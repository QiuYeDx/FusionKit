import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { LongTextFormat } from '../../src/long-text/contract';
import type { SegmentRecord } from '../../src/long-text/model';
import {
  buildSegmentTable, displayAt, displaySource, segmentDocument, splitLines,
  type InlineRecognizer, type SegmentOptions,
} from '../../src/long-text/segments';

/**
 * A stand-in for `inline.ts` that knows only code spans and links in Markdown, and URLs in TXT; HTML
 * tags only count as markup for `hasTranslatableText`.
 */
const CODE_SPAN = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;
const LINK = /!?\[([^\]\n]*)\]\(([^)\s]*)\)/g;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g;
const BARE_URL = /https?:\/\/[^\s]+/g;

function markdownSpans(display: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of display.matchAll(CODE_SPAN)) spans.push([match.index, match.index + match[0].length]);
  const inCode = (at: number) => spans.some(([start, end]) => at >= start && at < end);
  for (const match of display.matchAll(LINK)) if (!inCode(match.index)) spans.push([match.index, match.index + match[0].length]);
  return spans.sort((a, b) => a[0] - b[0]);
}

export const stubInline: InlineRecognizer = {
  findInlineSpans: (display, _kind, format) => (format === 'txt'
    ? [...display.matchAll(BARE_URL)].map(match => [match.index, match.index + match[0].length] as [number, number])
    : markdownSpans(display)),
  hasTranslatableText: display => /\p{L}/u.test(display.replace(CODE_SPAN, '').replace(LINK, (_link, text: string) => text).replace(HTML_TAG, '')),
  normalizeLabel: label => label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase(),
};

export const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

export const segment = (format: LongTextFormat, S: string, options: Partial<SegmentOptions> = {}) =>
  segmentDocument(format, S, { inline: stubInline, ...options });

/**
 * Invariants (a) and (b) of §6.4.5 at the level of segmentation, plus record consistency: ranges run
 * forward through S, never cross a line break, so with no translation copying S around them gives S
 * back; numbering, groups, pages and the compact table agree with the records.
 */
export function expectInvariants(S: string, records: readonly SegmentRecord[]): void {
  let previous = 0;
  let ordinal = 0;
  let page = 0;
  let rebuilt = '';
  for (const [index, record] of records.entries()) {
    expect(record.i).toBe(index);
    expect(record.r.length).toBeGreaterThanOrEqual(2);
    expect(record.r.length % 2).toBe(0);
    expect(record.b).toHaveLength(record.r.length / 2 - 1);
    for (const offset of record.r) {
      expect(offset).toBeGreaterThanOrEqual(previous);
      previous = offset;
    }
    for (let k = 0; k < record.r.length; k += 2) expect(S.slice(record.r[k], record.r[k + 1])).not.toMatch(/[\r\n]/);
    expect(record.o).toBe(record.t ? ++ordinal : 0);
    expect(record.k === 'verbatim').toBe(record.t === 0);
    expect(record.g).toBeLessThanOrEqual(index);
    if (record.g !== index) expect(records[record.g].g).toBe(record.g);
    expect(record.pg === page || record.pg === page + 1).toBe(true);
    page = record.pg;
  }
  expect(previous).toBeLessThanOrEqual(S.length);
  let cursor = 0;
  for (const record of records) {
    const start = record.r[0];
    const end = record.r[record.r.length - 1];
    rebuilt += S.slice(cursor, start) + S.slice(start, end);
    cursor = end;
  }
  expect(rebuilt + S.slice(cursor)).toBe(S);
  const table = buildSegmentTable(records);
  expect(table.count).toBe(records.length);
  for (const record of records) expect(displayAt(S, table, record.i)).toBe(displaySource(S, record));
}

/** Runs of S outside every segment range that contain a letter, one entry per line, trimmed. */
export function uncoveredLetters(S: string, records: readonly SegmentRecord[]): string[] {
  const covered = new Uint8Array(S.length);
  for (const record of records) for (let k = 0; k < record.r.length; k += 2) covered.fill(1, record.r[k], record.r[k + 1]);
  const lines = splitLines(S);
  const runs: string[] = [];
  for (let j = 0; j < lines.count; j++) {
    let run = '';
    for (let q = lines.starts[j]; q < lines.ends[j]; q++) if (!covered[q]) run += S[q];
    if (/\p{L}/u.test(run)) runs.push(run.trim());
  }
  return runs;
}

/** Translatable records with their display text. */
export const displays = (S: string, records: readonly SegmentRecord[]) =>
  records.filter(record => record.t).map(record => displaySource(S, record));
