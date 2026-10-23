import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEGMENT_KINDS, type LongTextFormat, type TxtSplit } from '../../src/long-text/contract';
import * as inline from '../../src/long-text/inline';
import type { LineEnding, TranslationRecord } from '../../src/long-text/model';
import { rebuild, type ExportMode } from '../../src/long-text/rebuild';
import { displayAt, segmentDocument, type SegmentedDocument } from '../../src/long-text/segments';
import { joinerBetween } from '../../src/long-text/text-stats';

/** `LONG_TEXT_UPDATE_GOLDEN=1` rewrites the `*.expected.*` files from the current output; review the diff before keeping it. */
const UPDATE_GOLDEN = process.env.LONG_TEXT_UPDATE_GOLDEN === '1';
const fixtureUrl = (name: string) => new URL(`fixtures/${name}`, import.meta.url);
/** Fixtures are compared with LF line endings, whatever a checkout did to them; CRLF variants are derived. */
const fixture = (name: string) => readFileSync(fixtureUrl(name), 'utf8').replace(/\r\n/g, '\n');

interface Doc extends SegmentedDocument { S: string; format: LongTextFormat }

async function load(format: LongTextFormat, S: string, txtSplit?: TxtSplit): Promise<Doc> {
  return { ...(await segmentDocument(format, S, { inline, txtSplit })), S, format };
}

const done = (index: number, target: string): TranslationRecord => ({
  index, rev: 1, previous: null, runId: null, at: 0, status: 'done', target, origin: 'model', locked: false, flags: [], failure: null,
});

const TOKEN = /(<\/?[xm]\d{1,3}\/?>)/;
/**
 * A stand-in model: Latin words in upper case, other words in «guillemets», markup kept as tokens and
 * restored by `decode` exactly as a real answer would be.
 */
function fakeTranslation(doc: Doc, index: number): string {
  const kind = SEGMENT_KINDS[doc.table.kind[index]];
  const { text, marks } = inline.project(displayAt(doc.S, doc.table, index), kind, doc.format, { refs: new Set(doc.refs) });
  const answer = text.split(TOKEN)
    .map((part, k) => (k % 2 ? part : part.replace(/\p{L}+/gu, word => (/\p{Script=Latin}/u.test(word) ? word.toUpperCase() : `«${word}»`))))
    .join('');
  const result = inline.decode(answer, marks, kind, { final: false, joinerTarget: 'zh-Hans', format: doc.format, source: text });
  if (!result.ok) throw new Error(`segment ${index} did not decode`);
  return result.text;
}

function translate(doc: Doc, pick: (index: number) => boolean = () => true): Array<TranslationRecord | undefined> {
  return doc.records.map(record => (record.t && pick(record.i) ? done(record.i, fakeTranslation(doc, record.i)) : undefined));
}

function assemble(doc: Doc, translations: ReadonlyArray<TranslationRecord | undefined>, mode: ExportMode, lineEnding: LineEnding = '\n'): string {
  return rebuild(doc.S, doc.table, translations, { mode, format: doc.format, lineEnding });
}

/** One translation per segment, by index; a document of plain strings. */
async function withTranslations(format: LongTextFormat, S: string, targets: Record<number, string>, mode: ExportMode, lineEnding: LineEnding = '\n') {
  const doc = await load(format, S);
  const translations = doc.records.map(record => (targets[record.i] === undefined ? undefined : done(record.i, targets[record.i])));
  return assemble(doc, translations, mode, lineEnding);
}

const GOLDEN: Array<{ name: string; extension: string; format: LongTextFormat }> = [
  { name: 'novel-indented', extension: 'txt', format: 'txt' },
  { name: 'gutenberg-wrapped', extension: 'txt', format: 'txt' },
  { name: 'poem', extension: 'txt', format: 'txt' },
  { name: 'split-groups', extension: 'txt', format: 'txt' },
  { name: 'comprehensive', extension: 'md', format: 'markdown' },
  { name: 'split-groups', extension: 'md', format: 'markdown' },
];
const MODES: ExportMode[] = ['target', 'bilingual'];
const goldenName = (name: string, mode: ExportMode, extension: string) => `${name}.${mode}.expected.${extension}`;

