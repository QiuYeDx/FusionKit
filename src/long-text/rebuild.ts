import { SEGMENT_KINDS, type LongTextFormat, type SegmentKind } from './contract';
import { ASCII_PUNCT, PARAGRAPH_LIKE } from './inline';
import { SEGMENT_FLAG, type LineEnding, type SegmentTable, type TranslationRecord } from './model';
import { codeSpanEnd } from './segment-markdown';
import { isIndent } from './segment-txt';
import { displayAt } from './segments';
import { joinerBetween } from './text-stats';

/**
 * Export assembly (design §6.12): copies S and replaces the line range of each translated segment, so
 * everything outside translated segments, verbatim blocks and untranslated segments included, stays
 * byte for byte. Inserted lines end with `lineEnding`, the line ending most of S uses.
 */

export type ExportMode = 'target' | 'bilingual';
export interface RebuildOptions { mode: ExportMode; format: LongTextFormat; lineEnding: LineEnding }

type HardBreak = '' | '  ' | '\\';

/** The translation of a done segment, line breaks as `\n` and none at either end; null when there is none. */
export function translationOf(record: TranslationRecord | undefined): string | null {
  if (record?.status !== 'done' || record.target === null) return null;
  return record.target.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '') || null;
}

/**
 * The marker that ends a line before a hard break: the one the source uses, except a backslash after
 * a blank line (two spaces would only leave a blank line, which ends the paragraph) and two spaces
 * after an unescaped backslash (a second backslash would only escape it).
 */
function hardBreakAfter(line: string, preferred: HardBreak): '  ' | '\\' {
  if (!line.trim()) return '\\';
  let backslashes = 0;
  while (line[line.length - 1 - backslashes] === '\\') backslashes++;
  if (backslashes % 2) return '  ';
  return preferred || '\\';
}

/** Cells of a table row between its unescaped `|` outside code spans, edges included. */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let from = 0;
  for (let q = 0; q < row.length; q++) {
    const char = row[q];
    if (char === '\\' && ASCII_PUNCT.test(row[q + 1] ?? '')) q++;
    else if (char === '`') q = codeSpanEnd(row, q) - 1;
    else if (char === '|') {
      cells.push(row.slice(from, q));
      from = q + 1;
    }
  }
  cells.push(row.slice(from));
  return cells;
}

/**
 * `source<br>translation` per cell, keeping the source cell's padding. Empty cells and cells the
 * translation leaves unchanged keep the source alone; rows whose cell counts differ keep the source.
 */
function bilingualRow(source: string, translation: string): string {
  const sourceCells = tableCells(source);
  const targetCells = tableCells(translation);
  if (sourceCells.length !== targetCells.length) return source;
  return sourceCells.map((cell, k) => {
    const text = cell.trim();
    const translated = targetCells[k].trim();
    if (!text || !translated || translated === text) return cell;
    const lead = cell.slice(0, cell.length - cell.trimStart().length);
    const trail = cell.slice(cell.trimEnd().length);
    return `${lead}${text}<br>${translated}${trail}`;
  }).join('|');
}

/** Start of the line holding a position, for positions that never decrease between calls. */
class LineStarts {
  private scanned = 0;
  private start = 0;

  constructor(private readonly S: string) {}

  /** The spaces, tabs and U+3000 that indent the line holding `position`, up to `position`. */
  indentAt(position: number): string {
    for (; this.scanned < position; this.scanned++) {
      const code = this.S.charCodeAt(this.scanned);
      if (code === 0x0a || code === 0x0d) this.start = this.scanned + 1;
    }
    let end = this.start;
    while (end < position && isIndent(this.S.charCodeAt(end))) end++;
    return this.S.slice(this.start, end);
  }
}

class Assembler {
  private readonly lineStarts: LineStarts;
  private readonly out: string[] = [];
  private cursor = 0;

  constructor(
    private readonly S: string,
    private readonly table: SegmentTable,
    private readonly options: RebuildOptions,
  ) {
    this.lineStarts = new LineStarts(S);
  }

  /** Puts the translation of segment `index` in place of its source. */
  target(index: number, text: string): void {
    const start = this.start(index);
    this.write(start, this.end(index), this.placed(index, text, start));
  }

