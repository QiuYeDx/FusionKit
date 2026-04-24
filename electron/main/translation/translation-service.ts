/**
 * 字幕翻译模块 - 服务层（入口）
 *
 * TranslationService 是翻译功能的统一入口，职责：
 *   1. 管理活跃任务的生命周期（启动 / 取消）
 *   2. 根据文件扩展名自动选择对应的 Translator（策略模式）
 *   3. 提供翻译前的 token 预估能力
 *
 * 调用路径：IPC handler → TranslationService.processTask → LRC/SRTTranslator.translate
 */

import { SubtitleFileType, SubtitleTranslatorTask, SubtitleSliceType } from "./typing";
import { LRCTranslator } from "./class/lrc-translator";
import { SRTTranslator } from "./class/srt-translator";
import { encode } from "gpt-tokenizer";
import { DEFAULT_SLICE_LENGTH_MAP } from "./contants";

export class TranslationService {
  /** 以 fileName 为 key 追踪正在执行的任务，用于支持取消操作 */
  private activeTasks = new Map<string, AbortController>();

  /**
   * 处理一个翻译任务：根据文件后缀选择翻译器 → 执行翻译 → 返回最终状态。
   * AbortController 贯穿整个翻译流程，任何阶段调用 cancelTask 都能中断。
   */
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

  /** 根据文件类型创建对应的翻译器实例（策略模式） */
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

  /** 通过 AbortController 取消指定文件的翻译任务 */
  cancelTask(fileName: string) {
    this.activeTasks.get(fileName)?.abort();
  }

  /**
   * 翻译前的 token 预估。在用户点击"翻译"之前展示预估费用，帮助用户决策。
   *
   * 预估逻辑：
   *   1. 用 gpt-tokenizer 精确计算原文 token 数
   *   2. 根据 maxTokens 和 prompt 开销估算分片数
   *   3. 输出 token 按原文的 1.5 倍估算（翻译通常会扩展文本量）
   *   4. 费用 = 输入 token 单价 + 输出 token 单价（按百万 token 计）
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
    const maxTokens = sliceType === SubtitleSliceType.CUSTOM 
      ? (customSliceLength || 500)
      : DEFAULT_SLICE_LENGTH_MAP[sliceType];

    const originalTokens = this.calculateTokens(content);
    
    // 每个分片都会附带系统 prompt，约占 200 tokens
    const promptOverhead = 200;
    const fragmentCount = Math.ceil(originalTokens / (maxTokens - promptOverhead));
    
    const inputTokens = originalTokens + (fragmentCount * promptOverhead);
    const outputTokens = Math.ceil(originalTokens * 1.5);
    const totalTokens = inputTokens + outputTokens;
    
    const inputCostPer1M = inputTokenPrice || 1.5;
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

  /** 使用 gpt-tokenizer 计算精确 token 数，编码失败时回退到字符数 × 0.75 的粗略估算 */
  private calculateTokens(text: string): number {
    try {
      return encode(text).length;
    } catch (error) {
      console.error("计算token失败:", error);
      return Math.ceil(text.length * 0.75);
    }
  }
}
