import type { IpcRenderer, WebUtils } from "electron";
import {
  LOCAL_SUBTITLE_LIMITS,
  createLocalSubtitleError,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleTaskEventEnvelope,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS,
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS,
  localSubtitleSecureIpcEnvelopeSchema,
  validateLocalSubtitleResourceEventEnvelope,
  validateLocalSubtitleTaskEventEnvelope,
  type LocalSubtitleIpcResult,
  type LocalSubtitleOwnerSessionRegistration,
  type LocalSubtitlePreloadInternalChannel,
  type LocalSubtitlePublicInvokeChannel,
  type LocalSubtitlePublicOperationContract,
  type LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";

export interface CreateLocalSubtitleRendererApiOptions {
  readonly ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "off">;
  readonly webUtils: Pick<WebUtils, "getPathForFile">;
  readonly ownerSessionRegistration: unknown;
}

type EventValidator<TEvent> = (
  payload: unknown,
) => LocalSubtitleIpcResult<TEvent>;

export function createLocalSubtitleRendererApi({
  ipcRenderer,
  webUtils,
  ownerSessionRegistration,
}: CreateLocalSubtitleRendererApiOptions): LocalSubtitleRendererApi {
  const ownerSessionId = resolveOwnerSessionId(ownerSessionRegistration);

  const invokeOperation = async <TResult>(
    channel: LocalSubtitlePublicInvokeChannel | LocalSubtitlePreloadInternalChannel,
    contract: LocalSubtitlePublicOperationContract,
    payload: unknown,
  ): Promise<LocalSubtitleIpcResult<TResult>> => {
    if (!ownerSessionId) return ownerReleasedFailure();

    const parsedRequest = contract.requestSchema.safeParse(payload);
    if (!parsedRequest.success) return invalidRequestFailure();

    const parsedEnvelope = localSubtitleSecureIpcEnvelopeSchema(
      contract.requestSchema,
    ).safeParse({
      ownerSessionId,
      payload: parsedRequest.data,
    });
    if (!parsedEnvelope.success) return invalidRequestFailure();

    let response: unknown;
    try {
      response = await ipcRenderer.invoke(channel, parsedEnvelope.data);
    } catch {
      return transportFailure();
    }

    const parsedResponse = contract.resultSchema.safeParse(response);
    if (!parsedResponse.success) return invalidContentFailure();
    return parsedResponse.data as LocalSubtitleIpcResult<TResult>;
  };

  const invokePublic = <TResult>(
    channel: LocalSubtitlePublicInvokeChannel,
    payload: unknown,
  ) =>
    invokeOperation<TResult>(
      channel,
      LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[channel],
      payload,
    );

  const invokeInternal = <TResult>(
    channel: LocalSubtitlePreloadInternalChannel,
    payload: unknown,
  ) => {
    const contract = LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS[channel];
    if (!contract.requiresOwnerEnvelope) {
      return Promise.resolve(invalidRequestFailure<TResult>());
    }
    return invokeOperation<TResult>(channel, contract, payload);
  };

  const subscribe = <TEvent>(
    channel: (typeof LOCAL_SUBTITLE_EVENT_CHANNELS)[keyof typeof LOCAL_SUBTITLE_EVENT_CHANNELS],
    validate: EventValidator<TEvent>,
    listener: (event: TEvent) => void,
  ): (() => void) => {
    if (!ownerSessionId || typeof listener !== "function") return noOp;

    const wrapped = (_event: unknown, payload: unknown) => {
      const parsedEvent = validate(payload);
      if (parsedEvent.ok) listener(parsedEvent.data);
    };

    try {
      ipcRenderer.on(channel, wrapped);
    } catch {
      return noOp;
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      try {
        ipcRenderer.off(channel, wrapped);
      } catch {
        // Unsubscription remains idempotent if Electron is already tearing down.
      }
    };
  };

  const api: LocalSubtitleRendererApi = {
    async authorizeInputFiles(files) {
      if (!ownerSessionId) return ownerReleasedFailure();
      if (
        !Array.isArray(files) ||
        files.length === 0 ||
        files.length > LOCAL_SUBTITLE_LIMITS.maxBatchFiles
      ) {
        return invalidRequestFailure();
      }

      const authorizedFiles: Array<{ filePath: string }> = [];
      try {
        for (const file of files) {
          const filePath = webUtils.getPathForFile(file);
          if (typeof filePath !== "string" || filePath.length === 0) {
            return invalidRequestFailure();
          }
          authorizedFiles.push({ filePath });
        }
      } catch {
        return invalidRequestFailure();
      }

      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
        { files: authorizedFiles },
      );
    },
    probeMedia(fileToken) {
      return invokePublic(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia, {
        fileToken,
      });
    },
    revokeInputFile(fileToken) {
      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile,
        { fileToken },
      );
    },
    selectOutputDirectory() {
      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory,
        {},
      );
    },
    revokeOutputDirectory(outputDirToken) {
      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory,
        { outputDirToken },
      );
    },
    probeRuntime() {
      return invokePublic(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeRuntime, {});
    },
    previewBackend(request) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.previewBackend,
        request,
      );
    },
    listManagedResources() {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources,
        {},
      );
    },
    startResourceInstall(request) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall,
        request,
      );
    },
    cancelResourceJob(jobId) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob,
        { jobId },
      );
    },
    async importModel(file, options) {
      if (!ownerSessionId) return ownerReleasedFailure();
      const mode = options?.mode;
      if (mode !== "copy" && mode !== "move") return invalidRequestFailure();

      let filePath = "";
      try {
        filePath = webUtils.getPathForFile(file);
      } catch {
        return invalidRequestFailure();
      }
      if (typeof filePath !== "string" || filePath.length === 0) {
        return invalidRequestFailure();
      }

      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
        { filePath, mode },
      );
    },
    deleteManagedResource(resourceId) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource,
        { resourceId },
      );
    },
    getSessionSnapshot() {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot,
        {},
      );
    },
    enqueue(request) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
        request,
      );
    },
    retryTask(taskId) {
      return invokePublic(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTask, {
        taskId,
      });
    },
    retryTaskOnCpu(request) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTaskOnCpu,
        request,
      );
    },
    cancelBatch(batchId) {
      return invokePublic(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelBatch, {
        batchId,
      });
    },
    cancelTask(taskId) {
      return invokePublic(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask, {
        taskId,
      });
    },
    removeTask(taskId) {
      return invokePublic(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask, {
        taskId,
      });
    },
    completePostAction(request) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.completePostAction,
        request,
      );
    },
    readArtifactText(artifactRef) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText,
        { artifactRef },
      );
    },
    revealArtifact(artifactRef) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact,
        { artifactRef },
      );
    },
    handoffArtifact(artifactRef) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact,
        { artifactRef },
      );
    },
    listOverwriteRecoveries(request = {}) {
      return invokePublic(
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listOverwriteRecoveries,
        request,
      );
    },
    recoverOverwrite(recoveryId) {
      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.recoverOverwrite,
        { recoveryId },
      );
    },
    onTaskEvent(listener) {
      return subscribe<LocalSubtitleTaskEventEnvelope>(
        LOCAL_SUBTITLE_EVENT_CHANNELS.taskEvent,
        validateLocalSubtitleTaskEventEnvelope,
        listener,
      );
    },
    onResourceEvent(listener) {
      return subscribe<LocalSubtitleResourceEventEnvelope>(
        LOCAL_SUBTITLE_EVENT_CHANNELS.resourceEvent,
        validateLocalSubtitleResourceEventEnvelope,
        listener,
      );
    },
  };

  return Object.freeze(api);
}

