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

    content.split("\n").forEach((line) => {
      const potentialFragment = currentFragment
        ? `${currentFragment}\n${line}`
        : line;
      if (this.countTokens(potentialFragment) > maxTokens) {
        fragments.push(currentFragment);
        currentFragment = line;
      } else {
        currentFragment = potentialFragment;
      }
    });

    if (currentFragment) fragments.push(currentFragment);
    return fragments;
  }

  protected formatPrompt(partialContent: string, context: string): string {
    return (
      `将以下字幕内容翻译为中日双语，每行日语后面紧跟着对应的中文，保持连贯性，格式如下:\n` +
      `1\n` +
      `00:00:53,620 --> 00:00:55,620\n` +
      `ゴーって言ってます\n` +
      `说要开始了\n` +
      `前面的翻译内容是:\n${context}\n` +
      `请处理以下内容:\n\n${partialContent}` +
      `只回复我有效的字幕文件内容，不要添加额外的markdown格式或其他话语！`
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
