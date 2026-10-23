import type { VerbatimKind } from './contract';
import type { SegmentRecord } from './model';
import type { SegmentDraft, SourceLines } from './segments';

/**
 * Markdown block scanning (§6.4.1) without a Markdown library: one pass over the lines that tracks
 * open block quotes, list items and footnote definitions as a container stack, a simplified CommonMark
 * block parser. Structure it is not sure about becomes a verbatim block rather than translated text.
 */

type Container =
  | { type: 'quote' }
  /** `width`: columns a continuation line is indented by, relative to the parent's content. */
  | { type: 'item' | 'footnote'; width: number; marker: string };

interface ParagraphLine {
  start: number;
  /** End of the content, trailing whitespace and a hard-break backslash excluded. */
  end: number;
  /** End when this is the last line, where a backslash is literal text. */
  lastEnd: number;
  hard: SegmentRecord['hb'];
}
type ParagraphKind = 'paragraph' | 'quote' | 'list_item' | 'footnote';
type Leaf =
  | { type: 'paragraph'; kind: ParagraphKind; level: number; marker: string; prefix: string; lines: ParagraphLine[] }
  | { type: 'fence'; char: string; length: number; ranges: number[] }
  | { type: 'math'; close: '$$' | '\\]'; ranges: number[] }
  /** `end` null: the block ends before the next blank line. */
  | { type: 'html'; end: RegExp | null; ranges: number[] }
  /** Indented code; blank lines wait in `blank` until more code follows them. */
  | { type: 'code'; ranges: number[]; blank: number[] }
  /** `delimiter`: the next line is the delimiter row, which belongs to no segment. */
  | { type: 'table'; delimiter: boolean };

// Patterns apply to a line's content after its container prefixes and at most 3 columns of indentation.
const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/d;
const SETEXT_UNDERLINE = /^(=+|-+)[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^(?:[-+*]|(\d{1,9})[.)])(?=[ \t]|$)/;
const TASK = /^\[([ xX])\][ \t]/;
const FOOTNOTE = /^\[\^([^\]]+)\]:[ \t]?/;
/** A whole one-line definition: a destination, an optional title after whitespace, nothing else. */
const LINK_DEFINITION = /^\[([^\]^][^\]]*)\]:[ \t]*(?:<[^<>]*>|[^\s<]\S*)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const HTML_COMMENT_END = /-->/;
const HTML_RAW = /^<(?:script|pre|style|textarea)(?=[\s>]|$)/i;
const HTML_RAW_END = /<\/(?:script|pre|style|textarea)>/i;
const HTML_BLOCK = /^<\/?(?:div|p|table|pre|details|summary|section|article|figure|h[1-6]|ul|ol|li|blockquote|iframe|video|audio|picture|center|hr)(?=[\s/>]|$)/i;
/** A line that is one complete open or close tag (CommonMark HTML block type 7, which cannot interrupt a paragraph). */
const HTML_TAG_LINE = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
const FRONT_MATTER_LINES = 200;
/** Extension lines that only work on a line of their own: `:::` containers, `!!!` / `???` admonitions. */
const EXTENSION_LINE = /^(?::{3,}|(?:!!!|\?\?\?\+?)(?=[ \t]))/;
/** The first line of a GitHub alert. */
const ALERT_LINE = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;

const isSpaceOrTab = (code: number) => code === 0x20 || code === 0x09;

type MathCloser = '$$' | '\\]';
/** `single`: a `$$ … $$` or `\[ … \]` line; otherwise an opening line whose block runs to the next line ending in `close`. */
function mathStart(text: string): { single: boolean; close: MathCloser } | null {
  const trimmed = text.trimEnd();
  if (trimmed.startsWith('\\[')) {
    if (trimmed === '\\[') return { single: false, close: '\\]' };
    return trimmed.length > 4 && trimmed.endsWith('\\]') && !trimmed.slice(2, -2).includes('\\]') ? { single: true, close: '\\]' } : null;
  }
  if (!trimmed.startsWith('$$')) return null;
  if (trimmed.length >= 4 && trimmed.endsWith('$$') && !trimmed.slice(2, -2).includes('$$')) return { single: true, close: '$$' };
  return trimmed.includes('$', 2) ? null : { single: false, close: '$$' };
}

