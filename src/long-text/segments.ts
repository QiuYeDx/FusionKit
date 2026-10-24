import {
  LONG_TEXT_LIMITS, SEGMENT_KINDS, VERBATIM_KINDS,
  type LongTextFormat, type SegmentKind, type Style, type TxtSplit, type VerbatimKind,
} from './contract';
import { SEGMENT_FLAG, type PageRecord, type SegmentRecord, type SegmentTable } from './model';
import { paginate } from './pages';
import { scanMarkdown } from './segment-markdown';
import { detectTxtSplit, isChapterTitle, isSpace, scanTxt } from './segment-txt';
import { estimateTokens, joinerBetween } from './text-stats';

/**
 * Segmentation entry point (§6.3–6.5): splits S into reviewable segments and verbatim blocks, splits
 * over-long segments, numbers and paginates them, and builds the compact `SegmentTable`.
 */

/** Options of the inline functions: the normalized labels of the document's link reference definitions. */
export interface InlineContext { refs?: ReadonlySet<string> }
/**
 * Inline recognition of `inline.ts`, injected so that segmentation does not depend on it; the importer
 * passes that module's functions.
 */
export interface InlineRecognizer {
  /** Extent `[start, end)` of every inline mark, nested ones included; a pair's extent covers its text. */
  findInlineSpans(display: string, kind: SegmentKind, format: LongTextFormat, options: InlineContext): ReadonlyArray<readonly [number, number]>;
  /** Whether the projected text keeps a letter outside the atoms. */
  hasTranslatableText(display: string, kind: SegmentKind, format: LongTextFormat, options: InlineContext): boolean;
  normalizeLabel(label: string): string;
}

export interface SegmentOptions {
  /** TXT only: `auto` (the default) picks `line` or `unwrap` from the line shapes. */
  txtSplit?: TxtSplit;
  inline: InlineRecognizer;
}
export interface SegmentedDocument {
  /** `segments.jsonl`, in index order, with `pg` set. */
  records: SegmentRecord[];
  table: SegmentTable;
  pages: PageRecord[];
  /** Null for Markdown. */
  structure: { txtSplit: TxtSplit; resolved: 'line' | 'unwrap' } | null;
  detectedStyle: Style;
  /** Normalized link reference labels (Markdown), sorted; projections must use the same set as `refs`. */
  refs: string[];
}

export class SegmentationError extends Error {
  constructor(public readonly code: 'too_many_segments' | 'invalid_record') { super(code); }
}

/** Content offsets of each source line, line breaks excluded. */
export interface SourceLines { count: number; starts: Int32Array; ends: Int32Array }

/** A block found by a scanner, before display checks, splitting and numbering. */
export interface SegmentDraft {
  kind: SegmentKind;
  verbatimKind?: VerbatimKind;
  level: number;
  marker: string;
  /** Flat [start, end, …] content range of each line in S. */
  ranges: number[];
  /** Break after each line but the last: 0 soft, 1 hard, 2 soft without a joiner (`SegmentRecord.b`). */
  breaks: number[];
  prefix: string;
  hardBreak: SegmentRecord['hb'];
  chapter: boolean;
}

/** Scanners yield null once per source line; segmentation gives the event loop a turn every this many lines or drafts. */
const PAUSE_EVERY = 2_000;
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

export async function segmentDocument(format: LongTextFormat, S: string, options: SegmentOptions): Promise<SegmentedDocument> {
  const lines = splitLines(S);
  const txtSplit = options.txtSplit ?? 'auto';
  const resolved = format === 'markdown' ? null : txtSplit === 'auto' ? detectTxtSplit(S, lines) : txtSplit;
  const labels: string[] = [];
  const drafts: SegmentDraft[] = [];
  let scanned = 0;
  // Reference links may come before their definitions, so every draft is collected before inline recognition.
  for (const draft of resolved ? scanTxt(S, lines, resolved) : scanMarkdown(S, lines, labels)) {
    if (!draft) {
      if (++scanned % PAUSE_EVERY === 0) await pause();
    } else if (drafts.push(draft) > LONG_TEXT_LIMITS.segments) {
      throw new SegmentationError('too_many_segments');
    }
  }
  const refs = [...new Set(labels.map(label => options.inline.normalizeLabel(label)))].sort();
  const writer = new RecordWriter(S, format, options.inline, format === 'markdown' ? { refs: new Set(refs) } : {});
  for (let k = 0; k < drafts.length; k++) {
    writer.add(drafts[k]);
    if ((k + 1) % PAUSE_EVERY === 0) await pause();
  }
  const { records } = writer;
  const pages = paginate(records, index => displaySource(S, records[index]), format);
  pages.forEach((page, number) => {
    for (let i = page.start; i <= page.end; i++) records[i].pg = number;
  });
  return {
    records,
    table: buildSegmentTable(records),
    pages,
    structure: resolved ? { txtSplit, resolved } : null,
    detectedStyle: writer.style(),
    refs,
  };
}

