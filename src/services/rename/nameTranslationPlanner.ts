import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { ModelProfile } from "@/type/model";
import {
  NameTranslationPlannerError,
  normalizeNameTranslationOptions,
  type BatchPathCheckResult,
  type ClarificationRequired,
  type NameTranslationModelInputItem,
  type NameTranslationModelOutputItem,
  type NameTranslationOptions,
  type NameTranslationPlanningMetrics,
  type NameTranslationPlanningPhase,
  type NameTranslationPlanningProgress,
  type NameTranslationPlan,
  type NameTranslationPlanItem,
  type NameTranslationPlanSummary,
  type NameTranslationTarget,
  type ScanRenameTargetsResult,
} from "./nameTypes";
import {
  createPlanExpiry,
  rememberNameTranslationPlan,
  summarizeNameTranslationPlan,
} from "./namePlanStore";
import { joinPath, isRootLikePath } from "./namePath";
import { sanitizeTranslatedName } from "./nameSanitize";
import { validatePlanItems } from "./nameConflict";
import {
  checkRenameTargetsExist,
  checkRenameTargetExists,
  scanNameTranslationTargets,
} from "./nameTargetResolver";
import {
  buildNameTranslationSystemPrompt,
  buildNameTranslationUserPrompt,
} from "./nameTranslationPrompt";
import {
  createNameTranslationCacheKey,
  createNameTranslationOutputFromCache,
  defaultNameTranslationCache,
  type NameTranslationCache,
} from "./nameTranslationCache";
import { getNameTranslationFastPath } from "./nameTranslationFastPath";

const DEFAULT_PREVIEW_LIMIT = 30;
const DEFAULT_MAX_TARGETS = 5000;
const MAX_TRANSLATION_WARNINGS = 200;
const DEFAULT_ADAPTIVE_BATCHING_THRESHOLD = 5;
const DEFAULT_TRANSLATION_BATCH_CONFIG: NameTranslationBatchConfig = {
  batchSize: 50,
  concurrency: 3,
  minBatchSize: 5,
  maxBatchSize: 80,
  rateLimitBackoffMs: 1500,
  adaptiveBatching: true,
};
const MAX_RATE_LIMIT_RETRIES = 2;

const modelOutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      translatedStem: z.string(),
      confidence: z.enum(["high", "medium", "low"]).optional(),
      note: z.string().optional(),
    })
  ),
});

export interface CreateNameTranslationPlanDeps {
  scanTargets?: (
    options: NameTranslationOptions,
    maxTargets?: number
  ) => Promise<ScanRenameTargetsResult>;
  translateBatch?: (
    items: NameTranslationModelInputItem[],
    options: NameTranslationOptions
  ) => Promise<NameTranslationModelOutputItem[]>;
  checkPathExists?: (filePath: string) => Promise<boolean>;
  checkPathsExist?: (filePaths: string[]) => Promise<BatchPathCheckResult>;
  now?: () => number;
  previewLimit?: number;
  maxTargets?: number;
  planIdFactory?: () => string;
  progress?: (progress: NameTranslationPlanningProgress) => void;
  signal?: AbortSignal;
  translationCache?: NameTranslationCache;
  batchConfig?: Partial<NameTranslationBatchConfig>;
}

export interface NameTranslationBatchConfig {
  batchSize: number;
  concurrency: number;
  minBatchSize: number;
  maxBatchSize: number;
  rateLimitBackoffMs: number;
  adaptiveBatching: boolean;
}

interface PlanningProgressReporter {
  start: (
    phase: NameTranslationPlanningPhase,
    progress?: Omit<NameTranslationPlanningProgress, "phase" | "metrics">
  ) => void;
  emit: (
    phase: NameTranslationPlanningPhase,
    progress?: Omit<NameTranslationPlanningProgress, "phase" | "metrics">
  ) => void;
  finish: (
    phase: Extract<NameTranslationPlanningPhase, "done" | "failed" | "cancelled">,
    progress?: Omit<NameTranslationPlanningProgress, "phase" | "metrics">
  ) => void;
  completeCurrentPhase: (metricKey: keyof NameTranslationPlanningMetrics) => void;
  setMetrics: (metrics: Partial<NameTranslationPlanningMetrics>) => void;
}

interface TranslationStats {
  requestCount: number;
  retryCount: number;
  completedBatchCount: number;
  totalBatchCount: number;
  translatedCount: number;
  translatableCount: number;
  cacheHitCount: number;
  fastPathCount: number;
  activeBatchCount: number;
  concurrencyPeak: number;
}

interface TranslationObserver {
  stats: TranslationStats;
  onProgress?: (stats: TranslationStats) => void;
}

interface PathCheckStats {
  requestCount: number;
}

interface TranslationWorkItem {
  key: string;
  modelInput: NameTranslationModelInputItem;
  targetIds: string[];
}

interface TranslationBatch {
  workItems: TranslationWorkItem[];
}

interface PreparedTranslationWork {
  translationMap: Map<string, NameTranslationModelOutputItem>;
  workItems: TranslationWorkItem[];
  translatableCount: number;
  resolvedCount: number;
  cacheHitCount: number;
  fastPathCount: number;
}

