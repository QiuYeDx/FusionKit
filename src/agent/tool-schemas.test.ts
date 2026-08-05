import { describe, expect, it } from "vitest";
import {
  applyNameTranslationPlanSchema,
  createNameTranslationPlanSchema,
  inspectRenamePathsSchema,
  queueRecoveredSubtitleTranslateSchema,
  queueTranslateSchema,
  scanSubtitleRecoveryTasksSchema,
} from "./tool-schemas";

describe("queue translate schema", () => {
  it("accepts custom translation slice length", () => {
    const parsed = queueTranslateSchema.parse({
      sliceType: "CUSTOM",
      customSliceLength: 1200,
    });

    expect(parsed.sliceType).toBe("CUSTOM");
    expect(parsed.customSliceLength).toBe(1200);
  });

  it("keeps queue defaults when custom slicing is not requested", () => {
    const parsed = queueTranslateSchema.parse({});

    expect(parsed.sliceType).toBe("NORMAL");
    expect(parsed.customSliceLength).toBeUndefined();
  });

  it.each([
    { filePaths: ["/private/input.srt"] },
    { scanId: "scan_abc" },
    { outputDir: "/private/output", outputMode: "custom" },
  ])("rejects renderer path authority: %o", (legacyAuthority) => {
    expect(() => queueTranslateSchema.parse(legacyAuthority)).toThrow();
  });
});

describe("subtitle recovery schemas", () => {
  it("accepts only fixed-picker scan intent and opaque scan queueing", () => {
    expect(scanSubtitleRecoveryTasksSchema.parse({ selectionMode: "manifest" }))
      .toMatchObject({ selectionMode: "manifest" });
    expect(queueRecoveredSubtitleTranslateSchema.parse({
      recoveryScanId: "recovery-scan-one",
    })).toMatchObject({ recoveryScanId: "recovery-scan-one" });
  });

  it.each([
    { roots: ["/private/recovery"] },
    { checkpointPaths: ["/private/task.fusionkit.resume.json"] },
    { useCurrentOutputDir: true },
  ])("rejects raw recovery authority: %o", (legacyAuthority) => {
    expect(() => scanSubtitleRecoveryTasksSchema.parse(legacyAuthority))
      .toThrow();
  });

  it("rejects checkpoint paths when queueing recovered tasks", () => {
    expect(() => queueRecoveredSubtitleTranslateSchema.parse({
      recoveryScanId: "recovery-scan-one",
      checkpointPaths: ["/private/task.fusionkit.resume.json"],
    })).toThrow();
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
    expect(parsed.outputMode).toBe("target_only");
    expect(parsed.bilingualSeparator).toBe(" - ");
  });

  it("accepts bilingual output mode settings", () => {
    const parsed = createNameTranslationPlanSchema.parse({
      roots: ["/tmp/日剧"],
      outputMode: "bilingual_target_first",
      bilingualSeparator: "_",
    });

    expect(parsed.outputMode).toBe("bilingual_target_first");
    expect(parsed.bilingualSeparator).toBe("_");
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