/** Undefined when `text` starts no HTML block, else how the block ends. */
function htmlStart(text: string): RegExp | null | undefined {
  if (text.startsWith('<!--')) return HTML_COMMENT_END;
  if (HTML_RAW.test(text)) return HTML_RAW_END;
  return HTML_BLOCK.test(text) ? null : undefined;
}

/**
 * End of the code span opening at `at`: after the next run of exactly as many backticks, else after
 * the opening run. Also splits table rows into cells at export (`rebuild.ts`), so both agree.
 */
export function codeSpanEnd(text: string, at: number): number {
  const runEnd = (from: number) => {
    let q = from;
    while (text[q] === '`') q++;
    return q;
  };
  const open = runEnd(at);
  for (let q = text.indexOf('`', open); q >= 0; q = text.indexOf('`', q)) {
    const close = runEnd(q);
    if (close - q === open - at) return close;
    q = close;
  }
  return open;
}

/** Number of cells of a table row, or 0 when it has no unescaped `|` outside code spans. */
export function tableCells(row: string): number {
  const text = row.trim();
  let pipes = 0;
  let first = -1;
  let last = -1;
  for (let q = 0; q < text.length; q++) {
    const char = text[q];
    if (char === '\\') {
      q++;
    } else if (char === '`') {
      q = codeSpanEnd(text, q) - 1;
    } else if (char === '|') {
      pipes++;
      if (first < 0) first = q;
      last = q;
    }
  }
  if (!pipes) return 0;
  return pipes + 1 - (first === 0 ? 1 : 0) - (last === text.length - 1 && text.length > 1 ? 1 : 0);
}

const verbatim = (verbatimKind: VerbatimKind, ranges: number[]): SegmentDraft => ({
  kind: 'verbatim', verbatimKind, level: 0, marker: '', ranges,
  breaks: new Array<number>(ranges.length / 2 - 1).fill(1), prefix: '', hardBreak: '', chapter: false,
});

class MarkdownScanner {
  private readonly stack: Container[] = [];
  private leaf: Leaf | null = null;
  private readonly out: SegmentDraft[] = [];
  /** The current line: position and column of the scan, and the end of its content. */
  private pos = 0;
  private col = 0;
  private end = 0;

  constructor(private readonly S: string, private readonly lines: SourceLines, private readonly labels: string[]) {}

  *drafts(): Generator<SegmentDraft | null> {
    const frontMatterEnd = this.frontMatterEnd();
    if (frontMatterEnd >= 0) {
      const ranges: number[] = [];
      for (let j = 0; j <= frontMatterEnd; j++) ranges.push(this.lines.starts[j], this.lines.ends[j]);
      yield verbatim('frontmatter', ranges);
    }
    for (let j = 0; j < this.lines.count; j++) {
      if (j > frontMatterEnd) this.line(j);
      yield* this.out;
      this.out.length = 0;
      yield null;
    }
    this.closeLeaf();
    yield* this.out;
  }

  /** Index of the line closing a front matter that opens on line 0, or −1. */
  private frontMatterEnd(): number {
    const { S, lines } = this;
    const lineText = (j: number) => S.slice(lines.starts[j], lines.ends[j]).trimEnd();
    const open = lines.count > 1 ? lineText(0) : '';
    if (open !== '---' && open !== '+++') return -1;
    for (let j = 1; j < Math.min(lines.count, FRONT_MATTER_LINES); j++) {
      const text = lineText(j);
      if (text === open || (open === '---' && text === '...')) return j;
    }
    return -1;
  }

