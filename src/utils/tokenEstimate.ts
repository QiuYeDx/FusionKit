import { SubtitleSliceType } from "@/type/subtitle";
import type {
  TranslationLanguage,
  TranslationOutputMode,
} from "@/type/subtitle";
import type { Model, TokenPricing } from "@/type/model";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";
import {
  buildSubtitleTokenEstimate,
  type SubtitleTokenEstimateResult,
} from "@/utils/subtitleTokenEstimateCore";
import { encode } from "gpt-tokenizer";

// ---------------------------------------------------------------------------
// Token counter
// ---------------------------------------------------------------------------

function countTokens(text: string): number {
  return encode(text).length;
}

// ---------------------------------------------------------------------------
// CostEstimate shape
// ---------------------------------------------------------------------------

export type CostEstimateResult = SubtitleTokenEstimateResult;

export type SubtitleTokenEstimateOptions = {
  fileName?: string;
  sourceLang?: TranslationLanguage;
  targetLang?: TranslationLanguage;
  translationOutputMode?: TranslationOutputMode;
};

function resolveMaxTokens(
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
): number {
  const fallback = DEFAULT_SLICE_LENGTH_MAP[sliceType];
  const value =
    sliceType === SubtitleSliceType.CUSTOM ? customSliceLength : fallback;

  return Number.isFinite(value) && value && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Public: synchronous estimate used for immediate UI feedback
// ---------------------------------------------------------------------------

export function estimateSubtitleTokensFast(
  content: string,
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
  _model?: Model,
  tokenPricing?: TokenPricing,
  options: SubtitleTokenEstimateOptions = {},
): CostEstimateResult {
  return buildSubtitleTokenEstimate({
    content,
    maxTokens: resolveMaxTokens(sliceType, customSliceLength),
    countTokens,
    tokenPricing,
    loading: false,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Public: async estimate kept for existing call sites
// ---------------------------------------------------------------------------

export async function estimateSubtitleTokens(
  content: string,
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
  _model?: Model,
  tokenPricing?: TokenPricing,
  options: SubtitleTokenEstimateOptions = {},
): Promise<CostEstimateResult> {
  return buildSubtitleTokenEstimate({
    content,
    maxTokens: resolveMaxTokens(sliceType, customSliceLength),
    countTokens,
    tokenPricing,
    loading: false,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export const formatTokens = (tokens: number): string => {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
};

export const formatCost = (cost: number): string => {
  if (cost < 0.001) {
    return `$${(cost * 1000).toFixed(3)}‰`;
  } else if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  } else if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
};
