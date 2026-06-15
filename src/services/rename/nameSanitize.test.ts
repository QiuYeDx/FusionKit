import { describe, expect, it } from "vitest";
import { sanitizeTranslatedName } from "./nameSanitize";
import {
  DEFAULT_NAME_TRANSLATION_OPTIONS,
  type NameTranslationOptions,
  type NameTranslationTarget,
} from "./nameTypes";

describe("sanitizeTranslatedName", () => {
  it("replaces invalid characters and preserves the original extension", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "第01話.srt", stem: "第01話", extension: ".srt" }),
      "Episode: 01/Opening?",
      createOptions()
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("Episode 01 Opening.srt");
    expect(result.warnings).toContain("invalid_chars_sanitized");
  });

  it("adjusts Windows reserved names", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "aux.txt", stem: "aux", extension: ".txt" }),
      "CON",
      createOptions()
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("CON_name.txt");
    expect(result.warnings).toContain("windows_reserved_name_adjusted");
  });

  it("blocks empty translated names", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "a.srt", stem: "a", extension: ".srt" }),
      " / : ",
      createOptions()
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("empty_name");
  });

  it("produces bilingual name with target first", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "第01話.srt", stem: "第01話", extension: ".srt" }),
      "Episode 1",
      createOptions({ outputMode: "bilingual_target_first", bilingualSeparator: " - " })
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("Episode 1 - 第01話.srt");
    expect(result.translatedStem).toBe("Episode 1");
  });

  it("produces bilingual name with original first", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "第01話.srt", stem: "第01話", extension: ".srt" }),
      "Episode 1",
      createOptions({ outputMode: "bilingual_original_first", bilingualSeparator: " - " })
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("第01話 - Episode 1.srt");
    expect(result.translatedStem).toBe("Episode 1");
  });

  it("uses custom separator in bilingual mode", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "日本語.txt", stem: "日本語", extension: ".txt" }),
      "Japanese",
      createOptions({ outputMode: "bilingual_target_first", bilingualSeparator: "_" })
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("Japanese_日本語.txt");
  });

  it("sanitizes illegal characters from separator", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "名前.srt", stem: "名前", extension: ".srt" }),
      "Name",
      createOptions({ outputMode: "bilingual_target_first", bilingualSeparator: " / " })
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("Name 名前.srt");
  });

  it("falls back to default separator when sanitized separator is empty", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "名前.srt", stem: "名前", extension: ".srt" }),
      "Name",
      createOptions({ outputMode: "bilingual_target_first", bilingualSeparator: "/*?" })
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("Name - 名前.srt");
  });

  it("target_only mode preserves existing behavior", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "第01話.srt", stem: "第01話", extension: ".srt" }),
      "Episode 1",
      createOptions({ outputMode: "target_only" })
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("Episode 1.srt");
  });

  it("handles directories in bilingual mode (no extension)", () => {
    const result = sanitizeTranslatedName(
      createTarget({ originalName: "ドラマ", stem: "ドラマ", extension: "", kind: "directory" }),
      "Drama",
      createOptions({ outputMode: "bilingual_original_first", bilingualSeparator: " - " })
    );

    expect(result.valid).toBe(true);
    expect(result.newName).toBe("ドラマ - Drama");
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

function createTarget(
  overrides: Partial<NameTranslationTarget>
): NameTranslationTarget {
  return {
    id: "target_1",
    kind: "file",
    absolutePath: "/tmp/rename/第01話.srt",
    parentPath: "/tmp/rename",
    originalName: "第01話.srt",
    stem: "第01話",
    extension: ".srt",
    depthFromRoot: 0,
    anchorRoot: "/tmp/rename/第01話.srt",
    ...overrides,
  };
}
