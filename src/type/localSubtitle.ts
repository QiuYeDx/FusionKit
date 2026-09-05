export const LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION = 1 as const;
export const LOCAL_SUBTITLE_IPC_BRIDGE_VERSION = 4 as const;
export const LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION = 1 as const;
export const LOCAL_SUBTITLE_RUNTIME_MANIFEST_SCHEMA_VERSION = 1 as const;
export const LOCAL_SUBTITLE_RESOURCE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION = 1 as const;
export const LOCAL_SUBTITLE_VAD_MANIFEST_VERSION = 1 as const;

export const LOCAL_SUBTITLE_PRODUCTION_CONTRACT = {
  engine: {
    id: "whisper_cpp",
    version: "v1.9.1",
    commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
  },
  launchModel: {
    id: "large-v3-q5_0",
    sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
  },
  vad: {
    id: "silero-vad-v6.2.0-ggml",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    tokenTimestamps: false,
    timelinePolicy: "mapped_segment_timestamps_only",
  },
  transcript: {
    pcmWindowMs: 30_000,
    overlapMs: 5_000,
    boundaryToleranceMs: 100,
    maxRawSegmentDurationMs: 15_000,
    repeatedCueThreshold: 8,
    repeatedCoverageMs: 15_000,
    maxRetryDepth: 3,
    maxServerResponseBytes: 64 * 1024 * 1024,
    maxActiveNativeRequests: 1,
    privatePathEntropyBits: 192,
  },
} as const;

export const LOCAL_SUBTITLE_LIMITS = {
  maxIpcFrameBytes: 256 * 1024,
  maxSessionSnapshotBytes: 4 * 1024 * 1024,
  maxBatchFiles: 100,
  maxSessionTasks: 1_000,
  maxSessionBatches: 1_000,
  maxSessionResourceJobs: 100,
  maxMediaFileBytes: 64 * 1024 * 1024 * 1024,
  maxNormalizedPcmBytes: 12 * 1024 * 1024 * 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxTranscriptSegments: 200_000,
  maxTranscriptWords: 1_000_000,
  maxWordsPerSegment: 512,
  maxArtifactCues: 200_000,
  maxDurationMs: 99 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000 + 999,
  maxIdChars: 128,
  maxOpaqueRefChars: 128,
  maxDisplayNameChars: 255,
  maxLanguageChars: 32,
  maxInitialPromptChars: 4096,
  maxCueTextChars: 4096,
  maxCueLines: 4,
  maxLineChars: 1024,
  maxMediaTracks: 128,
  maxMediaMetadataFieldChars: 512,
  maxDiagnosticsBytes: 64 * 1024,
  maxDiagnosticLines: 256,
  maxDiagnosticLineChars: 1024,
  maxDiagnosticSummaryChars: 2048,
  maxRuntimeManifestBytes: 2 * 1024 * 1024,
  maxRuntimeArtifacts: 256,
  maxRuntimeLicenses: 64,
  maxRuntimeSources: 64,
  maxRuntimeEvidenceFiles: 256,
  maxRuntimeRelativePathChars: 512,
} as const;

export const LOCAL_SUBTITLE_ENGINES = ["whisper_cpp"] as const;
export type LocalSubtitleEngine = (typeof LOCAL_SUBTITLE_ENGINES)[number];

// Runtime artifact capability labels such as "metal_cpu" belong to the
// resource manifest. A committed task always records one actual backend.
export const LOCAL_SUBTITLE_BACKENDS = ["cpu", "cuda", "metal"] as const;
export type LocalSubtitleBackend = (typeof LOCAL_SUBTITLE_BACKENDS)[number];

export const LOCAL_SUBTITLE_DEVICE_PREFERENCES = [
  "auto",
  ...LOCAL_SUBTITLE_BACKENDS,
] as const;
export type LocalSubtitleDevicePreference =
  (typeof LOCAL_SUBTITLE_DEVICE_PREFERENCES)[number];

export const LOCAL_SUBTITLE_TASK_MODES = [
  "transcribe",
  "translate_to_english",
] as const;
export type LocalSubtitleTaskMode =
  (typeof LOCAL_SUBTITLE_TASK_MODES)[number];

export const LOCAL_SUBTITLE_FORMATS = ["SRT", "LRC"] as const;
export type LocalSubtitleFormat = (typeof LOCAL_SUBTITLE_FORMATS)[number];

export const LOCAL_SUBTITLE_OUTPUT_MODES = ["source", "custom"] as const;
export type LocalSubtitleOutputMode =
  (typeof LOCAL_SUBTITLE_OUTPUT_MODES)[number];

export const LOCAL_SUBTITLE_CONFLICT_POLICIES = ["index", "overwrite"] as const;
export type LocalSubtitleConflictPolicy =
  (typeof LOCAL_SUBTITLE_CONFLICT_POLICIES)[number];

export const LOCAL_SUBTITLE_HANDOFF_MODES = [
  "export_only",
  "enqueue_translation",
  "enqueue_and_start_translation",
] as const;
export type SubtitleTranslationHandoffMode =
  (typeof LOCAL_SUBTITLE_HANDOFF_MODES)[number];

export interface LocalSubtitleModelSnapshot {
  readonly engine: LocalSubtitleEngine;
  readonly engineVersion: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version;
  readonly engineCommit: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit;
  readonly modelManifestVersion: typeof LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION;
  readonly modelId: string;
  readonly modelHash: string;
}

