import { describe, expect, it } from "vitest";
import { parseTxtTranslationUnits } from "../../../electron/main/text-translation/parsing/text-parser";
import { planTranslationSegments } from "../../../electron/main/text-translation/planning/segment-planner";

const countCharacters = (text: string) => text.length;

describe("TXT parser and segment planner", () => {
  it("parses headings and paragraphs with stable source offsets", () => {
    const text = [
      "Chapter 1",
      "",
      "First paragraph line one.",
      "line two stays inside the same paragraph.",
      "",
      "第二章",
      "",
      "另一个自然段。",
    ].join("\n");

    const units = parseTxtTranslationUnits({
      fileId: "file_001",
      text,
      maxUnitTokens: 200,
      countTokens: countCharacters,
    });

    expect(units.map((unit) => [unit.kind, unit.sourceText])).toEqual([
      ["heading", "Chapter 1"],
      [
        "paragraph",
        "First paragraph line one.\nline two stays inside the same paragraph.",
      ],
      ["heading", "第二章"],
      ["paragraph", "另一个自然段。"],
    ]);

    for (const unit of units) {
      expect(text.slice(unit.sourceStart, unit.sourceEnd)).toBe(unit.sourceText);
      expect(unit.unitId).toMatch(/^file_001_u_\d{6}$/);
    }
  });

  it("splits oversized paragraphs at preferred punctuation before hard cuts", () => {
    const text = "Alpha sentence. Beta sentence. GammaWithoutBoundary";
    const units = parseTxtTranslationUnits({
      fileId: "file_001",
      text,
      maxUnitTokens: 16,
      countTokens: countCharacters,
    });

    expect(units.length).toBeGreaterThan(1);
    expect(units[0].sourceText).toBe("Alpha sentence.");
    expect(units[0].structuralContext).toMatchObject({
      splitPartIndex: 0,
      splitPartCount: units.length,
      hardCut: false,
    });
    expect(units.some((unit) => unit.structuralContext?.hardCut)).toBe(true);
    expect(units.every((unit) => unit.tokenCount <= 16)).toBe(true);
  });

  it("plans stable ordered segments without exceeding the token budget", () => {
    const text = ["A short paragraph.", "", "B short paragraph.", "", "C"].join(
      "\n",
    );
    const units = parseTxtTranslationUnits({
      fileId: "file_001",
      text,
      maxUnitTokens: 100,
      countTokens: countCharacters,
    });

    const segments = planTranslationSegments({
      fileId: "file_001",
      units,
      sliceTokenLimit: 20,
      startingGlobalIndex: 5,
      countTokens: countCharacters,
    });

    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.segmentId)).toEqual([
      "file_001_s_000000",
      "file_001_s_000001",
      "file_001_s_000002",
    ]);
    expect(segments.map((segment) => segment.globalIndex)).toEqual([5, 6, 7]);
    expect(
      segments.every((segment) => segment.sourceTokenCount <= 20),
    ).toBe(true);
    expect(segments[0].sourceTextSnapshotPath).toBe(
      "segments/source/00000005.txt",
    );
  });

  it("marks segment boundaries that start or end inside a split natural unit", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const units = parseTxtTranslationUnits({
      fileId: "file_001",
      text,
      maxUnitTokens: 18,
      countTokens: countCharacters,
    });

    const segments = planTranslationSegments({
      fileId: "file_001",
      units,
      sliceTokenLimit: 18,
      countTokens: countCharacters,
    });

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0].startsMidUnit).toBe(false);
    expect(segments[0].endsMidUnit).toBe(true);
    expect(segments[1].startsMidUnit).toBe(true);
  });

  it("is deterministic for the same normalized input and options", () => {
    const text = "One.\n\nTwo.\n\nThree.";
    const options = {
      fileId: "file_001",
      text,
      maxUnitTokens: 10,
      countTokens: countCharacters,
    };

    const firstUnits = parseTxtTranslationUnits(options);
    const secondUnits = parseTxtTranslationUnits(options);

    expect(secondUnits).toEqual(firstUnits);
    expect(
      planTranslationSegments({
        fileId: "file_001",
        units: secondUnits,
        sliceTokenLimit: 12,
        countTokens: countCharacters,
      }),
    ).toEqual(
      planTranslationSegments({
        fileId: "file_001",
        units: firstUnits,
        sliceTokenLimit: 12,
        countTokens: countCharacters,
      }),
    );
  });
});
