import { describe, expect, it } from "vitest";
import {
  assessLocalSubtitleReviewCandidate,
  planLocalSubtitleReview,
  type ReviewSegment,
} from "../../electron/main/local-subtitle/local-review";

const segment = (startMs: number, endMs: number, text = "a"): ReviewSegment => ({startMs, endMs, text});

describe("bounded local subtitle review plans", () => {
  it("leaves ordinary and empty timelines without extra work, without calling them silence", () => {
    for (const segments of [[], [segment(100, 2000, "ordinary")]]) {
      expect(planLocalSubtitleReview({durationMs: 30_000, segments})).toMatchObject({
        windows: [], concerns: [], totalAudioMs: 0, evidence: "review_hints_only",
      });
    }
  });

  it("retains a long raw interval once, keeps text private and leaves input unchanged", () => {
    const segments = Object.freeze([Object.freeze(segment(3840, 25340, "private words"))]);
    const plan = planLocalSubtitleReview({durationMs: 30_000, segments});
    expect(plan.concerns).toEqual([{startMs: 3840, endMs: 25340, kind: "long_segment"}]);
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]).toMatchObject({startMs: 1840, endMs: 27340, concernIndexes: [0]});
    expect(JSON.stringify(plan)).not.toContain("private words");
    expect(segments[0]).toEqual(segment(3840, 25340, "private words"));
    expect(Object.isFrozen(plan.windows[0]?.concernIndexes)).toBe(true);
  });

  it("merges adjacent syllable concerns with context rather than decoding tiny islands", () => {
    const plan = planLocalSubtitleReview({durationMs: 30_000, segments: [], humanConcerns: [
      {startMs: 8200, endMs: 8780}, {startMs: 9180, endMs: 9380},
    ]});
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.startMs).toBeLessThanOrEqual(6200);
    expect(plan.windows[0]!.endMs).toBeGreaterThanOrEqual(11380);
    expect(plan.windows[0]!.concernIndexes).toEqual([0, 1]);
    expect(plan.totalAudioMs).toBeGreaterThanOrEqual(8000);
  });

  it("includes a surrounding cue when it fits and clamps both media edges", () => {
    const plan = planLocalSubtitleReview({durationMs: 20_000, segments: [segment(4000, 14000)],
      humanConcerns: [{startMs: 8500, endMs: 8600}]});
    expect(plan.windows[0]).toMatchObject({startMs: 4000, endMs: 14000});
    for (const concern of [{startMs: 0, endMs: 100}, {startMs: 1900, endMs: 2000}]) {
      const short = planLocalSubtitleReview({durationMs: 2000, segments: [], humanConcerns: [concern]});
      expect(short.windows[0]).toMatchObject({startMs: 0, endMs: 2000});
    }
  });

  it("bounds count and total audio while explicitly deferring unprocessed concerns", () => {
    const short = planLocalSubtitleReview({durationMs: 200_000, segments: [], humanConcerns:
      Array.from({length: 6}, (_, index) => ({startMs: 1000 + index * 30000, endMs: 2000 + index * 30000}))});
    expect(short.windows).toHaveLength(4);
    expect(short.deferredConcernCount).toBe(2);
    const long = planLocalSubtitleReview({durationMs: 200_000, segments:
      Array.from({length: 4}, (_, index) => segment(2000 + index * 40000, 27000 + index * 40000, String(index)))});
    expect(long.windows).toHaveLength(2);
    expect(long.totalAudioMs).toBe(58_000);
    expect(long.deferredConcernCount).toBe(2);
  });

  it("gives human feedback budget priority and never splits an overlong concern", () => {
    const plan = planLocalSubtitleReview({durationMs: 200_000,
      segments: [segment(0, 40000, "long"), segment(45000, 70000, "first"), segment(80000, 105000, "second")],
      humanConcerns: [{startMs: 150000, endMs: 151000}]});
    expect(plan.windows.some(window => window.startMs <= 150000 && window.endMs >= 151000)).toBe(true);
    expect(plan.deferredConcernCount).toBeGreaterThan(0);
    expect(plan.windows.every(window => window.endMs - window.startMs <= 30000)).toBe(true);
  });

  it("flags repeated text for review but does not call real repetition hallucination", () => {
    const repeated = [segment(0, 2000, "ふぅー"), segment(4000, 6000, "ふぅー"), segment(8000, 10000, "ふぅー")];
    expect(planLocalSubtitleReview({durationMs: 18000, segments: repeated}).concerns[0]?.kind).toBe("repeated_text");
    const distant = repeated.map((item, index) => ({...item, startMs: index * 10000, endMs: index * 10000 + 2000}));
    expect(planLocalSubtitleReview({durationMs: 30000, segments: distant}).concerns).toEqual([]);
  });

  it("limits retained concerns and reports overflow instead of dropping it silently", () => {
    const plan = planLocalSubtitleReview({durationMs: 3_000_000, segments:
      Array.from({length: 130}, (_, index) => segment(index * 20000, index * 20000 + 16000, String(index)))});
    expect(plan.concerns).toHaveLength(128);
    const covered = plan.windows.reduce((sum, window) => sum + window.concernIndexes.length, 0);
    expect(covered + plan.deferredConcernCount).toBe(130);
  });

  it("plans acoustic review for estimated display timing even below the long-span threshold", () => {
    const plan = planLocalSubtitleReview({durationMs: 30000, segments: [segment(8390, 19410, "same sentence")],
      estimatedTimingConcerns: [{startMs: 8390, endMs: 13900}, {startMs: 13900, endMs: 19410}]});
    expect(plan.concerns.map(concern => concern.kind)).toEqual(["estimated_display_timing", "estimated_display_timing"]);
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.startMs).toBeLessThanOrEqual(8390);
    expect(plan.windows[0]!.endMs).toBeGreaterThanOrEqual(19410);
  });

  it.each([
    {segments: [segment(1000, 500)]},
    {segments: [segment(0, 1000), segment(500, 2000)]},
    {segments: [segment(0, NaN)]},
    {segments: [], humanConcerns: [{startMs: -1, endMs: 100}]},
  ])("rejects invalid source geometry without including source text in errors", input => {
    expect(() => planLocalSubtitleReview({durationMs: 30000, ...input})).toThrow(/Invalid/);
  });
});

