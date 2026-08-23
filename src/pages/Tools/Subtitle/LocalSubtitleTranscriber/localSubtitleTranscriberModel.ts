import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_LIMITS,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleConflictPolicy,
  type LocalSubtitleDevicePreference,
  type LocalSubtitleFormat,
  type LocalSubtitleResourceJobStatus,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleTaskSummary,
  type LocalSubtitleTaskMode,
  type SubtitleTranslationHandoffMode,
} from "@/type/localSubtitle";
import type {
  EnqueueLocalSubtitleBatchRequest,
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleBackendPreviewSummary,
  LocalSubtitleManagedResourceSummary,
  LocalSubtitleMediaProbeSummary,
  LocalSubtitleOutputDirectorySelection,
  LocalSubtitleRuntimeSummary,
} from "@/type/localSubtitleIpc";
import type { LocalSubtitleRuntimeSyncStatus } from "@/services/local-subtitle/localSubtitleRuntimeService";
import type { LocalSubtitleTranscriberPreferences } from "@/store/tools/subtitle/localSubtitleTranscriberConfig";

type ActiveOutputDirectory = Extract<
  LocalSubtitleOutputDirectorySelection,
  { cancelled: false }
>;

export type LocalSubtitleStartIssue =
  | "environment_loading"
  | "environment_unavailable"
  | "runtime_unavailable"
  | "session_unavailable"
  | "model_required"
  | "vad_required"
  | "backend_preview_loading"
  | "backend_preview_unavailable"
  | "file_required"
  | "media_probe_loading"
  | "media_probe_failed"
  | "output_directory_required";

export type LocalSubtitleDraftMediaProbe =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly summary: LocalSubtitleMediaProbeSummary;
    }
  | {
      readonly status: "error";
      readonly error:
        | { readonly message: string }
        | { readonly kind: "mismatched_file" };
    };

export type LocalSubtitleDraftMediaProbeStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface LocalSubtitleStartReadinessInput {
  readonly environmentLoading: boolean;
  readonly environmentError: boolean;
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly runtimeSyncStatus: LocalSubtitleRuntimeSyncStatus;
  readonly readyModels: readonly LocalSubtitleManagedResourceSummary[];
  readonly selectedModelId: string | null;
  readonly vadEnabled: boolean;
  readonly vadReady: boolean;
  readonly backendPreviewStatus: "idle" | "loading" | "ready" | "error";
  readonly backendPreviewModelId: string | null;
  readonly backendPreviewDevicePreference: LocalSubtitleDevicePreference | null;
  readonly devicePreference: LocalSubtitleDevicePreference;
  readonly selectedFiles: readonly LocalSubtitleAuthorizedMedia[];
  readonly mediaProbeStatus: LocalSubtitleDraftMediaProbeStatus;
  readonly outputMode: "source" | "custom";
  readonly outputDirectory: ActiveOutputDirectory | null;
}

export interface LocalSubtitleBackendPreviewRequestState {
  readonly previewKey: string | null;
  readonly cachedPreviewKey: string | null;
  readonly environmentLoading: boolean;
  readonly environmentError: boolean;
  readonly runtimeSyncStatus: LocalSubtitleRuntimeSyncStatus;
  readonly taskMediaOperationActive: boolean;
}

export function createLocalSubtitleBackendPreviewKey(input: {
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly modelId: string | null;
  readonly devicePreference: LocalSubtitleBackendPreviewSummary["devicePreference"];
}): string | null {
  if (
    !input.runtime ||
    !input.modelId ||
    !isLocalSubtitleDevicePreferenceAvailable(
      input.runtime,
      input.devicePreference,
    )
  ) return null;
  return [
    input.runtime.runtimeGeneration,
    input.modelId,
    input.devicePreference,
  ].join(":");
}

export function isLocalSubtitleDevicePreferenceAvailable(
  runtime: LocalSubtitleRuntimeSummary | null,
  preference: LocalSubtitleDevicePreference,
): boolean {
  if (
    !runtime ||
    runtime.runner.status !== "ready" ||
    runtime.mediaRuntime.status !== "ready"
  ) return false;
  if (preference === "auto") {
    return runtime.backends.some((backend) => backend.status === "available");
  }
  return runtime.backends.some(
    (backend) =>
      backend.backend === preference && backend.status === "available",
  );
}

export function shouldRequestLocalSubtitleBackendPreview(
  input: LocalSubtitleBackendPreviewRequestState,
): boolean {
  return Boolean(
    input.previewKey &&
    !input.environmentLoading &&
    !input.environmentError &&
    input.runtimeSyncStatus === "ready" &&
    !input.taskMediaOperationActive &&
    input.cachedPreviewKey !== input.previewKey,
  );
}

