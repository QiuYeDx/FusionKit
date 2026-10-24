import { LONG_TEXT_LIMITS, type LongTextFormat } from './contract';
import type { PageRecord, SegmentRecord } from './model';

/**
 * Pagination (§6.5): fills pages from the first segment on. A chapter heading starts a new page once
 * the current one holds `chapterMinSegments` translatable segments; a page closes at `pageSegments`
 * segments, verbatim blocks included, and never lets its translatable token estimate pass
 * `pageTokens` unless a single segment does.
 */
export function paginate(
  records: ReadonlyArray<Pick<SegmentRecord, 'k' | 't' | 'n' | 'ch'>>,
  displayOf: (index: number) => string,
  format: LongTextFormat,
): PageRecord[] {
  const { pageSegments, pageTokens, chapterMinSegments } = LONG_TEXT_LIMITS;
  const pages: PageRecord[] = [];
  let start = 0;
  let translatable = 0;
  let tokens = 0;
  const close = (end: number) => {
    let title: string | null = null;
    for (let i = start; i <= end && title === null; i++) if (records[i].k === 'heading') title = pageTitle(displayOf(i), format);
    pages.push({ start, end, title });
    start = end + 1;
    translatable = 0;
    tokens = 0;
  };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (i > start && ((record.ch && translatable >= chapterMinSegments) || (record.t && tokens + record.n > pageTokens))) close(i - 1);
    if (record.t) {
      translatable++;
      tokens += record.n;
    }
    if (i - start + 1 >= pageSegments || tokens >= pageTokens) close(i);
  }
  if (start < records.length) close(records.length - 1);
  return pages;
}

const TITLE_CHARS = 60;
/** Inline Markdown reduced to its text: link and image text stay, destinations, footnote references and tags go. */
const MARKUP: ReadonlyArray<readonly [RegExp, string]> = [
  [/!?\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1'],
  [/\[\^[^\]]+\]/g, ''],
  [/<\/?[A-Za-z][^>]*>/g, ''],
  [/(?<!\\)(\*{1,3}|_{1,3}|~~)(?=\S)(.*?[^\s\\])\1/g, '$2'],
  [/(`+)(.+?)\1/g, '$2'],
  [/\\([!-/:-@[-`{-~])/g, '$1'],
];

/** A heading's display text without inline markup, on one line, cut to 60 characters. */
export function pageTitle(display: string, format: LongTextFormat): string {
  let text = display;
  if (format === 'markdown') for (const [pattern, replacement] of MARKUP) text = text.replace(pattern, replacement);
  return Array.from(text.replace(/\s*\n\s*/g, ' ').trim()).slice(0, TITLE_CHARS).join('').trimEnd();
}
