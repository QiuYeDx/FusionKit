import { ModelRuntimeClientError } from "../ai/model-runtime-errors";

export type SubtitleTranslationRetryPolicy = Readonly<{
  /** Total request attempts for one fragment, including the first request. */
  maxAttempts: number;
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Maximum locally calculated exponential-backoff delay. */
  maxDelayMs: number;
  /** Maximum accepted server Retry-After delay. */
  maxServerDelayMs: number;
  /** Positive jitter added to desynchronise concurrent fragment retries. */
  jitterRatio: number;
}>;

export const DEFAULT_SUBTITLE_TRANSLATION_RETRY_POLICY = Object.freeze({
  maxAttempts: 7,
  baseDelayMs: 2_000,
  maxDelayMs: 45_000,
  maxServerDelayMs: 120_000,
  jitterRatio: 0.2,
}) satisfies SubtitleTranslationRetryPolicy;

/**
 * Resolve the delay after a failed, one-based request attempt.
 *
 * The local exponential backoff is always a floor, including when a provider
 * sends Retry-After: 0. This prevents concurrent subtitle fragments from
 * immediately retrying in lockstep during a short provider outage.
 */
export function resolveSubtitleTranslationRetryDelay(
  error: unknown,
  failedAttempt: number,
  policy: SubtitleTranslationRetryPolicy =
    DEFAULT_SUBTITLE_TRANSLATION_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(failedAttempt));
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (safeAttempt - 1),
  );
  const randomValue = Math.min(1, Math.max(0, random()));
  const jitteredBackoff = Math.min(
    policy.maxDelayMs,
    Math.round(exponential * (1 + policy.jitterRatio * randomValue)),
  );

  const retryAfterMs =
    error instanceof ModelRuntimeClientError &&
    typeof error.details.retryAfterMs === "number" &&
    Number.isFinite(error.details.retryAfterMs)
      ? Math.min(
          policy.maxServerDelayMs,
          Math.max(0, error.details.retryAfterMs),
        )
      : 0;

  return Math.max(jitteredBackoff, retryAfterMs);
}
