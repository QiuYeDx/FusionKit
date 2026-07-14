import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioRealtimeSessionConfig } from "@/type/audio";
import type { SyncAudioRuntimeConfigRequest } from "@/type/audioIpc";
import { AudioRuntimeConfigStore } from "../../electron/main/audio/audio-runtime-config";
import {
  AudioRealtimeIpcService,
  type AudioRealtimeRuntimeInvoker,
} from "../../electron/main/audio/realtime-ipc";
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
    const { service, context } = createServiceWithConfig(
      createRealtimeRuntimeConfig(server.baseUrl),
    );

    const result = await service.createEphemeralSession(
      {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
        instructions: "Speak concisely.",
        voice: "marin",
        turnDetection: "server_vad",
      },
      context,
    );

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
    }, context)).resolves.toMatchObject({
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
    }, context)).resolves.toMatchObject({
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
    const { service, context } = createServiceWithConfig(
      createRealtimeRuntimeConfig(server.baseUrl),
    );

    const result = await service.createEphemeralSession(
      {
        assignmentKey: "realtimeCaptions",
        mode: "caption",
        language: "en",
        turnDetection: "server_vad",
        inputAudioFormat: "pcm16",
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        clientSecret: "ek-caption-client",
        expiresAt: "2025-06-15T15:06:41.000Z",
      },
    });
  });

  it("rejects MiMo profiles for native WebRTC session creation", async () => {
    const { service, context } = createServiceWithConfig(
      createMimoStreamingRuntimeConfig(),
    );

    const result = await service.createEphemeralSession(
      {
        assignmentKey: "realtimeCaptions",
        mode: "caption",
        language: "zh",
      },
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "audio_route_not_configured",
        field: "transport",
      },
    });
  });

  it.each([
    {
      name: "caption mode mismatch",
      payload: {
        assignmentKey: "realtimeCaptions",
        mode: "duplex_voice",
      } as AudioRealtimeSessionConfig,
      field: "mode",
    },
    {
      name: "caption instructions",
      payload: {
        assignmentKey: "realtimeCaptions",
        mode: "caption",
        instructions: "Transcribe carefully.",
      } as AudioRealtimeSessionConfig,
      field: "instructions",
    },
    {
      name: "caption voice",
      payload: {
        assignmentKey: "realtimeCaptions",
        mode: "caption",
        voice: "marin",
      } as AudioRealtimeSessionConfig,
      field: "voice",
    },
    {
      name: "caption language outside the route allowlist",
      payload: {
        assignmentKey: "realtimeCaptions",
        mode: "caption",
        language: "it",
      } as AudioRealtimeSessionConfig,
      field: "language",
    },
    {
      name: "caption input format outside the route allowlist",
      payload: {
        assignmentKey: "realtimeCaptions",
        mode: "caption",
        inputAudioFormat: "opus",
      } as unknown as AudioRealtimeSessionConfig,
      field: "inputAudioFormat",
    },
    {
      name: "voice language",
      payload: {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
        language: "en",
      } as AudioRealtimeSessionConfig,
      field: "language",
    },
    {
      name: "voice input format outside the route allowlist",
      payload: {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
        inputAudioFormat: "opus",
      } as unknown as AudioRealtimeSessionConfig,
      field: "inputAudioFormat",
    },
    {
      name: "voice output format outside the route allowlist",
      payload: {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
        outputAudioFormat: "opus",
      } as unknown as AudioRealtimeSessionConfig,
      field: "outputAudioFormat",
    },
    {
      name: "voice outside the route allowlist",
      payload: {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
        voice: "nova",
      } as AudioRealtimeSessionConfig,
      field: "voice",
    },
  ])("rejects unsupported realtime $name before adapter invocation", async ({
    payload,
    field,
  }) => {
    const runtime: AudioRealtimeRuntimeInvoker = {
      createEphemeralSession: vi.fn(async () => ({ clientSecret: "unused" })),
    };
    const { service, context } = createServiceWithConfig(
      createRealtimeRuntimeConfig("https://api.openai.com/v1"),
      runtime,
    );

    const result = await service.createEphemeralSession(payload, context);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_task_parameters", field },
    });
    expect(runtime.createEphemeralSession).not.toHaveBeenCalled();
  });

  it.each([
    ["realtimeCaptions", "gpt-realtime-unknown"],
    ["realtimeVoice", "gpt-realtime-whisper"],
    ["realtimeVoice", "gpt-realtime-transcribe"],
  ] as const)(
    "rejects an incompatible %s model before adapter invocation",
    async (assignmentKey, model) => {
      const runtime: AudioRealtimeRuntimeInvoker = {
        createEphemeralSession: vi.fn(async () => ({ clientSecret: "unused" })),
      };
      const snapshot = createRealtimeRuntimeConfig("https://api.openai.com/v1");
      const route = snapshot.profiles[0].routes[assignmentKey];
      if (!route || Array.isArray(route)) {
        throw new Error(`Missing ${assignmentKey} route fixture.`);
      }
      route.model = model;
      const { service, context } = createServiceWithConfig(snapshot, runtime);

      const result = await service.createEphemeralSession(
        assignmentKey === "realtimeCaptions"
          ? { assignmentKey, mode: "caption" }
          : { assignmentKey, mode: "duplex_voice" },
        context,
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_task_parameters", field: "assignmentKey" },
      });
      expect(runtime.createEphemeralSession).not.toHaveBeenCalled();
    },
  );

  it("allows a custom OpenAI-compatible realtime caption model", async () => {
    const runtime: AudioRealtimeRuntimeInvoker = {
      createEphemeralSession: vi.fn(async () => ({
        sessionId: "sess_custom_caption",
        clientSecret: "custom-secret",
      })),
    };
    const snapshot = createRealtimeRuntimeConfig("https://vendor.example/v1");
    snapshot.profiles[0].providerPreset = "custom_openai_compatible";
    snapshot.profiles[0].routes.realtimeCaptions!.model =
      "vendor-live-transcriber";
    const { service, context } = createServiceWithConfig(snapshot, runtime);

    await expect(service.createEphemeralSession(
      { assignmentKey: "realtimeCaptions", mode: "caption", language: "en" },
      context,
    )).resolves.toMatchObject({
      ok: true,
      data: { sessionId: "sess_custom_caption" },
    });
    expect(runtime.createEphemeralSession).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentKey: "realtimeCaptions" }),
      expect.objectContaining({
        model: expect.objectContaining({
          providerPreset: "custom_openai_compatible",
          modelKey: "vendor-live-transcriber",
        }),
      }),
    );
  });

  it("applies portable realtime voice allowlists to custom-compatible models", async () => {
    const runtime: AudioRealtimeRuntimeInvoker = {
      createEphemeralSession: vi.fn(async () => ({
        sessionId: "sess_custom_voice",
        clientSecret: "custom-secret",
      })),
    };
    const snapshot = createRealtimeRuntimeConfig("https://vendor.example/v1");
    snapshot.profiles[0].providerPreset = "custom_openai_compatible";
    snapshot.profiles[0].routes.realtimeVoice!.model = "vendor-live-voice";
    const { service, context } = createServiceWithConfig(snapshot, runtime);

    await expect(service.createEphemeralSession(
      {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
        voice: "nova",
        inputAudioFormat: "pcm16",
        outputAudioFormat: "pcm16",
      },
      context,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_task_parameters", field: "voice" },
    });
    expect(runtime.createEphemeralSession).not.toHaveBeenCalled();

    await expect(service.createEphemeralSession(
      {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
        voice: "marin",
        inputAudioFormat: "pcmu",
        outputAudioFormat: "pcma",
      },
      context,
    )).resolves.toMatchObject({
      ok: true,
      data: { sessionId: "sess_custom_voice" },
    });
    expect(runtime.createEphemeralSession).toHaveBeenCalledTimes(1);
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
    const { service, context } = createServiceWithConfig(
      createRealtimeRuntimeConfig(server.baseUrl),
    );

    const result = await service.createEphemeralSession(
      {
        assignmentKey: "realtimeVoice",
        mode: "duplex_voice",
      },
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "http_unauthorized",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-realtime-ipc");
  });

  it("aborts pending ephemeral creation when its renderer owner is released", async () => {
    const deferred = createDeferred<{
      sessionId: string;
      clientSecret: string;
    }>();
    let signal: AbortSignal | undefined;
    const runtime: AudioRealtimeRuntimeInvoker = {
      createEphemeralSession: vi.fn((_payload, options) => {
        signal = options.signal;
        return deferred.promise;
      }),
    };
    const { service, context } = createServiceWithConfig(
      createRealtimeRuntimeConfig("https://api.openai.com/v1"),
      runtime,
    );

    const pending = service.createEphemeralSession(
      { assignmentKey: "realtimeVoice", mode: "duplex_voice" },
      context,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    service.releaseOwner(context.senderId);
    expect(signal?.aborted).toBe(true);
    deferred.resolve({
      sessionId: "late_session",
      clientSecret: "late_secret",
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    await expect(service.stopSession(
      { sessionId: "late_session", reason: "user" },
      context,
    )).resolves.toMatchObject({
      ok: true,
      data: { stopped: false },
    });
  });
});

function createServiceWithConfig(
  snapshot: SyncAudioRuntimeConfigRequest,
  runtime?: AudioRealtimeRuntimeInvoker,
): {
  service: AudioRealtimeIpcService;
  context: {
    senderId: number;
    configRevision: string;
    requireConfigRevision: true;
  };
} {
  const configStore = new AudioRuntimeConfigStore();
  const senderId = 77;
  const synced = configStore.sync(snapshot, senderId);
  return {
    service: new AudioRealtimeIpcService({
      configStore,
      ...(runtime ? { runtime } : {}),
    }),
    context: {
      senderId,
      configRevision: synced.revision,
      requireConfigRevision: true,
    },
  };
}

function createRealtimeRuntimeConfig(baseUrl: string): SyncAudioRuntimeConfigRequest {
  return {
    profiles: [
      {
        id: "audio_realtime",
        providerPreset: "openai",
        apiKey: "sk-realtime-ipc",
        baseUrl,
        routes: {
          speechSynthesis: {},
          realtimeCaptions: {
            transport: "openai_realtime",
            model: "gpt-realtime-whisper",
            enabled: true,
          },
          realtimeVoice: {
            transport: "openai_realtime",
            model: "gpt-realtime",
            enabled: true,
          },
        },
      },
    ],
    assignment: {
      transcription: null,
      speechSynthesis: null,
      realtimeCaptions: "audio_realtime",
      realtimeVoice: "audio_realtime",
    },
  };
}

function createMimoStreamingRuntimeConfig(): SyncAudioRuntimeConfigRequest {
  return {
    profiles: [
      {
        id: "audio_mimo",
        providerPreset: "mimo",
        apiKey: "mimo-secret-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        routes: {
          speechSynthesis: {},
          realtimeCaptions: {
            transport: "mimo_chat_audio",
            model: "mimo-v2.5-asr",
            enabled: true,
          },
        },
      },
    ],
    assignment: {
      transcription: null,
      speechSynthesis: null,
      realtimeCaptions: "audio_mimo",
      realtimeVoice: null,
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
