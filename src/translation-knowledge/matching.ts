import {
  ASSIGNED_CODE_POINT_RANGES,
  FULL_CASE_FOLDING,
  WORD_CODE_POINT_RANGES,
} from './unicode/16.0.0/data';

/** Persist with compiled knowledge; changing matching semantics requires a new version. */
export const MATCH_POLICY_VERSION = 'fk-tk-match/1-unicode-16.0.0' as const;

export interface LiteralMatchOptions {
  readonly mode: 'whole_term' | 'literal_phrase';
  readonly caseSensitive: boolean;
}

export interface LiteralMatch {
  /** UTF-16 offsets in normalizeForMatching(text), with end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * NFC literal matching with pinned, locale-independent Unicode full case folding.
 * Folded expansions (ß → ss, İ → i + dot) are indivisible source code points.
 * A match never starts or ends inside an expansion or a UTF-16 surrogate pair.
 */
export function matchLiteral(
  text: string,
  needle: string,
  options: LiteralMatchOptions,
): LiteralMatch[] {
  const source = normalizeForMatching(text);
  const query = normalizeForMatching(needle);
  if (!query || !source) return [];

  const folded = foldWithBoundaries(source, options.caseSensitive);
  const target = options.caseSensitive ? query : fold(query);
  const matches: LiteralMatch[] = [];
  let cursor = 0;
  while (cursor <= folded.text.length - target.length) {
    const offset = folded.text.indexOf(target, cursor);
    if (offset < 0) break;
    // Advance by one UTF-16 unit so overlapping occurrences remain observable.
    // Invalid interiors are excluded by the source-boundary map below.
    cursor = offset + 1;
    const start = folded.sourceOffsets[offset];
    const end = folded.sourceOffsets[offset + target.length];
    if (start < 0 || end < 0) continue;
    if (options.mode === 'whole_term' &&
      (isWordCodePoint(codePointBefore(source, start)) ||
        isWordCodePoint(source.codePointAt(end)))) continue;
    matches.push({ start, end, text: source.slice(start, end) });
  }
  return matches;
}

/**
 * Unicode 16.0 NFC, including on newer runtimes. Unicode guarantees normalization
 * stability for already assigned characters. Unassigned code points have no
 * decomposition and CCC=0 in this version, so they are identity barriers and are
 * never submitted to a runtime that may now assign different properties to them.
 * Requires a runtime implementing Unicode 16.0 normalization or later.
 */
export function normalizeForMatching(text: string): string {
  // ASCII is assigned and NFC-stable in every Unicode version; this is common
  // for English subtitle and terminology input and needs no table walk.
  if (/^[\u0000-\u007F]*$/u.test(text)) return text;
  const parts: string[] = [];
  let runStart = 0;
  let offset = 0;
  for (const character of text) {
    if (!inRanges(character.codePointAt(0)!, ASSIGNED_CODE_POINT_RANGES)) {
      if (runStart < offset) parts.push(text.slice(runStart, offset).normalize('NFC'));
      parts.push(character);
      runStart = offset + character.length;
    }
    offset += character.length;
  }
  if (runStart < text.length) parts.push(text.slice(runStart).normalize('NFC'));
  return parts.join('');
}

function fold(text: string): string {
  const parts: string[] = [];
  for (const character of text) {
    parts.push(FULL_CASE_FOLDING[character.codePointAt(0)!] ?? character);
  }
  return parts.join('');
}

function foldWithBoundaries(source: string, caseSensitive: boolean): {
  text: string;
  sourceOffsets: Int32Array;
} {
  const parts: string[] = [];
  for (const character of source) {
    parts.push(caseSensitive
      ? character
      : FULL_CASE_FOLDING[character.codePointAt(0)!] ?? character);
  }
  const text = parts.join('');
  const sourceOffsets = new Int32Array(text.length + 1).fill(-1);
  sourceOffsets[0] = 0;
  let sourceOffset = 0;
  let foldedOffset = 0;
  let partIndex = 0;
  for (const character of source) {
    sourceOffset += character.length;
    foldedOffset += parts[partIndex++].length;
    sourceOffsets[foldedOffset] = sourceOffset;
  }
  return { text, sourceOffsets };
}

function codePointBefore(text: string, offset: number): number | undefined {
  if (offset === 0) return undefined;
  const last = text.charCodeAt(offset - 1);
  if (last >= 0xDC00 && last <= 0xDFFF && offset >= 2) {
    const first = text.charCodeAt(offset - 2);
    if (first >= 0xD800 && first <= 0xDBFF) return text.codePointAt(offset - 2);
  }
  return last;
}

/** Pinned L*, M*, N* and Pc membership; intentionally no runtime Unicode regex. */
function isWordCodePoint(point: number | undefined): boolean {
  if (point === undefined) return false;
  return inRanges(point, WORD_CODE_POINT_RANGES);
}

function inRanges(point: number, ranges: readonly (readonly [number, number])[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [start, end] = ranges[middle];
    if (point < start) high = middle - 1;
    else if (point > end) low = middle + 1;
    else return true;
  }
  return false;
}
