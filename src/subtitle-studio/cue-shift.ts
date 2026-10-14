import { z } from 'zod';
import { idSchema, StudioError } from './domain';

/** Furthest one shift moves the cues, either way. */
export const CUE_SHIFT_MAX_MS = 86_400_000;
export const cueShiftDeltaSchema = z.number().int().min(-CUE_SHIFT_MAX_MS).max(CUE_SHIFT_MAX_MS).refine(delta => delta !== 0);
/** Why the cues cannot move by that much; nothing moves then. */
export type CueShiftProblem = 'negative' | 'beyond_media' | 'before_previous';
export type CueShiftPreview = { count: number; problem?: CueShiftProblem };
export const cueShiftRequestSchemas = {
  previewCueShift: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), deltaMs: cueShiftDeltaSchema, fromCueId: idSchema.optional() }).strict(),
};

type Timed = { id: string; timing: { startMs: number; endMs: number | null } };

/** Index of the first cue that moves: `fromCueId`, or the first cue of the document. */
export function shiftStart(cues: readonly Timed[], fromCueId?: string): number {
  if (fromCueId === undefined) return 0;
  const index = cues.findIndex(cue => cue.id === fromCueId);
  if (index < 0) throw new StudioError('invalid_input');
  return index;
}

/**
 * Whether the cues from `from` to the end can all move by `deltaMs`. A transcript
 * (`mediaDurationMs` given) must keep every line ending within its media; a shift
 * from a later cue may not move it before the start of the cue before it.
 */
export function shiftProblem(cues: readonly Timed[], from: number, deltaMs: number, mediaDurationMs?: number): CueShiftProblem | null {
  for (let index = from; index < cues.length; index++) {
    const { startMs, endMs } = cues[index].timing;
    if (startMs + deltaMs < 0) return 'negative';
    if (mediaDurationMs !== undefined && (endMs === null || endMs + deltaMs <= 0 || endMs + deltaMs > mediaDurationMs)) return 'beyond_media';
  }
  const previous = cues[from - 1]?.timing.startMs, first = cues[from]?.timing.startMs;
  if (previous !== undefined && first !== undefined && first + deltaMs < previous && first >= previous) return 'before_previous';
  return null;
}

/**
 * A stretch ratio as a fraction, so frame rate conversions are exact (23.976 is 24000/1001).
 * Times scale by num/den around an anchor: between half and twice as long, never 1.
 */
export const CUE_STRETCH_MAX_TERM = 1_000_000;
export const cueStretchRatioSchema = z.object({ num: z.number().int().min(1).max(CUE_STRETCH_MAX_TERM), den: z.number().int().min(1).max(CUE_STRETCH_MAX_TERM) }).strict()
  .refine(ratio => ratio.num !== ratio.den && ratio.num * 2 >= ratio.den && ratio.num <= ratio.den * 2);
export type CueStretchRatio = z.infer<typeof cueStretchRatioSchema>;
/** Why the cues cannot be stretched by that ratio; nothing moves then. */
export type CueStretchProblem = 'beyond_media';
/** How many cues a stretch moves, and where the last one starts before and after it (and ends after it, when known). */
export type CueStretchPreview = { count: number; lastBeforeMs?: number; lastAfterMs?: number; lastEndAfterMs?: number; problem?: CueStretchProblem };
export const cueStretchRequestSchemas = {
  previewCueStretch: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), ratio: cueStretchRatioSchema, fromCueId: idSchema.optional() }).strict(),
};

/** The frame rates offered for conversion, as exact fractions. */
export const FRAME_RATES = [
  { id: '23.976', num: 24000, den: 1001 },
  { id: '24', num: 24, den: 1 },
  { id: '25', num: 25, den: 1 },
  { id: '29.97', num: 30000, den: 1001 },
  { id: '30', num: 30, den: 1 },
] as const;
export type FrameRateId = typeof FRAME_RATES[number]['id'];

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
const reduced = (num: number, den: number): CueStretchRatio => { const divisor = gcd(num, den); return { num: num / divisor, den: den / divisor }; };

/**
 * The ratio that fits subtitles timed for `subtitleFps` to a video at `videoFps`: a frame lasts
 * longer at a lower rate, so times grow by subtitle rate ÷ video rate (25 → 23.976 is 1001/960).
 */
export function frameRateRatio(subtitleFps: FrameRateId, videoFps: FrameRateId): CueStretchRatio {
  const from = FRAME_RATES.find(rate => rate.id === subtitleFps)!, to = FRAME_RATES.find(rate => rate.id === videoFps)!;
  return reduced(from.num * to.den, from.den * to.num);
}

/** A typed ratio such as 1.0427 (up to six decimals) as a fraction, or null when it is not a number. */
export function decimalRatio(value: string): CueStretchRatio | null {
  if (!/^\d{1,2}(\.\d{1,6})?$/.test(value.trim())) return null;
  const num = Math.round(Number(value.trim()) * CUE_STRETCH_MAX_TERM);
  return num > 0 ? reduced(num, CUE_STRETCH_MAX_TERM) : null;
}

/** A time stretched around `anchorMs`, rounded to the millisecond. */
export function stretchTime(ms: number, anchorMs: number, ratio: CueStretchRatio): number {
  return anchorMs + Math.round((ms - anchorMs) * ratio.num / ratio.den);
}

/** Where a stretch is anchored: the start of the document, or the start of the first cue that moves. */
export function stretchAnchor(cues: readonly Timed[], from: number, fromCueId?: string): number {
  return fromCueId === undefined ? 0 : cues[from].timing.startMs;
}

/**
 * Whether the cues from `from` on can be stretched. The anchor never moves and the ratio is
 * positive, so times stay at or after it and keep their order; only a transcript (`mediaDurationMs`)
 * can end past its media.
 */
export function stretchProblem(cues: readonly Timed[], from: number, ratio: CueStretchRatio, anchorMs: number, mediaDurationMs?: number): CueStretchProblem | null {
  if (mediaDurationMs === undefined) return null;
  for (let index = from; index < cues.length; index++) {
    const { endMs } = cues[index].timing;
    if (endMs === null) return 'beyond_media';
    const after = stretchTime(endMs, anchorMs, ratio);
    if (after <= 0 || after > mediaDurationMs) return 'beyond_media';
  }
  return null;
}
