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
  AudioRuntimeAdapterModelConfig,
  ResolvedAudioRouteConfig,
  AudioTranscriptionResult,
  CreateAudioTranscriptionRequest,
  CreateSpeechSynthesisRequest,
  SpeechSynthesisResult,
} from "@/type/audio";
import {
  getSpeechRouteConstraints,
  getTranscriptionRouteConstraints,
} from "@/lib/audio-provider-registry";
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
  type AudioIpcError,
  type AudioIpcResult,
  type AudioOutputDirectorySelection,
  type AuthorizedAudioTranscriptionResult,
  type AuthorizedAudioInputFile,
  type AuthorizedSpeechSynthesisResult,
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
  type SelectAudioOutputDirectoryRequest,
  type SpeechSynthesisStreamEvent,
  type SpeechSynthesisRuntimeStreamEvent,
  type SyncAudioRuntimeConfigRequest,
  type SyncAudioRuntimeConfigResult,
  type TranscribeRecordedAudioChunkRequest,
  type TranscribeRecordedAudioChunkResult,
} from "@/type/audioIpc";
import {
  audioRouteIssueToIpcError,
  toAudioIpcError,
} from "./audio-ipc-errors";
import { createAudioRuntimeError } from "./audio-errors";
import {
  AudioRuntimeConfigStore,
  sharedAudioRuntimeConfigStore,
  toAudioRuntimeAdapterModelConfig,
} from "./audio-runtime-config";
import {
  AudioFileAuthorizationStore,
  cleanupStaleAudioOutputs,
  type AudioFileInfo,
  type AuthorizedAudioFileInfo,
} from "./audio-file";
import {
  AudioOutputDirectoryAuthorizationStore,
  type AuthorizedAudioOutputDirectory,
} from "./audio-output-directory";
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
  model: AudioRuntimeAdapterModelConfig;
  signal?: AbortSignal;
  requestId?: string;
  onStreamEvent?: (
    event: SpeechSynthesisRuntimeStreamEvent,
  ) => void | Promise<void>;
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

interface PendingAudioRequest {
  ownerGeneration: number;
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
    dialect: AudioRuntimeAdapterModelConfig["audioDialect"],
  ): Promise<AudioFileInfo>;
  consume(
    ownerId: number,
    fileToken: string,
    dialect: AudioRuntimeAdapterModelConfig["audioDialect"],
  ): Promise<AudioFileInfo>;
  revoke(ownerId: number, fileToken: string): void;
  releaseOwner(ownerId: number): void;
}

export interface AudioOutputDirectoryAuthorizations {
  authorize(
    ownerId: number,
    directoryPath: string,
  ): Promise<AuthorizedAudioOutputDirectory>;
  resolve(ownerId: number, outputDirToken: string): Promise<string>;
  revoke(ownerId: number, outputDirToken: string): void;
  releaseOwner(ownerId: number): void;
}

export type AudioOutputDirectorySelector = (
  request: SelectAudioOutputDirectoryRequest,
) => Promise<{ canceled: boolean; filePaths: string[] }>;

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
  outputDirectoryAuthorizations?: AudioOutputDirectoryAuthorizations;
  selectOutputDirectory?: AudioOutputDirectorySelector;
}

