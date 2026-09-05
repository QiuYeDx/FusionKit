import { describe, expect, it } from "vitest";
import { planLocalSubtitleOverlapReview, resolveLocalSubtitleOverlap } from "../../electron/main/local-subtitle/cue-overlap-resolver";
import type { LocalSubtitlePostProcessingWindow } from "../../electron/main/local-subtitle/subtitle-post-processor";
import type { LocalSubtitleServerRawSegment } from "../../electron/main/local-subtitle/server-contract";

const win = (startMs: number, endMs: number, coreStartMs: number, coreEndMs: number, key: string): LocalSubtitlePostProcessingWindow =>
  ({ windowKey: key, rootWindowKey: key, rootPlanId: "test", retryDepth: 0, startMs, endMs, coreStartMs, coreEndMs,
    startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: coreStartMs * 16, coreEndFrame: coreEndMs * 16 });
const raw = (text: string, startMs: number, endMs: number): LocalSubtitleServerRawSegment =>
  ({ id: 0, text, startMs, endMs, temperature: 0, averageLogProbability: -.1, noSpeechProbability: .01 });
const leftText = "ん?なんだどうして", rightText = "ん?何だ?どうしたのって何がだ?";
const input = () => ({ leftWindow: win(0, 30000, 0, 27500, "w0"), rightWindow: win(25000, 55000, 27500, 55000, "w1"),
  leftRaw: [raw(leftText, 24960, 30000)], rightRaw: [raw(rightText, 1350, 6230)],
  cues: [{ id: "left", startMs: 24960, endMs: 27500, text: leftText }, { id: "right", startMs: 27500, endMs: 31230, text: rightText }] });
const witness = (): LocalSubtitleServerRawSegment => ({ ...raw("ん?なんだ どうしたのって何がだ", 4920, 11300),
  dtwTokens: [{ text: "ん?なんだ", pointMs: 6420 }, { text: " どうしたのって何がだ", pointMs: 11060 }] });
const plan = () => planLocalSubtitleOverlapReview(input())!;

describe("cross-window variant arbitration", () => {
  it("requires a third observation and selects the existing complete text once", () => {
    const review = plan();
    expect(review.window).toMatchObject({ startMs: 20000, endMs: 40000, rootWindowKey: "w1.seam", windowKey: "w1.seam" });
    expect(resolveLocalSubtitleOverlap(review, [])).toBeUndefined();
    const result = resolveLocalSubtitleOverlap(review, [witness()])!;
    expect(result.replacement).toEqual({ id: "left.seam", startMs: 24960, endMs: 31230, text: rightText });
    expect(result.evidence).toMatchObject({ discarded: { text: leftText }, selected: { text: rightText }, prefixUnits: 7, suffixUnits: 11 });
  });
  it("accepts the same two-sided evidence pattern on different wording", () => {
    const data = input();
    const l = "あなたはなにを考えていますか私は", r = "あなたは何を考えていますか私も同じことを考えています";
    data.leftRaw[0] = { ...data.leftRaw[0]!, text: l }; data.rightRaw[0] = { ...data.rightRaw[0]!, text: r };
    data.cues[0]!.text = l; data.cues[1]!.text = r;
    const w = { ...witness(), text: "あなたはなにを考えていますか私も同じことを考えています", dtwTokens: [
      { text: "あなたはなにを考えていますか", pointMs: 6400 }, { text: "私も同じことを考えています", pointMs: 11000 }] };
    expect(resolveLocalSubtitleOverlap(planLocalSubtitleOverlapReview(data)!, [w])?.replacement.text).toBe(r);
  });
  it.each(["interior_left", "disjoint", "same_window", "retry", "not_extended", "wrong_owner", "real_repeat", "exact_prefix"])("does not request review for %s", scenario => {
    const data = input();
    if (scenario === "interior_left") data.leftRaw[0] = { ...data.leftRaw[0]!, endMs: 29000 };
    if (scenario === "disjoint") data.rightRaw[0] = { ...data.rightRaw[0]!, startMs: 5500 };
    if (scenario === "same_window") data.rightWindow = data.leftWindow;
    if (scenario === "retry") data.leftWindow = { ...data.leftWindow, retryDepth: 1 };
    if (scenario === "not_extended") data.rightRaw[0] = { ...data.rightRaw[0]!, endMs: 5400 };
    if (scenario === "wrong_owner") data.cues[0]!.startMs++;
    if (scenario === "real_repeat") data.rightRaw[0] = { ...data.rightRaw[0]!, text: leftText };
    if (scenario === "exact_prefix") data.rightRaw[0] = { ...data.rightRaw[0]!, text: leftText + "続きを話します" };
    expect(planLocalSubtitleOverlapReview(data)).toBeUndefined();
  });
  it.each(["missing", "reversed", "collapsed", "out_of_bounds", "coverage"])("rejects invalid token evidence: %s", scenario => {
    const w = witness();
    const tokens = scenario === "missing" ? undefined : scenario === "coverage" ? [] : [
      { text: "ん?なんだ", pointMs: 6420 },
      { text: " どうしたのって何がだ", pointMs: scenario === "reversed" ? 6000 : scenario === "collapsed" ? 6420 : 15000 },
    ];
    expect(resolveLocalSubtitleOverlap(plan(), [{ ...w, dtwTokens: tokens }])).toBeUndefined();
  });
  it("rejects multiple occurrences, including real repetition within one native segment", () => {
    const w = witness();
    expect(resolveLocalSubtitleOverlap(plan(), [w, w])).toBeUndefined();
    expect(resolveLocalSubtitleOverlap(plan(), [w, { ...w, startMs: 12000, endMs: 18000 }])).toBeUndefined();
    expect(resolveLocalSubtitleOverlap(plan(), [{ ...w, text: w.text + w.text, dtwTokens: [...w.dtwTokens!, ...w.dtwTokens!] }])).toBeUndefined();
  });
  it("rejects nearby different speech, unmatched inserted words and shifted timing", () => {
    const w = witness();
    for (const patch of [{ text: "ん?なんだ明日はどこに行きますか" }, { text: "ん?なんだどうし新しい言葉たのって何がだ" },
      { startMs: 4000 }, { endMs: 12000 }])
      expect(resolveLocalSubtitleOverlap(plan(), [{ ...w, ...patch }])).toBeUndefined();
  });
});
