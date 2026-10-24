import { describe, expect, it } from 'vitest';
import { LONG_TEXT_LIMITS } from '../../src/long-text/contract';
import { displaySource, loadSegmentTable, SegmentationError, buildSegmentTable } from '../../src/long-text/segments';
import { isChapterTitle } from '../../src/long-text/segment-txt';
import { estimateTokens } from '../../src/long-text/text-stats';
import { displays, expectInvariants, fixture, segment, uncoveredLetters } from './segment-test-utils';

const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const nonBlankLines = (S: string) => lf(S).split('\n').filter(line => line.trim());
const withLetters = (lines: string[]) => lines.filter(line => /\p{L}/u.test(line));

describe('TXT structure', () => {
  it('keeps every line of an indented Chinese novel as its own segment, indentation outside the range', async () => {
    const S = fixture('novel-indented.txt');
    const { records, structure, detectedStyle } = await segment('txt', S);
    expectInvariants(S, records);
    expect(uncoveredLetters(S, records)).toEqual([]);
    expect(structure).toEqual({ txtSplit: 'auto', resolved: 'line' });
    expect(displays(S, records)).toEqual(withLetters(nonBlankLines(S)).map(line => line.trim()));
    for (const record of records.filter(record => record.k === 'line')) {
      expect(record.r).toHaveLength(2);
      const lineStart = Math.max(S.lastIndexOf('\n', record.r[0] - 1), S.lastIndexOf('\r', record.r[0] - 1)) + 1;
      expect(S.slice(lineStart, record.r[0])).toBe('　　');
    }
    expect(detectedStyle).toBe('literary');
  });

  it('recognizes chapter headings and keeps separator lines verbatim', async () => {
    const S = fixture('novel-indented.txt');
    const { records } = await segment('txt', S);
    const headings = records.filter(record => record.k === 'heading');
    expect(headings.map(record => displaySource(S, record))).toEqual(['序章', '第一章　初雪', '第二章　旧信', '第十二章　夜', '尾声']);
    for (const heading of headings) expect(heading).toMatchObject({ l: 2, ch: 1, t: 1 });
    const rules = records.filter(record => record.k === 'verbatim');
    expect(rules.map(record => displaySource(S, record))).toEqual(['***', '◇◇◇', '――――', '12']);
    for (const rule of rules) expect(rule).toMatchObject({ vk: 'rule', t: 0, o: 0 });
  });

  it('unwraps hard-wrapped prose into one segment per paragraph', async () => {
    const S = fixture('gutenberg-wrapped.txt');
    const { records, structure } = await segment('txt', S);
    expectInvariants(S, records);
    expect(uncoveredLetters(S, records)).toEqual([]);
    expect(structure).toEqual({ txtSplit: 'auto', resolved: 'unwrap' });
    const paragraphs = lf(S).trim().split(/\n\n/);
    expect(records).toHaveLength(paragraphs.length);
    expect(displays(S, records)).toEqual(paragraphs.map(paragraph => paragraph.replace(/\n/g, ' ')));
    for (const record of records) expect(record.b.every(soft => soft === 0)).toBe(true);
    expect(records.filter(record => record.ch).map(record => displaySource(S, record))).toEqual(['CHAPTER I.', 'CHAPTER II.']);
    expect(records[2]).toMatchObject({ k: 'paragraph', l: 0, cp: '', hb: '' });
    expect(records[2].r.length).toBe(12);
  });

  it('does not join the lines of a poem in stanzas', async () => {
    const S = fixture('poem.txt');
    const { records, structure } = await segment('txt', S);
    expectInvariants(S, records);
    expect(structure?.resolved).toBe('line');
    expect(displays(S, records)).toEqual(nonBlankLines(S));
    expect(records.every(record => record.k === 'line')).toBe(true);
  });

  it('lets a manual choice override the detection', async () => {
    const prose = fixture('gutenberg-wrapped.txt');
    const asLines = await segment('txt', prose, { txtSplit: 'line' });
    expectInvariants(prose, asLines.records);
    expect(asLines.structure).toEqual({ txtSplit: 'line', resolved: 'line' });
    expect(displays(prose, asLines.records)).toEqual(nonBlankLines(prose));

    const poem = fixture('poem.txt');
    const unwrapped = await segment('txt', poem, { txtSplit: 'unwrap' });
    expectInvariants(poem, unwrapped.records);
    expect(unwrapped.structure).toEqual({ txtSplit: 'unwrap', resolved: 'unwrap' });
    expect(unwrapped.records).toHaveLength(5);
  });

  it('starts a new paragraph at an indented line when unwrapping', async () => {
    const S = '　　第一段第一行，\n接着写完。\n　　第二段。\n  Third paragraph starts\nhere and ends.\n\nLast one.';
    const { records } = await segment('txt', S, { txtSplit: 'unwrap' });
    expectInvariants(S, records);
    expect(displays(S, records)).toEqual(['第一段第一行，接着写完。', '第二段。', 'Third paragraph starts here and ends.', 'Last one.']);
    expect(records[0].r).toEqual([2, 9, 10, 15]);
  });

  it('starts a new paragraph at a single-tab indent when unwrapping, but not at a single space', async () => {
    const S = '\tFirst paragraph wraps\nmore text.\n\tSecond paragraph.';
    const { records } = await segment('txt', S, { txtSplit: 'unwrap' });
    expectInvariants(S, records);
    expect(displays(S, records)).toEqual(['First paragraph wraps more text.', 'Second paragraph.']);
    const spaced = 'First paragraph wraps\n more text.';
    expect(displays(spaced, (await segment('txt', spaced, { txtSplit: 'unwrap' })).records)).toEqual(['First paragraph wraps more text.']);
  });

  it('glues CJK text wrapped by count inside numbers and Latin words without a joiner', async () => {
    const original = '据报道，2023年10月，苹果公司在美国加州召开发布会，正式发布了iPhone 15，起售价为12999元，引起了广泛的关注和讨论。';
    const S = '　　据报道，20\n23年10月，苹果公司在美国加州召开发布会，正式发布了iPho\nne 1\n5，起售价为12999元，引起了广泛的关注和讨论。';
    const { records } = await segment('txt', S, { txtSplit: 'unwrap' });
    expectInvariants(S, records);
    expect(displays(S, records)).toEqual([original]);
    expect(records[0].b).toEqual([2, 2, 2]);
  });

  it('keeps the one space CJK text has at a wrap point', async () => {
    const S = [
      '　　苹果公司在美国加州召开发布会，正式发布了 ',
      'iPhone 15 手机，引起了广泛的关注和讨论。',
      '　　苹果公司在美国加州召开发布会，正式发布了iPhone',
      ' 15 手机，引起了广泛的关注和讨论。',
    ].join('\n');
    const { records } = await segment('txt', S, { txtSplit: 'unwrap' });
    expectInvariants(S, records);
    expect(displays(S, records)).toEqual([
      '苹果公司在美国加州召开发布会，正式发布了 iPhone 15 手机，引起了广泛的关注和讨论。',
      '苹果公司在美国加州召开发布会，正式发布了iPhone 15 手机，引起了广泛的关注和讨论。',
    ]);
    expect(records.map(record => record.b)).toEqual([[0], [0]]);
  });

  it('restores numbers and words of a CJK novel hard-wrapped every 35 characters', async () => {
    // Paragraphs of different lengths, so that the wraps fall at different places, many inside a number or a word.
    const paragraphs = Array.from({ length: 40 }, (_, k) =>
      `这是${'第'.repeat(k % 9)}${k + 1}个段落。2023年10月，苹果公司正式发布了iPhone 15系列手机，标准版起售价为5999元，顶配版售价高达12999元，引起了广泛的关注和热烈的讨论。`);
    const splitsToken = (line: string, next: string) => /[A-Za-z0-9]$/.test(line) && /^[A-Za-z0-9]/.test(next);
    const lines = paragraphs.flatMap(paragraph => {
      const indented = `　　${paragraph}`;
      return Array.from({ length: Math.ceil(indented.length / 35) }, (_, k) => indented.slice(35 * k, 35 * (k + 1)));
    });
    expect(lines.filter((line, k) => splitsToken(line, lines[k + 1] ?? '')).length).toBeGreaterThan(20);
    const S = lines.join('\n');
    const { records, structure } = await segment('txt', S);
    expectInvariants(S, records);
    expect(structure).toEqual({ txtSplit: 'auto', resolved: 'unwrap' });
    expect(displays(S, records)).toEqual(paragraphs);
  });
});