export function hasActiveLocalSubtitleTasks(
  batches: readonly LocalSubtitleBatchSummary[],
): boolean {
  return batches.some((batch) => batch.tasks.some((task) =>
    isLocalSubtitleTaskActive(task)
  ));
}

/**
 * Keep the renderer fallback behind the authoritative session snapshot.
 * Both arrays are insertion ordered, which is also the FIFO admission order.
 */
export function mergeLocalSubtitleVisibleBatches(
  liveBatches: readonly LocalSubtitleBatchSummary[],
  submittedBatches: readonly LocalSubtitleBatchSummary[],
): LocalSubtitleBatchSummary[] {
  const liveBatchIds = new Set(liveBatches.map((batch) => batch.batchId));
  return [
    ...liveBatches,
    ...submittedBatches.filter((batch) => !liveBatchIds.has(batch.batchId)),
  ];
}

export function flattenLocalSubtitleTasksInQueueOrder(
  batches: readonly LocalSubtitleBatchSummary[],
): LocalSubtitleTaskSummary[] {
  return batches.flatMap((batch) => batch.tasks);
}

export interface LocalSubtitleTaskProgressDisplay {
  readonly percent: number;
  readonly completedWindows?: number;
  readonly totalWindows?: number;
}

export function deriveLocalSubtitleTaskProgressDisplay(
  task: Pick<LocalSubtitleTaskSummary, "status" | "progress">,
): LocalSubtitleTaskProgressDisplay | null {
  if (
    task.status !== "transcribing" ||
    task.progress.stage !== "transcribing"
  ) return null;

  const progress = task.progress;
  const hasWindowProgress =
    Number.isSafeInteger(progress.completedWindows) &&
    Number.isSafeInteger(progress.totalWindows) &&
    progress.completedWindows !== undefined &&
    progress.totalWindows !== undefined &&
    progress.completedWindows >= 0 &&
    progress.totalWindows > 0 &&
    progress.completedWindows <= progress.totalWindows;
  const percent = hasWindowProgress
    ? Math.round((progress.completedWindows! / progress.totalWindows!) * 100)
    : Math.round(progress.stageProgress);
  return {
    percent: clampPercentage(percent),
    ...(hasWindowProgress
      ? {
          completedWindows: progress.completedWindows,
          totalWindows: progress.totalWindows,
        }
      : {}),
  };
}

export function supportedLocalSubtitleConflictPolicies(
  runtime: LocalSubtitleRuntimeSummary | null,
): readonly LocalSubtitleConflictPolicy[] {
  const advertised = runtime?.supportedOutputConflictPolicies;
  return advertised?.length ? advertised : ["index"];
}

export function resolveLocalSubtitleConflictPolicy(
  runtime: LocalSubtitleRuntimeSummary | null,
  requested: LocalSubtitleConflictPolicy,
): LocalSubtitleConflictPolicy {
  const supported = supportedLocalSubtitleConflictPolicies(runtime);
  return supported.includes(requested) ? requested : supported[0] ?? "index";
}

export function getReadyLocalSubtitleModels(
  resources: readonly LocalSubtitleManagedResourceSummary[],
): LocalSubtitleManagedResourceSummary[] {
  return resources.filter(
    (resource) => resource.resourceType === "model" && resource.status === "ready",
  );
}

export function getLocalSubtitleModelImportTarget(
  resources: readonly LocalSubtitleManagedResourceSummary[],
  fileSize: number,
): LocalSubtitleManagedResourceSummary | null {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  return resources.find(
    (resource) =>
      resource.resourceType === "model" &&
      resource.status !== "ready" &&
      resource.byteSize === fileSize,
  ) ?? null;
}

const TERMINAL_RESOURCE_JOB_STATUSES: ReadonlySet<
  LocalSubtitleResourceJobStatus
> = new Set(["completed", "cancelled", "failed"] as const);

export function isLocalSubtitleResourceJobActive(
  job: LocalSubtitleResourceJobSummary | null,
): boolean {
  return Boolean(job && !TERMINAL_RESOURCE_JOB_STATUSES.has(job.status));
}

export function getLatestLocalSubtitleResourceJobs(
  jobs: readonly LocalSubtitleResourceJobSummary[],
): ReadonlyMap<string, LocalSubtitleResourceJobSummary> {
  const latest = new Map<string, LocalSubtitleResourceJobSummary>();
  for (const job of jobs) {
    const current = latest.get(job.resourceId);
    if (!current || compareResourceJobs(current, job) <= 0) {
      latest.set(job.resourceId, job);
    }
  }
  return latest;
}

