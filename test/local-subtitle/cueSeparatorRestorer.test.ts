import { describe, expect, it } from "vitest";
import { needsLocalSubtitleSeparators, restoreLocalSubtitleCueSeparators } from "../../electron/main/local-subtitle/cue-separator-restorer";
import type { LocalSubtitleServerRawSegment } from "../../electron/main/local-subtitle/server-contract";

const text = "今日はいい天気ですね明日は家で休みます";
const cue = { id: "cue-1", text, startMs: 1000, endMs: 11000 };
const raw = (text: string, startMs: number, endMs: number, id = 0): LocalSubtitleServerRawSegment => ({
  id, text, startMs, endMs, temperature: 0, averageLogProbability: -0.1, noSpeechProbability: 0.01,
});
const targets = { maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 };
const primary = [raw(text, 0, 10000)];
const candidate = [raw("今日は、いい天気ですね", 0, 4000), raw("明日は家で休みます", 4000, 10000, 1)];
const restore = (patch: Partial<Parameters<typeof restoreLocalSubtitleCueSeparators>[0]> = {}) =>
  restoreLocalSubtitleCueSeparators({ cue, primary, candidate, windowStartMs: 1000, targets, ...patch });

describe("insertion-only Japanese cue separators", () => {
  it("uses exact primary text plus native separators without changing parent times", () => {
    const result = restore();
    expect(result.text).toBe("今日は、いい天気ですね 明日は家で休みます");
    expect({ ...result, text: cue.text }).toEqual(cue);
  });

  it("does not replace a primary segment when the candidate changes even one word", () => {
    expect(restore({ candidate: [raw("今日は、悪い天気ですね明日は家で休みます", 0, 10000)] })).toBe(cue);
    expect(restore({ candidate: [raw("こんにちは" + text, 0, 10000)] })).toBe(cue);
  });

  it("requires exact parent ownership, including both times", () => {
    expect(restore({ primary: [raw(text, 100, 10000)] })).toBe(cue);
    expect(restore({ primary: [raw(text, 0, 9000)] })).toBe(cue);
    expect(restore({ primary: [primary[0]!, primary[0]!] })).toBe(cue);
  });

  it("restores only the interior of a unique exact native group when other segments disagree", () => {
    const original = "おはようございます" + text + "また会いましょう";
    const custom = { ...cue, text: original };
    const result = restore({ cue: custom, primary: [raw(original, 0, 10000)],
      candidate: [raw("こんにちは", 0, 1000), ...candidate, raw("さようなら", 9000, 10000)] });
    expect(result.text).toBe("おはようございます今日は、いい天気ですね 明日は家で休みますまた会いましょう");
    expect({ ...result, text: original }).toEqual(custom);
  });

  it("rejects ambiguous partial groups and does not mine substrings from changed native segments", () => {
    const original = "おはようございます" + text + "また会いましょう";
    const custom = { ...cue, text: original };
    expect(restore({ cue: custom, primary: [raw(original, 0, 10000)],
      candidate: [...candidate, ...candidate] })).toBe(custom);
    expect(restore({ cue: custom, primary: [raw(original, 0, 10000)],
      candidate: [raw("こんにちは今日は、いい天気ですね明日は家で休みます", 0, 10000)] })).toBe(custom);
    expect(restore({ candidate: [raw("今日は、いい", 0, 1000)] })).toBe(cue);
  });

  it("preserves original punctuation and spaces rather than normalizing them away", () => {
    for (const original of [text.replace("ですね", "ですね、"), text.replace("ですね", "ですね ")]) {
      const custom = { ...cue, text: original };
      expect(restore({ cue: custom, primary: [raw(original, 0, 10000)] })).toBe(custom);
    }
  });

  it("requires the entire candidate context to map before applying interior punctuation", () => {
    const context = [raw("おはよう", 0, 1000), raw(text, 1000, 11000), raw("またね", 11000, 12000)];
    const custom = { ...cue, startMs: 1000, endMs: 11000 };
    const result = restore({ cue: custom, primary: context, windowStartMs: 0,
      candidate: [raw("おはよう今日は、いい天気ですね明日は家で休みますまたね", 0, 12000)] });
    expect(result.text).toContain("今日は、");
    expect(result.text).not.toContain("おはよう");
    expect(restore({ cue: custom, primary: context, windowStartMs: 0,
      candidate: [raw("嘘の前文今日は、いい天気ですね明日は家で休みますまたね", 0, 12000)] })).toBe(custom);
  });

  it("does not create separators at dependent endings or single-kana word fragments", () => {
    for (const [left, right] of [["私は誰", "だと思いますか"], ["これはそ", "なたへの贈り物です"], ["私はそ", "うだと思っています"]]) {
      const original = left! + right!, custom = { ...cue, text: original };
      expect(restore({ cue: custom, primary: [raw(original, 0, 10000)],
        candidate: [raw(left!, 0, 5000), raw(right!, 5000, 10000)] })).toBe(custom);
    }
  });

  it("keeps honorific prefixes with their noun when accepting an observed comma", () => {
    const original = "そうですねお兄さんはこちらに来てください";
    const custom = { ...cue, text: original };
    const result = restore({ cue: custom, primary: [raw(original, 0, 10000)],
      candidate: [raw("そうですね、お兄さんはこちらに来てください", 0, 10000)] });
    expect(result.text).toBe("そうですね、お兄さんはこちらに来てください");
  });

  it("keeps already punctuated, short, non-Japanese and multiline cues unchanged", () => {
    for (const original of ["", "はい", "Hello there welcome to the meeting", "今日はいい天気ですね。明日は休みです。", "今日はいい天気ですね\n明日は家で休みます"]) {
      const custom = { ...cue, text: original };
      expect(needsLocalSubtitleSeparators(custom)).toBe(false);
      expect(restore({ cue: custom })).toBe(custom);
    }
  });

  it("fails closed on ambiguous repeated candidate occurrences and resource limits", () => {
    expect(restore({ candidate: [...candidate, ...candidate] })).toBe(cue);
    expect(restore({ primary: [...primary, raw(text, 12000, 22000, 1)] })).toBe(cue);
    expect(restore({ primary: Array.from({ length: 129 }, () => primary[0]!) })).toBe(cue);
    expect(restore({ candidate: [raw("あ".repeat(8193), 0, 10000)] })).toBe(cue);
  });
});
