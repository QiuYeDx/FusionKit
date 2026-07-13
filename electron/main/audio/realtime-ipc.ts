import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type {
  AudioRealtimeSessionConfig,
  AudioRuntimeAdapterModelConfig,
  ResolvedAudioRouteConfig,
} from "@/type/audio";
import { getRealtimeRouteConstraints } from "@/lib/audio-provider-registry";
import {
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  audioIpcSuccess,
  validateAudioRealtimeSessionIpcRequest,
  validateStopAudioRealtimeSessionIpcRequest,
  type AudioIpcError,
  type AudioIpcResult,
  type RealtimeEphemeralSessionResult,
  type StopAudioRealtimeSessionRequest,
  type StopAudioRealtimeSessionResult,
} from "@/type/audioIpc";
import {
  audioRouteIssueToIpcError,
  toAudioIpcError,
} from "./audio-ipc-errors";
import {
  AudioRuntimeConfigStore,
  sharedAudioRuntimeConfigStore,
  toAudioRuntimeAdapterModelConfig,
} from "./audio-runtime-config";
import {
  createOpenAIRealtimeEphemeralSession,
} from "./realtime/openai-realtime-adapter";
import type { AudioIpcClientContext } from "./ipc";
import { sharedAudioPreloadCapabilityRegistry } from "./audio-ipc-security";

type Validator<TRequest> = (payload: unknown) => AudioIpcResult<TRequest>;

export interface AudioRealtimeRuntimeInvokerOptions {
  model: AudioRuntimeAdapterModelConfig;
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
  private readonly pendingCreations = new Set<{
    ownerId: number;
    controller: AbortController;
  }>();

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
    if (ownerId === "default") {
      return audioIpcFailure({
        code: "stale_audio_config",
        message: "Audio runtime configuration owner is unavailable.",
        field: "configRevision",
      });
    }
    const routeResult = this.configStore.resolveRoute(
      { assignmentKey: payload.assignmentKey },
      ownerId,
      context?.configRevision,
    );
    if (!routeResult.ok) {
      return audioIpcFailure(audioRouteIssueToIpcError(routeResult.issue));
    }
    if (routeResult.config.transport !== "openai_realtime") {
      return audioIpcFailure({
        code: "audio_route_not_configured",
        message: "Realtime WebRTC sessions require an OpenAI Realtime audio profile.",
        field: "transport",
      });
    }
    const parameterError = validateRealtimeTaskParameters(
      payload,
      routeResult.config,
    );
    if (parameterError) return audioIpcFailure(parameterError);
    const model = toAudioRuntimeAdapterModelConfig(routeResult.config);
    const pendingCreation = {
      ownerId,
      controller: new AbortController(),
    };
    this.pendingCreations.add(pendingCreation);

    try {
      const result = await this.runtime.createEphemeralSession(payload, {
        model,
        signal: pendingCreation.controller.signal,
      });
      if (pendingCreation.controller.signal.aborted) {
        return audioIpcFailure({
          code: "aborted",
          message: "Audio realtime session owner was released.",
        });
      }
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
      if (pendingCreation.controller.signal.aborted) {
        return audioIpcFailure({
          code: "aborted",
          message: "Audio realtime session owner was released.",
        });
      }
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      this.pendingCreations.delete(pendingCreation);
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
    for (const pending of this.pendingCreations) {
      if (pending.ownerId !== ownerId) continue;
      this.pendingCreations.delete(pending);
      pending.controller.abort();
    }
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

function validateRealtimeTaskParameters(
  payload: AudioRealtimeSessionConfig,
  route: ResolvedAudioRouteConfig,
): AudioIpcError | undefined {
  const constraints = getRealtimeRouteConstraints(
    route.providerPreset,
    payload.assignmentKey,
  );
  if (!constraints) {
    return invalidRealtimeTaskParameter(
      "assignmentKey",
      "The selected audio API does not define realtime constraints.",
    );
  }
  if (constraints.mode !== payload.mode) {
    return invalidRealtimeTaskParameter(
      "mode",
      "The selected audio route does not support this realtime mode.",
    );
  }
  if (payload.instructions !== undefined && !constraints.supportsInstructions) {
    return invalidRealtimeTaskParameter(
      "instructions",
      "The selected audio route does not support instructions.",
    );
  }
  if (payload.language !== undefined && !constraints.supportsLanguage) {
    return invalidRealtimeTaskParameter(
      "language",
      "The selected audio route does not support language selection.",
    );
  }
  if (payload.voice !== undefined && !constraints.supportsVoice) {
    return invalidRealtimeTaskParameter(
      "voice",
      "The selected audio route does not support voice selection.",
    );
  }
  return undefined;
}

function invalidRealtimeTaskParameter(
  field: string,
  message: string,
): AudioIpcError {
  return { code: "invalid_task_parameters", message, field };
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
