import { REPAIR_KINDS, type LanguageTag, type LongTextFormat, type RepairKind, type SegmentKind } from './contract';
import { LANGUAGE_INFO } from './languages';
import type { InlineMark } from './model';
import { joinerBetween } from './text-stats';

/**
 * Inline protection (design §6.4.3). `project` turns a display text into `{ text, marks }`: `<xN/>`
 * atoms must come back from the model unchanged and exactly once, `<mN>…</mN>` pairs keep their ends
 * while the text between them is translated. `decode` checks a model's text against the marks,
 * repairs what it may and restores the original markup.
 */

export type AtomMark = Extract<InlineMark, { atom: true }>;
export type PairMark = Extract<InlineMark, { atom: false }>;
type AtomKind = AtomMark['kind'];
type PairKind = PairMark['kind'];

export interface Projection { text: string; marks: InlineMark[] }
export interface ProjectOptions {
  /** `normalizeLabel` of every link reference definition of the document. Without them a shortcut
   * reference `[text]` stays plain text, and `[text][]` and `[text][label]` are taken as links. */
  refs?: ReadonlySet<string>;
}
export interface DecodeOptions {
  /** The last attempt repairs whatever it can instead of failing. */
  final: boolean;
  /** Decides the joiner in front of markup appended to the end. */
  joinerTarget: LanguageTag;
  format: LongTextFormat;
  /** The projected text that was sent to the model (`project(…).text`). */
  source: string;
}
export type DecodeResult = { ok: true; text: string; repaired: RepairKind[] } | { ok: false; reason: 'markup' | 'empty' };

// ---------------------------------------------------------------------------------------------
// Recognition

interface AtomNode { atom: true; kind: AtomKind; start: number; end: number }
interface PairNode { atom: false; kind: PairKind; start: number; openEnd: number; closeStart: number; end: number; children: InlineNode[] }
type InlineNode = AtomNode | PairNode;
/** What starts at a position: an atom, or (`kind: null`) plain text that must be skipped as a whole. */
interface Hit { kind: AtomKind | null; end: number }
interface Span {
  start: number; end: number;
  /** Link text and image descriptions contain no further links. */
  inLink: boolean;
  brackets?: Map<number, number>;
  /** Per closer, the smallest position from which a search for it already failed. */
  failed: Map<string, number>;
}
const span = (start: number, end: number, inLink: boolean): Span => ({ start, end, inLink, failed: new Map() });

