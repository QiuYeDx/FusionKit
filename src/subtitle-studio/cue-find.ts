import { z } from 'zod';
import { editedText } from './cue-edit-contract';
import { idSchema, type SubtitleDocument, type SubtitleText } from './domain';
import { cueFindOptionShape, cueFindQuerySchema, expandCueReplacement, matchCueText, type CueFindMatch, type CueFindOptions } from './cue-find-query';

export { cueFindQuerySchema, type CueFindOptions, type CueFindMatch };
/** Matching cues returned at most by one search. */
export const CUE_FIND_LIMIT = 10_000;
export const cueFindFieldSchema = z.enum(['source', 'target', 'both']);
export type CueFindField = z.infer<typeof cueFindFieldSchema>;
export const cueFindRequestSchemas = {
  searchCues: z.object({ documentId: idSchema, revision: z.number().int().positive().safe(), query: cueFindQuerySchema,
    field: cueFindFieldSchema, trackId: idSchema.optional(), ...cueFindOptionShape }).strict(),
};
/** Matching cues in document order, with the number of matches in each field. */
export type CueFindResult = { cues: { cueId: string; index: number; source: number; target: number }[]; occurrences: number; truncated: boolean };

const optionsOf = (options: boolean | CueFindOptions): CueFindOptions => typeof options === 'boolean' ? { matchCase: options } : options;

/** Where `query` occurs in `plain`, left to right without overlaps, as [start, end) offsets. */
export function findRanges(plain: string, query: string, options: boolean | CueFindOptions): [number, number][] {
  return matchCueText(plain, query, optionsOf(options)).map(match => [match.start, match.end]);
}

/** The texts a search looks at, in document order: each cue's source and/or its translation on the track. */
export function searchTexts(doc: SubtitleDocument, request: { field: CueFindField; trackId?: string }) {
  const track = request.trackId ? doc.translationTracks.find(item => item.id === request.trackId) : undefined;
  return doc.cues.map((cue, index) => {
    const entry = track?.entries[cue.id];
    return { cueId: cue.id, index, source: request.field === 'target' ? undefined : cue.source.plain, target: request.field === 'source' || !entry ? undefined : entry.text.plain };
  });
}

/**
 * The cues whose source and/or translation on `trackId` match, as the list shows them.
 * `count` gives the number of matches in one text; by default it matches here.
 */
export function searchDocument(doc: SubtitleDocument, request: { query: string; field: CueFindField; trackId?: string } & CueFindOptions, limit = CUE_FIND_LIMIT,
  count: (text: string, at: { index: number; field: 'source' | 'target' }) => number = text => matchCueText(text, request.query, request).length): CueFindResult {
  const cues: CueFindResult['cues'] = [];
  let occurrences = 0, truncated = false;
  for (const item of searchTexts(doc, request)) {
    const source = item.source === undefined ? 0 : count(item.source, { index: item.index, field: 'source' });
    const target = item.target === undefined ? 0 : count(item.target, { index: item.index, field: 'target' });
    if (!source && !target) continue;
    if (cues.length >= limit) { truncated = true; continue; }
    cues.push({ cueId: item.cueId, index: item.index, source, target });
    occurrences += source + target;
  }
  return { cues, occurrences, truncated };
}

/**
 * The text with every match replaced, or null when nothing matches. Matches inside one styled
 * span keep its style; when one crosses spans, the line is rebuilt as an inline edit would be.
 * A regular expression replacement expands `$1`, `$<name>`, `$&` and `$$` per match; `matches`
 * may give the matches found elsewhere (the main process finds them in a worker).
 */
export function replaceText(text: SubtitleText, query: string, replacement: string, options: boolean | CueFindOptions, matches?: readonly CueFindMatch[]): SubtitleText | null {
  const settings = optionsOf(options);
  const found = matches ?? matchCueText(text.plain, query, settings);
  if (!found.length) return null;
  const insert = (match: CueFindMatch) => settings.regex ? expandCueReplacement(replacement, match, text.plain) : replacement;
  let start = 0;
  const bounds = text.spans.map(span => { const range = [start, start + span.text.length] as const; start += span.text.length; return range; });
  const inside = found.every(({ start: from, end: to }) => bounds.some(([a, b]) => from >= a && to <= b));
  const replaceIn = (value: string, offset: number) => {
    let result = '', at = 0;
    for (const match of found) {
      const from = match.start - offset, to = match.end - offset;
      if (from < 0 || to > value.length) continue;
      result += value.slice(at, from) + insert(match);
      at = to;
    }
    return result + value.slice(at);
  };
  if (inside) {
    const spans = text.spans.map((span, index) => ({ text: replaceIn(span.text, bounds[index][0]), marks: [...span.marks] })).filter(span => span.text);
    return { plain: spans.map(span => span.text).join(''), spans };
  }
  return editedText(text, replaceIn(text.plain, 0));
}