export interface LocalSubtitleAdvancedSettings {
  readonly initialPrompt?: string;
  readonly beamSize: number;
  readonly temperature: number;
  readonly vadMinSilenceMs: number;
  /** Display targets; segment-only evidence may require exceeding these values. */
  readonly maxCueDurationMs: number;
  readonly maxCueChars: number;
  readonly maxLineChars: number;
}

export interface LocalSubtitleVadSnapshot {
  readonly enabled: boolean;
  readonly modelId: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id;
  readonly tokenTimestamps: false;
  readonly timelinePolicy: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy;
}

export interface LocalSubtitleRawQualityGateSnapshot {
  readonly maxSegmentDurationMs: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs;
  readonly repeatedCueThreshold: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold;
  readonly repeatedCoverageMs: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs;
  readonly maxRetryDepth: typeof LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth;
}

export const LOCAL_SUBTITLE_CUE_POLICY = "sentence_readable_dtw_v3" as const;

export interface LocalSubtitleInferenceSnapshot {
  /** Older snapshots omit this; newly created tasks always record the active policy. */
  readonly cuePolicy?: typeof LOCAL_SUBTITLE_CUE_POLICY | "sentence_readable_v2";
  readonly advanced: LocalSubtitleAdvancedSettings;
  readonly vad: LocalSubtitleVadSnapshot;
  readonly rawQualityGate: LocalSubtitleRawQualityGateSnapshot;
}

export type LocalSubtitleOutputSnapshot =
  | {
      readonly mode: "source";
      readonly formats: readonly LocalSubtitleFormat[];
      readonly conflictPolicy: LocalSubtitleConflictPolicy;
    }
  | {
      readonly mode: "custom";
      readonly formats: readonly LocalSubtitleFormat[];
      readonly conflictPolicy: LocalSubtitleConflictPolicy;
      readonly directoryLeaseRef: string;
      readonly displayLabel: string;
    };

export type LocalSubtitlePostActionConfig =
  | { readonly mode: "export_only" }
  | {
      readonly mode:
        | "enqueue_translation"
        | "enqueue_and_start_translation";
      readonly preferredFormat: LocalSubtitleFormat;
      readonly translationSnapshotId: string;
    };

export interface LocalSubtitleBatchConfigSnapshot {
  readonly schemaVersion: typeof LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION;
  readonly serverHttpContractVersion: typeof LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly model: LocalSubtitleModelSnapshot;
  readonly devicePreference: LocalSubtitleDevicePreference;
  readonly resolvedBackend: LocalSubtitleBackend;
  readonly language: string;
  readonly taskMode: LocalSubtitleTaskMode;
  readonly inference: LocalSubtitleInferenceSnapshot;
  readonly output: LocalSubtitleOutputSnapshot;
  readonly postAction: LocalSubtitlePostActionConfig;
}

export function createLocalSubtitleBatchConfigSnapshot(
  input: LocalSubtitleBatchConfigSnapshot,
): LocalSubtitleBatchConfigSnapshot {
  const output: LocalSubtitleOutputSnapshot =
    input.output.mode === "source"
      ? {
          mode: "source",
          formats: [...input.output.formats],
          conflictPolicy: input.output.conflictPolicy,
        }
      : {
          mode: "custom",
          formats: [...input.output.formats],
          conflictPolicy: input.output.conflictPolicy,
          directoryLeaseRef: input.output.directoryLeaseRef,
          displayLabel: input.output.displayLabel,
        };
  const postAction: LocalSubtitlePostActionConfig =
    input.postAction.mode === "export_only"
      ? { mode: "export_only" }
      : {
          mode: input.postAction.mode,
          preferredFormat: input.postAction.preferredFormat,
          translationSnapshotId: input.postAction.translationSnapshotId,
        };

  return deepFreeze({
    ...input,
    model: { ...input.model },
    inference: {
      cuePolicy: LOCAL_SUBTITLE_CUE_POLICY,
      advanced: { ...input.inference.advanced },
      vad: { ...input.inference.vad },
      rawQualityGate: { ...input.inference.rawQualityGate },
    },
    output,
    postAction,
  });
}

export const LOCAL_SUBTITLE_TASK_STATUSES = [
  "queued",
  "preparing_media",
  "loading_model",
  "transcribing",
  "post_processing",
  "exporting",
  "completed",
  "cancelling",
  "cancelled",
  "failed",
] as const;
export type LocalSubtitleTaskStatus =
  (typeof LOCAL_SUBTITLE_TASK_STATUSES)[number];

export const LOCAL_SUBTITLE_TASK_STAGES = [
  "queued",
  "preparing_media",
  "loading_model",
  "transcribing",
  "post_processing",
  "exporting",
  "cancelling",
] as const;
export type LocalSubtitleTaskStage =
  (typeof LOCAL_SUBTITLE_TASK_STAGES)[number];

export const LOCAL_SUBTITLE_OPERATION_STAGES = [
  "ipc",
  "preflight",
  "resource",
  ...LOCAL_SUBTITLE_TASK_STAGES,
  "artifact",
  "handoff",
  "cleanup",
] as const;
export type LocalSubtitleOperationStage =
  (typeof LOCAL_SUBTITLE_OPERATION_STAGES)[number];