/** Anything a model could mean as a token: half- or fullwidth brackets, slashes, letters and digits, inner spaces. */
const TOKEN_SOURCE = String.raw`[<＜]\s*([/／])?\s*([xmXMｘｍＸＭ])\s*([0-9０-９]{1,3})\s*([/／])?\s*[>＞]`;
const TOKEN_AT = new RegExp(TOKEN_SOURCE, 'y');
const TOKENS = new RegExp(TOKEN_SOURCE, 'g');
const AUTOLINK_AT = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
const OPEN_TAG_AT = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/y;
const CLOSE_TAG_AT = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;
const FOOTNOTE_AT = /\[\^[^\]\n]+\]/y;
const ENTITY_AT = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});/y;
/** Bare URLs end at whitespace, angle brackets, quotes, backticks and CJK punctuation. */
const URL_AT = /(?:https?:\/\/|www\.)[^\s<>"`‘-‟…　-〿＀-￯]+/iy;
const URL_PREFIX = /^(?:https?:\/\/|www\.)./i;
const EMAIL_AT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/y;
/** ASCII punctuation, the characters a backslash escapes. */
export const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ALNUM = /[A-Za-z0-9]/;
const EMAIL_CHAR = /[A-Za-z0-9._%+-]/;
const WORD = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const WHITESPACE = /\s/u;
const SPACE_OR_TAB = /[ \t]/;
/**
 * Block syntax a line of a paragraph-like segment must not start with (design §6.4.3 step 11). The
 * second group is the number of an ordered list marker: the backslash goes after it.
 */
const BLOCK_START = /^([ \t]{0,3})(?:#{1,6}(?=[ \t]|$)|>|[-+*](?=[ \t]|$)|(\d{1,9})[.)](?=[ \t]|$)|\||```|~~~|---)/;
/** Segment kinds whose lines may hold hard breaks and must not start with block syntax. */
export const PARAGRAPH_LIKE: ReadonlySet<SegmentKind> = new Set(['paragraph', 'quote', 'list_item', 'footnote']);

/** End of a sticky match at `at` that stays inside `end`, or −1. */
function matchAt(pattern: RegExp, text: string, at: number, end: number): number {
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  return match && at + match[0].length <= end ? at + match[0].length : -1;
}

function runLength(text: string, at: number, char: string, end: number): number {
  let q = at;
  while (q < end && text[q] === char) q++;
  return q - at;
}

/** Drops trailing punctuation from a bare URL, and closing brackets it does not open. */
function trimUrl(url: string): string {
  const count = (text: string, char: string) => text.split(char).length - 1;
  let text = url;
  for (;;) {
    const last = text[text.length - 1];
    if (`.,;:!?'"*_~`.includes(last)) text = text.slice(0, -1);
    else if (last === ')' && count(text, ')') > count(text, '(')) text = text.slice(0, -1);
    else if (last === ']' && count(text, ']') > count(text, '[')) text = text.slice(0, -1);
    else return text;
  }
}

/** Parentheses nesting allowed in a link destination; the limit keeps unbalanced text linear. */
const MAX_DESTINATION_NESTING = 32;

/** `(destination "title")` after a link text; returns the index after `)`, or −1. */
function inlineTail(text: string, at: number, end: number): number {
  const skipSpaces = (q: number) => { while (q < end && /[ \t\n]/.test(text[q])) q++; return q; };
  let q = skipSpaces(at + 1);
  if (text[q] === '<') {
    for (q++; q < end && text[q] !== '>'; q++) {
      if (text[q] === '\n' || text[q] === '<') return -1;
      if (text[q] === '\\') q++;
    }
    if (q >= end) return -1;
    q++;
  } else {
    let depth = 0;
    for (; q < end; q++) {
      const char = text[q];
      if (char === '\\' && q + 1 < end && ASCII_PUNCT.test(text[q + 1])) q++;
      else if (char === '(') { if (++depth > MAX_DESTINATION_NESTING) return -1; }
      else if (char === ')') { if (depth === 0) break; depth--; }
      else if (char <= ' ') break;
    }
    if (depth > 0) return -1;
  }
  const afterDestination = q;
  q = skipSpaces(q);
  if (q > afterDestination && q < end && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
    const opener = text[q];
    const closer = opener === '(' ? ')' : opener;
    for (q++; q < end && text[q] !== closer; q++) {
      if (text[q] === '\\') q++;
      else if (opener === '(' && text[q] === '(') return -1;
    }
    if (q >= end) return -1;
    q = skipSpaces(q + 1);
  }
  return q < end && text[q] === ')' ? q + 1 : -1;
}

/** `[label]` of a full reference link; returns the index after `]`, or −1. */
function referenceLabelEnd(text: string, at: number, end: number): number {
  for (let q = at + 1; q < end && q - at <= 1000; q++) {
    const char = text[q];
    if (char === '\\') q++;
    else if (char === '[') return -1;
    else if (char === ']') return text.slice(at + 1, q).trim() ? q + 1 : -1;
  }
  return -1;
}

function hasLetters(text: string, start: number, end: number, nodes: readonly InlineNode[]): boolean {
  let q = start;
  for (const node of nodes) {
    if (LETTER.test(text.slice(q, node.start))) return true;
    if (!node.atom && hasLetters(text, node.openEnd, node.closeStart, node.children)) return true;
    q = node.end;
  }
  return LETTER.test(text.slice(q, end));
}

/**
 * Left-to-right recognition by the priority of design §6.4.3. Atoms bind tighter than links and
 * emphasis: searches for a closing bracket or delimiter skip over them.
 */
class InlineScanner {
  private readonly markdown: boolean;
  /** Starts of maximal backtick runs, by run length. */
  private backtickRuns?: Map<number, number[]>;

  constructor(private readonly text: string, format: LongTextFormat, private readonly refs: ReadonlySet<string> | undefined) {
    this.markdown = format === 'markdown';
  }

  scan(r: Span): InlineNode[] {
    const { text } = this;
    const nodes: InlineNode[] = [];
    for (let q = r.start; q < r.end;) {
      const char = text[q];
      if (this.markdown && ((char === '[' && !r.inLink) || (char === '!' && text[q + 1] === '['))) {
        const node = this.link(q, r);
        if (node) { nodes.push(node); q = node.end; continue; }
      }
      const hit = this.tokenAt(q, r);
      if (hit) {
        if (hit.kind) nodes.push({ atom: true, kind: hit.kind, start: q, end: hit.end });
        q = hit.end;
        continue;
      }
      if (this.markdown && (char === '*' || char === '_' || char === '~')) {
        const run = runLength(text, q, char, r.end);
        const node = this.emphasis(q, run, r);
        if (node) nodes.push(node);
        q = node ? node.end : q + run;
        continue;
      }
      q++;
    }
    return nodes;
  }

  /** Table rows: unescaped `|` outside code spans separate the cells, which are scanned one by one. */
  scanTableRow(): InlineNode[] {
    const { text } = this;
    const row = span(0, text.length, false);
    const nodes: InlineNode[] = [];
    let cell = 0;
    for (let q = 0; q < text.length;) {
      const char = text[q];
      if (char === '\\' && ASCII_PUNCT.test(text[q + 1] ?? '')) { q += 2; continue; }
      if (char === '`') { q = this.codeSpan(q, row).end; continue; }
      if (char !== '|') { q++; continue; }
      let start = q;
      while (start > cell && SPACE_OR_TAB.test(text[start - 1])) start--;
      let end = q + 1;
      while (end < text.length && SPACE_OR_TAB.test(text[end])) end++;
      nodes.push(...this.scan(span(cell, start, false)), { atom: true, kind: 'sep', start, end });
      cell = q = end;
    }
    nodes.push(...this.scan(span(cell, text.length, false)));
    return nodes;
  }

  private tokenAt(q: number, r: Span): Hit | null {
    const { text } = this;
    const char = text[q];
    if (char === '\n') return { kind: 'break', end: q + 1 };
    if (char === '<' || char === '＜') {
      const end = matchAt(TOKEN_AT, text, q, r.end);
      if (end > 0) return { kind: 'literal', end };
      return char === '<' && this.markdown ? this.angle(q, r) : null;
    }
    if (this.markdown) {
      switch (char) {
        case '\\': return this.backslash(q, r);
        case '`': return this.codeSpan(q, r);
        case '$': return this.math(q, r);
        case '[': {
          const end = matchAt(FOOTNOTE_AT, text, q, r.end);
          return end > 0 ? { kind: 'footnote', end } : null;
        }
        case '&': {
          const end = matchAt(ENTITY_AT, text, q, r.end);
          return end > 0 ? { kind: 'entity', end } : null;
        }
      }
    }
    return ALNUM.test(char) ? this.bareLink(q, r) : null;
  }

  private angle(q: number, r: Span): Hit | null {
    const { text } = this;
    let end = matchAt(AUTOLINK_AT, text, q, r.end);
    if (end > 0) return { kind: 'url', end };
    if (text.startsWith('<!--', q)) {
      const close = this.indexIn('-->', q + 4, r);
      return close < 0 ? null : { kind: 'html', end: close + 3 };
    }
    end = matchAt(OPEN_TAG_AT, text, q, r.end);
    if (end < 0) end = matchAt(CLOSE_TAG_AT, text, q, r.end);
    return end > 0 ? { kind: 'html', end } : null;
  }

  /** `\(…\)` is math; any other backslash before ASCII punctuation is an escape. */
  private backslash(q: number, r: Span): Hit | null {
    const next = q + 1 < r.end ? this.text[q + 1] : '';
    if (next === '(') {
      const close = this.indexIn('\\)', q + 2, r);
      if (close > q + 2) return { kind: 'math', end: close + 2 };
    }
    return next && ASCII_PUNCT.test(next) ? { kind: 'escape', end: q + 2 } : null;
  }

  /** A code span closes at the next run of exactly as many backticks; otherwise the run is plain text. */
  private codeSpan(q: number, r: Span): Hit {
    const { text } = this;
    const length = runLength(text, q, '`', r.end);
    if (!this.backtickRuns) {
      this.backtickRuns = new Map();
      for (let p = 0; p < text.length;) {
        const run = runLength(text, p, '`', text.length);
        if (!run) { p++; continue; }
        const starts = this.backtickRuns.get(run) ?? [];
        starts.push(p);
        this.backtickRuns.set(run, starts);
        p += run;
      }
    }
    const starts = this.backtickRuns.get(length) ?? [];
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] < q + length) low = middle + 1; else high = middle;
    }
    const close = starts[low];
    return close !== undefined && close + length <= r.end ? { kind: 'code', end: close + length } : { kind: null, end: q + length };
  }

  /** `$…$` and `$$…$$`: content not empty and not starting with a space; the closer follows no space and precedes no digit. */
  private math(q: number, r: Span): Hit | null {
    const { text } = this;
    const length = text[q + 1] === '$' ? 2 : 1;
    const plain = length === 2 ? { kind: null, end: q + 2 } : null;
    const first = text[q + length];
    if (q + length >= r.end || WHITESPACE.test(first) || first === '$') return plain;
    const delimiter = '$'.repeat(length);
    const from = q + length + 1;
    if (from >= (r.failed.get(delimiter) ?? Infinity)) return plain;
    for (let p = text.indexOf(delimiter, from); p >= 0 && p + length <= r.end; p = text.indexOf(delimiter, p + 1)) {
      const before = text[p - 1];
      if (WHITESPACE.test(before) || before === '\\' || /[0-9]/.test(text[p + length] ?? '')) continue;
      return { kind: 'math', end: p + length };
    }
    r.failed.set(delimiter, from);
    return plain;
  }

  /** Bare `http(s)://` and `www.` URLs and e-mail addresses, starting at a word boundary. */
  private bareLink(q: number, r: Span): Hit | null {
    const { text } = this;
    const before = q > r.start ? text[q - 1] : '';
    if (!ALNUM.test(before) && /[hw]/i.test(text[q])) {
      URL_AT.lastIndex = q;
      const match = URL_AT.exec(text);
      if (match) {
        const url = trimUrl(text.slice(q, Math.min(q + match[0].length, r.end)));
        if (URL_PREFIX.test(url)) return { kind: 'url', end: q + url.length };
      }
    }
    if (EMAIL_CHAR.test(before)) return null;
    const end = matchAt(EMAIL_AT, text, q, r.end);
    return end > 0 ? { kind: 'url', end } : null;
  }

  /** Position of `needle` inside the span, remembering failures so repeated openers stay linear. */
  private indexIn(needle: string, from: number, r: Span): number {
    if (from >= (r.failed.get(needle) ?? Infinity)) return -1;
    const index = this.text.indexOf(needle, from);
    if (index >= 0 && index + needle.length <= r.end) return index;
    r.failed.set(needle, from);
    return -1;
  }

  /** Images (also inside link text) and links: `[text](…)`, `[text][label]`, `[text][]`, `[text]`. */
  private link(q: number, r: Span): InlineNode | null {
    const extent = this.linkExtent(q, r);
    if (!extent) return null;
    const textStart = extent.open + 1;
    const children = this.scan(span(textStart, extent.textEnd, true));
    if (!hasLetters(this.text, textStart, extent.textEnd, children)) return { atom: true, kind: 'url', start: q, end: extent.end };
    return { atom: false, kind: q === extent.open ? 'link' : 'image', start: q, openEnd: textStart, closeStart: extent.textEnd, end: extent.end, children };
  }

  private linkExtent(q: number, r: Span): { open: number; textEnd: number; end: number } | null {
    const { text } = this;
    const open = text[q] === '!' ? q + 1 : q;
    const textEnd = this.brackets(r).get(open);
    if (textEnd === undefined) return null;
    const after = textEnd + 1;
    let end = -1;
    if (text[after] === '(' && after < r.end) end = inlineTail(text, after, r.end);
    if (end < 0 && text[after] === '[' && after < r.end) {
      if (text[after + 1] === ']') end = after + 2 <= r.end && this.isReference(text.slice(open + 1, textEnd), true) ? after + 2 : -1;
      else {
        const labelEnd = referenceLabelEnd(text, after, r.end);
        if (labelEnd > 0 && this.isReference(text.slice(after + 1, labelEnd - 1), true)) end = labelEnd;
      }
    }
    if (end < 0 && this.isReference(text.slice(open + 1, textEnd), false)) end = after;
    return end < 0 ? null : { open, textEnd, end };
  }

  /** Whether `label` names a reference definition; `assumed` answers when the definitions are unknown. */
  private isReference(label: string, assumed: boolean): boolean {
    return this.refs ? this.refs.has(normalizeLabel(label)) : assumed;
  }

  /** Matching `]` of every `[` in the span, brackets inside atoms excluded. */
  private brackets(r: Span): Map<number, number> {
    if (r.brackets) return r.brackets;
    const matches = new Map<number, number>();
    const open: number[] = [];
    for (let q = r.start; q < r.end;) {
      const hit = this.tokenAt(q, r);
      if (hit) { q = hit.end; continue; }
      if (this.text[q] === '[') open.push(q);
      else if (this.text[q] === ']' && open.length) matches.set(open.pop()!, q);
      q++;
    }
    return (r.brackets = matches);
  }

  /**
   * `*`, `_` (one to three) and `~~` emphasis, simplified: the opener precedes no whitespace, the
   * closer is the next run of the same length that follows no whitespace; `_` inside a word counts as text.
   */
  private emphasis(q: number, run: number, r: Span): PairNode | null {
    const { text } = this;
    const char = text[q];
    if (char === '~' ? run !== 2 : run > 3) return null;
    if (q + run >= r.end || WHITESPACE.test(text[q + run]) || (char === '_' && WORD.test(text[q - 1] ?? ''))) return null;
    const close = this.closer(q + run, char, run, r);
    if (close < 0) return null;
    return { atom: false, kind: 'format', start: q, openEnd: q + run, closeStart: close, end: close + run, children: this.scan(span(q + run, close, r.inLink)) };
  }

  private closer(from: number, char: string, run: number, r: Span): number {
    const { text } = this;
    const key = char + run;
    if (from >= (r.failed.get(key) ?? Infinity)) return -1;
    for (let p = from; p < r.end;) {
      const current = text[p];
      if (current === char) {
        const length = runLength(text, p, char, r.end);
        if (length === run && !WHITESPACE.test(text[p - 1]) && !(char === '_' && WORD.test(text[p + run] ?? ''))) return p;
        p += length;
        continue;
      }
      if ((current === '[' && !r.inLink) || (current === '!' && text[p + 1] === '[')) {
        const extent = this.linkExtent(p, r);
        if (extent) { p = extent.end; continue; }
      }
      p = this.tokenAt(p, r)?.end ?? p + 1;
    }
    r.failed.set(key, from);
    return -1;
  }
}

