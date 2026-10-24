import { readFileSync } from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import type { SupportedEncoding } from '../../src/long-text/contract';
import { decodeBytes, detectEncoding, detectLineEnding, previewLines } from '../../electron/main/long-text/encoding';
import { COMMON_SIMPLIFIED, COMMON_TRADITIONAL } from '../../electron/main/long-text/encoding-tables';

// Samples are UTF-8 text; every test encodes them on the spot, so no binary fixture is checked in.
const sample = (name: 'zh-hans' | 'zh-hant' | 'ja' | 'ko' | 'fr') =>
  readFileSync(path.join(__dirname, 'fixtures', 'encoding', `${name}.txt`), 'utf8');

const BOMS = {
  'utf-8': [0xef, 0xbb, 0xbf],
  'utf-16le': [0xff, 0xfe],
  'utf-16be': [0xfe, 0xff],
} as const;

const withBom = (encoding: keyof typeof BOMS, text: string) =>
  Buffer.concat([Buffer.from(BOMS[encoding]), iconv.encode(text, encoding, { addBOM: false })]);

function detected(bytes: Uint8Array) {
  const result = detectEncoding(bytes);
  if ('error' in result) throw new Error(`unexpected ${result.error}`);
  return result;
}

describe('detectEncoding', () => {
  it.each(Object.keys(BOMS) as Array<keyof typeof BOMS>)('reads the %s byte order mark', encoding => {
    const result = detected(withBom(encoding, sample('zh-hans')));
    expect(result).toEqual({ encoding, confidence: 'high', bom: true, scores: [[encoding, 1]] });
  });

  it('rejects UTF-32 byte order marks as binary', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), iconv.encode('Hello', 'utf-32le', { addBOM: false })]);
    const be = Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), iconv.encode('Hello', 'utf-32be', { addBOM: false })]);
    expect(detectEncoding(le)).toEqual({ error: 'binary_file' });
    expect(detectEncoding(be)).toEqual({ error: 'binary_file' });
  });

  it.each(['utf-16le', 'utf-16be'] as const)('recognizes %s without a byte order mark', encoding => {
    const result = detected(iconv.encode(sample('fr'), encoding, { addBOM: false }));
    expect(result).toMatchObject({ encoding, confidence: 'high', bom: false });
  });

  it('accepts strict UTF-8, including plain ASCII', () => {
    expect(detected(Buffer.from(sample('ja'), 'utf8'))).toMatchObject({ encoding: 'utf-8', confidence: 'high', bom: false });
    expect(detected(Buffer.from('Plain ASCII text.\nSecond line.\n'))).toMatchObject({ encoding: 'utf-8', confidence: 'high' });
  });

  it.each([
    ['zh-hans', 'gb18030'],
    ['zh-hant', 'big5'],
    ['ja', 'shift_jis'],
    ['ja', 'euc-jp'],
    ['ko', 'euc-kr'],
    ['fr', 'windows-1252'],
  ] as const)('recognizes %s text saved as %s with high confidence', (name, encoding) => {
    const text = sample(name);
    const bytes = iconv.encode(text, encoding);
    expect(bytes.length).toBeGreaterThanOrEqual(2048);
    expect(detected(bytes)).toMatchObject({ encoding, confidence: 'high', bom: false });
    expect(decodeBytes(bytes, encoding)).toBe(text);
  });

  it('does not read Big5 as GB18030', () => {
    const { encoding, scores } = detected(iconv.encode(sample('zh-hant'), 'big5'));
    expect(encoding).toBe('big5');
    const score = (name: SupportedEncoding) => scores.find(([candidate]) => candidate === name)?.[1] ?? -Infinity;
    expect(score('big5') - score('gb18030')).toBeGreaterThanOrEqual(0.1);
  });

  it.each([
    ['zh-hans', 'gb18030', ['┌──┬──┐', '│名称│数值│', '├──┼──┤', '│长度│十二│', '└──┴──┘']],
    ['zh-hant', 'big5', ['┌──┬──┐', '│名稱│數值│', '├──┼──┤', '│長度│十二│', '└──┴──┘']],
  ] as const)('reads %s text with box-drawn tables as %s (box drawing is neutral, not bad)', (name, encoding, table) => {
    const separator = '─'.repeat(30);
    // Tables and separators between short passages of prose.
    const text = `${table.join('\n')}\n${separator}\n${sample(name).slice(0, 40)}\n`.repeat(12);
    const bytes = iconv.encode(text, encoding);
    expect(iconv.decode(bytes, encoding)).toBe(text);
    expect(detected(bytes)).toMatchObject({ encoding });
  });

  it('rates dialogue-heavy GBK prose high', () => {
    const prose = [
      '“你明天还来吗？”她站在门口问。',
      '我想了想，说：“要是不下雨，我就早点过来，帮你把院子里的柴火搬进屋。”',
      '她笑了笑，没有再说什么，转身回到厨房里去了。灶台上的水已经开了，锅盖被蒸汽顶得轻轻作响。',
      '外面的风越来越大，树枝不停地敲打着窗户。我坐在桌边，看着那盏昏黄的油灯，心里却一直想着白天在河边遇到的那个陌生人。',
      '他穿着一件旧军装，背着一个很大的包，说是要去北方找他的哥哥。临走的时候，他把一封信交给我，请我替他寄出去。',
    ].join('\n');
    const bytes = iconv.encode(`${prose}\n\n`.repeat(5), 'gb18030');
    expect(bytes.length).toBeGreaterThanOrEqual(2048);
    expect(detected(bytes)).toMatchObject({ encoding: 'gb18030', confidence: 'high' });
  });

  it('does not read a Shift_JIS paragraph as cp949 Hangul', () => {
    // Shift_JIS kana pairs are valid cp949 extension syllables; only KS X 1001 syllables count for EUC-KR.
    const text = sample('ja').slice(0, 60);
    expect(detected(iconv.encode(text, 'shift_jis'))).toMatchObject({ encoding: 'shift_jis', confidence: 'high' });
  });

  it.each([
    ['中文', 'gb18030'],
    ['中文測試', 'big5'],
    ['日本', 'shift_jis'],
    ['Déjà vu.', 'windows-1252'],
  ] as const)('rates the short sample %s (%s) low', (text, encoding) => {
    expect(detected(iconv.encode(text, encoding)).confidence).toBe('low');
  });

  it('falls back to the best reading, with low confidence, when no candidate decodes cleanly', () => {
    // 0x81 followed by a space is invalid in every candidate encoding.
    const bytes = Buffer.concat([iconv.encode(sample('zh-hans'), 'gb18030'), Buffer.from([0x81, 0x20])]);
    expect(detected(bytes)).toMatchObject({ encoding: 'gb18030', confidence: 'low' });
  });

  it('treats NUL bytes in a non-UTF-8 file as binary', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    expect(detectEncoding(png)).toEqual({ error: 'binary_file' });
    const text = iconv.encode(sample('zh-hans'), 'gb18030');
    expect(detectEncoding(Buffer.concat([text.subarray(0, 100), Buffer.from([0]), text.subarray(100)]))).toEqual({ error: 'binary_file' });
  });

  it('treats more than 1% control characters as binary', () => {
    const noisy = 'Name\u0001Value\u0002'.repeat(200);
    expect(detectEncoding(Buffer.from(noisy, 'utf8'))).toEqual({ error: 'binary_file' });
    expect(detectEncoding(iconv.encode(`${sample('zh-hans')}${noisy}`, 'gb18030'))).toEqual({ error: 'binary_file' });
    const rare = `${sample('fr')}\u0007`;
    expect(detected(Buffer.from(rare, 'utf8'))).toMatchObject({ encoding: 'utf-8', confidence: 'high' });
  });

  it('does not cut a four-byte GB18030 character at the edge of the sample', () => {
    // '㐀' is 81 39 EE 39: the sample may not end after its digit bytes.
    const head = Buffer.concat([Buffer.alloc(64 * 1024 - 1, 'a'), iconv.encode('㐀', 'gb18030')]);
    expect(head.subarray(-4)).toEqual(Buffer.from([0x81, 0x39, 0xee, 0x39]));
    const body = iconv.encode(sample('zh-hans').repeat(80), 'gb18030');
    const result = detected(Buffer.concat([head, body]));
    expect(result).toMatchObject({ encoding: 'gb18030', confidence: 'high' });
  });

  it('reads the whole file when both sampled parts are ASCII', () => {
    const bytes = Buffer.concat([Buffer.alloc(300 * 1024, 'a'), iconv.encode(sample('zh-hant'), 'big5')]);
    expect(detected(bytes)).toMatchObject({ encoding: 'big5', confidence: 'high' });
  });
});

