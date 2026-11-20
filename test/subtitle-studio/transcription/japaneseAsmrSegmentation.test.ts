import { describe, expect, it } from 'vitest';
import { planJapaneseAsmrSegmentation } from '../../../electron/main/subtitle-studio/transcription/native/japanese-asmr-segmentation';
import { detectJapaneseAsmrSpeechIntervals, japaneseAsmrFrameToMs, japaneseAsmrFrameToSample, mergeJapaneseAsmrSpeechIntervals, planJapaneseAsmrCueIntervals, type JapaneseAsmrVadOptions } from '../../../src/subtitle-studio/transcription/japanese-asmr-contract';

const options: JapaneseAsmrVadOptions = { startThreshold: 0.6, endThreshold: 0.35, minSpeechMs: 40, minSilenceMs: 60, maxCueDurationMs: 500 };

describe('Japanese ASMR segmentation', () => {
  it('maps half-open frames to samples and milliseconds', () => {
    expect(japaneseAsmrFrameToSample(3)).toBe(960);
    expect(japaneseAsmrFrameToMs(3)).toBe(60);
  });

  it('uses hysteresis and closes after a minimum silence', () => {
    const probabilities = [0, 0.7, 0.8, 0.4, 0.3, 0.2, 0.1, 0.9, 0.8, 0.1];
    expect(detectJapaneseAsmrSpeechIntervals(probabilities, options)).toEqual([
      { startFrame: 1, endFrame: 4 },
      { startFrame: 7, endFrame: 10 },
    ]);
  });

  it('merges adjacent intervals without changing frame boundaries', () => {
    expect(mergeJapaneseAsmrSpeechIntervals([
      { startFrame: 2, endFrame: 5 }, { startFrame: 7, endFrame: 10 }, { startFrame: 20, endFrame: 21 },
    ], 40)).toEqual([{ startFrame: 2, endFrame: 10 }, { startFrame: 20, endFrame: 21 }]);
  });

  it('marks intervals exceeding the recognizer limit for review', () => {
    expect(planJapaneseAsmrCueIntervals([{ startFrame: 0, endFrame: 26 }], options)).toEqual([
      { startFrame: 0, endFrame: 25, needsReview: true }, { startFrame: 25, endFrame: 26, needsReview: false },
    ]);
  });

  it('produces a stable first-stage plan for contiguous speech', () => {
    const plan = planJapaneseAsmrSegmentation([0.8, 0.8, 0.2, 0.2, 0.8, 0.8], options, 40);
    expect(plan).toEqual({ speechIntervals: [{ startFrame: 0, endFrame: 6 }], cueIntervals: [{ startFrame: 0, endFrame: 6, needsReview: false }] });
  });
});
