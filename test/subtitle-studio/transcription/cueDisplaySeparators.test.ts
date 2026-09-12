import { describe, expect, it } from "vitest";
import { restoreFinalLocalSubtitleSeparators as restore } from "../../../electron/main/subtitle-studio/transcription/native/cue-display-separators";
import type { PrefixOverlapView } from "../../../electron/main/subtitle-studio/transcription/native/cue-prefix-overlap-evidence";
import type { LocalSubtitleServerRawSegment } from "../../../electron/main/subtitle-studio/transcription/native/server-contract";

const left = "お話は聞きました", right = "明日は家で休みます";
const cue = { id: "kept", startMs: 1000, endMs: 5700, text: left + right };
function view(id = "a", origin = 0, texts = [left, right], sourceIdentity = "source"): PrefixOverlapView {
  let position = 0;
  const segments: LocalSubtitleServerRawSegment[] = texts.map((text, i) => {
    const tokens = [...text].map(text => ({ text, pointMs: /[、。\s]/u.test(text) ? null : 1100 + (position++) * 200 - origin }));
    return { id: i, text, startMs: i * 2000, endMs: (i + 1) * 2000, dtwTokens: tokens,
      temperature: 0, averageLogProbability: -0.1, noSpeechProbability: 0.01 };
  });
  return { id, sourceIdentity, mode: "uncompressed_non_vad", windowStartMs: origin, windowEndMs: origin + 10000, segments };
}
const pair = () => [view(), view("b", 200, [left + "、" + right])];

describe("final display separators from retained seam observations", () => {
  it("repairs a final cue shorter than six seconds without changing identity, text or time", () => {
    const before = structuredClone(cue), views = pair(), saved = structuredClone(views);
    expect(restore(cue, "source", views)).toEqual({ ...cue, text: left + " " + right });
    expect(cue).toEqual(before); expect(views).toEqual(saved);
  });
  it("is idempotent and preserves existing punctuation and whitespace exactly", () => {
    const restored = restore(cue, "source", pair());
    expect(restore(restored, "source", pair())).toBe(restored);
    for (const separator of ["、", "。", " ", "　"]) {
      const source = { ...cue, text: left + separator + right };
      expect(restore(source, "source", pair())).toBe(source);
    }
  });
  it("uses full groups with leading/trailing context, not arbitrary matching substrings", () => {
    const a = view("a", 0, [left, right]), b = view("b", 200, [left + " " + right]);
    b.segments = [{ ...b.segments[0]!, text: "別の台詞" + b.segments[0]!.text,
      dtwTokens: [{ text: "別の台詞", pointMs: 0 }, ...b.segments[0]!.dtwTokens!] }];
    expect(restore(cue, "source", [a, b])).toBe(cue);
  });
  it("requires two distinct windows and correct media identity", () => {
    const a = view();
    for (const views of [[a], [a, a], [a, view("b")], [a, view("a", 200)],
      [a, view("b", 100)], [a, view("b", 200, [left, right], "other")]])
      expect(restore(cue, "source", views)).toBe(cue);
  });
  it("does not use a DTW gap alone or a separator in only one view", () => {
    const a = view("a", 0, [left + right]), b = view("b", 200, [left + right]);
    for (const v of [a, b]) v.segments[0]!.dtwTokens!.forEach((t, i) => { if (i >= left.length && t.pointMs !== null) t.pointMs += 900; });
    expect(restore(cue, "source", [a, b])).toBe(cue);
    expect(restore(cue, "source", [view(), b])).toBe(cue);
  });
  it("rejects mismatched words, changed kanji, internal quotes and repeated occurrences", () => {
    for (const text of [left + "、" + right.replace("明日", "今日"), left + "、" + right + "別の文",
      left + "「" + right + "」", left + "、" + right + left + right])
      expect(restore(cue, "source", [view(), view("b", 200, [text])])).toBe(cue);
    const repeated = { ...cue, text: cue.text + cue.text };
    expect(restore(repeated, "source", pair())).toBe(repeated);
  });
  it("rejects boundaries inside words, dependent particles and isolated kana", () => {
    for (const at of [2, 4, left.length + 1]) {
      const a = cue.text.slice(0, at), b = cue.text.slice(at);
      expect(restore(cue, "source", [view("a", 0, [a, b]), view("b", 200, [a + "、" + b])])).toBe(cue);
    }
  });
  it("accepts equal-length kana correspondence without replacing the original name", () => {
    const source = { ...cue, text: left + "ミナミは家で休みます" };
    const views = [view("a", 0, [left, "みなみは家で休みます"]), view("b", 200, [left + " みなみは家で休みます"])];
    expect(restore(source, "source", views)).toEqual({ ...source, text: left + " ミナミは家で休みます" });
  });
  it("rejects invalid token coverage, nonmonotone points, unrelated time and excessive views", () => {
    const mutations: ((v: PrefixOverlapView) => void)[] = [
      v => { v.segments[0]!.dtwTokens = []; },
      v => { v.segments[0]!.dtwTokens![2]!.pointMs = null; },
      v => { v.segments[0]!.dtwTokens![2]!.pointMs = -1; },
      v => { v.segments[0]!.dtwTokens![2]!.pointMs = 9999; },
      v => { v.segments[0]!.dtwTokens!.forEach(t => { if (t.pointMs !== null) t.pointMs += 3000; }); },
    ];
    for (const mutate of mutations) { const views = pair(); mutate(views[1]!); expect(restore(cue, "source", views)).toBe(cue); }
    expect(restore(cue, "source", Array.from({ length: 17 }, () => view()))).toBe(cue);
  });
  it("keeps text separators independent from precise onset agreement", () => {
    const views = pair();
    const tokens = views[1]!.segments[0]!.dtwTokens!;
    // The first kana moves, but the following lexical anchor stays at the same
    // source position/time. Neither point becomes a new subtitle timestamp.
    const head = tokens.findIndex(t => t.text === "明");
    tokens[head]!.pointMs! -= 100;
    expect(restore(cue, "source", views)).toEqual({ ...cue, text: left + " " + right });
  });
  it("allows an explicitly separated long lexical gap without assuming silent audio", () => {
    const source = { ...cue, endMs: 14000 }, views = pair();
    for (const v of views) {
      v.windowEndMs = v.windowStartMs + 15000;
      let offset = 0;
      for (const s of v.segments) for (const token of s.dtwTokens!) {
        if (token.pointMs === null) continue;
        if (offset++ >= left.length) token.pointMs += 7000;
      }
    }
    expect(restore(source, "source", views)).toEqual({ ...source, text: left + " " + right });
  });
  it("rejects explicit text separation when the lexical anchors disagree in time", () => {
    const views = pair();
    let offset = 0;
    for (const token of views[1]!.segments[0]!.dtwTokens!) {
      if (token.pointMs === null) continue;
      if (offset++ >= left.length) token.pointMs += 500;
    }
    expect(restore(cue, "source", views)).toBe(cue);
  });
});
