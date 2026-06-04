import { describe, expect, it } from "vitest";
import { validatePlanItems } from "./nameConflict";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationOptions,
  type NameTranslationPlanItem,
} from "./nameTypes";

describe("validatePlanItems", () => {
  it("blocks duplicate targets when collisionPolicy is fail", () => {
    const items = [
      createItem("a", "A.srt", "Episode.srt"),
      createItem("b", "B.srt", "Episode.srt"),
    ];

    const result = validatePlanItems(items, createOptions());

    expect(result.map((item) => item.status)).toEqual(["blocked", "blocked"]);
    expect(result[0].reason).toBe("duplicate_target");
  });

  it("adds stable indexes for duplicate targets when collisionPolicy is append_index", () => {
    const items = [
      createItem("a", "A.srt", "Episode.srt"),
      createItem("b", "B.srt", "Episode.srt"),
    ];

    const result = validatePlanItems(
      items,
      createOptions({ collisionPolicy: "append_index" })
    );

    expect(result.map((item) => item.status)).toEqual(["ready", "ready"]);
    expect(result.map((item) => item.newName)).toEqual([
      "Episode.srt",
      "Episode (1).srt",
    ]);
  });

  it("blocks existing target paths when they are outside the rename batch", () => {
    const items = [createItem("a", "A.srt", "Episode.srt")];

    const result = validatePlanItems(items, createOptions(), {
      existingTargetPaths: ["/tmp/rename/Episode.srt"],
    });

    expect(result[0]).toMatchObject({
      status: "blocked",
      reason: "target_exists",
    });
  });

  it("marks unchanged and case-only renames without blocking them", () => {
    const unchanged = createItem("a", "A.srt", "A.srt");
    const caseOnly = createItem("b", "B.srt", "b.srt");

    const result = validatePlanItems([unchanged, caseOnly], createOptions());

    expect(result[0].status).toBe("unchanged");
    expect(result[1].status).toBe("ready");
    expect(result[1].warnings).toContain("case_only");
  });
});

function createOptions(
  overrides: Partial<NameTranslationOptions> = {}
): NameTranslationOptions {
  return {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    roots: ["/tmp/rename"],
    ...overrides,
  };
}

function createItem(
  id: string,
  originalName: string,
  newName: string
): NameTranslationPlanItem {
  return {
    id,
    targetId: id,
    kind: "file",
    sourcePath: `/tmp/rename/${originalName}`,
    sourceParentPath: "/tmp/rename",
    originalName,
    translatedStem: newName.replace(/\.srt$/, ""),
    newName,
    targetPath: `/tmp/rename/${newName}`,
    status: "ready",
    warnings: [],
  };
}
