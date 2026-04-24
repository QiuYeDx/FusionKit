/**
 * SRT 字幕格式翻译器
 *
 * SRT 格式特点：字幕以"块"为单位，块间用空行分隔，每块结构如下：
 *   1                              <- 序号
 *   00:00:01,000 --> 00:00:03,000  <- 时间轴
 *   字幕文本（可能多行）            <- 文本内容
 *
 * 分片策略：以完整字幕块为最小单元进行累计，不会拆开单个块。
 * 这比 LRC 的逐行分片更复杂，因为 SRT 一个块可能包含多行文本。
 */

import { encode } from "gpt-tokenizer";
import { SubtitleTranslatorTask } from "../typing";
import { BaseTranslator } from "./base-translator";
import { getLanguageName } from "../contants";

type TranslatorConfig = {
  apiKey: string;
  endpoint: string;
  apiModel?: string;
  costRates?: { input: number; output: number };
};

export class SRTTranslator extends BaseTranslator {
  private apiModel: string;
  private costPerInput: number;
  private costPerOutput: number;
  private totalCost = 0;

  constructor(private config: TranslatorConfig) {
    super();
    this.apiModel = config.apiModel || "gpt-3.5-turbo";
    this.costPerInput = config.costRates?.input ?? 0.0015;
    this.costPerOutput = config.costRates?.output ?? 0.002;
  }

  /**
   * SRT 分片：以字幕块（\n\n 分隔）为最小单元进行累计。
   * 三种情况：
   *   - 单块超过 maxTokens → 独立成片（极端情况）
   *   - 累计后超过 maxTokens → 当前累计成片，新块开启下一片
   *   - 累计后未超过 → 继续累计
   */
  protected splitContent(content: string, maxTokens: number): string[] {
    const fragments: string[] = [];
    let currentFragment = "";

    const subtitleBlocks = content.trim().split(/\n\n+/);

    for (const block of subtitleBlocks) {
      if (!block.trim()) continue;

      const blockTokens = this.countTokens(block);

      if (blockTokens >= maxTokens) {
        if (currentFragment) {
          fragments.push(currentFragment);
          currentFragment = "";
        }
        fragments.push(block);
      } else {
        const potentialFragment = currentFragment
          ? `${currentFragment}\n\n${block}`
          : block;
        const potentialTokens = this.countTokens(potentialFragment);

        if (potentialTokens >= maxTokens) {
          if (currentFragment) {
            fragments.push(currentFragment);
            currentFragment = block;
          }
        } else {
          currentFragment = potentialFragment;
        }
      }
    }

    if (currentFragment) {
      fragments.push(currentFragment);
    }

    return fragments;
  }

  /**
   * 构建 SRT 翻译 prompt。
   * 与 LRC 的区别：SRT prompt 要求 LLM 以"专业字幕翻译者"角色回答，
   * 并强调保持 SRT 格式、不添加额外说明。
   * context 参数提供上一片的翻译结果，帮助 LLM 保持术语和语气一致性。
   */
  protected formatPrompt(partialContent: string, context: string): string {
    const srcName = getLanguageName(this.sourceLang);
    const tgtName = getLanguageName(this.targetLang);

    if (this.bilingualOutput) {
      return (
        `You are a professional subtitle translator. Translate the following ${srcName} subtitles into bilingual format: keep each original ${srcName} line, then immediately follow it with the ${tgtName} translation on the next line. Maintain coherence and accuracy.\n\n` +
        (context
          ? `Previous translated content (for reference only, do NOT translate again):\n${context}\n\n`
          : "") +
        `Translate the following subtitle content (only this part, ensure coherence with context above, maintain SRT format):\n\n${partialContent}\n\n` +
        `Output format must match the original. Each ${srcName} text line must be immediately followed by its ${tgtName} translation. Do not add any extra explanations or markdown formatting.`
      );
    }

    return (
      `You are a professional subtitle translator. Translate the following ${srcName} subtitles into ${tgtName}. Replace all ${srcName} text with the ${tgtName} translation. Maintain coherence and accuracy.\n\n` +
      (context
        ? `Previous translated content (for reference only, do NOT translate again):\n${context}\n\n`
        : "") +
      `Translate the following subtitle content (only this part, ensure coherence with context above, maintain SRT format):\n\n${partialContent}\n\n` +
      `Output only the ${tgtName} translations in the original SRT format. Do not add any extra explanations or markdown formatting.`
    );
  }

  protected getApiEndpoint(): string {
    return this.config.endpoint;
  }

  protected createHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      "X-Request-Source": "srt-translator",
    };
  }

  protected buildRequestBody(prompt: string): BodyInit {
    return JSON.stringify({
      model: this.apiModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 3500,
    });
  }

  protected async parseResponse(response: any): Promise<string> {
    const translated = response.choices[0].message.content;
    this.totalCost += this.calculateCost(response.usage);
    return this.postProcess(translated);
  }

  protected normalizeError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(`翻译错误: ${String(error)}`);
  }

  /** 覆盖父类 translate，在翻译完成后执行 SRT 特有的收尾逻辑 */
  async translate(task: SubtitleTranslatorTask, signal?: AbortSignal) {
    await super.translate(task, signal);
    task.progress = 100;
    this.finalizeTranslation(task);
  }

  private countTokens(text: string): number {
    return encode(text).length;
  }

  private calculateCost(usage: {
    prompt_tokens: number;
    completion_tokens: number;
  }): number {
    return (
      (usage.prompt_tokens * this.costPerInput) / 1000 +
      (usage.completion_tokens * this.costPerOutput) / 1000
    );
  }

  /**
   * SRT 后处理。
   * 注释掉的代码是之前尝试用正则提取 SRT 块的逻辑，
   * 但由于 LLM 返回格式不稳定（双语模式下块结构变化），
   * 改为直接返回原始内容，由前端或用户侧处理格式问题。
   */
  private postProcess(content: string): string {
    return content;
  }

  private finalizeTranslation(task: SubtitleTranslatorTask) {
    console.log(` 翻译完成，总费用：$${this.totalCost.toFixed(2)}`);
  }
}
