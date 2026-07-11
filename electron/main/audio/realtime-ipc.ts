import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type {
  AudioRealtimeSessionConfig,
  AudioRuntimeModelConfig,
} from "@/type/audio";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  audioIpcSuccess,
  validateAudioRealtimeSessionIpcRequest,
  validateStopAudioRealtimeSessionIpcRequest,
  type AudioIpcResult,
  type RealtimeEphemeralSessionResult,
  type StopAudioRealtimeSessionRequest,
  type StopAudioRealtimeSessionResult,
} from "@/type/audioIpc";
import {
  audioCapabilityIssueToIpcError,
  toAudioIpcError,
} from "./audio-ipc-errors";
import {
  AudioRuntimeConfigStore,
  sharedAudioRuntimeConfigStore,
} from "./audio-runtime-config";
import {
  createOpenAIRealtimeEphemeralSession,
} from "./realtime/openai-realtime-adapter";
import type { AudioIpcClientContext } from "./ipc";
import { sharedAudioPreloadCapabilityRegistry } from "./audio-ipc-security";

type Validator<TRequest> = (payload: unknown) => AudioIpcResult<TRequest>;

export interface AudioRealtimeRuntimeInvokerOptions {
  model: AudioRuntimeModelConfig;
  signal?: AbortSignal;
}

export interface AudioRealtimeRuntimeInvoker {
  createEphemeralSession(
    payload: AudioRealtimeSessionConfig,
    options: AudioRealtimeRuntimeInvokerOptions,
  ): Promise<RealtimeEphemeralSessionResult>;
}

export interface AudioRealtimeIpcServiceOptions {
  runtime?: AudioRealtimeRuntimeInvoker;
  configStore?: AudioRuntimeConfigStore;
}

export class AudioRealtimeIpcService {
  private readonly runtime: AudioRealtimeRuntimeInvoker;
  private readonly configStore: AudioRuntimeConfigStore;
  private readonly activeSessions = new Map<
    string,
    { ownerId: number | "default"; expiresAtMs: number }
  >();

  constructor(options: AudioRealtimeIpcServiceOptions = {}) {
    this.runtime = options.runtime ?? {
      createEphemeralSession: (payload, runtimeOptions) =>
        createOpenAIRealtimeEphemeralSession({ ...runtimeOptions, payload }),
    };
    this.configStore = options.configStore ?? new AudioRuntimeConfigStore();
  }

  async createEphemeralSession(
    payload: AudioRealtimeSessionConfig,
    context?: AudioIpcClientContext,
  ): Promise<AudioIpcResult<RealtimeEphemeralSessionResult>> {
    const ownerId = context?.senderId ?? "default";
    this.pruneExpiredSessions();
    if (
      context?.requireConfigRevision &&
      !this.configStore.isRevisionCurrent(ownerId, context.configRevision)
    ) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message:
          "Audio runtime configuration revision is missing, stale, or belongs to another renderer.",
        field: "configRevision",
      });
    }
    const modelResult = this.configStore.resolveModel(
      payload.assignmentKey,
      ownerId,
    );
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }
    if (modelResult.config.audioDialect !== "openai_realtime") {
      return audioIpcFailure({
        code: "unsupported_audio_capability",
        message: "Realtime WebRTC sessions require an OpenAI Realtime audio profile.",
        field: "audioDialect",
        details: { audioDialect: modelResult.config.audioDialect },
      });
    }

    try {
      const result = await this.runtime.createEphemeralSession(payload, {
        model: modelResult.config,
      });
      if (result.sessionId) {
        this.activeSessions.set(
          createSessionKey(ownerId, result.sessionId),
          {
            ownerId,
            expiresAtMs: parseSessionExpiry(result.expiresAt),
          },
        );
      }
      return audioIpcSuccess(result);
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  async stopSession(
    request: StopAudioRealtimeSessionRequest,
    context?: AudioIpcClientContext,
  ): Promise<AudioIpcResult<StopAudioRealtimeSessionResult>> {
    const ownerId = context?.senderId ?? "default";
    this.pruneExpiredSessions();
    const stopped = this.activeSessions.delete(
      createSessionKey(ownerId, request.sessionId),
    );
    return audioIpcSuccess({
      stopped,
      sessionId: request.sessionId,
      reason: request.reason ?? "user",
    });
  }

  releaseOwner(ownerId: number): void {
    for (const [key, session] of this.activeSessions) {
      if (session.ownerId === ownerId) this.activeSessions.delete(key);
    }
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.activeSessions) {
      if (session.expiresAtMs <= now) this.activeSessions.delete(key);
    }
  }
}

export function setupAudioRealtimeIPC(
  service = new AudioRealtimeIpcService({
    configStore: sharedAudioRuntimeConfigStore,
  }),
): void {
  sharedAudioPreloadCapabilityRegistry.onOwnerReleased((senderId) => {
    service.releaseOwner(senderId);
  });
  handleValidatedRequest<AudioRealtimeSessionConfig, RealtimeEphemeralSessionResult>(
    AUDIO_IPC_CHANNELS.realtimeCreateEphemeralSession,
    validateAudioRealtimeSessionIpcRequest,
    (request, _event, context) =>
      service.createEphemeralSession(request, context),
    { requireConfigRevision: true },
  );

  handleValidatedRequest<
    StopAudioRealtimeSessionRequest,
    StopAudioRealtimeSessionResult
  >(
    AUDIO_IPC_CHANNELS.realtimeStopSession,
    validateStopAudioRealtimeSessionIpcRequest,
    (request, _event, context) => service.stopSession(request, context),
  );
}

function handleValidatedRequest<TRequest, TResponse>(
  channel: string,
  validate: Validator<TRequest>,
  run: (
    request: TRequest,
    event: IpcMainInvokeEvent,
    context: AudioIpcClientContext,
  ) => Promise<AudioIpcResult<TResponse>>,
  options: { requireConfigRevision?: boolean } = {},
): void {
  ipcMain.handle(channel, async (event, envelope: unknown) => {
    const authorization =
      sharedAudioPreloadCapabilityRegistry.authorize<unknown>(event, envelope);
    if (!authorization.ok) return authorization;
    const validation = validate(authorization.data.payload);
    if (!validation.ok) return validation;

    const context: AudioIpcClientContext = {
      senderId: authorization.data.senderId,
      ...(authorization.data.configRevision
        ? { configRevision: authorization.data.configRevision }
        : {}),
      ...(options.requireConfigRevision
        ? { requireConfigRevision: true }
        : {}),
    };

    try {
      return await run(validation.data, event, context);
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  });
}

function parseSessionExpiry(expiresAt: string | undefined): number {
  const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(parsed) && parsed > Date.now()
    ? parsed
    : Date.now() + 10 * 60 * 1000;
}

function createSessionKey(
  ownerId: number | "default",
  sessionId: string,
): string {
  return `${ownerId}:${sessionId}`;
}
