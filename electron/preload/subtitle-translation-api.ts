import type { IpcRenderer, WebUtils } from "electron";
import {
  SUBTITLE_TRANSLATION_INTERNAL_OPERATION_CONTRACTS,
  SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS,
  subtitleTranslationIpcFailure,
  subtitleTranslationOwnerSessionIdSchema,
  subtitleTranslationSecureIpcEnvelopeSchema,
  type SubtitleTranslationIpcResult,
  type SubtitleTranslationInputFileCapture,
  type SubtitleTranslationAgentInputSelection,
  type SubtitleTranslationAgentInputSelectionRequest,
  type SubtitleTranslationAgentInputSelectionRevocation,
  type SubtitleTranslationAgentTaskRegistrationRequest,
  type SubtitleTranslationAuthorizedTaskReference,
  type SubtitleTranslationAuthorizedTaskRegistrationRequest,
  type SubtitleTranslationDirectoryRevocation,
  type SubtitleTranslationDirectorySelection,
  type SubtitleTranslationGeneratedImportCandidate,
  type SubtitleTranslationGeneratedImportCandidateControl,
  type SubtitleTranslationGeneratedImportCandidateRequest,
  type SubtitleTranslationImportDirectoryLease,
  type SubtitleTranslationInputFileAuthorization,
  type SubtitleTranslationInputSelectionSource,
  type SubtitleTranslationInputFileContent,
  type SubtitleTranslationInputFileRevocation,
  type SubtitleTranslationOwnerSessionRegistration,
  type SubtitleTranslationPreloadInternalChannel,
  type SubtitleTranslationRendererApi,
  SUBTITLE_TRANSLATION_LIMITS,
  type SubtitleTranslationPreparedRecoveryBatch,
  type SubtitleTranslationRecoveryScanSelection,
  type SubtitleTranslationTaskTargetReauthorization,
  type SubtitleTranslationTaskSourceReveal,
} from "@/type/subtitleTranslationIpc";

export interface CreateSubtitleTranslationRendererApiOptions {
  readonly ipcRenderer: Pick<IpcRenderer, "invoke">;
  readonly webUtils: Pick<WebUtils, "getPathForFile">;
  readonly ownerSessionRegistration: unknown;
  readonly now?: () => number;
  readonly createInputCaptureNonce?: () => string;
}

const INPUT_CAPTURE_TTL_MS = 30_000;
const MAX_PENDING_INPUT_CAPTURES = 8;
const INPUT_CAPTURE_NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const INPUT_CAPTURE_REF_PATTERN = /^subtitle_translation_input_[0-9a-f]{32}$/u;

interface PendingInputCapture {
  readonly files: ReadonlyArray<{ readonly filePath: string }>;
  readonly source: SubtitleTranslationInputSelectionSource;
  readonly expiresAt: number;
}

