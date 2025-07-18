import { SubtitleFileType, SubtitleTranslatorTask, SubtitleSliceType } from "./typing";
import { LRCTranslator } from "./class/lrc-translator";
import { SRTTranslator } from "./class/srt-translator";
import { encode } from "gpt-3-encoder";
import { DEFAULT_SLICE_LENGTH_MAP } from "./contants";

export class TranslationService {
  private activeTasks = new Map<string, AbortController>();

  async processTask(task: SubtitleTranslatorTask) {
    const controller = new AbortController();
    this.activeTasks.set(task.fileName, controller);

    try {
      const translator = this.getTranslator(
        task.fileName.split(".").at(-1)?.toUpperCase() as SubtitleFileType,
        {
          apiKey: task.apiKey,
          apiModel: task.apiModel,
          endpoint: task.endPoint,
        }
      );
      console.info(">>> [processTask] task: ", task, translator);
      await translator.translate(task, controller.signal);
      return { status: "completed" };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return { status: "cancelled" };
      return { status: "failed", error: error instanceof Error ? error.message : "未知错误" };
    } finally {
      this.activeTasks.delete(task.fileName);
    }
  }

  private getTranslator(
    fileType: SubtitleFileType,
    params: { apiKey: string; apiModel: string; endpoint: string }
  ) {
    return {
      [SubtitleFileType.LRC]: new LRCTranslator({
        apiKey: params.apiKey,
        endpoint: params.endpoint,
        apiModel: params.apiModel,
      }),
      [SubtitleFileType.SRT]: new SRTTranslator({
        apiKey: params.apiKey,
        endpoint: params.endpoint,
        apiModel: params.apiModel,
      }),
    }[fileType];
  }

  cancelTask(fileName: string) {
    this.activeTasks.get(fileName)?.abort();
  }

  /**
   * 估算字幕翻译的token消耗量
   * @param content 字幕内容
   * @param sliceType 分片类型
   * @param customSliceLength 自定义分片长度（当sliceType为CUSTOM时使用）
   * @param inputTokenPrice 输入token价格（每1M token的美元价格）
   * @param outputTokenPrice 输出token价格（每1M token的美元价格）
   * @returns 预估的token消耗量信息
   */
  estimateTokens(
    content: string,
    sliceType: SubtitleSliceType,
    customSliceLength?: number,
    inputTokenPrice?: number,
    outputTokenPrice?: number
  ): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
    fragmentCount: number;
  } {
    // 获取最大token数
    const maxTokens = sliceType === SubtitleSliceType.CUSTOM 
      ? (customSliceLength || 500)
      : DEFAULT_SLICE_LENGTH_MAP[sliceType];

    // 计算原始内容的token数量
    const originalTokens = this.calculateTokens(content);
    
    // 估算分片数量（考虑到翻译prompt会增加一些token）
    const promptOverhead = 200; // 每个分片的prompt大约增加200个token
    const fragmentCount = Math.ceil(originalTokens / (maxTokens - promptOverhead));
    
    // 输入token = 原始内容token + prompt开销
    const inputTokens = originalTokens + (fragmentCount * promptOverhead);
    
    // 输出token估算（通常翻译后的内容会比原文稍多，这里估算为1.2倍）
    const outputTokens = Math.ceil(originalTokens * 1.2);
    
    const totalTokens = inputTokens + outputTokens;
    
    // 费用估算（使用传入的价格或默认价格）
    const inputCostPer1M = inputTokenPrice || 1.5; // 默认价格（美元/1M tokens）
    const outputCostPer1M = outputTokenPrice || 2.0;
    const estimatedCost = (inputTokens / 1000000) * inputCostPer1M + (outputTokens / 1000000) * outputCostPer1M;
    
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost,
      fragmentCount
    };
  }

  /**
   * 计算文本的token数量
   * @param text 要计算的文本
   * @returns token数量
   */
  private calculateTokens(text: string): number {
    try {
      return encode(text).length;
    } catch (error) {
      console.error("计算token失败:", error);
      // 如果编码失败，使用粗略估算：平均每个字符约0.75个token
      return Math.ceil(text.length * 0.75);
    }
  }
}
