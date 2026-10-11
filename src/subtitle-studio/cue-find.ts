import { z } from 'zod';
import { editedText } from './cue-edit-contract';
import { idSchema, type SubtitleDocument, type SubtitleText } from './domain';

/** Matching cues returned at most by one search. */
export const CUE_FIND_LIMIT = 10_000;
export const cueFindFieldSchema = z.enum(['source', 'target', 'both']);
export type CueFindField = z.infer<typeof cueFindFieldSchema>;
export const cueFindQuerySchema = z.string().min(1).max(200).refine(value => value.trim().length > 0);
export const cueFindRequestSchemas = {
  searchCues: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), query: cueFindQuerySchema,
    field: cueFindFieldSchema, trackId: idSchema.optional(), matchCase: z.boolean() }).strict(),
};
/** Matching cues in document order, with the number of matches in each field. */
export type CueFindResult = { cues: { cueId: string; index: number; source: number; target: number }[]; occurrences: number; truncated: boolean };

const same = (a: string, b: string, matchCase: boolean) => matchCase ? a === b : a === b || a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** Where `query` occurs in `plain`, left to right without overlaps, as [start, end) offsets. */
export function findRanges(plain: string, query: string, matchCase: boolean): [number, number][] {
  const ranges: [number, number][] = [];
  if (!query) return ranges;
  for (let index = 0; index + query.length <= plain.length;) {
    let matched = true;
    for (let offset = 0; offset < query.length && matched; offset++) matched = same(plain[index + offset], query[offset], matchCase);
    if (matched) { ranges.push([index, index + query.length]); index += query.length; } else index++;
  }
  return ranges;
}

/** The cues whose source and/or translation on `trackId` contain `query`, as the list shows them. */
export function searchDocument(doc: SubtitleDocument, request: { query: string; field: CueFindField; trackId?: string; matchCase: boolean }, limit = CUE_FIND_LIMIT): CueFindResult {
  const track = request.trackId ? doc.translationTracks.find(item => item.id === request.trackId) : undefined;
  const cues: CueFindResult['cues'] = [];
  let occurrences = 0, truncated = false;
  doc.cues.forEach((cue, index) => {
    const source = request.field === 'target' ? 0 : findRanges(cue.source.plain, request.query, request.matchCase).length;
    const entry = track?.entries[cue.id];
    const target = request.field === 'source' || !entry ? 0 : findRanges(entry.text.plain, request.query, request.matchCase).length;
    if (!source && !target) return;
    if (cues.length >= limit) { truncated = true; return; }
    cues.push({ cueId: cue.id, index, source, target });
    occurrences += source + target;
  });
  return { cues, occurrences, truncated };
}

/**
 * The text with every match replaced, or null when nothing matches. Matches inside one styled
 * span keep its style; when one crosses spans, the line is rebuilt as an inline edit would be.
 */
export function replaceText(text: SubtitleText, query: string, replacement: string, matchCase: boolean): SubtitleText | null {
  const ranges = findRanges(text.plain, query, matchCase);
  if (!ranges.length) return null;
  let start = 0;
  const bounds = text.spans.map(span => { const range = [start, start + span.text.length] as const; start += span.text.length; return range; });
  const inside = ranges.every(([from, to]) => bounds.some(([a, b]) => from >= a && to <= b));
  const replaceIn = (value: string, offset: number) => {
    let result = '', at = 0;
    for (const [from, to] of ranges) {
      if (from - offset < 0 || to - offset > value.length) continue;
      result += value.slice(at, from - offset) + replacement;
      at = to - offset;
    }
    return result + value.slice(at);
  };
  if (inside) {
    const spans = text.spans.map((span, index) => ({ text: replaceIn(span.text, bounds[index][0]), marks: [...span.marks] })).filter(span => span.text);
    return { plain: spans.map(span => span.text).join(''), spans };
  }
  return editedText(text, replaceIn(text.plain, 0));
}
