import type { ModelRuntimeUsage } from "../ai/model-runtime-client";
import type { TokenPricing } from "@/type/model";
import type { SubtitleTranslationUsage } from "@/type/subtitleUsage";
import { isSubtitleTranslationUsage } from "@/type/subtitleUsage";

export function normalizeSubtitleTranslationUsage(
  value: unknown,
): SubtitleTranslationUsage | undefined {
  if (!isSubtitleTranslationUsage(value)) return undefined;
  return Object.freeze({ ...value });
}

export function preferMoreCompleteSubtitleTranslationUsage(
  preferredOnTie: SubtitleTranslationUsage | undefined,
  alternative: SubtitleTranslationUsage | undefined,
): SubtitleTranslationUsage | undefined {
  const preferred = normalizeSubtitleTranslationUsage(preferredOnTie);
  const other = normalizeSubtitleTranslationUsage(alternative);
  if (!preferred) return other;
  if (!other) return preferred;

  const preferredScore = [
    preferred.requestCount,
    preferred.reportedRequestCount,
    preferred.totalTokens,
  ] as const;
  const otherScore = [
    other.requestCount,
    other.reportedRequestCount,
    other.totalTokens,
  ] as const;
  for (let index = 0; index < preferredScore.length; index += 1) {
    if (preferredScore[index] > otherScore[index]) return preferred;
    if (preferredScore[index] < otherScore[index]) return other;
  }
  return preferred;
}

export function accumulateSubtitleTranslationUsage(
  current: SubtitleTranslationUsage | undefined,
  usage: ModelRuntimeUsage | undefined,
  pricing: TokenPricing | undefined,
): SubtitleTranslationUsage {
  const previous = normalizeSubtitleTranslationUsage(current);
  const inputTokens = nonNegative(usage?.inputTokens);
  const outputTokens = nonNegative(usage?.outputTokens);
  const totalTokens = nonNegative(usage?.totalTokens) ??
    ((inputTokens ?? 0) + (outputTokens ?? 0));
  const completeReport = inputTokens !== undefined && outputTokens !== undefined;
  const calculatedCost = calculateCost(inputTokens, outputTokens, pricing);
  const previousCost = previous?.calculatedCost;

  return Object.freeze({
    inputTokens: (previous?.inputTokens ?? 0) + (inputTokens ?? 0),
    outputTokens: (previous?.outputTokens ?? 0) + (outputTokens ?? 0),
    totalTokens: (previous?.totalTokens ?? 0) + totalTokens,
    reasoningTokens:
      (previous?.reasoningTokens ?? 0) +
      (nonNegative(usage?.reasoningTokens) ?? 0),
    cachedInputTokens:
      (previous?.cachedInputTokens ?? 0) +
      (nonNegative(usage?.cachedInputTokens) ?? 0),
    requestCount: (previous?.requestCount ?? 0) + 1,
    reportedRequestCount:
      (previous?.reportedRequestCount ?? 0) + (completeReport ? 1 : 0),
    ...(
      previousCost !== undefined || calculatedCost !== undefined
        ? { calculatedCost: (previousCost ?? 0) + (calculatedCost ?? 0) }
        : {}
    ),
  });
}

function calculateCost(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  pricing: TokenPricing | undefined,
): number | undefined {
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    !validPrice(pricing?.inputTokensPerMillion) ||
    !validPrice(pricing?.outputTokensPerMillion)
  ) {
    return undefined;
  }
  return (
    (inputTokens / 1_000_000) * pricing.inputTokensPerMillion +
    (outputTokens / 1_000_000) * pricing.outputTokensPerMillion
  );
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function validPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