export const LOCAL_SUBTITLE_ARTIFACT_STATUSES = [
  "committed",
  "failed",
  "skipped",
] as const;
export type LocalSubtitleArtifactStatus =
  (typeof LOCAL_SUBTITLE_ARTIFACT_STATUSES)[number];

export interface GeneratedSubtitleArtifactSummary {
  readonly artifactRef: string;
  readonly displayName: string;
  readonly format: LocalSubtitleFormat;
  readonly expiresAt: number;
}

export type LocalSubtitleArtifactResult =
  | {
      readonly format: LocalSubtitleFormat;
      readonly status: "committed";
      readonly artifact: GeneratedSubtitleArtifactSummary;
    }
  | {
      readonly format: LocalSubtitleFormat;
      readonly status: "failed";
      readonly errorCode: LocalSubtitleErrorCode;
    }
  | {
      readonly format: LocalSubtitleFormat;
      readonly status: "skipped";
      readonly errorCode?: LocalSubtitleErrorCode;
    };

export interface LocalSubtitleCompletionResult {
  readonly outcome: "full" | "partial";
  readonly artifacts: readonly LocalSubtitleArtifactResult[];
  readonly warnings: readonly LocalSubtitleWarningCode[];
}

export const SUBTITLE_TRANSLATION_IMPORT_STATUSES = [
  "not_requested",
  "pending",
  "importing",
  "queued",
  "skipped",
  "failed",
] as const;
export type SubtitleTranslationImportStatus =
  (typeof SUBTITLE_TRANSLATION_IMPORT_STATUSES)[number];

export const SUBTITLE_TRANSLATION_START_STATUSES = [
  "not_requested",
  "requesting",
  "started",
  "waiting",
  "failed",
] as const;
export type SubtitleTranslationStartStatus =
  (typeof SUBTITLE_TRANSLATION_START_STATUSES)[number];

export const SUBTITLE_TRANSLATION_START_FAILURE_REASONS = [
  "estimate_failed",
  "configuration_required",
  "profile_unavailable",
  "authorization_expired",
  "start_rejected",
] as const;
export type SubtitleTranslationStartFailureReason =
  (typeof SUBTITLE_TRANSLATION_START_FAILURE_REASONS)[number];

export interface LocalSubtitlePostActionState {
  readonly mode: SubtitleTranslationHandoffMode;
  readonly preferredFormat?: LocalSubtitleFormat;
  readonly importStatus: SubtitleTranslationImportStatus;
  readonly startStatus: SubtitleTranslationStartStatus;
  readonly importReceiptId?: string;
  readonly translationTaskId?: string;
  readonly importErrorCode?: LocalSubtitleErrorCode;
  readonly startFailureReason?: SubtitleTranslationStartFailureReason;
}

export const LOCAL_SUBTITLE_ERROR_CODES = [
  "invalid_ipc_request",
  "owner_released",
  "authorization_expired",
  "unsupported_platform",
  "unsupported_architecture",
  "runtime_missing",
  "runtime_protocol_mismatch",
  "runtime_crashed",
  "runtime_unresponsive",
  "media_runtime_missing",
  "media_runtime_invalid",
  "media_runtime_launch_failed",
  "accelerator_unavailable",
  "backend_mismatch",
  "backend_unverified",
  "model_missing",
  "model_incompatible",
  "model_corrupt",
  "model_download_failed",
  "model_disk_full",
  "resource_not_allowed",
  "resource_busy",
  "resource_signature_invalid",
  "limit_exceeded",
  "insufficient_disk",
  "media_probe_failed",
  "no_audio_stream",
  "media_changed",
  "media_decode_failed",
  "unsupported_media",
  "no_speech_detected",
  "transcription_failed",
  "transcript_quality_failed",
  "out_of_memory",
  "output_conflict",
  "output_write_failed",
  "cleanup_failed",
  "cancel_failed",
  "cancelled_after_partial_commit",
  "artifact_expired",
  "artifact_changed",
  "content_too_large",
  "invalid_content",
  "configuration_not_ready",
  "configuration_required",
  "directory_authorization_required",
  "profile_required",
  "profile_unavailable",
  "duplicate",
  "unsupported_format",
  "import_failed",
  "estimate_failed",
  "start_rejected",
] as const;
export type LocalSubtitleErrorCode =
  (typeof LOCAL_SUBTITLE_ERROR_CODES)[number];

export const LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES = [
  "runtime_missing",
  "runtime_crashed",
  "runtime_unresponsive",
  "media_runtime_invalid",
  "accelerator_unavailable",
  "backend_mismatch",
  "backend_unverified",
  "transcription_failed",
  "out_of_memory",
] as const satisfies readonly LocalSubtitleErrorCode[];

export const LOCAL_SUBTITLE_WARNING_CODES = [
  "cancelled_after_partial_commit",
] as const satisfies readonly LocalSubtitleErrorCode[];
export type LocalSubtitleWarningCode =
  (typeof LOCAL_SUBTITLE_WARNING_CODES)[number];

export const LOCAL_SUBTITLE_ERROR_MANIFEST_VERSION = 1 as const;

export const LOCAL_SUBTITLE_ERROR_SCOPES = [
  "request",
  "session",
  "batch",
  "task",
  "resource",
  "artifact",
  "handoff",
] as const;
export type LocalSubtitleErrorScope =
  (typeof LOCAL_SUBTITLE_ERROR_SCOPES)[number];

