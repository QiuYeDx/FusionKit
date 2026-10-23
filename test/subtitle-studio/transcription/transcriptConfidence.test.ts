import { describe, expect, it } from 'vitest';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../../src/subtitle-studio/transcription/domain';
import { validateLocalSubtitleTranscript } from '../../../src/subtitle-studio/transcription/ipc-contract';
import type { LocalSubtitleServerRawSegment as Raw } from '../../../electron/main/subtitle-studio/transcription/native/server-contract';
import {
  LocalSubtitlePostProcessorError,
  createSubtitlePostProcessPolicy,
  planLocalSubtitleRootWindows,
  postProcessLocalSubtitleTranscript,
  type LocalSubtitlePostProcessingWindow as Window,
  type LocalSubtitlePostProcessingWindowAttempt as Attempt,
} from '../../../electron/main/subtitle-studio/transcription/native/subtitle-post-processor';
import { planOverlapGroupReview } from '../../../electron/main/subtitle-studio/transcription/native/overlap-group-review';
import { draftOverlapGroupSplice } from '../../../electron/main/subtitle-studio/transcription/native/overlap-group-splice';

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
// The value the formula gives before rounding: exp(avg_logprob) x (1 - no_speech_prob).
const expected = (averageLogProbability: number, noSpeechProbability = 0) =>
  Math.exp(Math.min(0, averageLogProbability)) * (1 - noSpeechProbability);
const rounded = (value: number) => Math.round(value * 1000) / 1000;