export function getInstalledLocalSubtitleResourceBytes(
  resources: readonly LocalSubtitleManagedResourceSummary[],
): number {
  return resources.reduce(
    (total, resource) =>
      resource.status === "ready" ? total + resource.byteSize : total,
    0,
  );
}

export function formatLocalSubtitleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function getLocalSubtitleFileFormatLabel(
  displayName: string,
): string | undefined {
  const separator = displayName.lastIndexOf(".");
  if (separator <= 0 || separator === displayName.length - 1) return undefined;
  const extension = displayName.slice(separator + 1);
  return /^[a-z0-9]{1,10}$/iu.test(extension)
    ? extension.toUpperCase()
    : undefined;
}

export function getLocalSubtitleTrackLanguageLabel(
  language: string | undefined,
): string | undefined {
  const normalized = language?.trim();
  if (!normalized || normalized.toLowerCase() === "und") return undefined;
  return normalized;
}

export function getLocalSubtitleTrackCodecLabel(
  codec: string | undefined,
  fileFormat?: string,
): string | undefined {
  const normalized = codec?.trim().toUpperCase();
  if (!normalized || normalized === fileFormat?.toUpperCase()) return undefined;
  return normalized;
}

export function deriveLocalSubtitleStartIssue(
  input: LocalSubtitleStartReadinessInput,
): LocalSubtitleStartIssue | null {
  if (input.environmentLoading) return "environment_loading";
  if (input.environmentError) return "environment_unavailable";
  if (!isCpuRuntimeReady(input.runtime)) return "runtime_unavailable";
  if (!isLocalSubtitleDevicePreferenceAvailable(
    input.runtime,
    input.devicePreference,
  )) return "backend_preview_unavailable";
  if (input.runtimeSyncStatus !== "ready") return "session_unavailable";
  if (
    !input.selectedModelId ||
    !input.readyModels.some(
      (model) => model.resourceId === input.selectedModelId,
    )
  ) {
    return "model_required";
  }
  if (input.vadEnabled && !input.vadReady) return "vad_required";
  if (
    input.backendPreviewStatus === "idle" ||
    input.backendPreviewStatus === "loading" ||
    input.backendPreviewModelId !== input.selectedModelId ||
    input.backendPreviewDevicePreference !== input.devicePreference
  ) {
    return "backend_preview_loading";
  }
  if (input.backendPreviewStatus === "error") {
    return "backend_preview_unavailable";
  }
  if (input.selectedFiles.length === 0) return "file_required";
  if (input.mediaProbeStatus === "idle" || input.mediaProbeStatus === "loading") {
    return "media_probe_loading";
  }
  if (input.mediaProbeStatus === "error") return "media_probe_failed";
  if (input.outputMode === "custom" && !input.outputDirectory) {
    return "output_directory_required";
  }
  return null;
}

export function createLocalSubtitleBatchRequest(input: {
  readonly files: readonly LocalSubtitleAuthorizedMedia[];
  readonly modelId: string;
  readonly preferences: LocalSubtitleTranscriberPreferences;
  readonly initialPrompt?: string;
  readonly taskMode?: LocalSubtitleTaskMode;
  readonly outputDirectory: ActiveOutputDirectory | null;
  readonly explicitAudioStreamIds?: ReadonlyMap<string, string>;
  readonly conflictPolicy?: LocalSubtitleConflictPolicy;
  readonly postAction: Readonly<
    | { mode: "export_only" }
    | {
        mode: Exclude<SubtitleTranslationHandoffMode, "export_only">;
        preferredFormat: LocalSubtitleFormat;
        translationSnapshotId: string;
      }
  >;
}): EnqueueLocalSubtitleBatchRequest {
  if (
    input.files.length === 0 ||
    input.files.length > LOCAL_SUBTITLE_LIMITS.maxBatchFiles
  ) {
    throw new Error(
      `A local subtitle request requires 1-${LOCAL_SUBTITLE_LIMITS.maxBatchFiles} files.`,
    );
  }
  const output = input.preferences.outputMode === "custom"
    ? {
        mode: "custom" as const,
        outputDirToken: requireOutputDirectory(input.outputDirectory),
        formats: [...input.preferences.outputFormats],
        conflictPolicy: input.conflictPolicy ?? "index",
      }
    : {
        mode: "source" as const,
        formats: [...input.preferences.outputFormats],
        conflictPolicy: input.conflictPolicy ?? "index",
      };

  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    files: input.files.map((file) => {
      const audioStreamId = input.explicitAudioStreamIds?.get(file.fileToken);
      return {
        fileToken: file.fileToken,
        ...(audioStreamId === undefined ? {} : { audioStreamId }),
      };
    }),
    config: {
      modelId: input.modelId,
      devicePreference: input.preferences.devicePreference,
      language: input.preferences.language,
      taskMode: input.taskMode ?? "transcribe",
      vadEnabled: input.preferences.vadEnabled,
      advanced: {
        ...(input.initialPrompt
          ? { initialPrompt: input.initialPrompt }
          : {}),
        beamSize: input.preferences.beamSize,
        temperature: input.preferences.temperature,
        vadMinSilenceMs: input.preferences.vadMinSilenceMs,
        maxCueDurationMs: input.preferences.maxCueDurationMs,
        maxCueChars: input.preferences.maxCueChars,
        maxLineChars: input.preferences.maxLineChars,
      },
      output,
      postAction: input.postAction.mode === "export_only"
        ? { mode: "export_only" }
        : {
            mode: input.postAction.mode,
            preferredFormat: input.postAction.preferredFormat,
            translationSnapshotId: input.postAction.translationSnapshotId,
          },
    },
  };
}