/** The records of every segment that was split into more than one part, by group. */
function splitGroups(doc: Doc) {
  const groups = new Map<number, SegmentedDocument['records']>();
  for (const record of doc.records) groups.set(record.g, [...(groups.get(record.g) ?? []), record]);
  return [...groups.values()].filter(parts => parts.length > 1);
}

/** S with its line breaks cycling through CRLF, LF and a lone CR. */
const mixedEndings = (S: string) => {
  let k = 0;
  return S.replace(/\n/g, () => ['\r\n', '\n', '\r'][k++ % 3]);
};

describe('invariant (a): no translation gives S back byte for byte', () => {
  for (const { name, extension, format } of GOLDEN) {
    it(`${name}.${extension}`, async () => {
      const S = fixture(`${name}.${extension}`);
      for (const variant of [S, S.replace(/\n/g, '\r\n'), S.replace(/\n/g, '\r'), mixedEndings(S)]) {
        const doc = await load(format, variant);
        const pending = doc.records.map((record): TranslationRecord | undefined => (record.t ? { ...done(record.i, 'x'), status: 'pending', target: null, origin: null } : undefined));
        for (const mode of MODES) {
          expect(assemble(doc, [], mode)).toBe(variant);
          expect(assemble(doc, pending, mode, '\r\n')).toBe(variant);
        }
      }
    });
  }

  it('holds for an empty text and a text without line breaks', async () => {
    for (const S of ['', 'One line without a break', '   ']) {
      for (const format of ['txt', 'markdown'] as const) {
        const doc = await load(format, S);
        for (const mode of MODES) expect(assemble(doc, [], mode)).toBe(S);
      }
    }
  });
});

describe('golden files', () => {
  it('cover line and unwrap TXT and split groups', async () => {
    expect((await load('txt', fixture('novel-indented.txt'))).structure?.resolved).toBe('line');
    expect((await load('txt', fixture('poem.txt'))).structure?.resolved).toBe('line');
    expect((await load('txt', fixture('gutenberg-wrapped.txt'))).structure?.resolved).toBe('unwrap');
    for (const [format, name] of [['txt', 'split-groups.txt'], ['markdown', 'split-groups.md']] as const) {
      expect(splitGroups(await load(format, fixture(name))).map(parts => parts.length)).toEqual([2, 2]);
    }
  });

  for (const { name, extension, format } of GOLDEN) {
    for (const mode of MODES) {
      const expected = goldenName(name, mode, extension);
      it(expected, async () => {
        const doc = await load(format, fixture(`${name}.${extension}`));
        const actual = assemble(doc, translate(doc), mode);
        if (UPDATE_GOLDEN) writeFileSync(fixtureUrl(expected), actual);
        expect(actual).toBe(fixture(expected));
      });

      it(`${expected} with CRLF line endings`, async () => {
        const doc = await load(format, fixture(`${name}.${extension}`).replace(/\n/g, '\r\n'));
        expect(assemble(doc, translate(doc), mode, '\r\n')).toBe(fixture(expected).replace(/\n/g, '\r\n'));
      });
    }
  }
});