/** Length of the block syntax `text` starts with, or 0. */
function blockLead(text: string): number {
  return BLOCK_START.exec(text)?.[0].length ?? 0;
}

/**
 * Block syntax the source itself writes at the start of a line (the segment start, or after a hard
 * break) becomes a `literal` atom, so that `decode` escapes only block syntax the model wrote.
 */
function protectLineStarts(display: string, nodes: readonly InlineNode[], end: number, firstLine: number | null): InlineNode[] {
  const result: InlineNode[] = [];
  let lineStart = firstLine;
  const lead = (limit: number) => {
    if (lineStart === null) return;
    const length = blockLead(display.slice(lineStart, limit));
    if (length) result.push({ atom: true, kind: 'literal', start: lineStart, end: lineStart + length });
    lineStart = null;
  };
  for (const node of nodes) {
    lead(node.start);
    if (!node.atom) node.children = protectLineStarts(display, node.children, node.closeStart, null);
    result.push(node);
    if (node.atom && node.kind === 'break') lineStart = node.end;
  }
  lead(end);
  return result;
}

function scanInline(display: string, kind: SegmentKind, format: LongTextFormat, refs: ReadonlySet<string> | undefined): InlineNode[] {
  const scanner = new InlineScanner(display, format, refs);
  const markdown = format === 'markdown';
  const nodes = markdown && kind === 'table_row' ? scanner.scanTableRow() : scanner.scan(span(0, display.length, false));
  return markdown && PARAGRAPH_LIKE.has(kind) ? protectLineStarts(display, nodes, display.length, 0) : nodes;
}