export function deriveLocalSubtitleDraftMediaProbeStatus(
  files: readonly LocalSubtitleAuthorizedMedia[],
  probes: ReadonlyMap<string, LocalSubtitleDraftMediaProbe>,
): LocalSubtitleDraftMediaProbeStatus {
  if (files.length === 0) return "idle";
  const entries = files.map((file) => probes.get(file.fileToken));
  if (entries.some((entry) => entry?.status === "error")) return "error";
  if (entries.some((entry) => entry?.status !== "ready")) return "loading";
  return "ready";
}

export function reconcileLocalSubtitleDraftMediaProbes(
  files: readonly LocalSubtitleAuthorizedMedia[],
  current: ReadonlyMap<string, LocalSubtitleDraftMediaProbe>,
): ReadonlyMap<string, LocalSubtitleDraftMediaProbe> {
  let changed = current.size !== files.length;
  const next = new Map<string, LocalSubtitleDraftMediaProbe>();
  for (const file of files) {
    const existing = current.get(file.fileToken);
    if (existing) {
      next.set(file.fileToken, existing);
      continue;
    }
    changed = true;
    next.set(file.fileToken, { status: "loading" });
  }
  return changed ? next : current;
}

export function pruneLocalSubtitleDraftAudioSelections(
  files: readonly LocalSubtitleAuthorizedMedia[],
  current: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const selectedTokens = new Set(files.map((file) => file.fileToken));
  if ([...current].every(([fileToken]) => selectedTokens.has(fileToken))) {
    return current;
  }
  return new Map(
    [...current].filter(([fileToken]) => selectedTokens.has(fileToken)),
  );
}

export function formatLocalSubtitleDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function findLocalSubtitleTask(
  batches: readonly LocalSubtitleBatchSummary[],
  batchId: string | null,
  taskId: string | null,
): LocalSubtitleTaskSummary | null {
  if (!batchId || !taskId) return null;
  return batches
    .find((batch) => batch.batchId === batchId)
    ?.tasks.find((task) => task.taskId === taskId) ?? null;
}

export function isLocalSubtitleTaskActive(
  task: LocalSubtitleTaskSummary | null,
): boolean {
  return Boolean(
    task && !["completed", "cancelled", "failed"].includes(task.status),
  );
}

export function canManuallyHandoffLocalSubtitleArtifact(
  task: Pick<LocalSubtitleTaskSummary, "postAction">,
  format: LocalSubtitleFormat,
  translationTaskMissing: boolean,
): boolean {
  if (task.postAction.mode === "export_only") return true;
  if (task.postAction.preferredFormat !== format) return false;
  return translationTaskMissing ||
    task.postAction.importStatus === "failed" ||
    task.postAction.importStatus === "skipped";
}

function isCpuRuntimeReady(runtime: LocalSubtitleRuntimeSummary | null): boolean {
  return Boolean(
    runtime &&
      runtime.runner.status === "ready" &&
      runtime.mediaRuntime.status === "ready" &&
      runtime.backends.some(
        (backend) => backend.backend === "cpu" && backend.status === "available",
      ),
  );
}

function requireOutputDirectory(
  outputDirectory: ActiveOutputDirectory | null,
): string {
  if (!outputDirectory) {
    throw new Error("A custom output directory authorization is required.");
  }
  return outputDirectory.outputDirToken;
}

function compareResourceJobs(
  left: LocalSubtitleResourceJobSummary,
  right: LocalSubtitleResourceJobSummary,
): number {
  const updated = left.updatedAt.localeCompare(right.updatedAt);
  if (updated !== 0) return updated;
  const created = left.createdAt.localeCompare(right.createdAt);
  return created;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
