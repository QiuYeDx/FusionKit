import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_AUDIO_PROFILES,
  createLocalSubtitleServerInferenceFields,
  resolveLocalSubtitleAudioProfile,
  validateLocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerInferenceResponse,
} from "../../../electron/main/subtitle-studio/transcription/native/server-contract";
import {
  LocalSubtitleServerSupervisor,
  type LocalSubtitleServerHttpClientLike,
} from "../../../electron/main/subtitle-studio/transcription/native/server-supervisor";
import {
  cleanupLocalSubtitleServerSession,
  createLocalSubtitleServerSession,
} from "../../../electron/main/subtitle-studio/transcription/native/server-session";
import {
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "../../../electron/main/subtitle-studio/transcription/native/resource-path";
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from "../../../src/subtitle-studio/transcription/domain";
import { TRANSCRIPTION_AUDIO_PROFILES } from "../../../src/subtitle-studio/transcription-audio-profiles";
import { createRuntimeFixture, type LocalSubtitleRuntimeFixture } from "./runtimeFixture";

/** The fields every request sent before audio profiles existed, in their exact order. */
const DEFAULT_FIELDS = ["response_format", "language", "translate", "vad", "token_timestamps", "no_language_probabilities",
  "beam_size", "temperature", "temperature_inc", "no_timestamps", "vad_min_silence_duration_ms"];

describe("audio profile inference fields", () => {
  it("keeps standard requests, with and without conditioned padding, exactly as before", () => {
    const standard = createLocalSubtitleServerInferenceFields(request());
    expect(Object.entries(standard)).toEqual([["response_format", "verbose_json"], ["language", "ja"], ["translate", "false"],
      ["vad", "true"], ["token_timestamps", "false"], ["no_language_probabilities", "true"], ["beam_size", "5"], ["temperature", "0"],
      ["temperature_inc", "0.2"], ["no_timestamps", "false"], ["vad_min_silence_duration_ms", "500"], ["prompt", "FusionKit"]]);
    expect(Object.keys(createLocalSubtitleServerInferenceFields(request({ vadSpeechPadMs: 1000 }))))
      .toEqual([...DEFAULT_FIELDS, "vad_speech_pad_ms", "prompt"]);
    expect(createLocalSubtitleServerInferenceFields(request({ vadSpeechPadMs: 1000 })).vad_speech_pad_ms).toBe("1000");
    const { initialPrompt: _prompt, ...withoutPrompt } = request();
    expect(Object.keys(createLocalSubtitleServerInferenceFields({ ...withoutPrompt, vadEnabled: false })))
      .toEqual(DEFAULT_FIELDS.slice(0, -1));
  });

  it("pins the parameter table of each profile", () => {
    expect(Object.keys(LOCAL_SUBTITLE_AUDIO_PROFILES)).toEqual([...TRANSCRIPTION_AUDIO_PROFILES]);
    expect(LOCAL_SUBTITLE_AUDIO_PROFILES).toEqual({
      quiet_whisper_v1: { vadThreshold: 0.35, vadMinSpeechMs: 150, vadSpeechPadMs: 300, noSpeechThreshold: 0.7, quietAudioMode: "gated_v1" },
      noisy_music_v1: { vadThreshold: 0.45, vadSpeechPadMs: 200, suppressNonSpeech: true },
    });
    expect(Object.isFrozen(LOCAL_SUBTITLE_AUDIO_PROFILES.quiet_whisper_v1)).toBe(true);
    expect(resolveLocalSubtitleAudioProfile(undefined)).toBeUndefined();
    expect(resolveLocalSubtitleAudioProfile("noisy_music_v1")).toBe(LOCAL_SUBTITLE_AUDIO_PROFILES.noisy_music_v1);
    for (const unknown of ["standard", "quiet", "__proto__", "toString", 1, null])
      expect(() => resolveLocalSubtitleAudioProfile(unknown)).toThrow(/audio profile/);
  });

  it("sends each profile's fields after the existing VAD field", () => {
    expect(Object.entries(createLocalSubtitleServerInferenceFields(request({ vadThreshold: 0.35, vadMinSpeechMs: 150, vadSpeechPadMs: 300,
      noSpeechThreshold: 0.7 }))).slice(DEFAULT_FIELDS.length)).toEqual([["vad_threshold", "0.35"], ["vad_min_speech_duration_ms", "150"],
      ["vad_speech_pad_ms", "300"], ["no_speech_thold", "0.7"], ["prompt", "FusionKit"]]);
    expect(Object.entries(createLocalSubtitleServerInferenceFields(request({ vadThreshold: 0.45, vadSpeechPadMs: 200,
      suppressNonSpeech: true }))).slice(DEFAULT_FIELDS.length)).toEqual([["vad_threshold", "0.45"], ["vad_speech_pad_ms", "200"],
      ["suppress_nst", "true"], ["prompt", "FusionKit"]]);
    // A conditioned quiet window keeps its 1000 ms padding beside the profile fields.
    expect(createLocalSubtitleServerInferenceFields(request({ vadThreshold: 0.35, vadSpeechPadMs: 1000 })))
      .toMatchObject({ vad_threshold: "0.35", vad_speech_pad_ms: "1000" });
  });

  it("accepts the boundary values and rejects voice-detection fields without VAD or out of range", () => {
    for (const patch of [{ vadThreshold: 0.1 }, { vadThreshold: 0.9 }, { vadMinSpeechMs: 50 }, { vadMinSpeechMs: 1000 },
      { vadSpeechPadMs: 30 }, { vadSpeechPadMs: 1000 }, { noSpeechThreshold: 0.3 }, { noSpeechThreshold: 0.95 }, { suppressNonSpeech: true as const }])
      expect(() => validateLocalSubtitleServerInferenceRequest(request(patch))).not.toThrow();
    for (const patch of [{ vadThreshold: 0.35 }, { vadMinSpeechMs: 150 }, { vadSpeechPadMs: 300 }])
      expect(() => createLocalSubtitleServerInferenceFields(request({ ...patch, vadEnabled: false }))).toThrow(/VAD/);
    for (const patch of [{ vadThreshold: 0.09 }, { vadThreshold: 0.91 }, { vadThreshold: Number.NaN }, { vadThreshold: "0.35" },
      { vadMinSpeechMs: 49 }, { vadMinSpeechMs: 1001 }, { vadMinSpeechMs: 150.5 },
      { vadSpeechPadMs: 29 }, { vadSpeechPadMs: 1001 }, { vadSpeechPadMs: 300.5 },
      { noSpeechThreshold: 0.29 }, { noSpeechThreshold: 0.96 }, { noSpeechThreshold: Infinity },
      { suppressNonSpeech: false }, { suppressNonSpeech: "true" }]) {
      expect(() => createLocalSubtitleServerInferenceFields(request(patch as never)), JSON.stringify(patch)).toThrow();
      expect(() => validateLocalSubtitleServerInferenceRequest(request(patch as never)), JSON.stringify(patch)).toThrow();
    }
  });
});

describe("audio profile supervisor snapshot", () => {
  let fixture: LocalSubtitleRuntimeFixture;
  let verifiedRuntime: LocalSubtitleVerifiedRuntimeBundle;
  const supervisors: LocalSubtitleServerSupervisor[] = [];
  const children: FakeChild[] = [];
  beforeAll(async () => {
    fixture = await createRuntimeFixture();
    verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({ environment: fixture.environment, scope: "server", signatureVerifier: async () => true });
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.close(0, null);
    for (const supervisor of supervisors.splice(0)) {
      await supervisor.shutdown("app_quit").catch(() => undefined);
      await supervisor.drainBackgroundCleanup();
    }
  });
  afterAll(async () => { await fixture.cleanup(); });

  it("hands the profile fields to the HTTP client in its immutable request", async () => {
    const client = new FakeHttpClient();
    const managedResourceRoot = path.join(fixture.tempRoot, "managed");
    let nextPort = 44_000;
    const supervisor = new LocalSubtitleServerSupervisor({ managedResourceRoot, startupTimeoutMs: 100, startupPollIntervalMs: 1,
      idleTimeoutMs: 60_000, abortGraceMs: 5, terminateGraceMs: 5, forceKillGraceMs: 5, maxStartAttempts: 2,
      dependencies: {
        reservePort: async () => ({ port: nextPort++, release: async () => undefined }),
        createSession: root => createLocalSubtitleServerSession(root),
        createHttpClient: () => client,
        spawnProcess: () => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; },
        cleanupSession: session => cleanupLocalSubtitleServerSession(session),
      } });
    supervisors.push(supervisor);
    const owner = Object.freeze({ webContentsId: 17, ownerSessionId: "audio-profile" });
    const lease = await supervisor.acquire(owner, { verifiedRuntime, serverArtifactId: "whisper-server-mac-arm64-metal-cpu",
      purpose: "inference", backend: "cpu", threads: 4,
      model: { storage: "managed", id: "large-v3-q5_0", absolutePath: path.join(managedResourceRoot, "models", "large-v3-q5_0", "model.bin"),
        byteSize: 1_081_140_203, sha256: "a".repeat(64) },
      vadModel: { storage: "managed", id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id, absolutePath: path.join(managedResourceRoot, "vad", "vad.bin"),
        byteSize: 885_098, sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256 } });
    const fields = { vadThreshold: 0.35, vadMinSpeechMs: 150, vadSpeechPadMs: 300, noSpeechThreshold: 0.7 };
    await supervisor.beginInference(lease, { ...request(fields, managedResourceRoot), requestGeneration: 1 }).result;
    await supervisor.beginInference(lease, { ...request({ vadThreshold: 0.45, vadSpeechPadMs: 200, suppressNonSpeech: true }, managedResourceRoot),
      requestGeneration: 2 }).result;
    await supervisor.beginInference(lease, { ...request({}, managedResourceRoot), requestGeneration: 3 }).result;
    expect(client.requests[0]).toMatchObject(fields);
    expect(client.requests[1]).toMatchObject({ vadThreshold: 0.45, vadSpeechPadMs: 200, suppressNonSpeech: true });
    expect(client.requests[1]).not.toHaveProperty("vadMinSpeechMs");
    for (const key of ["vadThreshold", "vadMinSpeechMs", "vadSpeechPadMs", "noSpeechThreshold", "suppressNonSpeech"])
      expect(client.requests[2]).not.toHaveProperty(key);
    expect(client.requests.every(value => Object.isFrozen(value))).toBe(true);
    await supervisor.release(lease);
  });
});

