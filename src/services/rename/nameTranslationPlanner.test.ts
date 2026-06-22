import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNameTranslationPlan,
  parseNameTranslationModelOutputText,
  repairNameTranslationModelJsonText,
} from "./nameTranslationPlanner";
import {
  clearAllNameTranslationPlansForTest,
  getNameTranslationPlan,
} from "./namePlanStore";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  NameTranslationPlannerError,
  type NameTranslationOptions,
  type NameTranslationModelInputItem,
  type NameTranslationPlanningProgress,
  type NameTranslationTarget,
  type ScanRenameTargetsResult,
} from "./nameTypes";
import {
  clearDefaultNameTranslationCacheForTest,
  MemoryNameTranslationCache,
} from "./nameTranslationCache";

afterEach(() => {
  clearAllNameTranslationPlansForTest();
  clearDefaultNameTranslationCacheForTest();
});

describe("createNameTranslationPlan", () => {
  it("creates a dry-run plan, preserves extensions, and stores full items", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
    ];

    const summary = await createNameTranslationPlan(createOptions(), {
      planIdFactory: () => "rename_plan_test",
      previewLimit: 1,
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) =>
        items.map((item, index) => ({
          id: item.id,
          translatedStem: `Episode ${index + 1}`,
        })),
      checkPathExists: async () => false,
      now: () => Date.now(),
    });

    expect(summary).toMatchObject({
      planId: "rename_plan_test",
      totalTargets: 2,
      previewLimit: 1,
      readyCount: 2,
      blockedCount: 0,
      applyable: true,
    });
    expect(summary.itemsPreview).toHaveLength(1);
    expect(summary.itemsPreview[0].newName).toBe("Episode 1.srt");

    const storedPlan = getNameTranslationPlan("rename_plan_test");
    expect(storedPlan?.items).toHaveLength(2);
    expect(storedPlan?.itemsStored).toBe(true);
    expect(storedPlan?.items[1].targetPath).toBe("/tmp/rename/Episode 2.srt");
  });

  it("blocks items missing model output", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
    ];

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async () => [
        { id: "target_a", translatedStem: "Episode 1" },
      ],
      checkPathExists: async () => false,
    });

    expect(summary.readyCount).toBe(1);
    expect(summary.blockedCount).toBe(1);
    expect(summary.applyable).toBe(false);
    expect(summary.itemsPreview[1].reason).toBe("missing_translation");
  });

  it("recovers a failed model batch by splitting it into smaller requests", async () => {
    const targets = [
      createTarget("target_a", "#1【ELDEN RING】はじめてのエルデンリング！！！！！！！【湊あくあ-ホロライブ】.lrc", "#1【ELDEN RING】はじめてのエルデンリング！！！！！！！【湊あくあ-ホロライブ】"),
      createTarget("target_b", "#2【ELDEN RING】エルデの王に私はなる【湊あくあ_ホロライブ】.srt", "#2【ELDEN RING】エルデの王に私はなる【湊あくあ_ホロライブ】"),
    ];
    const calls: string[][] = [];

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) => {
        calls.push(items.map((item) => item.id));
        if (items.length > 1) {
          throw new Error("No object generated: could not parse the response.");
        }
        return items.map((item) => ({
          id: item.id,
          translatedStem:
            item.id === "target_a"
              ? "#1【ELDEN RING】첫 엘든 링！！！！！！！【미나토 아쿠아-홀로라이브】"
              : "#2【ELDEN RING】엘데의 왕이 되겠다【미나토 아쿠아_홀로라이브】",
        }));
      },
      checkPathExists: async () => false,
    });

    expect(calls).toEqual([["target_a", "target_b"], ["target_a"], ["target_b"]]);
    expect(summary.readyCount).toBe(2);
    expect(summary.blockedCount).toBe(0);
    expect(summary.warnings).toContain(
      "model_batch_failed:2:No object generated: could not parse the response."
    );
    expect(summary.itemsPreview[0].newName).toContain(".lrc");
    expect(summary.itemsPreview[1].newName).toContain(".srt");
  });

  it("emits planning progress with phase metrics", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
    ];
    const progressEvents: NameTranslationPlanningProgress[] = [];
    let timestamp = 1_000;

    const summary = await createNameTranslationPlan(createOptions(), {
      planIdFactory: () => "rename_plan_progress_test",
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) =>
        items.map((item, index) => ({
          id: item.id,
          translatedStem: `Episode ${index + 1}`,
        })),
      checkPathExists: async () => false,
      progress: (progress) => progressEvents.push(progress),
      now: () => {
        timestamp += 5;
        return timestamp;
      },
    });

    expect(summary.readyCount).toBe(2);
    expect(progressEvents[0]?.phase).toBe("scanning");
    expect(progressEvents.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        "scanning",
        "translating",
        "checking_targets",
        "validating",
        "storing",
        "done",
      ])
    );
    expect(progressEvents.at(-1)?.phase).toBe("done");
    expect(
      progressEvents.some(
        (event) =>
          event.phase === "translating" && event.completedBatchCount === 1
      )
    ).toBe(true);

    const done = progressEvents.at(-1)!;
    expect(done.totalTargets).toBe(2);
    expect(done.translatedCount).toBe(2);
    expect(done.metrics).toMatchObject({
      translationRequestCount: 1,
      translationBatchCount: 1,
      translationConcurrencyPeak: 1,
      translationCacheHitCount: 0,
      translationFastPathCount: 0,
      pathCheckRequestCount: 2,
    });
    expect(done.metrics?.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(done.metrics?.classifyingDurationMs).toBeGreaterThanOrEqual(0);
    expect(done.metrics?.translationDurationMs).toBeGreaterThanOrEqual(0);
    expect(done.metrics?.pathCheckDurationMs).toBeGreaterThanOrEqual(0);
    expect(done.metrics?.planBuildDurationMs).toBeGreaterThanOrEqual(0);
    expect(done.metrics?.totalPlanningDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("dedupes duplicate translation keys and fans out model output", async () => {
    const targets = [
      createTarget("target_a", "月光.srt", "月光"),
      createTarget("target_b", "月光.ass", "月光"),
    ];
    const translateBatch = vi.fn(async (items: NameTranslationModelInputItem[]) =>
      items.map((item) => ({
        id: item.id,
        translatedStem: "Moonlight",
      }))
    );

    const summary = await createNameTranslationPlan(createOptions(), {
      planIdFactory: () => "rename_plan_dedupe",
      scanTargets: async () => createScanResult(targets),
      translateBatch,
      checkPathExists: async () => false,
    });

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0]?.[0].map((item) => item.id)).toEqual([
      "target_a",
    ]);
    expect(summary.readyCount).toBe(2);

    const storedPlan = getNameTranslationPlan("rename_plan_dedupe");
    expect(storedPlan?.items.map((item) => item.newName)).toEqual([
      "Moonlight.srt",
      "Moonlight.ass",
    ]);
  });

  it("uses fast path outputs without calling the model", async () => {
    const targets = [createTarget("target_a", "S01E02.mkv", "S01E02")];
    const translateBatch = vi.fn(async () => {
      throw new Error("model should not be called");
    });

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch,
      checkPathExists: async () => false,
    });

    expect(translateBatch).not.toHaveBeenCalled();
    expect(summary.unchangedCount).toBe(1);
    expect(summary.itemsPreview[0].warnings).toContain(
      "model_note:fast_path:episode_code"
    );
  });

  it("reuses cached translated stems when output mode changes", async () => {
    const targets = [createTarget("target_a", "第01話.srt", "第01話")];
    const translationCache = new MemoryNameTranslationCache();
    const translateBatch = vi.fn(async (items: NameTranslationModelInputItem[]) =>
      items.map((item) => ({
        id: item.id,
        translatedStem: "Episode 1",
      }))
    );

    await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch,
      checkPathExists: async () => false,
      translationCache,
    });

    const bilingualSummary = await createNameTranslationPlan(
      createOptions({
        outputMode: "bilingual_target_first",
        bilingualSeparator: " + ",
      }),
      {
        scanTargets: async () => createScanResult(targets),
        translateBatch,
        checkPathExists: async () => false,
        translationCache,
      }
    );

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(bilingualSummary.itemsPreview[0].newName).toBe(
      "Episode 1 + 第01話.srt"
    );
  });

  it("uses batch target path checks when available", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
    ];
    const progressEvents: NameTranslationPlanningProgress[] = [];
    const checkPathsExist = vi.fn(async (paths: string[]) => ({
      existingPaths: new Set([paths[1]]),
      errorPaths: new Map<string, string>(),
    }));
    const checkPathExists = vi.fn(async () => {
      throw new Error("single-path fallback should not run");
    });

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) =>
        items.map((item, index) => ({
          id: item.id,
          translatedStem: `Episode ${index + 1}`,
        })),
      checkPathsExist,
      checkPathExists,
      progress: (progress) => progressEvents.push(progress),
    });

    expect(checkPathsExist).toHaveBeenCalledTimes(1);
    expect(checkPathsExist).toHaveBeenCalledWith([
      "/tmp/rename/Episode 1.srt",
      "/tmp/rename/Episode 2.srt",
    ]);
    expect(checkPathExists).not.toHaveBeenCalled();
    expect(summary.readyCount).toBe(1);
    expect(summary.blockedCount).toBe(1);
    expect(summary.itemsPreview[1].reason).toBe("target_exists");
    expect(progressEvents.at(-1)?.metrics?.pathCheckRequestCount).toBe(1);
  });

  it("surfaces batch path-check errors as plan warnings", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
      createTarget("target_c", "第03話.srt", "第03話"),
    ];
    const checkPathsExist = vi.fn(async (paths: string[]) => ({
      existingPaths: new Set([paths[0]]),
      errorPaths: new Map<string, string>([
        [paths[1], "EACCES: permission denied"],
      ]),
    }));

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) =>
        items.map((item, index) => ({
          id: item.id,
          translatedStem: `Episode ${index + 1}`,
        })),
      checkPathsExist,
      checkPathExists: async () => false,
    });

    expect(checkPathsExist).toHaveBeenCalledTimes(1);
    expect(summary.warnings).toContainEqual(
      expect.stringContaining("EACCES: permission denied")
    );
    expect(summary.warnings).toContainEqual(
      expect.stringContaining("/tmp/rename/Episode 2.srt")
    );
    expect(summary.readyCount).toBe(2);
    expect(summary.blockedCount).toBe(1);
    expect(summary.itemsPreview[0].reason).toBe("target_exists");
  });

  it("falls back to single-path checks when batch target path checks fail", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
    ];
    const progressEvents: NameTranslationPlanningProgress[] = [];
    const checkPathsExist = vi.fn(async () => {
      throw new Error("batch IPC unavailable");
    });
    const checkPathExists = vi.fn(async (targetPath: string) =>
      targetPath.endsWith("Episode 2.srt")
    );

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) =>
        items.map((item, index) => ({
          id: item.id,
          translatedStem: `Episode ${index + 1}`,
        })),
      checkPathsExist,
      checkPathExists,
      progress: (progress) => progressEvents.push(progress),
    });

    expect(checkPathsExist).toHaveBeenCalledTimes(1);
    expect(checkPathExists).toHaveBeenCalledTimes(2);
    expect(summary.itemsPreview[1].reason).toBe("target_exists");
    expect(progressEvents.at(-1)?.metrics?.pathCheckRequestCount).toBe(3);
  });

  it("warns when all single-path fallback checks fail", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
      createTarget("target_c", "第03話.srt", "第03話"),
    ];
    const checkPathsExist = vi.fn(async () => {
      throw new Error("batch IPC unavailable");
    });
    const checkPathExists = vi.fn(async () => {
      throw new Error("EACCES: permission denied");
    });

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) =>
        items.map((item, index) => ({
          id: item.id,
          translatedStem: `Episode ${index + 1}`,
        })),
      checkPathsExist,
      checkPathExists,
    });

    expect(checkPathsExist).toHaveBeenCalledTimes(1);
    expect(checkPathExists).toHaveBeenCalledTimes(3);
    expect(summary.readyCount).toBe(3);
    expect(summary.warnings).toContainEqual(
      expect.stringMatching(/路径存在性检查部分失败 \(3\/3\)/)
    );
    expect(summary.warnings).toContainEqual(
      expect.stringContaining("冲突检测可能不完整")
    );
  });

  it("warns when some single-path fallback checks fail", async () => {
    const targets = [
      createTarget("target_a", "第01話.srt", "第01話"),
      createTarget("target_b", "第02話.srt", "第02話"),
      createTarget("target_c", "第03話.srt", "第03話"),
    ];
    const checkPathsExist = vi.fn(async () => {
      throw new Error("batch IPC unavailable");
    });
    const checkPathExists = vi.fn(async (targetPath: string) => {
      if (targetPath.endsWith("Episode 2.srt")) {
        throw new Error("EACCES: permission denied");
      }
      return false;
    });

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) =>
        items.map((item, index) => ({
          id: item.id,
          translatedStem: `Episode ${index + 1}`,
        })),
      checkPathsExist,
      checkPathExists,
    });

    expect(checkPathsExist).toHaveBeenCalledTimes(1);
    expect(checkPathExists).toHaveBeenCalledTimes(3);
    expect(summary.readyCount).toBe(3);
    expect(summary.warnings).toContainEqual(
      expect.stringMatching(/路径存在性检查部分失败 \(1\/3\)/)
    );
  });

  it("runs translation batches with bounded concurrency", async () => {
    const targets = Array.from({ length: 10 }, (_, index) =>
      createTarget(
        `target_${index}`,
        `第${String(index + 1).padStart(2, "0")}話.srt`,
        `第${String(index + 1).padStart(2, "0")}話`
      )
    );
    const progressEvents: NameTranslationPlanningProgress[] = [];
    let activeRequestCount = 0;
    let maxActiveRequestCount = 0;
    const translateBatch = vi.fn(async (items: NameTranslationModelInputItem[]) => {
      activeRequestCount += 1;
      maxActiveRequestCount = Math.max(maxActiveRequestCount, activeRequestCount);
      await Promise.resolve();
      activeRequestCount -= 1;
      return items.map((item) => ({
        id: item.id,
        translatedStem: `Episode ${item.id.replace("target_", "")}`,
      }));
    });

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch,
      checkPathExists: async () => false,
      progress: (progress) => progressEvents.push(progress),
      batchConfig: {
        batchSize: 1,
        minBatchSize: 1,
        concurrency: 3,
      },
    });

    expect(summary.readyCount).toBe(10);
    expect(translateBatch).toHaveBeenCalledTimes(10);
    expect(maxActiveRequestCount).toBeGreaterThan(1);
    expect(maxActiveRequestCount).toBeLessThanOrEqual(3);
    expect(progressEvents.at(-1)?.metrics).toMatchObject({
      translationBatchCount: 10,
      translationConcurrencyPeak: 3,
    });
  });

  it("backs off and retries rate-limited batches", async () => {
    const targets = [
      createTarget("target_a", "第一章.srt", "第一章"),
      createTarget("target_b", "第二章.srt", "第二章"),
      createTarget("target_c", "第三章.srt", "第三章"),
    ];
    const progressEvents: NameTranslationPlanningProgress[] = [];
    const calls: string[] = [];
    let rateLimitThrown = false;

    const summary = await createNameTranslationPlan(createOptions(), {
      scanTargets: async () => createScanResult(targets),
      translateBatch: async (items) => {
        calls.push(items[0].id);
        if (items[0].id === "target_a" && !rateLimitThrown) {
          rateLimitThrown = true;
          throw new Error("429 rate limit");
        }
        return items.map((item) => ({
          id: item.id,
          translatedStem: `${item.stem} translated`,
        }));
      },
      checkPathExists: async () => false,
      progress: (progress) => progressEvents.push(progress),
      batchConfig: {
        batchSize: 1,
        minBatchSize: 1,
        concurrency: 2,
        rateLimitBackoffMs: 0,
      },
    });

    expect(summary.readyCount).toBe(3);
    expect(calls.filter((id) => id === "target_a")).toHaveLength(2);
    expect(summary.warnings).toContain("model_rate_limit_backoff:1:0ms");
    expect(progressEvents.at(-1)?.retryCount).toBe(1);
  });

  it("fails fast for non-recoverable model errors without splitting batches", async () => {
    const targets = [
      createTarget("target_a", "第一章.srt", "第一章"),
      createTarget("target_b", "第二章.srt", "第二章"),
    ];
    const calls: string[][] = [];

    await expect(
      createNameTranslationPlan(createOptions(), {
        scanTargets: async () => createScanResult(targets),
        translateBatch: async (items) => {
          calls.push(items.map((item) => item.id));
          throw new Error("401 unauthorized");
        },
        checkPathExists: async () => false,
      })
    ).rejects.toMatchObject({
      code: "model_request_failed",
    });

    expect(calls).toEqual([["target_a", "target_b"]]);
  });

  it("stops launching batches and skips storing when aborted between batches", async () => {
    const targets = [
      createTarget("target_a", "第一章.srt", "第一章"),
      createTarget("target_b", "第二章.srt", "第二章"),
      createTarget("target_c", "第三章.srt", "第三章"),
    ];
    const controller = new AbortController();
    const progressEvents: NameTranslationPlanningProgress[] = [];
    const translateBatch = vi.fn(async (items: NameTranslationModelInputItem[]) => {
      controller.abort();
      return items.map((item) => ({
        id: item.id,
        translatedStem: `${item.stem} translated`,
      }));
    });

    await expect(
      createNameTranslationPlan(createOptions(), {
        planIdFactory: () => "rename_plan_abort_between_batches",
        scanTargets: async () => createScanResult(targets),
        translateBatch,
        checkPathExists: async () => false,
        progress: (progress) => progressEvents.push(progress),
        signal: controller.signal,
        batchConfig: {
          batchSize: 1,
          minBatchSize: 1,
          concurrency: 1,
        },
      })
    ).rejects.toMatchObject({
      code: "planning_cancelled",
    });

    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(progressEvents.at(-1)?.phase).toBe("cancelled");
    expect(getNameTranslationPlan("rename_plan_abort_between_batches")).toBeNull();
  });

  it("emits failed progress while preserving planner errors", async () => {
    const targets = [createTarget("target_a", "第01話.srt", "第01話")];
    const progressEvents: NameTranslationPlanningProgress[] = [];

    await expect(
      createNameTranslationPlan(createOptions(), {
        scanTargets: async () => createScanResult(targets),
        translateBatch: async () => {
          throw new NameTranslationPlannerError(
            "未配置任务执行模型，请在设置页面配置。",
            "missing_task_model"
          );
        },
        checkPathExists: async () => false,
        progress: (progress) => progressEvents.push(progress),
      })
    ).rejects.toMatchObject({
      code: "missing_task_model",
      message: "未配置任务执行模型，请在设置页面配置。",
    });

    expect(progressEvents.map((event) => event.phase)).toContain("translating");
    expect(progressEvents.at(-1)?.phase).toBe("failed");
    expect(getNameTranslationPlan("rename_plan_progress_failed")).toBeNull();
  });

  it("emits cancelled progress and skips storing when aborted", async () => {
    const targets = [createTarget("target_a", "第01話.srt", "第01話")];
    const progressEvents: NameTranslationPlanningProgress[] = [];
    const controller = new AbortController();
    controller.abort();

    await expect(
      createNameTranslationPlan(createOptions(), {
        planIdFactory: () => "rename_plan_cancelled",
        scanTargets: async () => createScanResult(targets),
        translateBatch: async (items) =>
          items.map((item) => ({
            id: item.id,
            translatedStem: "Episode 1",
          })),
        checkPathExists: async () => false,
        progress: (progress) => progressEvents.push(progress),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      code: "planning_cancelled",
    });

    expect(progressEvents.at(-1)?.phase).toBe("cancelled");
    expect(getNameTranslationPlan("rename_plan_cancelled")).toBeNull();
  });

  it("repairs fenced or reasoning-wrapped model JSON output", () => {
    const raw = [
      "<think>I should only return JSON.</think>",
      "```json",
      "{\"items\":[{\"id\":\"target_a\",\"translatedStem\":\"첫 엘든 링\"}]}",
      "```",
    ].join("\n");

    expect(repairNameTranslationModelJsonText(raw)).toBe(
      "{\"items\":[{\"id\":\"target_a\",\"translatedStem\":\"첫 엘든 링\"}]}"
    );
    expect(parseNameTranslationModelOutputText(raw)).toEqual([
      { id: "target_a", translatedStem: "첫 엘든 링" },
    ]);
  });

  it("returns clarification for path_segments without explicit boundaries", async () => {
    const summary = await createNameTranslationPlan(
      createOptions({
        scope: "path_segments",
        targetKind: "both",
      }),
      {
        scanTargets: async () => {
          throw new Error("scan should not run");
        },
      }
    );

    expect(summary.applyable).toBe(false);
    expect(summary.clarificationRequired?.code).toBe(
      "path_segment_boundary_required"
    );
  });

  it("keeps explicit path_segments non-applyable until path-level ordering is implemented", async () => {
    const summary = await createNameTranslationPlan(
      createOptions({
        scope: "path_segments",
        targetKind: "both",
        pathSegmentRange: {
          startPath: "/tmp/rename/第一季",
          endPath: "/tmp/rename/第一季/第01話.srt",
          includeEndFileName: true,
        },
      }),
      {
        scanTargets: async () => {
          throw new Error("scan should not run");
        },
      }
    );

    expect(summary.applyable).toBe(false);
    expect(summary.clarificationRequired?.code).toBe("path_segments_deferred");
    expect(summary.warnings[0]).toContain("path_segments planning");
  });

  it("blocks unsafe path segment start paths", async () => {
    const summary = await createNameTranslationPlan(
      createOptions({
        scope: "path_segments",
        targetKind: "both",
        pathSegmentRange: {
          startPath: "/",
          endPath: "/tmp/rename/第01話.srt",
          includeEndFileName: true,
        },
      }),
      {
        scanTargets: async () => {
          throw new Error("scan should not run");
        },
      }
    );

    expect(summary.applyable).toBe(false);
    expect(summary.clarificationRequired?.code).toBe(
      "unsafe_path_segment_start"
    );
  });

  it("surfaces missing task model errors clearly", async () => {
    const targets = [createTarget("target_a", "第01話.srt", "第01話")];

    await expect(
      createNameTranslationPlan(createOptions(), {
        scanTargets: async () => createScanResult(targets),
        translateBatch: async () => {
          throw new NameTranslationPlannerError(
            "未配置任务执行模型，请在设置页面配置。",
            "missing_task_model"
          );
        },
        checkPathExists: async () => false,
      })
    ).rejects.toMatchObject({
      code: "missing_task_model",
      message: "未配置任务执行模型，请在设置页面配置。",
    });
  });
});

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

function createTarget(
  id: string,
  originalName: string,
  stem: string
): NameTranslationTarget {
  const dotIndex = originalName.lastIndexOf(".");
  const extension = dotIndex > 0 ? originalName.slice(dotIndex) : "";
  return {
    id,
    kind: "file",
    absolutePath: `/tmp/rename/${originalName}`,
    parentPath: "/tmp/rename",
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