export interface LocalSubtitleErrorDefinition {
  readonly scope: LocalSubtitleErrorScope;
  readonly defaultStage: LocalSubtitleOperationStage;
  readonly retryable: boolean;
  readonly blocksBatchCommit: boolean;
}

function defineError(
  scope: LocalSubtitleErrorScope,
  defaultStage: LocalSubtitleOperationStage,
  retryable: boolean,
  blocksBatchCommit: boolean,
): LocalSubtitleErrorDefinition {
  return Object.freeze({ scope, defaultStage, retryable, blocksBatchCommit });
}

export const LOCAL_SUBTITLE_ERROR_MANIFEST = {
  invalid_ipc_request: defineError("request", "ipc", false, true),
  owner_released: defineError("session", "cleanup", false, true),
  authorization_expired: defineError("session", "preflight", true, true),
  unsupported_platform: defineError("batch", "preflight", false, true),
  unsupported_architecture: defineError("batch", "preflight", false, true),
  runtime_missing: defineError("batch", "preflight", true, true),
  runtime_protocol_mismatch: defineError("batch", "preflight", true, true),
  runtime_crashed: defineError("batch", "transcribing", true, true),
  runtime_unresponsive: defineError("batch", "transcribing", true, true),
  media_runtime_missing: defineError("batch", "preflight", true, true),
  media_runtime_invalid: defineError("batch", "preflight", true, true),
  media_runtime_launch_failed: defineError("batch", "preflight", true, true),
  accelerator_unavailable: defineError("batch", "preflight", true, true),
  backend_mismatch: defineError("batch", "preflight", false, true),
  backend_unverified: defineError("batch", "preflight", true, true),
  model_missing: defineError("batch", "loading_model", true, true),
  model_incompatible: defineError("batch", "loading_model", false, true),
  model_corrupt: defineError("batch", "loading_model", true, true),
  model_download_failed: defineError("resource", "resource", true, false),
  model_disk_full: defineError("resource", "resource", true, false),
  resource_not_allowed: defineError("resource", "resource", false, false),
  resource_busy: defineError("resource", "resource", true, false),
  resource_signature_invalid: defineError("resource", "resource", true, false),
  limit_exceeded: defineError("request", "preflight", false, true),
  insufficient_disk: defineError("batch", "preflight", true, true),
  media_probe_failed: defineError("task", "preparing_media", true, false),
  no_audio_stream: defineError("task", "preparing_media", false, false),
  media_changed: defineError("task", "preparing_media", true, false),
  media_decode_failed: defineError("task", "preparing_media", true, false),
  unsupported_media: defineError("task", "preparing_media", false, false),
  no_speech_detected: defineError("task", "post_processing", false, false),
  transcription_failed: defineError("task", "transcribing", true, false),
  transcript_quality_failed: defineError(
    "task",
    "post_processing",
    true,
    false,
  ),
  out_of_memory: defineError("batch", "transcribing", true, true),
  output_conflict: defineError("task", "exporting", true, false),
  output_write_failed: defineError("task", "exporting", true, false),
  cleanup_failed: defineError("task", "cleanup", true, false),
  cancel_failed: defineError("task", "cancelling", true, false),
  cancelled_after_partial_commit: defineError(
    "task",
    "exporting",
    false,
    false,
  ),
  artifact_expired: defineError("artifact", "artifact", true, false),
  artifact_changed: defineError("artifact", "artifact", false, false),
  content_too_large: defineError("artifact", "artifact", false, false),
  invalid_content: defineError("artifact", "artifact", false, false),
  configuration_not_ready: defineError("handoff", "handoff", true, false),
  configuration_required: defineError("handoff", "handoff", true, false),
  directory_authorization_required: defineError(
    "handoff",
    "handoff",
    true,
    false,
  ),
  profile_required: defineError("handoff", "handoff", true, false),
  profile_unavailable: defineError("handoff", "handoff", true, false),
  duplicate: defineError("handoff", "handoff", false, false),
  unsupported_format: defineError("handoff", "handoff", false, false),
  import_failed: defineError("handoff", "handoff", true, false),
  estimate_failed: defineError("handoff", "handoff", true, false),
  start_rejected: defineError("handoff", "handoff", true, false),
} as const satisfies Record<
  LocalSubtitleErrorCode,
  LocalSubtitleErrorDefinition
>;

export const LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS = [
  "attempt",
  "maxAttempts",
  "exitCode",
  "signal",
  "httpStatus",
  "backend",
  "expected",
  "actual",
  "resourceId",
  "runtimeVersion",
  "protocolVersion",
  "requiredBytes",
  "availableBytes",
  "limit",
  "observed",
] as const;
export type LocalSubtitleDiagnosticMetadataKey =
  (typeof LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS)[number];
export type LocalSubtitleDiagnosticScalar = string | number | boolean | null;

export interface LocalSubtitleDiagnostics {
  readonly summary?: string;
  readonly lines?: readonly string[];
  readonly metadata?: Readonly<
    Partial<
      Record<LocalSubtitleDiagnosticMetadataKey, LocalSubtitleDiagnosticScalar>
    >
  >;
  readonly truncated: boolean;
}

