import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendSpeechSynthesis } from "../../electron/main/audio/audio-runtime-client";
import { AudioRuntimeClientError } from "../../electron/main/audio/audio-errors";
import {
  createMimoStreamingSpeechEvents,
  startFakeAudioApiServer,
  type FakeAudioApiServer,
} from "./fakeAudioApiServer";
import { Model } from "@/type/model";
import type {
  AudioRuntimeModelConfig,
  CreateSpeechSynthesisRequest,
} from "@/type/audio";
import type { SpeechSynthesisRuntimeStreamEvent } from "@/type/audioIpc";

type AudioDeltaEvent = Extract<
  SpeechSynthesisRuntimeStreamEvent,
  { type: "audio_delta" }
>;

describe("MiMo streaming TTS runtime", () => {
  let server: FakeAudioApiServer | undefined;
  let tempRoot: string | undefined;

  beforeEach(async () => {
    server = await startFakeAudioApiServer();
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "fusionkit-mimo-stream-test-"),
    );
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("streams preset voice PCM16 chunks and stores a WAV result", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const pcmChunks = [createPcm16Chunk([1, 2]), createPcm16Chunk([3, 4])];
    const base64Chunks = pcmChunks.map((chunk) => chunk.toString("base64"));
    activeServer.enqueueRoute("mimo_chat_completions", {
      sseEvents: createMimoStreamingSpeechEvents({
        audioBase64Chunks: base64Chunks,
        textChunks: ["你", "好"],
        model: "mimo-v2.5-tts",
      }),
    });

    const events: SpeechSynthesisRuntimeStreamEvent[] = [];
    const result = await sendSpeechSynthesis({
      model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-tts"),
      payload: createSpeechPayload({
        responseFormat: "pcm16",
        stream: true,
        speed: undefined,
        voice: "Chloe",
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-stream-preset",
        mimoOptions: {
          mode: "preset_voice",
          styleInstruction: "更亲切一点",
          audioTagsEnabled: true,
        },
      }),
      requestId: "stream-preset",
      onStreamEvent: (event) => {
        events.push(event);
      },
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      outputPath: path.join(activeTempRoot, "mimo-stream-preset.wav"),
      mimeType: "audio/wav",
      responseFormat: "wav",
      sizeBytes: 44 + Buffer.concat(pcmChunks).byteLength,
      model: "mimo-v2.5-tts",
      streamStats: {
        chunkCount: 2,
        totalBytes: Buffer.concat(pcmChunks).byteLength,
        sampleRate: 24000,
        channels: 1,
        streamMode: "incremental",
      },
    });
    expect(result.streamStats?.firstChunkLatencyMs).toEqual(expect.any(Number));
    await expect(stat(result.outputPath)).resolves.toMatchObject({
      size: 44 + Buffer.concat(pcmChunks).byteLength,
    });
    const wav = await readFile(result.outputPath);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(40)).toBe(Buffer.concat(pcmChunks).byteLength);

    const audioEvents = getAudioDeltaEvents(events);
    expect(audioEvents).toHaveLength(2);
    expect(Buffer.concat(audioEvents.map((event) => Buffer.from(event.pcmBytes))))
      .toEqual(Buffer.concat(pcmChunks));
    expect(events[0]).toMatchObject({
      type: "started",
      requestId: "stream-preset",
      sampleRate: 24000,
      channels: 1,
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      requestId: "stream-preset",
      result: { outputPath: result.outputPath },
    });
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("你好");
    expect(JSON.stringify(events)).not.toContain(base64Chunks[0]);
    expect(activeServer.requests[0]).toMatchObject({
      method: "POST",
      route: "mimo_chat_completions",
      body: {
        model: "mimo-v2.5-tts",
        stream: true,
        messages: [
          { role: "user", content: "更亲切一点" },
          { role: "assistant", content: "hello from FusionKit" },
        ],
        audio: {
          voice: "Chloe",
          format: "pcm16",
          audio_tags_enabled: true,
        },
      },
    });
    expect(activeServer.requests[0].headers["api-key"]).toBe(
      "mimo-audio-runtime",
    );
    expect(activeServer.requests[0].headers.authorization).toBeUndefined();
    expect(activeServer.requests[0].body).not.toHaveProperty("speed");
  });

  it("streams voice design requests with MiMo-only prompt options", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute("mimo_chat_completions", {
      sseEvents: createMimoStreamingSpeechEvents({
        audioBase64Chunks: [createPcm16Chunk([5, 6]).toString("base64")],
        model: "mimo-v2.5-tts-voicedesign",
      }),
    });

    const result = await sendSpeechSynthesis({
      model: createMimoModel(
        activeServer.baseUrl,
        "mimo-v2.5-tts-voicedesign",
      ),
      payload: createSpeechPayload({
        responseFormat: "pcm16",
        stream: true,
        speed: undefined,
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-stream-design",
        mimoOptions: {
          mode: "voice_design",
          voiceDesignPrompt: "年轻女性，清澈，有科技感",
          optimizeTextPreview: true,
        },
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      outputPath: path.join(activeTempRoot, "mimo-stream-design.wav"),
      model: "mimo-v2.5-tts-voicedesign",
      responseFormat: "wav",
      streamStats: { chunkCount: 1, streamMode: "incremental" },
    });
    expect(activeServer.requests[0].body).toMatchObject({
      model: "mimo-v2.5-tts-voicedesign",
      stream: true,
      messages: [
        { role: "user", content: "年轻女性，清澈，有科技感" },
        { role: "assistant", content: "hello from FusionKit" },
      ],
      audio: {
        format: "pcm16",
        optimize_text_preview: true,
      },
    });
    const audio = activeServer.requests[0].body?.audio as Record<string, unknown>;
    expect(audio.voice).toBeUndefined();
  });

  it("streams voice clone requests with reference audio data URIs", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const referencePath = path.join(activeTempRoot, "reference.mp3");
    const referenceBytes = Buffer.concat([
      Buffer.from("ID3", "ascii"),
      Buffer.from([9, 10, 11, 12]),
    ]);
    await writeFile(referencePath, referenceBytes);
    activeServer.enqueueRoute("mimo_chat_completions", {
      sseEvents: createMimoStreamingSpeechEvents({
        audioBase64Chunks: [createPcm16Chunk([7, 8]).toString("base64")],
        model: "mimo-v2.5-tts-voiceclone",
      }),
    });

    const result = await sendSpeechSynthesis({
      model: createMimoModel(
        activeServer.baseUrl,
        "mimo-v2.5-tts-voiceclone",
      ),
      payload: createSpeechPayload({
        responseFormat: "pcm16",
        stream: true,
        speed: undefined,
        instructions: undefined,
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-stream-clone",
        mimoOptions: {
          mode: "voice_clone",
          voiceSamplePath: referencePath,
          voiceSampleMime: "audio/mpeg",
        },
      }),
      retry: { maxRetries: 0 },
    });

    expect(result).toMatchObject({
      outputPath: path.join(activeTempRoot, "mimo-stream-clone.wav"),
      model: "mimo-v2.5-tts-voiceclone",
      responseFormat: "wav",
      streamStats: { chunkCount: 1, streamMode: "incremental" },
    });
    expect(activeServer.requests[0].body).toMatchObject({
      model: "mimo-v2.5-tts-voiceclone",
      stream: true,
      messages: [
        { role: "assistant", content: "hello from FusionKit" },
      ],
      audio: {
        voice: `data:audio/mpeg;base64,${referenceBytes.toString("base64")}`,
        format: "pcm16",
      },
    });
  });

  it("marks streaming responses as final-only when audio arrives in the final message", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    const finalPcm = createPcm16Chunk([11, 12]);
    activeServer.enqueueRoute("mimo_chat_completions", {
      sseEvents: [
        {
          id: "chatcmpl-fusionkit-fake-tts-stream-final",
          object: "chat.completion.chunk",
          model: "mimo-v2.5-tts",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "最终音频",
                audio: { data: finalPcm.toString("base64") },
              },
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ],
    });

    const events: SpeechSynthesisRuntimeStreamEvent[] = [];
    const result = await sendSpeechSynthesis({
      model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-tts"),
      payload: createSpeechPayload({
        responseFormat: "pcm16",
        stream: true,
        speed: undefined,
        outputPathMode: "custom_dir",
        outputDir: activeTempRoot,
        fileNameHint: "mimo-stream-final-only",
        mimoOptions: { mode: "preset_voice" },
      }),
      requestId: "stream-final-only",
      onStreamEvent: (event) => {
        events.push(event);
      },
      retry: { maxRetries: 0 },
    });

    expect(result.streamStats).toMatchObject({
      chunkCount: 1,
      totalBytes: finalPcm.byteLength,
      streamMode: "final_only",
    });
    expect(getAudioDeltaEvents(events)).toHaveLength(1);
    expect(getAudioDeltaEvents(events)[0].pcmBytes).toEqual(finalPcm);
  });

  it("aborts an in-flight stream without emitting completed events", async () => {
    const activeServer = requireServer(server);
    const activeTempRoot = requireTempRoot(tempRoot);
    activeServer.enqueueRoute("mimo_chat_completions", {
      sseEvents: createMimoStreamingSpeechEvents({
        audioBase64Chunks: [
          createPcm16Chunk([13, 14]).toString("base64"),
          createPcm16Chunk([15, 16]).toString("base64"),
        ],
      }),
      sseEventDelayMs: 20,
    });

    const controller = new AbortController();
    const events: SpeechSynthesisRuntimeStreamEvent[] = [];
    await expect(
      sendSpeechSynthesis({
        model: createMimoModel(activeServer.baseUrl, "mimo-v2.5-tts"),
        payload: createSpeechPayload({
          responseFormat: "pcm16",
          stream: true,
          speed: undefined,
          outputPathMode: "custom_dir",
          outputDir: activeTempRoot,
          fileNameHint: "mimo-stream-abort",
          mimoOptions: { mode: "preset_voice" },
        }),
        requestId: "stream-abort",
        signal: controller.signal,
        onStreamEvent: (event) => {
          events.push(event);
          if (event.type === "audio_delta") {
            controller.abort();
          }
        },
        retry: { maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: "aborted" });

    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(events).toContainEqual({
      type: "error",
      requestId: "stream-abort",
      error: expect.objectContaining({ code: "aborted" }),
    });
    await expect(
      stat(path.join(activeTempRoot, "mimo-stream-abort.wav")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createMimoModel(
  baseUrl: string,
  modelKey: string,
): AudioRuntimeModelConfig {
  return {
    audioProfileId: "audio_mimo",
    connectionProfileId: "profile_mimo",
    provider: Model.Other,
    apiKey: "mimo-audio-runtime",
    baseUrl,
    audioDialect: "mimo_chat_audio",
    modelKey,
    capabilities: [
      "file_transcription",
      "speech_synthesis",
      "streaming_speech_synthesis",
      "mimo_voice_design",
      "mimo_voice_clone",
    ],
  };
}

function createSpeechPayload(
  overrides: Partial<CreateSpeechSynthesisRequest> = {},
): CreateSpeechSynthesisRequest {
  return {
    assignmentKey: "speechSynthesis",
    input: "hello from FusionKit",
    voice: "mimo_default",
    instructions: "Warm and clear.",
    responseFormat: "wav",
    speed: 1.1,
    ...overrides,
  };
}

function createPcm16Chunk(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, index * 2);
  });
  return buffer;
}

function getAudioDeltaEvents(
  events: SpeechSynthesisRuntimeStreamEvent[],
): AudioDeltaEvent[] {
  return events.filter(
    (event): event is AudioDeltaEvent => event.type === "audio_delta",
  );
}

function requireServer(
  server: FakeAudioApiServer | undefined,
): FakeAudioApiServer {
  if (!server) throw new AudioRuntimeClientError({
    code: "network_error",
    message: "Fake server was not initialized.",
  });
  return server;
}

function requireTempRoot(value: string | undefined): string {
  if (!value) {
    throw new Error("Temp root was not initialized.");
  }
  return value;
}
