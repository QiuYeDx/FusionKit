import { beforeEach, describe, expect, it, vi } from "vitest";

const localStorageItems = vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  return storage;
});

import useModelStore from "@/store/useModelStore";
import { Model } from "@/type/model";
import { AUDIO_EVENT_CHANNELS, AUDIO_IPC_CHANNELS } from "@/type/audioIpc";
import {
  cancelAudioTranscription,
  transcribeAudio,
} from "./audioTranscriptionService";
import {
  cancelRecordedAudioChunkTranscription,
  createAudioRealtimeSessionHandle,
  createRealtimeEphemeralSession,
  mapOpenAIRealtimeServerEvent,
  transcribeRecordedAudioChunk,
} from "./audioRealtimeService";
import {
  cancelSpeechSynthesis,
  revealSpeechOutput,
  synthesizeSpeech,
  cancelSpeechSynthesisStream,
  synthesizeSpeechStream,
} from "./speechSynthesisService";

describe("audio renderer services", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let on: ReturnType<typeof vi.fn>;
  let off: ReturnType<typeof vi.fn>;
  let streamListener: ((event: unknown, payload: unknown) => void) | undefined;

  beforeEach(() => {
    localStorageItems.clear();
    useModelStore.setState({
      profiles: [
        {
          id: "profile_audio",
          name: "Audio Profile",
          provider: Model.OpenAI,
          apiKey: "sk-renderer-audio",
          baseUrl: "https://api.openai.com/v1",
          modelKey: "unused",
          tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 },
          apiFormat: "chat_completions",
          outputTokenParameter: "max_tokens",
        },
      ],
      audioProfiles: [
        {
          id: "audio_openai",
          name: "OpenAI Audio",
          connectionProfileId: "profile_audio",
          audioDialect: "openai_audio",
          capabilities: [
            "file_transcription",
            "speech_synthesis",
            "streaming_speech_synthesis",
          ],
          models: {
            transcription: "gpt-4o-transcribe",
            speechSynthesis: "gpt-4o-mini-tts",
          },
          defaults: {},
        },
        {
          id: "audio_realtime",
          name: "OpenAI Realtime",
          connectionProfileId: "profile_audio",
          audioDialect: "openai_realtime",
          capabilities: [
            "realtime_transcription",
            "realtime_duplex_voice",
          ],
          models: {
            realtime: "gpt-realtime",
          },
          defaults: {},
        },
      ],
      audioAssignment: {
        transcription: "audio_openai",
        speechSynthesis: "audio_openai",
        realtimeCaptions: "audio_openai",
        realtimeVoice: "audio_realtime",
      },
    });

    streamListener = undefined;
    invoke = vi.fn(async (channel: string) => {
      if (channel === AUDIO_IPC_CHANNELS.syncRuntimeConfig) {
        return { ok: true, data: { synced: true, audioProfileCount: 1 } };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribe) {
        return {
          ok: true,
          data: {
            text: "hello audio",
            responseFormat: "json",
            model: "gpt-4o-transcribe",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelTranscription) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "asr_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.transcribeRecordedChunk) {
        return {
          ok: true,
          data: {
            requestId: "chunk_req_001",
            text: "chunk transcript",
            responseFormat: "text",
            startedAtMs: 0,
            endedAtMs: 5000,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelRecordedChunkTranscription) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "chunk_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.synthesizeSpeech) {
        return {
          ok: true,
          data: {
            outputPath: "/tmp/speech.mp3",
            mimeType: "audio/mpeg",
            responseFormat: "mp3",
            sizeBytes: 32,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelSpeechSynthesis) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "speech_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.synthesizeSpeechStream) {
        return {
          ok: true,
          data: {
            outputPath: "/tmp/speech.wav",
            mimeType: "audio/wav",
            responseFormat: "pcm16",
            sizeBytes: 44,
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.cancelSpeechSynthesisStream) {
        return {
          ok: true,
          data: { cancelled: true, requestId: "speech_req_001" },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.realtimeCreateEphemeralSession) {
        return {
          ok: true,
          data: {
            sessionId: "sess_renderer_realtime",
            clientSecret: "ek-renderer-realtime",
            realtimeCallsUrl: "https://api.openai.com/v1/realtime/calls",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.realtimeStopSession) {
        return {
          ok: true,
          data: {
            stopped: true,
            sessionId: "sess_renderer_realtime",
            reason: "user",
          },
        };
      }
      if (channel === AUDIO_IPC_CHANNELS.revealOutput) {
        return {
          ok: true,
          data: { revealed: true, path: "/tmp/speech.mp3" },
        };
      }
      return { ok: false, error: { code: "invalid_ipc_request", message: "bad" } };
    });
    on = vi.fn((_channel: string, listener: typeof streamListener) => {
      streamListener = listener;
    });
    off = vi.fn();
    vi.stubGlobal("window", { ipcRenderer: { invoke, on, off } });
  });

  it("syncs global audio config before transcription without putting API config in task payload", async () => {
    const result = await transcribeAudio({
      assignmentKey: "transcription",
      filePath: "/tmp/speech.wav",
      fileName: "speech.wav",
      mimeType: "audio/wav",
      responseFormat: "json",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { text: "hello audio" },
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.objectContaining({
        connectionProfiles: [
          expect.objectContaining({ apiKey: "sk-renderer-audio" }),
        ],
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      AUDIO_IPC_CHANNELS.transcribe,
      expect.not.objectContaining({
        apiKey: expect.anything(),
        baseUrl: expect.anything(),
        modelKey: expect.anything(),
      }),
    );
  });

  it("exposes transcription cancellation without syncing runtime config again", async () => {
    const result = await cancelAudioTranscription("asr_req_001");

    expect(result).toMatchObject({
      ok: true,
      data: { cancelled: true, requestId: "asr_req_001" },
    });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.cancelTranscription,
      { requestId: "asr_req_001" },
    );
    expect(invoke).not.toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.anything(),
    );
  });

  it("syncs global audio config before transcribing recorded chunks", async () => {
    const result = await transcribeRecordedAudioChunk({
      assignmentKey: "realtimeCaptions",
      requestId: "chunk_req_001",
      audioBytes: new Uint8Array([82, 73, 70, 70]),
      mimeType: "audio/wav",
      responseFormat: "text",
      startedAtMs: 0,
      endedAtMs: 5000,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { text: "chunk transcript" },
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.objectContaining({
        connectionProfiles: [
          expect.objectContaining({ apiKey: "sk-renderer-audio" }),
        ],
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      AUDIO_IPC_CHANNELS.transcribeRecordedChunk,
      expect.not.objectContaining({
        apiKey: expect.anything(),
        baseUrl: expect.anything(),
        modelKey: expect.anything(),
      }),
    );
  });

  it("exposes recorded chunk cancellation without syncing runtime config again", async () => {
    await expect(cancelRecordedAudioChunkTranscription("chunk_req_001"))
      .resolves.toMatchObject({
        ok: true,
        data: { cancelled: true, requestId: "chunk_req_001" },
      });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.cancelRecordedChunkTranscription,
      { requestId: "chunk_req_001" },
    );
    expect(invoke).not.toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.anything(),
    );
  });

  it("syncs global audio config before non-stream speech synthesis", async () => {
    const result = await synthesizeSpeech({
      assignmentKey: "speechSynthesis",
      requestId: "speech_req_001",
      input: "hello",
      voice: "alloy",
      responseFormat: "mp3",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { outputPath: "/tmp/speech.mp3" },
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.objectContaining({
        connectionProfiles: [
          expect.objectContaining({ apiKey: "sk-renderer-audio" }),
        ],
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      AUDIO_IPC_CHANNELS.synthesizeSpeech,
      expect.not.objectContaining({
        apiKey: expect.anything(),
        baseUrl: expect.anything(),
        modelKey: expect.anything(),
      }),
    );
  });

  it("exposes non-stream speech cancellation and output reveal helpers", async () => {
    await expect(cancelSpeechSynthesis("speech_req_001"))
      .resolves.toMatchObject({
        ok: true,
        data: { cancelled: true, requestId: "speech_req_001" },
      });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.cancelSpeechSynthesis,
      { requestId: "speech_req_001" },
    );
    expect(invoke).not.toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.anything(),
    );

    await expect(revealSpeechOutput({ outputPath: "/tmp/speech.mp3" }))
      .resolves.toMatchObject({
        ok: true,
        data: { revealed: true, path: "/tmp/speech.mp3" },
      });
    expect(invoke).toHaveBeenCalledWith(AUDIO_IPC_CHANNELS.revealOutput, {
      outputPath: "/tmp/speech.mp3",
    });
  });

  it("subscribes to matching speech stream events and exposes cancellation", async () => {
    const audioDelta = vi.fn();
    const any = vi.fn();
    const handle = synthesizeSpeechStream(
      {
        assignmentKey: "speechSynthesis",
        input: "hello",
        voice: "alloy",
        responseFormat: "pcm16",
      },
      { audioDelta, any },
      { requestId: "speech_req_001" },
    );

    expect(on).toHaveBeenCalledWith(
      AUDIO_EVENT_CHANNELS.speechSynthesisStream,
      expect.any(Function),
    );
    streamListener?.({}, {
      type: "audio_delta",
      requestId: "other",
      pcmBytes: new Uint8Array([9]),
    });
    streamListener?.({}, {
      type: "audio_delta",
      requestId: "speech_req_001",
      pcmBytes: new Uint8Array([1, 2, 3]),
    });

    expect(audioDelta).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);
    await expect(handle.result).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith(
      AUDIO_IPC_CHANNELS.synthesizeSpeechStream,
      {
        requestId: "speech_req_001",
        payload: expect.objectContaining({
          assignmentKey: "speechSynthesis",
          stream: true,
        }),
      },
    );

    await expect(cancelSpeechSynthesisStream({ requestId: "speech_req_001" }))
      .resolves.toMatchObject({
        ok: true,
        data: { cancelled: true, requestId: "speech_req_001" },
      });
    handle.unsubscribe();
    expect(off).toHaveBeenCalledWith(
      AUDIO_EVENT_CHANNELS.speechSynthesisStream,
      expect.any(Function),
    );
  });

  it("syncs global audio config before creating a realtime ephemeral session", async () => {
    const result = await createRealtimeEphemeralSession({
      assignmentKey: "realtimeVoice",
      mode: "duplex_voice",
      voice: "marin",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { sessionId: "sess_renderer_realtime" },
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      AUDIO_IPC_CHANNELS.syncRuntimeConfig,
      expect.objectContaining({
        connectionProfiles: [
          expect.objectContaining({ apiKey: "sk-renderer-audio" }),
        ],
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      AUDIO_IPC_CHANNELS.realtimeCreateEphemeralSession,
      expect.not.objectContaining({
        apiKey: expect.anything(),
        baseUrl: expect.anything(),
        modelKey: expect.anything(),
        provider: expect.anything(),
        audioDialect: expect.anything(),
      }),
    );
  });

  it("maps OpenAI Realtime server events into FusionKit realtime events", () => {
    expect(mapOpenAIRealtimeServerEvent(JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "hello",
    }))).toEqual([
      { type: "transcript_delta", role: "user", text: "hello" },
    ]);
    expect(mapOpenAIRealtimeServerEvent({
      type: "response.created",
      response: { id: "resp_001" },
    })).toEqual([
      { type: "response_started", responseId: "resp_001" },
    ]);
    expect(mapOpenAIRealtimeServerEvent({
      type: "response.audio_transcript.done",
      transcript: "hi there",
    })).toEqual([
      { type: "transcript_final", role: "assistant", text: "hi there" },
    ]);
    expect(mapOpenAIRealtimeServerEvent({
      type: "error",
      error: { message: "session failed" },
    })).toEqual([
      {
        type: "error",
        error: {
          code: "realtime_session_failed",
          message: "session failed",
        },
      },
    ]);
  });

  it("cleans up realtime browser resources idempotently", async () => {
    const dataChannelClose = vi.fn();
    const peerConnectionClose = vi.fn();
    const trackStop = vi.fn();
    const stopRemoteSession = vi.fn(async () => ({
      ok: true as const,
      data: {
        stopped: true,
        sessionId: "sess_renderer_realtime",
        reason: "page_unload" as const,
      },
    }));
    const events: unknown[] = [];
    const handle = createAudioRealtimeSessionHandle({
      sessionId: "sess_renderer_realtime",
      dataChannel: { close: dataChannelClose },
      peerConnection: { close: peerConnectionClose },
      mediaStream: {
        getTracks: () => [{ stop: trackStop } as unknown as MediaStreamTrack],
      },
      onEvent: (event) => events.push(event),
      stopRemoteSession,
    });

    await handle.stop("page_unload");
    await handle.stop("user");

    expect(handle.closed).toBe(true);
    expect(dataChannelClose).toHaveBeenCalledTimes(1);
    expect(peerConnectionClose).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(stopRemoteSession).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "session_closed", reason: "page_unload" },
    ]);
  });
});