describe('target only', () => {
  it('keeps the indentation of every line and the source of untranslated lines (AC-LT-05-1, AC-LT-17-3)', async () => {
    const doc = await load('txt', fixture('novel-indented.txt'));
    const translations = translate(doc, index => doc.records[index].o % 2 === 1);
    const source = doc.S.split('\n');
    let offset = 0;
    const expected = source.map(line => {
      const start = offset;
      offset += line.length + 1;
      const record = doc.records.find(segment => segment.r[0] >= start && segment.r[0] <= start + line.length);
      const target = record && translations[record.i]?.target;
      return target ? /^[ \t　]*/.exec(line)![0] + target : line;
    });
    expect(expected.filter((line, j) => line !== source[j]).length).toBeGreaterThan(10);
    expect(assemble(doc, translations, 'target').split('\n')).toEqual(expected);
  });

  it('writes a TXT line break as a new line indented like the first line', async () => {
    expect(await withTranslations('txt', '\u3000\u3000第一行。\n第二行。\n', { 0: 'One.\nStill one.', 1: 'Two.' }, 'target'))
      .toBe('\u3000\u3000One.\n\u3000\u3000Still one.\nTwo.\n');
    expect(await withTranslations('txt', '  First line.\r\nSecond line.\r\n', { 0: '第一\n行' }, 'target', '\r\n')).toBe('  第一\r\n  行\r\nSecond line.\r\n');
  });

  it('writes Markdown hard breaks with the source marker, the line ending and the continuation prefix', async () => {
    expect(await withTranslations('markdown', 'one  \ntwo\n', { 0: '一\n二' }, 'target')).toBe('一  \n二\n');
    expect(await withTranslations('markdown', 'one\\\ntwo\n', { 0: '一\n二' }, 'target')).toBe('一\\\n二\n');
    expect(await withTranslations('markdown', 'one\ntwo\n', { 0: '一\n二' }, 'target', '\r\n')).toBe('一\\\r\n二\n');
    expect(await withTranslations('markdown', '> one  \n> two\n', { 0: '一\n二' }, 'target')).toBe('> 一  \n> 二\n');
    expect(await withTranslations('markdown', '- one\\\n  two\n- three\n', { 0: '一\n二' }, 'target')).toBe('- 一\\\n  二\n- three\n');
    expect(await withTranslations('markdown', '[^1]: one\n    two\n', { 0: '一\n二' }, 'target')).toBe('[^1]: 一\\\n    二\n');
  });

  it('keeps hard breaks readable as hard breaks', async () => {
    expect(await withTranslations('markdown', 'one  \ntwo\n', { 0: '甲\n\n乙' }, 'target')).toBe('甲  \n\\\n乙\n');
    expect(await withTranslations('markdown', 'one\\\ntwo\n', { 0: 'C:\\\n乙' }, 'target')).toBe('C:\\  \n乙\n');
    expect(await withTranslations('markdown', 'one\\\ntwo\n', { 0: 'C:\\\\\n乙' }, 'target')).toBe('C:\\\\\\\n乙\n');
    expect(await withTranslations('markdown', 'one\n', { 0: '\n甲\r\n乙\n\n' }, 'target')).toBe('甲\\\n乙\n');
  });

  it('keeps extension marker lines on lines of their own after an identity translation', async () => {
    const cases: Array<[string, string]> = [
      ['> [!NOTE]\n> Useful information\n> on two lines.\n', '> [!NOTE]\n> Useful information on two lines.\n'],
      [':::tip\nbody text\nwraps here\n:::\n', ':::tip\nbody text wraps here\n:::\n'],
      ['::: tip Pro tip\nRun the build\nbefore you deploy.\n:::\n', '::: tip Pro tip\nRun the build before you deploy.\n:::\n'],
      ['!!! note "T"\n    body\n\nAfter the note\nends here.\n', '!!! note "T"\n    body\n\nAfter the note ends here.\n'],
    ];
    for (const [S, expected] of cases) {
      const doc = await load('markdown', S);
      const identity = doc.records.map(record => (record.t ? done(record.i, displayAt(S, doc.table, record.i)) : undefined));
      expect(assemble(doc, identity, 'target'), S).toBe(expected);
      const bilingual = assemble(doc, identity, 'bilingual').split('\n');
      for (const marker of ['> [!NOTE]', ':::tip', '::: tip Pro tip', '!!! note "T"', ':::']) {
        if (S.split('\n').includes(marker)) expect(bilingual, S).toContain(marker);
      }
    }
  });

  it('keeps headings and table rows on one line', async () => {
    expect(await withTranslations('markdown', '## Title ##\n', { 0: '标\n题' }, 'target')).toBe('## 标 题 ##\n');
    expect(await withTranslations('markdown', '| a | b |\n| - | - |\n', { 0: '| 甲\n乙 | 丙 |' }, 'target')).toBe('| 甲 乙 | 丙 |\n| - | - |\n');
  });

  it('replaces each translated part of a split group and keeps the others', async () => {
    const doc = await load('txt', fixture('split-groups.txt'));
    const part = doc.records.filter(record => record.g !== record.i).pop()!;
    const translations = doc.records.map(record => (record.i === part.i ? done(part.i, 'SECOND PART') : undefined));
    expect(assemble(doc, translations, 'target')).toBe(`${doc.S.slice(0, part.r[0])}SECOND PART${doc.S.slice(part.r[1])}`);
  });

  it('ignores pending and failed records and empty translations', async () => {
    const doc = await load('txt', 'One.\nTwo.\nThree.\n');
    const translations: Array<TranslationRecord | undefined> = [
      { ...done(0, 'x'), status: 'failed', target: null, origin: null, failure: { code: 'transport' } },
      done(1, '\n\n'),
      done(2, '三。'),
    ];
    expect(assemble(doc, translations, 'target')).toBe('One.\nTwo.\n三。\n');
  });
});