export function createSubtitleTranslationRendererApi({
  ipcRenderer,
  webUtils,
  ownerSessionRegistration,
  now = Date.now,
  createInputCaptureNonce = defaultInputCaptureNonce,
}: CreateSubtitleTranslationRendererApiOptions): SubtitleTranslationRendererApi {
  const ownerSessionId = resolveOwnerSessionId(ownerSessionRegistration);
  const pendingInputCaptures = new Map<string, PendingInputCapture>();

  const purgeExpiredInputCaptures = () => {
    const currentTime = now();
    for (const [captureRef, capture] of pendingInputCaptures) {
      if (capture.expiresAt <= currentTime) {
        pendingInputCaptures.delete(captureRef);
      }
    }
  };

  const invoke = async <TResult>(
    channel: Exclude<
      SubtitleTranslationPreloadInternalChannel,
      typeof SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession
    >,
    payload: unknown,
  ): Promise<SubtitleTranslationIpcResult<TResult>> => {
    if (!ownerSessionId) return ownerReleasedFailure();
    const contract = SUBTITLE_TRANSLATION_INTERNAL_OPERATION_CONTRACTS[channel];
    const request = contract.requestSchema.safeParse(payload);
    if (!request.success) return invalidRequestFailure();
    const envelope = subtitleTranslationSecureIpcEnvelopeSchema(
      contract.requestSchema,
    ).safeParse({ ownerSessionId, payload: request.data });
    if (!envelope.success) return invalidRequestFailure();

    let response: unknown;
    try {
      response = await ipcRenderer.invoke(channel, envelope.data);
    } catch {
      return transportFailure();
    }
    const parsed = contract.resultSchema.safeParse(response);
    return parsed.success
      ? parsed.data as SubtitleTranslationIpcResult<TResult>
      : invalidContentFailure();
  };

  const captureNativeInputFile = (
    file: File,
    captureRef?: string,
    source: SubtitleTranslationInputSelectionSource = "picker",
  ): SubtitleTranslationIpcResult<SubtitleTranslationInputFileCapture> => {
    if (!ownerSessionId) return ownerReleasedFailure();
    if (source !== "picker" && source !== "drop") {
      return invalidRequestFailure();
    }
    purgeExpiredInputCaptures();

    let capture: PendingInputCapture | undefined;
    if (captureRef !== undefined) {
      if (!INPUT_CAPTURE_REF_PATTERN.test(captureRef)) {
        return invalidRequestFailure();
      }
      capture = pendingInputCaptures.get(captureRef);
      if (!capture) return fileAuthorizationFailure("captureRef");
      if (capture.source !== source) {
        pendingInputCaptures.delete(captureRef);
        return invalidRequestFailure();
      }
      if (capture.files.length >= SUBTITLE_TRANSLATION_LIMITS.maxAgentSelectionFiles) {
        pendingInputCaptures.delete(captureRef);
        return invalidRequestFailure();
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
    if (!filePath) {
      if (captureRef) pendingInputCaptures.delete(captureRef);
      return fileAuthorizationFailure(`files.${fileIndex}`);
    }
    if (capture?.files.some((candidate) => candidate.filePath === filePath)) {
      pendingInputCaptures.delete(captureRef!);
      return invalidRequestFailure();
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
        data: Object.freeze({ captureRef, fileCount: files.length }),
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
    const nextCaptureRef = `subtitle_translation_input_${nonce}`;
    if (pendingInputCaptures.has(nextCaptureRef)) return transportFailure();
    pendingInputCaptures.set(nextCaptureRef, {
      files: Object.freeze([capturedFile]),
      source,
      expiresAt: now() + INPUT_CAPTURE_TTL_MS,
    });
    return {
      ok: true,
      data: Object.freeze({ captureRef: nextCaptureRef, fileCount: 1 }),
    };
  };

  const api: SubtitleTranslationRendererApi = {
    captureInputFile(file, captureRef, source) {
      return captureNativeInputFile(file, captureRef, source);
    },
    authorizeCapturedInputFiles(captureRef) {
      if (!ownerSessionId) return Promise.resolve(ownerReleasedFailure());
      if (!INPUT_CAPTURE_REF_PATTERN.test(captureRef)) {
        return Promise.resolve(invalidRequestFailure());
      }
      purgeExpiredInputCaptures();
      const capture = pendingInputCaptures.get(captureRef);
      pendingInputCaptures.delete(captureRef);
      if (!capture) {
        return Promise.resolve(fileAuthorizationFailure("captureRef"));
      }
      return invoke<readonly SubtitleTranslationInputFileAuthorization[]>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
        { source: capture.source, files: capture.files },
      );
    },
    authorizeInputFile(file: File) {
      let filePath = "";
      try {
        filePath = webUtils.getPathForFile(file);
      } catch {
        // Synthetic File objects never receive filesystem authority.
      }
      if (!filePath) return Promise.resolve(invalidRequestFailure());
      return invoke<SubtitleTranslationInputFileAuthorization>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.authorizeInputFile,
        { filePath },
      );
    },
    revokeInputFile(inputToken: string) {
      return invoke<SubtitleTranslationInputFileRevocation>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeInputFile,
        { inputToken },
      );
    },
    readInputFile(inputToken: string) {
      return invoke<SubtitleTranslationInputFileContent>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readInputFile,
        { inputToken },
      );
    },
    selectAgentInputFiles() {
      return invoke<SubtitleTranslationAgentInputSelection>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectAgentInputFiles,
        {},
      );
    },
    readAgentInputFile(request: SubtitleTranslationAgentInputSelectionRequest) {
      return invoke<SubtitleTranslationInputFileContent>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readAgentInputFile,
        request,
      );
    },
    revokeAgentInputSelection(selectionRef: string) {
      return invoke<SubtitleTranslationAgentInputSelectionRevocation>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeAgentInputSelection,
        { selectionRef },
      );
    },
    registerAgentAuthorizedTask(
      request: SubtitleTranslationAgentTaskRegistrationRequest,
    ) {
      return invoke<SubtitleTranslationAuthorizedTaskReference>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAgentAuthorizedTask,
        request,
      );
    },
    registerAuthorizedTask(
      request: SubtitleTranslationAuthorizedTaskRegistrationRequest,
    ) {
      return invoke<SubtitleTranslationAuthorizedTaskReference>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAuthorizedTask,
        request,
      );
    },
    revealTaskSource(taskId: string) {
      return invoke<SubtitleTranslationTaskSourceReveal>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskSource,
        { taskId },
      );
    },
    selectOutputDirectory() {
      return invoke<SubtitleTranslationDirectorySelection>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory,
        {},
      );
    },
    revokeOutputDirectory(directoryToken: string) {
      return invoke<SubtitleTranslationDirectoryRevocation>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory,
        { directoryToken },
      );
    },
    reauthorizeTaskTarget(taskId: string) {
      return invoke<SubtitleTranslationTaskTargetReauthorization>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.reauthorizeTaskTarget,
        { taskId },
      );
    },
    acquireImportDirectoryLease(request) {
      return invoke<SubtitleTranslationImportDirectoryLease>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.acquireImportDirectoryLease,
        request,
      );
    },
    releaseImportDirectoryLease(directoryLeaseToken) {
      return invoke<{ readonly released: boolean }>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseImportDirectoryLease,
        { directoryLeaseToken },
      );
    },
    createGeneratedImportCandidate(
      request: SubtitleTranslationGeneratedImportCandidateRequest,
    ) {
      return invoke<SubtitleTranslationGeneratedImportCandidate>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.createGeneratedImportCandidate,
        request,
      );
    },
    commitGeneratedImportCandidate(
      request: SubtitleTranslationGeneratedImportCandidateControl,
    ) {
      return invoke<{ readonly committed: boolean }>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.commitGeneratedImportCandidate,
        request,
      );
    },
    releaseGeneratedImportCandidate(
      request: SubtitleTranslationGeneratedImportCandidateControl,
    ) {
      return invoke<{ readonly released: boolean }>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedImportCandidate,
        request,
      );
    },
    releaseGeneratedTask(taskId) {
      return invoke<{ readonly released: boolean }>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedTask,
        { taskId },
      );
    },
    selectRecoveryDirectory(request = {}) {
      return invoke<SubtitleTranslationRecoveryScanSelection>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectRecoveryDirectory,
        request,
      );
    },
    selectRecoveryManifest() {
      return invoke<SubtitleTranslationRecoveryScanSelection>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectRecoveryManifest,
        {},
      );
    },
    prepareRecoveredTasks(request) {
      return invoke<SubtitleTranslationPreparedRecoveryBatch>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.prepareRecoveredTasks,
        request,
      );
    },
    revokeRecoveryScan(recoveryScanId) {
      return invoke<{ readonly released: boolean }>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeRecoveryScan,
        { recoveryScanId },
      );
    },
    revealRecoveryCheckpoint(checkpointRef) {
      return invoke<{ readonly revealed: boolean }>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealRecoveryCheckpoint,
        { checkpointRef },
      );
    },
    revealTaskOutput(taskId) {
      return invoke<{ readonly revealed: boolean }>(
        SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskOutput,
        { taskId },
      );
    },
  };
  return Object.freeze(api);
}