/** CommonMark label matching: case-insensitive, with inner whitespace collapsed. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

/**
 * Projects a display text for the model. Ids count from 1 per segment, atoms and pairs separately, in
 * order of appearance. TXT protects only token-like text, line breaks, URLs and e-mail addresses.
 */
export function project(display: string, kind: SegmentKind, format: LongTextFormat, options: ProjectOptions = {}): Projection {
  const marks: InlineMark[] = [];
  let atoms = 0;
  let pairs = 0;
  const emit = (start: number, end: number, nodes: readonly InlineNode[], parent: number | null): string => {
    let text = '';
    let q = start;
    for (const node of nodes) {
      text += display.slice(q, node.start);
      if (node.atom) {
        const id = ++atoms;
        marks.push({ id, atom: true, kind: node.kind, raw: display.slice(node.start, node.end) });
        text += `<x${id}/>`;
      } else {
        const id = ++pairs;
        marks.push({
          id, atom: false, kind: node.kind, parent,
          open: display.slice(node.start, node.openEnd),
          close: display.slice(node.closeStart, node.end),
          inner: display.slice(node.openEnd, node.closeStart),
        });
        text += `<m${id}>${emit(node.openEnd, node.closeStart, node.children, id)}</m${id}>`;
      }
      q = node.end;
    }
    return text + display.slice(q, end);
  };
  return { text: emit(0, display.length, scanInline(display, kind, format, options.refs), null), marks };
}

