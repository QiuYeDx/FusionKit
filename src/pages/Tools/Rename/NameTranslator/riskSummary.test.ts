import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationPlan,
  type NameTranslationPlanItem,
} from "@/services/rename/nameTypes";
import { getRenameWarningDetails, getRiskSummary } from "./riskSummary";

describe("rename risk summary warning details", () => {
  it("keeps plan and ready-item warning details aligned with the risk count", () => {
    const plan = createPlan({
      warnings: [
        "model_batch_failed:22:structured_output_failed:No object generated",
        "model_batch_retry_split:22:11+11",
      ],
      items: [
        createItem({
          id: "ready-file",
          originalName: "Episode 01.srt",
          newName: "第 01 集.srt",
          warnings: ["invalid_chars_sanitized"],
        }),
        createItem({
          id: "ready-directory",
          kind: "directory",
          originalName: "Season 01",
          newName: "第 01 季",
          warnings: ["case_only"],
        }),
        createItem({
          id: "blocked-file",
          status: "blocked",
          warnings: ["target_exists"],
        }),
      ],
    });

    const details = getRenameWarningDetails(plan);
    const risk = getRiskSummary(plan);

    expect(details).toHaveLength(4);
    expect(details.slice(0, 2)).toEqual([
      {
        source: "plan",
        message:
          "model_batch_failed:22:structured_output_failed:No object generated",
      },
      { source: "plan", message: "model_batch_retry_split:22:11+11" },
    ]);
    expect(details[2]).toMatchObject({
      source: "item",
      itemId: "ready-file",
      itemKind: "file",
      itemName: "Episode 01.srt → 第 01 集.srt",
      message: "invalid_chars_sanitized",
    });
    expect(details.some((detail) => detail.message === "target_exists")).toBe(
      false
    );
    expect(risk.warningCount).toBe(details.length);
    expect(risk.warningDetails).toEqual(details);
    expect(risk.reasons).toEqual(["directories", "warnings"]);
  });

  it("returns an empty non-risk summary without a plan", () => {
    expect(getRiskSummary(null)).toEqual({
      hasRisk: false,
      reasons: [],
      readyCount: 0,
      fileCount: 0,
      directoryCount: 0,
      warningCount: 0,
      warningDetails: [],
    });
  });
});

function createPlan(
  patch: Partial<NameTranslationPlan> = {}
): NameTranslationPlan {
  const items = patch.items ?? [createItem()];
  return {
    planId: "rename-plan-warning-details",
    createdAt: 1,
    expiresAt: 2,
    options: {
      ...DEFAULT_NAME_TRANSLATION_OPTIONS,
      roots: ["C:/rename"],
    },
    roots: ["C:/rename"],
    totalTargets: items.length,
    previewLimit: 200,
    items,
    itemsPreview: items,
    itemsStored: true,
    readyCount: items.filter((item) => item.status === "ready").length,
    blockedCount: items.filter((item) => item.status === "blocked").length,
    skippedCount: 0,
    unchangedCount: 0,
    warnings: [],
    applyable: true,
    ...patch,
  };
}

function createItem(
  patch: Partial<NameTranslationPlanItem> = {}
): NameTranslationPlanItem {
  return {
    id: "ready-item",
    targetId: "target-ready-item",
    kind: "file",
    sourcePath: "C:/rename/Episode 01.srt",
    sourceParentPath: "C:/rename",
    originalName: "Episode 01.srt",
    translatedStem: "第 01 集",
    newName: "第 01 集.srt",
    targetPath: "C:/rename/第 01 集.srt",
    status: "ready",
    warnings: [],
    ...patch,
  };
}
