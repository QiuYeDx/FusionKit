import { describe, expect, it } from "vitest";
import { encode } from "gpt-tokenizer";
import { boundSubtitleContext, buildSubtitleTranslationPrompt, SUBTITLE_CONTEXT_TOKEN_LIMIT } from "./subtitleTranslationPrompt";
import { buildSubtitleTokenEstimate, splitSubtitleContentForEstimate } from "./subtitleTokenEstimateCore";

const countTokens = (text: string) => encode(text).length;

describe("bounded subtitle reference context", () => {
  it("estimates Windows SRT fragments without merging the entire file", () => {
    const content = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nGoodbye";
    expect(splitSubtitleContentForEstimate(content, 1, countTokens, "sample.srt")).toHaveLength(2);
  });
  it("keeps complete recent LRC lines and Unicode within budget", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `[00:01.00]第${i}句 日本語👩‍🚀 café`);
    const result = boundSubtitleContext(lines.join("\r\n"), "LRC", countTokens);
    expect(result).toBeTruthy();
    expect(countTokens(result)).toBeLessThanOrEqual(SUBTITLE_CONTEXT_TOKEN_LIMIT);
    expect(result.endsWith(lines.at(-1)!)).toBe(true);
    expect(result).not.toContain("第0句");
    for (const line of result.split("\n")) expect(lines).toContain(line);
    expect(result).not.toContain("\uFFFD");
  });

  it("keeps complete SRT blocks and omits a final oversized cue instead of truncating it", () => {
    const cue = (i: number) => `${i}\n00:00:01,000 --> 00:00:02,000\n原文${i} 🙂`;
    const blocks = Array.from({ length: 100 }, (_, i) => cue(i));
    const result = boundSubtitleContext(blocks.join("\n\n"), "SRT", countTokens);
    expect(result).toBeTruthy();
    expect(countTokens(result)).toBeLessThanOrEqual(500);
    expect(result.endsWith(cue(99))).toBe(true);
    for (const block of result.split("\n\n")) expect(blocks).toContain(block);
    expect(boundSubtitleContext(`${cue(1)}\n\n${cue(2)}${"漢字".repeat(2000)}`, "SRT", countTokens)).toBe("");
  });

  it("uses exactly the runtime prompt for a one-fragment estimate", () => {
    const content = "[00:01.00]今日は";
    const options = {fileName: "sample.lrc", content, countTokens, maxTokens: 3000, sourceLang: "JA", targetLang: "EN", translationOutputMode: "target_only" as const};
    const estimate = buildSubtitleTokenEstimate(options);
    const prompt = buildSubtitleTranslationPrompt({...options, format: "LRC", context: {previousSource: "", previousTranslation: ""}});
    expect(estimate.fragmentCount).toBe(1);
    expect(estimate.inputTokens).toBe(countTokens(prompt));
    expect(prompt).toContain("Japanese subtitles into English");
  });

  it("reserves unknown previous translations only for subsequent fragments", () => {
    const content = "[00:01.00]今日は\n[00:02.00]またね";
    const fragments = splitSubtitleContentForEstimate(content, 1, countTokens, "sample.lrc");
    const sourceOnly = fragments.reduce((sum, fragment, index) => sum + countTokens(buildSubtitleTranslationPrompt({format: "LRC", content: fragment, context: {previousSource: fragments[index - 1] ?? "", previousTranslation: ""}})), 0);
    const estimate = buildSubtitleTokenEstimate({content, maxTokens: 1, countTokens, fileName: "sample.lrc"});
    expect(estimate.inputTokens - sourceOnly).toBeGreaterThanOrEqual(500);
    expect(estimate.inputTokens - sourceOnly).toBeLessThan(650);
  });
});
