import { describe, expect, it } from "vitest";
import { ModelRuntimeClientError } from "../../electron/main/ai/model-runtime-errors";
import {
  DEFAULT_SUBTITLE_TRANSLATION_RETRY_POLICY,
  resolveSubtitleTranslationRetryDelay,
} from "../../electron/main/translation/retry-policy";

describe("subtitle translation retry policy", () => {
  it("provides six retries with bounded exponential backoff", () => {
    expect(DEFAULT_SUBTITLE_TRANSLATION_RETRY_POLICY.maxAttempts).toBe(7);
    expect(resolveSubtitleTranslationRetryDelay(undefined, 1, undefined, () => 0))
      .toBe(2_000);
    expect(resolveSubtitleTranslationRetryDelay(undefined, 2, undefined, () => 0))
      .toBe(4_000);
    expect(resolveSubtitleTranslationRetryDelay(undefined, 6, undefined, () => 0))
      .toBe(45_000);
  });

  it("adds jitter without exceeding the local delay ceiling", () => {
    expect(resolveSubtitleTranslationRetryDelay(undefined, 2, undefined, () => 1))
      .toBe(4_800);
    expect(resolveSubtitleTranslationRetryDelay(undefined, 6, undefined, () => 1))
      .toBe(45_000);
  });

  it("uses Retry-After as a bounded floor instead of allowing immediate retries", () => {
    const retryAfterZero = new ModelRuntimeClientError(
      "http_rate_limited",
      "slow down",
      true,
      { retryAfterMs: 0 },
    );
    const retryAfterTenSeconds = new ModelRuntimeClientError(
      "http_retryable",
      "temporarily unavailable",
      true,
      { retryAfterMs: 10_000 },
    );
    const excessiveRetryAfter = new ModelRuntimeClientError(
      "http_retryable",
      "temporarily unavailable",
      true,
      { retryAfterMs: 600_000 },
    );

    expect(resolveSubtitleTranslationRetryDelay(retryAfterZero, 1, undefined, () => 0))
      .toBe(2_000);
    expect(resolveSubtitleTranslationRetryDelay(
      retryAfterTenSeconds,
      1,
      undefined,
      () => 0,
    )).toBe(10_000);
    expect(resolveSubtitleTranslationRetryDelay(
      excessiveRetryAfter,
      1,
      undefined,
      () => 0,
    )).toBe(120_000);
  });
});