/** Splits S at `\r\n`, `\n` and `\r`. */
export function splitLines(S: string): SourceLines {
  let count = 1;
  for (let i = 0; i < S.length; i++) {
    const code = S.charCodeAt(i);
    if (code === 0x0a || (code === 0x0d && S.charCodeAt(i + 1) !== 0x0a)) count++;
  }
  const starts = new Int32Array(count);
  const ends = new Int32Array(count);
  let line = 0;
  for (let i = 0; i < S.length; i++) {
    const code = S.charCodeAt(i);
    if (code !== 0x0a && code !== 0x0d) continue;
    ends[line] = i;
    if (code === 0x0d && S.charCodeAt(i + 1) === 0x0a) i++;
    starts[++line] = i + 1;
  }
  ends[line] = S.length;
  return { count, starts, ends };
}

/**
 * Joins lines `from … from + count − 1`: soft breaks (0) with `joinerBetween`, hard breaks (1) with
 * `\n`, and soft breaks without a joiner (2) with nothing.
 */
function joinLines(S: string, ranges: ArrayLike<number>, breaks: ArrayLike<number>, from: number, count: number, anchors?: number[]): string {
  let text = '';
  for (let j = from; j < from + count; j++) {
    const line = S.slice(ranges[2 * j], ranges[2 * j + 1]);
    const b = breaks[j - 1];
    if (j > from) text += b === 1 ? '\n' : b === 2 ? '' : joinerBetween(text, line);
    anchors?.push(text.length);
    text += line;
  }
  return text;
}

/** The text a segment is read, projected, searched and given as context by (§6.4.4). */
export function displaySource(S: string, record: Pick<SegmentRecord, 'r' | 'b'>): string {
  return joinLines(S, record.r, record.b, 0, record.r.length / 2);
}

/** `displaySource` of segment `index` of a loaded table. */
export function displayAt(S: string, table: SegmentTable, index: number): string {
  return joinLines(S, table.lineRanges, table.lineBreaks, table.lineStart[index], table.lineCount[index]);
}

type Spans = ReadonlyArray<readonly [number, number]>;

