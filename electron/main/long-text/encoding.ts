import iconv from 'iconv-lite';
import type { LongTextValues, SupportedEncoding } from '../../../src/long-text/contract';
import type { LineEnding } from '../../../src/long-text/model';
import { COMMON_SIMPLIFIED, COMMON_TRADITIONAL, KS_HANGUL } from './encoding-tables';

/** Encoding detection and decoding of imported files with iconv-lite only (design §6.2). */

export type EncodingDetection =
  | {
      encoding: SupportedEncoding;
      confidence: 'high' | 'low';
      bom: boolean;
      /** Valid legacy candidates by score, or every candidate when none is valid; the single certain encoding otherwise. */
      scores: Array<[SupportedEncoding, number]>;
    }
  | { error: 'binary_file' };

const CANDIDATES = ['gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'windows-1252'] as const satisfies readonly SupportedEncoding[];
type Candidate = (typeof CANDIDATES)[number];

const UTF16_PROBE_BYTES = 4 * 1024;
const SAMPLE_PART_BYTES = 64 * 1024;
const HIGH_SCORE = 0.85;
const HIGH_LEAD = 0.1;
/** Fewer non-ASCII characters than this are too little evidence for high confidence. */
const MIN_EVIDENCE = 32;
const CONTROL_LIMIT = 0.01;
const BIG5_TRAIL_SHARE = 0.15;
const GB_TRAIL_SHARE = 0.05;
const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 200;
const REPLACEMENT = '�';
const BINARY = { error: 'binary_file' } as const;

export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  const bom = bomEncoding(bytes);
  if (bom === 'utf-32') return BINARY;
  if (bom) return certain(bom, decodeBytes(bytes, bom), true);
  const utf16 = utf16ByteOrder(bytes);
  if (utf16) return certain(utf16, decodeBytes(bytes, utf16), false);
  const utf8 = strictUtf8(bytes);
  if (utf8 !== null) return certain('utf-8', utf8, false);
  if (bytes.subarray(0, SAMPLE_PART_BYTES).includes(0)) return BINARY;
  return guessLegacyEncoding(bytes);
}

/** Decodes the whole file and drops a byte order mark. Undecodable bytes become U+FFFD. */
export function decodeBytes(bytes: Uint8Array, encoding: SupportedEncoding): string {
  if (encoding === 'utf-8') return new TextDecoder('utf-8').decode(bytes);
  return iconv.decode(asBuffer(bytes), encoding);
}

/** The first non-blank lines of the file read as `encoding`, and how many characters of the whole file failed to decode. */
export function previewLines(bytes: Uint8Array, encoding: SupportedEncoding): LongTextValues['previewEncoding'] {
  const text = decodeBytes(bytes, encoding);
  const lines: string[] = [];
  for (const [line] of text.matchAll(/[^\r\n]+/g)) {
    if (!line.trim()) continue;
    lines.push(truncate(line, PREVIEW_LINE_CHARS));
    if (lines.length === PREVIEW_LINES) break;
  }
  let replacementChars = 0;
  for (let at = text.indexOf(REPLACEMENT); at !== -1; at = text.indexOf(REPLACEMENT, at + 1)) replacementChars++;
  return { lines, replacementChars };
}

/** The most frequent of `\n`, `\r\n` and a lone `\r`. Ties go to `\n`, then `\r\n`; no line break at all gives `\n`. */
export function detectLineEnding(text: string): LineEnding {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) lf++;
    else if (code === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        crlf++;
        i++;
      } else cr++;
    }
  }
  if (crlf > lf && crlf >= cr) return '\r\n';
  return cr > lf ? '\r' : '\n';
}

function certain(encoding: SupportedEncoding, text: string, bom: boolean): EncodingDetection {
  if (controlShare(text) > CONTROL_LIMIT) return BINARY;
  return { encoding, confidence: 'high', bom, scores: [[encoding, 1]] };
}

function bomEncoding(bytes: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32' | null {
  const [a, b, c, d] = bytes;
  if ((a === 0xff && b === 0xfe && c === 0 && d === 0) || (a === 0 && b === 0 && c === 0xfe && d === 0xff)) return 'utf-32';
  if (a === 0xef && b === 0xbb && c === 0xbf) return 'utf-8';
  if (a === 0xff && b === 0xfe) return 'utf-16le';
  if (a === 0xfe && b === 0xff) return 'utf-16be';
  return null;
}