function request(patch: Partial<LocalSubtitleServerInferenceRequest> = {}, root = "/private"): LocalSubtitleServerInferenceRequest {
  return { requestGeneration: 1, filePath: path.join(root, "windows", "window.wav"),
    expectedFileIdentity: Object.freeze({ objectIdentity: Object.freeze({ volumeSerialHex: "00000001", fileIdHex: "00000000000000000000000000000002" }),
      size: 4_096, mtimeMs: 1_000.25, ctimeMs: 1_000.5 }),
    language: "ja", taskMode: "transcribe", beamSize: 5, temperature: 0, vadEnabled: true, vadMinSilenceMs: 500,
    initialPrompt: "FusionKit", ...patch };
}

class FakeChild extends EventEmitter {
  static nextPid = 91_000;
  readonly pid = FakeChild.nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    queueMicrotask(() => this.close(null, typeof signal === "number" ? "SIGTERM" : signal));
    return true;
  }
  close(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true; this.exitCode = exitCode; this.signalCode = signalCode;
    this.stdout.end(); this.stderr.end();
    this.emit("close", exitCode, signalCode);
  }
}

class FakeHttpClient implements LocalSubtitleServerHttpClientLike {
  readonly sessionDisposition = "reusable" as const;
  readonly requests: LocalSubtitleServerInferenceRequest[] = [];
  async probeReadiness() { return { sessionDisposition: "reusable" as const }; }
  async health() { return { sessionDisposition: "reusable" as const }; }
  async inference(value: LocalSubtitleServerInferenceRequest): Promise<LocalSubtitleServerInferenceResponse> {
    this.requests.push(value);
    return Object.freeze({ requestGeneration: value.requestGeneration, sessionDisposition: "reusable",
      result: Object.freeze({ contractVersion: 1, task: "transcribe", language: "ja", durationMs: 1_000, text: "",
        segments: Object.freeze([]), wordTimelineStatus: "discarded_vad_compressed_timeline" }) });
  }
}
