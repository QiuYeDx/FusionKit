import { z } from 'zod';
import { CUE_AUDIO_LIMITS } from './cue-audio';
import { idSchema, LIMITS, StudioError, type SubtitleDocument } from './domain';

export const cueSplitRequestSchemas = {
  suggestCueSplit: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), cueId: idSchema,
    /** Where the text is split, in UTF-16 units of the cue's plain text. */
    offset: z.number().int().min(1).max(LIMITS.cueBytes) }).strict(),
};
/** `words`: at the start of the word the split falls before; `proportional`: by the share of the text before it. */
export type CueSplitSuggestion = { splitMs: number; basis: 'words' | 'proportional' };

/**
 * When to split a cue at `offset` in its text. A transcript cue with the text and times of its
 * segment splits at the start of the word the text is split before; otherwise at the share of the text before the split, between
 * the start and the end (unknown: the next cue's start, else five seconds on).
 */
export function suggestCueSplit(doc: SubtitleDocument, cueId: string, offset: number): CueSplitSuggestion {
  const index = doc.cues.findIndex(cue => cue.id === cueId);
  if (index < 0) throw new StudioError('invalid_input');
  const cue = doc.cues[index];
  const text = cue.source.plain;
  if (offset < 1 || offset >= text.length) throw new StudioError('invalid_input');
  const startMs = cue.timing.startMs;
  const endMs = cue.timing.endMs ?? doc.cues[index + 1]?.timing.startMs ?? startMs + CUE_AUDIO_LIMITS.unknownEndMs;
  if (doc.schemaVersion === 2) {
    // The cue still says and spans what the transcript heard (an undone edit counts), so its word times apply.
    const segmentId = 'segmentId' in cue ? cue.segmentId : undefined;
    const segment = doc.preservation.transcript.segments.find(item => item.id === segmentId);
    const words = segment && segment.text === text && segment.startMs === startMs && segment.endMs === cue.timing.endMs ? segment.words : undefined;
    if (words?.length && words.map(word => word.text).join('').trim() === text) {
      // Word texts carry their leading spaces; positions are counted in the trimmed text.
      const lead = words.map(word => word.text).join('').length - words.map(word => word.text).join('').trimStart().length;
      let position = -lead;
      for (const word of words) {
        if (position + word.text.length > offset) {
          if (word.startMs > startMs && word.startMs < endMs) return { splitMs: word.startMs, basis: 'words' };
          break;
        }
        position += word.text.length;
      }
    }
  }
  const share = offset / text.length;
  const splitMs = Math.round((startMs + (endMs - startMs) * share) / 10) * 10;
  return { splitMs: Math.min(Math.max(splitMs, startMs + 1), Math.max(startMs + 1, endMs - 1)), basis: 'proportional' };
}

/**
 * Where a cue's text splits so that the second part starts with `before`: its `occurrence`-th
 * appearance (from 1). Null when it does not appear, appears more than once without an occurrence,
 * or leaves either part empty.
 */
export function splitOffsetAt(text: string, before: string, occurrence?: number): number | null {
  if (!before) return null;
  const positions: number[] = [];
  for (let at = text.indexOf(before); at >= 0; at = text.indexOf(before, at + 1)) positions.push(at);
  if (occurrence === undefined && positions.length !== 1) return null;
  const offset = positions[(occurrence ?? 1) - 1];
  if (offset === undefined) return null;
  const [first, second] = splitHalves(text, offset);
  return first && second ? offset : null;
}

/** The two texts a split at `offset` leaves, without the spaces around the split. */
export function splitHalves(text: string, offset: number): [string, string] {
  return [text.slice(0, offset).trim(), text.slice(offset).trim()];
}

type Timed = { timing: { startMs: number; endMs: number | null } };
/** Longest default for a new cue, filling the gap between its neighbours. */
const DEFAULT_INSERT_MS = 2000;

/**
 * The default time of a cue inserted beside `cues[index]`: after it, from its end (or start) to the
 * next start; before it, from the previous end. At most two seconds; one second when there is no gap.
 */
export function defaultInsertTiming(cues: readonly Timed[], index: number, position: 'before' | 'after') {
  const anchor = cues[index];
  if (position === 'after') {
    const startMs = anchor.timing.endMs ?? anchor.timing.startMs;
    const next = cues[index + 1]?.timing.startMs;
    const endMs = next !== undefined && next > startMs ? Math.min(next, startMs + DEFAULT_INSERT_MS) : startMs + 1000;
    return { startMs, endMs };
  }
  const previous = cues[index - 1];
  const endMs = anchor.timing.startMs;
  const startMs = Math.max(0, previous ? Math.max(previous.timing.endMs ?? previous.timing.startMs, endMs - DEFAULT_INSERT_MS) : endMs - DEFAULT_INSERT_MS);
  return { startMs: Math.min(startMs, endMs), endMs };
}

export type CueInsertTimeProblem = 'end_required' | 'end_before_start' | 'before_previous' | 'after_next' | 'beyond_media';
/**
 * Why an inserted cue cannot take these times, by the rules the main process applies: it may not
 * start before the cue before it or after the cue after it, nor end before it starts; an unknown
 * end only where the format allows one; a transcript's lines end within its media.
 */
export function insertTimeProblem(input: { startMs: number; endMs: number | null; previousStartMs?: number; nextStartMs?: number; allowUnknownEnd: boolean; mediaDurationMs?: number }): CueInsertTimeProblem | null {
  const { startMs, endMs } = input;
  if (endMs === null && !input.allowUnknownEnd) return 'end_required';
  if (endMs !== null && endMs < startMs) return 'end_before_start';
  if (input.previousStartMs !== undefined && startMs < input.previousStartMs) return 'before_previous';
  if (input.nextStartMs !== undefined && startMs > input.nextStartMs) return 'after_next';
  if (input.mediaDurationMs !== undefined && endMs !== null && endMs > input.mediaDurationMs) return 'beyond_media';
  return null;
}
