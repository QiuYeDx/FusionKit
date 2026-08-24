export interface SubtitleTranslationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly requestCount: number;
  readonly reportedRequestCount: number;
  /** Calculated from the task's frozen profile pricing, not a provider invoice. */
  readonly calculatedCost?: number;
}

export function isSubtitleTranslationUsage(
  value: unknown,
): value is SubtitleTranslationUsage {
  if (!isRecord(value)) return false;
  return nonNegativeFinite(value.inputTokens) &&
    nonNegativeFinite(value.outputTokens) &&
    nonNegativeFinite(value.totalTokens) &&
    nonNegativeFinite(value.reasoningTokens) &&
    nonNegativeFinite(value.cachedInputTokens) &&
    nonNegativeSafeInteger(value.requestCount) &&
    nonNegativeSafeInteger(value.reportedRequestCount) &&
    value.reportedRequestCount <= value.requestCount &&
    (value.calculatedCost === undefined ||
      nonNegativeFinite(value.calculatedCost));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
