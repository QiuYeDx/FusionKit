// src/main/translation/lrc-translator.ts
import { BaseTranslator } from "./base-translator";
import { SubtitleTranslatorTask } from "../typing";
import { encode } from "gpt-tokenizer";
import { getLanguageName } from "../contants";

export class LRCTranslator extends BaseTranslator {
  private readonly apiModel: string;
  private readonly costPerInput: number;
  private readonly costPerOutput: number;
  private totalCost = 0;

  constructor(
    private config: {
      apiKey: string;
      endpoint: string;
      apiModel?: string;
      costRates?: { input: number; output: number };
    }
  ) {
    super();
    this.apiModel = config.apiModel || "gpt-3.5-turbo";
    this.costPerInput = config.costRates?.input || 0.0015;
    this.costPerOutput = config.costRates?.output || 0.002;
  }

  protected splitContent(content: string, maxTokens: number): string[] {
    const parts: string[] = [];
    let currentPart: string[] = [];
    let currentTokenCount = 0;

    for (const line of content.split("\n")) {
      const lineTokens = encode(line).length;

      if (currentTokenCount + lineTokens > maxTokens) {
        parts.push(currentPart.join("\n"));
        currentPart = [line];
        currentTokenCount = lineTokens;
      } else {
        currentPart.push(line);
        currentTokenCount += lineTokens;
      }
    }

    if (currentPart.length > 0) {
      parts.push(currentPart.join("\n"));
    }

    return parts;
  }

  protected formatPrompt(partialContent: string, context: string): string {
    const srcName = getLanguageName(this.sourceLang);
    const tgtName = getLanguageName(this.targetLang);

    if (this.bilingualOutput) {
      return (
        `Translate the following ${srcName} subtitle content into bilingual format with ${srcName} and ${tgtName}. Each ${srcName} line should be immediately followed by the ${tgtName} translation with the same timestamp. Maintain coherence. Example format:\n` +
        `[00:00.05]<${srcName} text>\n` +
        `[00:00.05]<${tgtName} translation>\n` +
        (context ? `Previous translated content:\n${context}\n` : "") +
        `Translate the following content:\n\n${partialContent}`
      );
    }

    return (
      `Translate the following ${srcName} subtitle content into ${tgtName}. Replace all ${srcName} text with ${tgtName} translation. Maintain the LRC format and timestamps. Maintain coherence.\n` +
      (context ? `Previous translated content:\n${context}\n` : "") +
      `Translate the following content:\n\n${partialContent}`
    );
  }

  protected getApiEndpoint(): string {
    return this.config.endpoint;
  }

  protected createHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  protected buildRequestBody(prompt: string): BodyInit {
    return JSON.stringify({
      model: this.apiModel,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 3500,
    });
  }

  protected async parseResponse(response: any): Promise<string> {
    const content = response.choices[0].message.content;
    const cleanedContent = this.cleanTranslatedContent(content);

    // 计算费用
    const inputTokens = response.usage?.prompt_tokens || 0;
    const outputTokens = response.usage?.completion_tokens || 0;
    this.totalCost += (inputTokens / 1_000_000) * this.costPerInput;
    this.totalCost += (outputTokens / 1_000_000) * this.costPerOutput;

    return cleanedContent;
  }

  private cleanTranslatedContent(content: string): string {
    return content
      .replace(/^\s*```(lrc|plaintext)?\s*/g, "")
      .replace(/```$/g, "")
      .split("\n")
      .filter((line) => line.startsWith("["))
      .join("\n")
      .trim();
  }

  protected normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(`Translation failed: ${String(error)}`);
  }

  // 新增上下文保留机制
  protected getContextWindowSize(): number {
    return 2; // 保留最后两句作为上下文
  }
}
