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
  type LocalSubtitleInputFileCapture,
  type LocalSubtitleInputSelectionSource,
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
  readonly now?: () => number;
  readonly createInputCaptureNonce?: () => string;
}

const INPUT_CAPTURE_TTL_MS = 30_000;
const MAX_PENDING_INPUT_CAPTURES = 8;
const INPUT_CAPTURE_NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const INPUT_CAPTURE_REF_PATTERN = /^local_subtitle_input_[0-9a-f]{32}$/u;

interface PendingInputCapture {
  readonly files: ReadonlyArray<{ readonly filePath: string }>;
  readonly source: LocalSubtitleInputSelectionSource;
  readonly expiresAt: number;
}

type EventValidator<TEvent> = (
  payload: unknown,
) => LocalSubtitleIpcResult<TEvent>;

export function createLocalSubtitleRendererApi({
  ipcRenderer,
  webUtils,
  ownerSessionRegistration,
  now = Date.now,
  createInputCaptureNonce = defaultInputCaptureNonce,
}: CreateLocalSubtitleRendererApiOptions): LocalSubtitleRendererApi {
  const ownerSession = resolveOwnerSession(ownerSessionRegistration);
  const ownerSessionId = ownerSession?.ownerSessionId;
  const pendingInputCaptures = new Map<string, PendingInputCapture>();

  const purgeExpiredInputCaptures = () => {
    const currentTime = now();
    for (const [captureRef, capture] of pendingInputCaptures) {
      if (capture.expiresAt <= currentTime) {
        pendingInputCaptures.delete(captureRef);
      }
    }
  };

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

  const captureNativeInputFile = (
    file: File,
    captureRef?: string,
    source: LocalSubtitleInputSelectionSource = "picker",
  ): LocalSubtitleIpcResult<LocalSubtitleInputFileCapture> => {
    if (!ownerSessionId) return ownerReleasedFailure();
    if (source !== "picker" && source !== "drop") {
      return invalidRequestFailure("source");
    }
    purgeExpiredInputCaptures();

    let capture: PendingInputCapture | undefined;
    if (captureRef !== undefined) {
      if (
        typeof captureRef !== "string" ||
        !INPUT_CAPTURE_REF_PATTERN.test(captureRef)
      ) {
        return invalidRequestFailure("captureRef");
      }
      capture = pendingInputCaptures.get(captureRef);
      if (!capture) return fileAuthorizationFailure("captureRef");
      if (capture.source !== source) {
        pendingInputCaptures.delete(captureRef);
        return invalidRequestFailure("source");
      }
      if (capture.files.length >= LOCAL_SUBTITLE_LIMITS.maxBatchFiles) {
        pendingInputCaptures.delete(captureRef);
        return invalidRequestFailure("files");
      }
    }

    const fileIndex = capture?.files.length ?? 0;
    let filePath = "";
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      if (captureRef) pendingInputCaptures.delete(captureRef);
      return fileAuthorizationFailure(`files.${fileIndex}`);
    }
    if (typeof filePath !== "string" || filePath.length === 0) {
      if (captureRef) pendingInputCaptures.delete(captureRef);
      return fileAuthorizationFailure(`files.${fileIndex}`);
    }

    if (capture?.files.some((candidate) => candidate.filePath === filePath)) {
      if (captureRef) pendingInputCaptures.delete(captureRef);
      return invalidRequestFailure("files");
    }

    const capturedFile = Object.freeze({ filePath });
    if (capture && captureRef) {
      const files = Object.freeze([...capture.files, capturedFile]);
      pendingInputCaptures.set(captureRef, {
        files,
        source: capture.source,
        expiresAt: capture.expiresAt,
      });
      return {
        ok: true,
        data: Object.freeze({
          captureRef,
          fileCount: files.length,
        }) satisfies LocalSubtitleInputFileCapture,
      };
    }

    while (pendingInputCaptures.size >= MAX_PENDING_INPUT_CAPTURES) {
      const oldestCaptureRef = pendingInputCaptures.keys().next().value;
      if (typeof oldestCaptureRef !== "string") break;
      pendingInputCaptures.delete(oldestCaptureRef);
    }

    let nonce = "";
    try {
      nonce = createInputCaptureNonce();
    } catch {
      return transportFailure();
    }
    if (!INPUT_CAPTURE_NONCE_PATTERN.test(nonce)) return transportFailure();

    const nextCaptureRef = `local_subtitle_input_${nonce}`;
    if (pendingInputCaptures.has(nextCaptureRef)) return transportFailure();
    pendingInputCaptures.set(nextCaptureRef, {
      files: Object.freeze([capturedFile]),
      source,
      expiresAt: now() + INPUT_CAPTURE_TTL_MS,
    });
    return {
      ok: true,
      data: Object.freeze({
        captureRef: nextCaptureRef,
        fileCount: 1,
      }) satisfies LocalSubtitleInputFileCapture,
    };
  };

  const api: LocalSubtitleRendererApi = {
    bridgeVersion: ownerSession?.bridgeVersion ?? 0,
    captureInputFile(file, captureRef, source) {
      // Resolve exactly one native File synchronously while its originating
      // picker/drop event is still active. The renderer receives only a short-
      // lived opaque reference; the path remains private to preload and main.
      return captureNativeInputFile(file, captureRef, source);
    },
    authorizeCapturedInputFiles(captureRef) {
      if (!ownerSessionId) return Promise.resolve(ownerReleasedFailure());
      if (
        typeof captureRef !== "string" ||
        !INPUT_CAPTURE_REF_PATTERN.test(captureRef)
      ) {
        return Promise.resolve(invalidRequestFailure("captureRef"));
      }

      purgeExpiredInputCaptures();
      const capture = pendingInputCaptures.get(captureRef);
      pendingInputCaptures.delete(captureRef);
      if (!capture) {
        return Promise.resolve(fileAuthorizationFailure("captureRef"));
      }

      return invokeInternal(
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
        { source: capture.source, files: capture.files },
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

function defaultInputCaptureNonce(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}
