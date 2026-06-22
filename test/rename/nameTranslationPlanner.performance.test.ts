import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNameTranslationPlan,
  type NameTranslationBatchConfig,
} from "../../src/services/rename/nameTranslationPlanner";
import {
  clearAllNameTranslationPlansForTest,
  getNameTranslationPlan,
} from "../../src/services/rename/namePlanStore";
import {
  clearDefaultNameTranslationCacheForTest,
  MemoryNameTranslationCache,
} from "../../src/services/rename/nameTranslationCache";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationModelInputItem,
  type NameTranslationOptions,
  type NameTranslationPlanningProgress,
  type NameTranslationTarget,
  type ScanRenameTargetsResult,
} from "../../src/services/rename/nameTypes";

afterEach(() => {
  clearAllNameTranslationPlansForTest();
  clearDefaultNameTranslationCacheForTest();
  vi.restoreAllMocks();
});

describe("name translation planner performance regressions", () => {
  it("keeps five-item preview latency close to one item with adaptive batches", async () => {
    const single = await runTimedFakeModelPlan({
      planId: "rename_perf_single_item",
      targets: createChineseEpisodeTargets(1),
      delayMs: 25,
      perItemDelayMs: 35,
      batchConfig: {},
    });
    const legacyFive = await runTimedFakeModelPlan({
      planId: "rename_perf_legacy_five_items",
      targets: createChineseEpisodeTargets(5),
      delayMs: 25,
      perItemDelayMs: 35,
      batchConfig: {
        adaptiveBatching: false,
      },
    });
    const adaptiveFive = await runTimedFakeModelPlan({
      planId: "rename_perf_adaptive_five_items",
      targets: createChineseEpisodeTargets(5),
      delayMs: 25,
      perItemDelayMs: 35,
      batchConfig: {},
    });

    expect(single.summary.readyCount).toBe(1);
    expect(legacyFive.summary.readyCount).toBe(5);
    expect(adaptiveFive.summary.readyCount).toBe(5);
    expect(
      single.translateBatch.mock.calls.map(([items]) => items.length)
    ).toEqual([1]);
    expect(
      legacyFive.translateBatch.mock.calls.map(([items]) => items.length)
    ).toEqual([5]);
    expect(
      adaptiveFive.translateBatch.mock.calls.map(([items]) => items.length)
    ).toEqual([2, 2, 1]);
    expect(adaptiveFive.maxActiveRequestCount).toBe(3);

    console.log(
      `[small-batch perf] single=${single.durationMs.toFixed(0)}ms, legacyFive=${legacyFive.durationMs.toFixed(0)}ms, adaptiveFive=${adaptiveFive.durationMs.toFixed(0)}ms`
    );

    expect(adaptiveFive.durationMs).toBeLessThan(legacyFive.durationMs * 0.8);
    expect(adaptiveFive.durationMs).toBeLessThan(single.durationMs * 2.5);
    expect(adaptiveFive.progressEvents.at(-1)?.metrics).toMatchObject({
      translationRequestCount: 3,
      translationBatchCount: 3,
      translationConcurrencyPeak: 3,
    });
  });

  it("keeps 500-target fake model planning faster with bounded concurrency than serial batches", async () => {
    const targets = createChineseEpisodeTargets(500);

    const serial = await runTimedFakeModelPlan({
      planId: "rename_perf_serial",
      targets,
      delayMs: 30,
      batchConfig: {
        batchSize: 50,
        minBatchSize: 1,
        concurrency: 1,
        rateLimitBackoffMs: 0,
      },
    });
    const concurrent = await runTimedFakeModelPlan({
      planId: "rename_perf_concurrent",
      targets,
      delayMs: 30,
      batchConfig: {
        batchSize: 50,
        minBatchSize: 1,
        concurrency: 3,
        rateLimitBackoffMs: 0,
      },
    });

    expect(serial.summary.readyCount).toBe(500);
    expect(concurrent.summary.readyCount).toBe(500);
    expect(serial.translateBatch).toHaveBeenCalledTimes(10);
    expect(concurrent.translateBatch).toHaveBeenCalledTimes(10);
    expect(serial.maxActiveRequestCount).toBe(1);
    expect(concurrent.maxActiveRequestCount).toBeGreaterThan(1);
    expect(concurrent.maxActiveRequestCount).toBeLessThanOrEqual(3);

    console.log(
      `[perf reference] serial=${serial.durationMs.toFixed(0)}ms, concurrent=${concurrent.durationMs.toFixed(0)}ms, ratio=${(concurrent.durationMs / serial.durationMs).toFixed(2)}`
    );

    expect(serial.progressEvents.at(-1)?.metrics).toMatchObject({
      translationRequestCount: 10,
      translationBatchCount: 10,
      translationConcurrencyPeak: 1,
      pathCheckRequestCount: 1,
    });
    expect(concurrent.progressEvents.at(-1)?.metrics).toMatchObject({
      translationRequestCount: 10,
      translationBatchCount: 10,
      translationConcurrencyPeak: 3,
      pathCheckRequestCount: 1,
    });
  });

  it("records cache and fast-path savings on a 500-target rerun without model calls", async () => {
    const translationCache = new MemoryNameTranslationCache();
    const targets = [
      ...Array.from({ length: 250 }, (_, index) =>
        createTarget({
          id: `fast_${index}`,
          originalName: `S01E${String(index + 1).padStart(3, "0")}.mkv`,
          stem: `S01E${String(index + 1).padStart(3, "0")}`,
          parentPath: `/tmp/rename/fast_${index}`,
        })
      ),
      ...Array.from({ length: 250 }, (_, index) => {
        const stemIndex = index % 25;
        return createTarget({
          id: `cached_${index}`,
          originalName: `第${String(stemIndex + 1).padStart(2, "0")}話.srt`,
          stem: `第${String(stemIndex + 1).padStart(2, "0")}話`,
          parentPath: `/tmp/rename/cached_${index}`,
        });
      }),
    ];
    const firstTranslateBatch = vi.fn(
      async (items: NameTranslationModelInputItem[]) =>
        items.map((item) => ({
          id: item.id,
          translatedStem: `Episode ${item.stem.match(/\d+/)?.[0] ?? item.id}`,
        }))
    );

    const firstSummary = await createNameTranslationPlan(createOptions(), {
      planIdFactory: () => "rename_perf_cache_seed",
      scanTargets: async () => createScanResult(targets),
      translateBatch: firstTranslateBatch,
      checkPathsExist: async () => ({ existingPaths: new Set(), errorPaths: new Map() }),
      checkPathExists: async () => false,
      translationCache,
      batchConfig: {
        batchSize: 20,
        minBatchSize: 1,
        concurrency: 3,
      },
    });

    const secondProgressEvents: NameTranslationPlanningProgress[] = [];
    const secondTranslateBatch = vi.fn(async () => {
      throw new Error("cached rerun should not call the model");
    });

    const secondSummary = await createNameTranslationPlan(createOptions(), {
      planIdFactory: () => "rename_perf_cache_rerun",
      scanTargets: async () => createScanResult(targets),
      translateBatch: secondTranslateBatch,
      checkPathsExist: async () => ({ existingPaths: new Set(), errorPaths: new Map() }),
      checkPathExists: async () => false,
      translationCache,
      progress: (progress) => secondProgressEvents.push(progress),
      batchConfig: {
        batchSize: 20,
        minBatchSize: 1,
        concurrency: 3,
      },
    });

    expect(firstSummary.totalTargets).toBe(500);
    expect(secondSummary.totalTargets).toBe(500);
    expect(firstTranslateBatch).toHaveBeenCalledTimes(3);
    expect(
      firstTranslateBatch.mock.calls.map(([items]) => items.length)
    ).toEqual([9, 8, 8]);
    expect(firstTranslateBatch.mock.calls.flatMap(([items]) => items)).toHaveLength(
      25
    );
    expect(secondTranslateBatch).not.toHaveBeenCalled();
    expect(secondProgressEvents.at(-1)?.metrics).toMatchObject({
      translationRequestCount: 0,
      translationBatchCount: 0,
      translationCacheHitCount: 250,
      translationFastPathCount: 250,
      translationConcurrencyPeak: 0,
      pathCheckRequestCount: 1,
    });
  });

  it("stops queued work and skips storing after cancellation in a large plan", async () => {
    const targets = createChineseEpisodeTargets(120);
    const controller = new AbortController();
    const progressEvents: NameTranslationPlanningProgress[] = [];
    const translateBatch = vi.fn(async (items: NameTranslationModelInputItem[]) => {
      controller.abort();
      return items.map((item) => ({
        id: item.id,
        translatedStem: `Episode ${item.id.replace("target_", "")}`,
      }));
    });

    await expect(
      createNameTranslationPlan(createOptions(), {
        planIdFactory: () => "rename_perf_cancelled",
        scanTargets: async () => createScanResult(targets),
        translateBatch,
        checkPathExists: async () => false,
        progress: (progress) => progressEvents.push(progress),
        signal: controller.signal,
        batchConfig: {
          batchSize: 10,
          minBatchSize: 1,
          concurrency: 1,
        },
      })
    ).rejects.toMatchObject({
      code: "planning_cancelled",
    });

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(progressEvents.at(-1)?.phase).toBe("cancelled");
    expect(getNameTranslationPlan("rename_perf_cancelled")).toBeNull();
  });

  it("recovers a large parse-failed batch by splitting into stable smaller requests", async () => {
    const targets = createChineseEpisodeTargets(16);
    const callSizes: number[] = [];
    const progressEvents: NameTranslationPlanningProgress[] = [];

    const summary = await createNameTranslationPlan(createOptions(), {
      planIdFactory: () => "rename_perf_batch_split",
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) => {
        callSizes.push(items.length);
        if (items.length > 4) {
          throw new Error("No object generated: parse failed");
        }
        return items.map((item) => ({
          id: item.id,
          translatedStem: `Episode ${item.id.replace("target_", "")}`,
        }));
      },
      checkPathsExist: async () => ({ existingPaths: new Set(), errorPaths: new Map() }),
      checkPathExists: async () => false,
      progress: (progress) => progressEvents.push(progress),
      batchConfig: {
        batchSize: 16,
        minBatchSize: 1,
        concurrency: 1,
      },
    });

    expect(summary.readyCount).toBe(16);
    expect(callSizes).toEqual([16, 8, 4, 4, 8, 4, 4]);
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        "model_batch_retry_split:16:8+8",
        "model_batch_retry_split:8:4+4",
      ])
    );
    expect(progressEvents.at(-1)?.metrics).toMatchObject({
      translationRequestCount: 7,
      translationBatchCount: 1,
      translationConcurrencyPeak: 1,
    });
    expect(progressEvents.at(-1)?.retryCount).toBe(3);
  });
});

