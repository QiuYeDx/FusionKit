import { z } from 'zod';

export const STUDIO_TRANSCRIPTION_MODES = ['standard', 'japanese_asmr'] as const;
export type StudioTranscriptionMode = typeof STUDIO_TRANSCRIPTION_MODES[number];

export const JAPANESE_ASMR_MODEL_ID = 'anime-whisper-q8_0' as const;
export const JAPANESE_ASMR_VAD_MODEL_ID = 'whisper-vad-encdec-asmr-onnx' as const;
export const JAPANESE_ASMR_FRAME_DURATION_MS = 20 as const;
export const JAPANESE_ASMR_SAMPLE_RATE = 16_000 as const;

export const japaneseAsmrModeSchema = z.literal('japanese_asmr');

export const japaneseAsmrVadOptionsSchema = z.object({
  startThreshold: z.number().finite().min(0).max(1),
  endThreshold: z.number().finite().min(0).max(1),
  minSpeechMs: z.number().int().min(JAPANESE_ASMR_FRAME_DURATION_MS),
  minSilenceMs: z.number().int().min(JAPANESE_ASMR_FRAME_DURATION_MS),
  maxCueDurationMs: z.number().int().min(500),
}).strict().superRefine((value, context) => {
  if (value.endThreshold > value.startThreshold) {
    context.addIssue({ code: 'custom', path: ['endThreshold'], message: 'End threshold cannot exceed start threshold.' });
  }
});

export type JapaneseAsmrVadOptions = z.infer<typeof japaneseAsmrVadOptionsSchema>;

export interface JapaneseAsmrSpeechInterval {
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface JapaneseAsmrCueInterval extends JapaneseAsmrSpeechInterval {
  readonly needsReview: boolean;
}

export function japaneseAsmrFrameToSample(frame: number): number {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError('Frame must be a non-negative safe integer.');
  return frame * JAPANESE_ASMR_SAMPLE_RATE * JAPANESE_ASMR_FRAME_DURATION_MS / 1000;
}

export function japaneseAsmrFrameToMs(frame: number): number {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError('Frame must be a non-negative safe integer.');
  return frame * JAPANESE_ASMR_FRAME_DURATION_MS;
}

function assertProbability(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Speech probability must be between 0 and 1.');
}

export function detectJapaneseAsmrSpeechIntervals(probabilities: readonly number[], options: JapaneseAsmrVadOptions): JapaneseAsmrSpeechInterval[] {
  const parsed = japaneseAsmrVadOptionsSchema.parse(options);
  let startFrame: number | undefined;
  let lastSpeechFrame = -1;
  const intervals: JapaneseAsmrSpeechInterval[] = [];
  const minSpeechFrames = Math.ceil(parsed.minSpeechMs / JAPANESE_ASMR_FRAME_DURATION_MS);
  const minSilenceFrames = Math.ceil(parsed.minSilenceMs / JAPANESE_ASMR_FRAME_DURATION_MS);

  const close = (endFrame: number) => {
    if (startFrame === undefined) return;
    if (endFrame - startFrame >= minSpeechFrames) intervals.push({ startFrame, endFrame });
    startFrame = undefined;
  };

  probabilities.forEach((probability, frame) => {
    assertProbability(probability);
    if (startFrame === undefined && probability >= parsed.startThreshold) startFrame = frame;
    if (startFrame !== undefined && probability >= parsed.endThreshold) lastSpeechFrame = frame;
    if (startFrame !== undefined && frame - lastSpeechFrame >= minSilenceFrames) close(lastSpeechFrame + 1);
  });
  if (startFrame !== undefined) close(probabilities.length);
  return intervals;
}

export function mergeJapaneseAsmrSpeechIntervals(
  intervals: readonly JapaneseAsmrSpeechInterval[],
  maxGapMs: number,
): JapaneseAsmrSpeechInterval[] {
  if (!Number.isInteger(maxGapMs) || maxGapMs < 0) throw new RangeError('Maximum gap must be a non-negative integer.');
  const maxGapFrames = Math.floor(maxGapMs / JAPANESE_ASMR_FRAME_DURATION_MS);
  const result: JapaneseAsmrSpeechInterval[] = [];
  for (const interval of intervals) {
    if (!Number.isSafeInteger(interval.startFrame) || !Number.isSafeInteger(interval.endFrame)
      || interval.startFrame < 0 || interval.endFrame <= interval.startFrame) throw new RangeError('Invalid speech interval.');
    const previous = result.at(-1);
    if (previous && interval.startFrame - previous.endFrame <= maxGapFrames) {
      result[result.length - 1] = { startFrame: previous.startFrame, endFrame: Math.max(previous.endFrame, interval.endFrame) };
    } else result.push({ ...interval });
  }
  return result;
}

export function planJapaneseAsmrCueIntervals(
  intervals: readonly JapaneseAsmrSpeechInterval[],
  options: Pick<JapaneseAsmrVadOptions, 'maxCueDurationMs'>,
): JapaneseAsmrCueInterval[] {
  const maxFrames = Math.floor(options.maxCueDurationMs / JAPANESE_ASMR_FRAME_DURATION_MS);
  if (maxFrames < 1) throw new RangeError('Maximum cue duration must contain at least one frame.');
  const cues: JapaneseAsmrCueInterval[] = [];
  for (const interval of intervals) {
    if (interval.endFrame <= interval.startFrame) throw new RangeError('Invalid speech interval.');
    let startFrame = interval.startFrame;
    while (interval.endFrame - startFrame > maxFrames) {
      cues.push({ startFrame, endFrame: startFrame + maxFrames, needsReview: true });
      startFrame += maxFrames;
    }
    cues.push({ startFrame, endFrame: interval.endFrame, needsReview: interval.endFrame - startFrame > maxFrames });
  }
  return cues;
}
