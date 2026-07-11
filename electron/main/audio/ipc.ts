import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  shell,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
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
  AUDIO_PRELOAD_INTERNAL_CHANNELS,
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
  validateReadAudioOutputIpcRequest,
  validateSaveAudioTextOutputIpcRequest,
  validateSyncAudioRuntimeConfigIpcRequest,
  validateTranscribeRecordedAudioChunkIpcRequest,
  type AudioIpcResult,
  type AuthorizedAudioInputFile,
  type CancelAudioTranscriptionRequest,
  type CancelAudioTranscriptionResult,
  type CancelRecordedAudioChunkTranscriptionRequest,
  type CancelRecordedAudioChunkTranscriptionResult,
  type CancelSpeechSynthesisRequest,
  type CancelSpeechSynthesisResult,
  type CancelSpeechSynthesisStreamRequest,
  type CancelSpeechSynthesisStreamResult,
  type CreateSpeechSynthesisStreamIpcRequest,
  type CreateAudioTranscriptionIpcRequest,
  type CreateSpeechSynthesisIpcRequest,
  type RevealAudioOutputRequest,
  type RevealAudioOutputResult,
  type ReadAudioOutputRequest,
  type ReadAudioOutputResult,
  type SaveAudioTextOutputRequest,
  type SaveAudioTextOutputResult,
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
import { createAudioRuntimeError } from "./audio-errors";
import {
  AudioRuntimeConfigStore,
  sharedAudioRuntimeConfigStore,
} from "./audio-runtime-config";
import {
  AudioFileAuthorizationStore,
  cleanupStaleAudioOutputs,
  type AudioFileInfo,
  type AuthorizedAudioFileInfo,
} from "./audio-file";
import {
  registerAudioPreloadCapability,
  sharedAudioPreloadCapabilityRegistry,
} from "./audio-ipc-security";
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

export interface AudioIpcClientContext {
  senderId: number;
  configRevision?: string;
  requireConfigRevision?: boolean;
}

interface ActiveAudioRequest {
  ownerId: number;
  requestId: string;
  controller: AbortController;
}

interface AuthorizedAudioOutput {
  ownerId: number;
  outputPath: string;
  mimeType: string;
  expiresAt: number;
}

export interface AudioInputFileAuthorizations {
  authorize(
    ownerId: number,
    filePath: string,
    explicitMimeType?: string,
  ): Promise<AuthorizedAudioFileInfo>;
  resolve(
    ownerId: number,
    fileToken: string,
    dialect: AudioRuntimeModelConfig["audioDialect"],
  ): Promise<AudioFileInfo>;
  releaseOwner(ownerId: number): void;
}

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
  fileAuthorizations?: AudioInputFileAuthorizations;
}

