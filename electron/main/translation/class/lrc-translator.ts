/**
 * LRC 歌词格式翻译器
 *
 * LRC 格式特点：每行以时间标签开头，如 [00:01.50]歌词文本
 * 分片策略：按行累计 token 数，不拆分单行（LRC 每行较短，不会超限）
 *
 * 双语输出示例：
 *   [00:01.50]夜に駆ける
 *   [00:01.50]奔向夜晚
 */

import { BaseTranslator } from "./base-translator";
import { encode } from "gpt-tokenizer";
import { getLanguageName } from "../constants";
import { cleanTranslatedLrcContent } from "../lrc-utils";

export class LRCTranslator extends BaseTranslator {
  private readonly apiModel: string;
  /** 费用单价（美元 / 百万 token） */
  private readonly costPerInput: number;
  private readonly costPerOutput: number;
  /** 累计费用（美元），在 parseResponse 中逐片累加 */
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

  /**
   * LRC 分片：逐行累计 token，超过 maxTokens 时切分。
   * LRC 每行都是独立的时间标签+文本，天然以行为最小单元。
   */
  protected splitContent(content: string, maxTokens: number): string[] {
    const parts: string[] = [];
    let currentPart: string[] = [];
    let currentTokenCount = 0;
    const safeMaxTokens = Math.max(1, Math.floor(maxTokens));

    for (const line of content.split("\n")) {
      const lineTokens = encode(line).length;

      if (lineTokens > safeMaxTokens) {
        if (currentPart.length > 0) {
          parts.push(currentPart.join("\n"));
        }
        parts.push(line);
        currentPart = [];
        currentTokenCount = 0;
        continue;
      }

      if (
        currentPart.length > 0 &&
        currentTokenCount + lineTokens > safeMaxTokens
      ) {
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

  /**
   * 构建 LRC 翻译 prompt。
   * 双语模式：要求 LLM 在每行原文后紧跟一行译文（使用相同时间标签）
   * 仅译文模式：直接替换原文为译文
   */
  protected formatPrompt(partialContent: string, context: string): string {
    const srcName = getLanguageName(this.sourceLang);
    const tgtName = getLanguageName(this.targetLang);
    const outputRules =
      "Output only valid LRC lines. Every output line must start with a timestamp or metadata tag in [] format. Do not add markdown formatting or explanations.\n";

    if (this.bilingualOutput) {
      return (
        `Translate the following ${srcName} subtitle content into bilingual format with ${srcName} and ${tgtName}. Each ${srcName} line should be immediately followed by the ${tgtName} translation with the same timestamp. Maintain coherence. Example format:\n` +
        `[00:00.05]<${srcName} text>\n` +
        `[00:00.05]<${tgtName} translation>\n` +
        outputRules +
        (context ? `Previous translated content:\n${context}\n` : "") +
        `Translate the following content:\n\n${partialContent}`
      );
    }

    return (
      `Translate the following ${srcName} subtitle content into ${tgtName}. Replace all ${srcName} text with ${tgtName} translation. Maintain the LRC format and timestamps. Maintain coherence.\n` +
      outputRules +
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

  /** 解析 LLM 响应，清洗 markdown 格式残留，并累计本次调用的费用 */
  protected async parseResponse(response: any): Promise<string> {
    const content = response.choices[0].message.content;
    const cleanedContent = cleanTranslatedLrcContent(content);

    const inputTokens = response.usage?.prompt_tokens || 0;
    const outputTokens = response.usage?.completion_tokens || 0;
    this.totalCost += (inputTokens / 1_000_000) * this.costPerInput;
    this.totalCost += (outputTokens / 1_000_000) * this.costPerOutput;

    return cleanedContent;
  }

  protected normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(`Translation failed: ${String(error)}`);
  }

  /** 上下文窗口大小：保留最后 N 句作为下一片翻译的 context（预留扩展） */
  protected getContextWindowSize(): number {
    return 2;
  }
}
