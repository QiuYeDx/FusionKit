import { describe, expect, it } from 'vitest';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../../src/subtitle-studio/transcription/domain';
import type { LocalSubtitleServerRawSegment as Raw } from '../../../electron/main/subtitle-studio/transcription/native/server-contract';
import {
  assessLocalSubtitleRawWindow,
  createSubtitlePostProcessPolicy,
  decideLocalSubtitleWindowRetry,
  dropLocalSubtitleSeamDuplicates,
  planLocalSubtitleRootWindows,
  postProcessLocalSubtitleTranscript,
  type LocalSubtitlePostProcessingWindow as Window,
  type LocalSubtitlePostProcessingWindowAttempt as Attempt,
  type LocalSubtitleRootWindowPlan,
} from '../../../electron/main/subtitle-studio/transcription/native/subtitle-post-processor';

// 2026-10-23 asr-quality T-ASRQ-11: the shapes follow the seam duplicates found in the
// real-audio comparison run of T-ASRQ-09; all wording here is invented.
// 2026-10-24: the far-end guard and edge restore shapes follow the T-ASRQ-11 rerun; the
// trimmed repeat (T-ASRQ-14) follows the long copy that rerun kept at the 177.50 s seam.
const policy = createSubtitlePostProcessPolicy({
  advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500, maxCueDurationMs: 7_000, maxCueChars: 84, maxLineChars: 42 },
  vad: { enabled: true, modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id, tokenTimestamps: false,
    timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy },
  rawQualityGate: {
    maxSegmentDurationMs: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
    repeatedCueThreshold: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
    repeatedCoverageMs: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
    maxRetryDepth: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth,
  },
});
const MODEL = { engine: 'whisper_cpp' as const, modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
  modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256, backend: 'cpu' as const };

function raw(startMs: number, endMs: number, text: string, id = 0): Raw {
  return { id, startMs, endMs, text, temperature: 0, averageLogProbability: -0.25, noSpeechProbability: 0.01 };
}
function attempt(window: Window, segments: readonly Raw[], index: number): Attempt {
  return { window, windowAttempt: index + 1, processEpoch: 1, requestGeneration: index + 1, response: {
    requestGeneration: index + 1, sessionDisposition: 'reusable', result: {
      contractVersion: 1, task: 'transcribe', language: 'japanese', durationMs: window.endMs - window.startMs,
      text: segments.map(segment => segment.text).join(' ').trim(), segments,
      wordTimelineStatus: 'discarded_vad_compressed_timeline',
    },
  } };
}
function run(rootPlan: LocalSubtitleRootWindowPlan, totalFrames: number, perWindow: readonly (readonly Raw[])[],
  windows: readonly Window[] = rootPlan.windows) {
  expect(windows).toHaveLength(perWindow.length);
  return postProcessLocalSubtitleTranscript({
    source: { displayName: 'sample.wav', durationMs: Math.round(totalFrames / 16), totalFrames, sampleRateHz: 16_000 },
    model: MODEL, taskMode: 'transcribe', policy, rootPlan,
    attempts: windows.map((window, index) => attempt(window, perWindow[index]!, index)),
  });
}
/** [0, 30] and [25, 55] s windows owning [0, 27.5) and [27.5, 55] s; right raw times are window-relative. */
function seam(left: readonly Raw[], right: readonly Raw[]) {
  const result = run(planLocalSubtitleRootWindows({ rootPlanId: 'plan-001', totalFrames: 55_000 * 16, policy }), 55_000 * 16, [left, right]);
  const cues = result.transcript.segments;
  const { segments: kept, dropped } = dropLocalSubtitleSeamDuplicates(cues, result.report.seamDuplicates, cues);
  return { result, cues, kept, dropped };
}
const except = <T>(values: readonly T[], ...indices: number[]) => values.filter((_, index) => !indices.includes(index));
const twoCuesThenCopy = (tailEndMs = 27_900) => seam(
  [raw(23_800, 25_600, '明天上午', 0), raw(25_600, tailEndMs, '我们一起去图书馆', 1)],
  [raw(200, 3_200, '明天上午，我们一起去图书馆', 0), raw(3_200, 8_600, '如果下雨就改到下周再去', 1)],
);
/** The previous window's longer variant goes; the next window's copy is clipped to start at the seam. */
const variantBeforeSeam = (rightStartMs: number) => seam(
  [raw(23_100, 25_390, '要不要喝茶', 0), raw(25_390, 27_900, '好的呀，知道', 1)],
  [raw(rightStartMs, 3_080, '好的知道', 0), raw(3_080, 6_660, '还有水', 1)],
);
/** The next window's long copy is kept for its last two characters and opens with the whole cue before the fragment. */
const longCopyAfterCue = (before = '作为守护这座城市的人', copy = '作为守护这座城市的人，我们绝不能让大家失望') => seam(
  [raw(23_700, 27_420, before, 0), raw(27_420, 28_600, '我们绝不能让大家', 1)],
  [raw(200, 6_000, copy, 0)],
);
/** The previous window's long copy is kept for its first seven characters and closes with the whole cue after the fragment. */
const longCopyBeforeCue = (after = '晚上一起吃饭', copyStartMs = 24_000) => seam(
  [raw(copyStartMs, 28_800, '大家先别急着走，晚上一起吃饭', 0)],
  [raw(1_000, 2_700, '别急着走', 0), raw(3_000, 4_500, after, 1)],
);
const failed: readonly Raw[] = [raw(100, 100, '无效')];
/** The retry children of a window whose attempt failed. */
function split(window: Window, index: number) {
  const retry = decideLocalSubtitleWindowRetry({ attempt: attempt(window, failed, index), policy,
    assessment: assessLocalSubtitleRawWindow({ window, result: attempt(window, failed, index).response.result, policy }) });
  if (retry.action !== 'split') throw new Error(`Expected a split, got ${retry.action}`);
  return retry.children;
}