describe('bilingual', () => {
  it('follows each TXT segment with its translation, indented like it (AC-LT-17-2)', async () => {
    expect(await withTranslations('txt', '\u3000\u3000第一行。\r\n第二行。\n第三行。\r\n', { 0: 'Line one.', 1: 'Line two.', 2: 'Line\nthree.' }, 'bilingual', '\r\n'))
      .toBe('\u3000\u3000第一行。\r\n\u3000\u3000Line one.\r\n第二行。\r\nLine two.\n第三行。\r\nLine\r\nthree.\r\n');
    expect(await withTranslations('txt', 'One line.\rTwo lines.\r', { 1: '两行。' }, 'bilingual', '\r')).toBe('One line.\rTwo lines.\r两行。\r');
  });

  it('writes Markdown paragraphs and quotes as sibling paragraphs (AC-LT-17-2)', async () => {
    expect(await withTranslations('markdown', 'Hello\nworld.\n', { 0: '你好，\n世界。' }, 'bilingual')).toBe('Hello\nworld.\n\n你好，\\\n世界。\n');
    expect(await withTranslations('markdown', '> Hello.\n', { 0: '你好。' }, 'bilingual')).toBe('> Hello.\n>\n> 你好。\n');
    expect(await withTranslations('markdown', '> > Hi.\n> Lazy.\n', { 0: '嗨。' }, 'bilingual', '\r\n')).toBe('> > Hi.\n> Lazy.\r\n> >\r\n> > 嗨。\n');
  });

  it('continues list items and footnotes with a hard break (AC-LT-17-2)', async () => {
    expect(await withTranslations('markdown', '- Item.\n- Next.\n', { 0: '条目。' }, 'bilingual')).toBe('- Item.\\\n  条目。\n- Next.\n');
    expect(await withTranslations('markdown', '1. One\n   - Nested\n', { 1: '嵌套' }, 'bilingual')).toBe('1. One\n   - Nested\\\n     嵌套\n');
    expect(await withTranslations('markdown', '[^1]: Note.\n', { 0: '注。' }, 'bilingual')).toBe('[^1]: Note.\\\n    注。\n');
    expect(await withTranslations('markdown', '- path C:\\\n', { 0: '路径' }, 'bilingual')).toBe('- path C:\\  \n  路径\n');
  });

  it('writes headings as one line "source / translation" (AC-LT-17-2)', async () => {
    expect(await withTranslations('markdown', '## Installation ##\n\nText.\n', { 0: '安装' }, 'bilingual')).toBe('## Installation / 安装 ##\n\nText.\n');
    expect(await withTranslations('markdown', 'Getting\nstarted\n=======\n', { 0: '入门\n指南' }, 'bilingual')).toBe('Getting\nstarted / 入门 指南\n=======\n');
  });

  it('merges table cells as "source<br>translation" and falls back to the source row (AC-LT-17-2)', async () => {
    const table = '| Option | Value | Note |\n| - | - | - |\n| `a|b` | 300 | A \\| pipe |\n|  | x | y |\n';
    expect(await withTranslations('markdown', table, { 0: '| 选项 | 值 | 说明 |', 1: '| `a|b` | 300 | 一个 \\| 管道 |', 2: '| 空 | 叉 |' }, 'bilingual'))
      .toBe('| Option<br>选项 | Value<br>值 | Note<br>说明 |\n| - | - | - |\n| `a|b` | 300 | A \\| pipe<br>一个 \\| 管道 |\n|  | x | y |\n');
    expect(await withTranslations('markdown', 'Name | Value\n--- | ---\nSpeed | 12\n', { 1: '速度 | 12' }, 'bilingual')).toBe('Name | Value\n--- | ---\nSpeed<br>速度 | 12\n');
  });

  it('puts the whole source of a split group before its whole translation (AC-LT-05-7)', async () => {
    const cases = [
      { format: 'txt', name: 'split-groups.txt', separators: ['\n　　', '\n'] },
      { format: 'markdown', name: 'split-groups.md', separators: ['\\\n  ', '\n>\n> '] },
    ] as const;
    for (const { format, name, separators } of cases) {
      const doc = await load(format, fixture(name));
      const translations = translate(doc);
      const output = assemble(doc, translations, 'bilingual');
      const groups = splitGroups(doc);
      expect(groups).toHaveLength(2);
      groups.forEach((parts, k) => {
        const source = doc.S.slice(parts[0].r[0], parts[parts.length - 1].r[1]);
        const joined = parts.map(part => translations[part.i]!.target!).reduce((text, piece) => text + joinerBetween(text, piece) + piece);
        expect(output).toContain(source + separators[k] + joined);
        expect(output.split(source).length).toBe(2);
      });
    }
  });

  it('fills the untranslated parts of a split group with their source', async () => {
    const doc = await load('txt', fixture('split-groups.txt'));
    const [first, second] = splitGroups(doc)[0];
    const translations = doc.records.map(record => (record.i === second.i ? done(record.i, 'Translated second part.') : undefined));
    const source = doc.S.slice(first.r[0], second.r[1]);
    expect(assemble(doc, translations, 'bilingual')).toContain(`${source}\n　　${displayAt(doc.S, doc.table, first.i)} Translated second part.\n`);
  });

  it('keeps code, HTML, math and front matter byte for byte (AC-LT-17-2)', async () => {
    const doc = await load('markdown', fixture('comprehensive.md'));
    const output = assemble(doc, translate(doc), 'bilingual');
    for (const record of doc.records.filter(record => !record.t)) {
      expect(output).toContain(doc.S.slice(record.r[0], record.r[record.r.length - 1]));
    }
  });
});

it('assembles a large document quickly', async () => {
  const S = Array.from({ length: 40_000 }, (_, k) => `\u3000\u3000第${k}行，港口很安静。`).join('\r\n');
  const doc = await load('txt', S);
  const translations = doc.records.map(record => done(record.i, `Line ${record.i}, the harbour is quiet.`));
  const started = performance.now();
  for (const mode of MODES) expect(assemble(doc, translations, mode, '\r\n').length).toBeGreaterThan(S.length);
  expect(performance.now() - started).toBeLessThan(2_000);
});
