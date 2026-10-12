import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, excerptTitle, normalizeManualTitle } from "./session-title";

describe("session titles", () => {
  it("cuts the first non-empty line of the first message", () => {
    expect(excerptTitle("\n  把工作台里还没翻译的日语字幕翻成中文  \n第二行")).toBe("把工作台里还没翻译的日语字幕翻成中文");
    expect(excerptTitle("a".repeat(30))).toBe(`${"a".repeat(24)}…`);
    expect(excerptTitle("hello   there\tfriend")).toBe("hello there friend");
  });
  it("never splits a surrogate pair or an emoji sequence", () => {
    const title = excerptTitle("👨‍👩‍👧".repeat(30));
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title.slice(0, -1)))).toHaveLength(24);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("reduces a model answer to a short clean title", () => {
    expect(cleanGeneratedTitle("“日语字幕翻译成中文。”")).toBe("日语字幕翻译成中文");
    expect(cleanGeneratedTitle("Title: **Convert LRC to SRT**\nmore")).toBe("Convert LRC to SRT");
    expect(cleanGeneratedTitle("《绝区零》译名整理")).toBe("《绝区零》译名整理");
    expect(cleanGeneratedTitle("「鬼灭」字幕翻译")).toBe("「鬼灭」字幕翻译");
    expect(cleanGeneratedTitle("。。。")).toBe("");
    expect(cleanGeneratedTitle("")).toBe("");
  });
  it("keeps every title within the saved length, even when graphemes are long", () => {
    const family = "👨‍👩‍👧‍👦";
    for (const title of [normalizeManualTitle(family.repeat(80)), excerptTitle(family.repeat(80)), cleanGeneratedTitle(family.repeat(80))]) {
      expect(title.length).toBeLessThanOrEqual(200);
      expect(title.replace("…", "").length % family.length).toBe(0);
    }
  });
  it("normalizes a typed title and treats blank as no change", () => {
    expect(normalizeManualTitle("  新的   名字 ")).toBe("新的 名字");
    expect(normalizeManualTitle("   ")).toBe("");
  });
});