interface TranslationRecoveryContext {
  observer?: TranslationObserver;
  batchConfig: NameTranslationBatchConfig;
  signal?: AbortSignal;
  onRateLimit?: () => void;
}

type ModelErrorCategory = "rate_limit" | "non_recoverable" | "recoverable";

export async function createNameTranslationPlan(
  options: NameTranslationOptions,
  deps: CreateNameTranslationPlanDeps = {}
): Promise<NameTranslationPlanSummary> {
  const clock = deps.now ?? Date.now;
  const progress = createPlanningProgressReporter(deps.progress, clock);
  const normalizedOptions = normalizeNameTranslationOptions(options);
  const now = clock();
  const previewLimit = deps.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const planId = deps.planIdFactory?.() ?? createPlanId();

  try {
    const clarificationRequired =
      getPathSegmentClarification(normalizedOptions) ??
      getUnsafePathSegmentClarification(normalizedOptions);
    throwIfPlanningAborted(deps.signal);

    if (clarificationRequired) {
      const plan = buildPlan({
        planId,
        createdAt: now,
        previewLimit,
        options: normalizedOptions,
        items: [],
        warnings: [],
        clarificationRequired,
      });
      throwIfPlanningAborted(deps.signal);
      progress.start("storing");
      rememberNameTranslationPlan(plan);
      progress.finish("done", {
        totalTargets: 0,
        warningCount: 0,
      });
      return summarizeNameTranslationPlan(plan);
    }

    if (normalizedOptions.scope === "path_segments") {
      const plan = buildPlan({
        planId,
        createdAt: now,
        previewLimit,
        options: normalizedOptions,
        items: [],
        warnings: [
          "path_segments planning is intentionally non-applyable until path-level rename ordering is implemented.",
        ],
        clarificationRequired: {
          code: "path_segments_deferred",
          message:
            "路径片段重命名需要额外确认和目录重写顺序，本阶段只生成不可应用预览。",
        },
      });
      throwIfPlanningAborted(deps.signal);
      progress.start("storing");
      rememberNameTranslationPlan(plan);
      progress.finish("done", {
        totalTargets: 0,
        warningCount: plan.warnings.length,
      });
      return summarizeNameTranslationPlan(plan);
    }

    const scanTargets = deps.scanTargets ?? scanNameTranslationTargets;
    progress.start("scanning");
    const scanResult = await scanTargets(
      normalizedOptions,
      deps.maxTargets ?? DEFAULT_MAX_TARGETS
    );
    progress.completeCurrentPhase("scanDurationMs");
    progress.emit("scanning", {
      totalTargets: scanResult.totalCount,
      scannedTargets: scanResult.targets.length,
      warningCount: scanResult.warnings.length,
    });
    throwIfPlanningAborted(deps.signal);

    const translationWarnings: string[] = [];
    const translationCache = deps.translationCache ?? defaultNameTranslationCache;
    progress.start("classifying", {
      totalTargets: scanResult.totalCount,
      scannedTargets: scanResult.targets.length,
      warningCount: scanResult.warnings.length,
    });
    const preparedTranslationWork = prepareTranslationWork(
      scanResult.targets,
      normalizedOptions,
      translationCache,
      clock,
      deps.signal
    );
    progress.setMetrics({
      translationCacheHitCount: preparedTranslationWork.cacheHitCount,
      translationFastPathCount: preparedTranslationWork.fastPathCount,
    });
    progress.completeCurrentPhase("classifyingDurationMs");
    progress.emit("classifying", {
      totalTargets: scanResult.totalCount,
      translatableCount: preparedTranslationWork.translatableCount,
      translatedCount: preparedTranslationWork.resolvedCount,
      cacheHitCount: preparedTranslationWork.cacheHitCount,
      fastPathCount: preparedTranslationWork.fastPathCount,
      warningCount: scanResult.warnings.length,
    });
    throwIfPlanningAborted(deps.signal);

    const batchConfig = normalizeTranslationBatchConfig(deps.batchConfig);
    const totalBatchCount = createTranslationBatches(
      preparedTranslationWork.workItems,
      batchConfig
    ).length;
    progress.start("translating", {
      totalTargets: scanResult.totalCount,
      translatableCount: preparedTranslationWork.translatableCount,
      translatedCount: preparedTranslationWork.resolvedCount,
      cacheHitCount: preparedTranslationWork.cacheHitCount,
      fastPathCount: preparedTranslationWork.fastPathCount,
      completedBatchCount: 0,
      totalBatchCount,
      warningCount: scanResult.warnings.length,
    });
    const translationStats: TranslationStats = {
      requestCount: 0,
      retryCount: 0,
      completedBatchCount: 0,
      totalBatchCount,
      translatedCount: preparedTranslationWork.resolvedCount,
      translatableCount: preparedTranslationWork.translatableCount,
      cacheHitCount: preparedTranslationWork.cacheHitCount,
      fastPathCount: preparedTranslationWork.fastPathCount,
      activeBatchCount: 0,
      concurrencyPeak: 0,
    };
    const translationMap = await translateTargets(
      preparedTranslationWork,
      normalizedOptions,
      deps.translateBatch ?? translateBatchWithTaskModel,
      translationWarnings,
      translationCache,
      clock,
      deps.signal,
      batchConfig,
      {
        stats: translationStats,
        onProgress: (stats) =>
          progress.emit("translating", {
            totalTargets: scanResult.totalCount,
            translatableCount: stats.translatableCount,
            translatedCount: stats.translatedCount,
            cacheHitCount: stats.cacheHitCount,
            fastPathCount: stats.fastPathCount,
            activeBatchCount: stats.activeBatchCount,
            completedBatchCount: stats.completedBatchCount,
            totalBatchCount: stats.totalBatchCount,
            retryCount: stats.retryCount,
            warningCount: scanResult.warnings.length + translationWarnings.length,
          }),
      }
    );
    throwIfPlanningAborted(deps.signal);
    progress.setMetrics({
      translationRequestCount: translationStats.requestCount,
      translationBatchCount: translationStats.totalBatchCount,
      translationConcurrencyPeak: translationStats.concurrencyPeak,
      translationCacheHitCount: translationStats.cacheHitCount,
      translationFastPathCount: translationStats.fastPathCount,
    });
    progress.completeCurrentPhase("translationDurationMs");

    const rawItems = scanResult.targets.map((target) =>
      createPlanItem(target, normalizedOptions, translationMap, translationWarnings)
    );
    const pathCheckStats: PathCheckStats = { requestCount: 0 };
    const pathCheckWarnings: string[] = [];
    progress.start("checking_targets", {
      totalTargets: scanResult.totalCount,
      warningCount: scanResult.warnings.length + translationWarnings.length,
    });
    const existingTargetPaths = await collectExistingTargetPaths(
      rawItems,
      deps.checkPathExists ?? checkRenameTargetExists,
      pathCheckStats,
      deps.checkPathsExist ??
        (deps.checkPathExists ? undefined : checkRenameTargetsExist),
      pathCheckWarnings
    );
    throwIfPlanningAborted(deps.signal);
    progress.setMetrics({
      pathCheckRequestCount: pathCheckStats.requestCount,
    });
    progress.completeCurrentPhase("pathCheckDurationMs");

    progress.start("validating", {
      totalTargets: scanResult.totalCount,
      warningCount: scanResult.warnings.length + translationWarnings.length,
    });
    const planBuildStartedAt = clock();
    const validatedItems = validatePlanItems(rawItems, normalizedOptions, {
      existingTargetPaths,
    });
    const plan = buildPlan({
      planId,
      createdAt: now,
      previewLimit,
      options: normalizedOptions,
      items: validatedItems,
      warnings: [...scanResult.warnings, ...translationWarnings, ...pathCheckWarnings],
      totalTargets: scanResult.totalCount,
    });
    progress.setMetrics({
      planBuildDurationMs: Math.max(0, clock() - planBuildStartedAt),
    });
    throwIfPlanningAborted(deps.signal);

    progress.start("storing", {
      totalTargets: scanResult.totalCount,
      warningCount: plan.warnings.length,
    });
    rememberNameTranslationPlan(plan);
    progress.finish("done", {
      totalTargets: scanResult.totalCount,
      translatedCount: translationStats.translatedCount,
      cacheHitCount: translationStats.cacheHitCount,
      fastPathCount: translationStats.fastPathCount,
      completedBatchCount: translationStats.completedBatchCount,
      totalBatchCount: translationStats.totalBatchCount,
      retryCount: translationStats.retryCount,
      warningCount: plan.warnings.length,
    });
    return summarizeNameTranslationPlan(plan);
  } catch (error) {
    progress.finish(isPlanningCancelledError(error) ? "cancelled" : "failed");
    throw error;
  }
}