export class AudioIpcService {
  private readonly runtime: AudioRuntimeInvoker;
  private readonly configStore: AudioRuntimeConfigStore;
  private readonly revealOutputImpl: (outputPath: string) => void;
  private readonly fileAuthorizations: AudioInputFileAuthorizations;
  private readonly transcriptionControllers = new Map<string, ActiveAudioRequest>();
  private readonly chunkTranscriptionControllers = new Map<string, ActiveAudioRequest>();
  private readonly speechControllers = new Map<string, ActiveAudioRequest>();
  private readonly streamControllers = new Map<string, ActiveAudioRequest>();
  private readonly outputAuthorizations = new Map<string, AuthorizedAudioOutput>();

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
    this.fileAuthorizations =
      options.fileAuthorizations ?? new AudioFileAuthorizationStore();
  }

  async syncRuntimeConfig(
    request: SyncAudioRuntimeConfigRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<SyncAudioRuntimeConfigResult>> {
    return audioIpcSuccess(this.configStore.sync(request, context.senderId));
  }

  async authorizeInputFile(
    request: { filePath: string; mimeType?: string },
    context: AudioIpcClientContext,
  ): Promise<AudioIpcResult<AuthorizedAudioInputFile>> {
    try {
      return audioIpcSuccess(
        await this.fileAuthorizations.authorize(
          context.senderId,
          request.filePath,
          request.mimeType,
        ),
      );
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  async transcribe(
    payload: CreateAudioTranscriptionIpcRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<AudioTranscriptionResult>> {
    const revisionError = this.validateConfigRevision(context);
    if (revisionError) return audioIpcFailure(revisionError);
    const modelResult = this.resolveModel(payload.assignmentKey, context.senderId);
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }

    let trustedPayload: CreateAudioTranscriptionRequest;
    try {
      const fileInfo = await this.fileAuthorizations.resolve(
        context.senderId,
        payload.fileToken,
        modelResult.config.audioDialect,
      );
      const { fileToken: _fileToken, ...rendererPayload } = payload;
      trustedPayload = {
        ...rendererPayload,
        filePath: fileInfo.filePath,
        fileName: fileInfo.fileName,
        mimeType: fileInfo.mimeType,
      };
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }

    const controller = payload.requestId ? new AbortController() : undefined;
    const controllerKey = payload.requestId
      ? createControllerKey(context.senderId, payload.requestId)
      : undefined;
    if (payload.requestId) {
      if (this.transcriptionControllers.has(controllerKey!)) {
        return audioIpcFailure({
          code: "invalid_ipc_request",
          message: "Transcription requestId is already active.",
          field: "requestId",
        });
      }
      this.transcriptionControllers.set(controllerKey!, {
        ownerId: context.senderId,
        requestId: payload.requestId,
        controller: controller!,
      });
    }

    try {
      const result = await this.runtime.transcribe(trustedPayload, {
          model: modelResult.config,
          signal: controller?.signal,
          requestId: payload.requestId,
        });
      return audioIpcSuccess(this.authorizeOutput(context.senderId, result));
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (
        controllerKey &&
        this.transcriptionControllers.get(controllerKey)?.controller === controller
      ) {
        this.transcriptionControllers.delete(controllerKey);
      }
    }
  }

  async cancelTranscription(
    request: CancelAudioTranscriptionRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<CancelAudioTranscriptionResult>> {
    const controllerKey = createControllerKey(context.senderId, request.requestId);
    const active = this.transcriptionControllers.get(controllerKey);
    if (!active) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    active.controller.abort();
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async transcribeRecordedChunk(
    request: TranscribeRecordedAudioChunkRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<TranscribeRecordedAudioChunkResult>> {
    const revisionError = this.validateConfigRevision(context);
    if (revisionError) return audioIpcFailure(revisionError);
    const modelResult = this.resolveModel(request.assignmentKey, context.senderId);
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
    const controllerKey = createControllerKey(context.senderId, request.requestId);
    if (this.chunkTranscriptionControllers.has(controllerKey)) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Recorded chunk requestId is already active.",
        field: "requestId",
      });
    }

    const controller = new AbortController();
    this.chunkTranscriptionControllers.set(controllerKey, {
      ownerId: context.senderId,
      requestId: request.requestId,
      controller,
    });
    let tempFilePath: string | undefined;

    try {
      tempFilePath = await createRecordedChunkTempFile(
        request.requestId,
        request.audioBytes,
      );
      if (controller.signal.aborted) {
        throw createAudioRuntimeError({
          code: "aborted",
          message: "Recorded chunk transcription was aborted.",
        });
      }
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
      if (
        this.chunkTranscriptionControllers.get(controllerKey)?.controller ===
        controller
      ) {
        this.chunkTranscriptionControllers.delete(controllerKey);
      }
      if (tempFilePath) await safeUnlink(tempFilePath);
    }
  }

  async cancelRecordedChunkTranscription(
    request: CancelRecordedAudioChunkTranscriptionRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<CancelRecordedAudioChunkTranscriptionResult>> {
    const controllerKey = createControllerKey(context.senderId, request.requestId);
    const active = this.chunkTranscriptionControllers.get(controllerKey);
    if (!active) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    active.controller.abort();
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async synthesizeSpeech(
    payload: CreateSpeechSynthesisIpcRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<SpeechSynthesisResult>> {
    const revisionError = this.validateConfigRevision(context);
    if (revisionError) return audioIpcFailure(revisionError);
    const modelResult = this.resolveModel(payload.assignmentKey, context.senderId);
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }

    let trustedPayload: CreateSpeechSynthesisRequest;
    try {
      trustedPayload = await this.resolveSpeechInputFiles(
        payload,
        context.senderId,
        modelResult.config.audioDialect,
      );
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }

    const controller = payload.requestId ? new AbortController() : undefined;
    const controllerKey = payload.requestId
      ? createControllerKey(context.senderId, payload.requestId)
      : undefined;
    if (payload.requestId) {
      if (this.speechControllers.has(controllerKey!)) {
        return audioIpcFailure({
          code: "invalid_ipc_request",
          message: "Speech synthesis requestId is already active.",
          field: "requestId",
        });
      }
      this.speechControllers.set(controllerKey!, {
        ownerId: context.senderId,
        requestId: payload.requestId,
        controller: controller!,
      });
    }

    try {
      const result = await this.runtime.synthesize(trustedPayload, {
          model: modelResult.config,
          signal: controller?.signal,
          requestId: payload.requestId,
        });
      return audioIpcSuccess(this.authorizeOutput(context.senderId, result));
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (
        controllerKey &&
        this.speechControllers.get(controllerKey)?.controller === controller
      ) {
        this.speechControllers.delete(controllerKey);
      }
    }
  }

  async cancelSpeechSynthesis(
    request: CancelSpeechSynthesisRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<CancelSpeechSynthesisResult>> {
    const controllerKey = createControllerKey(context.senderId, request.requestId);
    const active = this.speechControllers.get(controllerKey);
    if (!active) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    active.controller.abort();
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async synthesizeSpeechStream(
    request: CreateSpeechSynthesisStreamIpcRequest,
    webContents: WebContents,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<SpeechSynthesisResult>> {
    const revisionError = this.validateConfigRevision(context);
    if (revisionError) return audioIpcFailure(revisionError);
    const modelResult = this.resolveModel(
      request.payload.assignmentKey,
      context.senderId,
    );
    if (!modelResult.ok) {
      return audioIpcFailure(audioCapabilityIssueToIpcError(modelResult.issue));
    }
    const controllerKey = createControllerKey(context.senderId, request.requestId);
    if (this.streamControllers.has(controllerKey)) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Speech synthesis stream requestId is already active.",
        field: "requestId",
      });
    }

    const controller = new AbortController();
    this.streamControllers.set(controllerKey, {
      ownerId: context.senderId,
      requestId: request.requestId,
      controller,
    });

    try {
      const trustedPayload = await this.resolveSpeechInputFiles(
        request.payload,
        context.senderId,
        modelResult.config.audioDialect,
      );
      const result = await this.runtime.synthesize(trustedPayload, {
        model: modelResult.config,
        signal: controller.signal,
        requestId: request.requestId,
        onStreamEvent: (event) => {
          if (!webContents.isDestroyed()) {
            webContents.send(AUDIO_EVENT_CHANNELS.speechSynthesisStream, event);
          }
        },
      });
      return audioIpcSuccess(this.authorizeOutput(context.senderId, result));
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (
        this.streamControllers.get(controllerKey)?.controller === controller
      ) {
        this.streamControllers.delete(controllerKey);
      }
    }
  }

  async cancelSpeechSynthesisStream(
    request: CancelSpeechSynthesisStreamRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<CancelSpeechSynthesisStreamResult>> {
    const controllerKey = createControllerKey(context.senderId, request.requestId);
    const active = this.streamControllers.get(controllerKey);
    if (!active) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    active.controller.abort();
    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async revealOutput(
    request: RevealAudioOutputRequest,
    context: AudioIpcClientContext,
  ): Promise<AudioIpcResult<RevealAudioOutputResult>> {
    try {
      const output = this.resolveOutput(context.senderId, request.outputToken);
      this.revealOutputImpl(output.outputPath);
      return audioIpcSuccess({
        revealed: true,
        path: output.outputPath,
      });
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  async readOutput(
    request: ReadAudioOutputRequest,
    context: AudioIpcClientContext,
  ): Promise<AudioIpcResult<ReadAudioOutputResult>> {
    try {
      const output = this.resolveOutput(context.senderId, request.outputToken);
      return audioIpcSuccess({
        bytes: new Uint8Array(await readFile(output.outputPath)),
        mimeType: output.mimeType,
      });
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  releaseOwner(ownerId: number): void {
    for (const controllers of [
      this.transcriptionControllers,
      this.chunkTranscriptionControllers,
      this.speechControllers,
      this.streamControllers,
    ]) {
      for (const [key, active] of controllers) {
        if (active.ownerId !== ownerId) continue;
        controllers.delete(key);
        active.controller.abort();
      }
    }
    this.configStore.clearOwner(ownerId);
    this.fileAuthorizations.releaseOwner(ownerId);
    for (const [token, output] of this.outputAuthorizations) {
      if (output.ownerId === ownerId) this.outputAuthorizations.delete(token);
    }
  }

  private validateConfigRevision(context: AudioIpcClientContext) {
    if (!context.requireConfigRevision) return undefined;
    if (
      this.configStore.isRevisionCurrent(
        context.senderId,
        context.configRevision,
      )
    ) {
      return undefined;
    }
    return {
      code: "invalid_ipc_request" as const,
      message:
        "Audio runtime configuration revision is missing, stale, or belongs to another renderer.",
      field: "configRevision",
    };
  }

  private async resolveSpeechInputFiles(
    payload: CreateSpeechSynthesisIpcRequest,
    ownerId: number,
    dialect: AudioRuntimeModelConfig["audioDialect"],
  ): Promise<CreateSpeechSynthesisRequest> {
    if (!payload.mimoOptions) {
      return payload as CreateSpeechSynthesisRequest;
    }

    const { voiceSampleToken, ...mimoOptions } = payload.mimoOptions;
    if (!voiceSampleToken) {
      return {
        ...payload,
        mimoOptions,
      } as CreateSpeechSynthesisRequest;
    }

    const fileInfo = await this.fileAuthorizations.resolve(
      ownerId,
      voiceSampleToken,
      dialect,
    );
    if (
      fileInfo.mimeType !== "audio/wav" &&
      fileInfo.mimeType !== "audio/mpeg" &&
      fileInfo.mimeType !== "audio/mp3"
    ) {
      throw createAudioRuntimeError({
        code: "unsupported_audio_format",
        message: "MiMo voice clone reference must be WAV or MP3 audio.",
        field: "mimoOptions.voiceSampleToken",
      });
    }

    return {
      ...payload,
      mimoOptions: {
        ...mimoOptions,
        voiceSamplePath: fileInfo.filePath,
        voiceSampleMime: fileInfo.mimeType,
      },
    } as CreateSpeechSynthesisRequest;
  }

  private resolveModel(assignmentKey: AudioAssignmentKey, ownerId: number) {
    return this.configStore.resolveModel(assignmentKey, ownerId);
  }

  private authorizeOutput<T extends AudioTranscriptionResult | SpeechSynthesisResult>(
    ownerId: number,
    result: T,
  ): T {
    if (!result.outputPath) return result;
    const now = Date.now();
    for (const [token, output] of this.outputAuthorizations) {
      if (output.expiresAt <= now) this.outputAuthorizations.delete(token);
    }
    const outputToken = randomUUID();
    this.outputAuthorizations.set(outputToken, {
      ownerId,
      outputPath: result.outputPath,
      mimeType: "mimeType" in result ? result.mimeType : "application/octet-stream",
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    return { ...result, outputToken };
  }

  private resolveOutput(ownerId: number, outputToken: string): AuthorizedAudioOutput {
    const output = this.outputAuthorizations.get(outputToken);
    if (!output || output.ownerId !== ownerId || output.expiresAt <= Date.now()) {
      this.outputAuthorizations.delete(outputToken);
      throw createAudioRuntimeError({
        code: "invalid_ipc_request",
        message: "Audio output authorization is invalid or expired.",
        field: "outputToken",
      });
    }
    return output;
  }
}

export function setupAudioIPC(
  service = new AudioIpcService({
    configStore: sharedAudioRuntimeConfigStore,
  }),
): void {
  ipcMain.on(
    AUDIO_PRELOAD_INTERNAL_CHANNELS.registerCapability,
    (event, capability: unknown) => {
      event.returnValue = registerAudioPreloadCapability(event, capability);
    },
  );
  ipcMain.handle(
    AUDIO_PRELOAD_INTERNAL_CHANNELS.authorizeInputFile,
    async (event, envelope: unknown) => {
      const authorization =
        sharedAudioPreloadCapabilityRegistry.authorize<unknown>(event, envelope);
      if (!authorization.ok) return authorization;
      const validation = validateAuthorizeInputFileRequest(
        authorization.data.payload,
      );
      if (!validation.ok) return validation;
      return service.authorizeInputFile(validation.data, {
        senderId: authorization.data.senderId,
      });
    },
  );
  sharedAudioPreloadCapabilityRegistry.onOwnerReleased((senderId) => {
    service.releaseOwner(senderId);
  });
  void cleanupStaleRecordedChunkTempFiles();
  void cleanupStaleAudioOutputs();

  handleValidatedRequest<
    SyncAudioRuntimeConfigRequest,
    SyncAudioRuntimeConfigResult
  >(
    AUDIO_IPC_CHANNELS.syncRuntimeConfig,
    validateSyncAudioRuntimeConfigIpcRequest,
    (request, _event, context) => service.syncRuntimeConfig(request, context),
  );

  handleValidatedRequest<
    CreateAudioTranscriptionIpcRequest,
    AudioTranscriptionResult
  >(
    AUDIO_IPC_CHANNELS.transcribe,
    validateCreateAudioTranscriptionIpcRequest,
    (request, _event, context) => service.transcribe(request, context),
    { requireConfigRevision: true },
  );

  handleValidatedRequest<
    CancelAudioTranscriptionRequest,
    CancelAudioTranscriptionResult
  >(
    AUDIO_IPC_CHANNELS.cancelTranscription,
    validateCancelAudioTranscriptionIpcRequest,
    (request, _event, context) => service.cancelTranscription(request, context),
  );

  handleValidatedRequest<
    TranscribeRecordedAudioChunkRequest,
    TranscribeRecordedAudioChunkResult
  >(
    AUDIO_IPC_CHANNELS.transcribeRecordedChunk,
    validateTranscribeRecordedAudioChunkIpcRequest,
    (request, _event, context) =>
      service.transcribeRecordedChunk(request, context),
    { requireConfigRevision: true },
  );

  handleValidatedRequest<
    CancelRecordedAudioChunkTranscriptionRequest,
    CancelRecordedAudioChunkTranscriptionResult
  >(
    AUDIO_IPC_CHANNELS.cancelRecordedChunkTranscription,
    validateCancelRecordedAudioChunkTranscriptionIpcRequest,
    (request, _event, context) =>
      service.cancelRecordedChunkTranscription(request, context),
  );

  handleValidatedRequest<CreateSpeechSynthesisIpcRequest, SpeechSynthesisResult>(
    AUDIO_IPC_CHANNELS.synthesizeSpeech,
    validateCreateSpeechSynthesisIpcRequest,
    (request, _event, context) => service.synthesizeSpeech(request, context),
    { requireConfigRevision: true },
  );

  handleValidatedRequest<
    CancelSpeechSynthesisRequest,
    CancelSpeechSynthesisResult
  >(
    AUDIO_IPC_CHANNELS.cancelSpeechSynthesis,
    validateCancelSpeechSynthesisIpcRequest,
    (request, _event, context) =>
      service.cancelSpeechSynthesis(request, context),
  );

  handleValidatedRequest<
    CreateSpeechSynthesisStreamIpcRequest,
    SpeechSynthesisResult
  >(
    AUDIO_IPC_CHANNELS.synthesizeSpeechStream,
    validateCreateSpeechSynthesisStreamIpcRequest,
    (request, event, context) =>
      service.synthesizeSpeechStream(request, event.sender, context),
    { requireConfigRevision: true },
  );

  handleValidatedRequest<
    CancelSpeechSynthesisStreamRequest,
    CancelSpeechSynthesisStreamResult
  >(
    AUDIO_IPC_CHANNELS.cancelSpeechSynthesisStream,
    validateCancelSpeechSynthesisStreamIpcRequest,
    (request, _event, context) =>
      service.cancelSpeechSynthesisStream(request, context),
  );

  handleValidatedRequest<RevealAudioOutputRequest, RevealAudioOutputResult>(
    AUDIO_IPC_CHANNELS.revealOutput,
    validateRevealAudioOutputIpcRequest,
    (request, _event, context) => service.revealOutput(request, context),
  );

  handleValidatedRequest<ReadAudioOutputRequest, ReadAudioOutputResult>(
    AUDIO_IPC_CHANNELS.readOutput,
    validateReadAudioOutputIpcRequest,
    (request, _event, context) => service.readOutput(request, context),
  );

  handleValidatedRequest<SaveAudioTextOutputRequest, SaveAudioTextOutputResult>(
    AUDIO_IPC_CHANNELS.saveTextOutput,
    validateSaveAudioTextOutputIpcRequest,
    (request) => saveAudioTextOutput(request),
  );
}

async function saveAudioTextOutput(
  request: SaveAudioTextOutputRequest,
): Promise<AudioIpcResult<SaveAudioTextOutputResult>> {
  const defaultName = path.basename(request.defaultName);
  const selected = await dialog.showSaveDialog({
    title: "Save audio text output",
    defaultPath: defaultName,
    filters: [
      { name: request.extension.toUpperCase(), extensions: [request.extension] },
    ],
  });
  if (selected.canceled || !selected.filePath) {
    return audioIpcSuccess({ saved: false, cancelled: true });
  }
  try {
    await writeFile(selected.filePath, request.content, "utf8");
    return audioIpcSuccess({
      saved: true,
      cancelled: false,
      path: selected.filePath,
    });
  } catch (error) {
    return audioIpcFailure({
      code: "output_write_failed",
      message: "Audio text output could not be saved.",
      field: "path",
      details: { path: selected.filePath },
    });
  }
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

function validateAuthorizeInputFileRequest(
  payload: unknown,
): AudioIpcResult<{ filePath: string; mimeType?: string }> {
  if (!isRecord(payload) || !isNonEmptyString(payload.filePath)) {
    return audioIpcFailure({
      code: "invalid_ipc_request",
      message: "Authorized audio selection must contain a file path.",
      field: "filePath",
    });
  }
  if (payload.mimeType !== undefined && typeof payload.mimeType !== "string") {
    return audioIpcFailure({
      code: "invalid_ipc_request",
      message: "Authorized audio selection MIME type must be a string.",
      field: "mimeType",
    });
  }
  return audioIpcSuccess({
    filePath: payload.filePath,
    ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
  });
}

export async function createRecordedChunkTempFile(
  requestId: string,
  audioBytes: Uint8Array,
): Promise<string> {
  const directory = getRecordedChunkTempDirectory();
  await mkdir(directory, { recursive: true });
  const safeRequestId = requestId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const filePath = path.join(
    directory,
    `${safeRequestId || "chunk"}-${randomUUID()}.wav`,
  );
  try {
    await writeFile(filePath, audioBytes, { flag: "wx" });
    return filePath;
  } catch (error) {
    await safeUnlink(filePath);
    throw error;
  }
}

export async function cleanupStaleRecordedChunkTempFiles(options: {
  maxAgeMs?: number;
  now?: number;
} = {}): Promise<void> {
  const directory = getRecordedChunkTempDirectory();
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".wav"))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        try {
          const fileStat = await stat(filePath);
          if (now - fileStat.mtimeMs >= maxAgeMs) await safeUnlink(filePath);
        } catch {
          // A concurrent request may already have removed the temporary file.
        }
      }),
  );
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Temporary recorded chunks are best-effort cleanup artifacts.
  }
}

function createControllerKey(ownerId: number, requestId: string): string {
  return `${ownerId}:${requestId}`;
}

function getRecordedChunkTempDirectory(): string {
  return path.join(os.tmpdir(), "fusionkit-audio", "recorded-chunks");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
