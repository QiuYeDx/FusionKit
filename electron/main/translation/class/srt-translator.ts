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

  protected splitContent(content: string, maxTokens: number): string[] {
    const fragments: string[] = [];
    let currentFragment = "";

    // 将内容按 SRT 字幕块分割（两个换行符 \n\n 分隔块）
    const subtitleBlocks = content.trim().split(/\n\n+/);

    for (const block of subtitleBlocks) {
      if (!block.trim()) continue; // 跳过空块

      // 计算当前块的 token 数
      const blockTokens = this.countTokens(block);

      if (blockTokens >= maxTokens) {
        // 如果单个块超过 maxTokens，直接作为单独的分片
        if (currentFragment) {
          fragments.push(currentFragment);
          currentFragment = "";
        }
        fragments.push(block);
      } else {
        // 检查加入当前块后是否超过 maxTokens
        const potentialFragment = currentFragment
          ? `${currentFragment}\n\n${block}`
          : block;
        const potentialTokens = this.countTokens(potentialFragment);

        if (potentialTokens >= maxTokens) {
          // 如果超过限制，将当前积累的内容作为一个分片，新块放入下一个分片
          if (currentFragment) {
            fragments.push(currentFragment);
            currentFragment = block;
          }
        } else {
          // 未超过限制，继续积累
          currentFragment = potentialFragment;
        }
      }
    }

    // 处理最后一个分片
    if (currentFragment) {
      fragments.push(currentFragment);
    }

    return fragments;
  }

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
      // temperature: 0.3,
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

  // 覆盖父类方法添加后处理
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

  private postProcess(content: string): string {
    // 清理 markdown 和多余换行
    // let cleaned = content
    //   .replace(/```srt?/g, "")
    //   .replace(/```/g, "")
    //   .replace(/\n{3,}/g, "\n\n")
    //   .trim();

    // // 尝试提取 SRT 块
    // const srtBlockRegex =
    //   /\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n[\s\S]*?(?=\n\n|\n$)/g;
    // const matches = cleaned.match(srtBlockRegex);

    // if (matches && matches.length > 0) {
    //   return matches.join("\n\n");
    // }

    // // 如果正则匹配失败，返回清理后的内容并记录警告
    // console.warn("SRT block regex failed, returning cleaned content:", cleaned);
    // return cleaned;
    return content;
  }

  private finalizeTranslation(task: SubtitleTranslatorTask) {
    console.log(` 翻译完成，总费用：$${this.totalCost.toFixed(2)}`);
    // 实际文件保存逻辑...
  }
}
