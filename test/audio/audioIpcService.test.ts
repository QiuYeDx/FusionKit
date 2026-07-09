import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { AudioIpcService, type AudioRuntimeInvoker } from "../../electron/main/audio/ipc";
import { createAudioRuntimeError } from "../../electron/main/audio/audio-errors";
import { Model } from "@/type/model";
import type {
  CreateAudioTranscriptionRequest,
  CreateSpeechSynthesisRequest,
} from "@/type/audio";
import type { SyncAudioRuntimeConfigRequest } from "@/type/audioIpc";

const electronMock = vi.hoisted(() => ({
  shell: { showItemInFolder: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("electron", () => electronMock);

describe("AudioIpcService", () => {
  it("returns a not-configured error before global audio config is synced", async () => {
    const service = new AudioIpcService({
      runtime: createRuntimeInvoker(),
    });

    const result = await service.transcribe(createTranscriptionPayload());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "audio_profile_not_configured",
      },
    });
  });

  it("resolves synced global audio config and does not return API keys", async () => {
    const runtime = createRuntimeInvoker();
    const service = new AudioIpcService({ runtime });
    await service.syncRuntimeConfig(createRuntimeConfigSnapshot());

    const result = await service.transcribe(createTranscriptionPayload());

    expect(result).toMatchObject({
      ok: true,
      data: {
        text: "transcribed",
        responseFormat: "json",
        model: "gpt-4o-transcribe",
      },
    });
    expect(runtime.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentKey: "transcription" }),
      expect.objectContaining({
        model: expect.objectContaining({
          apiKey: "sk-audio-ipc",
          modelKey: "gpt-4o-transcribe",
          audioDialect: "openai_audio",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("sk-audio-ipc");
  });

  it("emits streaming speech events and supports request cancellation", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn(),
      synthesize: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.onStreamEvent?.({
            type: "started",
            requestId: options.requestId ?? "missing",
            sampleRate: 24000,
            channels: 1,
          });
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Audio request was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              outputPath: "/tmp/speech.wav",
              mimeType: "audio/wav",
              responseFormat: "pcm16",
              sizeBytes: 44,
            });
          }, 100);
        });
      }),
    };
    const service = new AudioIpcService({ runtime });
    await service.syncRuntimeConfig(createRuntimeConfigSnapshot());
    const webContents = createWebContentsMock();

    const streamPromise = service.synthesizeSpeechStream(
      {
        requestId: "stream_req_001",
        payload: createSpeechPayload({ stream: true, responseFormat: "pcm16" }),
      },
      webContents,
    );
    await waitFor(() => expect(webContents.send).toHaveBeenCalledTimes(1));
    expect(webContents.send).toHaveBeenCalledWith(
      "audio:speech-synthesis-stream",
      expect.objectContaining({
        type: "started",
        requestId: "stream_req_001",
      }),
    );

    const cancelResult = await service.cancelSpeechSynthesisStream({
      requestId: "stream_req_001",
    });
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "stream_req_001" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(streamPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });

  it("supports cancelling active transcription requests", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Audio transcription was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              text: "late transcription",
              responseFormat: "json",
            });
          }, 100);
        });
      }),
      synthesize: vi.fn(),
    };
    const service = new AudioIpcService({ runtime });
    await service.syncRuntimeConfig(createRuntimeConfigSnapshot());

    const transcriptionPromise = service.transcribe(
      createTranscriptionPayload({ requestId: "asr_req_001" }),
    );
    await waitFor(() => expect(abortSignal).toBeDefined());

    const cancelResult = await service.cancelTranscription({
      requestId: "asr_req_001",
    });
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "asr_req_001" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(transcriptionPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });

  it("transcribes recorded chunks through the realtime captions assignment", async () => {
    const runtime = createRuntimeInvoker();
    const service = new AudioIpcService({ runtime });
    await service.syncRuntimeConfig(createRuntimeConfigSnapshot());

    const result = await service.transcribeRecordedChunk({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_001",
      audioBytes: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      responseFormat: "text",
      language: "zh",
      startedAtMs: 0,
      endedAtMs: 5000,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        requestId: "chunk_req_001",
        text: "transcribed",
        responseFormat: "text",
        startedAtMs: 0,
        endedAtMs: 5000,
      },
    });
    expect(runtime.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentKey: "transcription",
        requestId: "chunk_req_001",
        mimeType: "audio/wav",
        responseFormat: "text",
        language: "zh",
      }),
      expect.objectContaining({
        model: expect.objectContaining({
          modelKey: "gpt-4o-transcribe",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("sk-audio-ipc");
  });

  it("supports cancelling active recorded chunk transcription requests", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Recorded chunk transcription was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              text: "late chunk",
              responseFormat: "text",
            });
          }, 100);
        });
      }),
      synthesize: vi.fn(),
    };
    const service = new AudioIpcService({ runtime });
    await service.syncRuntimeConfig(createRuntimeConfigSnapshot());

    const chunkPromise = service.transcribeRecordedChunk({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_002",
      audioBytes: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      responseFormat: "text",
    });
    await waitFor(() => expect(abortSignal).toBeDefined());

    const cancelResult = await service.cancelRecordedChunkTranscription({
      requestId: "chunk_req_002",
    });
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "chunk_req_002" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(chunkPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });

  it("supports cancelling active non-stream speech requests", async () => {
    let abortSignal: AbortSignal | undefined;
    const runtime: AudioRuntimeInvoker = {
      transcribe: vi.fn(),
      synthesize: vi.fn((_payload, options) => {
        abortSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(
              createAudioRuntimeError({
                code: "aborted",
                message: "Speech synthesis was aborted.",
              }),
            );
          });
          setTimeout(() => {
            resolve({
              outputPath: "/tmp/speech.wav",
              mimeType: "audio/wav",
              responseFormat: "wav",
              sizeBytes: 44,
            });
          }, 100);
        });
      }),
    };
    const service = new AudioIpcService({ runtime });
    await service.syncRuntimeConfig(createRuntimeConfigSnapshot());

    const speechPromise = service.synthesizeSpeech(
      createSpeechPayload({ requestId: "speech_req_001" }),
    );
    await waitFor(() => expect(abortSignal).toBeDefined());

    const cancelResult = await service.cancelSpeechSynthesis({
      requestId: "speech_req_001",
    });
    expect(cancelResult).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "speech_req_001" },
    });
    expect(abortSignal?.aborted).toBe(true);
    await expect(speechPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });
});

