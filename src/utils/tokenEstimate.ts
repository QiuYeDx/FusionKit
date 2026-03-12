import { SubtitleSliceType } from "@/type/subtitle";
import { Model, TokenPricing } from "@/type/model";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";

/**
 * 快速估算文本的 token 数量（纯前端，无 IPC）。
 * 对 CJK / 假名等宽字符按 ~1 token 计，Latin/数字/标点按 ~0.25 token 计。
 * 精度足以用于费用预览，避免调用 gpt-3-encoder 阻塞主进程。
 */
function countTokensFast(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
      (code >= 0xac00 && code <= 0xd7af)    // Hangul Syllables
    ) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * 估算字幕翻译的 token 消耗量（纯渲染进程本地计算，不阻塞主进程）
 */
export const estimateSubtitleTokens = async (
  content: string,
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
  _model?: Model,
  tokenPricing?: TokenPricing
): Promise<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fragmentCount: number;
}> => {
  const maxTokens =
    sliceType === SubtitleSliceType.CUSTOM
      ? customSliceLength || 500
      : DEFAULT_SLICE_LENGTH_MAP[sliceType];

  const originalTokens = countTokensFast(content);
  const promptOverhead = 200;
  const fragmentCount = Math.max(
    1,
    Math.ceil(originalTokens / Math.max(1, maxTokens - promptOverhead))
  );

  const inputTokens = originalTokens + fragmentCount * promptOverhead;
  const outputTokens = Math.ceil(originalTokens * 1.5);
  const totalTokens = inputTokens + outputTokens;

  const inputPrice = tokenPricing?.inputTokensPerMillion || 1.5;
  const outputPrice = tokenPricing?.outputTokensPerMillion || 2.0;
  const estimatedCost =
    (inputTokens / 1_000_000) * inputPrice +
    (outputTokens / 1_000_000) * outputPrice;

  return { inputTokens, outputTokens, totalTokens, estimatedCost, fragmentCount };
};

/**
 * 格式化token数量为可读字符串
 * @param tokens token数量
 * @returns 格式化后的字符串
 */
export const formatTokens = (tokens: number): string => {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
};

/**
 * 格式化费用为可读字符串
 * @param cost 费用（美元）
 * @returns 格式化后的字符串
 */
export const formatCost = (cost: number): string => {
  if (cost < 0.001) {
    return `$${(cost * 1000).toFixed(3)}‰`; // 千分之几美元
  } else if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  } else if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}; 