function createPlanningProgressReporter(
  callback: CreateNameTranslationPlanDeps["progress"],
  now: () => number
): PlanningProgressReporter {
  const startedAt = now();
  let phaseStartedAt = startedAt;
  const metrics: NameTranslationPlanningMetrics = {};

  const emitProgress = (
    phase: NameTranslationPlanningPhase,
    progress: Omit<NameTranslationPlanningProgress, "phase" | "metrics"> = {}
  ) => {
    if (!callback) return;
    try {
      callback({
        phase,
        ...progress,
        metrics: {
          ...metrics,
          totalPlanningDurationMs: Math.max(0, now() - startedAt),
        },
      });
    } catch {
      // Progress observers must not affect plan generation.
    }
  };

  return {
    start: (phase, progress) => {
      phaseStartedAt = now();
      emitProgress(phase, progress);
    },
    emit: emitProgress,
    finish: (phase, progress) => {
      metrics.totalPlanningDurationMs = Math.max(0, now() - startedAt);
      emitProgress(phase, progress);
    },
    completeCurrentPhase: (metricKey) => {
      metrics[metricKey] = Math.max(0, now() - phaseStartedAt);
    },
    setMetrics: (nextMetrics) => {
      Object.assign(metrics, nextMetrics);
    },
  };
}

function throwIfPlanningAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new NameTranslationPlannerError(
    "名称翻译计划生成已取消。",
    "planning_cancelled"
  );
}

function isPlanningCancelledError(error: unknown): boolean {
  return (
    error instanceof NameTranslationPlannerError &&
    error.code === "planning_cancelled"
  );
}

