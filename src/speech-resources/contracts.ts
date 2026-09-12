export const LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION = 1 as const;

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

export const LOCAL_SUBTITLE_BACKENDS = ["cpu", "cuda", "metal"] as const;

export const LOCAL_SUBTITLE_TASK_STAGES = [
  "queued",
  "preparing_media",
  "loading_model",
  "transcribing",
  "post_processing",
  "exporting",
  "cancelling",
] as const;

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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
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

export interface LocalSubtitleOwnerKey { readonly webContentsId: number; readonly ownerSessionId: string; }
export interface LocalSubtitleSessionSnapshot { readonly schemaVersion: 1; readonly revision: number; readonly batches: readonly never[]; readonly resourceJobs: readonly LocalSubtitleResourceJobSummary[]; }
export interface LocalSubtitleServerManagedResourceIdentity<Storage extends 'managed' | 'managed_staging' = 'managed' | 'managed_staging'> { readonly storage: Storage; readonly id: string; readonly absolutePath: string; readonly byteSize: number; readonly sha256: string; }
export type SpeechResourceModelSmoke = (input: Readonly<{ owner: LocalSubtitleOwnerKey; model: LocalSubtitleServerManagedResourceIdentity<'managed_staging'>; signal: AbortSignal }>) => Promise<void>;
export type SpeechResourceVadSmoke = (input: Readonly<{ owner: LocalSubtitleOwnerKey; model: LocalSubtitleServerManagedResourceIdentity<'managed'>; vad: LocalSubtitleServerManagedResourceIdentity<'managed_staging'>; signal: AbortSignal }>) => Promise<void>;
export class SpeechResourceSmokeError extends Error {
  readonly localSubtitleCode: LocalSubtitleErrorCode;
  constructor(readonly code: LocalSubtitleErrorCode, message: string) {
    super(message);
    this.name = 'SpeechResourceSmokeError';
    this.localSubtitleCode = code;
  }
}