function resolveOwnerSessionId(registration: unknown): string | undefined {
  const contract =
    LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS[
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession
    ];
  const parsed = contract.resultSchema.safeParse(registration);
  if (!parsed.success) return undefined;

  const result = parsed.data as LocalSubtitleIpcResult<
    LocalSubtitleOwnerSessionRegistration
  >;
  return result.ok ? result.data.ownerSessionId : undefined;
}

function ownerReleasedFailure<T>(): LocalSubtitleIpcResult<T> {
  return {
    ok: false,
    error: createLocalSubtitleError(
      "owner_released",
      "Local subtitle owner session is unavailable.",
    ),
  };
}

function invalidRequestFailure<T>(): LocalSubtitleIpcResult<T> {
  return {
    ok: false,
    error: createLocalSubtitleError(
      "invalid_ipc_request",
      "Local subtitle IPC request is invalid.",
    ),
  };
}

function transportFailure<T>(): LocalSubtitleIpcResult<T> {
  return {
    ok: false,
    error: createLocalSubtitleError(
      "invalid_ipc_request",
      "Local subtitle IPC transport is unavailable.",
    ),
  };
}

function invalidContentFailure<T>(): LocalSubtitleIpcResult<T> {
  return {
    ok: false,
    error: createLocalSubtitleError(
      "invalid_content",
      "Local subtitle IPC response is invalid.",
      { stage: "ipc" },
    ),
  };
}

function noOp(): void {}
