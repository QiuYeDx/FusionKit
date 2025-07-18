import { SubtitleSliceType } from "@/type/subtitle";
import { Model, TokenPricing } from "@/type/model";

/**
 * 估算字幕翻译的token消耗量（通过IPC调用主进程）
 * @param content 字幕内容
 * @param sliceType 分片类型
 * @param customSliceLength 自定义分片长度（当sliceType为CUSTOM时使用）
 * @param model 模型类型
 * @param tokenPricing token价格信息
 * @returns 预估的token消耗量信息
 */
export const estimateSubtitleTokens = async (
  content: string,
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
  model?: Model,
  tokenPricing?: TokenPricing
): Promise<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fragmentCount: number;
}> => {
  try {
    // 通过IPC调用主进程的token估算
    const result = await window.ipcRenderer.invoke("estimate-subtitle-tokens", {
      content,
      sliceType,
      customSliceLength,
      inputTokenPrice: tokenPricing?.inputTokensPerMillion,
      outputTokenPrice: tokenPricing?.outputTokensPerMillion
    });
    return result;
  } catch (error) {
    console.error("调用主进程计算token失败:", error);
    // 如果调用失败，使用简化的前端估算作为兜底
    return estimateSubtitleTokensFallback(content, sliceType, customSliceLength, tokenPricing);
  }
};

/**
 * 前端兜底的token估算（当主进程调用失败时使用）
 */
const estimateSubtitleTokensFallback = (
  content: string,
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
  tokenPricing?: TokenPricing
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  fragmentCount: number;
} => {
  // 简化的token估算
  const approximateTokens = Math.ceil(content.length * 0.75);
  const fragmentCount = Math.ceil(approximateTokens / 1000); // 假设每个分片1000tokens
  const inputTokens = approximateTokens + (fragmentCount * 200);
  const outputTokens = Math.ceil(approximateTokens * 1.2);
  const totalTokens = inputTokens + outputTokens;
  
  // 使用传入的价格或默认价格
  const inputPrice = tokenPricing?.inputTokensPerMillion || 1.5;
  const outputPrice = tokenPricing?.outputTokensPerMillion || 2.0;
  const estimatedCost = (inputTokens / 1000000) * inputPrice + (outputTokens / 1000000) * outputPrice;
  
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost,
    fragmentCount
  };
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