describe('chapter titles', () => {
  it.each([
    '第十二章　夜', '第3章', '第１２回 风雨', '第一卷：开端', '第五話', '序章', '楔子', '后记', 'あとがき',
    'Chapter IV', 'CHAPTER 12: The Storm', 'Part Two', 'Book III', 'Prologue', 'Epilogue', 'Chapter One', 'CHAPTER I.',
    'Chapter Forty-Two', 'PART ONE', 'Chapter 3 — The Road', 'Prologue: 1888', 'CHAPTER XII. THE STORM',
  ])('accepts %s', title => expect(isChapterTitle(title)).toBe(true));
  it.each([
    '第三章是最难的一章', '这是第十二章', 'Chapters of my life', '序章的故事很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长',
    'Part of me wanted to stay.', 'Book reviews will follow next week.', 'Chapter and verse were quoted.',
    'Prologue to a disaster was this.', 'Epilogue writing is hard.',
  ])('rejects %s', text => expect(isChapterTitle(text)).toBe(false));

  it('does not make prose lines starting with Part or Book into headings', async () => {
    const S = 'Part of me wanted to stay.\nBook reviews will follow next week.\nChapter Two\nThe end.';
    const { records } = await segment('txt', S, { txtSplit: 'line' });
    expect(records.map(record => record.k)).toEqual(['line', 'line', 'heading', 'line']);
  });
});