export interface LocalSubtitleError {
  readonly code: LocalSubtitleErrorCode;
  readonly message: string;
  readonly stage: LocalSubtitleOperationStage;
  readonly retryable: boolean;
  readonly field?: string;
  readonly details?: LocalSubtitleDiagnostics;
  readonly causeCode?: LocalSubtitleErrorCode;
}

export function createLocalSubtitleError(
  code: LocalSubtitleErrorCode,
  message: string,
  options: {
    stage?: LocalSubtitleOperationStage;
    field?: string;
    details?: LocalSubtitleDiagnostics;
    causeCode?: LocalSubtitleErrorCode;
  } = {},
): LocalSubtitleError {
  const definition = LOCAL_SUBTITLE_ERROR_MANIFEST[code];
  return deepFreeze({
    code,
    message,
    stage: options.stage ?? definition.defaultStage,
    retryable: definition.retryable,
    ...(options.field === undefined ? {} : { field: options.field }),
    ...(options.details === undefined
      ? {}
      : { details: cloneDiagnostics(options.details) }),
    ...(options.causeCode === undefined
      ? {}
      : { causeCode: options.causeCode }),
  });
}

export function isLocalSubtitleErrorCode(
  value: unknown,
): value is LocalSubtitleErrorCode {
  return (
    typeof value === "string" &&
    (LOCAL_SUBTITLE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export const LOCAL_SUBTITLE_TASK_TRANSITIONS = {
  queued: ["preparing_media", "cancelling", "failed"],
  preparing_media: ["loading_model", "transcribing", "cancelling", "failed"],
  loading_model: ["transcribing", "cancelling", "failed"],
  transcribing: ["post_processing", "cancelling", "failed"],
  post_processing: ["exporting", "cancelling", "failed"],
  exporting: ["completed", "cancelling", "failed"],
  completed: [],
  cancelling: ["completed", "cancelled", "failed"],
  cancelled: [],
  failed: [],
} as const satisfies Record<
  LocalSubtitleTaskStatus,
  readonly LocalSubtitleTaskStatus[]
>;

export function canTransitionLocalSubtitleTaskStatus(
  from: LocalSubtitleTaskStatus,
  to: LocalSubtitleTaskStatus,
): boolean {
  return (LOCAL_SUBTITLE_TASK_TRANSITIONS[from] as readonly string[]).includes(
    to,
  );
}

export type LocalSubtitleTerminalResolution =
  | {
      readonly ok: true;
      readonly status: "completed";
      readonly completion: LocalSubtitleCompletionResult;
    }
  | { readonly ok: true; readonly status: "cancelled" | "failed" }
  | {
      readonly ok: false;
      readonly reason:
        | "no_requested_formats"
        | "duplicate_requested_format"
        | "duplicate_artifact_result"
        | "unexpected_artifact_format"
        | "incomplete_artifact_results"
        | "committed_artifact_format_mismatch"
        | "no_failed_artifact"
        | "cancellation_marker_missing"
        | "unexpected_cancellation_marker"
        | "unexpected_cancellation_cleanup_failure"
        | "cancellation_marker_without_commit";
      readonly format?: LocalSubtitleFormat;
    };

export function hasLocalSubtitleArtifactCancellationEvidence(
  artifactResults: readonly LocalSubtitleArtifactResult[],
): boolean {
  return artifactResults.some((result) =>
    (result.status === "failed" && result.errorCode === "cancel_failed") ||
    (result.status === "skipped" &&
      result.errorCode === "cancelled_after_partial_commit")
  );
}

export function resolveLocalSubtitleTerminalOutcome(options: {
  requestedFormats: readonly LocalSubtitleFormat[];
  artifactResults: readonly LocalSubtitleArtifactResult[];
  cancellationRequested?: boolean;
}): LocalSubtitleTerminalResolution {
  if (options.requestedFormats.length === 0) {
    return { ok: false, reason: "no_requested_formats" };
  }

  const requested = new Set<LocalSubtitleFormat>();
  for (const format of options.requestedFormats) {
    if (requested.has(format)) {
      return {
        ok: false,
        reason: "duplicate_requested_format",
        format,
      };
    }
    requested.add(format);
  }

  const results = new Map<LocalSubtitleFormat, LocalSubtitleArtifactResult>();
  for (const result of options.artifactResults) {
    if (!requested.has(result.format)) {
      return {
        ok: false,
        reason: "unexpected_artifact_format",
        format: result.format,
      };
    }
    if (results.has(result.format)) {
      return {
        ok: false,
        reason: "duplicate_artifact_result",
        format: result.format,
      };
    }
    if (
      result.status === "committed" &&
      result.artifact.format !== result.format
    ) {
      return {
        ok: false,
        reason: "committed_artifact_format_mismatch",
        format: result.format,
      };
    }
    results.set(result.format, result);
  }

  if (results.size !== requested.size) {
    return { ok: false, reason: "incomplete_artifact_results" };
  }

  const committedCount = options.artifactResults.filter(
    (result) => result.status === "committed",
  ).length;
  const hasCancellationMarker = options.artifactResults.some(
    (result) =>
      result.status === "skipped" &&
      result.errorCode === "cancelled_after_partial_commit",
  );
  const hasCancellationCleanupFailure = options.artifactResults.some(
    (result) =>
      result.status === "failed" && result.errorCode === "cancel_failed",
  );
  if (!options.cancellationRequested && hasCancellationCleanupFailure) {
    return {
      ok: false,
      reason: "unexpected_cancellation_cleanup_failure",
    };
  }
  if (committedCount === 0) {
    if (hasCancellationMarker) {
      return { ok: false, reason: "cancellation_marker_without_commit" };
    }
    if (
      !options.cancellationRequested &&
      !options.artifactResults.some((result) => result.status === "failed")
    ) {
      return { ok: false, reason: "no_failed_artifact" };
    }
    return {
      ok: true,
      status:
        options.cancellationRequested && !hasCancellationCleanupFailure
          ? "cancelled"
          : "failed",
    };
  }

  const full = committedCount === requested.size;
  if (
    !full &&
    options.cancellationRequested &&
    !hasCancellationMarker &&
    !hasCancellationCleanupFailure
  ) {
    return { ok: false, reason: "cancellation_marker_missing" };
  }
  if (!options.cancellationRequested && hasCancellationMarker) {
    return { ok: false, reason: "unexpected_cancellation_marker" };
  }

  return {
    ok: true,
    status: "completed",
    completion: deepFreeze({
      outcome: full ? "full" : "partial",
      artifacts: options.artifactResults.map(cloneArtifactResult),
      warnings:
        !full && options.cancellationRequested
          ? ["cancelled_after_partial_commit"]
          : [],
    }),
  };
}

export interface LocalSubtitleTaskState {
  readonly status: LocalSubtitleTaskStatus;
  readonly artifactResults: readonly LocalSubtitleArtifactResult[];
  readonly completion?: LocalSubtitleCompletionResult;
  readonly error?: LocalSubtitleError;
}

export type LocalSubtitleTaskTransitionResult =
  | { readonly ok: true; readonly state: LocalSubtitleTaskState }
  | {
      readonly ok: false;
      readonly reason:
        | "transition_not_allowed"
        | "artifact_results_invalid"
        | "terminal_outcome_invalid"
        | "terminal_status_mismatch"
        | "failure_error_required";
    };

export function transitionLocalSubtitleTaskState(
  current: LocalSubtitleTaskState,
  target: LocalSubtitleTaskStatus,
  context: {
    requestedFormats: readonly LocalSubtitleFormat[];
    artifactResults?: readonly LocalSubtitleArtifactResult[];
    cancellationRequested?: boolean;
    error?: LocalSubtitleError;
  },
): LocalSubtitleTaskTransitionResult {
  if (!canTransitionLocalSubtitleTaskStatus(current.status, target)) {
    return { ok: false, reason: "transition_not_allowed" };
  }

  const artifactResults = context.artifactResults ?? current.artifactResults;
  if (
    !isValidArtifactResultSubset(context.requestedFormats, artifactResults)
  ) {
    return { ok: false, reason: "artifact_results_invalid" };
  }
  if (
    artifactResults.length > 0 &&
    [
      "queued",
      "preparing_media",
      "loading_model",
      "transcribing",
      "post_processing",
    ].includes(current.status)
  ) {
    return { ok: false, reason: "artifact_results_invalid" };
  }
  const cancellationRequested =
    context.cancellationRequested ?? current.status === "cancelling";
  if (target === "completed") {
    const terminal = resolveLocalSubtitleTerminalOutcome({
      requestedFormats: context.requestedFormats,
      artifactResults,
      cancellationRequested,
    });
    if (!terminal.ok) {
      return { ok: false, reason: "terminal_outcome_invalid" };
    }
    if (terminal.status !== "completed") {
      return { ok: false, reason: "terminal_status_mismatch" };
    }
    return {
      ok: true,
      state: deepFreeze({
        status: "completed",
        artifactResults: artifactResults.map(cloneArtifactResult),
        completion: terminal.completion,
      }),
    };
  }

  if (target === "failed") {
    if (
      artifactResults.some((result) => result.status === "committed")
    ) {
      return { ok: false, reason: "terminal_status_mismatch" };
    }
    if (
      artifactResults.some(
        (result) =>
          result.status === "skipped" &&
          result.errorCode === "cancelled_after_partial_commit",
      )
    ) {
      return { ok: false, reason: "terminal_outcome_invalid" };
    }
    if (
      !cancellationRequested &&
      artifactResults.some(
        (result) =>
          result.status === "failed" && result.errorCode === "cancel_failed",
      )
    ) {
      return { ok: false, reason: "terminal_outcome_invalid" };
    }
    if (context.error === undefined) {
      return { ok: false, reason: "failure_error_required" };
    }
    return {
      ok: true,
      state: deepFreeze({
        status: "failed",
        artifactResults: artifactResults.map(cloneArtifactResult),
        error: cloneLocalSubtitleError(context.error),
      }),
    };
  }

  if (target === "cancelled") {
    if (
      artifactResults.some((result) => result.status === "committed")
    ) {
      return { ok: false, reason: "terminal_status_mismatch" };
    }
    if (
      artifactResults.some(
        (result) =>
          result.status === "skipped" &&
          result.errorCode === "cancelled_after_partial_commit",
      )
    ) {
      return { ok: false, reason: "terminal_outcome_invalid" };
    }
    if (
      artifactResults.some(
        (result) =>
          result.status === "failed" && result.errorCode === "cancel_failed",
      )
    ) {
      return { ok: false, reason: "terminal_status_mismatch" };
    }
    return {
      ok: true,
      state: deepFreeze({
        status: "cancelled",
        artifactResults: artifactResults.map(cloneArtifactResult),
      }),
    };
  }

  return {
    ok: true,
    state: deepFreeze({
      status: target,
      artifactResults: artifactResults.map(cloneArtifactResult),
    }),
  };
}

export interface LocalSubtitleTaskProgress {
  readonly stage: LocalSubtitleTaskStage;
  readonly stageProgress: number;
  readonly overallProgress: number;
  readonly completedWindows?: number;
  readonly totalWindows?: number;
}

export interface LocalSubtitleTaskSummary {
  readonly taskId: string;
  readonly batchId: string;
  readonly sourceKey: string;
  readonly generation: number;
  readonly displayName: string;
  readonly durationMs?: number;
  readonly status: LocalSubtitleTaskStatus;
  readonly progress: LocalSubtitleTaskProgress;
  readonly model: LocalSubtitleModelSnapshot;
  readonly resolvedBackend: LocalSubtitleBackend;
  readonly requestedFormats: readonly LocalSubtitleFormat[];
  readonly artifactResults: readonly LocalSubtitleArtifactResult[];
  readonly completion?: LocalSubtitleCompletionResult;
  readonly postAction: LocalSubtitlePostActionState;
  readonly error?: LocalSubtitleError;
  readonly cpuRetryAvailable?: true;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function isLocalSubtitleCpuRetryAvailable(
  task: Pick<
    LocalSubtitleTaskSummary,
    "status" | "resolvedBackend" | "error"
  >,
): boolean {
  return task.status === "failed" &&
    task.resolvedBackend !== "cpu" &&
    task.error !== undefined &&
    (LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES as readonly LocalSubtitleErrorCode[])
      .includes(task.error.code);
}

export const LOCAL_SUBTITLE_BATCH_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
] as const;
export type LocalSubtitleBatchStatus =
  (typeof LOCAL_SUBTITLE_BATCH_STATUSES)[number];

export function deriveLocalSubtitleBatchStatus(
  tasks: readonly Pick<LocalSubtitleTaskSummary, "status">[],
): LocalSubtitleBatchStatus {
  if (tasks.length === 0 || tasks.every((task) => task.status === "queued")) {
    return "queued";
  }
  if (tasks.some((task) => task.status === "cancelling")) {
    return "cancelling";
  }
  const terminalStatuses = new Set<LocalSubtitleTaskStatus>([
    "completed",
    "cancelled",
    "failed",
  ]);
  if (!tasks.every((task) => terminalStatuses.has(task.status))) {
    return "running";
  }
  if (tasks.some((task) => task.status === "completed")) {
    return "completed";
  }
  if (tasks.every((task) => task.status === "cancelled")) {
    return "cancelled";
  }
  return "failed";
}

export interface LocalSubtitleBatchConfigSummary {
  readonly modelId: string;
  readonly devicePreference: LocalSubtitleDevicePreference;
  readonly resolvedBackend: LocalSubtitleBackend;
  readonly language: string;
  readonly taskMode: LocalSubtitleTaskMode;
  readonly vadEnabled: boolean;
  readonly outputFormats: readonly LocalSubtitleFormat[];
  readonly outputMode: LocalSubtitleOutputMode;
  readonly conflictPolicy: LocalSubtitleConflictPolicy;
  readonly postActionMode: SubtitleTranslationHandoffMode;
  readonly preferredHandoffFormat?: LocalSubtitleFormat;
}

export interface LocalSubtitleBatchSummary {
  readonly batchId: string;
  readonly status: LocalSubtitleBatchStatus;
  readonly config: LocalSubtitleBatchConfigSummary;
  readonly tasks: readonly LocalSubtitleTaskSummary[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const LOCAL_SUBTITLE_RESOURCE_TYPES = [
  "model",
  "vad",
  "accelerator",
] as const;
export type LocalSubtitleResourceType =
  (typeof LOCAL_SUBTITLE_RESOURCE_TYPES)[number];

export const LOCAL_SUBTITLE_RESOURCE_JOB_STATUSES = [
  "queued",
  "acquiring",
  "verifying",
  "load_smoke",
  "signature_check",
  "committing",
  "completed",
  "cancelling",
  "cancelled",
  "failed",
] as const;
export type LocalSubtitleResourceJobStatus =
  (typeof LOCAL_SUBTITLE_RESOURCE_JOB_STATUSES)[number];

export interface LocalSubtitleResourceJobSummary {
  readonly jobId: string;
  readonly resourceId: string;
  readonly resourceType: LocalSubtitleResourceType;
  readonly status: LocalSubtitleResourceJobStatus;
  readonly progress: number;
  readonly bytesCompleted?: number;
  readonly bytesTotal?: number;
  readonly error?: LocalSubtitleError;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalSubtitleSessionSnapshot {
  readonly schemaVersion: typeof LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION;
  readonly revision: number;
  readonly batches: readonly LocalSubtitleBatchSummary[];
  readonly resourceJobs: readonly LocalSubtitleResourceJobSummary[];
}

export type LocalSubtitleTaskEvent =
  | {
      readonly type: "task-updated";
      readonly task: LocalSubtitleTaskSummary;
    }
  | {
      readonly type: "task-removed";
      readonly removedAt: string;
    };

export interface LocalSubtitleTaskEventEnvelope {
  readonly batchId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly revision: number;
  readonly event: LocalSubtitleTaskEvent;
}

export type LocalSubtitleResourceEvent =
  | {
      readonly type: "resource-job-updated";
      readonly job: LocalSubtitleResourceJobSummary;
    }
  | {
      readonly type: "resource-job-removed";
      readonly jobId: string;
      readonly removedAt: string;
    };

export interface LocalSubtitleResourceEventEnvelope {
  readonly revision: number;
  readonly event: LocalSubtitleResourceEvent;
}

export interface LocalSubtitleWord {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly probability?: number;
}

export interface LocalSubtitleSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly words?: readonly LocalSubtitleWord[];
  readonly estimatedTiming?: true;
  readonly confidence?: number;
  readonly speaker?: string;
}

export interface LocalSubtitleTranscript {
  readonly schemaVersion: typeof LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION;
  readonly source: {
    readonly displayName: string;
    readonly durationMs: number;
  };
  readonly model: {
    readonly engine: LocalSubtitleEngine;
    readonly modelId: string;
    readonly modelHash: string;
    readonly backend: LocalSubtitleBackend;
  };
  readonly detectedLanguage?: string;
  readonly languageProbability?: number;
  readonly segments: readonly LocalSubtitleSegment[];
}

export interface LocalSubtitleEventCursor {
  readonly revision: number;
  readonly generation?: number;
}

export type LocalSubtitleEventDecision =
  | {
      readonly action: "apply";
      readonly needsSnapshot: false;
      readonly advanceRevision: true;
    }
  | {
      readonly action: "apply";
      readonly needsSnapshot: true;
      readonly advanceRevision: true;
      readonly reason: "revision_gap";
    }
  | {
      readonly action: "ignore";
      readonly needsSnapshot: false;
      readonly advanceRevision: boolean;
      readonly reason:
        | "duplicate_revision"
        | "stale_revision"
        | "stale_generation";
    }
  | {
      readonly action: "ignore";
      readonly needsSnapshot: true;
      readonly advanceRevision: false;
      readonly reason: "revision_gap";
    };

export function classifyLocalSubtitleTaskEvent(
  cursor: LocalSubtitleEventCursor,
  event: Pick<LocalSubtitleTaskEventEnvelope, "generation" | "revision">,
): LocalSubtitleEventDecision {
  if (event.revision === cursor.revision) {
    return {
      action: "ignore",
      needsSnapshot: false,
      advanceRevision: false,
      reason: "duplicate_revision",
    };
  }
  if (event.revision < cursor.revision) {
    return {
      action: "ignore",
      needsSnapshot: false,
      advanceRevision: false,
      reason: "stale_revision",
    };
  }
  const staleGeneration =
    cursor.generation !== undefined && event.generation < cursor.generation;
  if (event.revision > cursor.revision + 1) {
    if (staleGeneration) {
      return {
        action: "ignore",
        needsSnapshot: true,
        advanceRevision: false,
        reason: "revision_gap",
      };
    }
    return {
      action: "apply",
      needsSnapshot: true,
      advanceRevision: true,
      reason: "revision_gap",
    };
  }
  if (staleGeneration) {
    return {
      action: "ignore",
      needsSnapshot: false,
      advanceRevision: true,
      reason: "stale_generation",
    };
  }
  return { action: "apply", needsSnapshot: false, advanceRevision: true };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneArtifactResult(
  result: LocalSubtitleArtifactResult,
): LocalSubtitleArtifactResult {
  if (result.status === "committed") {
    return {
      format: result.format,
      status: "committed",
      artifact: { ...result.artifact },
    };
  }
  if (result.status === "failed") {
    return {
      format: result.format,
      status: "failed",
      errorCode: result.errorCode,
    };
  }
  return {
    format: result.format,
    status: "skipped",
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

function isValidArtifactResultSubset(
  requestedFormats: readonly LocalSubtitleFormat[],
  artifactResults: readonly LocalSubtitleArtifactResult[],
): boolean {
  if (
    requestedFormats.length === 0 ||
    new Set(requestedFormats).size !== requestedFormats.length
  ) {
    return false;
  }
  const requested = new Set(requestedFormats);
  const observed = new Set<LocalSubtitleFormat>();
  for (const result of artifactResults) {
    if (!requested.has(result.format) || observed.has(result.format)) {
      return false;
    }
    if (
      result.status === "committed" &&
      result.artifact.format !== result.format
    ) {
      return false;
    }
    observed.add(result.format);
  }
  return true;
}

function cloneLocalSubtitleError(error: LocalSubtitleError): LocalSubtitleError {
  return {
    ...error,
    ...(error.details === undefined
      ? {}
      : {
          details: {
            ...error.details,
            ...(error.details.lines === undefined
              ? {}
              : { lines: [...error.details.lines] }),
            ...(error.details.metadata === undefined
              ? {}
              : { metadata: { ...error.details.metadata } }),
          },
        }),
  };
}

function cloneDiagnostics(
  details: LocalSubtitleDiagnostics,
): LocalSubtitleDiagnostics {
  return {
    ...details,
    ...(details.lines === undefined ? {} : { lines: [...details.lines] }),
    ...(details.metadata === undefined
      ? {}
      : { metadata: { ...details.metadata } }),
  };
}
