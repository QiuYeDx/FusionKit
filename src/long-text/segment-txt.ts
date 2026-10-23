import type { SegmentDraft, SourceLines } from './segments';
import { isCjk } from './text-stats';

/** TXT segmentation (§6.3): one segment per line, or paragraphs re-joined from hard-wrapped lines. */

const EN_NUMBER_WORDS = 'One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty|Thirty|Forty|Fifty|Sixty|Seventy|Eighty|Ninety|Hundred|First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Last';
const EN_UPPER_WORDS = EN_NUMBER_WORDS.toUpperCase();
/** A chapter number: digits, a Roman numeral or a number word (`Forty-Two`, `FIRST`). */
const EN_NUMBER = `\\d+|[IVXLC]+|(?:${EN_NUMBER_WORDS})(?:-(?:${EN_NUMBER_WORDS}))?|(?:${EN_UPPER_WORDS})(?:-(?:${EN_UPPER_WORDS}))?`;

const CHAPTER_TITLES = [
  /^\s*第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节節回卷部篇集幕话話]([\s:：·、].{0,40})?$/u,
  /^\s*(序章|序言|楔子|引子|尾声|後記|后记|番外|終章|あとがき|プロローグ|エピローグ)(\s.{0,30})?$/u,
  // `Chapter`, `Part` and `Book` need a number, so that prose such as `Part of me wanted to stay.` is no title.
  new RegExp(`^\\s*(?:Chapter|CHAPTER|Part|PART|Book|BOOK)\\s+(?:${EN_NUMBER})\\b\\.?(?:[\\s:\\-–—].{0,60})?$`, 'u'),
  /^\s*(?:Prologue|PROLOGUE|Epilogue|EPILOGUE)(?:\s*[.:\-–—]\s*.{0,60})?$/u,
];
/** Chapter titles such as `第十二章　夜`, `序章` or `Chapter IV`. */
export const isChapterTitle = (text: string) => CHAPTER_TITLES.some(pattern => pattern.test(text));

const LETTER = /\p{L}/u;
const WORD = /[\p{L}\p{N}]/u;
const TERMINAL = new Set(Array.from('。！？!?…"”’」』）)：:；;.'));
/** Nothing but the line break between two content ranges: no trailing whitespace, no indentation. */
const BARE_BREAK = /^(?:\r\n|\n|\r)$/;
/** Indentation: space, tab and U+3000. */
export const isIndent = (code: number) => code === 0x20 || code === 0x09 || code === 0x3000;
export const isSpace = (code: number) => code === 0x20 || (code >= 0x09 && code <= 0x0d) || (code > 0x7f && /\s/.test(String.fromCharCode(code)));

/** Content of a line without its indentation (spaces, tabs, U+3000) and trailing whitespace; empty for a blank line. */
function contentOf(S: string, lines: SourceLines, j: number): [number, number] {
  let start = lines.starts[j];
  let end = lines.ends[j];
  while (start < end && isIndent(S.charCodeAt(start))) start++;
  while (end > start && isSpace(S.charCodeAt(end - 1))) end--;
  return [start, end];
}

/** East Asian wide characters of the BMP; astral ones are wide in planes 2 and 3. */
const WIDE_BMP = (() => {
  const table = new Uint8Array(0x10000);
  const ranges = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
    [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  ];
  for (const [from, to] of ranges) table.fill(1, from, to + 1);
  return table;
})();

/** Columns a line takes in a monospaced editor: East Asian wide characters count 2. */
function widthOf(S: string, start: number, end: number): number {
  let width = 0;
  for (let i = start; i < end; i++) {
    const code = S.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < end) {
      const plane = 1 + ((code - 0xd800) >> 6);
      width += plane === 2 || plane === 3 ? 2 : 1;
      i++;
    } else {
      width += 1 + WIDE_BMP[code];
    }
  }
  return width;
}

/**
 * `unwrap` when the text looks hard-wrapped: in blocks of at least 3 lines, at least 60% of the lines
 * before the last reach 75% of the usual width (95th percentile, at least 40 columns) without ending
 * a sentence; needs 20 such lines.
 */