function normalizeTranslationBatchConfig(
  input: Partial<NameTranslationBatchConfig> = {}
): NameTranslationBatchConfig {
  const minBatchSize = Math.max(
    1,
    Math.floor(input.minBatchSize ?? DEFAULT_TRANSLATION_BATCH_CONFIG.minBatchSize)
  );
  const maxBatchSize = Math.max(
    minBatchSize,
    Math.floor(input.maxBatchSize ?? DEFAULT_TRANSLATION_BATCH_CONFIG.maxBatchSize)
  );
  const requestedBatchSize = Math.floor(
    input.batchSize ?? DEFAULT_TRANSLATION_BATCH_CONFIG.batchSize
  );

  return {
    minBatchSize,
    maxBatchSize,
    batchSize: Math.max(
      minBatchSize,
      Math.min(maxBatchSize, requestedBatchSize)
    ),
    concurrency: Math.max(
      1,
      Math.floor(input.concurrency ?? DEFAULT_TRANSLATION_BATCH_CONFIG.concurrency)
    ),
    rateLimitBackoffMs: Math.max(
      0,
      Math.floor(
        input.rateLimitBackoffMs ??
          DEFAULT_TRANSLATION_BATCH_CONFIG.rateLimitBackoffMs
      )
    ),
    adaptiveBatching:
      input.adaptiveBatching ??
      DEFAULT_TRANSLATION_BATCH_CONFIG.adaptiveBatching,
  };
}

function getPathSegmentClarification(
  options: NameTranslationOptions
): ClarificationRequired | undefined {
  if (options.scope !== "path_segments") return undefined;
  if (options.pathSegmentRange?.startPath && options.pathSegmentRange?.endPath) {
    return undefined;
  }

  return {
    code: "path_segment_boundary_required",
    message:
      "需要指定路径翻译的起止层级，例如从哪个文件夹开始，到哪个文件或文件夹结束。",
    choices: [
      "只翻译所选文件或文件夹本身",
      "从某一级文件夹开始翻译路径片段",
      "改为翻译目录直接子项",
    ],
  };
}

function getUnsafePathSegmentClarification(
  options: NameTranslationOptions
): ClarificationRequired | undefined {
  if (options.scope !== "path_segments" || !options.pathSegmentRange) {
    return undefined;
  }
  if (!isRootLikePath(options.pathSegmentRange.startPath)) return undefined;

  return {
    code: "unsafe_path_segment_start",
    message: "路径片段起始层级不能是根目录、Home 根目录或系统保护目录。",
  };
}

function prepareTranslationWork(
  targets: NameTranslationTarget[],
  options: NameTranslationOptions,
  translationCache: NameTranslationCache,
  now: () => number,
  signal?: AbortSignal
): PreparedTranslationWork {
  const translationMap = new Map<string, NameTranslationModelOutputItem>();
  const workItems: TranslationWorkItem[] = [];
  const workItemsByKey = new Map<string, TranslationWorkItem>();
  let translatableCount = 0;
  let resolvedCount = 0;
  let cacheHitCount = 0;
  let fastPathCount = 0;

  translationCache.clearExpired(now());

  for (let index = 0; index < targets.length; index++) {
    if (index % 200 === 0) throwIfPlanningAborted(signal);
    const target = targets[index];
    if (target.skipped) continue;
    translatableCount += 1;

    const fastPathOutput = getNameTranslationFastPath(target, options);
    if (fastPathOutput) {
      translationMap.set(target.id, fastPathOutput);
      fastPathCount += 1;
      resolvedCount += 1;
      continue;
    }

    const key = createNameTranslationCacheKey(target, options);
    const cached = translationCache.get(key);
    if (cached) {
      translationMap.set(
        target.id,
        createNameTranslationOutputFromCache(target.id, cached)
      );
      cacheHitCount += 1;
      resolvedCount += 1;
      continue;
    }

    const existingWorkItem = workItemsByKey.get(key);
    if (existingWorkItem) {
      existingWorkItem.targetIds.push(target.id);
      continue;
    }

    const workItem: TranslationWorkItem = {
      key,
      modelInput: toModelInputItem(target),
      targetIds: [target.id],
    };
    workItems.push(workItem);
    workItemsByKey.set(key, workItem);
  }

  throwIfPlanningAborted(signal);
  return {
    translationMap,
    workItems,
    translatableCount,
    resolvedCount,
    cacheHitCount,
    fastPathCount,
  };
}

