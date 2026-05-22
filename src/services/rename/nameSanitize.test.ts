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