async function runTimedFakeModelPlan({
  planId,
  targets,
  delayMs,
  perItemDelayMs = 0,
  batchConfig,
}: {
  planId: string;
  targets: NameTranslationTarget[];
  delayMs: number;
  perItemDelayMs?: number;
  batchConfig: Partial<NameTranslationBatchConfig>;
}) {
  const progressEvents: NameTranslationPlanningProgress[] = [];
  let activeRequestCount = 0;
  let maxActiveRequestCount = 0;
  const translateBatch = vi.fn(async (items: NameTranslationModelInputItem[]) => {
    activeRequestCount += 1;
    maxActiveRequestCount = Math.max(maxActiveRequestCount, activeRequestCount);
    await delay(delayMs + items.length * perItemDelayMs);
    activeRequestCount -= 1;
    return items.map((item) => ({
      id: item.id,
      translatedStem: `Episode ${item.id.replace("target_", "")}`,
    }));
  });
  const startedAt = performance.now();
  const summary = await createNameTranslationPlan(createOptions(), {
    planIdFactory: () => planId,
    scanTargets: async () => createScanResult(targets),
    translateBatch,
    checkPathsExist: async () => ({ existingPaths: new Set(), errorPaths: new Map() }),
    checkPathExists: async () => false,
    translationCache: new MemoryNameTranslationCache(),
    progress: (progress) => progressEvents.push(progress),
    batchConfig,
  });
  const durationMs = performance.now() - startedAt;

  return {
    durationMs,
    summary,
    translateBatch,
    maxActiveRequestCount,
    progressEvents,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOptions(
  overrides: Partial<NameTranslationOptions> = {}
): NameTranslationOptions {
  return {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    roots: ["/tmp/rename"],
    scope: "children",
    targetKind: "files",
    ...overrides,
  };
}

function createChineseEpisodeTargets(count: number): NameTranslationTarget[] {
  return Array.from({ length: count }, (_, index) =>
    createTarget({
      id: `target_${index}`,
      originalName: `第${String(index + 1).padStart(3, "0")}話.srt`,
      stem: `第${String(index + 1).padStart(3, "0")}話`,
      parentPath: `/tmp/rename/episode_${index}`,
    })
  );
}

function createTarget({
  id,
  originalName,
  stem,
  parentPath,
}: {
  id: string;
  originalName: string;
  stem: string;
  parentPath: string;
}): NameTranslationTarget {
  const dotIndex = originalName.lastIndexOf(".");
  const extension = dotIndex > 0 ? originalName.slice(dotIndex) : "";
  return {
    id,
    kind: "file",
    absolutePath: `${parentPath}/${originalName}`,
    parentPath,
    originalName,
    stem,
    extension,
    depthFromRoot: 1,
    anchorRoot: "/tmp/rename",
  };
}

function createScanResult(
  targets: NameTranslationTarget[]
): ScanRenameTargetsResult {
  return {
    targets,
    totalCount: targets.length,
    truncated: false,
    warnings: [],
  };
}
