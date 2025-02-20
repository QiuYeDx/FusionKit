import { encode } from "gpt-3-encoder";
import { SubtitleTranslatorTask } from "../typing";
import { BaseTranslator } from "./base-translator";

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

      // 确保块以序号开始（简单验证）
      if (!/^\d+\n/.test(block)) {
        console.warn(`Invalid SRT block detected: ${block}`);
        continue; // 跳过不符合格式的块
      }

      // 计算当前块的 token 数
      const blockTokens = this.countTokens(block);

      if (blockTokens > maxTokens) {
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

        if (potentialTokens > maxTokens) {
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
    return (
      `你是一个专业的字幕翻译专家。你的任务是将日语字幕翻译为中日双语格式，每行日语后面紧跟着对应的中文翻译。请保持翻译的连贯性和准确性。\n\n` +
      `以下是前面的翻译内容（仅供参考，不要翻译）：\n${context}\n\n` +
      `请翻译以下字幕内容（只翻译这部分）：\n\n${partialContent}\n\n` +
      `翻译后的格式应与原文相同，每行日语后紧跟中文翻译。不要添加任何额外的解释或markdown格式。`
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
    // 假设字幕块以数字开头，以时间戳和内容行结尾
    const srtBlockRegex =
      /\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n[\s\S]*?(?=\n\n|\n$)/g;
    const matches = content.match(srtBlockRegex);
    if (matches) {
      return matches.join("\n\n");
    }
    // 清理 markdown 和多余换行
    return content
      .replace(/```srt?/g, "")
      .replace(/```/g, "")
      .replace(/\n+/g, "\n")
      .trim();
  }

  private finalizeTranslation(task: SubtitleTranslatorTask) {
    console.log(` 翻译完成，总费用：$${this.totalCost.toFixed(2)}`);
    // 实际文件保存逻辑...
  }
}
