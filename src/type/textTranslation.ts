import type { TranslationLanguage } from "@/type/subtitle";

export type TextFileFormat = "txt" | "markdown";

export type TextTranslationExecutionMode = "parallel" | "sequential_context";

export type TextTranslationOutputMode = "target_only" | "bilingual";

export type TextTranslationProjectMode =
  | "independent_files"
  | "ordered_project";

export type TextTranslationOutputPathMode = "custom" | "source";

export type TextTranslationConflictPolicy = "overwrite" | "index";

export type TextTranslationTaskStatus =
  | "not_started"
  | "preparing"
  | "waiting"
  | "running"
  | "paused"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

export type TextTranslationPhase =
  | "idle"
  | "inspecting_files"
  | "detecting_encoding"
  | "parsing"
  | "planning_segments"
  | "estimating"
  | "translating"
  | "assembling_outputs"
  | "completed";

export type TextTranslationErrorCode =
  | "no_files"
  | "invalid_file_id"
  | "duplicate_file_id"
  | "invalid_file_path"
  | "unsupported_file_format"
  | "duplicate_file_order"
  | "source_target_language_same"
  | "slice_token_limit_out_of_range"
  | "semantic_memory_token_limit_out_of_range"
  | "output_token_reserve_out_of_range"
  | "parallel_concurrency_out_of_range"
  | "model_context_token_limit_out_of_range"
  | "model_context_budget_exceeded"
  | "missing_task_model"
  | "file_size_soft_warning"
  | "file_size_hard_limit"
  | "project_size_soft_warning"
  | "project_size_hard_limit"
  | "disk_available_below_minimum"
  | "disk_available_below_recommended";

export type TextTranslationIssueSeverity = "error" | "warning";

export interface TextTranslationValidationIssue {
  code: TextTranslationErrorCode;
  severity: TextTranslationIssueSeverity;
  message: string;
  field?: string;
  fileId?: string;
  phase?: TextTranslationPhase;
  details?: Record<string, unknown>;
}

export interface TextTranslationFileRef {
  fileId: string;
  sourcePath: string;
  relativePath?: string;
  fileName: string;
  format: TextFileFormat;
  sizeBytes: number;
  modifiedAt: number;
  order: number;
}

export interface TextTranslationGlossaryEntry {
  source: string;
  target: string;
  note?: string;
}

export interface TextTranslationOptions {
  sourceLang: TranslationLanguage | "AUTO";
  targetLang: TranslationLanguage;
  executionMode: TextTranslationExecutionMode;
  outputMode: TextTranslationOutputMode;
  projectMode: TextTranslationProjectMode;

  sliceTokenLimit: number;
  semanticMemoryTokenLimit: number;
  modelContextTokenLimit: number;
  outputTokenReserve: number;
  parallelSliceConcurrency: number;

  documentBackground?: string;
  translationInstructions?: string;
  styleInstructions?: string;
  glossary?: TextTranslationGlossaryEntry[];

  outputDir?: string;
  outputPathMode: TextTranslationOutputPathMode;
  conflictPolicy: TextTranslationConflictPolicy;
}

export interface TextTranslationProgress {
  phase: TextTranslationPhase;
  completedFiles: number;
  totalFiles: number;
  completedSegments: number;
  totalSegments: number;
  activeSegmentIds: string[];
  currentFileId?: string;
  estimatedInputTokens?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  percentage: number;
}