describe('separators', () => {
  it('keeps lines without letters verbatim in both modes', async () => {
    const S = 'First line.\n***\n◇◇◇\n――――\n42\nLast line.';
    for (const txtSplit of ['line', 'unwrap'] as const) {
      const { records } = await segment('txt', S, { txtSplit });
      expectInvariants(S, records);
      expect(records.map(record => record.k)).toEqual([txtSplit === 'line' ? 'line' : 'paragraph', 'verbatim', 'verbatim', 'verbatim', 'verbatim', txtSplit === 'line' ? 'line' : 'paragraph']);
    }
  });
});

describe('over-long segments', () => {
  const sentences = (count: number) => Array.from({ length: count }, (_, k) => `这是第${k + 1}句话，用来测试超长段落的拆分是否正确。`).join('');

  it('splits at sentence ends into chunks of at most 900 tokens sharing a group', async () => {
    const S = `前言\n　　${sentences(120)}\n后记`;
    const { records } = await segment('txt', S);
    expectInvariants(S, records);
    const parts = records.filter(record => record.g === 1);
    expect(parts.length).toBeGreaterThan(1);
    expect(estimateTokens(sentences(120))).toBeGreaterThan(LONG_TEXT_LIMITS.splitTokens);
    for (const part of parts) {
      expect(part.n).toBeLessThanOrEqual(LONG_TEXT_LIMITS.chunkTokens);
      expect(displaySource(S, part)).toMatch(/。$/);
    }
    expect(parts.map(part => displaySource(S, part)).join('')).toBe(sentences(120));
    expect(parts.map(part => part.o)).toEqual(parts.map((_, k) => 2 + k));
    expect(records.at(-1)).toMatchObject({ g: records.length - 1, k: 'heading' });
  });

  it('falls back to whitespace and then to a hard cut that keeps surrogate pairs whole', async () => {
    const words = Array.from({ length: 900 }, (_, k) => `word${k}`).join(' ');
    const spaced = await segment('txt', words);
    expectInvariants(words, spaced.records);
    expect(spaced.records.length).toBeGreaterThan(1);
    for (const part of spaced.records) {
      expect(part.n).toBeLessThanOrEqual(LONG_TEXT_LIMITS.chunkTokens);
      expect(words[part.r[0] - 1] ?? ' ').toBe(' ');
    }

    const astral = '𠀀'.repeat(2000);
    const hard = await segment('txt', astral);
    expectInvariants(astral, hard.records);
    expect(hard.records.length).toBeGreaterThan(1);
    for (const part of hard.records) {
      expect(part.n).toBeLessThanOrEqual(LONG_TEXT_LIMITS.chunkTokens);
      expect(part.r[0] % 2).toBe(0);
      expect(part.r[1] % 2).toBe(0);
    }
    expect(hard.records.map(part => displaySource(astral, part)).join('')).toBe(astral);
  });

  it('moves a hard cut out of a URL', async () => {
    const url = `https://example.com/${'path/'.repeat(60)}end`;
    const S = '字'.repeat(800) + url + '字'.repeat(800);
    const { records } = await segment('txt', S);
    expectInvariants(S, records);
    expect(records.map(part => displaySource(S, part)).join('')).toBe(S);
    expect(records[1].r[0]).toBe(800);
    expect(displaySource(S, records[1]).startsWith(url)).toBe(true);
  });
});