function raw(startMs: number, endMs: number, text: string, averageLogProbability = -0.25, noSpeechProbability = 0.01, id = 0): Raw {
  return { id, startMs, endMs, text, temperature: 0, averageLogProbability, noSpeechProbability };
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
/** 30 s plans have one window; 55 s plans have [0, 30] and [25, 55] s owning [0, 27.5) and [27.5, 55] s. */
function run(durationMs: number, perWindow: readonly (readonly Raw[])[]) {
  const rootPlan = planLocalSubtitleRootWindows({ rootPlanId: 'plan-001', totalFrames: durationMs * 16, policy });
  expect(rootPlan.windows).toHaveLength(perWindow.length);
  return postProcessLocalSubtitleTranscript({
    source: { displayName: 'sample.wav', durationMs, totalFrames: durationMs * 16, sampleRateHz: 16_000 },
    model: MODEL, taskMode: 'transcribe', policy, rootPlan,
    attempts: rootPlan.windows.map((window, index) => attempt(window, perWindow[index]!, index)),
  });
}
const confidences = (result: ReturnType<typeof run>) => result.transcript.segments.map(segment => segment.confidence);

describe('transcript segment confidence', () => {
  it('scores a single raw segment as exp(avg_logprob) x (1 - no_speech_prob), rounded to 3 decimals', () => {
    const result = run(30_000, [[raw(1_000, 3_000, 'おはよう', -0.25, 0.01)]]);
    expect(result.transcript.segments).toEqual([
      { id: 'cue-000001', startMs: 1_000, endMs: 3_000, text: 'おはよう', confidence: 0.771 },
    ]);
    expect(rounded(expected(-0.25, 0.01))).toBe(0.771);
    expect(validateLocalSubtitleTranscript(result.transcript).ok).toBe(true);
  });

  it('stays within 0-1 with three decimals for extreme decoder values', () => {
    const cases = [[0.4, 0], [0, 0], [-0.0004, 0], [-1, 0.5], [-30, 0], [-0.1, 1], [-745, 0.2]] as const;
    const result = run(30_000, [cases.map(([logProbability, noSpeech], index) =>
      raw(1_000 + index * 2_000, 2_000 + index * 2_000, `文${index}`, logProbability, noSpeech, index))]);
    // A positive log probability is clamped to 1 instead of exceeding the range.
    expect(confidences(result)).toEqual([1, 1, 1, 0.184, 0, 0, 0]);
    for (const value of confidences(result)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(rounded(value!)).toBe(value);
    }
  });

  it('keeps a clipped observation at its own value', () => {
    // The first window's segment crosses its 27.5 s core end and is clipped there.
    const result = run(55_000, [[raw(26_000, 29_000, '境界をまたぐ文', -0.5, 0)], [raw(10_000, 12_000, '次の文', -2, 0)]]);
    expect(result.transcript.segments.map(segment => [segment.startMs, segment.endMs, segment.text]))
      .toEqual([[26_000, 27_500, '境界をまたぐ文'], [35_000, 37_000, '次の文']]);
    expect(confidences(result)).toEqual([rounded(expected(-0.5)), rounded(expected(-2))]);
  });

  it('weights a deduplicated cross-window observation by each owned duration', () => {
    // Left keeps 25.5-27.5 s (2000 ms), right keeps 27.5-28.5 s (1000 ms) of the same sentence.
    const result = run(55_000, [[raw(25_500, 28_500, '同じ文です', -0.1, 0)], [raw(2_000, 3_500, '同じ文です', -1, 0)]]);
    expect(result.report.duplicateBoundarySegmentCount).toBe(1);
    expect(result.transcript.segments).toEqual([
      { id: 'cue-000001', startMs: 25_500, endMs: 28_500, text: '同じ文です', confidence: 0.726 },
    ]);
    expect(rounded((expected(-0.1) * 2_000 + expected(-1) * 1_000) / 3_000)).toBe(0.726);
    // An unweighted mean would be 0.636.
    expect(rounded((expected(-0.1) + expected(-1)) / 2)).toBe(0.636);
  });

  it('folds a boundary fragment that trims to nothing into the previous cue', () => {
    // Right repeats only the left suffix; after trimming nothing remains, so it is absorbed.
    const result = run(55_000, [[raw(26_000, 27_500, 'そういえばさ', -0.2, 0)], [raw(2_400, 3_000, 'えばさ', -3, 0)]]);
    expect(result.report.trimmedBoundaryPrefixCount).toBe(1);
    expect(result.report.droppedBoundaryFragmentCount).toBe(1);
    expect(result.transcript.segments.map(segment => [segment.startMs, segment.endMs, segment.text]))
      .toEqual([[26_000, 28_000, 'そういえばさ']]);
    expect(confidences(result)).toEqual([rounded((expected(-0.2) * 1_500 + expected(-3) * 500) / 2_000)]);
  });

  it('leaves a trimmed but retained boundary cue at its own value', () => {
    const result = run(55_000, [[raw(26_000, 27_500, 'そういえばさ', -0.2, 0)], [raw(2_400, 5_000, 'えばさ、お風呂どうする?', -1.5, 0)]]);
    expect(result.report.trimmedBoundaryPrefixCount).toBe(1);
    expect(result.transcript.segments.map(segment => segment.text)).toEqual(['そういえばさ', 'お風呂どうする?']);
    expect(confidences(result)).toEqual([rounded(expected(-0.2)), rounded(expected(-1.5))]);
  });

  it('weighs a cue by its adjusted span after an overlap repair when it later absorbs a duplicate', () => {
    // 26.50-26.55 s overlap moves the boundary to 26.525 s, so the left "同じ文です" owns 975 ms, not 1000 ms.
    const result = run(55_000, [
      [raw(25_000, 26_550, '前の文', -0.3, 0, 0), raw(26_500, 27_500, '同じ文です', 0, 0, 1)],
      [raw(2_000, 3_000, '同じ文です', -2, 0)],
    ]);
    expect(result.report.timelineOverlapAdjustmentCount).toBe(1);
    expect(result.report.duplicateBoundarySegmentCount).toBe(1);
    expect(result.transcript.segments.map(segment => [segment.startMs, segment.endMs, segment.text]))
      .toEqual([[25_000, 26_525, '前の文'], [26_525, 28_000, '同じ文です']]);
    expect(confidences(result)).toEqual([rounded(expected(-0.3)), 0.707]);
    expect(rounded((1 * 975 + expected(-2) * 500) / 1_475)).toBe(0.707);
    expect(rounded((1 * 1_000 + expected(-2) * 500) / 1_500)).toBe(0.712);
  });

  it('ignores windows without segments and keeps the empty result a no-speech outcome', () => {
    const result = run(55_000, [[], [raw(10_000, 12_000, '後半だけ', -0.4, 0.2)]]);
    expect(confidences(result)).toEqual([rounded(expected(-0.4, 0.2))]);
    let error: unknown;
    try { run(55_000, [[], [raw(10_000, 12_000, '  ')]]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(LocalSubtitlePostProcessorError);
    expect(error).toMatchObject({ code: 'no_speech_detected', stage: 'canonical' });
  });
});

describe('overlap group splice confidence', () => {
  const first = '最初のお知らせ', last = '続きのお知らせ', phrase = first + last;
  function fixture(confidence: readonly (number | undefined)[]) {
    const window = (key: string, startMs: number, endMs: number, coreStartMs: number, coreEndMs: number) => ({
      windowKey: key, rootWindowKey: key, rootPlanId: 'p', retryDepth: 0, startMs, endMs, coreStartMs, coreEndMs,
      startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: coreStartMs * 16, coreEndFrame: coreEndMs * 16 });
    const leftWindow = window('l', 0, 30_000, 0, 27_500), rightWindow = window('r', 25_000, 55_000, 27_500, 55_000);
    const leftRaw = [raw(25_800, 29_000, phrase)], rightRaw = [raw(800, 2_800, first), raw(2_800, 4_000, last)];
    const cues = [
      { id: 'c0', startMs: 25_800, endMs: 27_500, text: phrase },
      { id: 'c1', startMs: 27_500, endMs: 27_800, text: first },
      { id: 'c2', startMs: 27_800, endMs: 29_000, text: last },
    ].map((cue, index) => confidence[index] === undefined ? cue : { ...cue, confidence: confidence[index] });
    const review = planOverlapGroupReview({ sourceIdentity: 'pcm', durationMs: 55_000, leftWindow, rightWindow, leftRaw, rightRaw, cues })!;
    expect(review).toBeDefined();
    return { review, cues };
  }

  it('keeps each retained cue confidence when its timing is re-estimated', () => {
    const { review, cues } = fixture([0.9, 0.42, 0.31]);
    const left = draftOverlapGroupSplice(review, cues, 'left'), right = draftOverlapGroupSplice(review, cues, 'right');
    if (left.status === 'rejected' || right.status === 'rejected') throw new Error('Expected review drafts');
    expect(left.replacements).toEqual([{ id: 'c0', startMs: 25_800, endMs: 29_000, text: phrase, estimatedTiming: true, confidence: 0.9 }]);
    expect(right.replacements.map(cue => [cue.id, cue.confidence])).toEqual([['c1', 0.42], ['c2', 0.31]]);
  });

  it('adds no confidence to cues of an older transcript', () => {
    const { review, cues } = fixture([undefined, undefined, undefined]);
    const left = draftOverlapGroupSplice(review, cues, 'left');
    if (left.status === 'rejected') throw new Error('Expected a review draft');
    expect(left.replacements[0]).not.toHaveProperty('confidence');
  });
});
