import { describe, expect, it } from 'vitest';
import type { LocalSubtitleServerRawSegment as Raw } from '../../../electron/main/subtitle-studio/transcription/native/server-contract';
import { LOCAL_SUBTITLE_ANCHOR_RETIMING_MIN_MEDIAN_SHIFT_MS, retimeLocalSubtitleSegmentsFromAnchor as retime }
  from '../../../electron/main/subtitle-studio/transcription/native/subtitle-post-processor';

// 2026-10-24 asr-quality T-ASRQ-16: a preset window takes the times of its standard-field
// timing anchor (design 方案 9, option C). The shapes follow the T-ASRQ-15 prototype; all
// wording here is invented. Times are window-relative milliseconds. Since 2026-10-25 only a
// window the preset heard early as a whole moves (anchored edges' median shift >= +500 ms).
function raw(startMs: number, endMs: number, text: string, id = 0): Raw {
  return { id, startMs, endMs, text, temperature: 0, averageLogProbability: -0.25, noSpeechProbability: 0.01 };
}
const times = (segments: readonly Raw[]) => segments.map(segment => [segment.startMs, segment.endMs]);

describe('anchor retiming', () => {
  it('takes the anchor times of edges whose two outer characters pair with an anchor segment\'s', () => {
    const preset = [raw(1_000, 3_000, '今天天气很好', 0), raw(3_000, 5_000, '我们去公园吧', 1)];
    const before = structuredClone(preset);
    const result = retime(preset, [raw(2_500, 4_200, '今天天气很好。'), raw(4_600, 6_900, '我们去公园吧')], 30_000);
    expect(times(result.segments)).toEqual([[2_500, 4_200], [4_600, 6_900]]);
    expect(result).toMatchObject({ status: 'retimed', anchoredEdges: 4, totalEdges: 4, medianShiftMs: 1_500, maxShiftMs: 1_900 });
    // Text and every other field stay; the input is not touched.
    expect(result.segments[0]).toEqual({ ...preset[0], startMs: 2_500, endMs: 4_200 });
    expect(preset).toEqual(before);
    expect(Object.isFrozen(result.segments) && result.segments.every(segment => Object.isFrozen(segment))).toBe(true);
  });

  it('interpolates edges that pair inside an anchor segment', () => {
    // The anchor heard both sentences as one; only its outer edges are anchors.
    const result = retime([raw(0, 2_000, '今天天气很好', 0), raw(2_000, 4_000, '我们去公园吧', 1)],
      [raw(1_000, 6_000, '今天天气很好，我们去公园吧')], 30_000);
    expect(times(result.segments)).toEqual([[1_000, 3_500], [3_500, 6_000]]);
    // The median is of the anchored edges only (+1000, +2000: the lower one); the largest move is of any edge.
    expect(result).toMatchObject({ status: 'retimed', anchoredEdges: 2, medianShiftMs: 1_000, maxShiftMs: 2_000 });
  });

  it('anchors an edge only when both of its outer characters pair', () => {
    // 今天 / 今日: only the first character pairs, so the start follows the anchored end.
    expect(times(retime([raw(1_000, 2_000, '今天很好')], [raw(1_500, 2_600, '今日很好')], 30_000).segments))
      .toEqual([[1_600, 2_600]]);
    // A one-character segment has no two characters to pair.
    const result = retime([raw(0, 500, '嗯', 0), raw(1_000, 3_000, '我们去公园吧', 1)],
      [raw(300, 800, '嗯'), raw(1_600, 3_600, '我们去公园吧')], 30_000);
    expect(times(result.segments)).toEqual([[600, 1_100], [1_600, 3_600]]);
    expect(result.anchoredEdges).toBe(2);
  });

  it('interpolates linearly between the nearest anchored edges and rounds to milliseconds', () => {
    const result = retime([raw(0, 1_000, '今天天气很好', 0), raw(1_000, 2_000, '完全不同的话', 1), raw(2_000, 3_000, '我们去公园吧', 2)],
      [raw(1_000, 5_000, '今天天气很好另外的我们去公园吧')], 30_000);
    // +1000 ms at 0 ms and +2000 ms at 3000 ms: a third of the way is +1333 ms, two thirds +1667 ms.
    expect(times(result.segments)).toEqual([[1_000, 2_333], [2_333, 3_667], [3_667, 5_000]]);
    expect(result.anchoredEdges).toBe(2);
  });

  it('moves an unaligned sentence between aligned ones along their shifts', () => {
    const result = retime([raw(0, 2_000, '今天天气很好', 0), raw(2_500, 3_500, '完全不同的话', 1), raw(4_000, 6_000, '我们去公园吧', 2)],
      [raw(1_000, 3_000, '今天天气很好'), raw(3_000, 5_000, '另外一些内容'), raw(7_000, 9_000, '我们去公园吧')], 30_000);
    expect(times(result.segments)).toEqual([[1_000, 3_000], [4_000, 6_000], [7_000, 9_000]]);
    expect(result).toMatchObject({ anchoredEdges: 4, totalEdges: 6, medianShiftMs: 1_000, maxShiftMs: 3_000 });
  });

  it('carries the nearest shift beyond the outermost anchored edges', () => {
    const result = retime([raw(0, 1_000, '前面没对上', 0), raw(1_000, 3_000, '今天天气很好', 1), raw(3_000, 4_000, '后面也没有', 2)],
      [raw(1_600, 3_700, '今天天气很好')], 30_000);
    expect(times(result.segments)).toEqual([[600, 1_600], [1_600, 3_700], [3_700, 4_700]]);
  });

  it('retimes a window only when its anchored edges move at least 500 ms later at the median', () => {
    expect(LOCAL_SUBTITLE_ANCHOR_RETIMING_MIN_MEDIAN_SHIFT_MS).toBe(500);
    const preset = [raw(1_000, 3_000, '今天天气很好', 0)];
    const atGate = retime(preset, [raw(1_500, 3_500, '今天天气很好')], 30_000);
    expect(times(atGate.segments)).toEqual([[1_500, 3_500]]);
    expect(atGate).toMatchObject({ status: 'retimed', anchoredEdges: 2, medianShiftMs: 500, maxShiftMs: 500 });
    // A millisecond short of it the window keeps its times, and the counts and shifts say why.
    const belowGate = retime(preset, [raw(1_499, 3_499, '今天天气很好')], 30_000);
    expect(belowGate).toEqual({ segments: preset, status: 'not_early', anchoredEdges: 2, totalEdges: 2, medianShiftMs: 499, maxShiftMs: 499 });
    expect(belowGate.segments).toBe(preset);
  });

  it('keeps a window the anchor hears earlier, or about where the preset did', () => {
    const preset = [raw(3_000, 5_000, '今天天气很好', 0), raw(6_000, 8_000, '我们去公园吧', 1)];
    // The anchor starts both sentences in the silence before them.
    expect(retime(preset, [raw(1_500, 4_800, '今天天气很好'), raw(4_900, 7_900, '我们去公园吧')], 30_000))
      .toEqual({ segments: preset, status: 'not_early', anchoredEdges: 4, totalEdges: 4, medianShiftMs: -1_100, maxShiftMs: 1_500 });
    // Small shifts either way are mostly the anchor's own variation.
    expect(retime(preset, [raw(3_100, 5_300, '今天天气很好'), raw(6_200, 7_950, '我们去公园吧')], 30_000))
      .toEqual({ segments: preset, status: 'not_early', anchoredEdges: 4, totalEdges: 4, medianShiftMs: 100, maxShiftMs: 300 });
  });

  it('decides on the anchored edges alone, more than half of which must move that much later', () => {
    // Interpolated edges would move 1.7 s, but only one of the two anchored edges (+400, +3000) moves later by 500 ms.
    const preset = [raw(0, 2_000, '今天天气很好', 0), raw(2_000, 4_000, '我们去公园吧', 1)];
    expect(retime(preset, [raw(400, 7_000, '今天天气很好，我们去公园吧')], 30_000))
      .toEqual({ segments: preset, status: 'not_early', anchoredEdges: 2, totalEdges: 4, medianShiftMs: 400, maxShiftMs: 3_000 });
    // Two of three anchored edges (+300, +600, +800) do; the end the anchor heard more after carries the last shift.
    const result = retime([raw(1_000, 3_000, '今天天气很好', 0), raw(3_000, 5_000, '我们去公园吧', 1)],
      [raw(1_300, 3_600, '今天天气很好'), raw(3_800, 6_500, '我们去公园吧呀')], 30_000);
    expect(times(result.segments)).toEqual([[1_300, 3_600], [3_800, 5_800]]);
    expect(result).toMatchObject({ status: 'retimed', anchoredEdges: 3, totalEdges: 4, medianShiftMs: 600, maxShiftMs: 800 });
  });

  it('retimes a window heard ever earlier after the decoder missed its opening', () => {
    // The shape of pv-zh 100–130 s: each sentence is early by more than the one before; 嗯 has no anchor.
    const preset = [raw(500, 2_500, '我们去公园吧', 0), raw(2_500, 4_500, '明天也许下雨', 1), raw(4_500, 5_000, '嗯', 2),
      raw(5_000, 7_000, '那就改天再去', 3), raw(7_000, 9_000, '今天天气很好', 4)];
    const result = retime(preset, [raw(2_200, 4_300, '我们去公园吧'), raw(5_000, 7_200, '明天也许下雨'),
      raw(8_400, 10_500, '那就改天再去'), raw(11_000, 13_100, '今天天气很好')], 30_000);
    expect(times(result.segments)).toEqual([[2_200, 4_300], [5_000, 7_200], [7_200, 8_400], [8_400, 10_500], [11_000, 13_100]]);
    expect(result).toMatchObject({ status: 'retimed', anchoredEdges: 8, totalEdges: 10, medianShiftMs: 2_700, maxShiftMs: 4_100 });
  });

  it('keeps a window without an anchored edge as it is', () => {
    const preset = [raw(1_000, 3_000, '今天天气很好', 0)];
    for (const [anchor, status] of [
      [[raw(2_000, 4_000, '完全不同的话')], 'unaligned'],
      [[], 'empty'],
      [[raw(0, 1_000, '。'), raw(1_000, 2_000, '')], 'empty'],
    ] as const) {
      const result = retime(preset, anchor, 30_000);
      expect(result).toEqual({ segments: preset, status, anchoredEdges: 0, totalEdges: 2, medianShiftMs: 0, maxShiftMs: 0 });
      expect(result.segments).toBe(preset);
    }
    expect(retime([raw(0, 1_000, '♪')], [raw(500, 1_500, '今天天气很好')], 30_000).status).toBe('unaligned');
    expect(retime([], [raw(500, 1_500, '今天天气很好')], 30_000)).toMatchObject({ status: 'unaligned', totalEdges: 0 });
  });

  it('keeps each start after the previous end and each segment at least 0.2 s long', () => {
    expect(times(retime([raw(0, 2_000, '今天天气很好', 0), raw(2_000, 4_000, '我们去公园吧', 1)],
      [raw(600, 3_000, '今天天气很好'), raw(2_600, 4_200, '我们去公园吧')], 30_000).segments)).toEqual([[600, 3_000], [3_000, 4_200]]);
    expect(times(retime([raw(0, 500, '我们去公园吧')], [raw(1_000, 1_100, '我们去公园吧')], 30_000).segments))
      .toEqual([[1_000, 1_200]]);
  });

  it('stays within the window, moving segments the window end cut short earlier', () => {
    const preset = [raw(6_000, 8_000, '今天天气很好', 0), raw(8_000, 9_000, '还有一句', 1), raw(9_000, 9_800, '最后', 2)];
    const result = retime(preset, [raw(7_000, 9_000, '今天天气很好')], 10_000);
    expect(times(result.segments)).toEqual([[7_000, 9_000], [9_000, 9_800], [9_800, 10_000]]);
    expect(result).toMatchObject({ status: 'retimed', anchoredEdges: 2 });
    // Only edges without an anchor time move earlier; where an anchored one would have to, the window keeps its times.
    const anchored = retime(preset, [raw(9_000, 9_950, '今天天气很好')], 10_000);
    expect(anchored).toMatchObject({ status: 'unaligned', anchoredEdges: 0 });
    expect(anchored.segments).toBe(preset);
    // Starts never fall before the window either.
    expect(times(retime([raw(500, 2_000, '今天天气很好', 0), raw(2_000, 3_000, '我们去公园吧', 1)],
      [raw(-80, 3_000, '今天天气很好'), raw(3_000, 4_000, '我们去公园吧')], 10_000).segments)).toEqual([[0, 3_000], [3_000, 4_000]]);
  });

  it('keeps a window whose segments cannot all fit in order', () => {
    const preset = [raw(0, 100, '今天', 0), raw(100, 200, '天气', 1), raw(200, 300, '很好', 2)];
    const result = retime(preset, [raw(600, 700, '今天'), raw(700, 800, '天气'), raw(800, 900, '很好')], 1_000);
    expect(result.status).toBe('unaligned');
    expect(result.segments).toBe(preset);
  });

  it('keeps a window too long to compare, or with an invalid duration or text', () => {
    const preset = [raw(0, 10_000, 'あ'.repeat(600), 0), raw(10_000, 20_000, 'あ'.repeat(600), 1)];
    const result = retime(preset, [raw(500, 20_500, 'あ'.repeat(1_000))], 30_000);
    expect(result).toMatchObject({ status: 'oversized', anchoredEdges: 0 });
    expect(result.segments).toBe(preset);
    // At the cap the window is still compared.
    expect(retime([raw(0, 20_000, 'あ'.repeat(1_000))], [raw(600, 20_600, 'あ'.repeat(1_000))], 30_000).status).toBe('retimed');
    for (const durationMs of [0, -1, 1.5, Number.NaN])
      expect(retime([raw(0, 2_000, '今天天气很好')], [raw(500, 2_500, '今天天气很好')], durationMs).status).toBe('unaligned');
    // Text the contract would refuse never throws here; it simply has nothing to pair.
    expect(retime([raw(0, 2_000, '\ud800今天')], [raw(500, 2_500, '今天天气很好')], 30_000).status).toBe('unaligned');
  });

  it('compares mixed CJK and Latin text as across seams', () => {
    const result = retime([raw(0, 2_000, 'ＯＫ，今日はいい天気', 0), raw(2_000, 4_000, "Let's go to the park", 1)],
      [raw(500, 2_600, 'ok 今日は、いい天気。'), raw(2_800, 4_700, 'Lets go to the PARK!')], 30_000);
    expect(times(result.segments)).toEqual([[500, 2_600], [2_800, 4_700]]);
    expect(result.anchoredEdges).toBe(4);
    expect(result.segments.map(segment => segment.text)).toEqual(['ＯＫ，今日はいい天気', "Let's go to the park"]);
  });
});
