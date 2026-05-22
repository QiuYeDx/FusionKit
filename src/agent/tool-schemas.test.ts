import { describe, expect, it } from "vitest";
import {
  applyNameTranslationPlanSchema,
  createNameTranslationPlanSchema,
  inspectRenamePathsSchema,
  queueTranslateSchema,
} from "./tool-schemas";

describe("queue translate schema", () => {
  it("accepts custom translation slice length", () => {
    const parsed = queueTranslateSchema.parse({
      scanId: "scan_abc",
      sliceType: "CUSTOM",
      customSliceLength: 1200,
    });

    expect(parsed.sliceType).toBe("CUSTOM");
    expect(parsed.customSliceLength).toBe(1200);
  });

  it("keeps queue defaults when custom slicing is not requested", () => {
    const parsed = queueTranslateSchema.parse({
      scanId: "scan_abc",
    });

    expect(parsed.sliceType).toBe("NORMAL");
    expect(parsed.customSliceLength).toBeUndefined();
  });
});

describe("name translation tool schemas", () => {
  it("accepts path inspection input", () => {
    const parsed = inspectRenamePathsSchema.parse({
      paths: ["/tmp/日剧"],
    });

    expect(parsed.paths).toEqual(["/tmp/日剧"]);
  });

  it("uses conservative dry-run plan defaults", () => {
    const parsed = createNameTranslationPlanSchema.parse({
      roots: ["/tmp/日剧/episode 01.srt"],
    });

    expect(parsed.scope).toBe("self");
    expect(parsed.targetKind).toBe("files");
    expect(parsed.recursive).toBe(false);
    expect(parsed.includeHidden).toBe(false);
    expect(parsed.collisionPolicy).toBe("fail");
    expect(parsed.targetLang).toBe("ZH");
  });

  it("keeps explicit recursive descendant settings", () => {
    const parsed = createNameTranslationPlanSchema.parse({
      roots: ["/tmp/日剧"],
      scope: "descendants",
      targetKind: "files",
      recursive: true,
      maxDepth: 6,
      targetLang: "EN",
      collisionPolicy: "append_index",
    });

    expect(parsed.scope).toBe("descendants");
    expect(parsed.recursive).toBe(true);
    expect(parsed.maxDepth).toBe(6);
    expect(parsed.targetLang).toBe("EN");
    expect(parsed.collisionPolicy).toBe("append_index");
  });

  it("requires a plan id before apply", () => {
    const parsed = applyNameTranslationPlanSchema.parse({
      planId: "rename_plan_abc",
    });

    expect(parsed.planId).toBe("rename_plan_abc");
  });
});