async function translateTargets(
  preparedWork: PreparedTranslationWork,
  options: NameTranslationOptions,
  translateBatch: NonNullable<CreateNameTranslationPlanDeps["translateBatch"]>,
  warnings: string[],
  translationCache: NameTranslationCache,
  now: () => number,
  signal?: AbortSignal,
  batchConfig: NameTranslationBatchConfig = DEFAULT_TRANSLATION_BATCH_CONFIG,
  observer?: TranslationObserver
): Promise<Map<string, NameTranslationModelOutputItem>> {
  const translationMap = new Map(preparedWork.translationMap);
  const batches = createTranslationBatches(
    preparedWork.workItems,
    batchConfig
  );
  if (batches.length === 0) {
    observer?.onProgress?.({ ...observer.stats });
    return translationMap;
  }

  let nextBatchIndex = 0;
  let activeBatchCount = 0;
  let completedBatchCount = 0;
  let concurrencyLimit = batchConfig.concurrency;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const pump = () => {
      if (settled) return;
      try {
        throwIfPlanningAborted(signal);
      } catch (error) {
        fail(error);
        return;
      }

      if (completedBatchCount >= batches.length) {
        settled = true;
        resolve();
        return;
      }

      while (
        activeBatchCount < concurrencyLimit &&
        nextBatchIndex < batches.length
      ) {
        const batch = batches[nextBatchIndex++];
        activeBatchCount += 1;
        updateActiveTranslationStats(observer, activeBatchCount);

        runTranslationBatch(
          batch,
          options,
          translateBatch,
          warnings,
          translationMap,
          translationCache,
          now,
          {
            observer,
            batchConfig,
            signal,
            onRateLimit: () => {
              concurrencyLimit = 1;
            },
          }
        )
          .then(() => {
            activeBatchCount -= 1;
            completedBatchCount += 1;
            if (observer) {
              observer.stats.completedBatchCount = completedBatchCount;
              observer.stats.activeBatchCount = activeBatchCount;
              observer.onProgress?.({ ...observer.stats });
            }
            pump();
          })
          .catch((error) => {
            activeBatchCount -= 1;
            updateActiveTranslationStats(observer, activeBatchCount);
            fail(error);
          });
      }
    };

    pump();
  });

  throwIfPlanningAborted(signal);
  return translationMap;
}

async function runTranslationBatch(
  batch: TranslationBatch,
  options: NameTranslationOptions,
  translateBatch: NonNullable<CreateNameTranslationPlanDeps["translateBatch"]>,
  warnings: string[],
  translationMap: Map<string, NameTranslationModelOutputItem>,
  translationCache: NameTranslationCache,
  now: () => number,
  recoveryContext: TranslationRecoveryContext
): Promise<void> {
  throwIfPlanningAborted(recoveryContext.signal);
  const batchInput = batch.workItems.map((workItem) => workItem.modelInput);
  const workItemsByInputId = new Map(
    batch.workItems.map((workItem) => [workItem.modelInput.id, workItem])
  );
  const seenOutputIds = new Set<string>();
  const outputs = await translateBatchWithRecovery(
    batchInput,
    options,
    translateBatch,
    warnings,
    recoveryContext
  );
  throwIfPlanningAborted(recoveryContext.signal);

  for (const output of outputs) {
    const workItem = workItemsByInputId.get(output.id);
    if (!workItem) {
      pushTranslationWarning(warnings, `unknown_model_output:${output.id}`);
      continue;
    }
    if (seenOutputIds.has(output.id)) {
      pushTranslationWarning(warnings, `duplicate_model_output:${output.id}`);
      continue;
    }
    seenOutputIds.add(output.id);

    translationCache.set({
      key: workItem.key,
      translatedStem: output.translatedStem,
      confidence: output.confidence,
      note: output.note,
      createdAt: now(),
    });

    for (const targetId of workItem.targetIds) {
      translationMap.set(targetId, {
        ...output,
        id: targetId,
      });
    }

    const observer = recoveryContext.observer;
    if (observer) {
      observer.stats.translatedCount = Math.min(
        observer.stats.translatableCount,
        observer.stats.translatedCount + workItem.targetIds.length
      );
    }
  }
}

function updateActiveTranslationStats(
  observer: TranslationObserver | undefined,
  activeBatchCount: number
): void {
  if (!observer) return;
  observer.stats.activeBatchCount = activeBatchCount;
  observer.stats.concurrencyPeak = Math.max(
    observer.stats.concurrencyPeak,
    activeBatchCount
  );
  observer.onProgress?.({ ...observer.stats });
}

function createTranslationBatches(
  workItems: TranslationWorkItem[],
  batchConfig: NameTranslationBatchConfig
): TranslationBatch[] {
  if (workItems.length === 0) return [];

  const configuredBatchCount = Math.ceil(
    workItems.length / batchConfig.batchSize
  );
  const adaptiveBatchCount = Math.min(
    batchConfig.concurrency,
    workItems.length
  );
  const shouldBalanceAcrossWorkers =
    batchConfig.adaptiveBatching &&
    batchConfig.concurrency > 1 &&
    workItems.length >= DEFAULT_ADAPTIVE_BATCHING_THRESHOLD &&
    configuredBatchCount <= batchConfig.concurrency;

  if (shouldBalanceAcrossWorkers) {
    return createBalancedTranslationBatches(
      workItems,
      adaptiveBatchCount
    );
  }

  const batches: TranslationBatch[] = [];
  for (
    let start = 0;
    start < workItems.length;
    start += batchConfig.batchSize
  ) {
    batches.push({
      workItems: workItems.slice(start, start + batchConfig.batchSize),
    });
  }
  return batches;
}