/** UTF-16 without a byte order mark: zero bytes fill one side of each byte pair (the high byte of ASCII). */
function utf16ByteOrder(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const pairs = Math.floor(Math.min(bytes.length, UTF16_PROBE_BYTES) / 2);
  if (!pairs) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < pairs * 2; i += 2) {
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  const even = evenZeros / pairs;
  const odd = oddZeros / pairs;
  if (odd >= 0.3 && even < 0.05) return 'utf-16le';
  if (even >= 0.3 && odd < 0.05) return 'utf-16be';
  return null;
}

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface CandidateScore {
  encoding: Candidate;
  valid: boolean;
  score: number;
  text: string;
  nonAscii: number;
}

function guessLegacyEncoding(bytes: Uint8Array): EncodingDetection {
  const sample = sampleOf(bytes);
  const trailShare = narrowTrailShare(sample);
  const results = CANDIDATES.map(encoding => scoreCandidate(sample, encoding, trailShare));
  const byScore = (a: CandidateScore, b: CandidateScore) => b.score - a.score;
  const valid = results.filter(result => result.valid).sort(byScore);
  // Without a valid reading the document still imports; the unconfirmed encoding then blocks translation.
  const ranked = valid.length ? valid : results.sort(byScore);
  const [best, second] = ranked;
  if (controlShare(best.text) > CONTROL_LIMIT) return BINARY;
  const high =
    valid.length > 0 &&
    best.nonAscii >= MIN_EVIDENCE &&
    best.score >= HIGH_SCORE &&
    best.score - (second?.score ?? -Infinity) >= HIGH_LEAD;
  return {
    encoding: best.encoding,
    confidence: high ? 'high' : 'low',
    bom: false,
    scores: ranked.map(result => [result.encoding, Math.round(result.score * 1000) / 1000]),
  };
}

/**
 * The first 64 KiB plus 64 KiB from the middle. Each part starts and ends right after an ASCII byte,
 * which ends a character in every candidate encoding, so no multibyte character is cut. Digits are
 * skipped because they can be the second byte of a four-byte GB18030 sequence.
 */
function sampleOf(bytes: Uint8Array): Buffer {
  if (bytes.length <= 2 * SAMPLE_PART_BYTES) return asBuffer(bytes);
  const headEnd = boundaryFrom(bytes, SAMPLE_PART_BYTES);
  const middleStart = boundaryFrom(bytes, Math.max(headEnd, (bytes.length - SAMPLE_PART_BYTES) >> 1));
  const middleEnd = boundaryFrom(bytes, middleStart + SAMPLE_PART_BYTES);
  const sample = Buffer.concat([bytes.subarray(0, headEnd), bytes.subarray(middleStart, middleEnd)]);
  // Non-ASCII bytes outside both parts still decide the encoding.
  return sample.some(byte => byte >= 0x80) ? sample : asBuffer(bytes);
}

/** The first offset at or after `from` that follows an ASCII byte other than a digit, or the end. */
function boundaryFrom(bytes: Uint8Array, from: number): number {
  for (let at = Math.max(from, 1); at < bytes.length; at++) {
    const previous = bytes[at - 1];
    if (previous < 0x80 && (previous < 0x30 || previous > 0x39)) return at;
  }
  return bytes.length;
}

/**
 * Share of double-byte pairs (lead 0x81–0xFE) whose trail byte is in 0x40–0x7E. About a third of Big5
 * characters have such a trail; GB2312 characters, which make up nearly all GBK text, never do.
 */
function narrowTrailShare(sample: Uint8Array): number {
  let pairs = 0;
  let narrow = 0;
  for (let i = 0; i < sample.length - 1; i++) {
    if (sample[i] < 0x81 || sample[i] > 0xfe) continue;
    pairs++;
    if (sample[i + 1] >= 0x40 && sample[i + 1] <= 0x7e) narrow++;
    i++;
  }
  return pairs ? narrow / pairs : 0;
}

