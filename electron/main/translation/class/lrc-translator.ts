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

import {
  coalesceEmptyLrcFragments,
  parseSubtitleCueDocument,
  renderSubtitleCueResponse,
  subtitleWithoutTranslation,
  validateCommittedSubtitle,
} from "@/utils/subtitleCueProtocol";
import { BaseTranslator } from "./base-translator";
import { encode } from "gpt-tokenizer";
import {
  boundSubtitleContext,
  buildSubtitleTranslationPrompt,
  type SubtitleTranslationContext,
} from "@/utils/subtitleTranslationPrompt";
import type { ModelRuntimeTextResult } from "../../ai/model-runtime-client";

export class LRCTranslator extends BaseTranslator {
  protected fragmentSeparator = "\n";

  private readonly apiModel: string;
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

    return coalesceEmptyLrcFragments(parts);
  }

  /**
   * 构建 LRC 翻译 prompt。
   * 双语模式：要求 LLM 在每行原文后紧跟一行译文（使用相同时间标签）
   * 仅译文模式：直接替换原文为译文
   */
  protected formatPrompt(
    partialContent: string,
    context: SubtitleTranslationContext,
  ): string {
    const countTokens = (text: string) => encode(text).length;
    return buildSubtitleTranslationPrompt({
      format: "LRC",
      content: partialContent,
      context: {
        previousSource: boundSubtitleContext(context.previousSource, "LRC", countTokens),
        previousTranslation: boundSubtitleContext(context.previousTranslation, "LRC", countTokens),
      },
      sourceLang: this.sourceLang,
      targetLang: this.targetLang,
      translationOutputMode: this.bilingualOutput ? "bilingual" : "target_only",
    });
  }

  /** 校验完整 ID 覆盖后，由程序重建源时间轴。 */
  protected async parseResponse(
    response: ModelRuntimeTextResult,
    sourceContent: string,
  ): Promise<string> {
    return renderSubtitleCueResponse(
      parseSubtitleCueDocument(sourceContent, "LRC"),
      response.content,
      this.bilingualOutput,
    );
  }

  protected translateWithoutModel(content: string): string | undefined {
    return subtitleWithoutTranslation(parseSubtitleCueDocument(content, "LRC"));
  }

  protected validateCommittedTranslation(source: string, translated: string): void {
    validateCommittedSubtitle(parseSubtitleCueDocument(source, "LRC"), translated, this.bilingualOutput);
  }

  protected normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(`Translation failed: ${String(error)}`);
  }
}