function createBalancedTranslationBatches(
  workItems: TranslationWorkItem[],
  batchCount: number
): TranslationBatch[] {
  const normalizedBatchCount = Math.max(
    1,
    Math.min(batchCount, workItems.length)
  );
  const baseBatchSize = Math.floor(
    workItems.length / normalizedBatchCount
  );
  const largerBatchCount = workItems.length % normalizedBatchCount;
  const batches: TranslationBatch[] = [];
  let start = 0;

  for (let index = 0; index < normalizedBatchCount; index++) {
    const size = baseBatchSize + (index < largerBatchCount ? 1 : 0);
    batches.push({
      workItems: workItems.slice(start, start + size),
    });
    start += size;
  }

  return batches;
}

async function translateBatchWithRecovery(
  items: NameTranslationModelInputItem[],
  options: NameTranslationOptions,
  translateBatch: NonNullable<CreateNameTranslationPlanDeps["translateBatch"]>,
  warnings: string[],
  context: TranslationRecoveryContext,
  rateLimitRetryCount = 0
): Promise<NameTranslationModelOutputItem[]> {
  try {
    throwIfPlanningAborted(context.signal);
    if (context.observer) {
      context.observer.stats.requestCount += 1;
      context.observer.onProgress?.({ ...context.observer.stats });
    }
    return await translateBatch(items, options);
  } catch (error) {
    if (error instanceof NameTranslationPlannerError) {
      throw error;
    }

    const message = formatModelError(error);
    pushTranslationWarning(warnings, `model_batch_failed:${items.length}:${message}`);
    const category = classifyModelError(message);

    if (category === "rate_limit") {
      if (rateLimitRetryCount >= MAX_RATE_LIMIT_RETRIES) {
        throw new NameTranslationPlannerError(
          `名称翻译模型限流重试后仍失败：${message}`,
          "model_request_failed"
        );
      }
      context.onRateLimit?.();
      if (context.observer) {
        context.observer.stats.retryCount += 1;
        context.observer.onProgress?.({ ...context.observer.stats });
      }
      pushTranslationWarning(
        warnings,
        `model_rate_limit_backoff:${items.length}:${context.batchConfig.rateLimitBackoffMs}ms`
      );
      await waitForTranslationRetry(
        context.batchConfig.rateLimitBackoffMs,
        context.signal
      );
      return translateBatchWithRecovery(
        items,
        options,
        translateBatch,
        warnings,
        context,
        rateLimitRetryCount + 1
      );
    }

    if (category === "non_recoverable") {
      throw new NameTranslationPlannerError(
        `名称翻译模型调用失败：${message}`,
        "model_request_failed"
      );
    }

    if (items.length <= 1) {
      return [];
    }

    const midpoint = Math.ceil(items.length / 2);
    if (context.observer) {
      context.observer.stats.retryCount += 1;
      context.observer.onProgress?.({ ...context.observer.stats });
    }
    pushTranslationWarning(
      warnings,
      `model_batch_retry_split:${items.length}:${midpoint}+${items.length - midpoint}`
    );
    throwIfPlanningAborted(context.signal);

    const left = await translateBatchWithRecovery(
      items.slice(0, midpoint),
      options,
      translateBatch,
      warnings,
      context
    );
    throwIfPlanningAborted(context.signal);
    const right = await translateBatchWithRecovery(
      items.slice(midpoint),
      options,
      translateBatch,
      warnings,
      context
    );

    return [...left, ...right];
  }
}

function createPlanItem(
  target: NameTranslationTarget,
  options: NameTranslationOptions,
  translationMap: Map<string, NameTranslationModelOutputItem>,
  warnings: string[]
): NameTranslationPlanItem {
  if (target.skipped) {
    return {
      id: createPlanItemId(target.id),
      targetId: target.id,
      kind: target.kind,
      sourcePath: target.absolutePath,
      sourceParentPath: target.parentPath,
      originalName: target.originalName,
      translatedStem: target.stem,
      newName: target.originalName,
      targetPath: target.absolutePath,
      status: "skipped",
      reason: target.skipReason ?? "skipped_by_scanner",
      warnings: target.skipReason ? [target.skipReason] : [],
    };
  }

  const translation = translationMap.get(target.id);
  if (!translation) {
    return {
      id: createPlanItemId(target.id),
      targetId: target.id,
      kind: target.kind,
      sourcePath: target.absolutePath,
      sourceParentPath: target.parentPath,
      originalName: target.originalName,
      translatedStem: target.stem,
      newName: target.originalName,
      targetPath: target.absolutePath,
      status: "blocked",
      reason: "missing_translation",
      warnings: ["missing_translation"],
    };
  }

  const sanitized = sanitizeTranslatedName(
    target,
    translation.translatedStem,
    options
  );
  const itemWarnings = [...sanitized.warnings];
  if (translation.note) itemWarnings.push(`model_note:${translation.note}`);

  if (!sanitized.valid) {
    return {
      id: createPlanItemId(target.id),
      targetId: target.id,
      kind: target.kind,
      sourcePath: target.absolutePath,
      sourceParentPath: target.parentPath,
      originalName: target.originalName,
      translatedStem: sanitized.translatedStem,
      newName: sanitized.newName,
      targetPath: target.absolutePath,
      status: "blocked",
      reason: sanitized.reason ?? "invalid_name",
      warnings: itemWarnings,
    };
  }

  if (warnings.length > MAX_TRANSLATION_WARNINGS) {
    warnings.splice(MAX_TRANSLATION_WARNINGS);
  }

  return {
    id: createPlanItemId(target.id),
    targetId: target.id,
    kind: target.kind,
    sourcePath: target.absolutePath,
    sourceParentPath: target.parentPath,
    originalName: target.originalName,
    translatedStem: sanitized.translatedStem,
    newName: sanitized.newName,
    targetPath: joinPath(target.parentPath, sanitized.newName),
    status: "ready",
    warnings: itemWarnings,
  };
}

