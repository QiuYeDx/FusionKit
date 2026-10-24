import { Fragment, memo, useMemo, type ReactNode } from 'react';
import type { LongTextFormat, SegmentKind } from '@/long-text/contract';
import { project } from '@/long-text/inline';
import type { InlineMark } from '@/long-text/model';

/**
 * A piece of a segment's display text and how it looks. The pieces add up to the display text
 * exactly; `shown` replaces a piece on screen (table cell separators) without changing that.
 */
export interface InlineRun {
  text: string;
  /** `lt-*` classes of the piece. */
  styles: readonly string[];
  shown?: string;
}

const TOKEN = /<x(\d+)\/>|<m(\d+)>|<\/m(\d+)>/g;

/** Markup the reader dims: everything an atom protects except code, URLs and breaks. */
const ATOM_STYLE: Readonly<Record<Extract<InlineMark, { atom: true }>['kind'], string | null>> = {
  code: 'lt-code', url: 'lt-url', html: 'lt-markup', math: 'lt-markup', footnote: 'lt-markup', escape: 'lt-markup',
  entity: 'lt-markup', break: null, sep: 'lt-sep', literal: 'lt-markup',
};

/** The style of the text inside a pair: emphasis by its delimiter, link text, image description. */
function pairStyle(mark: Extract<InlineMark, { atom: false }>): string[] {
  if (mark.kind === 'link') return ['lt-link'];
  if (mark.kind === 'image') return ['lt-alt'];
  const delimiter = mark.open.replace(/[^*_~]/g, '');
  if (delimiter.startsWith('~')) return ['lt-strike'];
  if (delimiter.length >= 3) return ['lt-strong', 'lt-em'];
  return [delimiter.length === 2 ? 'lt-strong' : 'lt-em'];
}

/**
 * The display text in styled pieces, from the marks `inline.ts` recognizes (design §6.4.3): code and
 * URLs stand out, Markdown delimiters and protected markup are dimmed, emphasis and link text keep
 * their look. The raw syntax stays visible, as in the editor. Table separators between cells show as
 * a thin bar; the outer pipes of a row are hidden.
 */
export function inlineRuns(display: string, kind: SegmentKind, format: LongTextFormat): InlineRun[] {
  if (!display) return [];
  const { text, marks } = project(display, kind, format);
  const atoms = new Map<number, Extract<InlineMark, { atom: true }>>();
  const pairs = new Map<number, Extract<InlineMark, { atom: false }>>();
  for (const mark of marks) {
    if (mark.atom) atoms.set(mark.id, mark);
    else pairs.set(mark.id, mark);
  }
  const runs: InlineRun[] = [];
  const stack: string[][] = [];
  const push = (piece: string, own: readonly string[] = [], shown?: string) => {
    if (!piece) return;
    runs.push({ text: piece, styles: [...stack.flat(), ...own], ...(shown === undefined ? {} : { shown }) });
  };
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    push(text.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[1]) {
      const atom = atoms.get(Number(match[1]));
      if (!atom) { push(match[0]); continue; }
      const style = ATOM_STYLE[atom.kind];
      if (atom.kind !== 'sep') push(atom.raw, style ? [style] : []);
      else {
        const outer = runs.length === 0 || at === text.length;
        push(atom.raw, ['lt-sep'], outer ? '' : '│');
      }
    } else if (match[2]) {
      const pair = pairs.get(Number(match[2]));
      if (!pair) { push(match[0]); continue; }
      push(pair.open, ['lt-markup']);
      stack.push(pairStyle(pair));
    } else {
      const pair = pairs.get(Number(match[3]));
      if (!pair) { push(match[0]); continue; }
      stack.pop();
      push(pair.close, ['lt-markup']);
    }
  }
  push(text.slice(at));
  return runs;
}

/** NFKC and lower case, as the main process compares search text. */
export const searchKey = (text: string): string => text.normalize('NFKC').toLowerCase();

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `[start, end)` ranges of `display` that match `query` ignoring case and width (design §4.6). Each
 * grapheme cluster is normalized on its own, so combining sequences (decomposed accents, half-width
 * voiced kana) compose as they do in the main process's whole-text NFKC, and a match maps back to
 * whole characters of the display text.
 */
export function searchRanges(display: string, query: string): Array<[number, number]> {
  const needle = searchKey(query.trim());
  if (!needle || !display) return [];
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of GRAPHEMES.segment(display)) {
    const key = searchKey(segment);
    for (let k = 0; k < key.length; k++) { starts.push(index); ends.push(index + segment.length); }
    normalized += key;
  }
  const ranges: Array<[number, number]> = [];
  for (let found = normalized.indexOf(needle); found >= 0; found = normalized.indexOf(needle, found + needle.length)) {
    const start = starts[found];
    const end = ends[found + needle.length - 1];
    const last = ranges[ranges.length - 1];
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}

/** The runs cut at the edges of `ranges`, with `marked` on the pieces inside one. */
export function markRuns(runs: readonly InlineRun[], ranges: ReadonlyArray<[number, number]>): Array<InlineRun & { marked: boolean }> {
  const result: Array<InlineRun & { marked: boolean }> = [];
  let offset = 0;
  for (const run of runs) {
    const start = offset;
    const end = offset + run.text.length;
    offset = end;
    // A replaced piece is shown whole; it is marked when a match covers any of it.
    if (run.shown !== undefined) {
      result.push({ ...run, marked: ranges.some(([from, to]) => from < end && to > start) });
      continue;
    }
    let at = start;
    for (const [from, to] of ranges) {
      if (to <= at || from >= end) continue;
      if (from > at) result.push({ ...run, text: run.text.slice(at - start, from - start), marked: false });
      const stop = Math.min(to, end);
      result.push({ ...run, text: run.text.slice(Math.max(from, at) - start, stop - start), marked: true });
      at = stop;
    }
    if (at < end) result.push({ ...run, text: run.text.slice(at - start), marked: false });
  }
  return result;
}

/** A segment's display text with its inline styles and the search matches marked. */
export const InlineText = memo(function InlineText({ text, kind, format, search }: {
  text: string;
  kind: SegmentKind;
  format: LongTextFormat;
  search?: string;
}) {
  const runs = useMemo(() => inlineRuns(text, kind, format), [text, kind, format]);
  const pieces = useMemo(() => markRuns(runs, search ? searchRanges(text, search) : []), [runs, text, search]);
  return <>{pieces.map((piece, index): ReactNode => {
    const content = piece.shown ?? piece.text;
    if (!content) return null;
    const styled = piece.styles.length ? <span className={piece.styles.join(' ')}>{content}</span> : content;
    return piece.marked ? <mark key={index} className="lt-mark">{styled}</mark> : <Fragment key={index}>{styled}</Fragment>;
  })}</>;
});