describe('decodeBytes', () => {
  it.each(Object.keys(BOMS) as Array<keyof typeof BOMS>)('drops the %s byte order mark', encoding => {
    expect(decodeBytes(withBom(encoding, 'Café 中文'), encoding)).toBe('Café 中文');
  });

  it('turns undecodable bytes into U+FFFD', () => {
    expect(decodeBytes(Buffer.from([0x61, 0xff, 0x62]), 'utf-8')).toBe('a�b');
  });

  it('accepts a plain Uint8Array view', () => {
    const bytes = iconv.encode('漢字', 'big5');
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(decodeBytes(view, 'big5')).toBe('漢字');
  });
});

describe('previewLines', () => {
  it('returns the first eight non-blank lines, each cut to 200 characters', () => {
    const long = '𠀀'.repeat(250);
    const lines = ['', '  ', '　', 'one', 'two', long, 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const bytes = Buffer.from(lines.join('\r\n').replace('two\r\n', 'two\r'), 'utf8');
    expect(previewLines(bytes, 'utf-8')).toEqual({
      lines: ['one', 'two', '𠀀'.repeat(200), 'four', 'five', 'six', 'seven', 'eight'],
      replacementChars: 0,
    });
  });

  it('counts the characters a wrong encoding cannot decode', () => {
    const text = sample('zh-hant');
    const bytes = iconv.encode(text, 'big5');
    const right = previewLines(bytes, 'big5');
    expect(right.replacementChars).toBe(0);
    expect(right.lines).toEqual(text.split('\n').filter(line => line.trim()).slice(0, 8));
    expect(previewLines(bytes, 'utf-8').replacementChars).toBeGreaterThan(100);
  });
});

describe('detectLineEnding', () => {
  it('picks the most frequent line break', () => {
    expect(detectLineEnding('a\r\nb\r\nc\nd')).toBe('\r\n');
    expect(detectLineEnding('a\nb\nc\r\nd')).toBe('\n');
    expect(detectLineEnding('a\rb\rc\nd')).toBe('\r');
    expect(detectLineEnding('a\r\r\nb')).toBe('\r\n');
  });

  it('falls back to \\n without line breaks or on a tie', () => {
    expect(detectLineEnding('single line')).toBe('\n');
    expect(detectLineEnding('a\nb\r\nc')).toBe('\n');
    expect(detectLineEnding('a\nb\rc')).toBe('\n');
  });
});

describe('encoding tables', () => {
  it('hold 500 distinct characters that their encodings store in two bytes', () => {
    for (const [table, encoding] of [[COMMON_SIMPLIFIED, 'gb18030'], [COMMON_TRADITIONAL, 'big5']] as const) {
      expect(table.size).toBe(500);
      for (const char of table) {
        const bytes = iconv.encode(char, encoding);
        expect(bytes.length, char).toBe(2);
        expect(iconv.decode(bytes, encoding), char).toBe(char);
      }
    }
  });
});
