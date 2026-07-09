import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { shell, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type {
  AudioAssignmentKey,
  AudioRuntimeModelConfig,
  AudioTranscriptionResult,
  CreateAudioTranscriptionRequest,
  CreateSpeechSynthesisRequest,
  SpeechSynthesisResult,
} from "@/type/audio";
import {
  AUDIO_EVENT_CHANNELS,
  AUDIO_IPC_CHANNELS,
  audioIpcFailure,
  audioIpcSuccess,
  validateCancelSpeechSynthesisIpcRequest,
  validateCancelSpeechSynthesisStreamIpcRequest,
  validateCancelAudioTranscriptionIpcRequest,
  validateCancelRecordedAudioChunkTranscriptionIpcRequest,
  validateCreateAudioTranscriptionIpcRequest,
  validateCreateSpeechSynthesisIpcRequest,
  validateCreateSpeechSynthesisStreamIpcRequest,
  validateRevealAudioOutputIpcRequest,
  validateSyncAudioRuntimeConfigIpcRequest,
  validateTranscribeRecordedAudioChunkIpcRequest,
  type AudioIpcResult,
  type CancelAudioTranscriptionRequest,
  type CancelAudioTranscriptionResult,
  type CancelRecordedAudioChunkTranscriptionRequest,
  type CancelRecordedAudioChunkTranscriptionResult,
  type CancelSpeechSynthesisRequest,
  type CancelSpeechSynthesisResult,
  type CancelSpeechSynthesisStreamRequest,
  type CancelSpeechSynthesisStreamResult,
  type CreateSpeechSynthesisStreamIpcRequest,
  type RevealAudioOutputRequest,
  type RevealAudioOutputResult,
  type SpeechSynthesisStreamEvent,
  type SyncAudioRuntimeConfigRequest,
  type SyncAudioRuntimeConfigResult,
  type TranscribeRecordedAudioChunkRequest,
  type TranscribeRecordedAudioChunkResult,
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
  sendAudioTranscription,
  sendSpeechSynthesis,
} from "./audio-runtime-client";

type Validator<TRequest> = (payload: unknown) => AudioIpcResult<TRequest>;
type AudioRuntimeInvokerOptions = {
  model: AudioRuntimeModelConfig;
  signal?: AbortSignal;
  requestId?: string;
  onStreamEvent?: (event: SpeechSynthesisStreamEvent) => void | Promise<void>;
};

export interface AudioRuntimeInvoker {
  transcribe(
    payload: CreateAudioTranscriptionRequest,
    options: AudioRuntimeInvokerOptions,
  ): Promise<AudioTranscriptionResult>;
  synthesize(
    payload: CreateSpeechSynthesisRequest,
    options: AudioRuntimeInvokerOptions,
  ): Promise<SpeechSynthesisResult>;
}

export interface AudioIpcServiceOptions {
  runtime?: AudioRuntimeInvoker;
  configStore?: AudioRuntimeConfigStore;
  revealOutput?: (outputPath: string) => void;
}

export class AudioIpcService {
  private readonly runtime: AudioRuntimeInvoker;
  private readonly configStore: AudioRuntimeConfigStore;
  private readonly revealOutputImpl: (outputPath: string) => void;
  private readonly transcriptionControllers = new Map<string, AbortController>();
  private readonly chunkTranscriptionControllers = new Map<string, AbortController>();
  private readonly speechControllers = new Map<string, AbortController>();
  private readonly streamControllers = new Map<string, AbortController>();

  constructor(options: AudioIpcServiceOptions = {}) {
    this.runtime = options.runtime ?? {
      transcribe: (payload, runtimeOptions) =>
        sendAudioTranscription({ ...runtimeOptions, payload }),
      synthesize: (payload, runtimeOptions) =>
        sendSpeechSynthesis({ ...runtimeOptions, payload }),
    };
    this.configStore = options.configStore ?? new AudioRuntimeConfigStore();
    this.revealOutputImpl =
      options.revealOutput ?? ((outputPath) => shell.showItemInFolder(outputPath));
  }

  async syncRuntimeConfig(
    request: SyncAudioRuntimeConfigRequest,
  ): Promise<AudioIpcResult<SyncAudioRuntimeConfigResult>> {
    return audioIpcSuccess(this.configStore.sync(request));
  }

  async transcribe(
    payload: CreateAudioTranscriptionRequest,
  ): Promise<AudioIpcResult<AudioTranscriptionResult>> {
    const modelResult = this.resolveModel(payload.assignmentKey);
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }

    const controller = payload.requestId ? new AbortController() : undefined;
    if (payload.requestId) {
      if (this.transcriptionControllers.has(payload.requestId)) {
        return audioIpcFailure({
          code: "invalid_ipc_request",
          message: "Transcription requestId is already active.",
          field: "requestId",
        });
      }
      this.transcriptionControllers.set(payload.requestId, controller!);
    }

    try {
      return audioIpcSuccess(
        await this.runtime.transcribe(payload, {
          model: modelResult.config,
          signal: controller?.signal,
          requestId: payload.requestId,
        }),
      );
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (payload.requestId) {
        this.transcriptionControllers.delete(payload.requestId);
      }
    }
  }

  async cancelTranscription(
    request: CancelAudioTranscriptionRequest,
  ): Promise<AudioIpcResult<CancelAudioTranscriptionResult>> {
    const controller = this.transcriptionControllers.get(request.requestId);
    if (!controller) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    controller.abort();
    this.transcriptionControllers.delete(request.requestId);
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async transcribeRecordedChunk(
    request: TranscribeRecordedAudioChunkRequest,
  ): Promise<AudioIpcResult<TranscribeRecordedAudioChunkResult>> {
    const modelResult = this.resolveModel(request.assignmentKey);
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }
    if (modelResult.config.audioDialect === "openai_realtime") {
      return audioIpcFailure({
        code: "unsupported_audio_capability",
        message:
          "OpenAI Realtime profiles should use the realtime WebRTC caption path, not recorded chunk transcription.",
        field: "audioDialect",
      });
    }
    if (this.chunkTranscriptionControllers.has(request.requestId)) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Recorded chunk requestId is already active.",
        field: "requestId",
      });
    }

    const controller = new AbortController();
    this.chunkTranscriptionControllers.set(request.requestId, controller);
    const tempFilePath = await createRecordedChunkTempFile(
      request.requestId,
      request.audioBytes,
    );

    try {
      const result = await this.runtime.transcribe(
        {
          assignmentKey: "transcription",
          requestId: request.requestId,
          filePath: tempFilePath,
          fileName: path.basename(tempFilePath),
          mimeType: request.mimeType,
          responseFormat: request.responseFormat,
          ...(request.language ? { language: request.language } : {}),
        },
        {
          model: modelResult.config,
          signal: controller.signal,
          requestId: request.requestId,
        },
      );

      return audioIpcSuccess({
        requestId: request.requestId,
        text: result.text,
        responseFormat: request.responseFormat,
        ...(result.model ? { model: result.model } : {}),
        ...(request.startedAtMs !== undefined
          ? { startedAtMs: request.startedAtMs }
          : {}),
        ...(request.endedAtMs !== undefined
          ? { endedAtMs: request.endedAtMs }
          : {}),
      });
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      this.chunkTranscriptionControllers.delete(request.requestId);
      await safeUnlink(tempFilePath);
    }
  }

  async cancelRecordedChunkTranscription(
    request: CancelRecordedAudioChunkTranscriptionRequest,
  ): Promise<AudioIpcResult<CancelRecordedAudioChunkTranscriptionResult>> {
    const controller = this.chunkTranscriptionControllers.get(request.requestId);
    if (!controller) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    controller.abort();
    this.chunkTranscriptionControllers.delete(request.requestId);
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async synthesizeSpeech(
    payload: CreateSpeechSynthesisRequest,
  ): Promise<AudioIpcResult<SpeechSynthesisResult>> {
    const modelResult = this.resolveModel(payload.assignmentKey);
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }

    const controller = payload.requestId ? new AbortController() : undefined;
    if (payload.requestId) {
      if (this.speechControllers.has(payload.requestId)) {
        return audioIpcFailure({
          code: "invalid_ipc_request",
          message: "Speech synthesis requestId is already active.",
          field: "requestId",
        });
      }
      this.speechControllers.set(payload.requestId, controller!);
    }

    try {
      return audioIpcSuccess(
        await this.runtime.synthesize(payload, {
          model: modelResult.config,
          signal: controller?.signal,
          requestId: payload.requestId,
        }),
      );
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (payload.requestId) {
        this.speechControllers.delete(payload.requestId);
      }
    }
  }

  async cancelSpeechSynthesis(
    request: CancelSpeechSynthesisRequest,
  ): Promise<AudioIpcResult<CancelSpeechSynthesisResult>> {
    const controller = this.speechControllers.get(request.requestId);
    if (!controller) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    controller.abort();
    this.speechControllers.delete(request.requestId);
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async synthesizeSpeechStream(
    request: CreateSpeechSynthesisStreamIpcRequest,
    webContents: WebContents,
  ): Promise<AudioIpcResult<SpeechSynthesisResult>> {
    const modelResult = this.resolveModel(request.payload.assignmentKey);
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }
    if (this.streamControllers.has(request.requestId)) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Speech synthesis stream requestId is already active.",
        field: "requestId",
      });
    }

    const controller = new AbortController();
    this.streamControllers.set(request.requestId, controller);

    try {
      const result = await this.runtime.synthesize(request.payload, {
        model: modelResult.config,
        signal: controller.signal,
        requestId: request.requestId,
        onStreamEvent: (event) => {
          if (!webContents.isDestroyed()) {
            webContents.send(AUDIO_EVENT_CHANNELS.speechSynthesisStream, event);
          }
        },
      });
      return audioIpcSuccess(result);
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      this.streamControllers.delete(request.requestId);
    }
  }

  async cancelSpeechSynthesisStream(
    request: CancelSpeechSynthesisStreamRequest,
  ): Promise<AudioIpcResult<CancelSpeechSynthesisStreamResult>> {
    const controller = this.streamControllers.get(request.requestId);
    if (!controller) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    controller.abort();
    this.streamControllers.delete(request.requestId);
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async revealOutput(
    request: RevealAudioOutputRequest,
  ): Promise<AudioIpcResult<RevealAudioOutputResult>> {
    try {
      this.revealOutputImpl(request.outputPath);
      return audioIpcSuccess({
        revealed: true,
        path: request.outputPath,
      });
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  private resolveModel(assignmentKey: AudioAssignmentKey) {
    return this.configStore.resolveModel(assignmentKey);
  }
}

export function setupAudioIPC(
  service = new AudioIpcService({
    configStore: sharedAudioRuntimeConfigStore,
  }),
): void {
  handleValidatedRequest<
    SyncAudioRuntimeConfigRequest,
    SyncAudioRuntimeConfigResult
  >(
    AUDIO_IPC_CHANNELS.syncRuntimeConfig,
    validateSyncAudioRuntimeConfigIpcRequest,
    (request) => service.syncRuntimeConfig(request),
  );

  handleValidatedRequest<CreateAudioTranscriptionRequest, AudioTranscriptionResult>(
    AUDIO_IPC_CHANNELS.transcribe,
    validateCreateAudioTranscriptionIpcRequest,
    (request) => service.transcribe(request),
  );

  handleValidatedRequest<
    CancelAudioTranscriptionRequest,
    CancelAudioTranscriptionResult
  >(
    AUDIO_IPC_CHANNELS.cancelTranscription,
    validateCancelAudioTranscriptionIpcRequest,
    (request) => service.cancelTranscription(request),
  );

  handleValidatedRequest<
    TranscribeRecordedAudioChunkRequest,
    TranscribeRecordedAudioChunkResult
  >(
    AUDIO_IPC_CHANNELS.transcribeRecordedChunk,
    validateTranscribeRecordedAudioChunkIpcRequest,
    (request) => service.transcribeRecordedChunk(request),
  );

  handleValidatedRequest<
    CancelRecordedAudioChunkTranscriptionRequest,
    CancelRecordedAudioChunkTranscriptionResult
  >(
    AUDIO_IPC_CHANNELS.cancelRecordedChunkTranscription,
    validateCancelRecordedAudioChunkTranscriptionIpcRequest,
    (request) => service.cancelRecordedChunkTranscription(request),
  );

  handleValidatedRequest<CreateSpeechSynthesisRequest, SpeechSynthesisResult>(
    AUDIO_IPC_CHANNELS.synthesizeSpeech,
    validateCreateSpeechSynthesisIpcRequest,
    (request) => service.synthesizeSpeech(request),
  );

  handleValidatedRequest<
    CancelSpeechSynthesisRequest,
    CancelSpeechSynthesisResult
  >(
    AUDIO_IPC_CHANNELS.cancelSpeechSynthesis,
    validateCancelSpeechSynthesisIpcRequest,
    (request) => service.cancelSpeechSynthesis(request),
  );

  handleValidatedRequest<
    CreateSpeechSynthesisStreamIpcRequest,
    SpeechSynthesisResult
  >(
    AUDIO_IPC_CHANNELS.synthesizeSpeechStream,
    validateCreateSpeechSynthesisStreamIpcRequest,
    (request, event) => service.synthesizeSpeechStream(request, event.sender),
  );

  handleValidatedRequest<
    CancelSpeechSynthesisStreamRequest,
    CancelSpeechSynthesisStreamResult
  >(
    AUDIO_IPC_CHANNELS.cancelSpeechSynthesisStream,
    validateCancelSpeechSynthesisStreamIpcRequest,
    (request) => service.cancelSpeechSynthesisStream(request),
  );

  handleValidatedRequest<RevealAudioOutputRequest, RevealAudioOutputResult>(
    AUDIO_IPC_CHANNELS.revealOutput,
    validateRevealAudioOutputIpcRequest,
    (request) => service.revealOutput(request),
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

async function createRecordedChunkTempFile(
  requestId: string,
  audioBytes: Uint8Array,
): Promise<string> {
  const directory = path.join(os.tmpdir(), "fusionkit-audio", "recorded-chunks");
  await mkdir(directory, { recursive: true });
  const safeRequestId = requestId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const filePath = path.join(
    directory,
    `${safeRequestId || "chunk"}-${randomUUID()}.wav`,
  );
  await writeFile(filePath, audioBytes);
  return filePath;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Temporary recorded chunks are best-effort cleanup artifacts.
  }
}