/**
 * Extent `[start, end)` of every mark `project` would make, nested ones included, in order of start;
 * a pair's extent covers its text. Segmentation cuts over-long segments outside them and counts them.
 */
export function findInlineSpans(display: string, kind: SegmentKind, format: LongTextFormat, options: ProjectOptions = {}): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const walk = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      spans.push([node.start, node.end]);
      if (!node.atom) walk(node.children);
    }
  };
  walk(scanInline(display, kind, format, options.refs));
  return spans;
}

/** Whether the projected text keeps a letter outside the atoms, i.e. has something to translate. */
export function hasTranslatableText(display: string, kind: SegmentKind, format: LongTextFormat, options: ProjectOptions = {}): boolean {
  return hasLetters(display, 0, display.length, scanInline(display, kind, format, options.refs));
}

/** What `markup_missing` looks for in a user's edit: atom raws (a separator as `|`) and link and image closes. */
export function markupRaws(marks: readonly InlineMark[]): string[] {
  const raws = new Set<string>();
  for (const mark of marks) {
    const raw = mark.atom ? (mark.kind === 'sep' ? mark.raw.trim() : mark.raw) : mark.kind === 'format' ? '' : mark.close;
    if (raw.trim()) raws.add(raw);
  }
  return [...raws];
}

// ---------------------------------------------------------------------------------------------
// Decoding

type Part =
  | { type: 'text'; text: string; repair?: boolean }
  | { type: 'atom'; id: number; appended?: boolean }
  | { type: 'open' | 'close'; id: number };

