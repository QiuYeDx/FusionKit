import { SubtitleSliceType } from "@/type/subtitle";
import { Model, TokenPricing } from "@/type/model";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";

// ---------------------------------------------------------------------------
// Fast heuristic counter (sync, zero-dependency)
// ---------------------------------------------------------------------------

function countTokensFast(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

// ---------------------------------------------------------------------------
// Precise counter (async, lazy-loads gpt-tokenizer)
// ---------------------------------------------------------------------------

type EncodeFn = (text: string) => number[];
let _encodeFn: EncodeFn | null = null;
let _loadPromise: Promise<EncodeFn> | null = null;

function loadTokenizer(): Promise<EncodeFn> {
  if (_encodeFn) return Promise.resolve(_encodeFn);
  if (_loadPromise) return _loadPromise;
  _loadPromise = import("gpt-tokenizer").then((mod) => {
    _encodeFn = mod.encode as EncodeFn;
    return _encodeFn;
  });
  return _loadPromise;
}

async function countTokensPrecise(text: string): Promise<number> {
  const encode = await loadTokenizer();
  return encode(text).length;
}

// ---------------------------------------------------------------------------
// CostEstimate shape
// ---------------------------------------------------------------------------

export type CostEstimateResult = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fragmentCount: number;
  loading?: boolean;
};

// ---------------------------------------------------------------------------
// Internal helper: build estimate from a raw token count
// ---------------------------------------------------------------------------

function buildEstimate(
  originalTokens: number,
  maxTokens: number,
  tokenPricing?: TokenPricing,
  loading?: boolean,
): CostEstimateResult {
  const promptOverhead = 200;
  const fragmentCount = Math.max(
    1,
    Math.ceil(originalTokens / Math.max(1, maxTokens - promptOverhead)),
  );

  const inputTokens = originalTokens + fragmentCount * promptOverhead;
  const outputTokens = Math.ceil(originalTokens * 1.5);
  const totalTokens = inputTokens + outputTokens;

  const inputPrice = tokenPricing?.inputTokensPerMillion || 1.5;
  const outputPrice = tokenPricing?.outputTokensPerMillion || 2.0;
  const estimatedCost =
    (inputTokens / 1_000_000) * inputPrice +
    (outputTokens / 1_000_000) * outputPrice;

  return { inputTokens, outputTokens, totalTokens, estimatedCost, fragmentCount, loading };
}

// ---------------------------------------------------------------------------
// Public: synchronous fast estimate (used for immediate UI feedback)
// ---------------------------------------------------------------------------

export function estimateSubtitleTokensFast(
  content: string,
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
  _model?: Model,
  tokenPricing?: TokenPricing,
): CostEstimateResult {
  const maxTokens =
    sliceType === SubtitleSliceType.CUSTOM
      ? customSliceLength || 500
      : DEFAULT_SLICE_LENGTH_MAP[sliceType];

  return buildEstimate(countTokensFast(content), maxTokens, tokenPricing, true);
}

// ---------------------------------------------------------------------------
// Public: async precise estimate (lazy-loads gpt-tokenizer)
// ---------------------------------------------------------------------------

export async function estimateSubtitleTokens(
  content: string,
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
  _model?: Model,
  tokenPricing?: TokenPricing,
): Promise<CostEstimateResult> {
  const maxTokens =
    sliceType === SubtitleSliceType.CUSTOM
      ? customSliceLength || 500
      : DEFAULT_SLICE_LENGTH_MAP[sliceType];

  const originalTokens = await countTokensPrecise(content);
  return buildEstimate(originalTokens, maxTokens, tokenPricing, false);
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
