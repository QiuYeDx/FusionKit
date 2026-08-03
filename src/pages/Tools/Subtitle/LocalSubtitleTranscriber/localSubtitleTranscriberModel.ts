import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  type LocalSubtitleBatchSummary,
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
  | "file_required"
  | "output_directory_required"
  | "task_active";

export interface LocalSubtitleStartReadinessInput {
  readonly environmentLoading: boolean;
  readonly environmentError: boolean;
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly runtimeSyncStatus: LocalSubtitleRuntimeSyncStatus;
  readonly readyModels: readonly LocalSubtitleManagedResourceSummary[];
  readonly selectedModelId: string | null;
  readonly selectedFile: LocalSubtitleAuthorizedMedia | null;
  readonly outputMode: "source" | "custom";
  readonly outputDirectory: ActiveOutputDirectory | null;
  readonly taskActive: boolean;
}

export function getReadyLocalSubtitleModels(
  resources: readonly LocalSubtitleManagedResourceSummary[],
): LocalSubtitleManagedResourceSummary[] {
  return resources.filter(
    (resource) => resource.resourceType === "model" && resource.status === "ready",
  );
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
  if (input.taskActive) return "task_active";
  if (!input.selectedFile) return "file_required";
  if (input.outputMode === "custom" && !input.outputDirectory) {
    return "output_directory_required";
  }
  return null;
}

export function createSingleFileLocalSubtitleRequest(input: {
  readonly file: LocalSubtitleAuthorizedMedia;
  readonly modelId: string;
  readonly preferences: LocalSubtitleTranscriberPreferences;
  readonly outputDirectory: ActiveOutputDirectory | null;
}): EnqueueLocalSubtitleBatchRequest {
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
    files: [{ fileToken: input.file.fileToken }],
    config: {
      modelId: input.modelId,
      devicePreference: "cpu",
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
