import { describe, expect, it } from "vitest";
import {
  estimateSubtitleTokens,
  estimateSubtitleTokensFast,
} from "@/utils/tokenEstimate";
import { SubtitleSliceType } from "@/type/subtitle";

function makeLrcLines(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const seconds = String(index % 60).padStart(2, "0");
    return `[00:${seconds}.00]あいうえお`;
  }).join("\n");
}

describe("subtitle token estimate", () => {
  it("uses subtitle fragments instead of subtracting prompt overhead from sensitive mode", () => {
    const estimate = estimateSubtitleTokensFast(
      makeLrcLines(60),
      SubtitleSliceType.SENSITIVE,
      undefined,
      undefined,
      undefined,
      {
        fileName: "song.lrc",
        sourceLang: "JA",
        targetLang: "ZH",
        translationOutputMode: "target_only",
      },
    );

    expect(estimate.fragmentCount).toBe(5);
    expect(estimate.inputTokens).toBeLessThan(5000);
  });

  it("counts bilingual output as original plus translated text", () => {
    const content = makeLrcLines(12);
    const targetOnly = estimateSubtitleTokensFast(
      content,
      SubtitleSliceType.SENSITIVE,
      undefined,
      undefined,
      undefined,
      {
        fileName: "song.lrc",
        translationOutputMode: "target_only",
      },
    );
    const bilingual = estimateSubtitleTokensFast(
      content,
      SubtitleSliceType.SENSITIVE,
      undefined,
      undefined,
      undefined,
      {
        fileName: "song.lrc",
        translationOutputMode: "bilingual",
      },
    );

    expect(bilingual.outputTokens).toBeGreaterThan(targetOnly.outputTokens);
  });

  it("keeps precise sensitive estimates in the same order of magnitude as real chunks", async () => {
    const estimate = await estimateSubtitleTokens(
      makeLrcLines(60),
      SubtitleSliceType.SENSITIVE,
      undefined,
      undefined,
      undefined,
      {
        fileName: "song.lrc",
        sourceLang: "JA",
        targetLang: "ZH",
        translationOutputMode: "target_only",
      },
    );

    expect(estimate.fragmentCount).toBeGreaterThan(1);
    expect(estimate.fragmentCount).toBeLessThan(20);
  });
});