function scoreCandidate(sample: Buffer, encoding: Candidate, trailShare: number): CandidateScore {
  const text = iconv.decode(sample, encoding, { stripBOM: false });
  const valid = !text.includes(REPLACEMENT) && controlShare(text) === 0 && iconv.encode(text, encoding).equals(sample);
  let nonAscii = 0;
  let weight = 0;
  let letters = 0;
  let kana = 0;
  let hangul = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x80) continue;
    nonAscii++;
    weight += charWeight(char, cp, encoding);
    if (!LETTER.test(char)) continue;
    letters++;
    if (isKana(cp)) kana++;
    else if (KS_HANGUL.has(char)) hangul++;
  }
  let score = nonAscii ? weight / nonAscii : 0;
  if (encoding === 'big5' || encoding === 'gb18030') score += trailBias(trailShare, encoding);
  if ((encoding === 'shift_jis' || encoding === 'euc-jp') && kana && kana >= 0.05 * letters) score += 0.15;
  if (encoding === 'euc-kr' && hangul && hangul >= 0.05 * letters) score += 0.15;
  return { encoding, valid, score, text, nonAscii };
}

/** Many narrow trail bytes point to Big5, almost none to GBK. */
function trailBias(share: number, encoding: 'big5' | 'gb18030'): number {
  const towardBig5 = share > BIG5_TRAIL_SHARE ? 0.1 : share < GB_TRAIL_SHARE ? -0.1 : 0;
  return encoding === 'big5' ? towardBig5 : -towardBig5;
}

const LETTER = /\p{L}/u;

const isBoxDrawing = (cp: number) => cp >= 0x2500 && cp <= 0x257f;

/** Good characters 1, neutral 0.5, bad −3, anything else 0. */
function charWeight(char: string, cp: number, encoding: Candidate): number {
  if (isPrivateUse(cp) || cp >= 0x20000) return -3;
  // Legal but rare in Shift_JIS text, and what EUC and GBK bytes turn into when read as Shift_JIS.
  if (isHalfwidthKatakana(cp)) return encoding === 'shift_jis' ? 0.5 : -3;
  if (isGood(char, cp, encoding)) return 1;
  // Box drawing is encoded by every CJK candidate (tables, tree listings, separators) and never by windows-1252.
  return isCjkIdeograph(cp) || isCjkPunctuation(cp) || isBoxDrawing(cp) ? 0.5 : 0;
}

function isGood(char: string, cp: number, encoding: Candidate): boolean {
  switch (encoding) {
    case 'gb18030': return COMMON_SIMPLIFIED.has(char);
    case 'big5': return COMMON_TRADITIONAL.has(char);
    case 'shift_jis':
    case 'euc-jp': return isKana(cp);
    case 'euc-kr': return KS_HANGUL.has(char);
    case 'windows-1252': return cp >= 0xc0 && cp <= 0xff;
  }
}

/** Full-width hiragana and katakana. */
const isKana = (cp: number) => (cp >= 0x3041 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff);
const isHalfwidthKatakana = (cp: number) => cp >= 0xff61 && cp <= 0xff9f;
const isPrivateUse = (cp: number) => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;
const isCjkIdeograph = (cp: number) => (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);

/**
 * CJK symbols and punctuation, vertical and compatibility forms, fullwidth forms, and the quotes,
 * dashes, ellipsis and middle dot that CJK encodings store as fullwidth punctuation.
 */
const isCjkPunctuation = (cp: number) =>
  (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xfe10 && cp <= 0xfe1f) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x2010 && cp <= 0x2027) || cp === 0xb7;

/** Share of C0 and C1 control characters and DEL, not counting tab, line feed, form feed and carriage return. */
function controlShare(text: string): number {
  if (!text) return 0;
  let controls = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x9f) continue;
    if (code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code >= 0x7f) controls++;
  }
  return controls / text.length;
}

/** The first `maxChars` code points of `line`. */
function truncate(line: string, maxChars: number): string {
  let end = 0;
  for (let count = 0; count < maxChars && end < line.length; count++) end += line.codePointAt(end)! > 0xffff ? 2 : 1;
  return line.slice(0, end);
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
