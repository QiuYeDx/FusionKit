import { describe, expect, it } from "vitest";
import { getNameTranslationFastPath } from "./nameTranslationFastPath";
import type {
  NameTranslationOptions,
  NameTranslationTarget,
} from "./nameTypes";
import { DEFAULT_NAME_TRANSLATION_OPTIONS } from "./nameTypes";

function createTarget(stem: string): NameTranslationTarget {
  return {
    id: `target_${stem || "empty"}`,
    kind: "file",
    absolutePath: `/test/${stem}.txt`,
    parentPath: "/test",
    originalName: `${stem}.txt`,
    stem,
    extension: ".txt",
    depthFromRoot: 0,
    anchorRoot: "/test",
  };
}

function createOptions(
  overrides?: Partial<NameTranslationOptions>
): NameTranslationOptions {
  return {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    roots: ["/test"],
    ...overrides,
  };
}

function expectFastPath(
  stem: string,
  reason: string,
  options?: Partial<NameTranslationOptions>
) {
  const result = getNameTranslationFastPath(
    createTarget(stem),
    createOptions(options)
  );
  expect(result).not.toBeNull();
  expect(result!.translatedStem).toBe(stem);
  expect(result!.confidence).toBe("high");
  expect(result!.note).toBe(`fast_path:${reason}`);
}

function expectNoFastPath(
  stem: string,
  options?: Partial<NameTranslationOptions>
) {
  const result = getNameTranslationFastPath(
    createTarget(stem),
    createOptions(options)
  );
  expect(result).toBeNull();
}

describe("getNameTranslationFastPath", () => {
  describe("empty", () => {
    it.each(["", "  ", " \t "])("returns fast_path:empty for %j", (stem) => {
      expectFastPath(stem, "empty");
    });
  });

  describe("no_natural_language (symbol-only)", () => {
    it.each(["---", "()", "★☆", "・", "——", "【】", "···", "♪♫"])(
      "returns fast_path:no_natural_language for %j",
      (stem) => {
        expectFastPath(stem, "no_natural_language");
      }
    );

    it.each(["hello", "你好", "a", "café"])(
      "does NOT fast-path %j (contains letters)",
      (stem) => {
        expectNoFastPath(stem);
      }
    );

    it("digits are caught by numeric, not no_natural_language", () => {
      expectFastPath("1", "numeric");
    });
  });

  describe("numeric", () => {
    it.each(["001", "42", "0", "999", "1.2.3", "1-2-3", "1_2_3"])(
      "returns fast_path:numeric for %j",
      (stem) => {
        expectFastPath(stem, "numeric");
      }
    );

    it.each([
      "2024-01-01",
      "2024_06",
      "2024",
      "1999",
      "2024.12.31",
      "1899-01-01",
      "2100",
    ])(
      "date-like %j is caught by numeric (NUMERIC_PATTERN matches before DATE_PATTERN)",
      (stem) => {
        expectFastPath(stem, "numeric");
      }
    );

    it.each(["1a", "v1.0", "1.2.3a", "12 34"])(
      "does NOT fast-path %j as numeric",
      (stem) => {
        expectNoFastPath(stem);
      }
    );
  });

  describe("date (subsumed by numeric)", () => {
    it("DATE_PATTERN is unreachable because all matching strings are caught by NUMERIC_PATTERN first", () => {
      const dateLikeStrings = [
        "2024",
        "2024-01",
        "2024-01-01",
        "2024_06",
        "2024.12.31",
      ];
      for (const stem of dateLikeStrings) {
        expectFastPath(stem, "numeric");
      }
    });

    it.each(["2024abc", "20-abc"])(
      "%j does not match numeric or date → no fast-path",
      (stem) => {
        expectNoFastPath(stem);
      }
    );
  });

  describe("episode_code", () => {
    it.each([
      "S01E02",
      "s1e1",
      "S100E1000",
      "Episode.12",
      "episode-5",
      "Episode_100",
      "ep_001",
      "EP.3",
      "ep100",
      "Season.1",
      "season3",
      "SEASON_10",
    ])("returns fast_path:episode_code for %j", (stem) => {
      expectFastPath(stem, "episode_code");
    });

    it.each(["Season One", "Episode Name", "S01", "E02", "ep", "episode"])(
      "does NOT fast-path %j as episode_code",
      (stem) => {
        expectNoFastPath(stem);
      }
    );
  });

  describe("technical_only", () => {
    it.each([
      "1080p",
      "x264.AAC",
      "h264",
      "HDR",
      "FLAC",
      "AV1",
      "webrip",
      "BluRay",
      "remux",
      "DVDRip",
    ])(
      "returns fast_path:technical_only for %j when preserveTechnicalTokens=true",
      (stem) => {
        expectFastPath(stem, "technical_only", {
          preserveTechnicalTokens: true,
        });
      }
    );

    it.each(["Movie 1080p", "1080p intro", "best.x264.release"])(
      "does NOT fast-path %j (contains non-technical tokens)",
      (stem) => {
        expectNoFastPath(stem, { preserveTechnicalTokens: true });
      }
    );

    it("does NOT fast-path technical tokens when preserveTechnicalTokens=false", () => {
      expectNoFastPath("1080p", { preserveTechnicalTokens: false });
      expectNoFastPath("x264.AAC", { preserveTechnicalTokens: false });
    });
  });

  describe("priority order", () => {
    it("empty takes precedence over all other checks", () => {
      expectFastPath("", "empty");
      expectFastPath("  ", "empty");
    });

    it("symbol-only is checked before numeric", () => {
      expectFastPath("---", "no_natural_language");
    });

    it("numeric is checked before date", () => {
      expectFastPath("2024-01-01", "numeric");
    });

    it("numeric is checked before episode_code (no overlap since episode codes contain letters)", () => {
      expectFastPath("001", "numeric");
      expectFastPath("S01E02", "episode_code");
    });
  });

  describe("return value structure", () => {
    it("returns correct id and translatedStem equal to original stem", () => {
      const target = createTarget("001");
      const result = getNameTranslationFastPath(target, createOptions());
      expect(result).toMatchObject({
        id: target.id,
        translatedStem: "001",
        confidence: "high",
      });
    });

    it("returns null for stems requiring translation", () => {
      expect(
        getNameTranslationFastPath(createTarget("第01話"), createOptions())
      ).toBeNull();
    });

    it("returns null for natural language stems", () => {
      expect(
        getNameTranslationFastPath(
          createTarget("My Document"),
          createOptions()
        )
      ).toBeNull();
    });
  });
});