const ATOM_REPAIR: Readonly<Record<AtomKind, RepairKind>> = {
  code: 'code', url: 'url', footnote: 'url', html: 'html', math: 'math', sep: 'table',
  break: 'other', escape: 'other', entity: 'other', literal: 'other',
};
const MARKUP_FAILURE: DecodeResult = { ok: false, reason: 'markup' };
const halfwidth = (text: string) => text.replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
const withoutTokens = (text: string) => text.replace(TOKENS, '');

/** Line breaks from the model become joiners: real breaks are `break` atoms. */
function collapseNewlines(text: string): string {
  return text.replace(/[ \t]*(?:\r\n?|\n)\s*/g, (run: string, offset: number) => joinerBetween(
    withoutTokens(text.slice(Math.max(0, offset - 64), offset)),
    withoutTokens(text.slice(offset + run.length, offset + run.length + 64)),
  ));
}

/** Splits the model's text at tokens in any spelling; unknown ids and `</xN>` are dropped. */
function readParts(text: string, atoms: ReadonlyMap<number, AtomMark>, pairs: ReadonlyMap<number, PairMark>): Part[] {
  const parts: Part[] = [];
  let last = 0;
  const pushText = (end: number) => {
    if (end <= last) return;
    const previous = parts[parts.length - 1];
    if (previous?.type === 'text') previous.text += text.slice(last, end);
    else parts.push({ type: 'text', text: text.slice(last, end) });
  };
  for (const match of text.matchAll(TOKENS)) {
    const [token, lead, letter, digits, trail] = match;
    pushText(match.index);
    last = match.index + token.length;
    const id = Number(halfwidth(digits));
    if (halfwidth(letter).toLowerCase() === 'x') {
      if ((!lead || trail) && atoms.has(id)) parts.push({ type: 'atom', id });
    } else if (pairs.has(id)) parts.push({ type: lead ? 'close' : 'open', id });
  }
  pushText(text.length);
  return parts;
}

/**
 * Keeps one open and the first close after it per pair, closes open pairs at the end and reorders
 * crossed closes. Returns the link and image pairs to append, or null when a non-final attempt lost one.
 */
function repairPairs(parts: Part[], pairs: ReadonlyMap<number, PairMark>, final: boolean, repairs: Set<RepairKind>): { parts: Part[]; links: PairMark[] } | null {
  const positions = new Map<number, { opens: number[]; closes: number[] }>();
  parts.forEach((part, index) => {
    if (part.type !== 'open' && part.type !== 'close') return;
    const entry = positions.get(part.id) ?? { opens: [], closes: [] };
    (part.type === 'open' ? entry.opens : entry.closes).push(index);
    positions.set(part.id, entry);
  });
  const dropped = new Set<number>();
  const unclosed: Array<{ open: number; id: number }> = [];
  const links: PairMark[] = [];
  for (const mark of pairs.values()) {
    const { opens, closes } = positions.get(mark.id) ?? { opens: [], closes: [] };
    const open = opens[0] ?? -1;
    const close = open < 0 ? -1 : closes.find(index => index > open) ?? -1;
    for (const index of [...opens, ...closes]) if (index !== open && index !== close) dropped.add(index);
    const category = mark.kind === 'format' ? 'format' : 'link';
    if (open < 0) {
      if (mark.kind !== 'format') {
        if (!final) return null;
        links.push(mark);
      }
      repairs.add(category);
      continue;
    }
    if (close < 0) unclosed.push({ open, id: mark.id });
    if (close < 0 || opens.length > 1 || closes.length > 1) repairs.add(category);
  }
  const kept = parts.filter((_, index) => !dropped.has(index));
  unclosed.sort((a, b) => b.open - a.open);
  for (const { id } of unclosed) kept.push({ type: 'close', id });
  // Every close follows its own open, so the stack is never empty at a close.
  const stack: number[] = [];
  for (const part of kept) {
    if (part.type === 'open') stack.push(part.id);
    else if (part.type === 'close') {
      const top = stack.pop()!;
      if (top !== part.id) { part.id = top; repairs.add('format'); }
    }
  }
  return { parts: kept, links };
}

/**
 * Keeps the first of duplicated atoms and lists the missing ones to append. A missing line break is
 * dropped instead, and an atom the raw text of an appended link already carries is not repeated.
 * `repaired` counts the atoms that needed a repair.
 */
