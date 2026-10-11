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