export interface TextTranslationTask {
  taskId: string;
  projectId?: string;
  files: TextTranslationFileRef[];
  options: TextTranslationOptions;
  status: TextTranslationTaskStatus;
  phase: TextTranslationPhase;
  progress: TextTranslationProgress;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceFingerprint {
  fileId: string;
  sourcePath: string;
  sizeBytes: number;
  modifiedAt: number;
  contentHash?: string;
}

export type TextTranslationOptionsWithoutSecrets = TextTranslationOptions;

export interface TextTranslationPersistedModelRef {
  profileId?: string;
  modelKey?: string;
  endpointLabel?: string;
}

export interface PersistedTextTranslationTask {
  schemaVersion: 1;
  taskId: string;
  projectId?: string;
  status: TextTranslationTaskStatus;
  phase: TextTranslationPhase;
  options: TextTranslationOptionsWithoutSecrets;
  sourceFingerprint: SourceFingerprint[];
  segmentCount: number;
  completedSegmentCount: number;
  failedSegmentIds: string[];
  staleFromSegmentId?: string;
  model?: TextTranslationPersistedModelRef;
  createdAt: string;
  updatedAt: string;
}

export interface TextTranslationRuntimeModelConfig {
  profileId?: string;
  apiKey: string;
  modelKey: string;
  endpoint: string;
}

export interface CreateTextTranslationTaskRequest {
  files: Array<{
    sourcePath: string;
    relativePath?: string;
    order: number;
  }>;
  options: TextTranslationOptions;
  model: TextTranslationRuntimeModelConfig;
}

export interface TextTranslationRecoverySummary {
  taskId: string;
  workspacePath: string;
  status: TextTranslationTaskStatus;
  resumable: boolean;
  completedSegmentCount: number;
  totalSegmentCount: number;
  failedSegmentIds: string[];
  staleFromSegmentId?: string;
  blockingReason?: string;
}

export interface TextTranslationConfigValidationInput {
  files: TextTranslationFileRef[];
  options: TextTranslationOptions;
  model?: Partial<TextTranslationRuntimeModelConfig>;
  requireModel?: boolean;
}

export interface TextTranslationValidationResult {
  ok: boolean;
  errors: TextTranslationValidationIssue[];
  warnings: TextTranslationValidationIssue[];
}

export interface TextTranslationWorkspaceDiskEstimate {
  sourceBytes: number;
  minimumRequiredBytes: number;
  recommendedAvailableBytes: number;
}

export const TEXT_TRANSLATION_SCHEMA_VERSION = 1 as const;

export const TEXT_TRANSLATION_TOKEN_LIMITS = {
  minSliceTokenLimit: 512,
  maxSliceTokenLimit: 16_000,
  minSemanticMemoryTokenLimit: 512,
  minModelContextTokenLimit: 8_192,
  minOutputTokenReserve: 1_024,
  maxParallelSliceConcurrency: 3,
  instructionReserveTokens: 2_048,
  recentContextReserveTokens: 1_024,
  safetyMarginMinTokens: 1_024,
  safetyMarginRatio: 0.05,
} as const;

export const DEFAULT_TEXT_TRANSLATION_SLICE_TOKEN_LIMIT = 3_000;
export const DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT = 32_768;

export const DEFAULT_TEXT_TRANSLATION_OPTIONS: TextTranslationOptions = {
  sourceLang: "AUTO",
  targetLang: "ZH",
  executionMode: "parallel",
  outputMode: "target_only",
  projectMode: "independent_files",
  sliceTokenLimit: DEFAULT_TEXT_TRANSLATION_SLICE_TOKEN_LIMIT,
  semanticMemoryTokenLimit: 8_192,
  modelContextTokenLimit: DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT,
  outputTokenReserve: resolveTextTranslationOutputTokenReserve(
    DEFAULT_TEXT_TRANSLATION_SLICE_TOKEN_LIMIT,
  ),
  parallelSliceConcurrency: 3,
  outputPathMode: "source",
  conflictPolicy: "index",
};

export const TEXT_TRANSLATION_RESOURCE_LIMITS = {
  txtSingleFileSoftWarningBytes: 50 * 1024 * 1024,
  txtSingleFileHardLimitBytes: 200 * 1024 * 1024,
  markdownSingleFileSoftWarningBytes: 5 * 1024 * 1024,
  markdownSingleFileHardLimitBytes: 10 * 1024 * 1024,
  projectTotalSoftWarningBytes: 200 * 1024 * 1024,
  projectTotalHardLimitBytes: 1024 * 1024 * 1024,
  successfulWorkspaceRetentionDays: 7,
  nonSuccessReviewAfterDays: 30,
} as const;

export function resolveTextTranslationOutputTokenReserve(
  sliceTokenLimit: number,
): number {
  return Math.max(4_096, sliceTokenLimit * 2);
}

export function createTextTranslationOptions(
  overrides: Partial<TextTranslationOptions> = {},
): TextTranslationOptions {
  const sliceTokenLimit =
    overrides.sliceTokenLimit ?? DEFAULT_TEXT_TRANSLATION_SLICE_TOKEN_LIMIT;

  return {
    ...DEFAULT_TEXT_TRANSLATION_OPTIONS,
    ...overrides,
    sliceTokenLimit,
    outputTokenReserve:
      overrides.outputTokenReserve ??
      resolveTextTranslationOutputTokenReserve(sliceTokenLimit),
  };
}

export function createInitialTextTranslationProgress(
  totalFiles = 0,
  phase: TextTranslationPhase = "idle",
): TextTranslationProgress {
  return {
    phase,
    completedFiles: 0,
    totalFiles,
    completedSegments: 0,
    totalSegments: 0,
    activeSegmentIds: [],
    percentage: 0,
  };
}

export function createTextTranslationTask(params: {
  taskId: string;
  projectId?: string;
  files: TextTranslationFileRef[];
  options?: TextTranslationOptions;
  workspacePath?: string;
  now?: string;
}): TextTranslationTask {
  const now = params.now ?? new Date().toISOString();

  return {
    taskId: params.taskId,
    projectId: params.projectId,
    files: params.files,
    options: params.options ?? createTextTranslationOptions(),
    status: "not_started",
    phase: "idle",
    progress: createInitialTextTranslationProgress(params.files.length),
    workspacePath: params.workspacePath,
    createdAt: now,
    updatedAt: now,
  };
}

export function createPersistedTextTranslationTask(params: {
  task: TextTranslationTask;
  sourceFingerprint: SourceFingerprint[];
  segmentCount: number;
  completedSegmentCount?: number;
  failedSegmentIds?: string[];
  staleFromSegmentId?: string;
  model?: TextTranslationPersistedModelRef;
}): PersistedTextTranslationTask {
  return {
    schemaVersion: TEXT_TRANSLATION_SCHEMA_VERSION,
    taskId: params.task.taskId,
    projectId: params.task.projectId,
    status: params.task.status,
    phase: params.task.phase,
    options: params.task.options,
    sourceFingerprint: params.sourceFingerprint,
    segmentCount: params.segmentCount,
    completedSegmentCount: params.completedSegmentCount ?? 0,
    failedSegmentIds: params.failedSegmentIds ?? [],
    staleFromSegmentId: params.staleFromSegmentId,
    model: params.model,
    createdAt: params.task.createdAt,
    updatedAt: params.task.updatedAt,
  };
}

export function validateTextTranslationConfig(
  input: TextTranslationConfigValidationInput,
): TextTranslationValidationResult {
  const errors: TextTranslationValidationIssue[] = [];
  const warnings: TextTranslationValidationIssue[] = [];
  const requireModel = input.requireModel ?? true;

  validateFiles(input.files, input.options, errors, warnings);
  validateOptions(input.options, errors);

  if (requireModel && !hasUsableRuntimeModel(input.model)) {
    errors.push({
      code: "missing_task_model",
      severity: "error",
      field: "model",
      message: "Task execution model is not configured.",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function estimateTextTranslationWorkspaceDiskRequirement(
  sourceBytes: number,
): TextTranslationWorkspaceDiskEstimate {
  return {
    sourceBytes,
    minimumRequiredBytes: Math.ceil(sourceBytes * 2 + 64 * 1024 * 1024),
    recommendedAvailableBytes: Math.ceil(sourceBytes * 3.5 + 128 * 1024 * 1024),
  };
}

export function assessTextTranslationDiskSpace(
  estimate: TextTranslationWorkspaceDiskEstimate,
  availableBytes: number,
): TextTranslationValidationResult {
  if (availableBytes < estimate.minimumRequiredBytes) {
    return {
      ok: false,
      errors: [
        {
          code: "disk_available_below_minimum",
          severity: "error",
          field: "workspace",
          message: "Available disk space is below the minimum required space.",
          details: {
            availableBytes,
            minimumRequiredBytes: estimate.minimumRequiredBytes,
          },
        },
      ],
      warnings: [],
    };
  }

  if (availableBytes < estimate.recommendedAvailableBytes) {
    return {
      ok: true,
      errors: [],
      warnings: [
        {
          code: "disk_available_below_recommended",
          severity: "warning",
          field: "workspace",
          message:
            "Available disk space is below the recommended workspace reserve.",
          details: {
            availableBytes,
            recommendedAvailableBytes: estimate.recommendedAvailableBytes,
          },
        },
      ],
    };
  }

  return { ok: true, errors: [], warnings: [] };
}

export function getTotalTextTranslationSourceBytes(
  files: TextTranslationFileRef[],
): number {
  return files.reduce((total, file) => total + Math.max(0, file.sizeBytes), 0);
}

export function estimateTextTranslationRequiredContextTokens(
  options: TextTranslationOptions,
): number {
  const safetyMargin = Math.max(
    TEXT_TRANSLATION_TOKEN_LIMITS.safetyMarginMinTokens,
    Math.ceil(
      options.modelContextTokenLimit *
        TEXT_TRANSLATION_TOKEN_LIMITS.safetyMarginRatio,
    ),
  );

  return (
    options.sliceTokenLimit +
    options.outputTokenReserve +
    TEXT_TRANSLATION_TOKEN_LIMITS.instructionReserveTokens +
    TEXT_TRANSLATION_TOKEN_LIMITS.recentContextReserveTokens +
    safetyMargin +
    (options.executionMode === "sequential_context"
      ? options.semanticMemoryTokenLimit
      : 0)
  );
}

function validateFiles(
  files: TextTranslationFileRef[],
  options: TextTranslationOptions,
  errors: TextTranslationValidationIssue[],
  warnings: TextTranslationValidationIssue[],
): void {
  if (files.length === 0) {
    errors.push({
      code: "no_files",
      severity: "error",
      field: "files",
      message: "At least one source file is required.",
    });
    return;
  }

  const fileIds = new Set<string>();
  const orders = new Set<number>();
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += Math.max(0, file.sizeBytes);

    if (!file.fileId.trim()) {
      errors.push({
        code: "invalid_file_id",
        severity: "error",
        field: "files.fileId",
        fileId: file.fileId,
        message: "File id is required and cannot be empty.",
      });
    } else if (fileIds.has(file.fileId)) {
      errors.push({
        code: "duplicate_file_id",
        severity: "error",
        field: "files.fileId",
        fileId: file.fileId,
        message: "File id must be unique within a task.",
      });
    }
    fileIds.add(file.fileId);

    if (!file.sourcePath.trim()) {
      errors.push({
        code: "invalid_file_path",
        severity: "error",
        field: "files.sourcePath",
        fileId: file.fileId,
        message: "Source path is required.",
      });
    }

    if (file.format !== "txt" && file.format !== "markdown") {
      errors.push({
        code: "unsupported_file_format",
        severity: "error",
        field: "files.format",
        fileId: file.fileId,
        message: "Only txt and markdown files are supported.",
      });
    }

    if (options.projectMode === "ordered_project") {
      if (orders.has(file.order)) {
        errors.push({
          code: "duplicate_file_order",
          severity: "error",
          field: "files.order",
          fileId: file.fileId,
          message: "Ordered projects require unique file order values.",
        });
      }
      orders.add(file.order);
    }

    pushResourceLimitIssue(file, errors, warnings);
  }

  if (totalBytes > TEXT_TRANSLATION_RESOURCE_LIMITS.projectTotalHardLimitBytes) {
    errors.push({
      code: "project_size_hard_limit",
      severity: "error",
      field: "files",
      message: "Project total size exceeds the first-version hard limit.",
      details: {
        totalBytes,
        hardLimitBytes:
          TEXT_TRANSLATION_RESOURCE_LIMITS.projectTotalHardLimitBytes,
      },
    });
  } else if (
    totalBytes > TEXT_TRANSLATION_RESOURCE_LIMITS.projectTotalSoftWarningBytes
  ) {
    warnings.push({
      code: "project_size_soft_warning",
      severity: "warning",
      field: "files",
      message: "Project total size exceeds the first-version soft warning.",
      details: {
        totalBytes,
        softLimitBytes:
          TEXT_TRANSLATION_RESOURCE_LIMITS.projectTotalSoftWarningBytes,
      },
    });
  }
}

function validateOptions(
  options: TextTranslationOptions,
  errors: TextTranslationValidationIssue[],
): void {
  if (
    options.sourceLang !== "AUTO" &&
    options.sourceLang === options.targetLang
  ) {
    errors.push({
      code: "source_target_language_same",
      severity: "error",
      field: "targetLang",
      message: "Target language must differ from the explicit source language.",
    });
  }

  if (
    !isIntegerInRange(
      options.sliceTokenLimit,
      TEXT_TRANSLATION_TOKEN_LIMITS.minSliceTokenLimit,
      TEXT_TRANSLATION_TOKEN_LIMITS.maxSliceTokenLimit,
    )
  ) {
    errors.push({
      code: "slice_token_limit_out_of_range",
      severity: "error",
      field: "sliceTokenLimit",
      message: "Slice token limit is outside the safe range.",
    });
  }

  if (
    !Number.isInteger(options.semanticMemoryTokenLimit) ||
    options.semanticMemoryTokenLimit <
      TEXT_TRANSLATION_TOKEN_LIMITS.minSemanticMemoryTokenLimit ||
    options.semanticMemoryTokenLimit >= options.modelContextTokenLimit
  ) {
    errors.push({
      code: "semantic_memory_token_limit_out_of_range",
      severity: "error",
      field: "semanticMemoryTokenLimit",
      message:
        "Semantic memory token limit must be positive and smaller than the model context window.",
    });
  }

  if (
    !isIntegerInRange(
      options.outputTokenReserve,
      TEXT_TRANSLATION_TOKEN_LIMITS.minOutputTokenReserve,
      options.modelContextTokenLimit,
    )
  ) {
    errors.push({
      code: "output_token_reserve_out_of_range",
      severity: "error",
      field: "outputTokenReserve",
      message: "Output token reserve is outside the safe range.",
    });
  }

  if (
    !isIntegerInRange(
      options.parallelSliceConcurrency,
      1,
      TEXT_TRANSLATION_TOKEN_LIMITS.maxParallelSliceConcurrency,
    )
  ) {
    errors.push({
      code: "parallel_concurrency_out_of_range",
      severity: "error",
      field: "parallelSliceConcurrency",
      message: "Parallel slice concurrency is outside the first-version range.",
    });
  }

  if (
    !Number.isInteger(options.modelContextTokenLimit) ||
    options.modelContextTokenLimit <
      TEXT_TRANSLATION_TOKEN_LIMITS.minModelContextTokenLimit
  ) {
    errors.push({
      code: "model_context_token_limit_out_of_range",
      severity: "error",
      field: "modelContextTokenLimit",
      message: "Model context token limit is outside the safe range.",
    });
    return;
  }

  const requiredContextTokens =
    estimateTextTranslationRequiredContextTokens(options);
  if (requiredContextTokens > options.modelContextTokenLimit) {
    errors.push({
      code: "model_context_budget_exceeded",
      severity: "error",
      field: "modelContextTokenLimit",
      message:
        "Model context window cannot fit instructions, memory, current segment, output reserve, and safety margin.",
      details: {
        requiredContextTokens,
        modelContextTokenLimit: options.modelContextTokenLimit,
      },
    });
  }
}

function pushResourceLimitIssue(
  file: TextTranslationFileRef,
  errors: TextTranslationValidationIssue[],
  warnings: TextTranslationValidationIssue[],
): void {
  const softLimit =
    file.format === "markdown"
      ? TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileSoftWarningBytes
      : TEXT_TRANSLATION_RESOURCE_LIMITS.txtSingleFileSoftWarningBytes;
  const hardLimit =
    file.format === "markdown"
      ? TEXT_TRANSLATION_RESOURCE_LIMITS.markdownSingleFileHardLimitBytes
      : TEXT_TRANSLATION_RESOURCE_LIMITS.txtSingleFileHardLimitBytes;

  if (file.sizeBytes > hardLimit) {
    errors.push({
      code: "file_size_hard_limit",
      severity: "error",
      field: "files.sizeBytes",
      fileId: file.fileId,
      message: "Source file exceeds the first-version hard limit.",
      details: {
        fileBytes: file.sizeBytes,
        hardLimitBytes: hardLimit,
        format: file.format,
      },
    });
  } else if (file.sizeBytes > softLimit) {
    warnings.push({
      code: "file_size_soft_warning",
      severity: "warning",
      field: "files.sizeBytes",
      fileId: file.fileId,
      message: "Source file exceeds the first-version soft warning.",
      details: {
        fileBytes: file.sizeBytes,
        softLimitBytes: softLimit,
        format: file.format,
      },
    });
  }
}

function hasUsableRuntimeModel(
  model: Partial<TextTranslationRuntimeModelConfig> | undefined,
): boolean {
  return Boolean(
    model?.apiKey?.trim() && model.modelKey?.trim() && model.endpoint?.trim(),
  );
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