describe('window seam duplicates', () => {
  it("drops the next window's 0.7 s copy of the previous two cues and gives the clipped tail it repeats its raw end", () => {
    const { result, cues, kept, dropped } = twoCuesThenCopy();
    expect(cues.map(cue => [cue.startMs, cue.endMs])).toEqual([[23_800, 25_600], [25_600, 27_500], [27_500, 28_200], [28_200, 33_600]]);
    const restoredEdge = { cueId: 'cue-000002', edge: 'end', fromMs: 27_500, toMs: 27_900 };
    expect(result.report.seamDuplicates).toEqual([{ cueId: 'cue-000003', startMs: 27_500, endMs: 28_200, seamMs: 27_500,
      clippedEdge: 'start', coverage: 1, keptCueIds: ['cue-000001', 'cue-000002'], restoredEdge }]);
    // Kept cues keep their wording; only the tail clipped to the seam moves.
    expect(kept).toEqual([cues[0], { ...cues[1], endMs: 27_900 }, cues[3]]);
    expect(dropped).toEqual(result.report.seamDuplicates);
    expect(Object.isFrozen(kept[1])).toBe(true);
    expect(JSON.stringify(result.report.seamDuplicates)).not.toContain('图书馆');
  });

  it("drops the previous window's clipped fragment that the next cue begins with and gives that cue its raw start", () => {
    const { result, cues, kept } = seam(
      [raw(25_200, 26_900, '外面的雨停了', 0), raw(26_900, 28_600, '原来你也在这里', 1)],
      [raw(2_300, 3_900, '我说原来你也在这里等公交车', 0), raw(3_900, 6_800, '末班车已经开走了', 1)],
    );
    expect(result.report.seamDuplicates).toEqual([{ cueId: 'cue-000002', startMs: 26_900, endMs: 27_500, seamMs: 27_500,
      clippedEdge: 'end', coverage: 1, keptCueIds: ['cue-000003'],
      restoredEdge: { cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 27_300 } }]);
    expect(kept).toEqual([cues[0], { ...cues[2], startMs: 27_300 }, cues[3]]);
    expect(kept[1]).toMatchObject({ startMs: 27_300, endMs: 28_900, text: '我说原来你也在这里等公交车' });
  });

  it('drops a 1.8 s near-identical variant starting at the seam and keeps the earlier wording with its raw end', () => {
    const { result, cues, kept } = seam(
      [raw(24_340, 27_700, '陈·嘉禾先生的旧读书笔记', 0)],
      [raw(500, 4_300, '程家禾先生的旧读书笔记', 0), raw(4_300, 9_000, '今天先讲到这里', 1)],
    );
    expect(cues[1]).toMatchObject({ startMs: 27_500, endMs: 29_300 });
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', clippedEdge: 'start', keptCueIds: ['cue-000001'] }]);
    expect(result.report.seamDuplicates[0]!.coverage).toBeCloseTo(9 / 11, 10);
    expect(kept).toEqual([{ ...cues[0], endMs: 27_700 }, cues[2]]);
    expect(kept[0]).toMatchObject({ startMs: 24_340, endMs: 27_700, text: '陈·嘉禾先生的旧读书笔记' });
  });

  it('drops both clipped copies when each repeats other cues across the seam', () => {
    const { result, kept } = seam(
      [raw(22_900, 25_500, '駅の前で待ってて', 0), raw(25_500, 27_460, 'すぐに行くから', 1), raw(27_460, 28_600, 'ちょっと待ってね', 2)],
      [raw(300, 3_000, '待っててすぐに行くから', 0), raw(3_000, 5_000, 'ちょっと待ってね', 1)],
    );
    // The first copy is judged again without the second, which it no longer lists as kept
    // nor restores; the second's kept cue never touched the seam.
    expect(result.report.seamDuplicates.map(duplicate => [duplicate.cueId, duplicate.clippedEdge, duplicate.keptCueIds]))
      .toEqual([['cue-000004', 'start', ['cue-000001', 'cue-000002']], ['cue-000003', 'end', ['cue-000005']]]);
    expect(result.report.seamDuplicates.map(duplicate => duplicate.restoredEdge)).toEqual([undefined, undefined]);
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[22_900, 25_500, '駅の前で待ってて'], [25_500, 27_460, 'すぐに行くから'], [28_000, 30_000, 'ちょっと待ってね']]);
  });

  it("keeps a next-window copy whose far end the previous window's copy stops short of, drops that fragment and trims the repeated opening", () => {
    const { result, cues, kept, dropped } = longCopyAfterCue();
    expect(cues.map(cue => [cue.startMs, cue.endMs])).toEqual([[23_700, 27_420], [27_420, 27_500], [27_500, 31_000]]);
    // The next window's copy is judged first and kept: only it heard the last two characters.
    const restoredEdge = { cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 27_420 };
    // Its opening up to the comma is the whole unclipped cue before it, so that opening and the comma go.
    const trimmedEdge = { cueId: 'cue-000003', edge: 'start', removedChars: 11, fromMs: 27_420, toMs: 27_420 };
    expect(result.report.seamDuplicates).toEqual([{ cueId: 'cue-000002', startMs: 27_420, endMs: 27_500, seamMs: 27_500,
      clippedEdge: 'end', coverage: 1, keptCueIds: ['cue-000003'], restoredEdge, trimmedEdge }]);
    expect(dropped).toEqual(result.report.seamDuplicates);
    // Each word shows once and nothing after the seam goes missing.
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([[23_700, 27_420, '作为守护这座城市的人'],
      [27_420, 31_000, '我们绝不能让大家失望']]);
    expect(kept[0]).toBe(cues[0]);
    expect(Object.isFrozen(kept[1])).toBe(true);
    expect(JSON.stringify(dropped)).not.toMatch(/城市|失望/u);
  });

  it("moves a trimmed start back to the end of the cue it repeats, cutting at whitespace", () => {
    const { result, kept, dropped } = seam(
      [raw(23_700, 27_000, 'see you at noon', 0), raw(27_200, 28_600, 'by the park', 1)],
      [raw(200, 6_000, 'See you at noon by the park then', 0)],
    );
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', clippedEdge: 'end', keptCueIds: ['cue-000003'],
      restoredEdge: { cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 27_200 },
      trimmedEdge: { cueId: 'cue-000003', edge: 'start', removedChars: 16, fromMs: 27_200, toMs: 27_000 } }]);
    expect(dropped).toEqual(result.report.seamDuplicates);
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[23_700, 27_000, 'see you at noon'], [27_000, 31_000, 'by the park then']]);
  });

  it('caps a trimmed start at the longest cue (7 s)', () => {
    const { result, kept } = seam(
      [raw(20_000, 23_000, 'see you at noon', 0), raw(27_200, 28_600, 'by the park', 1)],
      [raw(200, 6_000, 'See you at noon by the park then', 0)],
    );
    expect(result.report.seamDuplicates[0]!.trimmedEdge)
      .toEqual({ cueId: 'cue-000003', edge: 'start', removedChars: 16, fromMs: 27_200, toMs: 24_000 });
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[20_000, 23_000, 'see you at noon'], [24_000, 31_000, 'by the park then']]);
  });

  it("trims a kept previous-window copy whose ending is the whole cue after the seam and moves its end to that cue", () => {
    const { result, cues, kept, dropped } = longCopyBeforeCue();
    expect(cues.map(cue => [cue.startMs, cue.endMs])).toEqual([[24_000, 27_500], [27_500, 27_700], [28_000, 29_500]]);
    // The previous window's copy is kept for its first seven characters, which the next window never heard.
    expect(result.report.seamDuplicates).toEqual([{ cueId: 'cue-000002', startMs: 27_500, endMs: 27_700, seamMs: 27_500,
      clippedEdge: 'start', coverage: 1, keptCueIds: ['cue-000001'],
      restoredEdge: { cueId: 'cue-000001', edge: 'end', fromMs: 27_500, toMs: 27_700 },
      trimmedEdge: { cueId: 'cue-000001', edge: 'end', removedChars: 7, fromMs: 27_700, toMs: 28_000 } }]);
    expect(dropped).toEqual(result.report.seamDuplicates);
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[24_000, 28_000, '大家先别急着走'], [28_000, 29_500, '晚上一起吃饭']]);
  });

  it('caps a trimmed end at the longest cue (7 s)', () => {
    const { result, kept } = longCopyBeforeCue('晚上一起吃饭', 20_800);
    expect(result.report.seamDuplicates[0]!.trimmedEdge)
      .toEqual({ cueId: 'cue-000001', edge: 'end', removedChars: 7, fromMs: 27_700, toMs: 27_800 });
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[20_800, 27_800, '大家先别急着走'], [28_000, 29_500, '晚上一起吃饭']]);
  });

  it.each([
    { label: 'is not exactly the cue before it', before: '作为守护这座城市的人们', copy: '作为守护这座城市的人，我们绝不能让大家失望' },
    { label: 'differs in one character from the cue before it', before: '作为保护这座城市的人', copy: '作为守护这座城市的人，我们绝不能让大家失望' },
    { label: 'runs on without punctuation or whitespace', before: '作为守护这座城市的人', copy: '作为守护这座城市的人我们绝不能让大家失望' },
  ])("keeps the whole long copy when its opening $label", ({ before, copy }) => {
    const { result, cues, kept, dropped } = longCopyAfterCue(before, copy);
    const [reported] = result.report.seamDuplicates;
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', restoredEdge: { cueId: 'cue-000003', toMs: 27_420 } }]);
    expect(reported!.trimmedEdge).toBeUndefined();
    expect(dropped[0]!.trimmedEdge).toBeUndefined();
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([[23_700, 27_420, before], [27_420, 31_000, copy]]);
    // The executor checks the wording itself, so even a report planning the cut keeps the copy whole.
    const planned = dropLocalSubtitleSeamDuplicates(cues, [{ ...reported!,
      trimmedEdge: { cueId: 'cue-000003', edge: 'start', removedChars: 11, fromMs: 27_420, toMs: 27_420 } }], cues);
    expect(planned.dropped[0]!.trimmedEdge).toBeUndefined();
    expect(planned.segments).toEqual(kept);
  });

  it('keeps the whole long copy when its ending differs in one character from the cue after it', () => {
    const { result, cues, kept, dropped } = longCopyBeforeCue('晚上一起吃面');
    const [reported] = result.report.seamDuplicates;
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', restoredEdge: { cueId: 'cue-000001', toMs: 27_700 } }]);
    expect(reported!.trimmedEdge).toBeUndefined();
    expect(dropped[0]!.trimmedEdge).toBeUndefined();
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[24_000, 27_700, '大家先别急着走，晚上一起吃饭'], [28_000, 29_500, '晚上一起吃面']]);
    const planned = dropLocalSubtitleSeamDuplicates(cues, [{ ...reported!,
      trimmedEdge: { cueId: 'cue-000001', edge: 'end', removedChars: 7, fromMs: 27_700, toMs: 28_000 } }], cues);
    expect(planned.dropped[0]!.trimmedEdge).toBeUndefined();
    expect(planned.segments).toEqual(kept);
  });

  it.each([
    { before: 'tell them we don', fragment: 'want to wait any', copy: "Tell them we don't want to wait any longer" },
    { before: '油价每升涨了1', fragment: '大家都开始坐', copy: '油价每升涨了1.5元，大家都开始坐地铁' },
  ])("never cuts a long copy's opening at a joiner inside a word ($copy)", ({ before, fragment, copy }) => {
    const { result, kept } = seam([raw(23_700, 27_000, before, 0), raw(27_200, 28_600, fragment, 1)], [raw(200, 6_000, copy, 0)]);
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', keptCueIds: ['cue-000003'] }]);
    expect(result.report.seamDuplicates[0]!.trimmedEdge).toBeUndefined();
    expect(kept.map(cue => cue.text)).toEqual([before, copy]);
  });

  it('never trims a kept copy the far-end guard did not keep', () => {
    // The copy opens with the whole cue before the seam but falls below 80% for its inserted words.
    const copy = '我们走吧，那个就是说去公园散步';
    const { result, kept } = seam([raw(23_000, 26_000, '我们走吧', 0), raw(26_000, 28_000, '去公园散步', 1)], [raw(0, 4_000, copy, 0)]);
    expect(result.report.seamDuplicates).toEqual([{ cueId: 'cue-000002', startMs: 26_000, endMs: 27_500, seamMs: 27_500,
      clippedEdge: 'end', coverage: 1, keptCueIds: ['cue-000003'],
      restoredEdge: { cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 26_000 } }]);
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([[23_000, 26_000, '我们走吧'], [26_000, 29_000, copy]]);
  });

  it('trims only while the reported neighbour is still next to the copy, unchanged, and the rest keeps the minimum', () => {
    const { result, cues } = longCopyAfterCue();
    const drop = (current: readonly (typeof cues)[number][], reported = cues) =>
      dropLocalSubtitleSeamDuplicates(reported, result.report.seamDuplicates, current);
    const texts = (segments: readonly (typeof cues)[number][]) => segments.map(cue => [cue.startMs, cue.endMs, cue.text]);
    const whole = [23_700, 27_420, '作为守护这座城市的人'] as const;

    // Separators a later display pass restores neither stop the trim nor stay in the removed count.
    const separated = drop(cues.map((cue, index) => index === 2 ? { ...cue, text: '作为守护 这座城市的人，我们 绝不能让大家失望' } : cue));
    expect(texts(separated.segments)).toEqual([whole, [27_420, 31_000, '我们 绝不能让大家失望']]);
    expect(separated.dropped[0]!.trimmedEdge).toEqual({ cueId: 'cue-000003', edge: 'start', removedChars: 12, fromMs: 27_420, toMs: 27_420 });

    // A neighbour a later repair moved, rewrote, split or removed keeps the copy whole; the drop and restore stay.
    for (const current of [
      cues.map((cue, index) => index === 0 ? { ...cue, endMs: 27_300 } : cue),
      cues.map((cue, index) => index === 0 ? { ...cue, text: '作为守护这座城市' } : cue),
      cues.map((cue, index) => index === 0 ? { ...cue, id: 'cue-000001.dtw1' } : cue),
      cues.slice(1),
    ]) {
      const changed = drop(current);
      expect(changed.dropped).toEqual([{ ...result.report.seamDuplicates[0]!, trimmedEdge: undefined }]);
      expect(changed.segments.at(-1)).toMatchObject({ startMs: 27_420, text: '作为守护这座城市的人，我们绝不能让大家失望' });
    }

    // Fewer than 2 CJK or 4 Latin comparison characters left keep the copy whole.
    for (const copy of ['作为守护这座城市的人，好', '作为守护这座城市的人, ok']) {
      const short = cues.map((cue, index) => index === 2 ? { ...cue, text: copy } : cue);
      const kept = drop(short, short);
      expect(kept.dropped[0]!.trimmedEdge).toBeUndefined();
      expect(texts(kept.segments)).toEqual([whole, [27_420, 31_000, copy]]);
    }
  });

  it('moves a trimmed edge only out toward the reported neighbour as it stood before this call', () => {
    const { result, cues } = seam(
      [raw(23_700, 27_000, 'see you at noon', 0), raw(27_200, 28_600, 'by the park', 1)],
      [raw(200, 6_000, 'See you at noon by the park then', 0)],
    );
    const [reported] = result.report.seamDuplicates;
    const drop = (...duplicates: NonNullable<typeof reported>[]) => dropLocalSubtitleSeamDuplicates(cues, duplicates, cues);
    const texts = (segments: readonly (typeof cues)[number][]) => segments.map(cue => [cue.startMs, cue.endMs, cue.text]);
    const before = [23_700, 27_000, 'see you at noon'] as const;
    const whole = [27_200, 31_000, 'See you at noon by the park then'] as const;

    // A planned bound over the neighbour stops at its end; one inward leaves the edge where it is.
    for (const [toMs, startMs] of [[26_000, 27_000], [28_000, 27_200]] as const) {
      const bounded = drop({ ...reported!, trimmedEdge: { ...reported!.trimmedEdge!, toMs } });
      expect(texts(bounded.segments)).toEqual([before, [startMs, 31_000, 'by the park then']]);
      expect(bounded.dropped[0]!.trimmedEdge).toEqual({ ...reported!.trimmedEdge!, toMs: startMs });
    }

    // A neighbour an earlier entry moved in this call is no longer the reported one.
    const moved = drop({ ...reported!, keptCueIds: ['cue-000001'],
      restoredEdge: { cueId: 'cue-000001', edge: 'end', fromMs: 27_000, toMs: 27_100 }, trimmedEdge: undefined }, reported!);
    expect(texts(moved.segments)).toEqual([[23_700, 27_100, 'see you at noon'], whole]);
    expect(moved.dropped[1]).toEqual({ ...reported!, trimmedEdge: undefined });
    // Nor is a cue the report lists as a duplicate, kept here because it keeps another.
    const listed = drop(reported!, { ...reported!, cueId: 'cue-000001', keptCueIds: ['cue-000002'], restoredEdge: undefined,
      trimmedEdge: undefined });
    expect(texts(listed.segments)).toEqual([before, whole]);
    expect(listed.dropped).toEqual([{ ...reported!, trimmedEdge: undefined }]);
  });

  it.each([
    { label: 'one CJK character', left: ['作为守护这座城市的人', '我们绝不能让大家失'], right: '作为守护这座城市的人，我们绝不能让大家失望' },
    { label: 'three Latin letters', left: ['we meet at the old station', 'and walk to the'],
      right: 'We meet at the old station and walk to the bay' },
  ])('still drops a next-window copy whose far end adds only $label', ({ left, right }) => {
    const { result, kept } = seam([raw(23_700, 27_420, left[0]!, 0), raw(27_420, 28_600, left[1]!, 1)], [raw(200, 6_000, right, 0)]);
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000003', clippedEdge: 'start',
      keptCueIds: ['cue-000001', 'cue-000002'], restoredEdge: { cueId: 'cue-000002', edge: 'end', fromMs: 27_500, toMs: 28_600 } }]);
    expect(kept.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([[23_700, 27_420, left[0]], [27_420, 28_600, left[1]]]);
  });

  it("still drops a next-window copy whose last two characters differ from the previous window's", () => {
    // Both windows heard words there, so the difference only lowers the coverage.
    const { result, cues, kept } = seam(
      [raw(23_800, 25_600, '明天上午', 0), raw(25_600, 27_900, '我们一起去公园', 1)],
      [raw(200, 3_200, '明天上午，我们一起去学校', 0), raw(3_200, 8_600, '如果下雨就改到下周再去', 1)],
    );
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000003', clippedEdge: 'start',
      keptCueIds: ['cue-000001', 'cue-000002'], restoredEdge: { cueId: 'cue-000002', edge: 'end', fromMs: 27_500, toMs: 27_900 } }]);
    expect(result.report.seamDuplicates[0]!.coverage).toBeCloseTo(9 / 11, 10);
    expect(kept).toEqual([cues[0], { ...cues[1], endMs: 27_900 }, cues[3]]);
  });

  it('still drops a next-window copy whose extra words sit only at the seam side', () => {
    const { result, kept } = seam([raw(24_000, 28_000, '明天早上八点在门口集合', 0)],
      [raw(1_500, 3_600, '好的，明天早上八点在门口集合', 0), raw(3_600, 7_000, '记得带上雨伞', 1)]);
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', clippedEdge: 'start', keptCueIds: ['cue-000001'],
      restoredEdge: { cueId: 'cue-000001', edge: 'end', fromMs: 27_500, toMs: 28_000 } }]);
    expect(result.report.seamDuplicates[0]!.coverage).toBeCloseTo(11 / 13, 10);
    expect(kept.map(cue => [cue.startMs, cue.endMs])).toEqual([[24_000, 28_000], [28_600, 32_000]]);
  });

  it('keeps both clipped copies when each carries words at its far end that the other window never heard', () => {
    // Counting those two characters as edits, either copy would reach 80% (12 of 15).
    const left = '其实我早就知道了这件事是你做的';
    const right = '我早就知道了那件事是你做的情呢';
    const { result, cues, kept } = seam([raw(24_500, 28_400, left, 0)], [raw(1_000, 4_000, right, 0)]);
    expect(cues.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([[24_500, 27_500, left], [27_500, 29_000, right]]);
    expect(result.report.seamDuplicates).toEqual([]);
    expect(kept).toEqual(cues);
  });

  it('still drops a previous-window copy whose far end adds only one CJK character', () => {
    const left = '实我早就知道了这件事是你做的';
    const { result, cues, kept } = seam([raw(24_500, 28_400, left, 0)], [raw(1_000, 4_000, '我早就知道了那件事是你做的情呢', 0)]);
    expect(cues.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[24_500, 27_500, left], [27_500, 29_000, '我早就知道了那件事是你做的情呢']]);
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000001', clippedEdge: 'end', keptCueIds: ['cue-000002'],
      restoredEdge: { cueId: 'cue-000002', edge: 'start', fromMs: 27_500, toMs: 26_000 } }]);
    expect(result.report.seamDuplicates[0]!.coverage).toBeCloseTo(12 / 14, 10);
    expect(kept).toEqual([{ ...cues[1], startMs: 26_000 }]);
  });

  it('gives the kept next-window copy its raw start when the longer variant before the seam goes', () => {
    const { result, cues, kept } = variantBeforeSeam(1_300);
    expect(cues.map(cue => [cue.startMs, cue.endMs])).toEqual([[23_100, 25_390], [25_390, 27_500], [27_500, 28_080], [28_080, 31_660]]);
    // The kept copy misses one character of the variant (75%); the variant misses one of 5 (80%).
    expect(result.report.seamDuplicates).toEqual([{ cueId: 'cue-000002', startMs: 25_390, endMs: 27_500, seamMs: 27_500,
      clippedEdge: 'end', coverage: 0.8, keptCueIds: ['cue-000003'],
      restoredEdge: { cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 26_300 } }]);
    expect(kept).toEqual([cues[0], { ...cues[2], startMs: 26_300 }, cues[3]]);
  });

  it("never moves a restored start past the dropped copy's start or over a remaining cue", () => {
    const early = variantBeforeSeam(100);
    expect(early.result.report.seamDuplicates[0]!.restoredEdge)
      .toEqual({ cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 25_390 });
    expect(early.kept.map(cue => [cue.startMs, cue.endMs])).toEqual([[23_100, 25_390], [25_390, 28_080], [28_080, 31_660]]);

    // A later repair moved the cue before the dropped copy; the restore stops at its end.
    const { result, cues } = variantBeforeSeam(600);
    expect(result.report.seamDuplicates[0]!.restoredEdge).toMatchObject({ toMs: 25_600 });
    const repaired = cues.map((cue, index) => index === 0 ? { ...cue, endMs: 26_000 } : cue);
    const { segments, dropped } = dropLocalSubtitleSeamDuplicates(cues, result.report.seamDuplicates, repaired);
    expect(segments.map(cue => [cue.startMs, cue.endMs])).toEqual([[23_100, 26_000], [26_000, 28_080], [28_080, 31_660]]);
    expect(dropped[0]!.restoredEdge).toEqual({ cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 26_000 });
  });

  it("never moves a restored end past the dropped copy's end or over a remaining cue", () => {
    const late = twoCuesThenCopy(28_600);
    expect(late.result.report.seamDuplicates[0]!.restoredEdge)
      .toEqual({ cueId: 'cue-000002', edge: 'end', fromMs: 27_500, toMs: 28_200 });
    expect(late.kept.map(cue => [cue.startMs, cue.endMs])).toEqual([[23_800, 25_600], [25_600, 28_200], [28_200, 33_600]]);

    // A later repair moved the cue after the dropped copy; the restore stops at its start.
    const { result, cues } = twoCuesThenCopy();
    const repaired = cues.map((cue, index) => index === 3 ? { ...cue, startMs: 27_700 } : cue);
    const { segments, dropped } = dropLocalSubtitleSeamDuplicates(cues, result.report.seamDuplicates, repaired);
    expect(segments.map(cue => [cue.startMs, cue.endMs])).toEqual([[23_800, 25_600], [25_600, 27_700], [27_700, 33_600]]);
    expect(dropped[0]!.restoredEdge).toEqual({ cueId: 'cue-000002', edge: 'end', fromMs: 27_500, toMs: 27_700 });
  });

  it.each([
    { label: 'caps a restore at', leftStartMs: 21_000, toMs: 28_000 },
    { label: 'skips the restore of a kept cue already over', leftStartMs: 20_000, toMs: undefined },
  ])('$label the longest cue (7 s)', ({ leftStartMs, toMs }) => {
    const { result, kept } = seam([raw(leftStartMs, 28_400, '这条路一直往前走到第二个路口再右转就到了', 0)],
      [raw(1_500, 4_200, '到第二个路口再右转', 0)]);
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', clippedEdge: 'start', keptCueIds: ['cue-000001'] }]);
    expect(result.report.seamDuplicates[0]!.restoredEdge?.toMs).toBe(toMs);
    expect(kept.map(cue => [cue.startMs, cue.endMs])).toEqual([[leftStartMs, toMs ?? 27_500]]);
  });

  it('caps a restored start at the longest cue (7 s) too', () => {
    const { result, kept } = seam([raw(25_000, 28_000, '这条路一直往前走', 0)],
      [raw(1_000, 9_000, '我说这条路一直往前走到第二个路口再右转就到了', 0)]);
    expect(result.report.seamDuplicates).toMatchObject([{ cueId: 'cue-000001', clippedEdge: 'end', keptCueIds: ['cue-000002'],
      restoredEdge: { cueId: 'cue-000002', edge: 'start', fromMs: 27_500, toMs: 27_000 } }]);
    expect(kept.map(cue => [cue.startMs, cue.endMs])).toEqual([[27_000, 34_000]]);
  });

  it("keeps the kept cue's time when its raw observation already ended at the seam", () => {
    const { result, cues, kept } = seam(
      [raw(23_800, 25_600, '明天上午', 0), raw(25_600, 27_500, '我们一起去图书馆', 1)],
      [raw(200, 3_200, '明天上午，我们一起去图书馆', 0), raw(3_200, 8_600, '如果下雨就改到下周再去', 1)],
    );
    expect(result.report.seamDuplicates).toEqual([{ cueId: 'cue-000003', startMs: 27_500, endMs: 28_200, seamMs: 27_500,
      clippedEdge: 'start', coverage: 1, keptCueIds: ['cue-000001', 'cue-000002'] }]);
    expect(kept).toEqual(except(cues, 2));
  });

  it('never drops a cue that keeps an earlier duplicate across the seams of retry children', () => {
    const totalFrames = 80_000 * 16;
    const rootPlan = planLocalSubtitleRootWindows({ rootPlanId: 'plan-001', totalFrames, policy });
    const [first, middle, last] = rootPlan.windows;
    const retry = decideLocalSubtitleWindowRetry({ attempt: attempt(middle!, failed, 1), policy,
      assessment: assessLocalSubtitleRawWindow({ window: middle!, result: attempt(middle!, failed, 1).response.result, policy }) });
    if (retry.action !== 'split') throw new Error(`Expected a split, got ${retry.action}`);
    const [left, right] = retry.children;
    expect([left, right].map(window => [window.startMs, window.endMs, window.coreEndMs]))
      .toEqual([[25_000, 41_000, 40_000], [39_000, 55_000, 52_500]]);
    // The first window's clipped tail repeats a long cue that is itself clipped at the
    // children's seam and repeated, with more words, by the second child.
    const { transcript, report } = run(rootPlan, totalFrames, [
      [raw(20_000, 27_000, '今天风有点大', 0), raw(27_000, 28_400, '周末去海边', 1)],
      failed,
      [raw(3_000, 16_000, '我说周末去海边钓鱼然后回家做饭')],
      [raw(1_500, 6_000, '他们说我说周末去海边钓鱼然后回家做饭晚上再一起看书')],
      [raw(10_000, 12_000, '就这样')],
    ], [first!, middle!, left, right, last!]);
    const cues = transcript.segments;
    expect(cues.map(cue => [cue.startMs, cue.endMs]))
      .toEqual([[20_000, 27_000], [27_000, 27_500], [28_000, 40_000], [40_500, 45_000], [60_000, 62_000]]);
    expect(report.seamDuplicates).toMatchObject([{ cueId: 'cue-000002', seamMs: 27_500, clippedEdge: 'end', keptCueIds: ['cue-000003'] }]);
    const kept = dropLocalSubtitleSeamDuplicates(cues, report.seamDuplicates, cues).segments;
    expect(kept).toEqual(except(cues, 1));
    expect(report.seamDuplicates.flatMap(duplicate => duplicate.keptCueIds)
      .every(id => kept.some(cue => cue.id === id))).toBe(true);
  });

  it('keeps a cue restored at both its seams within the longest cue', () => {
    const totalFrames = 80_000 * 16;
    const rootPlan = planLocalSubtitleRootWindows({ rootPlanId: 'plan-001', totalFrames, policy });
    const [first, middle, last] = rootPlan.windows;
    const [left, right] = split(middle!, 1);
    const [leftFirst, leftSecond] = split(left, 2);
    expect([leftFirst, leftSecond].map(window => [window.startMs, window.endMs, window.coreEndMs]))
      .toEqual([[25_000, 34_000, 33_000], [32_000, 41_000, 40_000]]);
    // A 5.5 s cue clipped at both seams of a grandchild whose copies on either side both go.
    const { transcript, report } = run(rootPlan, totalFrames, [
      [raw(20_000, 24_000, '今天的会议到此结束', 0), raw(24_000, 28_000, '下周一早上九点', 1)],
      failed,
      failed,
      [raw(1_500, 9_000, '我说下周一早上九点在三楼会议室见面')],
      [raw(500, 3_000, '对在三楼会议室见面', 0), raw(4_000, 7_000, '散会以后记得关灯', 1)],
      [raw(3_000, 6_000, '大家辛苦了')],
      [raw(10_000, 12_000, '就这样')],
    ], [first!, middle!, left, leftFirst, leftSecond, right, last!]);
    const cues = transcript.segments;
    expect(cues.map(cue => [cue.startMs, cue.endMs])).toEqual([[20_000, 24_000], [24_000, 27_500], [27_500, 33_000],
      [33_000, 35_000], [36_000, 39_000], [42_000, 45_000], [60_000, 62_000]]);
    // The start goes back to its raw time; the end then stops 7 s after that restored start.
    expect(report.seamDuplicates.map(duplicate => [duplicate.cueId, duplicate.restoredEdge])).toEqual([
      ['cue-000002', { cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 26_500 }],
      ['cue-000004', { cueId: 'cue-000003', edge: 'end', fromMs: 33_000, toMs: 33_500 }],
    ]);
    const { segments } = dropLocalSubtitleSeamDuplicates(cues, report.seamDuplicates, cues);
    expect(segments.map(cue => [cue.startMs, cue.endMs]))
      .toEqual([[20_000, 24_000], [26_500, 33_500], [36_000, 39_000], [42_000, 45_000], [60_000, 62_000]]);
  });

  it('keeps a copy trimmed at both its seams within the longest cue', () => {
    const totalFrames = 80_000 * 16;
    const rootPlan = planLocalSubtitleRootWindows({ rootPlanId: 'plan-001', totalFrames, policy });
    const [first, middle, last] = rootPlan.windows;
    const [left, right] = split(middle!, 1);
    const [leftFirst, leftSecond] = split(left, 2);
    // A grandchild's long copy opens with the whole cue before one seam and closes with the whole cue after the other.
    const { transcript, report } = run(rootPlan, totalFrames, [
      [raw(22_000, 26_600, '各位同学请注意', 0), raw(27_200, 28_600, '明天的考试', 1)],
      failed,
      failed,
      [raw(1_500, 9_000, '各位同学请注意，明天的考试改在三楼大教室，记得带好准考证')],
      [raw(500, 1_400, '改在三楼大教室', 0), raw(1_800, 3_500, '记得带好准考证', 1)],
      [raw(3_000, 6_000, '大家辛苦了')],
      [raw(10_000, 12_000, '就这样')],
    ], [first!, middle!, left, leftFirst, leftSecond, right, last!]);
    const cues = transcript.segments;
    expect(cues.map(cue => [cue.startMs, cue.endMs])).toEqual([[22_000, 26_600], [27_200, 27_500], [27_500, 33_000],
      [33_000, 33_400], [33_800, 35_500], [42_000, 45_000], [60_000, 62_000]]);
    // The start goes out to the cue before it; the end then stops 7 s after that trimmed start, short of the cue after it.
    expect(report.seamDuplicates.map(duplicate => [duplicate.cueId, duplicate.restoredEdge, duplicate.trimmedEdge])).toEqual([
      ['cue-000002', { cueId: 'cue-000003', edge: 'start', fromMs: 27_500, toMs: 27_200 },
        { cueId: 'cue-000003', edge: 'start', removedChars: 8, fromMs: 27_200, toMs: 26_600 }],
      ['cue-000004', { cueId: 'cue-000003', edge: 'end', fromMs: 33_000, toMs: 33_400 },
        { cueId: 'cue-000003', edge: 'end', removedChars: 8, fromMs: 33_400, toMs: 33_600 }],
    ]);
    const { segments, dropped } = dropLocalSubtitleSeamDuplicates(cues, report.seamDuplicates, cues);
    expect(dropped).toEqual(report.seamDuplicates);
    expect(segments.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([[22_000, 26_600, '各位同学请注意'],
      [26_600, 33_600, '明天的考试改在三楼大教室'], [33_800, 35_500, '记得带好准考证'], [42_000, 45_000, '大家辛苦了'],
      [60_000, 62_000, '就这样']]);
  });

  it.each([
    { label: 'at', text: '嗯那会议改到下午三点', dropped: 1 },
    { label: 'below', text: '嗯那个会议改到下午三点', dropped: 0 },
  ])('applies the 80% coverage threshold $label the boundary', ({ text, dropped }) => {
    const { result, cues, kept } = seam([raw(24_000, 27_100, '会议改到下午三点', 0)], [raw(1_000, 3_800, text, 0)]);
    expect(cues[1]).toMatchObject({ startMs: 27_500, endMs: 28_800, text });
    expect(result.report.seamDuplicates.map(duplicate => duplicate.coverage)).toEqual(dropped ? [0.8] : []);
    expect(kept).toEqual(dropped ? [cues[0]] : cues);
  });

  it.each([
    { label: 'an unclipped first and a clipped second', left: [26_700, 27_100], right: [2_400, 2_900] },
    { label: 'a clipped first and an unclipped second', left: [27_200, 27_600], right: [2_900, 3_300] },
  ])('keeps legal repetition across the seam with $label うん', ({ left, right }) => {
    const { result, cues, kept } = seam([raw(left[0]!, left[1]!, 'うん')], [raw(right[0]!, right[1]!, 'うん')]);
    expect(cues.map(cue => cue.text)).toEqual(['うん', 'うん']);
    expect(result.report.duplicateBoundarySegmentCount).toBe(0);
    expect(result.report.seamDuplicates).toEqual([]);
    expect(kept).toEqual(cues);
  });

  it.each([['算了吧', '了'], ['it is ok now', 'OK!']])('keeps a clipped cue below the CJK and Latin minimums (%s / %s)', (left, right) => {
    const { result, cues, kept } = seam([raw(25_500, 27_200, left)], [raw(1_800, 3_000, right)]);
    expect(cues[1]).toMatchObject({ startMs: 27_500, endMs: 28_000, text: right });
    expect(result.report.seamDuplicates).toEqual([]);
    expect(kept).toEqual(cues);
  });

  it.each([['そうなんだけど、もう一回考えてみようか', 'うん'], ['you said this is it, right', 'yes it is']])(
    'keeps a short reply whose characters only occur apart in the longer cue across the seam (%s / %s)', (left, right) => {
      const { result, cues, kept } = seam([raw(23_000, 27_700, left)], [raw(2_300, 3_000, right)]);
      expect(cues.map(cue => [cue.startMs, cue.endMs, cue.text])).toEqual([[23_000, 27_500, left], [27_500, 28_000, right]]);
      expect(result.report.seamDuplicates).toEqual([]);
      expect(kept).toEqual(cues);
    });

  it('keeps the same sentence repeated away from any seam', () => {
    const { result, cues, kept } = seam([raw(10_000, 12_000, '再说一遍这句话')], [raw(15_000, 17_000, '再说一遍这句话')]);
    expect(cues.map(cue => cue.text)).toEqual(['再说一遍这句话', '再说一遍这句话']);
    expect(result.report.seamDuplicates).toEqual([]);
    expect(kept).toEqual(cues);
  });

  it('leaves pause cuts, which share no audio, untouched', () => {
    const totalFrames = 65_000 * 16 + 1;
    const rootPlan = planLocalSubtitleRootWindows({ rootPlanId: 'plan-001', totalFrames, policy,
      pauseCandidates: [{ startFrame: 24_400 * 16, endFrame: 25_600 * 16 }] });
    expect(rootPlan.windows.map(window => [window.startMs, window.endMs])).toEqual([[0, 25_000], [25_000, 55_000], [50_000, 65_000]]);
    const result = run(rootPlan, totalFrames,
      [[raw(23_000, 25_000, '停顿前后的同一句')], [raw(0, 1_500, '停顿前后的同一句')], [raw(4_000, 5_000, '最后一句')]]);
    expect(result.transcript.segments.map(cue => [cue.startMs, cue.endMs, cue.text]))
      .toEqual([[23_000, 25_000, '停顿前后的同一句'], [25_000, 26_500, '停顿前后的同一句'], [54_000, 55_000, '最后一句']]);
    expect(result.report.seamDuplicates).toEqual([]);
  });

  it('drops and restores only while the duplicate and its kept cues keep their reported timing and wording', () => {
    const { result, cues } = twoCuesThenCopy();
    const drop = (index: number, change: Partial<(typeof cues)[number]>) => dropLocalSubtitleSeamDuplicates(cues,
      result.report.seamDuplicates, cues.map((cue, position) => position === index ? { ...cue, ...change } : cue));

    // Separators a later display pass restores do not change the comparison wording.
    const separated = drop(1, { text: '我们、一起去图书馆。' });
    expect(separated.segments.map(cue => [cue.endMs, cue.text])).toEqual([[25_600, '明天上午'], [27_900, '我们、一起去图书馆。'],
      [33_600, '如果下雨就改到下周再去']]);
    expect(drop(0, { endMs: 25_500 }).dropped).toEqual([]);
    // A kept tail a later repair rewrote, or split into new cues, is neither relied on nor moved.
    for (const change of [{ text: '我们一起去' }, { id: 'cue-000002.dtw1' }]) {
      const changed = drop(1, change);
      expect(changed.dropped).toEqual([]);
      expect(changed.segments.map(cue => cue.endMs)).toEqual([25_600, 27_500, 28_200, 33_600]);
    }
    expect(drop(2, { id: 'cue-000003.seam' }).dropped).toEqual([]);
    const repaired = drop(2, { startMs: 27_600 });
    expect(repaired.dropped).toEqual([]);
    expect(repaired.segments).toHaveLength(4);
    expect(Object.isFrozen(repaired.segments)).toBe(true);

    // A report that would also drop a kept cue keeps the duplicate that relies on it.
    const [reported] = result.report.seamDuplicates;
    const chained = [reported!, { ...reported!, cueId: 'cue-000002', keptCueIds: ['cue-000004'] }];
    const kept = dropLocalSubtitleSeamDuplicates(cues, chained, cues);
    expect(kept.dropped).toEqual([{ ...reported!, cueId: 'cue-000002', keptCueIds: ['cue-000004'], restoredEdge: undefined }]);
    expect(kept.segments).toEqual(except(cues, 1));
    // An edge restore naming a remaining cue the entry does not keep is ignored.
    const foreign = dropLocalSubtitleSeamDuplicates(cues,
      [{ ...reported!, restoredEdge: { cueId: 'cue-000004', edge: 'start', fromMs: 28_200, toMs: 27_500 } }], cues);
    expect(foreign.dropped).toEqual([{ ...reported!, restoredEdge: undefined }]);
    expect(foreign.segments).toEqual(except(cues, 2));
  });
});
