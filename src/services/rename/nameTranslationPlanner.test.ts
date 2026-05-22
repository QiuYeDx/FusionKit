import { afterEach, describe, expect, it } from "vitest";
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
  type NameTranslationTarget,
  type ScanRenameTargetsResult,
} from "./nameTypes";

afterEach(() => {
  clearAllNameTranslationPlansForTest();
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