describe('line endings', () => {
  it('maps offsets through mixed CRLF, CR and LF', async () => {
    const lines = nonBlankLines(fixture('novel-indented.txt'));
    const endings = ['\r\n', '\r', '\n'];
    const S = lines.map((line, k) => line + endings[k % 3]).join('');
    const { records } = await segment('txt', S);
    expectInvariants(S, records);
    expect(displays(S, records)).toEqual(withLetters(lines).map(line => line.trim()));

    const unwrapped = await segment('txt', 'One\r\ntwo\rthree\n\r\nfour', { txtSplit: 'unwrap' });
    expect(displays('One\r\ntwo\rthree\n\r\nfour', unwrapped.records)).toEqual(['One two three', 'four']);
  });
});

describe('limits and scheduling', () => {
  it('refuses more than 200,000 segments, detecting the structure of one huge block on the way', async () => {
    await expect(segment('txt', 'a\n'.repeat(LONG_TEXT_LIMITS.segments + 1)))
      .rejects.toMatchObject({ code: 'too_many_segments' });
    const { records, table } = await segment('txt', 'a\n'.repeat(LONG_TEXT_LIMITS.segments));
    expect(records).toHaveLength(LONG_TEXT_LIMITS.segments);
    expect(table.count).toBe(LONG_TEXT_LIMITS.segments);
  });

  it('gives the event loop a turn while scanning a long document', async () => {
    let turns = 0;
    const tick = () => { turns++; if (turns < 1_000) setImmediate(tick); };
    setImmediate(tick);
    await segment('txt', 'line\n'.repeat(10_000));
    expect(turns).toBeGreaterThanOrEqual(5);
  });
});

describe('loadSegmentTable', () => {
  const linesOf = async function* (lines: string[]) { yield* lines; };

  it('loads segments.jsonl into the same table', async () => {
    const S = fixture('novel-indented.txt');
    const { records, table } = await segment('txt', S);
    const loaded = await loadSegmentTable(linesOf([...records.map(record => JSON.stringify(record)), '']), S.length);
    expect(loaded).toEqual(table);
    expect(buildSegmentTable(records)).toEqual(table);
  });

  it('rejects malformed records and ranges that go backwards or past S', async () => {
    const S = 'one\ntwo';
    const { records } = await segment('txt', S);
    const json = records.map(record => JSON.stringify(record));
    const reject = (lines: string[], length = S.length) =>
      expect(loadSegmentTable(linesOf(lines), length)).rejects.toBeInstanceOf(SegmentationError);
    await reject(['{']);
    await reject([json[1], json[0]]);
    await reject([json[0], JSON.stringify({ ...records[1], r: [0, 2] })]);
    await reject([JSON.stringify({ ...records[0], k: 'verbatim' })]);
    await reject([JSON.stringify({ ...records[0], b: [0] })]);
    await reject(json, 5);
    await expect(loadSegmentTable(linesOf(json), S.length)).resolves.toMatchObject({ count: 2 });
  });

  it('loads glued breaks and rejects unknown break values', async () => {
    const S = '　　发布了iPho\nne手机，引起了广泛的关注。';
    const { records, table } = await segment('txt', S, { txtSplit: 'unwrap' });
    expect(records[0].b).toEqual([2]);
    const json = JSON.stringify(records[0]);
    await expect(loadSegmentTable(linesOf([json]), S.length)).resolves.toEqual(table);
    await expect(loadSegmentTable(linesOf([JSON.stringify({ ...records[0], b: [3] })]), S.length)).rejects.toBeInstanceOf(SegmentationError);
  });
});