function repairAtoms(parts: Part[], atoms: ReadonlyMap<number, AtomMark>, links: readonly PairMark[], repairs: Set<RepairKind>): { parts: Part[]; appended: Part[]; repaired: number } {
  const seen = new Set<number>();
  const repaired = new Set<number>();
  const kept = parts.filter(part => {
    if (part.type !== 'atom' || atoms.get(part.id)!.kind === 'sep') return true;
    if (seen.has(part.id)) { repaired.add(part.id); return false; }
    seen.add(part.id);
    return true;
  });
  const carried = new Map<string, number>();
  const isCarried = (raw: string) => {
    const left = carried.get(raw) ?? links.reduce((count, link) => count + link.inner.split(raw).length - 1, 0);
    carried.set(raw, Math.max(0, left - 1));
    return left > 0;
  };
  const appended: Part[] = [];
  for (const mark of atoms.values()) {
    if (mark.kind === 'sep' || seen.has(mark.id)) continue;
    repaired.add(mark.id);
    if (mark.kind !== 'break' && !isCarried(mark.raw)) appended.push({ type: 'atom', id: mark.id, appended: true });
  }
  for (const id of repaired) repairs.add(ATOM_REPAIR[atoms.get(id)!.kind]);
  return { parts: kept, appended, repaired: repaired.size };
}

/** Unescaped `|` the model wrote instead of separator tokens, with the spaces and tabs around them (the sep raws carry those). */
const LITERAL_SEP = /[ \t]*(?<!\\)\|[ \t]*/g;

/** Maps literal pipes onto the expected separators by position, or null when their count differs. */
function literalSeparators(parts: Part[], expected: readonly AtomMark[]): Part[] | null {
  const count = parts.reduce((n, part) => n + (part.type === 'text' ? part.text.match(LITERAL_SEP)?.length ?? 0 : 0), 0);
  if (count !== expected.length) return null;
  let next = 0;
  return parts.flatMap((part): Part[] => (part.type !== 'text' ? [part] : part.text.split(LITERAL_SEP).flatMap((text, i): Part[] => [
    ...(i > 0 ? [{ type: 'atom' as const, id: expected[next++].id }] : []),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ])));
}

/**
 * Table separators are matched by position; a final attempt takes literal pipes for them when the
 * model wrote no separator token and as many pipes as expected, and otherwise trims or pads them at the end.
 */
function repairSeparators(parts: Part[], atoms: ReadonlyMap<number, AtomMark>, final: boolean, repairs: Set<RepairKind>): Part[] | null {
  const expected = [...atoms.values()].filter(mark => mark.kind === 'sep');
  let found = parts.filter((part): part is Extract<Part, { type: 'atom' }> => part.type === 'atom' && atoms.get(part.id)!.kind === 'sep');
  if (final && found.length === 0 && expected.length) {
    const converted = literalSeparators(parts, expected);
    if (converted) {
      repairs.add('table');
      return converted;
    }
  }
  let result = parts;
  if (found.length !== expected.length) {
    if (!final) return null;
    repairs.add('table');
    if (found.length > expected.length) {
      const extra = new Set<Part>(found.slice(expected.length));
      result = parts.filter(part => !extra.has(part));
      found = found.slice(0, expected.length);
    } else {
      const missing = expected.slice(found.length).map(mark => ({ type: 'atom' as const, id: mark.id }));
      result = [...parts, ...missing];
      found = [...found, ...missing];
    }
  }
  found.forEach((part, index) => { part.id = expected[index].id; });
  return result;
}

/** A shortcut or collapsed reference whose text was translated keeps its label: `[译文][label]`. */
function closeOf(mark: PairMark, rendered: string, innerStart: number): string {
  if (mark.kind !== 'format' && (mark.close === ']' || mark.close === '][]') && rendered.slice(innerStart) !== mark.inner) return `][${mark.inner}]`;
  return mark.close;
}

function appendJoiner(text: string, piece: string, target: LanguageTag): string {
  if (!text || WHITESPACE.test(text[text.length - 1]) || WHITESPACE.test(piece[0] ?? '')) return '';
  return LANGUAGE_INFO[target].usesSpaces ? ' ' : joinerBetween(text, piece);
}

/** Puts a backslash in front of the block syntax `text` starts with; `1\.` since a backslash before a digit escapes nothing. */
function escapeBlockStart(text: string): string {
  const match = BLOCK_START.exec(text);
  if (!match) return text;
  const at = match[1].length + (match[2]?.length ?? 0);
  return `${text.slice(0, at)}\\${text.slice(at)}`;
}

function render(parts: readonly Part[], atoms: ReadonlyMap<number, AtomMark>, pairs: ReadonlyMap<number, PairMark>, kind: SegmentKind, options: DecodeOptions): string {
  const markdown = options.format === 'markdown';
  const guardLines = markdown && PARAGRAPH_LIKE.has(kind);
  const innerStart = new Map<number, number>();
  let text = '';
  let lineStart = true;
  for (const part of parts) {
    let piece: string;
    switch (part.type) {
      case 'text':
        piece = part.text;
        if (!part.repair) {
          if (guardLines && lineStart) piece = escapeBlockStart(piece);
          if (markdown && kind === 'table_row') piece = piece.replace(/(?<!\\)\|/g, '\\|');
        }
        break;
      case 'atom': piece = atoms.get(part.id)!.raw; break;
      case 'open':
        piece = pairs.get(part.id)!.open;
        innerStart.set(part.id, text.length + piece.length);
        break;
      case 'close': piece = closeOf(pairs.get(part.id)!, text, innerStart.get(part.id)!); break;
    }
    if ((part.type === 'atom' && part.appended) || (part.type === 'text' && part.repair)) piece = appendJoiner(text, piece, options.joinerTarget) + piece;
    if (piece) lineStart = part.type === 'atom' && atoms.get(part.id)!.kind === 'break';
    text += piece;
  }
  return text;
}