  private line(j: number): void {
    this.pos = this.lines.starts[j];
    this.end = this.lines.ends[j];
    this.col = 0;
    const matched = this.matchContainers();
    const all = matched === this.stack.length;
    const leaf = this.leaf;
    if (all && leaf && leaf.type !== 'paragraph' && this.continueLeaf(leaf, j)) return;
    if (!all) {
      if (leaf?.type === 'paragraph' && !this.blankRest() && !this.startsBlock(false, j)) return this.appendLine(leaf);
      this.closeLeaf();
      this.stack.length = matched;
    }
    this.openContainers();
    if (this.blankRest()) return this.closeLeaf();
    const open = this.leaf;
    if (open?.type === 'paragraph') {
      // Every container matched and none opened: the line continues the paragraph unless it ends it.
      const { cols, pos } = this.indent();
      const underline = cols <= 3 ? SETEXT_UNDERLINE.exec(this.S.slice(pos, this.end)) : null;
      if (underline) return this.setextHeading(open, underline[1][0] === '=' ? 1 : 2);
      if (!this.startsBlock(true, j)) return this.appendLine(open);
      this.closeLeaf();
    }
    this.startBlock(j);
  }

  /** Columns of spaces and tabs (tab stops of 4) from the scan position, and where they end. */
  private indent(): { cols: number; pos: number; col: number } {
    let { pos, col } = this;
    while (pos < this.end) {
      const code = this.S.charCodeAt(pos);
      if (code === 0x20) col++;
      else if (code === 0x09) col += 4 - (col % 4);
      else break;
      pos++;
    }
    return { cols: col - this.col, pos, col };
  }

  private blankRest(): boolean {
    return this.indent().pos === this.end;
  }

  private skipColumns(columns: number): void {
    const target = this.col + columns;
    while (this.col < target && this.pos < this.end) {
      const code = this.S.charCodeAt(this.pos);
      if (code === 0x20) this.col++;
      else if (code === 0x09) this.col += 4 - (this.col % 4);
      else break;
      this.pos++;
    }
  }

  /** Consumes a `>` at `pos` and one following space or tab. */
  private consumeQuoteMarker(pos: number, col: number): void {
    this.pos = pos + 1;
    this.col = col + 1;
    const code = this.S.charCodeAt(this.pos);
    if (this.pos < this.end && isSpaceOrTab(code)) {
      this.col += code === 0x09 ? 4 - (this.col % 4) : 1;
      this.pos++;
    }
  }

  /** Consumes the prefixes of the open containers the line continues; returns how many. */
  private matchContainers(): number {
    let matched = 0;
    for (; matched < this.stack.length; matched++) {
      const container = this.stack[matched];
      const { cols, pos, col } = this.indent();
      if (container.type === 'quote') {
        if (cols > 3 || pos === this.end || this.S[pos] !== '>') break;
        this.consumeQuoteMarker(pos, col);
      } else if (pos !== this.end) {
        if (cols < container.width) break;
        this.skipColumns(container.width);
      }
    }
    return matched;
  }

  /** The content of line `j` if it continues every open container, else null. Leaves the scan state as it was. */
  private peekContent(j: number): string | null {
    const saved = [this.pos, this.col, this.end] as const;
    this.pos = this.lines.starts[j];
    this.end = this.lines.ends[j];
    this.col = 0;
    const content = this.matchContainers() === this.stack.length ? this.S.slice(this.pos, this.end) : null;
    [this.pos, this.col, this.end] = saved;
    return content;
  }