async function collectExistingTargetPaths(
  items: NameTranslationPlanItem[],
  checkPathExists: NonNullable<CreateNameTranslationPlanDeps["checkPathExists"]>,
  stats?: PathCheckStats,
  checkPathsExist?: NonNullable<CreateNameTranslationPlanDeps["checkPathsExist"]>,
  warnings?: string[]
): Promise<string[]> {
  const pathsToCheck = new Map<string, string>();

  for (const item of items) {
    if (item.status === "blocked" || item.status === "skipped") continue;
    if (item.sourcePath === item.targetPath) continue;
    pathsToCheck.set(item.targetPath, item.targetPath);
  }
  const targetPaths = [...pathsToCheck.values()];
  if (targetPaths.length === 0) {
    if (stats) stats.requestCount = 0;
    return [];
  }

  if (checkPathsExist) {
    if (stats) stats.requestCount += 1;
    try {
      const batchResult = await checkPathsExist(targetPaths);
      for (const [errorPath, errorMessage] of batchResult.errorPaths) {
        warnings?.push(`路径检查失败 (${errorMessage}): ${errorPath}`);
      }
      return [...batchResult.existingPaths].filter((targetPath) =>
        pathsToCheck.has(targetPath)
      );
    } catch {
      // Older renderer/main pairs may not have the batch IPC yet.
    }
  }

  const existingPaths: string[] = [];
  let checkErrorCount = 0;
  if (stats) stats.requestCount += targetPaths.length;
  await Promise.all(
    targetPaths.map(async (targetPath) => {
      try {
        if (await checkPathExists(targetPath)) existingPaths.push(targetPath);
      } catch {
        checkErrorCount += 1;
      }
    })
  );

  if (checkErrorCount > 0) {
    warnings?.push(
      `路径存在性检查部分失败 (${checkErrorCount}/${targetPaths.length})，冲突检测可能不完整`
    );
  }

  return existingPaths;
}

async function translateBatchWithTaskModel(
  items: NameTranslationModelInputItem[],
  options: NameTranslationOptions
): Promise<NameTranslationModelOutputItem[]> {
  const taskProfile = await getTaskProfile();
  if (!taskProfile?.apiKey || !taskProfile.modelKey || !taskProfile.baseUrl) {
    throw new NameTranslationPlannerError(
      "未配置任务执行模型，请在设置页面配置。",
      "missing_task_model"
    );
  }

  const model = createModel(taskProfile);
  const system = buildNameTranslationSystemPrompt(options);
  const prompt = buildNameTranslationUserPrompt(items);
  const maxOutputTokens = getModelOutputTokenBudget(items);

  try {
    const result = await generateObject({
      model,
      schema: modelOutputSchema,
      schemaName: "name_translation_result",
      schemaDescription:
        "Filename and folder basename translations keyed by the original input id.",
      system,
      prompt,
      temperature: 0.2,
      maxOutputTokens,
      maxRetries: 2,
      experimental_repairText: async ({ text }) =>
        repairNameTranslationModelJsonText(text),
    });

    return result.object.items;
  } catch (structuredError) {
    const structuredMessage = formatModelError(structuredError);
    if (classifyModelError(structuredMessage) !== "recoverable") {
      throw structuredError;
    }

    try {
      const result = await generateText({
        model,
        system: [
          system,
          "Return raw JSON only. The response must begin with { and end with }.",
        ].join("\n"),
        prompt,
        temperature: 0.2,
        maxOutputTokens,
        maxRetries: 2,
      });

      return parseNameTranslationModelOutputText(result.text);
    } catch (fallbackError) {
      throw new Error(
        `structured_output_failed:${formatModelError(structuredError)}; text_fallback_failed:${formatModelError(fallbackError)}`
      );
    }
  }
}

export function repairNameTranslationModelJsonText(text: string): string | null {
  const normalized = normalizeModelOutputText(text);
  const direct = coerceJsonCandidate(normalized);
  if (direct) return direct;

  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fencedCandidate = coerceJsonCandidate(fenced[1].trim());
    if (fencedCandidate) return fencedCandidate;
  }

  const objectCandidate = extractFirstBalancedJson(normalized, "{", "}");
  if (objectCandidate) {
    const repairedObject = coerceJsonCandidate(objectCandidate);
    if (repairedObject) return repairedObject;
  }

  const arrayCandidate = extractFirstBalancedJson(normalized, "[", "]");
  if (arrayCandidate) {
    const repairedArray = coerceJsonCandidate(arrayCandidate);
    if (repairedArray) return repairedArray;
  }

  return null;
}

