import { expect, it } from "vitest";
import { inspectLocalPrefixSeparators } from "../../electron/main/local-subtitle/cue-local-anchor-evidence";
import { refineLocalSubtitleCueWithDtw, restoreLocalSubtitleCueSeparators } from "../../electron/main/local-subtitle/cue-separator-restorer";

const text = "おはようございます私は学生です今日は家で勉強しますまた会いましょう";
const source = { text, startMs: 0, endMs: 15000 };
const cue = { ...source, id: "primary" };
const raw = (text: string, startMs: number, endMs: number) => ({ index: 0, text, startMs, endMs });
const view = () => ({ windowStartMs: 0, windowEndMs: 15000, segments: [
  raw("え、おはようございます。", 0, 3000), raw("ん、私は学生です", 3000, 5000),
  raw("今日は家で勉強します", 5000, 10000), raw("また会いましょう", 10000, 15000),
] });
const head = text.indexOf("今日");
const inspect = (v = view(), s = source, limit = head) => inspectLocalPrefixSeparators(s, v, limit);

it("records unmatched candidate content but inserts only a neutral source separator", () => {
  const result = inspect();
  expect(result).toHaveLength(1);
  expect(result[0]!.offset).toBe(text.indexOf("私"));
  expect(result[0]!.unmatchedCandidate).toBe("ん");
  expect(result[0]).not.toHaveProperty("pointMs");
});

it("uses a source-word boundary despite a changed lead-in, never a kana contraction", () => {
  const v = view();
  v.segments[0]!.text = "あ、もしもし?";
  const s = { ...source, text: text.replace("おはようございます", "ああもしもし") };
  expect(inspect(v, s, s.text.indexOf("今日"))[0]!.offset).toBe(6);
  v.segments[0]!.text = "あ、もしもしー。";
  expect(inspect(v, s, s.text.indexOf("今日"))).toEqual([]);
});

it("requires explicit native sentence-final punctuation, not a comma or pause", () => {
  for (const ending of ["、", "", "。」"]) {
    const v = view(); v.segments[0]!.text = "え、おはようございます" + ending;
    expect(inspect(v)).toEqual([]);
  }
});

it("rejects repeated left and right anchors in other primary or candidate positions", () => {
  for (const extra of ["おはようございます", "私は学生です今日は家で勉強します"]) {
    expect(inspectLocalPrefixSeparators({ ...source, contextText: text + extra }, view(), head)).toEqual([]);
    const v = view(); v.segments[3]!.text += extra;
    expect(inspect(v)).toEqual([]);
  }
});

it("rejects target-neighborhood changes and excessive unmatched candidate content", () => {
  for (const prefix of ["ん、僕は学生です", "いろいろな余計な内容私は学生です"]) {
    const v = view(); v.segments[1]!.text = prefix;
    expect(inspect(v)).toEqual([]);
  }
});

it("preserves already readable source boundaries and avoids quoted source text", () => {
  for (const boundary of [" ", "。", "?", "\n"]) {
    const s = { ...source, text: text.replace("私", boundary + "私") };
    expect(inspect(view(), s, s.text.indexOf("今日"))).toEqual([]);
  }
  expect(inspect(view(), { ...source, text: `「${text}」` })).toEqual([]);
});

it("does not use the complete group's head or a short left anchor", () => {
  expect(inspect(view(), source, text.indexOf("私"))).toEqual([]);
  const s = { ...source, text: text.replace("おはようございます", "はい") };
  const v = view(); v.segments[0]!.text = "え、はい。";
  expect(inspect(v, s, s.text.indexOf("今日"))).toEqual([]);
});

it("keeps all original words and times when DTW is absent or unreliable", () => {
  const input = { cue, primary: [raw(text, 0, 15000)], candidate: view().segments, windowStartMs: 0,
    windowDurationMs: 15000, targets: { maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 } };
  const expected = "おはようございます 私は学生です今日は家で勉強します また会いましょう";
  expect(restoreLocalSubtitleCueSeparators(input).text).toBe(expected);
  expect(refineLocalSubtitleCueWithDtw(input)).toEqual([{ ...cue, text: expected }]);
  expect(expected.replaceAll(" ", "")).toBe(text);
});

it("bounds work and rejects invalid native ranges", () => {
  const v = view(); v.windowEndMs = NaN;
  expect(inspect(v)).toEqual([]);
  v.windowEndMs = 15000; v.segments[1]!.startMs = 1000;
  expect(inspect(v)).toEqual([]);
  const long = view(); long.segments = Array.from({ length: 129 }, () => long.segments[0]!);
  expect(inspect(long)).toEqual([]);
});