export class AudioIpcService {
  private readonly runtime: AudioRuntimeInvoker;
  private readonly configStore: AudioRuntimeConfigStore;
  private readonly revealOutputImpl: (outputPath: string) => void;
  private readonly fileAuthorizations: AudioInputFileAuthorizations;
  private readonly outputDirectoryAuthorizations: AudioOutputDirectoryAuthorizations;
  private readonly selectOutputDirectoryImpl: AudioOutputDirectorySelector;
  private readonly transcriptionControllers = new Map<string, ActiveAudioRequest>();
  private readonly chunkTranscriptionControllers = new Map<string, ActiveAudioRequest>();
  private readonly speechControllers = new Map<string, ActiveAudioRequest>();
  private readonly streamControllers = new Map<string, ActiveAudioRequest>();
  private readonly pendingTranscriptionRequestIds =
    new Map<string, PendingAudioRequest>();
  private readonly pendingSpeechRequestIds =
    new Map<string, PendingAudioRequest>();
  private readonly pendingStreamRequestIds =
    new Map<string, PendingAudioRequest>();
  private readonly outputAuthorizations = new Map<string, AuthorizedAudioOutput>();
  private readonly ownerGenerations = new Map<number, number>();

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
    this.outputDirectoryAuthorizations =
      options.outputDirectoryAuthorizations ??
      new AudioOutputDirectoryAuthorizationStore();
    this.selectOutputDirectoryImpl =
      options.selectOutputDirectory ??
      ((request) =>
        dialog.showOpenDialog({
          ...(request.title ? { title: request.title } : {}),
          ...(request.buttonLabel ? { buttonLabel: request.buttonLabel } : {}),
          properties: ["openDirectory", "createDirectory"],
        }));
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
    const ownerGeneration = this.getOwnerGeneration(context.senderId);
    try {
      const authorization = await this.fileAuthorizations.authorize(
        context.senderId,
        request.filePath,
        request.mimeType,
      );
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        this.fileAuthorizations.revoke(
          context.senderId,
          authorization.fileToken,
        );
        return ownerReleasedFailure();
      }
      return audioIpcSuccess(authorization);
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  async selectOutputDirectory(
    request: SelectAudioOutputDirectoryRequest,
    context: AudioIpcClientContext,
  ): Promise<AudioIpcResult<AudioOutputDirectorySelection>> {
    const ownerGeneration = this.getOwnerGeneration(context.senderId);
    try {
      const selected = await this.selectOutputDirectoryImpl(request);
      const directoryPath = selected.filePaths[0];
      if (selected.canceled || !directoryPath) {
        return audioIpcSuccess({ cancelled: true });
      }
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
      const authorization = await this.outputDirectoryAuthorizations.authorize(
        context.senderId,
        directoryPath,
      );
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        this.outputDirectoryAuthorizations.revoke(
          context.senderId,
          authorization.outputDirToken,
        );
        return ownerReleasedFailure();
      }
      return audioIpcSuccess({ cancelled: false, ...authorization });
    } catch (error) {
      return audioIpcFailure(toAudioIpcError(error));
    }
  }

  async transcribe(
    payload: CreateAudioTranscriptionIpcRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<AuthorizedAudioTranscriptionResult>> {
    const ownerGeneration = this.getOwnerGeneration(context.senderId);
    const routeResult = this.configStore.resolveRoute(
      { assignmentKey: payload.assignmentKey },
      context.senderId,
      context.configRevision,
    );
    if (!routeResult.ok) {
      return audioIpcFailure(audioRouteIssueToIpcError(routeResult.issue));
    }
    const parameterError = validateTranscriptionTaskParameters(
      payload,
      routeResult.config,
    );
    if (parameterError) return audioIpcFailure(parameterError);
    const model = toAudioRuntimeAdapterModelConfig(routeResult.config);
    const controllerKey = createControllerKey(
      context.senderId,
      payload.requestId ?? `internal-transcription-${randomUUID()}`,
    );
    const pendingRequest = payload.requestId
      ? this.reserveRequestId(
        this.pendingTranscriptionRequestIds,
        this.transcriptionControllers,
        controllerKey,
        ownerGeneration,
      )
      : undefined;
    if (payload.requestId && !pendingRequest) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Transcription requestId is already active.",
        field: "requestId",
      });
    }
    const controller = pendingRequest?.controller ?? new AbortController();

    let trustedPayload: CreateAudioTranscriptionRequest;
    try {
      const fileInfo = await this.fileAuthorizations.resolve(
        context.senderId,
        payload.fileToken,
        routeResult.config.transport,
      );
      this.assertRequestCanContinue(
        context.senderId,
        ownerGeneration,
        controller.signal,
      );
      const {
        fileToken: _fileToken,
        outputDirToken,
        ...rendererPayload
      } = payload;
      const outputDir = await this.resolveTaskOutputDirectory(
        context.senderId,
        rendererPayload.outputPathMode,
        outputDirToken,
      );
      this.assertRequestCanContinue(
        context.senderId,
        ownerGeneration,
        controller.signal,
      );
      trustedPayload = {
        ...rendererPayload,
        filePath: fileInfo.filePath,
        fileName: fileInfo.fileName,
        mimeType: fileInfo.mimeType,
        ...(outputDir ? { outputDir } : {}),
      };
    } catch (error) {
      if (controller.signal.aborted) return audioRequestAbortedFailure();
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (pendingRequest) {
        this.releasePendingRequestId(
          this.pendingTranscriptionRequestIds,
          controllerKey,
          pendingRequest,
        );
      }
    }
    if (controller.signal.aborted) return audioRequestAbortedFailure();
    if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
      return ownerReleasedFailure();
    }

    this.transcriptionControllers.set(controllerKey, {
      ownerId: context.senderId,
      requestId: payload.requestId ?? controllerKey,
      controller,
    });

    try {
      const result = await this.runtime.transcribe(trustedPayload, {
        model,
        signal: controller.signal,
        requestId: payload.requestId,
      });
      if (
        controller.signal.aborted ||
        !this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)
      ) {
        if (result.outputPath) await this.discardOutputPath(result.outputPath);
        return audioRequestAbortedFailure();
      }
      return audioIpcSuccess(this.authorizeOutput(context.senderId, result));
    } catch (error) {
      if (controller.signal.aborted) return audioRequestAbortedFailure();
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (
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
    if (!this.abortRequest(
      this.pendingTranscriptionRequestIds,
      this.transcriptionControllers,
      controllerKey,
    )) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async transcribeRecordedChunk(
    request: TranscribeRecordedAudioChunkRequest,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<TranscribeRecordedAudioChunkResult>> {
    const ownerGeneration = this.getOwnerGeneration(context.senderId);
    const routeResult = this.configStore.resolveRoute(
      { assignmentKey: request.assignmentKey },
      context.senderId,
      context.configRevision,
    );
    if (!routeResult.ok) {
      return audioIpcFailure(audioRouteIssueToIpcError(routeResult.issue));
    }
    if (routeResult.config.transport === "openai_realtime") {
      return audioIpcFailure({
        code: "audio_route_not_configured",
        message:
          "OpenAI Realtime routes must use the WebRTC caption path, not recorded chunk transcription.",
        field: "transport",
      });
    }
    const parameterError = validateTranscriptionTaskParameters(
      request,
      routeResult.config,
    );
    if (parameterError) return audioIpcFailure(parameterError);
    const model = toAudioRuntimeAdapterModelConfig(routeResult.config);
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
          model,
          signal: controller.signal,
          requestId: request.requestId,
        },
      );
      if (
        controller.signal.aborted ||
        !this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)
      ) {
        return audioRequestAbortedFailure();
      }

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
      if (controller.signal.aborted) return audioRequestAbortedFailure();
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
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
  ): Promise<AudioIpcResult<AuthorizedSpeechSynthesisResult>> {
    const ownerGeneration = this.getOwnerGeneration(context.senderId);
    const routeResult = this.configStore.resolveRoute(
      { assignmentKey: payload.assignmentKey, mode: payload.intent.mode },
      context.senderId,
      context.configRevision,
    );
    if (!routeResult.ok) {
      return audioIpcFailure(audioRouteIssueToIpcError(routeResult.issue));
    }
    const parameterError = validateSpeechTaskParameters(
      payload,
      routeResult.config,
    );
    if (parameterError) return audioIpcFailure(parameterError);
    const model = toAudioRuntimeAdapterModelConfig(routeResult.config);
    const controllerKey = createControllerKey(
      context.senderId,
      payload.requestId ?? `internal-speech-${randomUUID()}`,
    );
    const pendingRequest = payload.requestId
      ? this.reserveRequestId(
        this.pendingSpeechRequestIds,
        this.speechControllers,
        controllerKey,
        ownerGeneration,
      )
      : undefined;
    if (payload.requestId && !pendingRequest) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Speech synthesis requestId is already active.",
        field: "requestId",
      });
    }
    const controller = pendingRequest?.controller ?? new AbortController();

    let trustedPayload: CreateSpeechSynthesisRequest;
    try {
      trustedPayload = await this.createTrustedSpeechPayload(
        payload,
        context.senderId,
        routeResult.config,
        ownerGeneration,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) return audioRequestAbortedFailure();
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (pendingRequest) {
        this.releasePendingRequestId(
          this.pendingSpeechRequestIds,
          controllerKey,
          pendingRequest,
        );
      }
    }
    if (controller.signal.aborted) return audioRequestAbortedFailure();
    if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
      return ownerReleasedFailure();
    }

    this.speechControllers.set(controllerKey, {
      ownerId: context.senderId,
      requestId: payload.requestId ?? controllerKey,
      controller,
    });

    try {
      const result = await this.runtime.synthesize(trustedPayload, {
        model,
        signal: controller.signal,
        requestId: payload.requestId,
      });
      if (
        controller.signal.aborted ||
        !this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)
      ) {
        await this.discardOutputPath(result.outputPath);
        return audioRequestAbortedFailure();
      }
      return audioIpcSuccess(this.authorizeOutput(context.senderId, result));
    } catch (error) {
      if (controller.signal.aborted) return audioRequestAbortedFailure();
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      if (
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
    if (!this.abortRequest(
      this.pendingSpeechRequestIds,
      this.speechControllers,
      controllerKey,
    )) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

    return audioIpcSuccess({
      cancelled: true,
      requestId: request.requestId,
    });
  }

  async synthesizeSpeechStream(
    request: CreateSpeechSynthesisStreamIpcRequest,
    webContents: WebContents,
    context: AudioIpcClientContext = { senderId: 0 },
  ): Promise<AudioIpcResult<AuthorizedSpeechSynthesisResult>> {
    const ownerGeneration = this.getOwnerGeneration(context.senderId);
    const routeResult = this.configStore.resolveRoute(
      {
        assignmentKey: request.payload.assignmentKey,
        mode: request.payload.intent.mode,
      },
      context.senderId,
      context.configRevision,
    );
    if (!routeResult.ok) {
      return audioIpcFailure(audioRouteIssueToIpcError(routeResult.issue));
    }
    const parameterError = validateSpeechTaskParameters(
      request.payload,
      routeResult.config,
    );
    if (parameterError) return audioIpcFailure(parameterError);
    const model = toAudioRuntimeAdapterModelConfig(routeResult.config);
    const controllerKey = createControllerKey(context.senderId, request.requestId);
    const pendingRequest = this.reserveRequestId(
      this.pendingStreamRequestIds,
      this.streamControllers,
      controllerKey,
      ownerGeneration,
    );
    if (!pendingRequest) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: "Speech synthesis stream requestId is already active.",
        field: "requestId",
      });
    }
    const controller = pendingRequest.controller;

    let trustedPayload: CreateSpeechSynthesisRequest;
    try {
      trustedPayload = await this.createTrustedSpeechPayload(
        request.payload,
        context.senderId,
        routeResult.config,
        ownerGeneration,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) return audioRequestAbortedFailure();
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
      return audioIpcFailure(toAudioIpcError(error));
    } finally {
      this.releasePendingRequestId(
        this.pendingStreamRequestIds,
        controllerKey,
        pendingRequest,
      );
    }
    if (controller.signal.aborted) return audioRequestAbortedFailure();
    if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
      return ownerReleasedFailure();
    }
    this.streamControllers.set(controllerKey, {
      ownerId: context.senderId,
      requestId: request.requestId,
      controller,
    });

    let streamedCompletion:
      | {
          outputPath: string;
          result: AuthorizedSpeechSynthesisResult;
        }
      | undefined;
    try {
      const result = await this.runtime.synthesize(trustedPayload, {
        model,
        signal: controller.signal,
        requestId: request.requestId,
        onStreamEvent: (event) => {
          if (
            controller.signal.aborted ||
            !this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)
          ) {
            return;
          }
          let publicEvent: SpeechSynthesisStreamEvent;
          if (event.type === "completed") {
            const authorizedResult = this.authorizeOutput(
              context.senderId,
              event.result,
            );
            streamedCompletion = {
              outputPath: event.result.outputPath,
              result: authorizedResult,
            };
            publicEvent = { ...event, result: authorizedResult };
          } else {
            publicEvent = event;
          }
          if (!webContents.isDestroyed()) {
            webContents.send(
              AUDIO_EVENT_CHANNELS.speechSynthesisStream,
              publicEvent,
            );
          }
        },
      });
      if (
        controller.signal.aborted ||
        !this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)
      ) {
        await this.discardOutputPath(result.outputPath);
        return audioRequestAbortedFailure();
      }
      return audioIpcSuccess(
        streamedCompletion?.outputPath === result.outputPath
          ? streamedCompletion.result
          : this.authorizeOutput(context.senderId, result),
      );
    } catch (error) {
      if (controller.signal.aborted) return audioRequestAbortedFailure();
      if (!this.isOwnerGenerationCurrent(context.senderId, ownerGeneration)) {
        return ownerReleasedFailure();
      }
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
    if (!this.abortRequest(
      this.pendingStreamRequestIds,
      this.streamControllers,
      controllerKey,
    )) {
      return audioIpcSuccess({
        cancelled: false,
        requestId: request.requestId,
      });
    }

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
      return audioIpcSuccess({ revealed: true });
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
    this.ownerGenerations.set(ownerId, this.getOwnerGeneration(ownerId) + 1);
    const ownerPrefix = `${ownerId}:`;
    for (const pending of [
      this.pendingTranscriptionRequestIds,
      this.pendingSpeechRequestIds,
      this.pendingStreamRequestIds,
    ]) {
      for (const [key, request] of pending) {
        if (!key.startsWith(ownerPrefix)) continue;
        pending.delete(key);
        request.controller.abort();
      }
    }
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
    this.outputDirectoryAuthorizations.releaseOwner(ownerId);
    for (const [token, output] of this.outputAuthorizations) {
      if (output.ownerId === ownerId) this.outputAuthorizations.delete(token);
    }
  }

  private getOwnerGeneration(ownerId: number): number {
    return this.ownerGenerations.get(ownerId) ?? 0;
  }

  private isOwnerGenerationCurrent(
    ownerId: number,
    generation: number,
  ): boolean {
    return this.getOwnerGeneration(ownerId) === generation;
  }

  private reserveRequestId(
    pending: Map<string, PendingAudioRequest>,
    active: Map<string, ActiveAudioRequest>,
    controllerKey: string,
    ownerGeneration: number,
  ): PendingAudioRequest | undefined {
    if (pending.has(controllerKey) || active.has(controllerKey)) return undefined;
    const request = {
      ownerGeneration,
      controller: new AbortController(),
    };
    pending.set(controllerKey, request);
    return request;
  }

  private releasePendingRequestId(
    pending: Map<string, PendingAudioRequest>,
    controllerKey: string,
    request: PendingAudioRequest,
  ): void {
    if (pending.get(controllerKey) === request) {
      pending.delete(controllerKey);
    }
  }

  private abortRequest(
    pending: Map<string, PendingAudioRequest>,
    active: Map<string, ActiveAudioRequest>,
    controllerKey: string,
  ): boolean {
    const controller = pending.get(controllerKey)?.controller
      ?? active.get(controllerKey)?.controller;
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private assertRequestCanContinue(
    ownerId: number,
    ownerGeneration: number,
    signal: AbortSignal,
  ): void {
    if (
      signal.aborted ||
      !this.isOwnerGenerationCurrent(ownerId, ownerGeneration)
    ) {
      throw createAudioRuntimeError({
        code: "aborted",
        message: "Audio request was aborted.",
      });
    }
  }

  private async createTrustedSpeechPayload(
    payload: CreateSpeechSynthesisIpcRequest,
    ownerId: number,
    route: ResolvedAudioRouteConfig,
    ownerGeneration: number,
    signal: AbortSignal,
  ): Promise<CreateSpeechSynthesisRequest> {
    const { intent, outputDirToken, ...rendererPayload } = payload;
    const outputDir = await this.resolveTaskOutputDirectory(
      ownerId,
      rendererPayload.outputPathMode,
      outputDirToken,
    );
    this.assertRequestCanContinue(ownerId, ownerGeneration, signal);
    const commonPayload = {
      ...rendererPayload,
      ...(outputDir ? { outputDir } : {}),
    };
    if (route.transport !== "mimo_chat_audio") {
      if (intent.mode !== "preset_voice") {
        throw createAudioRuntimeError({
          code: "invalid_task_parameters",
          message: "This audio route only supports preset voice synthesis.",
          field: "intent.mode",
        });
      }
      return {
        ...commonPayload,
        voice: intent.voice,
      };
    }

    if (intent.mode === "preset_voice") {
      return {
        ...commonPayload,
        voice: intent.voice,
        mimoOptions: {
          mode: intent.mode,
          ...(intent.styleInstruction
            ? { styleInstruction: intent.styleInstruction }
            : {}),
        },
      };
    }

    if (intent.mode === "voice_design") {
      return {
        ...commonPayload,
        mimoOptions: {
          mode: intent.mode,
          voiceDesignPrompt: intent.voiceDesignPrompt,
          ...(intent.optimizeTextPreview !== undefined
            ? { optimizeTextPreview: intent.optimizeTextPreview }
            : {}),
        },
      };
    }

    const fileInfo = await this.fileAuthorizations.consume(
      ownerId,
      intent.voiceSampleToken,
      route.transport,
    );
    this.assertRequestCanContinue(ownerId, ownerGeneration, signal);
    if (
      fileInfo.mimeType !== "audio/wav" &&
      fileInfo.mimeType !== "audio/mpeg" &&
      fileInfo.mimeType !== "audio/mp3"
    ) {
      throw createAudioRuntimeError({
        code: "unsupported_audio_format",
        message: "MiMo voice clone reference must be WAV or MP3 audio.",
        field: "intent.voiceSampleToken",
      });
    }

    return {
      ...commonPayload,
      mimoOptions: {
        mode: intent.mode,
        ...(intent.styleInstruction
          ? { styleInstruction: intent.styleInstruction }
          : {}),
        voiceSamplePath: fileInfo.filePath,
        voiceSampleMime: fileInfo.mimeType,
      },
    };
  }

  private async discardOutputPath(outputPath: string): Promise<void> {
    for (const [token, output] of this.outputAuthorizations) {
      if (output.outputPath === outputPath) this.outputAuthorizations.delete(token);
    }
    await safeUnlink(outputPath);
  }

  private resolveTaskOutputDirectory(
    ownerId: number,
    outputPathMode: CreateSpeechSynthesisRequest["outputPathMode"],
    outputDirToken: string | undefined,
  ): Promise<string | undefined> {
    if (outputPathMode !== "custom_dir" || !outputDirToken) {
      return Promise.resolve(undefined);
    }
    return this.outputDirectoryAuthorizations.resolve(ownerId, outputDirToken);
  }

  private authorizeOutput(
    ownerId: number,
    result: AudioTranscriptionResult,
  ): AuthorizedAudioTranscriptionResult;
  private authorizeOutput(
    ownerId: number,
    result: SpeechSynthesisResult,
  ): AuthorizedSpeechSynthesisResult;
  private authorizeOutput(
    ownerId: number,
    result: AudioTranscriptionResult | SpeechSynthesisResult,
  ): AuthorizedAudioTranscriptionResult | AuthorizedSpeechSynthesisResult {
    const { outputPath, ...rawPublicResult } = result;
    const publicResult = "rawJson" in rawPublicResult &&
        rawPublicResult.rawJson !== undefined
      ? {
          ...rawPublicResult,
          rawJson: sanitizePublicAudioProviderValue(rawPublicResult.rawJson),
        }
      : rawPublicResult;
    if (!outputPath) {
      if ("mimeType" in result) {
        throw createAudioRuntimeError({
          code: "invalid_response",
          message: "Speech synthesis completed without an output file.",
          field: "outputToken",
        });
      }
      return publicResult as AuthorizedAudioTranscriptionResult;
    }
    const now = Date.now();
    for (const [token, output] of this.outputAuthorizations) {
      if (output.expiresAt <= now) this.outputAuthorizations.delete(token);
    }
    const outputToken = randomUUID();
    this.outputAuthorizations.set(outputToken, {
      ownerId,
      outputPath,
      mimeType: "mimeType" in result ? result.mimeType : "application/octet-stream",
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    return "mimeType" in result
      ? ({ ...publicResult, outputToken } as AuthorizedSpeechSynthesisResult)
      : ({ ...publicResult, outputToken } as AuthorizedAudioTranscriptionResult);
  }

  private resolveOutput(ownerId: number, outputToken: string): AuthorizedAudioOutput {
    const output = this.outputAuthorizations.get(outputToken);
    if (!output || output.ownerId !== ownerId) {
      throw createAudioRuntimeError({
        code: "invalid_ipc_request",
        message: "Audio output authorization is invalid or expired.",
        field: "outputToken",
      });
    }
    if (output.expiresAt <= Date.now()) {
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

const SENSITIVE_PUBLIC_AUDIO_RESULT_KEYS = new Set([
  "apikey",
  "authorization",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "clientsecret",
  "path",
  "filepath",
  "outputpath",
  "directory",
  "base64",
  "audiodata",
  "pcmbytes",
  "buffer",
  "bytes",
  "requestbody",
]);

function sanitizePublicAudioProviderValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[redacted]";
    seen.add(value);
    return value.map((item) => sanitizePublicAudioProviderValue(item, seen));
  }
  if (typeof value === "string" && isSensitivePublicAudioString(value)) {
    return "[redacted]";
  }
  if (!isRecord(value)) return value;
  if (seen.has(value)) return "[redacted]";
  seen.add(value);

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SENSITIVE_PUBLIC_AUDIO_RESULT_KEYS.has(normalizedKey)) continue;
    sanitized[key] = sanitizePublicAudioProviderValue(child, seen);
  }
  return sanitized;
}

function isSensitivePublicAudioString(value: string): boolean {
  return (
    /\bBearer\s+[A-Za-z0-9._~-]+/i.test(value) ||
    /\b(?:sk|ek|mimo)-[A-Za-z0-9_-]{12,}\b/i.test(value) ||
    /data:audio\/[a-z0-9.+-]+;base64,/i.test(value) ||
    /(?:^|[\s'"(])\/(?:[^/\s'"`]+\/)+[^\s'"`]*/.test(value) ||
    /\b[A-Za-z]:\\[^\r\n]+/.test(value) ||
    /\\\\[^\\\s]+\\[^\r\n]+/.test(value) ||
    /^[A-Za-z0-9+/]{80,}={0,2}$/.test(value)
  );
}

function validateSpeechTaskParameters(
  payload: CreateSpeechSynthesisIpcRequest,
  route: ResolvedAudioRouteConfig,
): AudioIpcError | undefined {
  const constraints = getSpeechRouteConstraints(
    route.providerPreset,
    payload.intent.mode,
  );
  if (!constraints) {
    return invalidTaskParameter(
      "intent.mode",
      "The selected audio API does not support this speech mode.",
    );
  }
  if (!constraints.responseFormats.includes(payload.responseFormat)) {
    return invalidTaskParameter(
      "responseFormat",
      "The selected audio route does not support this response format.",
    );
  }
  if (payload.stream === true && !constraints.supportsStreaming) {
    return invalidTaskParameter(
      "stream",
      "The selected audio route does not support streaming.",
    );
  }
  const requiredResponseFormat = payload.stream === true
    ? constraints.streamResponseFormat
    : constraints.finalResponseFormat;
  if (
    requiredResponseFormat &&
    payload.responseFormat !== requiredResponseFormat
  ) {
    return invalidTaskParameter(
      "responseFormat",
      payload.stream === true
        ? "The selected audio route requires its streaming response format."
        : "The selected audio route requires its final response format.",
    );
  }
  if (payload.instructions && constraints.fields.instructions === "unsupported") {
    return invalidTaskParameter(
      "instructions",
      "The selected audio route does not support instructions.",
    );
  }
  if (payload.speed !== undefined && constraints.fields.speed === "unsupported") {
    return invalidTaskParameter(
      "speed",
      "The selected audio route does not support speed control.",
    );
  }

  const emptyInputAllowed =
    payload.intent.mode === "voice_design" &&
    payload.intent.optimizeTextPreview === true &&
    constraints.allowEmptyInputWhenOptimizeTextPreview;
  if (
    constraints.inputRequired &&
    !payload.input.trim() &&
    !emptyInputAllowed
  ) {
    return invalidTaskParameter(
      "input",
      "The selected audio route requires synthesis input.",
    );
  }

  if (
    payload.intent.mode === "preset_voice" &&
    constraints.fields.voice === "unsupported"
  ) {
    return invalidTaskParameter(
      "intent.voice",
      "The selected audio route does not support preset voices.",
    );
  }
  if (
    payload.intent.mode === "voice_design" &&
    constraints.fields.voiceDesignPrompt === "unsupported"
  ) {
    return invalidTaskParameter(
      "intent.voiceDesignPrompt",
      "The selected audio route does not support voice design.",
    );
  }
  if (
    payload.intent.mode === "voice_design" &&
    payload.intent.optimizeTextPreview !== undefined &&
    constraints.fields.optimizeTextPreview === "unsupported"
  ) {
    return invalidTaskParameter(
      "intent.optimizeTextPreview",
      "The selected audio route does not support optimized text preview.",
    );
  }
  if (
    payload.intent.mode === "voice_clone" &&
    constraints.fields.referenceAudio === "unsupported"
  ) {
    return invalidTaskParameter(
      "intent.voiceSampleToken",
      "The selected audio route does not support voice cloning.",
    );
  }
  if (
    (payload.intent.mode === "preset_voice" ||
      payload.intent.mode === "voice_clone") &&
    payload.intent.styleInstruction &&
    constraints.fields.styleInstruction === "unsupported"
  ) {
    return invalidTaskParameter(
      "intent.styleInstruction",
      "The selected audio route does not support style instructions.",
    );
  }
  return undefined;
}

function validateTranscriptionTaskParameters(
  payload: {
    responseFormat: CreateAudioTranscriptionIpcRequest["responseFormat"];
    language?: string;
    prompt?: string;
    stream?: boolean;
    timestampGranularities?: CreateAudioTranscriptionIpcRequest["timestampGranularities"];
  },
  route: ResolvedAudioRouteConfig,
): AudioIpcError | undefined {
  const constraints = getTranscriptionRouteConstraints(route.providerPreset);
  if (!constraints) {
    return invalidTaskParameter(
      "assignmentKey",
      "The selected audio API does not define transcription constraints.",
    );
  }
  if (!constraints.responseFormats.includes(payload.responseFormat)) {
    return invalidTaskParameter(
      "responseFormat",
      "The selected audio route does not support this transcription response format.",
    );
  }
  if (
    constraints.languages &&
    payload.language !== undefined &&
    !constraints.languages.includes(payload.language)
  ) {
    return invalidTaskParameter(
      "language",
      "The selected audio route does not support this transcription language.",
    );
  }
  if (payload.prompt !== undefined && !constraints.supportsPrompt) {
    return invalidTaskParameter(
      "prompt",
      "The selected audio route does not support transcription prompts.",
    );
  }
  if (payload.stream === true && !constraints.supportsStreaming) {
    return invalidTaskParameter(
      "stream",
      "The selected audio route does not support streaming transcription.",
    );
  }
  if (
    payload.timestampGranularities !== undefined &&
    !constraints.supportsTimestampGranularities
  ) {
    return invalidTaskParameter(
      "timestampGranularities",
      "The selected audio route does not support transcription timestamps.",
    );
  }
  return undefined;
}

function invalidTaskParameter(
  field: string,
  message: string,
): AudioIpcError {
  return { code: "invalid_task_parameters", message, field };
}

function ownerReleasedFailure<T>(): AudioIpcResult<T> {
  return audioIpcFailure({
    code: "aborted",
    message: "Audio request owner was released.",
  });
}

function audioRequestAbortedFailure<T>(): AudioIpcResult<T> {
  return audioIpcFailure({
    code: "aborted",
    message: "Audio request was aborted.",
  });
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
  ipcMain.handle(
    AUDIO_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory,
    async (event, envelope: unknown) => {
      const authorization =
        sharedAudioPreloadCapabilityRegistry.authorize<unknown>(event, envelope);
      if (!authorization.ok) return authorization;
      const validation = validateSelectAudioOutputDirectoryRequest(
        authorization.data.payload,
      );
      if (!validation.ok) return validation;
      return service.selectOutputDirectory(validation.data, {
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
    AuthorizedAudioTranscriptionResult
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

  handleValidatedRequest<
    CreateSpeechSynthesisIpcRequest,
    AuthorizedSpeechSynthesisResult
  >(
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
    AuthorizedSpeechSynthesisResult
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
    });
  } catch (error) {
    return audioIpcFailure({
      code: "output_write_failed",
      message: "Audio text output could not be saved.",
      field: "output",
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

function validateSelectAudioOutputDirectoryRequest(
  payload: unknown,
): AudioIpcResult<SelectAudioOutputDirectoryRequest> {
  if (!isRecord(payload)) {
    return audioIpcFailure({
      code: "invalid_ipc_request",
      message: "Output directory selection options must be an object.",
    });
  }
  const unexpectedField = Object.keys(payload).find(
    (key) => key !== "title" && key !== "buttonLabel",
  );
  if (unexpectedField) {
    return audioIpcFailure({
      code: "invalid_ipc_request",
      message: "Output directory selection contains an unsupported field.",
      field: unexpectedField,
    });
  }
  for (const field of ["title", "buttonLabel"] as const) {
    const value = payload[field];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > 200)
    ) {
      return audioIpcFailure({
        code: "invalid_ipc_request",
        message: `${field} must be a string of at most 200 characters.`,
        field,
      });
    }
  }
  return audioIpcSuccess({
    ...(typeof payload.title === "string" && payload.title.trim()
      ? { title: payload.title.trim() }
      : {}),
    ...(typeof payload.buttonLabel === "string" && payload.buttonLabel.trim()
      ? { buttonLabel: payload.buttonLabel.trim() }
      : {}),
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
