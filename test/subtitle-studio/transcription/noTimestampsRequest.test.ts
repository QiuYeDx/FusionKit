import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalSubtitleServerInferenceFields,
  parseLocalSubtitleServerVerboseJson,
  validateLocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerInferenceRequest,
} from "../../../electron/main/subtitle-studio/transcription/native/server-contract";
import { LocalSubtitleServerHttpClient } from "../../../electron/main/subtitle-studio/transcription/native/server-http-client";
import { localSubtitleFileIdentityForPathSync } from "../../../electron/main/subtitle-studio/transcription/native/filesystem-object-identity";

/** A response as whisper-server v1.9.1 gives it for no_timestamps=true (records/model-smoke.md, anime-whisper A-00): no start or end. */
function untimedResponse() {
  return {
    task: "transcribe", language: "japanese", duration: 3.859999895095825, text: "来たのって何がだ?…あっ\n",
    segments: [{ id: 0, text: "来たのって何がだ?…あっ", tokens: [6912, 3368],
      words: [{ word: "来", probability: 0.4469 }, { word: "た", probability: 0.998 }],
      temperature: 0, avg_logprob: -0.284623920917511, no_speech_prob: 0.000019277735191280954 }],
  };
}
const transcribe = { taskMode: "transcribe" as const, vadEnabled: false };

describe("no-timestamps requests", () => {
  it("send no_timestamps=true only when asked, in the same field order", () => {
    const plain = createLocalSubtitleServerInferenceFields(request());
    const untimed = createLocalSubtitleServerInferenceFields(request({ noTimestamps: true }));
    expect(plain.no_timestamps).toBe("false");
    expect(untimed.no_timestamps).toBe("true");
    expect(Object.keys(untimed)).toEqual(Object.keys(plain));
    expect({ ...untimed, no_timestamps: "false" }).toEqual(plain);
  });

  it("refuse any other flag value and DTW timing", () => {
    expect(() => validateLocalSubtitleServerInferenceRequest(request({ noTimestamps: true }))).not.toThrow();
    for (const patch of [{ noTimestamps: false }, { noTimestamps: "true" }, { noTimestamps: 1 }])
      expect(() => validateLocalSubtitleServerInferenceRequest(request(patch as never)), JSON.stringify(patch)).toThrow(/no-timestamps/);
    expect(() => createLocalSubtitleServerInferenceFields(request({ noTimestamps: true, timingMode: "dtw_large_v3" }))).toThrow();
  });
});

describe("no-timestamps responses", () => {
  it("are refused by the default strict parsing", () => {
    expect(() => parseLocalSubtitleServerVerboseJson(untimedResponse(), transcribe)).toThrow(/contract v1/);
    const half = untimedResponse(); Object.assign(half.segments[0]!, { start: 0.1 });
    expect(() => parseLocalSubtitleServerVerboseJson(half, transcribe)).toThrow(/contract v1/);
  });

  it("span the request window when the request asked for text only", () => {
    const result = parseLocalSubtitleServerVerboseJson(untimedResponse(), { ...transcribe, noTimestamps: true });
    expect(result).toEqual({ contractVersion: 1, task: "transcribe", language: "japanese", durationMs: 3_860, text: "来たのって何がだ?…あっ",
      segments: [{ id: 0, startMs: 0, endMs: 3_860, text: "来たのって何がだ?…あっ", temperature: 0,
        averageLogProbability: -0.284623920917511, noSpeechProbability: 0.000019277735191280954 }], wordTimelineStatus: "not_requested" });
    // Times it returns anyway are not used either.
    const timed = untimedResponse(); Object.assign(timed.segments[0]!, { start: 0, end: 30 });
    expect(parseLocalSubtitleServerVerboseJson(timed, { ...transcribe, noTimestamps: true }).segments[0]).toMatchObject({ startMs: 0, endMs: 3_860 });
    // Everything else stays strict.
    const extra = untimedResponse(); Object.assign(extra.segments[0]!, { speaker: 1 });
    expect(() => parseLocalSubtitleServerVerboseJson(extra, { ...transcribe, noTimestamps: true })).toThrow(/contract v1/);
    const noisy = untimedResponse(); noisy.segments[0]!.text = "bad\u0085text";
    expect(() => parseLocalSubtitleServerVerboseJson(noisy, { ...transcribe, noTimestamps: true })).toThrow(/contract v1/);
    expect(() => parseLocalSubtitleServerVerboseJson(untimedResponse(), { ...transcribe, noTimestamps: true, timingMode: "dtw_large_v3" })).toThrow();
  });
});

describe("the HTTP client", () => {
  let directory: string, windowPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fusionkit-no-timestamps-"));
    windowPath = path.join(directory, "window.wav");
    await writeFile(windowPath, Buffer.from("RIFF-no-timestamps-window", "utf8"));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("sends the flag and parses the text-only answer as such", async () => {
    const bodies: string[] = [];
    const server = createServer((incoming: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        const bytes = Buffer.from(JSON.stringify(untimedResponse()), "utf8");
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(bytes.length) });
        response.end(bytes);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The fake server has no port.");
    try {
      const client = new LocalSubtitleServerHttpClient({ host: "127.0.0.1", port: address.port, privatePath: `/fusionkit-${"a".repeat(48)}` });
      const identity = localSubtitleFileIdentityForPathSync(windowPath);
      const { result } = await client.inference(request({ filePath: windowPath, expectedFileIdentity: identity, vadEnabled: false, noTimestamps: true }));
      expect(bodies[0]).toMatch(/name="no_timestamps"\r\n\r\ntrue\r\n/u);
      expect(result.segments).toEqual([expect.objectContaining({ startMs: 0, endMs: 3_860, text: "来たのって何がだ?…あっ" })]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

function request(patch: Partial<LocalSubtitleServerInferenceRequest> = {}): LocalSubtitleServerInferenceRequest {
  return { requestGeneration: 1, filePath: "/private/windows/window.wav",
    expectedFileIdentity: Object.freeze({ objectIdentity: Object.freeze({ volumeSerialHex: "00000001", fileIdHex: "00000000000000000000000000000002" }),
      size: 4_096, mtimeMs: 1_000.25, ctimeMs: 1_000.5 }),
    language: "ja", taskMode: "transcribe", beamSize: 5, temperature: 0, vadEnabled: false, vadMinSilenceMs: 500, ...patch };
}
