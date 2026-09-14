import { describe, expect, it, vi } from 'vitest';
import {
  MATCH_POLICY_VERSION,
  matchLiteral,
  normalizeForMatching,
  type LiteralMatchOptions,
} from '../../src/translation-knowledge/matching';

const phrase: LiteralMatchOptions = { mode: 'literal_phrase', caseSensitive: true };
const caseless: LiteralMatchOptions = { mode: 'literal_phrase', caseSensitive: false };
const whole: LiteralMatchOptions = { mode: 'whole_term', caseSensitive: false };

describe('pinned Unicode literal matching', () => {
  it('exposes a version for persisted compilation policy', () => {
    expect(MATCH_POLICY_VERSION).toBe('fk-tk-match/1-unicode-16.0.0');
  });

  it('returns NFC UTF-16 offsets and text, including a preceding supplementary character', () => {
    expect(matchLiteral('😀 Cafe\u0301!', 'Café', phrase)).toEqual([
      { start: 3, end: 7, text: 'Café' },
    ]);
    expect(matchLiteral('Café', 'Cafe\u0301', phrase)).toEqual([
      { start: 0, end: 4, text: 'Café' },
    ]);
  });

  it('freezes NFC by never normalizing code points unassigned in Unicode 16.0', () => {
    const nativeNormalize = String.prototype.normalize;
    const normalize = vi.spyOn(String.prototype, 'normalize').mockImplementation(function (this: string, form?: string) {
      // Simulate a future runtime assigning normalization behavior to this point.
      // The pinned normalizer must never expose it to that implementation.
      if (String(this).includes('\u0378')) throw new Error('Future normalization behavior');
      return nativeNormalize.call(this, form);
    });
    try {
      expect(normalizeForMatching('A\u0378\u030A e\u0301')).toBe('A\u0378\u030A é');
      expect(normalizeForMatching('\u0378')).toBe('\u0378');
      expect(normalizeForMatching('')).toBe('');
      expect(matchLiteral('A\u0378\u030A', 'Å', caseless)).toEqual([]);
    } finally {
      normalize.mockRestore();
    }
  });

  it('retains Hangul composition and canonical ordering within assigned ranges', () => {
    expect(normalizeForMatching('\u1100\u1161\u11A8')).toBe('각');
    expect(normalizeForMatching('a\u0315\u0300')).toBe('à\u0315');
    expect(normalizeForMatching('😀A\u030A')).toBe('😀Å');
  });

  it('keeps whitespace and punctuation significant and does not apply NFKC', () => {
    expect(matchLiteral('星 舟，港口', '星舟', phrase)).toEqual([]);
    expect(matchLiteral('星舟，港口', '星舟港口', phrase)).toEqual([]);
    expect(matchLiteral('cat  dog', 'cat dog', phrase)).toEqual([]);
    expect(matchLiteral('ＫＡＴＡ', 'kata', caseless)).toEqual([]);
    expect(matchLiteral('①', '1', caseless)).toEqual([]);
  });

  it('keeps case sensitivity explicit', () => {
    expect(matchLiteral('Cat cat CAT', 'cat', phrase)).toEqual([
      { start: 4, end: 7, text: 'cat' },
    ]);
    expect(matchLiteral('Cat cat CAT', 'cat', caseless).map(match => match.start))
      .toEqual([0, 4, 8]);
  });

  it('uses full default folding for both sharp-s forms', () => {
    expect(matchLiteral('Straße STRAẞE', 'STRASSE', caseless)).toEqual([
      { start: 0, end: 6, text: 'Straße' },
      { start: 7, end: 13, text: 'STRAẞE' },
    ]);
    expect(matchLiteral('ss SS', 'ß', whole).map(match => match.text)).toEqual(['ss', 'SS']);
  });

  it('does not match only part of a full case-fold expansion', () => {
    expect(matchLiteral('ß ẞ', 's', caseless)).toEqual([]);
    expect(matchLiteral('ﬃ', 'fi', caseless)).toEqual([]);
    expect(matchLiteral('ﬃ', 'ffi', caseless)).toEqual([{ start: 0, end: 1, text: 'ﬃ' }]);
    expect(matchLiteral('sß', 'ss', caseless)).toEqual([{ start: 1, end: 2, text: 'ß' }]);
    expect(matchLiteral('ßs', 'ss', caseless)).toEqual([{ start: 0, end: 1, text: 'ß' }]);
  });

  it('folds uppercase and final Greek sigma to the same form', () => {
    expect(matchLiteral('ΟΣ ος οσ', 'οσ', whole).map(match => match.text))
      .toEqual(['ΟΣ', 'ος', 'οσ']);
  });

  it('uses default rather than Turkic or locale-sensitive folding', () => {
    expect(matchLiteral('I İ ı i', 'i', whole).map(match => match.text)).toEqual(['I', 'i']);
    expect(matchLiteral('İ i\u0307', 'i\u0307', caseless)).toEqual([
      { start: 0, end: 1, text: 'İ' },
      { start: 2, end: 4, text: 'i\u0307' },
    ]);
    expect(matchLiteral('İ', 'i', caseless)).toEqual([]);
  });

  it('matches canonically equivalent combining accents before folding', () => {
    expect(matchLiteral('A\u030A e\u0301', 'å', caseless)).toEqual([
      { start: 0, end: 1, text: 'Å' },
    ]);
    expect(matchLiteral('ΐ', '\u03B9\u0308\u0301', caseless)).toEqual([
      { start: 0, end: 1, text: 'ΐ' },
    ]);
  });

  it('does not let a query consume half of a source surrogate pair', () => {
    expect(matchLiteral('😀', '\uD83D', phrase)).toEqual([]);
    expect(matchLiteral('😀', '\uDE00', caseless)).toEqual([]);
    expect(matchLiteral('😀😀', '😀', phrase)).toEqual([
      { start: 0, end: 2, text: '😀' },
      { start: 2, end: 4, text: '😀' },
    ]);
  });

  it('folds supplementary letters and preserves their UTF-16 offsets', () => {
    expect(matchLiteral('𐐀 𐐨', '𐐨', whole)).toEqual([
      { start: 0, end: 2, text: '𐐀' },
      { start: 3, end: 5, text: '𐐨' },
    ]);
  });

  it('uses Unicode 16 folds added after earlier runtime Unicode releases', () => {
    expect(matchLiteral('\u1C89', '\u1C8A', caseless)).toEqual([
      { start: 0, end: 1, text: '\u1C89' },
    ]);
  });

  it('keeps all overlapping literal matches available to conflict detection', () => {
    expect(matchLiteral('ababa', 'aba', phrase)).toEqual([
      { start: 0, end: 3, text: 'aba' },
      { start: 2, end: 5, text: 'aba' },
    ]);
    expect(matchLiteral('ßßß', 'ssss', caseless)).toEqual([
      { start: 0, end: 2, text: 'ßß' },
      { start: 1, end: 3, text: 'ßß' },
    ]);
  });

  it('finds literal phrases in continuous Japanese and Chinese text without inventing boundaries', () => {
    expect(matchLiteral('猫は猫です', '猫', phrase).map(match => match.start)).toEqual([0, 2]);
    expect(matchLiteral('星舟港与星舟', '星舟', phrase).map(match => match.start)).toEqual([0, 4]);
    expect(matchLiteral('猫は猫です', '猫', whole)).toEqual([]);
    expect(matchLiteral('猫、猫。', '猫', whole).map(match => match.start)).toEqual([0, 2]);
  });

  it('whole terms require boundaries on both sides and accept punctuation or emoji', () => {
    expect(matchLiteral('cat-cat cat.cat 😀cat😀 (CAT) scatter cats', 'cat', whole)
      .map(match => match.text)).toEqual(['cat', 'cat', 'cat', 'cat', 'cat', 'CAT']);
  });

  it.each([
    ['Latin letter', 'x'],
    ['CJK letter', '猫'],
    ['supplementary letter', '𐐀'],
    ['nonspacing mark', '\u035C'],
    ['spacing mark', '\u0903'],
    ['enclosing mark', '\u20DD'],
    ['decimal number', '2'],
    ['letter number', 'Ⅰ'],
    ['other number', '½'],
    ['ASCII connector punctuation', '_'],
    ['fullwidth connector punctuation', '＿'],
    ['Unicode 16 letter', '\u1C89'],
    ['Unicode 15 mark', '\u{11F00}'],
    ['interior of a UnicodeData First/Last range', '\u{30001}'],
  ])('treats %s as a word-boundary blocker', (_label, adjacent) => {
    expect(matchLiteral(`${adjacent}cat`, 'cat', whole)).toEqual([]);
    expect(matchLiteral(`cat${adjacent}`, 'cat', whole)).toEqual([]);
  });

  it('keeps unassigned code points outside the pinned word categories', () => {
    expect(matchLiteral('\u0378cat\u0378', 'cat', whole)).toEqual([
      { start: 1, end: 4, text: 'cat' },
    ]);
  });

  it('checks word boundaries on the original source, including fold expansions', () => {
    expect(matchLiteral('xß ßx ß', 'ss', whole)).toEqual([
      { start: 6, end: 7, text: 'ß' },
    ]);
  });

  it('returns no empty-string matches', () => {
    expect(matchLiteral('abc', '', phrase)).toEqual([]);
    expect(matchLiteral('', 'abc', whole)).toEqual([]);
  });
});