  /** Puts the source of segments `first … last` (one group) followed by their joined translation in place of that source. */
  bilingual(first: number, last: number, text: string): void {
    const start = this.start(first);
    const end = this.end(last);
    this.write(start, end, this.pair(first, this.S.slice(start, end), text, start));
  }

  finish(): string {
    this.out.push(this.S.slice(this.cursor));
    return this.out.join('');
  }

  private start(index: number): number {
    return this.table.lineRanges[2 * this.table.lineStart[index]];
  }

  private end(index: number): number {
    return this.table.lineRanges[2 * (this.table.lineStart[index] + this.table.lineCount[index] - 1) + 1];
  }

  /** Copies S up to `start` and writes `replacement` for `[start, end)`. */
  private write(start: number, end: number, replacement: string): void {
    this.out.push(this.S.slice(this.cursor, start), replacement);
    this.cursor = end;
  }

  /**
   * A translation as it is written in place of segment `index` starting at `start`: a hard break
   * becomes a new line indented like the segment's first line (TXT), or the hard-break marker, the
   * line ending and the continuation prefix (Markdown blocks); headings and table rows stay on one line.
   */
  private placed(index: number, text: string, start: number): string {
    const { lineEnding } = this.options;
    if (this.options.format === 'txt') return text.includes('\n') ? text.split('\n').join(lineEnding + this.lineStarts.indentAt(start)) : text;
    if (!PARAGRAPH_LIKE.has(this.kind(index))) return text.replace(/\n/g, ' ');
    const prefix = this.table.prefixes.get(index) ?? '';
    const preferred = this.hardBreak(index);
    const lines = text.split('\n');
    let result = lines[0];
    for (let k = 1; k < lines.length; k++) result += hardBreakAfter(lines[k - 1], preferred) + lineEnding + prefix + lines[k];
    return result;
  }

  /** A group's source slice followed by its translation, by the kind of its first segment (design §6.12 table). */
  private pair(index: number, source: string, text: string, start: number): string {
    const { lineEnding } = this.options;
    if (this.options.format === 'txt') return source + lineEnding + this.lineStarts.indentAt(start) + this.placed(index, text, start);
    const translation = this.placed(index, text, start);
    const prefix = this.table.prefixes.get(index) ?? '';
    switch (this.kind(index)) {
      case 'heading': return `${source} / ${translation}`;
      case 'table_row': return bilingualRow(source, translation);
      case 'list_item':
      case 'footnote': return source + hardBreakAfter(source, '\\') + lineEnding + prefix + translation;
      default: return source + lineEnding + prefix.trimEnd() + lineEnding + prefix + translation;
    }
  }

  private kind(index: number): SegmentKind {
    return SEGMENT_KINDS[this.table.kind[index]];
  }

  private hardBreak(index: number): HardBreak {
    const flags = this.table.flags[index];
    if (flags & SEGMENT_FLAG.hardBreakBackslash) return '\\';
    return flags & SEGMENT_FLAG.hardBreakSpaces ? '  ' : '';
  }
}

/**
 * Assembles the export of a document. Untranslated segments keep their source without a mark. In
 * bilingual mode the parts of a split segment are joined back: the whole source of the group, then
 * the whole translation, where a part without a translation contributes its display source.
 */
export function rebuild(S: string, table: SegmentTable, translations: ReadonlyArray<TranslationRecord | undefined>, options: RebuildOptions): string {
  const assembler = new Assembler(S, table, options);
  for (let i = 0; i < table.count; i++) {
    if (!(table.flags[i] & SEGMENT_FLAG.translatable)) continue;
    if (options.mode === 'target') {
      const text = translationOf(translations[i]);
      if (text !== null) assembler.target(i, text);
      continue;
    }
    const first = i;
    while (i + 1 < table.count && table.group[i + 1] === table.group[first]) i++;
    const parts: Array<string | null> = [];
    for (let k = first; k <= i; k++) parts.push(translationOf(translations[k]));
    if (parts.every(part => part === null)) continue;
    let text = '';
    parts.forEach((part, k) => {
      const piece = part ?? displayAt(S, table, first + k);
      text += joinerBetween(text, piece) + piece;
    });
    assembler.bilingual(first, i, text);
  }
  return assembler.finish();
}
