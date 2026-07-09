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
  private readonly activeSessions = new Map<string, RealtimeEphemeralSessionResult>();

  constructor(options: AudioRealtimeIpcServiceOptions = {}) {
    this.runtime = options.runtime ?? {
      createEphemeralSession: (payload, runtimeOptions) =>
        createOpenAIRealtimeEphemeralSession({ ...runtimeOptions, payload }),
    };
    this.configStore = options.configStore ?? new AudioRuntimeConfigStore();
  }

  async createEphemeralSession(
    payload: AudioRealtimeSessionConfig,
  ): Promise<AudioIpcResult<RealtimeEphemeralSessionResult>> {
    const modelResult = this.configStore.resolveModel(payload.assignmentKey);
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
        this.activeSessions.set(result.sessionId, result);
      }
      return audioIpcSuccess(result);
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  async stopSession(
    request: StopAudioRealtimeSessionRequest,
  ): Promise<AudioIpcResult<StopAudioRealtimeSessionResult>> {
    const stopped = this.activeSessions.delete(request.sessionId);
    return audioIpcSuccess({
      stopped,
      sessionId: request.sessionId,
      reason: request.reason ?? "user",
    });
  }
}

export function setupAudioRealtimeIPC(
  service = new AudioRealtimeIpcService({
    configStore: sharedAudioRuntimeConfigStore,
  }),
): void {
  handleValidatedRequest<AudioRealtimeSessionConfig, RealtimeEphemeralSessionResult>(
    AUDIO_IPC_CHANNELS.realtimeCreateEphemeralSession,
    validateAudioRealtimeSessionIpcRequest,
    (request) => service.createEphemeralSession(request),
  );

  handleValidatedRequest<
    StopAudioRealtimeSessionRequest,
    StopAudioRealtimeSessionResult
  >(
    AUDIO_IPC_CHANNELS.realtimeStopSession,
    validateStopAudioRealtimeSessionIpcRequest,
    (request) => service.stopSession(request),
  );
}

function handleValidatedRequest<TRequest, TResponse>(
  channel: string,
  validate: Validator<TRequest>,
  run: (
    request: TRequest,
    event: IpcMainInvokeEvent,
  ) => Promise<AudioIpcResult<TResponse>>,
): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    const validation = validate(payload);
    if (!validation.ok) return validation;

    try {
      return await run(validation.data, event);
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  });
}
