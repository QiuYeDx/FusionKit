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

import {
  parseSubtitleCueDocument,
  renderSubtitleCueResponse,
  subtitleWithoutTranslation,
  validateCommittedSubtitle,
} from "@/utils/subtitleCueProtocol";
import { encode } from "gpt-tokenizer";
import { BaseTranslator } from "./base-translator";
import {
  boundSubtitleContext,
  buildSubtitleTranslationPrompt,
  type SubtitleTranslationContext,
} from "@/utils/subtitleTranslationPrompt";
import type { ModelRuntimeTextResult } from "../../ai/model-runtime-client";

type TranslatorConfig = {
  apiKey: string;
  endpoint: string;
  apiModel?: string;
  costRates?: { input: number; output: number };
};

export class SRTTranslator extends BaseTranslator {
  private apiModel: string;
  constructor(private config: TranslatorConfig) {
    super();
    this.apiModel = config.apiModel || "gpt-3.5-turbo";
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
    const safeMaxTokens = Math.max(1, Math.floor(maxTokens));

    const subtitleBlocks = content.trim().split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/);

    for (const block of subtitleBlocks) {
      if (!block.trim()) continue;

      const blockTokens = this.countTokens(block);

      if (blockTokens >= safeMaxTokens) {
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

        if (potentialTokens >= safeMaxTokens) {
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
   * 只提交带 ID 的文本；源编号与时间轴保留在本地。
   * context 分别提供上一片原文和已提交模型译文，保留有界参考。
   */
  protected formatPrompt(
    partialContent: string,
    context: SubtitleTranslationContext,
  ): string {
    const countTokens = (text: string) => encode(text).length;
    return buildSubtitleTranslationPrompt({
      format: "SRT",
      content: partialContent,
      context: {
        previousSource: boundSubtitleContext(context.previousSource, "SRT", countTokens),
        previousTranslation: boundSubtitleContext(context.previousTranslation, "SRT", countTokens),
      },
      sourceLang: this.sourceLang,
      targetLang: this.targetLang,
      translationOutputMode: this.bilingualOutput ? "bilingual" : "target_only",
    });
  }

  protected async parseResponse(
    response: ModelRuntimeTextResult,
    sourceContent: string,
  ): Promise<string> {
    return renderSubtitleCueResponse(
      parseSubtitleCueDocument(sourceContent, "SRT"),
      response.content,
      this.bilingualOutput,
    );
  }

  protected translateWithoutModel(content: string): string | undefined {
    return subtitleWithoutTranslation(parseSubtitleCueDocument(content, "SRT"));
  }

  protected validateCommittedTranslation(source: string, translated: string): void {
    validateCommittedSubtitle(parseSubtitleCueDocument(source, "SRT"), translated, this.bilingualOutput);
  }

  protected normalizeError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(`翻译错误: ${String(error)}`);
  }

  private countTokens(text: string): number {
    return encode(text).length;
  }

}
