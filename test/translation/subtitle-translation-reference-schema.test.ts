import { describe, expect, it } from "vitest";
import {
  parseSubtitleTranslationTaskReference,
  subtitleTranslationTaskReferenceSchema,
} from "@/type/subtitleTranslationIpc";

describe("subtitle translation task reference schema", () => {
  it("accepts strict path-free authorized file references", () => {
    const reference = {
      kind: "authorized_task_v1",
      source: {
        kind: "authorized_file",
        token: "subtitle-translation-source-token",
        displayName: "selected.srt",
      },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-token",
        displayLabel: "Subtitles",
      },
    };
    expect(parseSubtitleTranslationTaskReference(reference)).toEqual(reference);
    expect(subtitleTranslationTaskReferenceSchema.safeParse({
      ...reference,
      source: { ...reference.source, path: "/private/selected.srt" },
    }).success).toBe(false);
  });

  it("accepts strict path-free generated references", () => {
    const reference = {
      kind: "generated_task_v1",
      source: {
        kind: "generated_content",
        displayName: "generated.srt",
      },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-token",
        displayLabel: "Subtitles",
      },
    };
    expect(parseSubtitleTranslationTaskReference(reference)).toEqual(reference);
  });

  it("rejects generated references carrying raw paths or mixed legacy fields", () => {
    const generated = {
      kind: "generated_task_v1",
      source: {
        kind: "generated_content",
        displayName: "generated.srt",
        path: "/private/generated.srt",
      },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-token",
        displayLabel: "Subtitles",
      },
    };
    expect(subtitleTranslationTaskReferenceSchema.safeParse(generated).success)
      .toBe(false);
    expect(subtitleTranslationTaskReferenceSchema.safeParse({
      ...generated,
      source: { kind: "generated_content", displayName: "generated.srt" },
      targetDirectoryPath: "/private/output",
    }).success).toBe(false);
  });

  it("rejects the retired legacy path discriminant", () => {
    const legacy = {
      kind: "legacy_path_v1",
      originFilePath: "/legacy/input.srt",
      targetDirectoryPath: "/legacy/output",
    };
    expect(parseSubtitleTranslationTaskReference(legacy)).toBeUndefined();
    expect(subtitleTranslationTaskReferenceSchema.safeParse({
      ...legacy,
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-token",
        displayLabel: "Subtitles",
      },
    }).success).toBe(false);
    expect(parseSubtitleTranslationTaskReference({
      ...legacy,
      kind: "generated_task_v1",
    })).toBeUndefined();
    expect(parseSubtitleTranslationTaskReference({
      ...legacy,
      originFilePath: "",
      checkpointPath: "/legacy/task.fusionkit.resume.json",
    })).toBeUndefined();
  });
});
