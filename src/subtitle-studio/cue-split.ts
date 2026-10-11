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
