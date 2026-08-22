import type { IpcRenderer, WebUtils } from "electron";
import {
  LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
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
  const ownerSession = resolveOwnerSession(ownerSessionRegistration);
  const ownerSessionId = ownerSession?.ownerSessionId;

  const invokeOperation = async <TResult>(
    channel: LocalSubtitlePublicInvokeChannel | LocalSubtitlePreloadInternalChannel,
    contract: LocalSubtitlePublicOperationContract,
    payload: unknown,
  ): Promise<LocalSubtitleIpcResult<TResult>> => {
    if (!ownerSessionId) return ownerReleasedFailure();

    const parsedRequest = contract.requestSchema.safeParse(payload);
    if (!parsedRequest.success) {
      return invalidRequestFailure(validationField(parsedRequest.error));
    }

    const parsedEnvelope = localSubtitleSecureIpcEnvelopeSchema(
      contract.requestSchema,
    ).safeParse({
      ownerSessionId,
      payload: parsedRequest.data,
    });
    if (!parsedEnvelope.success) {
      return invalidRequestFailure(validationField(parsedEnvelope.error));
    }

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
    bridgeVersion: ownerSession?.bridgeVersion ?? 0,
    async authorizeInputFiles(files) {
      if (!ownerSessionId) return ownerReleasedFailure();
      if (
        !Array.isArray(files) ||
        files.length === 0 ||
        files.length > LOCAL_SUBTITLE_LIMITS.maxBatchFiles
      ) {
        return invalidRequestFailure("files");
      }

      const authorizedFiles: Array<{ filePath: string }> = [];
      for (let index = 0; index < files.length; index += 1) {
        try {
          const file = files[index]!;
          const filePath = webUtils.getPathForFile(file);
          if (typeof filePath !== "string" || filePath.length === 0) {
            return fileAuthorizationFailure(`files.${index}`);
          }
          authorizedFiles.push({ filePath });
        } catch {
          return fileAuthorizationFailure(`files.${index}`);
        }
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
      if (mode !== "copy" && mode !== "move") {
        return invalidRequestFailure("options.mode");
      }

      let filePath = "";
      try {
        filePath = webUtils.getPathForFile(file);
      } catch {
        return fileAuthorizationFailure("file");
      }
      if (typeof filePath !== "string" || filePath.length === 0) {
        return fileAuthorizationFailure("file");
      }

      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
        { filePath, mode, modelId: options.modelId },
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

function resolveOwnerSession(
  registration: unknown,
): LocalSubtitleOwnerSessionRegistration | undefined {
  const contract =
    LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS[
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession
    ];
  const parsed = contract.resultSchema.safeParse(registration);
  if (!parsed.success) return undefined;

  const result = parsed.data as LocalSubtitleIpcResult<
    LocalSubtitleOwnerSessionRegistration
  >;
  return result.ok ? result.data : undefined;
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

function invalidRequestFailure<T>(field?: string): LocalSubtitleIpcResult<T> {
  return {
    ok: false,
    error: createLocalSubtitleError(
      "invalid_ipc_request",
      "Local subtitle IPC request is invalid.",
      { stage: "ipc", ...(field ? { field } : {}) },
    ),
  };
}

function fileAuthorizationFailure<T>(field: string): LocalSubtitleIpcResult<T> {
  return {
    ok: false,
    error: createLocalSubtitleError(
      "authorization_expired",
      "The selected file is no longer available to the secure subtitle bridge. Select it again.",
      { stage: "preflight", field },
    ),
  };
}

function transportFailure<T>(): LocalSubtitleIpcResult<T> {
  return {
    ok: false,
    error: createLocalSubtitleError(
      "runtime_protocol_mismatch",
      "The local subtitle bridge is unavailable or out of date. Reload the app and retry.",
      { stage: "ipc" },
    ),
  };
}

function validationField(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[] }[];
}): string | undefined {
  const path = error.issues[0]?.path
    .filter((segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number"
    )
    .map(String)
    .join(".");
  return path && path.length <= 256 ? path : undefined;
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