/**
 * Emphasis needs its delimiters next to text (CommonMark flanking), and `project` never makes a format
 * pair whose text starts or ends with whitespace. Whitespace the model put just inside one moves out
 * across the delimiters; it is dropped at a line start or end, or next to other whitespace. Link and
 * image pairs keep theirs: link text may have spaces at its ends.
 */
function hoistFormatSpaces(parts: readonly Part[], atoms: ReadonlyMap<number, AtomMark>, pairs: ReadonlyMap<number, PairMark>): Part[] {
  const isFormat = (part: Part | undefined, type: 'open' | 'close') => part?.type === type && pairs.get(part.id)!.kind === 'format';
  const isLineEdge = (part: Part | undefined) => !part || (part.type === 'atom' && atoms.get(part.id)!.kind === 'break');
  const result: Part[] = parts.map(part => (part.type === 'text' ? { ...part } : part));
  for (let i = 0; i < result.length; i++) {
    const part = result[i];
    if (part.type !== 'text' || part.repair) continue;
    const lead = isFormat(result[i - 1], 'open') ? /^\s+/u.exec(part.text)?.[0] ?? '' : '';
    if (lead) {
      part.text = part.text.slice(lead.length);
      let j = i - 1;
      while (isFormat(result[j - 1], 'open')) j--;
      const before = result[j - 1];
      if (before?.type === 'text') {
        if (!/\s$/u.test(before.text)) before.text += lead;
      } else if (!isLineEdge(before)) {
        result.splice(j, 0, { type: 'text', text: lead });
        i++;
      }
    }
    const trail = isFormat(result[i + 1], 'close') ? /\s+$/u.exec(part.text)?.[0] ?? '' : '';
    if (trail) {
      part.text = part.text.slice(0, -trail.length);
      let j = i + 1;
      while (isFormat(result[j + 1], 'close')) j++;
      const after = result[j + 1];
      if (after?.type === 'text') {
        if (!/^\s/u.test(after.text)) after.text = trail + after.text;
      } else if (!isLineEdge(after)) {
        result.splice(j + 1, 0, { type: 'text', text: trail });
      }
    }
  }
  return result.filter(part => part.type !== 'text' || part.text);
}

/**
 * Validates and restores one item of a model response (design §6.4.3). A non-final attempt fails on a
 * lost link or image, a wrong separator count or too many repaired atoms; the final attempt repairs
 * everything, keeping every URL. An answer without text fails when the source had letters to translate.
 */
export function decode(modelText: string, marks: readonly InlineMark[], kind: SegmentKind, options: DecodeOptions): DecodeResult {
  const atoms = new Map<number, AtomMark>();
  const pairs = new Map<number, PairMark>();
  for (const mark of marks) {
    if (mark.atom) atoms.set(mark.id, mark);
    else pairs.set(mark.id, mark);
  }
  let text = collapseNewlines(modelText);
  if (!WHITESPACE.test(options.source[0] ?? '')) text = text.replace(/^\s+/u, '');
  if (!WHITESPACE.test(options.source[options.source.length - 1] ?? '')) text = text.replace(/\s+$/u, '');
  if (!/\S/u.test(withoutTokens(text)) && LETTER.test(withoutTokens(options.source))) return { ok: false, reason: 'empty' };

  const repairs = new Set<RepairKind>();
  const paired = repairPairs(readParts(text, atoms, pairs), pairs, options.final, repairs);
  if (!paired) return MARKUP_FAILURE;
  const { parts: withAtoms, appended, repaired } = repairAtoms(paired.parts, atoms, paired.links, repairs);
  if (!options.final && (repaired > 2 || repaired > 0.3 * atoms.size)) return MARKUP_FAILURE;
  const result = repairSeparators(withAtoms, atoms, options.final, repairs);
  if (!result) return MARKUP_FAILURE;
  for (const link of paired.links) appended.push({ type: 'text', text: link.open + link.inner + link.close, repair: true });
  // In a table row, the end is the end of the last cell, before a closing separator.
  const last = result[result.length - 1];
  const closingSep = last?.type === 'atom' && atoms.get(last.id)!.kind === 'sep';
  result.splice(closingSep ? result.length - 1 : result.length, 0, ...appended);
  return { ok: true, text: render(hoistFormatSpaces(result, atoms, pairs), atoms, pairs, kind, options), repaired: REPAIR_KINDS.filter(kind => repairs.has(kind)) };
}
