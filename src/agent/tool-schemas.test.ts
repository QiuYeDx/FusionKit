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

  it("leaves unrequested settings unset so the translator page's settings apply", () => {
    const parsed = queueTranslateSchema.parse({});

    expect(parsed).toEqual({});
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
    expect(parsed.targetKind).toBe("both");
    expect(parsed.includeRoots).toBe(false);
    // Languages, format and hidden files follow the name translator page when not requested.
    expect(parsed.includeHidden).toBeUndefined();
    expect(parsed.targetLang).toBeUndefined();
    expect(parsed.nameFormat).toBeUndefined();
  });

  it("accepts bilingual name formats and instructions", () => {
    const parsed = createNameTranslationPlanSchema.parse({
      roots: ["/tmp/日剧"],
      nameFormat: "translated_original",
      instructions: "人名保留罗马音",
    });

    expect(parsed.nameFormat).toBe("translated_original");
    expect(parsed.instructions).toBe("人名保留罗马音");
  });

  it("keeps explicit recursive settings and rejects removed scopes", () => {
    const parsed = createNameTranslationPlanSchema.parse({
      roots: ["/tmp/日剧"],
      scope: "descendants",
      targetKind: "files",
      includeRoots: true,
      targetLang: "EN",
    });

    expect(parsed.scope).toBe("descendants");
    expect(parsed.includeRoots).toBe(true);
    expect(parsed.targetLang).toBe("EN");
    expect(() =>
      createNameTranslationPlanSchema.parse({ roots: ["/tmp"], scope: "path_segments" }),
    ).toThrow();
  });

  it("requires a plan id before apply", () => {
    const parsed = applyNameTranslationPlanSchema.parse({
      planId: "rename_plan_abc",
    });

    expect(parsed.planId).toBe("rename_plan_abc");
  });
});
