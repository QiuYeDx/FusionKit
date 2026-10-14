import { z } from 'zod';

/**
 * The query rules shared by the search channel and the `replace` edit. Kept free of
 * other Studio modules, so the edit contract can use it without an import cycle.
 */
export const cueFindQuerySchema = z.string().min(1).max(200).refine(value => value.trim().length > 0);
/** How a query matches: by case, as a whole word, as a regular expression. Absent means off. */
export const cueFindOptionShape = { matchCase: z.boolean(), wholeWord: z.boolean().optional(), regex: z.boolean().optional() };
export type CueFindOptions = { matchCase: boolean; wholeWord?: boolean; regex?: boolean };
/** A regular expression search stops after this long and reports the pattern as too slow. */
export const CUE_FIND_PATTERN_TIMEOUT_MS = 3000;

/** The expression a regular expression query searches with: Unicode, every line, all matches. */
export function cueFindRegExp(query: string, matchCase: boolean): RegExp {
  return new RegExp(query, matchCase ? 'gmu' : 'gimu');
}

/** Whether a regular expression query can be built at all. */
export function validCueFindPattern(query: string): boolean {
  try { cueFindRegExp(query, true); return true; } catch { return false; }
}

/** One match in a text: [start, end) in UTF-16 offsets, and the groups a regular expression captured. */
export type CueFindMatch = { start: number; end: number; groups?: (string | null)[]; named?: Record<string, string | null> };

/**
 * Every match of `query` in `text`, left to right without overlaps. Empty matches never count.
 * A whole-word match may not touch a letter, digit or underscore at either end, except at an end
 * whose own character is Han, kana or Thai: those scripts are written without spaces.
 *
 * Self-contained on purpose (no outside names): the main process runs its source in a worker
 * thread, so that a slow regular expression can be stopped.
 */
export function matchCueText(text: string, query: string, options: CueFindOptions): CueFindMatch[] {
  const found: CueFindMatch[] = [];
  if (!query) return found;
  const word = /[\p{L}\p{N}_]/u;
  // Script extensions also cover the marks these scripts share, such as the long vowel mark ー.
  const unspaced = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Thai}]/u;
  // The code points touching [start, end): the last one inside on each side and the one outside.
  const pointAt = (index: number) => { const code = text.codePointAt(index); return code === undefined ? '' : String.fromCodePoint(code); };
  const pointBefore = (index: number) => {
    if (index <= 0) return '';
    const low = text.charCodeAt(index - 1);
    return index >= 2 && low >= 0xdc00 && low <= 0xdfff ? text.slice(index - 2, index) : text.slice(index - 1, index);
  };
  const whole = (start: number, end: number) => {
    if (!options.wholeWord) return true;
    const first = pointAt(start), last = pointBefore(end);
    const leftFree = unspaced.test(first) || !word.test(pointBefore(start));
    const rightFree = unspaced.test(last) || !word.test(pointAt(end));
    return leftFree && rightFree;
  };
  const step = (index: number) => { const code = text.codePointAt(index); return code !== undefined && code > 0xffff ? 2 : 1; };
  if (options.regex) {
    const pattern = new RegExp(query, options.matchCase ? 'gmu' : 'gimu');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index, end = start + match[0].length;
      if (end === start || !whole(start, end)) { pattern.lastIndex = start + step(start); continue; }
      found.push({ start, end, groups: match.slice(1).map(group => group ?? null),
        ...(match.groups ? { named: Object.fromEntries(Object.entries(match.groups).map(([name, value]) => [name, value ?? null])) } : {}) });
    }
    return found;
  }
  const same = (a: string, b: string) => options.matchCase ? a === b : a === b || a.toLocaleLowerCase() === b.toLocaleLowerCase();
  for (let index = 0; index + query.length <= text.length;) {
    let matched = true;
    for (let offset = 0; offset < query.length && matched; offset++) matched = same(text[index + offset], query[offset]);
    if (matched && whole(index, index + query.length)) { found.push({ start: index, end: index + query.length }); index += query.length; } else index++;
  }
  return found;
}

/**
 * The text a regular expression replacement puts in for one match: `$1`…`$99`, `$<name>`,
 * `$&` and `$$` as String.prototype.replace reads them; anything else stays as typed.
 */
export function expandCueReplacement(replacement: string, match: CueFindMatch, text: string): string {
  const groups = match.groups ?? [];
  return replacement.replace(/\$(\$|&|<([^>]*)>|(\d\d?))/g, (token: string, kind: string, name: string | undefined, digits: string | undefined) => {
    if (kind === '$') return '$';
    if (kind === '&') return text.slice(match.start, match.end);
    if (name !== undefined) return match.named && name in match.named ? match.named[name] ?? '' : token;
    // Two digits name a group when it exists; otherwise the first digit does and the second is text.
    const two = Number(digits);
    if (digits!.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
    const one = Number(digits![0]);
    if (one >= 1 && one <= groups.length) return (groups[one - 1] ?? '') + (digits!.length === 2 ? digits![1] : '');
    return token;
  });
}
