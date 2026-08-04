import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_LIMITS,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleResourceJobStatus,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type {
  EnqueueLocalSubtitleBatchRequest,
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleManagedResourceSummary,
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
  | "backend_preview_loading"
  | "backend_preview_unavailable"
  | "file_required"
  | "output_directory_required";

export interface LocalSubtitleStartReadinessInput {
  readonly environmentLoading: boolean;
  readonly environmentError: boolean;
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly runtimeSyncStatus: LocalSubtitleRuntimeSyncStatus;
  readonly readyModels: readonly LocalSubtitleManagedResourceSummary[];
  readonly selectedModelId: string | null;
  readonly backendPreviewStatus: "idle" | "loading" | "ready" | "error";
  readonly backendPreviewModelId: string | null;
  readonly selectedFiles: readonly LocalSubtitleAuthorizedMedia[];
  readonly outputMode: "source" | "custom";
  readonly outputDirectory: ActiveOutputDirectory | null;
}

export function getReadyLocalSubtitleModels(
  resources: readonly LocalSubtitleManagedResourceSummary[],
): LocalSubtitleManagedResourceSummary[] {
  return resources.filter(
    (resource) => resource.resourceType === "model" && resource.status === "ready",
  );
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

export function deriveLocalSubtitleStartIssue(
  input: LocalSubtitleStartReadinessInput,
): LocalSubtitleStartIssue | null {
  if (input.environmentLoading) return "environment_loading";
  if (input.environmentError) return "environment_unavailable";
  if (!isCpuRuntimeReady(input.runtime)) return "runtime_unavailable";
  if (input.runtimeSyncStatus !== "ready") return "session_unavailable";
  if (
    !input.selectedModelId ||
    !input.readyModels.some(
      (model) => model.resourceId === input.selectedModelId,
    )
  ) {
    return "model_required";
  }
  if (
    input.backendPreviewStatus === "idle" ||
    input.backendPreviewStatus === "loading" ||
    input.backendPreviewModelId !== input.selectedModelId
  ) {
    return "backend_preview_loading";
  }
  if (input.backendPreviewStatus === "error") {
    return "backend_preview_unavailable";
  }
  if (input.selectedFiles.length === 0) return "file_required";
  if (input.outputMode === "custom" && !input.outputDirectory) {
    return "output_directory_required";
  }
  return null;
}

export function createLocalSubtitleBatchRequest(input: {
  readonly files: readonly LocalSubtitleAuthorizedMedia[];
  readonly modelId: string;
  readonly preferences: LocalSubtitleTranscriberPreferences;
  readonly outputDirectory: ActiveOutputDirectory | null;
}): EnqueueLocalSubtitleBatchRequest {
  if (
    input.files.length === 0 ||
    input.files.length > LOCAL_SUBTITLE_LIMITS.maxBatchFiles
  ) {
    throw new Error(
      `A local subtitle batch requires 1-${LOCAL_SUBTITLE_LIMITS.maxBatchFiles} files.`,
    );
  }
  const output = input.preferences.outputMode === "custom"
    ? {
        mode: "custom" as const,
        outputDirToken: requireOutputDirectory(input.outputDirectory),
        formats: ["SRT" as const],
        conflictPolicy: "index" as const,
      }
    : {
        mode: "source" as const,
        formats: ["SRT" as const],
        conflictPolicy: "index" as const,
      };

  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    files: input.files.map((file) => ({ fileToken: file.fileToken })),
    config: {
      modelId: input.modelId,
      devicePreference: "auto",
      language: input.preferences.language,
      taskMode: "transcribe",
      qualityPreset: input.preferences.qualityPreset,
      vadEnabled: false,
      advanced: {
        beamSize: input.preferences.beamSize,
        temperature: input.preferences.temperature,
        vadMinSilenceMs: input.preferences.vadMinSilenceMs,
        maxCueDurationMs: input.preferences.maxCueDurationMs,
        maxCueChars: input.preferences.maxCueChars,
        maxLineChars: input.preferences.maxLineChars,
      },
      output,
      postAction: { mode: "export_only" },
    },
  };
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

export function getCommittedSrtArtifact(task: LocalSubtitleTaskSummary | null) {
  if (!task) return null;
  const result = task.artifactResults.find(
    (artifact) => artifact.format === "SRT" && artifact.status === "committed",
  );
  return result?.status === "committed" ? result.artifact : null;
}

export function isLocalSubtitleTaskActive(
  task: LocalSubtitleTaskSummary | null,
): boolean {
  return Boolean(
    task && !["completed", "cancelled", "failed"].includes(task.status),
  );
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