function resolveOwnerSessionId(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !("ok" in value) ||
    !("data" in value) ||
    value.ok !== true ||
    typeof value.data !== "object" ||
    value.data === null ||
    Array.isArray(value.data) ||
    Reflect.ownKeys(value.data).length !== 1 ||
    !("ownerSessionId" in value.data)
  ) {
    return undefined;
  }
  const registration = value.data as SubtitleTranslationOwnerSessionRegistration;
  const parsed = subtitleTranslationOwnerSessionIdSchema.safeParse(
    registration.ownerSessionId,
  );
  return parsed.success ? parsed.data : undefined;
}

function invalidRequestFailure<T>(): SubtitleTranslationIpcResult<T> {
  return subtitleTranslationIpcFailure(
    "invalid_ipc_request",
    "The subtitle translation IPC request is invalid.",
  );
}

function fileAuthorizationFailure<T>(
  field: string,
): SubtitleTranslationIpcResult<T> {
  return subtitleTranslationIpcFailure(
    "authorization_expired",
    "The selected subtitle files are no longer available. Select them again.",
    field,
  );
}

function ownerReleasedFailure<T>(): SubtitleTranslationIpcResult<T> {
  return subtitleTranslationIpcFailure(
    "owner_released",
    "The subtitle translation owner session is unavailable.",
  );
}

function transportFailure<T>(): SubtitleTranslationIpcResult<T> {
  return subtitleTranslationIpcFailure(
    "invalid_ipc_request",
    "The subtitle translation IPC transport failed.",
  );
}

function invalidContentFailure<T>(): SubtitleTranslationIpcResult<T> {
  return subtitleTranslationIpcFailure(
    "invalid_content",
    "The subtitle translation IPC response is invalid.",
  );
}

function defaultInputCaptureNonce(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}
