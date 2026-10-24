/** Character classes, letter counts and token estimates shared by segmentation, detection and checks. */

/** Writing system of a letter (`\p{L}`). */
export type Script = 'han' | 'kana' | 'hangul' | 'latin' | 'cyrillic' | 'other';
export type ScriptCounts = Record<Script, number> & { letters: number };

const LETTER = /\p{L}/u;
const HAN = /\p{Script=Han}/u;
// Script_Extensions also covers the prolonged sound mark ー, whose script is Common.
const KANA = /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** The writing system of a single character, or null when it is not a letter. */
export function scriptOf(char: string): Script | null {
  if (!LETTER.test(char)) return null;
  if (HAN.test(char)) return 'han';
  if (KANA.test(char)) return 'kana';
  if (HANGUL.test(char)) return 'hangul';
  if (LATIN.test(char)) return 'latin';
  if (CYRILLIC.test(char)) return 'cyrillic';
  return 'other';
}

export function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = { han: 0, kana: 0, hangul: 0, latin: 0, cyrillic: 0, other: 0, letters: 0 };
  for (const char of text) {
    const script = scriptOf(char);
    if (!script) continue;
    counts[script]++;
    counts.letters++;
  }
  return counts;
}

type Range = readonly [number, number];
const inRanges = (cp: number, ranges: readonly Range[]) => ranges.some(([from, to]) => cp >= from && cp <= to);

const HAN_RANGES: readonly Range[] = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x3ffff]];
const KANA_RANGES: readonly Range[] = [[0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9d], [0x1b000, 0x1b16f]];
const HANGUL_SYLLABLES: Range = [0xac00, 0xd7a3];
/** CJK symbols and punctuation, fullwidth forms and the CJK vertical and compatibility forms. */
const FULLWIDTH_RANGES: readonly Range[] = [[0x3000, 0x303f], [0xfe10, 0xfe1f], [0xfe30, 0xfe4f], [0xff00, 0xffef]];
/** Characters written without spaces around them: Han, kana, Bopomofo and fullwidth forms. Hangul is not one. */
const CJK_RANGES: readonly Range[] = [
  [0x2e80, 0x2fdf], [0x3000, 0x312f], [0x3190, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff],
  [0xfe10, 0xfe1f], [0xfe30, 0xfe4f], [0xff01, 0xff60], [0xff65, 0xff9f], [0xffe0, 0xffe6], [0x1b000, 0x1b16f], [0x20000, 0x3ffff],
];
/** Dashes, quotes, ellipses and the middle dot appear in both CJK and alphabetic text. */
const SHARED_PUNCTUATION: readonly Range[] = [[0xb7, 0xb7], [0x2010, 0x2027]];
const WHITESPACE = /\s/u;
const NON_ASCII_SPACES: readonly Range[] = [
  [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];

/** True when the first character of `char` is Han, kana, Bopomofo or a fullwidth form. */
export function isCjk(char: string): boolean {
  const cp = char.codePointAt(0);
  return cp !== undefined && inRanges(cp, CJK_RANGES);
}

/** Class of the text next to a joint: `cjk`, `other`, or null when only shared punctuation is there. */
function sideClass(chars: string[]): 'cjk' | 'other' | null {
  for (const char of chars) {
    const cp = char.codePointAt(0)!;
    if (inRanges(cp, SHARED_PUNCTUATION)) continue;
    return inRanges(cp, CJK_RANGES) ? 'cjk' : 'other';
  }
  return null;
}

/**
 * What joins two parts of a soft-wrapped line: nothing when both sides are CJK (or either side
 * already ends in whitespace), otherwise one space. Shared punctuation such as “ ” … — at the
 * joint is skipped to find the deciding character; a side with nothing else follows the other side.
 */
export function joinerBetween(before: string, after: string): '' | ' ' {
  if (!before || !after) return '';
  const left = Array.from(before.slice(-64)).reverse();
  const right = Array.from(after.slice(0, 64));
  if (WHITESPACE.test(left[0]) || WHITESPACE.test(right[0])) return '';
  const sides = [sideClass(left), sideClass(right)].filter(side => side !== null);
  return sides.every(side => side === 'cjk') ? '' : ' ';
}

/** Weight of one code point in hundredths of a token. */
function tokenWeight(cp: number): number {
  if (cp < 0x80) {
    if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 25;
    return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) ? 15 : 50;
  }
  if (inRanges(cp, HAN_RANGES) || inRanges(cp, KANA_RANGES) || (cp >= HANGUL_SYLLABLES[0] && cp <= HANGUL_SYLLABLES[1])) return 105;
  if (inRanges(cp, NON_ASCII_SPACES)) return 15;
  if (inRanges(cp, FULLWIDTH_RANGES)) return 100;
  return 50;
}

/**
 * Rough token count without a tokenizer: Han, kana and Hangul syllables 1.05, fullwidth punctuation
 * 1, ASCII letters and digits 0.25, whitespace 0.15, anything else 0.5; rounded up, plus one.
 */
export function estimateTokens(text: string): number {
  let hundredths = 0;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    hundredths += tokenWeight(cp);
  }
  return Math.ceil(hundredths / 100) + 1;
}
