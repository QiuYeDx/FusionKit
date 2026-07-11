import { afterEach, describe, expect, it, vi } from "vitest";
import { Model } from "@/type/model";
import type { SyncAudioRuntimeConfigRequest } from "@/type/audioIpc";
import { AudioRuntimeConfigStore } from "../../electron/main/audio/audio-runtime-config";
import { AudioRealtimeIpcService } from "../../electron/main/audio/realtime-ipc";
import {
  createAudioErrorBody,
  createOpenAIRealtimeClientSecretBody,
  startFakeAudioApiServer,
  type FakeAudioApiServer,
} from "./fakeAudioApiServer";

const electronMock = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock("electron", () => electronMock);

describe("audio realtime session runtime", () => {
  let server: FakeAudioApiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("creates an OpenAI Realtime WebRTC ephemeral session without returning API keys", async () => {
    server = await startFakeAudioApiServer();
    server.enqueueRoute("openai_realtime_client_secrets", (request) => {
      expect(request.headers.authorization).toBe("Bearer sk-realtime-ipc");
      expect(request.body).toMatchObject({
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: "Speak concisely.",
          audio: {
            output: {
              voice: "marin",
            },
          },
        },
      });
      return {
        body: createOpenAIRealtimeClientSecretBody({
          clientSecret: "ek-realtime-client",
          sessionId: "sess_realtime_voice_001",
          model: "gpt-realtime",
        }),
      };
    });
    const service = createServiceWithConfig(
      createRealtimeRuntimeConfig(server.baseUrl),
    );

    const result = await service.createEphemeralSession({
      assignmentKey: "realtimeVoice",
      mode: "duplex_voice",
      instructions: "Speak concisely.",
      voice: "marin",
      turnDetection: "server_vad",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        sessionId: "sess_realtime_voice_001",
        clientSecret: "ek-realtime-client",
        model: "gpt-realtime",
        realtimeCallsUrl: `${server.baseUrl}/realtime/calls`,
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-realtime-ipc");

    await expect(service.stopSession({
      sessionId: "sess_realtime_voice_001",
      reason: "user",
    })).resolves.toMatchObject({
      ok: true,
      data: {
        stopped: true,
        sessionId: "sess_realtime_voice_001",
        reason: "user",
      },
    });
    await expect(service.stopSession({
      sessionId: "sess_realtime_voice_001",
      reason: "page_unload",
    })).resolves.toMatchObject({
      ok: true,
      data: {
        stopped: false,
        reason: "page_unload",
      },
    });
  });

  it("creates a realtime transcription client secret request for captions", async () => {
    server = await startFakeAudioApiServer();
    server.enqueueRoute("openai_realtime_client_secrets", (request) => {
      expect(request.body).toMatchObject({
        session: {
          type: "transcription",
          audio: {
            input: {
              transcription: {
                model: "gpt-realtime-whisper",
                language: "en",
              },
              format: {
                type: "audio/pcm",
                rate: 24000,
              },
              turn_detection: { type: "server_vad" },
            },
          },
        },
      });
      return {
        body: {
          value: "ek-caption-client",
          expires_at: 1_750_000_001,
        },
      };
    });
    const service = createServiceWithConfig(
      createRealtimeRuntimeConfig(server.baseUrl),
    );

    const result = await service.createEphemeralSession({
      assignmentKey: "realtimeCaptions",
      mode: "caption",
      language: "en",
      turnDetection: "server_vad",
      inputAudioFormat: "pcm16",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        clientSecret: "ek-caption-client",
        expiresAt: "2025-06-15T15:06:41.000Z",
      },
    });
  });

  it("rejects MiMo profiles for native WebRTC session creation", async () => {
    const service = createServiceWithConfig(createMimoStreamingRuntimeConfig());

    const result = await service.createEphemeralSession({
      assignmentKey: "realtimeCaptions",
      mode: "caption",
      language: "zh",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_audio_capability",
        field: "audioDialect",
      },
    });
  });

  it("maps OpenAI realtime HTTP errors without leaking API keys", async () => {
    server = await startFakeAudioApiServer();
    server.enqueueRoute("openai_realtime_client_secrets", {
      status: 401,
      body: createAudioErrorBody(
        "The API key sk-realtime-ipc is invalid.",
        "invalid_api_key",
      ),
    });
    const service = createServiceWithConfig(
      createRealtimeRuntimeConfig(server.baseUrl),
    );

    const result = await service.createEphemeralSession({
      assignmentKey: "realtimeVoice",
      mode: "duplex_voice",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "http_unauthorized",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-realtime-ipc");
  });
});

function createServiceWithConfig(
  snapshot: SyncAudioRuntimeConfigRequest,
): AudioRealtimeIpcService {
  const configStore = new AudioRuntimeConfigStore();
  configStore.sync(snapshot);
  return new AudioRealtimeIpcService({ configStore });
}

function createRealtimeRuntimeConfig(baseUrl: string): SyncAudioRuntimeConfigRequest {
  return {
    connectionProfiles: [
      {
        id: "profile_realtime",
        provider: Model.OpenAI,
        apiKey: "sk-realtime-ipc",
        baseUrl,
      },
    ],
    audioProfiles: [
      {
        id: "audio_realtime",
        name: "OpenAI Realtime",
        connectionProfileId: "profile_realtime",
        audioDialect: "openai_realtime",
        capabilities: [
          "realtime_transcription",
          "realtime_duplex_voice",
        ],
        models: {
          realtimeTranscription: "gpt-realtime-whisper",
          realtimeVoice: "gpt-realtime",
        },
        defaults: {},
      },
    ],
    audioAssignment: {
      transcription: null,
      speechSynthesis: null,
      realtimeCaptions: "audio_realtime",
      realtimeVoice: "audio_realtime",
    },
  };
}

function createMimoStreamingRuntimeConfig(): SyncAudioRuntimeConfigRequest {
  return {
    connectionProfiles: [
      {
        id: "profile_mimo_audio",
        provider: Model.OpenAI,
        apiKey: "mimo-secret-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
      },
    ],
    audioProfiles: [
      {
        id: "audio_mimo",
        name: "MiMo Audio",
        connectionProfileId: "profile_mimo_audio",
        audioDialect: "mimo_chat_audio",
        capabilities: [
          "streaming_transcription",
        ],
        models: {
          transcription: "mimo-v2.5-asr",
          realtime: "mimo-v2.5-asr",
        },
        defaults: {},
      },
    ],
    audioAssignment: {
      transcription: null,
      speechSynthesis: null,
      realtimeCaptions: "audio_mimo",
      realtimeVoice: null,
    },
  };
}