function createRuntimeInvoker(): AudioRuntimeInvoker {
  return {
    transcribe: vi.fn(async (_payload, options) => ({
      text: "transcribed",
      responseFormat: "json",
      model: options.model.modelKey,
    })),
    synthesize: vi.fn(async (_payload, options) => ({
      outputPath: "/tmp/speech.wav",
      mimeType: "audio/wav",
      responseFormat: "wav",
      sizeBytes: 12,
      model: options.model.modelKey,
    })),
  };
}

function createRuntimeConfigSnapshot(): SyncAudioRuntimeConfigRequest {
  return {
    connectionProfiles: [
      {
        id: "profile_openai_audio",
        provider: Model.OpenAI,
        apiKey: "sk-audio-ipc",
        baseUrl: "https://api.openai.com/v1",
      },
    ],
    audioProfiles: [
      {
        id: "audio_transcription",
        name: "OpenAI Audio",
        connectionProfileId: "profile_openai_audio",
        audioDialect: "openai_audio",
        capabilities: [
          "file_transcription",
          "streaming_transcription",
          "speech_synthesis",
          "streaming_speech_synthesis",
        ],
        models: {
          transcription: "gpt-4o-transcribe",
          speechSynthesis: "gpt-4o-mini-tts",
          realtime: "gpt-4o-transcribe",
        },
        defaults: {},
      },
    ],
    audioAssignment: {
      transcription: "audio_transcription",
      speechSynthesis: "audio_transcription",
      realtimeCaptions: "audio_transcription",
      realtimeVoice: null,
    },
  };
}

function createTranscriptionPayload(
  overrides: Partial<CreateAudioTranscriptionRequest> = {},
): CreateAudioTranscriptionRequest {
  return {
    assignmentKey: "transcription",
    filePath: "/tmp/speech.wav",
    fileName: "speech.wav",
    mimeType: "audio/wav",
    responseFormat: "json",
    ...overrides,
  };
}

function createSpeechPayload(
  overrides: Partial<CreateSpeechSynthesisRequest> = {},
): CreateSpeechSynthesisRequest {
  return {
    assignmentKey: "speechSynthesis",
    input: "hello",
    voice: "alloy",
    responseFormat: "wav",
    ...overrides,
  };
}

function createWebContentsMock(): WebContents {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents;
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}
