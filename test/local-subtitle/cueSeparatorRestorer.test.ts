import { describe, expect, it } from "vitest";
import { needsLocalSubtitleSeparators, needsLocalSubtitleDtwRefinement, restoreLocalSubtitleCueSeparators, refineLocalSubtitleCueWithDtw } from "../../electron/main/local-subtitle/cue-separator-restorer";
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

const timed = (): LocalSubtitleServerRawSegment[] => [
  { ...raw("今日は、いい天気ですね", 0, 4000), dtwTokens: [
    { text: "今日は", pointMs: 1000 }, { text: "、", pointMs: null },
    { text: "いい天気ですね", pointMs: 3700 },
  ] },
  { ...raw("明日は家で休みます", 4000, 10000, 1), dtwTokens: [
    { text: "明日", pointMs: 4500 }, { text: "は家で休みます", pointMs: 6800 },
  ] },
];
const refine = (parts = timed(), patch: Partial<Parameters<typeof refineLocalSubtitleCueWithDtw>[0]> = {}) =>
  refineLocalSubtitleCueWithDtw({ cue, primary, candidate: parts, windowStartMs: 1000, windowDurationMs: 10000, targets, ...patch });

describe("DTW cue activation with exact source coverage", () => {
  it.each(["そなたが", "あなたは", "こなたに", "どなたを", "あそこで"])("keeps a complete demonstrative together when ICU splits its kana: %s", prefix => {
    const left = "お話は聞きました", right = prefix + "お待ちください";
    const original = left + right;
    const parts = [
      { ...raw(left, 0, 4000), dtwTokens: [{ text: left, pointMs: 3700 }] },
      { ...raw(right, 4000, 10000), dtwTokens: [{ text: right.slice(0, 1), pointMs: 4500 }, { text: right.slice(1), pointMs: 6800 }] },
    ];
    const result = refine(parts, { cue: { ...cue, text: original }, primary: [raw(original, 0, 10000)] });
    expect(result.map(c => c.text)).toEqual([left, right]);
    expect(result.map(c => [c.startMs, c.endMs])).toEqual([[1000, 5500], [5500, 11000]]);
    const noTiming = parts.map(part => ({ ...part, dtwTokens: undefined }));
    expect(refine(noTiming, { cue: { ...cue, text: original }, primary: [raw(original, 0, 10000)] }))
      .toEqual([{ ...cue, text: left + " " + right }]);
    const withinOneNativeSegment = [{ ...raw(original, 0, 10000), dtwTokens: parts.flatMap(part => part.dtwTokens) }];
    expect(refine(withinOneNativeSegment, { cue: { ...cue, text: original }, primary: [raw(original, 0, 10000)] }))
      .toEqual([{ ...cue, text: original }]);
  });
  it.each([["そ", "なたが"], ["そな", "たが"], ["そ", "うだと"], ["", "あこが"], ["", "そなたちが"]])("rejects kana fragments and near-miss pronouns despite valid times: %s / %s", (tail, head) => {
    const left = "お話は聞きました" + tail, right = head + "お待ちください";
    const original = left + right, custom = { ...cue, text: original };
    const parts = [
      { ...raw(left, 0, 4000), dtwTokens: [{ text: left, pointMs: 3700 }] },
      { ...raw(right, 4000, 10000), dtwTokens: [{ text: right.slice(0, 1), pointMs: 4500 }, { text: right.slice(1), pointMs: 6800 }] },
    ];
    expect(refine(parts, { cue: custom, primary: [raw(original, 0, 10000)] })).toEqual([custom]);
  });
  it.each(["。", "?", "！"])("uses an existing sentence boundary without dropping its punctuation: %s", punctuation => {
    const original = "今日はいい天気ですね" + punctuation + "明日は家で休みます";
    const custom = { ...cue, text: original };
    const parts = timed();
    parts[0] = { ...parts[0]!, text: "今日はいい天気ですね" + punctuation, dtwTokens: [
      { text: "今日はいい天気ですね", pointMs: 3700 }, { text: punctuation, pointMs: null },
    ] };
    const result = refine(parts, { cue: custom, primary: [raw(original, 0, 10000)] });
    expect(needsLocalSubtitleSeparators(custom)).toBe(false);
    expect(needsLocalSubtitleDtwRefinement(custom)).toBe(true);
    expect(result.map(c => c.text)).toEqual(["今日はいい天気ですね" + punctuation, "明日は家で休みます"]);
    expect(result.map(c => [c.startMs, c.endMs])).toEqual([[1000, 5500], [5500, 11000]]);
    expect(restore({ cue: custom, primary: [raw(original, 0, 10000)], candidate: parts })).toBe(custom);
    parts[1] = { ...parts[1]!, dtwTokens: [] };
    expect(refine(parts, { cue: custom, primary: [raw(original, 0, 10000)] }).map(c => [c.startMs, c.endMs])).toEqual([[1000, 11000]]);
  });
  it("does not let existing punctuation authorize deletion, short-cue requests or quoted-sentence cuts", () => {
    const original = "今日はいい天気ですね。明日は家で休みます";
    const custom = { ...cue, text: original };
    expect(refine(timed(), { cue: custom, primary: [raw(original, 0, 10000)] })).toEqual([custom]);
    expect(needsLocalSubtitleDtwRefinement({ ...custom, endMs: 4000 })).toBe(false);
    for (const text of ["「今日はいい天気ですね。明日は家で休みます」", "今日はいい天気ですね（明日は家で休みます?）"])
      expect(needsLocalSubtitleDtwRefinement({ ...custom, text })).toBe(false);
  });
  it("can separate a later unpunctuated sentence even if an earlier sentence already has punctuation", () => {
    const original = "今日はいい天気ですね。明日は家で休みます";
    const parts = [{ ...raw(original, 0, 10000), dtwTokens: [
      { text: "今日はいい天気ですね", pointMs: 3700 }, { text: "。", pointMs: null },
      { text: "明日は家で休みます", pointMs: 4500 },
    ] }];
    const result = refine(parts, { cue: { ...cue, text: original }, primary: [raw(original, 0, 10000)] });
    expect(result.map(c => c.text).join("")).toBe(original);
    expect(result).toHaveLength(2);
  });
  it("splits at the independent token point and keeps parent bounds and original words", () => {
    const result = refine();
    expect(result).toEqual([
      { id: "cue-1.dtw1", startMs: 1000, endMs: 5500, text: "今日は、いい天気ですね" },
      { id: "cue-1.dtw2", startMs: 5500, endMs: 11000, text: "明日は家で休みます" },
    ]);
    expect(result.map(c => c.text).join("").replace("、", "")).toBe(text);
    expect(refine(timed(), { targets: { ...targets, maxCueDurationMs: 2000 } }).map(c => [c.startMs, c.endMs])).toEqual(result.map(c => [c.startMs, c.endMs]));
  });
  it.each([null, -1, 3700, 6700, 11000, 4000.5])("retains text separators when a point is missing, degenerate or invalid: %s", pointMs => {
    const parts = timed(); parts[1] = { ...parts[1]!, dtwTokens: [{ text: "明日", pointMs }, { text: "は家で休みます", pointMs: 6800 }] };
    expect(refine(parts)).toEqual([restore()]);
  });
  it("rejects incomplete word coverage and contradictory earlier points", () => {
    const parts = timed(); parts[0] = { ...parts[0]!, dtwTokens: [{ text: parts[0]!.text, pointMs: 8000 }] };
    expect(refine(parts)).toEqual([restore()]);
    parts[0] = { ...parts[0]!, dtwTokens: [{ text: "wrong", pointMs: 1000 }] };
    expect(refine(parts)).toEqual([restore()]);
  });
  it("does not cut on a comma or through a token even when DTW values are valid", () => {
    const parts = [{ ...raw("今日は、いい天気ですね、明日は家で休みます", 0, 10000), dtwTokens: [
      { text: "今日は", pointMs: 1000 }, { text: "、", pointMs: null }, { text: "いい天気ですね", pointMs: 3700 },
      { text: "、", pointMs: null }, { text: "明日は家で休みます", pointMs: 4500 },
    ] }];
    expect(refine(parts)).toHaveLength(1);
  });
  it("requires primary ownership and never replaces changed candidate words", () => {
    const parts = timed(); parts[1] = { ...parts[1]!, text: "明日は外で遊びます" };
    expect(refine(parts)).toEqual([cue]);
    expect(refine(timed(), { primary: [] })).toEqual([cue]);
  });
  it("does not trim original whitespace by moving it onto a new cue edge", () => {
    const original = "今日はいい天気ですね 明日は家で休みます";
    const parts = [{ ...raw("今日はいい天気ですね 。明日は家で休みます", 0, 10000), dtwTokens: [
      { text: "今日はいい天気ですね ", pointMs: 3700 }, { text: "。", pointMs: null },
      { text: "明日は家で休みます", pointMs: 4500 },
    ] }];
    expect(refine(parts, { cue: { ...cue, text: original }, primary: [raw(original, 0, 10000)] })).toEqual([{ ...cue, text: original }]);
  });
});

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