const SPLITTABLE: ReadonlySet<SegmentKind> = new Set(['paragraph', 'quote', 'list_item', 'footnote', 'line']);
const DIALOGUE = /^[「『“"]/;
const INLINE_CODE = /`[^`\n]+`/;

/** Turns drafts into numbered records and collects the signals of the style suggestion. */
class RecordWriter {
  readonly records: SegmentRecord[] = [];
  private ordinal = 0;
  private readonly signals = { translatable: 0, chapters: 0, dialogue: 0, code: 0 };

  constructor(
    private readonly S: string,
    private readonly format: LongTextFormat,
    private readonly inline: InlineRecognizer,
    private readonly context: InlineContext,
  ) {}

  add(draft: SegmentDraft): void {
    if (draft.kind === 'verbatim') return this.push(draft, null);
    const anchors: number[] = [];
    const display = joinLines(this.S, draft.ranges, draft.breaks, 0, draft.ranges.length / 2, anchors);
    const markdown = this.format === 'markdown';
    if (markdown && !this.inline.hasTranslatableText(display, draft.kind, this.format, this.context)) return this.push(verbatimOther(draft), null);
    const tokens = estimateTokens(display);
    let spans: Spans | null = null;
    if (tokens > LONG_TEXT_LIMITS.splitTokens && SPLITTABLE.has(draft.kind)) {
      spans = this.spans(display, draft.kind);
      const pieces = splitPoints(display, spans, markdown);
      if (pieces) {
        const parts = pieces.map((piece, k) => sliceDraft(draft, anchors, piece, k === 0));
        const displays = parts.map(part => joinLines(this.S, part.ranges, part.breaks, 0, part.ranges.length / 2));
        if (markdown && displays.some(text => this.crowded(text, draft.kind))) return this.push(verbatimOther(draft), null);
        const group = this.records.length;
        parts.forEach((part, k) => this.push(part, displays[k], group));
        return;
      }
    }
    if (markdown && (spans ?? this.spans(display, draft.kind)).length > LONG_TEXT_LIMITS.inlineMarks) return this.push(verbatimOther(draft), null);
    this.push(draft, display, this.records.length, tokens);
  }

  private spans(display: string, kind: SegmentKind): Spans {
    return this.inline.findInlineSpans(display, kind, this.format, this.context);
  }

  private crowded(display: string, kind: SegmentKind): boolean {
    return this.spans(display, kind).length > LONG_TEXT_LIMITS.inlineMarks;
  }

  /** `display` is null for a verbatim block. */
  private push(draft: SegmentDraft, display: string | null, group = this.records.length, tokens?: number): void {
    const i = this.records.length;
    if (i >= LONG_TEXT_LIMITS.segments) throw new SegmentationError('too_many_segments');
    const translatable = display !== null;
    const text = display ?? joinLines(this.S, draft.ranges, draft.breaks, 0, draft.ranges.length / 2);
    const record: SegmentRecord = {
      i, o: translatable ? ++this.ordinal : 0, k: translatable ? draft.kind : 'verbatim', l: draft.level, m: draft.marker,
      t: translatable ? 1 : 0, r: draft.ranges, b: draft.breaks, cp: draft.prefix, hb: draft.hardBreak,
      g: group, n: tokens ?? estimateTokens(text), ch: translatable && draft.chapter ? 1 : 0, pg: 0,
    };
    if (!translatable) record.vk = draft.verbatimKind ?? 'other';
    this.records.push(record);
    this.count(record, text);
  }

  private count(record: SegmentRecord, display: string): void {
    const { signals } = this;
    if (!record.t) {
      if (record.vk === 'code') signals.code++;
      return;
    }
    signals.translatable++;
    if (DIALOGUE.test(display)) signals.dialogue++;
    if (this.format === 'txt') {
      signals.chapters += record.ch;
      return;
    }
    if (INLINE_CODE.test(display)) signals.code++;
    if (record.k === 'heading' && isChapterTitle(display)) signals.chapters++;
  }

  /** technical: code in at least 5% of the segments (Markdown); literary: 3 chapter titles or 10% dialogue. */
  style(): Style {
    const { translatable, chapters, dialogue, code } = this.signals;
    if (this.format === 'markdown' && code > 0 && code >= 0.05 * this.records.length) return 'technical';
    if (chapters >= 3 || (dialogue > 0 && dialogue >= 0.1 * translatable)) return 'literary';
    return 'general';
  }
}

const verbatimOther = (draft: SegmentDraft): SegmentDraft => ({ ...draft, kind: 'verbatim', verbatimKind: 'other', chapter: false });

const SENTENCE_END = /[。！？!?…]+[」』”"’)）]*|[.!?][”"’)）]*(?=\s)/gu;
/** Whitespace, the lightest character, estimates at 0.15 tokens: no longer text fits in one chunk. */
const MAX_CHUNK_CHARS = Math.floor((LONG_TEXT_LIMITS.chunkTokens - 1) / 0.15);
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Display ranges of the chunks an over-long segment is split into, each estimated at no more than
 * `chunkTokens`: cut after the last sentence end that fits, else at the whitespace nearest the most
 * that fits within `hardCutChars`, else hard, never inside an inline mark nor a surrogate pair.
 * `strict` (Markdown) gives up with null when no cut avoids the marks; otherwise a hard cut may go
 * through one.
 */
function splitPoints(display: string, spans: Spans, strict: boolean): Array<[number, number]> | null {
  const { chunkTokens, hardCutChars } = LONG_TEXT_LIMITS;
  const blocked = new Uint8Array(display.length + 1);
  for (const [start, end] of spans) blocked.fill(1, start + 1, end);
  const ends: number[] = [];
  for (const match of display.matchAll(SENTENCE_END)) {
    const cut = match.index + match[0].length;
    if (cut < display.length && !blocked[cut]) ends.push(cut);
  }
  const fits = (from: number, to: number) => estimateTokens(display.slice(from, to)) <= chunkTokens;

  const sentenceCut = (start: number, first: number): number | null => {
    let hi = first;
    while (hi < ends.length && ends[hi] - start <= MAX_CHUNK_CHARS) hi++;
    let lo = first;
    let best: number | null = null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fits(start, ends[mid])) { best = ends[mid]; lo = mid + 1; } else hi = mid;
    }
    return best;
  };
  const fallbackCut = (start: number): number | null => {
    let lo = start + 1;
    let hi = Math.min(display.length, start + hardCutChars);
    let target = start + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(start, mid)) { target = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let p = target; p > start; p--) if (isSpace(display.charCodeAt(p)) && !blocked[p]) return p;
    for (let p = target; p > start; p--) if (!blocked[p] && !isLowSurrogate(display.charCodeAt(p))) return p;
    if (strict) return null;
    return isLowSurrogate(display.charCodeAt(target)) && target - 1 > start ? target - 1 : target;
  };

  const pieces: Array<[number, number]> = [];
  let start = 0;
  let next = 0;
  while (start < display.length) {
    if (display.length - start <= MAX_CHUNK_CHARS && fits(start, display.length)) {
      pieces.push([start, display.length]);
      break;
    }
    while (next < ends.length && ends[next] <= start) next++;
    const cut = sentenceCut(start, next) ?? fallbackCut(start);
    if (cut === null) return null;
    let end = cut;
    while (end > start && isSpace(display.charCodeAt(end - 1))) end--;
    pieces.push([start, end]);
    start = cut;
    while (start < display.length && isSpace(display.charCodeAt(start))) start++;
  }
  return pieces;
}

/** The part of a draft shown as display `[from, to)`, mapped back to S through the line anchors. */
function sliceDraft(draft: SegmentDraft, anchors: readonly number[], [from, to]: readonly [number, number], first: boolean): SegmentDraft {
  // Last line starting at or before `from`, and last line starting before `to`.
  const lineOf = (offset: number, isEnd: boolean) => {
    let lo = 0;
    let hi = anchors.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (isEnd ? anchors[mid] < offset : anchors[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const firstLine = lineOf(from, false);
  const lastLine = lineOf(to, true);
  const ranges: number[] = [];
  for (let j = firstLine; j <= lastLine; j++) {
    const start = draft.ranges[2 * j];
    ranges.push(j === firstLine ? start + from - anchors[j] : start, j === lastLine ? start + to - anchors[j] : draft.ranges[2 * j + 1]);
  }
  return { ...draft, ranges, breaks: draft.breaks.slice(firstLine, lastLine), marker: first ? draft.marker : '', chapter: first && draft.chapter };
}

const KIND_INDEX = new Map<string, number>(SEGMENT_KINDS.map((kind, index) => [kind, index]));
const VERBATIM_INDEX = new Map<string, number>(VERBATIM_KINDS.map((kind, index) => [kind, index + 1]));
const HARD_BREAKS: readonly unknown[] = ['', '  ', '\\'];

/** Columns of the `SegmentTable`, filled one record at a time. */
class TableColumns {
  private readonly kind: number[] = [];
  private readonly level: number[] = [];
  private readonly flags: number[] = [];
  private readonly ordinal: number[] = [];
  private readonly group: number[] = [];
  private readonly tokens: number[] = [];
  private readonly page: number[] = [];
  private readonly verbatimKind: number[] = [];
  private readonly lineStart: number[] = [];
  private readonly lineCount: number[] = [];
  private readonly lineRanges: number[] = [];
  private readonly lineBreaks: number[] = [];
  private readonly markers = new Map<number, string>();
  private readonly prefixes = new Map<number, string>();

  get count(): number { return this.kind.length; }

  add(record: SegmentRecord): void {
    const lines = record.r.length / 2;
    this.kind.push(KIND_INDEX.get(record.k)!);
    this.level.push(Math.min(record.l, 255));
    this.flags.push((record.t ? SEGMENT_FLAG.translatable : 0) | (record.ch ? SEGMENT_FLAG.chapter : 0)
      | (record.hb === '\\' ? SEGMENT_FLAG.hardBreakBackslash : record.hb === '  ' ? SEGMENT_FLAG.hardBreakSpaces : 0));
    this.ordinal.push(record.o);
    this.group.push(record.g);
    this.tokens.push(record.n);
    this.page.push(record.pg);
    this.verbatimKind.push(record.vk ? VERBATIM_INDEX.get(record.vk)! : 0);
    this.lineStart.push(this.lineBreaks.length);
    this.lineCount.push(lines);
    for (let k = 0; k < record.r.length; k++) this.lineRanges.push(record.r[k]);
    for (let k = 0; k < lines; k++) this.lineBreaks.push(k < lines - 1 ? record.b[k] : 0);
    if (record.m) this.markers.set(record.i, record.m);
    if (record.cp) this.prefixes.set(record.i, record.cp);
  }

  table(): SegmentTable {
    return {
      count: this.count,
      kind: Uint8Array.from(this.kind), level: Uint8Array.from(this.level), flags: Uint8Array.from(this.flags),
      ordinal: Int32Array.from(this.ordinal), group: Int32Array.from(this.group), tokens: Uint32Array.from(this.tokens),
      page: Int32Array.from(this.page), verbatimKind: Uint8Array.from(this.verbatimKind),
      lineStart: Int32Array.from(this.lineStart), lineCount: Int32Array.from(this.lineCount),
      lineRanges: Int32Array.from(this.lineRanges), lineBreaks: Uint8Array.from(this.lineBreaks),
      markers: this.markers, prefixes: this.prefixes,
    };
  }
}

export function buildSegmentTable(records: readonly SegmentRecord[]): SegmentTable {
  const columns = new TableColumns();
  for (const record of records) columns.add(record);
  return columns.table();
}

/**
 * Loads `segments.jsonl`, checking every record, that the ranges run forward and, given the length of
 * S, that they stay inside it. Throws `SegmentationError('invalid_record')` on the first bad line.
 */
export async function loadSegmentTable(lines: AsyncIterable<string>, sourceLength = Infinity): Promise<SegmentTable> {
  const columns = new TableColumns();
  let previousEnd = 0;
  let read = 0;
  for await (const line of lines) {
    if (++read % PAUSE_EVERY === 0) await pause();
    if (!line.trim()) continue;
    if (columns.count >= LONG_TEXT_LIMITS.segments) throw new SegmentationError('too_many_segments');
    const record = parseRecord(line, columns.count, previousEnd);
    previousEnd = record.r[record.r.length - 1];
    if (previousEnd > sourceLength) throw new SegmentationError('invalid_record');
    columns.add(record);
  }
  return columns.table();
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isBit = (value: unknown) => value === 0 || value === 1;
const isBreak = (value: unknown) => value === 0 || value === 1 || value === 2;

function parseRecord(line: string, index: number, previousEnd: number): SegmentRecord {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new SegmentationError('invalid_record'); }
  const record = value as Partial<SegmentRecord> | null;
  const ranges = record?.r;
  const breaks = record?.b;
  const valid = typeof record === 'object' && record !== null
    && record.i === index && isCount(record.o) && KIND_INDEX.has(record.k as string) && isCount(record.l)
    && typeof record.m === 'string' && isBit(record.t) && typeof record.cp === 'string' && HARD_BREAKS.includes(record.hb)
    && isCount(record.g) && record.g <= index && isCount(record.n) && isBit(record.ch) && isCount(record.pg)
    && Array.isArray(ranges) && ranges.length >= 2 && ranges.length % 2 === 0
    && ranges.every((offset, k) => isCount(offset) && offset >= (k ? ranges[k - 1] : previousEnd))
    && Array.isArray(breaks) && breaks.length === ranges.length / 2 - 1 && breaks.every(isBreak)
    && (record.t === 1
      ? record.k !== 'verbatim' && record.vk === undefined && record.o > 0
      : record.k === 'verbatim' && VERBATIM_INDEX.has(record.vk as string) && record.o === 0);
  if (!valid) throw new SegmentationError('invalid_record');
  return record as SegmentRecord;
}