export function parseNameTranslationModelOutputText(
  text: string
): NameTranslationModelOutputItem[] {
  const repaired = repairNameTranslationModelJsonText(text);
  if (!repaired) {
    throw new Error(`response_not_json:${createTextPreview(text)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(repaired);
  } catch (error) {
    throw new Error(`json_parse_failed:${formatModelError(error)}`);
  }

  const validation = modelOutputSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(`schema_validation_failed:${validation.error.message}`);
  }

  return validation.data.items;
}

function getModelOutputTokenBudget(
  items: NameTranslationModelInputItem[]
): number {
  const estimated = items.reduce((total, item) => {
    const stemBudget = Math.max(80, Math.ceil(item.stem.length * 1.8));
    return total + stemBudget;
  }, 512);

  return Math.max(2048, Math.min(4096, estimated));
}

function normalizeModelOutputText(text: string): string {
  let normalized = text.replace(/^\uFEFF/, "").trim();
  normalized = normalized.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const unclosedThinkEnd = normalized.toLowerCase().lastIndexOf("</think>");
  if (unclosedThinkEnd >= 0) {
    normalized = normalized.slice(unclosedThinkEnd + "</think>".length).trim();
  }

  const fullFence = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fullFence?.[1]) {
    normalized = fullFence[1].trim();
  }

  return normalized;
}

function coerceJsonCandidate(candidate: string): string | null {
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) {
      return JSON.stringify({ items: parsed });
    }
    return candidate;
  } catch {
    return null;
  }
}

function extractFirstBalancedJson(
  text: string,
  openChar: "{" | "[",
  closeChar: "}" | "]"
): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (start < 0) {
      if (char === openChar) {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function classifyModelError(message: string): ModelErrorCategory {
  const isNonRecoverable = [
    /401|403|unauthorized|forbidden|invalid api key/i,
    /insufficient_quota|quota exceeded|billing/i,
    /404|model .*not found|model_not_found/i,
    /ENOTFOUND|ECONNREFUSED|network|fetch failed/i,
  ].some((pattern) => pattern.test(message));
  if (isNonRecoverable) return "non_recoverable";

  if (/429|rate limit|too many requests/i.test(message)) {
    return "rate_limit";
  }

  return "recoverable";
}

function waitForTranslationRetry(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfPlanningAborted(signal);
  if (delayMs <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(
        new NameTranslationPlannerError(
          "名称翻译计划生成已取消。",
          "planning_cancelled"
        )
      );
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function formatModelError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? ` cause=${error.cause.message}`
        : error.cause
          ? ` cause=${String(error.cause)}`
          : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

function createTextPreview(value: unknown, maxLength = 240): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength)}...`
    : compact;
}

function pushTranslationWarning(warnings: string[], warning: string): void {
  if (warnings.length >= MAX_TRANSLATION_WARNINGS) return;
  warnings.push(warning);
}

async function getTaskProfile(): Promise<ModelProfile | null> {
  const module = await import("@/store/useModelStore");
  return module.default.getState().getTaskProfile();
}

function createModel(profile: ModelProfile) {
  const baseURL = profile.baseUrl.replace(/\/chat\/completions\/?$/, "");
  const provider = createOpenAICompatible({
    baseURL,
    apiKey: profile.apiKey,
    name: "fusionkit-name-translation",
  });
  return provider(profile.modelKey);
}

function toModelInputItem(
  target: NameTranslationTarget
): NameTranslationModelInputItem {
  return {
    id: target.id,
    kind: target.kind,
    originalName: target.originalName,
    stem: target.stem,
    extension: target.extension,
    contextPath: target.parentPath,
  };
}

function buildPlan(params: {
  planId: string;
  createdAt: number;
  previewLimit: number;
  options: NameTranslationOptions;
  items: NameTranslationPlanItem[];
  warnings: string[];
  clarificationRequired?: ClarificationRequired;
  totalTargets?: number;
}): NameTranslationPlan {
  const readyCount = params.items.filter((item) => item.status === "ready").length;
  const blockedCount = params.items.filter(
    (item) => item.status === "blocked"
  ).length;
  const skippedCount = params.items.filter(
    (item) => item.status === "skipped"
  ).length;
  const unchangedCount = params.items.filter(
    (item) => item.status === "unchanged"
  ).length;
  const totalTargets = params.totalTargets ?? params.items.length;

  return {
    planId: params.planId,
    createdAt: params.createdAt,
    expiresAt: createPlanExpiry(params.createdAt),
    options: params.options,
    roots: params.options.roots,
    totalTargets,
    previewLimit: params.previewLimit,
    items: params.items,
    itemsPreview: params.items.slice(0, params.previewLimit),
    itemsStored: params.items.length > params.previewLimit,
    readyCount,
    blockedCount,
    skippedCount,
    unchangedCount,
    warnings: dedupeWarnings(params.warnings),
    clarificationRequired: params.clarificationRequired,
    applyable:
      !params.clarificationRequired &&
      readyCount > 0 &&
      blockedCount === 0 &&
      params.items.length > 0,
  };
}

function createPlanId(): string {
  return `rename_plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function createPlanItemId(targetId: string): string {
  return `rename_item_${targetId.replace(/^rename_target_/, "")}`;
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)].slice(0, 200);
}
