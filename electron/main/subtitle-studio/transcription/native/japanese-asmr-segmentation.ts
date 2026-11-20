import {
  detectJapaneseAsmrSpeechIntervals,
  mergeJapaneseAsmrSpeechIntervals,
  planJapaneseAsmrCueIntervals,
  type JapaneseAsmrCueInterval,
  type JapaneseAsmrSpeechInterval,
  type JapaneseAsmrVadOptions,
} from '../../../../../src/subtitle-studio/transcription/japanese-asmr-contract';

export interface JapaneseAsmrSegmentationPlan {
  readonly speechIntervals: readonly JapaneseAsmrSpeechInterval[];
  readonly cueIntervals: readonly JapaneseAsmrCueInterval[];
}

export function planJapaneseAsmrSegmentation(
  probabilities: readonly number[],
  options: JapaneseAsmrVadOptions,
  mergeGapMs = options.minSilenceMs,
): JapaneseAsmrSegmentationPlan {
  const detected = detectJapaneseAsmrSpeechIntervals(probabilities, options);
  const speechIntervals = mergeJapaneseAsmrSpeechIntervals(detected, mergeGapMs);
  const cueIntervals = planJapaneseAsmrCueIntervals(speechIntervals, options);
  return Object.freeze({ speechIntervals, cueIntervals });
}