describe("local candidate comparison", () => {
  const source = [segment(10000, 13000, "hello")];
  const plan = planLocalSubtitleReview({durationMs: 30000, segments: source, humanConcerns: [{startMs: 11000, endMs: 12000}]});
  const window = plan.windows[0]!;
  const assess = (segments: readonly ReviewSegment[], sourceSegments = source) => assessLocalSubtitleReviewCandidate({
    durationMs: 30000, sourceSegments, window, candidate: {windowKey: window.windowKey, sourceFingerprint: plan.sourceFingerprint, segments},
  });

  it("maps from the local origin and requires acoustic review even for identical text", () => {
    const result = assess([segment(10000 - window.startMs, 14000 - window.startMs, "hello")]);
    expect(result.projectedSegments).toEqual([segment(10000, 14000, "hello")]);
    expect(result.textRelation).toBe("same_whitespace_normalized_text");
    expect(result.risks).toContain("timing_changed");
    expect(result.automaticReplacementAllowed).toBe(false);
    expect(result.acousticVerification).toBe("unverified");
  });

  it("keeps a fully identical candidate unverified and does not infer semantic truth", () => {
    const result = assess([segment(10000-window.startMs, 13000-window.startMs, "hello")]);
    expect(result.risks).toEqual([]);
    expect(result.automaticReplacementAllowed).toBe(false);
  });

  it("compares text independently of segmentation and marks added text and empty output", () => {
    expect(assess([segment(10000-window.startMs, 11000-window.startMs, "he"), segment(11000-window.startMs, 13000-window.startMs, "llo")]).textRelation).toBe("same_whitespace_normalized_text");
    expect(assess([segment(0, 1000, "new words")]).risks).toContain("text_changed");
    expect(assess([]).risks).toContain("empty_candidate");
    expect(assess([]).automaticReplacementAllowed).toBe(false);
  });

  it("flags repeated and window-edge candidates without deleting them", () => {
    const result = assess([segment(0, 1000, "ah"), segment(1500, 2500, "ah"), segment(3000, 4000, "ah")]);
    expect(result.risks).toEqual(expect.arrayContaining(["repeated_text", "touches_window_edge"]));
    expect(result.projectedSegments).toHaveLength(3);
  });

  it("refuses stale text, stale timing and a response from another window", () => {
    expect(() => assess([], [segment(10000, 13000, "changed")])).toThrow(/Stale/);
    expect(() => assess([], [segment(10000, 13001, "hello")])).toThrow(/Stale/);
    expect(() => assessLocalSubtitleReviewCandidate({durationMs: 30000, sourceSegments: source, window,
      candidate: {windowKey: "wrong", sourceFingerprint: plan.sourceFingerprint, segments: []}})).toThrow(/mismatched/);
  });

  it.each([
    [segment(-1, 1000)], [segment(0, 31000)], [segment(0, Infinity)],
    [segment(0, 2000), segment(1500, 3000)],
  ])("rejects invalid candidate timing before projection", segments => {
    expect(() => assess(segments)).toThrow(/Invalid/);
  });

  it("detects a candidate overlapping an original cue that extends outside its window", () => {
    const sourceSegments = [segment(0, 60000, "original")];
    const local = planLocalSubtitleReview({durationMs: 60000, segments: sourceSegments, humanConcerns: [{startMs: 30000, endMs: 31000}]}).windows[0]!;
    const result = assessLocalSubtitleReviewCandidate({durationMs: 60000, sourceSegments, window: local,
      candidate: {sourceFingerprint: local.sourceFingerprint, windowKey: local.windowKey, segments: [segment(0, 2000, "partial")]}});
    expect(result.risks).toEqual(expect.arrayContaining(["source_crosses_window_edge", "overlaps_outside_source"]));
  });
});
