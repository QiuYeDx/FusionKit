import { describe, expect, it } from "vitest";
import {
  accumulateSubtitleTranslationUsage,
  normalizeSubtitleTranslationUsage,
  preferMoreCompleteSubtitleTranslationUsage,
} from "../../electron/main/translation/usage";

describe("subtitle translation usage aggregation", () => {
  it("accumulates API-reported tokens, coverage, and frozen-price cost", () => {
    const first = accumulateSubtitleTranslationUsage(
      undefined,
      {
        inputTokens: 1_000_000,
        outputTokens: 250_000,
        totalTokens: 1_300_000,
        reasoningTokens: 50_000,
        cachedInputTokens: 400_000,
      },
      {
        inputTokensPerMillion: 0.44,
        outputTokensPerMillion: 1.32,
      },
    );
    const total = accumulateSubtitleTranslationUsage(
      first,
      {
        inputTokens: 500_000,
        outputTokens: 100_000,
        reasoningTokens: 20_000,
        cachedInputTokens: 100_000,
      },
      {
        inputTokensPerMillion: 0.44,
        outputTokensPerMillion: 1.32,
      },
    );

    expect(total).toMatchObject({
      inputTokens: 1_500_000,
      outputTokens: 350_000,
      totalTokens: 1_900_000,
      reasoningTokens: 70_000,
      cachedInputTokens: 500_000,
      requestCount: 2,
      reportedRequestCount: 2,
    });
    expect(total.calculatedCost).toBeCloseTo(1.122, 12);
  });

  it("marks responses without complete usage as unreported", () => {
    const usage = accumulateSubtitleTranslationUsage(
      undefined,
      { totalTokens: 9 },
      {
        inputTokensPerMillion: 1,
        outputTokensPerMillion: 2,
      },
    );

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 9,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      requestCount: 1,
      reportedRequestCount: 0,
    });
  });

  it("keeps actual tokens without inventing a cost when pricing is absent", () => {
    const usage = accumulateSubtitleTranslationUsage(
      undefined,
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      undefined,
    );

    expect(usage.reportedRequestCount).toBe(1);
    expect(usage).not.toHaveProperty("calculatedCost");
  });

  it("rejects malformed persisted usage", () => {
    expect(normalizeSubtitleTranslationUsage({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      requestCount: 1,
      reportedRequestCount: 2,
    })).toBeUndefined();
    expect(normalizeSubtitleTranslationUsage({
      inputTokens: -1,
      outputTokens: 2,
      totalTokens: 1,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      requestCount: 1,
      reportedRequestCount: 1,
    })).toBeUndefined();
  });

  it("prefers the usage snapshot with more completed requests", () => {
    const older = accumulateSubtitleTranslationUsage(
      undefined,
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      undefined,
    );
    const newer = accumulateSubtitleTranslationUsage(
      older,
      { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      undefined,
    );

    expect(preferMoreCompleteSubtitleTranslationUsage(newer, older)).toEqual(newer);
    expect(preferMoreCompleteSubtitleTranslationUsage(older, newer)).toEqual(newer);
  });
});