  /** Opens the block quotes, list items and footnote definitions that start at the scan position. */
  private openContainers(): void {
    const { S, end } = this;
    for (;;) {
      const { cols, pos, col } = this.indent();
      if (cols > 3 || pos === end) return;
      const base = this.col;
      if (S[pos] === '>') {
        this.closeLeaf();
        this.stack.push({ type: 'quote' });
        this.consumeQuoteMarker(pos, col);
        continue;
      }
      const text = S.slice(pos, end);
      const note = FOOTNOTE.exec(text);
      if (note) {
        this.closeLeaf();
        this.stack.push({ type: 'footnote', width: col - base + 4, marker: `[^${note[1]}]` });
        this.pos = pos + note[0].length;
        this.col = col + note[0].length;
        continue;
      }
      const item = THEMATIC_BREAK.test(text) ? null : LIST_MARKER.exec(text);
      if (!item) return;
      const markerEnd = pos + item[0].length;
      let q = markerEnd;
      let c = col + item[0].length;
      while (q < end && isSpaceOrTab(S.charCodeAt(q))) {
        c += S.charCodeAt(q) === 0x09 ? 4 - (c % 4) : 1;
        q++;
      }
      const blank = q === end;
      // Only a non-empty bullet or an ordered item starting at 1 interrupts a paragraph.
      if (this.leaf?.type === 'paragraph' && (blank || (item[1] !== undefined && Number(item[1]) !== 1))) return;
      const spacing = c - (col + item[0].length);
      const indentedCode = !blank && spacing >= 5;
      const contentCol = blank || indentedCode ? col + item[0].length + 1 : c;
      this.closeLeaf();
      const container: Container = { type: 'item', width: contentCol - base, marker: item[1] === undefined ? '•' : item[0] };
      this.stack.push(container);
      if (indentedCode) {
        this.pos = markerEnd;
        this.col = col + item[0].length;
        this.skipColumns(1);
        return;
      }
      this.pos = q;
      this.col = c;
      const task = TASK.exec(S.slice(q, q + 4));
      if (task) {
        container.marker = task[1] === ' ' ? '☐' : '☑';
        this.pos += 3;
        this.col += 3;
        return;
      }
    }
  }

  /**
   * Whether the content at the scan position starts a block that ends an open paragraph. `continuing`:
   * the line matched all of the paragraph's containers; otherwise it is a candidate lazy line.
   */
  private startsBlock(continuing: boolean, j: number): boolean {
    const { cols, pos } = this.indent();
    if (cols > 3) return false;
    const text = this.S.slice(pos, this.end);
    if (text[0] === '>' || THEMATIC_BREAK.test(text) || ATX_HEADING.test(text) || FENCE.test(text) || FOOTNOTE.test(text)
      || mathStart(text) || htmlStart(text) !== undefined || EXTENSION_LINE.test(text)) return true;
    const item = LIST_MARKER.exec(text);
    if (item) {
      // Inside its own containers a paragraph is interrupted only as `openContainers` allows.
      if (!continuing) return true;
      const blank = !text.slice(item[0].length).trim();
      if (!blank && (item[1] === undefined || Number(item[1]) === 1)) return true;
    }
    return continuing && this.tableStartsAt(j);
  }

  /** Whether line `j` is a table header: a `|` and, next, a delimiter row with as many cells. */
  private tableStartsAt(j: number): boolean {
    const { cols, pos } = this.indent();
    if (cols > 3 || j + 1 >= this.lines.count) return false;
    const cells = tableCells(this.S.slice(pos, this.end));
    if (!cells) return false;
    const next = this.peekContent(j + 1);
    return next !== null && DELIMITER_ROW.test(next) && tableCells(next) === cells;
  }

  /** Continues a leaf that owns whole lines; false when the line ends it and still needs scanning. */
  private continueLeaf(leaf: Exclude<Leaf, { type: 'paragraph' }>, j: number): boolean {
    const { cols, pos } = this.indent();
    const text = this.S.slice(pos, this.end);
    switch (leaf.type) {
      case 'fence': {
        leaf.ranges.push(this.pos, this.end);
        let run = 0;
        while (text[run] === leaf.char) run++;
        if (cols <= 3 && run >= leaf.length && !text.slice(run).trim()) this.closeLeaf();
        return true;
      }
      case 'math':
        leaf.ranges.push(this.pos, this.end);
        if (text.trimEnd().endsWith(leaf.close)) this.closeLeaf();
        return true;
      case 'html':
        if (!leaf.end && pos === this.end) {
          this.closeLeaf();
          return false;
        }
        leaf.ranges.push(this.pos, this.end);
        if (leaf.end?.test(text)) this.closeLeaf();
        return true;
      case 'code':
        if (pos === this.end) {
          leaf.blank.push(this.pos, this.end);
          return true;
        }
        if (cols < 4) {
          this.closeLeaf();
          return false;
        }
        for (const offset of leaf.blank) leaf.ranges.push(offset);
        leaf.ranges.push(this.pos, this.end);
        leaf.blank = [];
        return true;
      case 'table':
        if (leaf.delimiter) {
          leaf.delimiter = false;
          return true;
        }
        if (pos === this.end || !tableCells(text) || this.startsBlock(false, j)) {
          this.closeLeaf();
          return false;
        }
        this.takeMarker();
        this.out.push(this.singleLine('table_row', 0, pos, this.trimmedEnd(pos)));
        return true;
    }
  }