export function detectTxtSplit(S: string, lines: SourceLines): 'line' | 'unwrap' {
  const widths: number[] = [];
  const wrapped: Array<{ width: number; terminal: boolean }> = [];
  let block: Array<{ width: number; terminal: boolean }> = [];
  const closeBlock = () => {
    // A loop, not a spread: a novel without blank lines is one block of every line.
    if (block.length >= 3) for (let k = 0; k < block.length - 1; k++) wrapped.push(block[k]);
    block = [];
  };
  for (let j = 0; j < lines.count; j++) {
    const start = lines.starts[j];
    let end = lines.ends[j];
    while (end > start && isSpace(S.charCodeAt(end - 1))) end--;
    if (end === start) {
      closeBlock();
      continue;
    }
    const width = widthOf(S, start, end);
    widths.push(width);
    block.push({ width, terminal: TERMINAL.has(S[end - 1]) });
  }
  closeBlock();
  if (wrapped.length < 20) return 'line';
  widths.sort((a, b) => a - b);
  const usual = widths[Math.ceil(widths.length * 0.95) - 1];
  if (usual < 40) return 'line';
  const suspects = wrapped.filter(line => line.width >= 0.75 * usual && !line.terminal).length;
  return suspects / wrapped.length >= 0.6 ? 'unwrap' : 'line';
}

const draft = (kind: 'line' | 'paragraph' | 'heading', ranges: number[], breaks = new Array<number>(ranges.length / 2 - 1).fill(0)): SegmentDraft => ({
  kind, level: kind === 'heading' ? 2 : 0, marker: '', ranges, breaks, prefix: '', hardBreak: '', chapter: kind === 'heading',
});

/**
 * Breaks of an unwrapped paragraph. CJK text is wrapped by character count, so a wrap may fall inside
 * a number or a Latin word (`iPho` / `ne`, `20` / `23年`): in a paragraph whose letters and digits are
 * mostly CJK, a break with nothing but the line break around it joins without a joiner (2). Every other
 * break is soft (0) and joins with `joinerBetween`.
 */
function unwrapBreaks(S: string, ranges: readonly number[]): number[] {
  let cjk = 0;
  let other = 0;
  for (let k = 0; k < ranges.length; k += 2) {
    for (const char of S.slice(ranges[k], ranges[k + 1])) {
      if (!WORD.test(char)) continue;
      if (isCjk(char)) cjk++;
      else other++;
    }
  }
  const glue = cjk > other;
  const breaks: number[] = [];
  for (let k = 2; k < ranges.length; k += 2) breaks.push(glue && BARE_BREAK.test(S.slice(ranges[k - 1], ranges[k])) ? 2 : 0);
  return breaks;
}

const rule =(start: number, end: number): SegmentDraft => ({
  kind: 'verbatim', verbatimKind: 'rule', level: 0, marker: '', ranges: [start, end], breaks: [], prefix: '', hardBreak: '', chapter: false,
});

/**
 * Yields the drafts of a TXT document in order, and null after each source line. Lines without a
 * letter are verbatim separators; a single-line segment matching a chapter pattern is a heading.
 */
export function* scanTxt(S: string, lines: SourceLines, mode: 'line' | 'unwrap'): Generator<SegmentDraft | null> {
  let paragraph: number[] = [];
  const closeParagraph = (): SegmentDraft | null => {
    if (!paragraph.length) return null;
    const ranges = paragraph;
    paragraph = [];
    if (ranges.length === 2) return draft(isChapterTitle(S.slice(ranges[0], ranges[1])) ? 'heading' : 'paragraph', ranges);
    return draft('paragraph', ranges, unwrapBreaks(S, ranges));
  };
  for (let j = 0; j < lines.count; j++) {
    const [start, end] = contentOf(S, lines, j);
    const text = S.slice(start, end);
    if (!text || !LETTER.test(text)) {
      const closed = closeParagraph();
      if (closed) yield closed;
      if (text) yield rule(start, end);
    } else if (mode === 'line') {
      yield draft(isChapterTitle(text) ? 'heading' : 'line', [start, end]);
    } else {
      const lineStart = lines.starts[j];
      // U+3000, a tab, or two spaces or tabs: one leading space is too common to mean an indent.
      const indented = /^(?:　|\t| [ \t])/.test(S.slice(lineStart, lineStart + 2));
      if (indented) {
        const closed = closeParagraph();
        if (closed) yield closed;
      }
      paragraph.push(start, end);
    }
    yield null;
  }
  const closed = closeParagraph();
  if (closed) yield closed;
}
