import { describe, expect, it } from "vitest";
import { refineLocalSubtitleCueWithDtw, restoreLocalSubtitleCueSeparators } from "../../../electron/main/subtitle-studio/transcription/native/cue-separator-restorer";
import type { LocalSubtitleServerRawSegment } from "../../../electron/main/subtitle-studio/transcription/native/server-contract";

const original = "あいさつ私は学生です今日は家で勉強しますまた会いましょう";
const cue = { id: "primary", text: original, startMs: 0, endMs: 15000 };
const raw = (text: string, startMs: number, endMs: number): LocalSubtitleServerRawSegment => ({ index: 0, text, startMs, endMs });
function candidate() {
  return [
    { ...raw("え、私は学生です", 0, 5000), dtwTokens: [
      { text: "え", pointMs: 1000 }, { text: "、", pointMs: 1100 }, { text: "私", pointMs: 2000 },
      { text: "は", pointMs: 2500 }, { text: "学生", pointMs: 3000 }, { text: "です", pointMs: 4000 }] },
    { ...raw("今日は家で勉強します", 5000, 10000), dtwTokens: [
      { text: "今日", pointMs: 6000 }, { text: "は", pointMs: 6300 }, { text: "家", pointMs: 6500 },
      { text: "で", pointMs: 6700 }, { text: "勉強", pointMs: 7000 }, { text: "します", pointMs: 8000 }] },
    { ...raw("また会いましょう", 10000, 15000), dtwTokens: [
      { text: "また", pointMs: 10500 }, { text: "会い", pointMs: 11000 }, { text: "ましょう", pointMs: 12000 }] },
  ];
}
const input = () => ({ cue, primary: [raw(original, 0, 15000)], candidate: candidate(), windowStartMs: 0,
  windowDurationMs: 15000, targets: { maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 } });

describe("local anchors at an accepted complete group's head", () => {
  it("adds the head cut, preserving primary words and the existing internal boundary", () => {
    const result = refineLocalSubtitleCueWithDtw(input());
    expect(result.map(c => c.text)).toEqual(["あいさつ私は学生です", "今日は家で勉強します", "また会いましょう"]);
    expect(result.map(c => [c.startMs, c.endMs])).toEqual([[0, 6000], [6000, 10500], [10500, 15000]]);
    expect(result.map(c => c.text).join("")).toBe(original);
  });
  it("does not change the text-only separator consumer", () => {
    const result = restoreLocalSubtitleCueSeparators(input());
    expect(result.text).toBe("あいさつ私は学生です今日は家で勉強します また会いましょう");
    expect([result.startMs, result.endMs]).toEqual([0, 15000]);
  });
  it("keeps old group cuts when the unmatched preceding segment lacks valid timing", () => {
    for (const point of [-1, null, 16000]) {
      const data = input(); data.candidate[0]!.dtwTokens[0]!.pointMs = point as number;
      expect(refineLocalSubtitleCueWithDtw(data).map(c => c.startMs)).toEqual([0, 10500]);
    }
  });
  it("requires a unique left anchor across other primary segments as well", () => {
    const data = input(); data.primary.push(raw("私は学生です", 15000, 18000));
    expect(refineLocalSubtitleCueWithDtw(data).map(c => c.startMs)).toEqual([0, 10500]);
  });
  it("rejects edits at the target neighborhood without discarding the accepted right group", () => {
    const data = input(); data.candidate[0]!.text = "え、私は学生でした";
    data.candidate[0]!.dtwTokens.at(-1)!.text = "でした";
    expect(refineLocalSubtitleCueWithDtw(data).map(c => c.startMs)).toEqual([0, 10500]);
  });
  it("does not move or crowd an existing internal cut to fit the new head", () => {
    const data = input();
    data.candidate[1]!.dtwTokens.forEach((t, i) => { t.pointMs = 6000 + i * 60; });
    data.candidate[2]!.dtwTokens.forEach((t, i) => { t.pointMs = 6500 + i * 500; });
    expect(refineLocalSubtitleCueWithDtw(data).map(c => c.startMs)).toEqual([0, 6500]);
  });
  it("never adopts a partial local match without an accepted complete group", () => {
    const data = input();
    data.candidate = [{ ...raw(data.candidate.map(s => s.text).join("。"), 0, 15000), dtwTokens: [] }];
    expect(refineLocalSubtitleCueWithDtw(data)).toEqual([cue]);
  });
});