  /** Starts the leaf block at the scan position; no leaf is open. */
  private startBlock(j: number): void {
    const { S } = this;
    const { cols, pos } = this.indent();
    if (cols >= 4) {
      this.takeMarker();
      this.leaf = { type: 'code', ranges: [this.pos, this.end], blank: [] };
      return;
    }
    const text = S.slice(pos, this.end);
    const fence = FENCE.exec(text);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      this.takeMarker();
      this.leaf = { type: 'fence', char: fence[1][0], length: fence[1].length, ranges: [this.pos, this.end] };
      return;
    }
    const math = mathStart(text);
    if (math) {
      this.takeMarker();
      if (math.single) this.out.push(verbatim('math', [this.pos, this.end]));
      else this.leaf = { type: 'math', close: math.close, ranges: [this.pos, this.end] };
      return;
    }
    const html = htmlStart(text);
    if (html !== undefined) {
      this.takeMarker();
      const ranges = [this.pos, this.end];
      if (html?.test(text.slice(html === HTML_COMMENT_END ? 4 : 0))) this.out.push(verbatim('html', ranges));
      else this.leaf = { type: 'html', end: html, ranges };
      return;
    }
    // Only here: a type 7 HTML block cannot interrupt a paragraph.
    if (HTML_TAG_LINE.test(text)) {
      this.takeMarker();
      this.leaf = { type: 'html', end: null, ranges: [this.pos, this.end] };
      return;
    }
    if (THEMATIC_BREAK.test(text)) {
      this.takeMarker();
      this.out.push(verbatim('rule', [this.pos, this.end]));
      return;
    }
    // A marker line keeps a line of its own: a paragraph would join it with the next line once translated.
    // `startBlock` runs with no paragraph open, so an alert line is the first line of a block in a quote.
    if (EXTENSION_LINE.test(text) || (this.stack[this.stack.length - 1]?.type === 'quote' && ALERT_LINE.test(text))) {
      this.takeMarker();
      this.out.push(verbatim('other', [this.pos, this.end]));
      return;
    }
    const heading = ATX_HEADING.exec(text);
    if (heading) {
      this.takeMarker();
      const title = heading.indices![2];
      if (!title || title[0] === title[1]) this.out.push(verbatim('other', [this.pos, this.end]));
      else this.out.push({ ...this.singleLine('heading', heading[1].length, pos + title[0], pos + title[1]), chapter: heading[1].length <= 2 });
      return;
    }
    if (this.tableStartsAt(j)) {
      this.takeMarker();
      this.leaf = { type: 'table', delimiter: true };
      this.out.push(this.singleLine('table_row', 0, pos, this.trimmedEnd(pos)));
      return;
    }
    const definition = LINK_DEFINITION.exec(text);
    if (definition) {
      this.takeMarker();
      this.labels.push(definition[1]);
      return;
    }
    const { kind, level } = this.paragraphKind();
    const paragraph: Leaf = { type: 'paragraph', kind, level, marker: this.takeMarker(), prefix: this.prefix(), lines: [] };
    this.leaf = paragraph;
    this.appendLine(paragraph);
  }

  private trimmedEnd(start: number): number {
    let end = this.end;
    while (end > start && isSpaceOrTab(this.S.charCodeAt(end - 1))) end--;
    return end;
  }

  private singleLine(kind: 'heading' | 'table_row', level: number, start: number, end: number): SegmentDraft {
    return { kind, level, marker: '', ranges: [start, end], breaks: [], prefix: '', hardBreak: '', chapter: false };
  }

  /** Adds the rest of the line, leading whitespace excluded, to an open paragraph. */
  private appendLine(paragraph: Extract<Leaf, { type: 'paragraph' }>): void {
    const { S } = this;
    let start = this.pos;
    while (start < this.end && isSpaceOrTab(S.charCodeAt(start))) start++;
    const end = this.trimmedEnd(start);
    let spaces = 0;
    while (S.charCodeAt(this.end - 1 - spaces) === 0x20 && this.end - 1 - spaces >= end) spaces++;
    let backslashes = 0;
    while (end - 1 - backslashes >= start && S[end - 1 - backslashes] === '\\') backslashes++;
    const line: ParagraphLine = { start, end, lastEnd: end, hard: '' };
    if (spaces >= 2) line.hard = '  ';
    else if (end === this.end && backslashes % 2 === 1) {
      line.hard = '\\';
      line.end = end - 1;
    }
    paragraph.lines.push(line);
  }

  private setextHeading(paragraph: Extract<Leaf, { type: 'paragraph' }>, level: 1 | 2): void {
    this.out.push({ ...this.paragraphDraft(paragraph), kind: 'heading', level, marker: '', chapter: true });
    this.leaf = null;
  }

  private paragraphDraft({ kind, level, marker, prefix, lines }: Extract<Leaf, { type: 'paragraph' }>): SegmentDraft {
    const ranges: number[] = [];
    const breaks: number[] = [];
    let hardBreak: SegmentRecord['hb'] = '';
    lines.forEach((line, k) => {
      const last = k === lines.length - 1;
      ranges.push(line.start, last ? line.lastEnd : line.end);
      if (last) return;
      breaks.push(line.hard ? 1 : 0);
      if (!hardBreak) hardBreak = line.hard;
    });
    return { kind, level, marker, ranges, breaks, prefix, hardBreak, chapter: false };
  }

  private closeLeaf(): void {
    const { leaf } = this;
    if (!leaf) return;
    this.leaf = null;
    switch (leaf.type) {
      case 'paragraph': this.out.push(this.paragraphDraft(leaf)); break;
      case 'fence':
      case 'code': this.out.push(verbatim('code', leaf.ranges)); break;
      case 'math': this.out.push(verbatim('math', leaf.ranges)); break;
      case 'html': this.out.push(verbatim('html', leaf.ranges)); break;
      case 'table': break;
    }
  }

  /** The marker of the innermost list item or footnote, shown on the first block it holds; clears every pending marker. */
  private takeMarker(): string {
    const inner = this.stack[this.stack.length - 1];
    const marker = inner && inner.type !== 'quote' ? inner.marker : '';
    for (const container of this.stack) if (container.type !== 'quote') container.marker = '';
    return marker;
  }

  private paragraphKind(): { kind: ParagraphKind; level: number } {
    const inner = this.stack[this.stack.length - 1];
    const depth = (type: Container['type']) => this.stack.filter(container => container.type === type).length;
    if (!inner) return { kind: 'paragraph', level: 0 };
    if (inner.type === 'quote') return { kind: 'quote', level: depth('quote') };
    if (inner.type === 'item') return { kind: 'list_item', level: depth('item') };
    return { kind: 'footnote', level: 0 };
  }

  /** Continuation prefix: `> ` per block quote, the content indentation of each list item and footnote. */
  private prefix(): string {
    return this.stack.map(container => (container.type === 'quote' ? '> ' : ' '.repeat(container.width))).join('');
  }
}

/**
 * Yields the drafts of a Markdown document in order, and null after each source line. The label of
 * every link reference definition is pushed to `labels`; definitions produce no draft.
 */
export function scanMarkdown(S: string, lines: SourceLines, labels: string[]): Generator<SegmentDraft | null> {
  return new MarkdownScanner(S, lines, labels).drafts();
}
