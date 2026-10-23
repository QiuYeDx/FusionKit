import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import iconv from 'iconv-lite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary, ImportDefaults } from '../../src/long-text/contract';
import { knowledgeSelectionSchema } from '../../src/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { LoadedDocument, type RatioModel } from '../../electron/main/long-text/document-state';
import { LongTextImporter } from '../../electron/main/long-text/importer';
import {
  FILES, LongTextOperationError, LongTextRepository, manifestSummary, unavailableSummary, type StoredDocument,
} from '../../electron/main/long-text/repository';
import { AT, removeRoot, temporaryRoot } from './document-test-utils';

// Wrapped so the tests can tell which files the importer opened.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const DEFAULTS: ImportDefaults = {
  targetLanguage: 'zh-Hans', style: null, instructions: '', profileId: null, pace: 2, batchSourceTokens: 1500,
  maxOutputTokens: null, knowledgeCollectionIds: [],
};
const ENGLISH = 'The river froze early that year.\nEveryone in the town said the winter would be long and hard.\n';
const MiB = 1024 * 1024;
const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

let root: string;
let inputs: string;
let repository: LongTextRepository;
let listed: DocumentSummary[];
let created: DocumentSummary[];
let readKnowledge: ReturnType<typeof vi.fn<() => LibrarySnapshot | Promise<LibrarySnapshot>>>;
let importer: LongTextImporter;

beforeEach(async () => {
  root = await temporaryRoot();
  inputs = path.join(root, 'inputs');
  await fs.mkdir(inputs);
  repository = new LongTextRepository(path.join(root, 'store'), { now: () => AT });
  listed = await repository.recover();
  created = [];
  readKnowledge = vi.fn(() => library([]));
  importer = new LongTextImporter({
    repository, documents: () => listed, readKnowledge, now: () => AT,
    onCreated: summary => {
      created.push(summary);
      listed.push(summary);
    },
  });
});

afterEach(async () => {
  await repository.idle();
  repository.dispose();
  await removeRoot(root);
});

async function input(name: string, content: string | Uint8Array): Promise<string> {
  const file = path.join(inputs, name);
  await fs.writeFile(file, content);
  return file;
}

async function load(id: string): Promise<StoredDocument> {
  const stored = await repository.withDocument(id, files => files.load());
  if ('unavailable' in stored) throw new Error(`unavailable: ${stored.unavailable}`);
  return stored;
}

async function folders(): Promise<string[]> {
  return (await fs.readdir(path.join(root, 'store', 'documents'))).sort();
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(() => 'resolved', (error: unknown) => (error instanceof LongTextOperationError ? error.code : String(error)));

function library(collections: Array<{ id: string; source: string; target: string; archived?: boolean }>): LibrarySnapshot {
  return {
    generation: 1,
    data: {
      format: 'fusionkit.translation-knowledge', schemaVersion: 2,
      package: { id: randomUUID(), revision: 1, name: 'Library', description: '', createdAt: '2026-10-22T00:00:00Z', generator: { name: 'test' } },
      collections: collections.map(({ id, source, target, archived }) => ({
        id, revision: 1, name: id, description: '', languagePair: { source, target }, archived: archived ?? false,
      })),
      entries: [], presets: [],
    },
  };
}

const openedPaths = (...names: string[]) => {
  const watched = new Set(names.map(name => path.join(inputs, name)));
  return [...vi.mocked(fs.open).mock.calls, ...vi.mocked(fs.readFile).mock.calls]
    .map(([file]) => String(file))
    .filter(file => watched.has(file));
};

describe('rejected files', () => {
  it('imports only the valid file of a mixed batch and reports each rejection (AC-LT-02-3)', async () => {
    const paths = [
      await input('a.docx', 'PK\u0003\u0004 not a document we read'),
      await input('ep01.srt', '1\n00:00:01,000 --> 00:00:02,000\nHello\n'),
      path.join(inputs, 'big.txt'),
      await input('empty.txt', ''),
      await input('data.txt', 'hello\u0000world, this is not text'),
      await input('ok.md', '# Notes\n\nA paragraph worth translating.\n'),
    ];
    const big = await fs.open(paths[2], 'w');
    await big.truncate(11 * MiB);
    await big.close();
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.readFile).mockClear();

    const result = await importer.importFiles(paths, DEFAULTS);

    expect(result.documents.map(document => document.name)).toEqual(['ok.md']);
    expect(result.duplicates).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'a.docx', reason: 'unsupported_format' },
      { name: 'ep01.srt', reason: 'subtitle_file' },
      { name: 'big.txt', reason: 'file_too_large' },
      { name: 'empty.txt', reason: 'empty_document' },
      { name: 'data.txt', reason: 'binary_file' },
    ]);
    // Extension and size are checked before anything is read.
    expect(openedPaths('a.docx', 'ep01.srt', 'big.txt')).toEqual([]);
    expect(await folders()).toEqual([result.documents[0].id]);
  });

  it('rejects every subtitle extension and accepts the text extensions in any case', async () => {
    const subtitles = ['.srt', '.ass', '.ssa', '.vtt', '.lrc', '.sbv', '.SUB'];
    const subtitlePaths = await Promise.all(subtitles.map(extension => input(`episode${extension}`, ENGLISH)));
    const textPaths = [await input('NOTES.TXT', ENGLISH), await input('guide.Markdown', `# Guide\n\n${ENGLISH}`), await input('readme.md', ENGLISH)];

    const result = await importer.importFiles([...subtitlePaths, ...textPaths], DEFAULTS);

    expect(result.skipped.map(skip => skip.reason)).toEqual(subtitles.map(() => 'subtitle_file'));
    expect(result.documents.map(document => [document.name, document.format])).toEqual([
      ['NOTES.TXT', 'txt'], ['guide.Markdown', 'markdown'], ['readme.md', 'markdown'],
    ]);
  });

  it('treats folders, missing files and text without letters as not importable', async () => {
    const folder = path.join(inputs, 'folder.txt');
    await fs.mkdir(folder);
    const paths = [folder, path.join(inputs, 'gone.md'), await input('rules.txt', '***\n\n◇◇◇\n  \n12 34\n')];

    const result = await importer.importFiles(paths, DEFAULTS);

    expect(result.skipped).toEqual([
      { name: 'folder.txt', reason: 'file_unreadable' },
      { name: 'gone.md', reason: 'file_unreadable' },
      { name: 'rules.txt', reason: 'empty_document' },
    ]);
    expect(result.documents).toEqual([]);
  });

  it('does not follow a symbolic link', async context => {
    const target = await input('target.txt', ENGLISH);
    const link = path.join(inputs, 'link.txt');
    try {
      await fs.symlink(target, link, 'file');
    } catch {
      context.skip(); // Windows without Developer Mode cannot create file links.
    }
    const result = await importer.importFiles([link], DEFAULTS);
    expect(result.skipped).toEqual([{ name: 'link.txt', reason: 'file_unreadable' }]);
  });

  it('rejects a document over 200,000 segments', async () => {
    const file = await input('huge.txt', 'a\n'.repeat(200_001));
    const result = await importer.importFiles([file], DEFAULTS);
    expect(result.skipped).toEqual([{ name: 'huge.txt', reason: 'too_many_segments' }]);
    expect(await folders()).toEqual([]);
  });

  it('stops at 200 documents but still recognizes duplicates', async () => {
    const file = await input('novel.txt', ENGLISH);
    const [first] = (await importer.importFiles([file], DEFAULTS)).documents;
    while (listed.length < 200) listed.push(unavailableSummary(randomUUID(), 'damaged', undefined, 'other', AT));
    const other = await input('other.txt', ENGLISH);

    const result = await importer.importFiles([file, other], DEFAULTS);

    expect(result.duplicates).toEqual([{ name: 'novel.txt', documentId: first.id }]);
    expect(result.skipped).toEqual([{ name: 'other.txt', reason: 'limit_exceeded' }]);
    expect(await errorCode(importer.importText('Pasted', ENGLISH, 'txt', DEFAULTS))).toBe('limit_exceeded');
  });
});

describe('duplicates', () => {
  it('activates the listed document for the same path and content (AC-LT-02-4)', async () => {
    const file = await input('novel.txt', ENGLISH);
    const [first] = (await importer.importFiles([file], DEFAULTS)).documents;

    const again = await importer.importFiles([path.join(inputs, '.', 'novel.txt')], DEFAULTS);

    expect(again).toEqual({ documents: [], duplicates: [{ name: 'novel.txt', documentId: first.id }], skipped: [] });
    expect(await folders()).toEqual([first.id]);
  });

  it('imports again when the content or the path differs', async () => {
    const file = await input('novel.txt', ENGLISH);
    const copy = await input('copy.txt', ENGLISH);
    await importer.importFiles([file], DEFAULTS);
    await fs.writeFile(file, `${ENGLISH}A new last line.\n`);

    const result = await importer.importFiles([file, copy], DEFAULTS);

    expect(result.documents.map(document => document.name)).toEqual(['novel.txt', 'copy.txt']);
    expect(result.duplicates).toEqual([]);
    expect(await folders()).toHaveLength(3);
  });

  it('reports the second of two identical paths in one import as a duplicate of the first', async () => {
    const file = await input('novel.txt', ENGLISH);
    const result = await importer.importFiles([file, file], DEFAULTS);
    expect(result.documents).toHaveLength(1);
    expect(result.duplicates).toEqual([{ name: 'novel.txt', documentId: result.documents[0].id }]);
  });

  it('ignores a listed document that cannot be opened', async () => {
    const file = await input('novel.txt', ENGLISH);
    const [first] = (await importer.importFiles([file], DEFAULTS)).documents;
    listed[0] = { ...listed[0], unavailable: 'damaged' };

    const result = await importer.importFiles([file], DEFAULTS);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].id).not.toBe(first.id);
  });
});

describe('the new document', () => {
  it('stores the file source, the original bytes, S and the detected encoding', async () => {
    const text = (await fs.readFile(fixture('encoding/zh-hans.txt'), 'utf8')).replace(/\r?\n/g, '\r\n');
    const bytes = iconv.encode(text, 'gb18030');
    const file = await input('novel.txt', bytes);

    const [summary] = (await importer.importFiles([file], DEFAULTS)).documents;
    const stored = await load(summary.id);
    const { manifest } = stored;

    expect(manifest.source).toEqual({
      kind: 'file', path: file, size: bytes.length, mtimeMs: (await fs.lstat(file)).mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(manifest.encoding).toEqual({ name: 'gb18030', confidence: 'high', confirmed: true, lineEnding: '\r\n' });
    expect(manifest.lineEnding).toBe('\r\n');
    expect(stored.source).toBe(text);
    expect(Buffer.from((await repository.withDocument(summary.id, files => files.readOriginal()))!)).toEqual(bytes);
    expect(manifest.detected.sourceLanguage).toBe('zh-Hans');
    expect(manifest.stats).toEqual({
      characters: text.length, segments: stored.table.count, translatable: manifest.counts.translatable,
      pages: stored.pages.length, sourceTokens: expect.any(Number),
    });
    expect(manifest.counts).toEqual({ translatable: manifest.stats.translatable, done: 0, pending: manifest.stats.translatable, failed: 0, attention: 0, edited: 0, locked: 0 });
    expect(manifest).toMatchObject({ revision: 0, createdAt: AT, updatedAt: AT, fullRunStarted: false, sample: null, runs: [], exports: [], exportFolder: null });
    expect(summary).toEqual(manifestSummary(manifest));
    expect(created).toEqual([summary]);
  });

  it('leaves a low-confidence encoding unconfirmed', async () => {
    const file = await input('short.txt', iconv.encode('第一章　中文测试', 'gb18030'));
    const [summary] = (await importer.importFiles([file], DEFAULTS)).documents;
    expect(summary.encoding).toMatchObject({ confidence: 'low', confirmed: false });
  });

  it('keeps pasted text as given, without an encoding or original bytes', async () => {
    const text = '  \n  Chapter One\r\nThe river froze early that year.\r\n';
    const summary = await importer.importText('  My notes  ', text, 'txt', DEFAULTS);
    const stored = await load(summary.id);

    expect(summary).toMatchObject({ name: 'My notes', source: { kind: 'paste' }, encoding: null, format: 'txt' });
    expect(stored.source).toBe(text);
    expect(stored.manifest.lineEnding).toBe('\r\n');
    expect(await repository.withDocument(summary.id, files => files.readOriginal())).toBeNull();
  });

  it('names pasted text after its first line when no name is sent, and cuts long names', async () => {
    const line = 'A remarkably long first line that keeps going on and on';
    const unnamed = await importer.importText(undefined, `\n\n${line}\nSecond line.\n`, 'txt', DEFAULTS);
    const long = await importer.importText('x'.repeat(200), ENGLISH, 'txt', DEFAULTS);
    expect(unnamed.name).toBe(line.slice(0, 30).trimEnd());
    expect(long.name).toBe('x'.repeat(120));
  });

  it('rejects pasted text with nothing to translate', async () => {
    expect(await errorCode(importer.importText(undefined, '  \n\t\n', 'txt', DEFAULTS))).toBe('empty_document');
    expect(await errorCode(importer.importText(undefined, '```\ncode only\n```\n', 'markdown', DEFAULTS))).toBe('empty_document');
    expect(await folders()).toEqual([]);
  });

  it('pages a document so that no page read returns more than 60 rows', async () => {
    const text = Array.from({ length: 400 }, (_, index) => `Line ${index} of the story goes on.`).join('\n');
    const summary = await importer.importText('Story', text, 'txt', DEFAULTS);
    await expectPagesWithin60(summary.id);
  });
});

describe('default settings', () => {
  it('derives the target from the defaults and moves it off the source language (AC-LT-07-1)', async () => {
    const japanese = await fs.readFile(fixture('encoding/ja.txt'), 'utf8');
    const english = await importer.importText('en', ENGLISH, 'txt', { ...DEFAULTS, targetLanguage: 'en' });
    const japaneseToJapanese = await importer.importText('ja', japanese, 'txt', { ...DEFAULTS, targetLanguage: 'ja' });
    const englishToJapanese = await importer.importText('en-ja', ENGLISH, 'txt', { ...DEFAULTS, targetLanguage: 'ja' });

    expect(english.languages).toEqual({ source: 'en', target: 'zh-Hans', sourceIsAuto: true });
    expect(japaneseToJapanese.languages).toEqual({ source: 'ja', target: 'en', sourceIsAuto: true });
    expect(englishToJapanese.languages).toEqual({ source: 'en', target: 'ja', sourceIsAuto: true });
  });

  it('suggests the style from the content unless the defaults name one', async () => {
    const novel = await input('novel.txt', await fs.readFile(fixture('novel-indented.txt')));
    const code = '# Setup\n\nRun `pnpm install` first, then `pnpm dev`.\n\n```sh\npnpm dev\n```\n\nOpen the `app` folder.\n';
    const [suggested] = (await importer.importFiles([novel], DEFAULTS)).documents;
    const technical = await importer.importText('setup', code, 'markdown', DEFAULTS);
    const chosen = await importer.importText('novel', await fs.readFile(novel, 'utf8'), 'txt', { ...DEFAULTS, style: 'general' });

    expect(suggested.style).toBe('literary');
    expect(technical.style).toBe('technical');
    expect(chosen.style).toBe('general');
    expect((await load(chosen.id)).manifest.detected.style).toBe('literary');
  });

  it('copies the remaining defaults into the settings', async () => {
    const defaults: ImportDefaults = {
      ...DEFAULTS, instructions: 'Keep the names in pinyin.', profileId: 'profile-1', pace: 4, batchSourceTokens: 2400, maxOutputTokens: 8192,
    };
    const summary = await importer.importText('notes', ENGLISH, 'txt', defaults);
    expect((await load(summary.id)).manifest.settings).toEqual({
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'general', instructions: 'Keep the names in pinyin.', knowledge: null,
      profileId: 'profile-1', pace: 4, batchSourceTokens: 2400, maxOutputTokens: 8192,
    });
  });

  it('keeps only the materials that exist, are not archived and match the direction', async () => {
    const [matching, otherDirection, archived, missing] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    readKnowledge.mockImplementation(() => library([
      { id: matching, source: 'en', target: 'zh-Hans' },
      { id: otherDirection, source: 'ja', target: 'zh-Hans' },
      { id: archived, source: 'en', target: 'zh-Hans', archived: true },
    ]));
    const files = [await input('one.txt', ENGLISH), await input('two.txt', `${ENGLISH}More.\n`)];
    const ids = [otherDirection, matching, archived, missing, matching];

    const result = await importer.importFiles(files, { ...DEFAULTS, knowledgeCollectionIds: ids });
    const { knowledge } = (await load(result.documents[0].id)).manifest.settings;

    expect(knowledge).toEqual({ version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [matching], disabledEntryIds: [] });
    expect(knowledgeSelectionSchema.safeParse(knowledge).success).toBe(true);
    expect(readKnowledge).toHaveBeenCalledTimes(1);
  });

  it('starts without materials when none fits or the library cannot be read', async () => {
    const otherDirection = randomUUID();
    readKnowledge.mockImplementation(() => library([{ id: otherDirection, source: 'ja', target: 'zh-Hans' }]));
    const unfit = await importer.importText('a', ENGLISH, 'txt', { ...DEFAULTS, knowledgeCollectionIds: [otherDirection] });
    readKnowledge.mockImplementation(() => Promise.reject(new Error('library locked')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unreadable = await importer.importText('b', ENGLISH, 'txt', { ...DEFAULTS, knowledgeCollectionIds: [otherDirection] });
    warn.mockRestore();
    readKnowledge.mockClear();
    await importer.importText('c', ENGLISH, 'txt', DEFAULTS);

    expect((await load(unfit.id)).manifest.settings.knowledge).toBeNull();
    expect((await load(unreadable.id)).manifest.settings.knowledge).toBeNull();
    expect(readKnowledge).not.toHaveBeenCalled();
  });
});

describe('resegment', () => {
  it('segments again with another paragraph mode and discards the translation state (AC-LT-05-8)', async () => {
    const file = await input('wrapped.txt', await fs.readFile(fixture('gutenberg-wrapped.txt')));
    const [summary] = (await importer.importFiles([file], DEFAULTS)).documents;
    const before = await load(summary.id);
    expect(before.manifest.structure).toEqual({ txtSplit: 'auto', resolved: 'unwrap' });
    await repository.withDocument(summary.id, files => files.writeManifest({
      ...before.manifest, fullRunStarted: true, sample: { indices: [0], settingsDigest: 'digest', at: AT },
      runs: [{ id: randomUUID(), kind: 'full', status: 'completed', startedAt: AT, settingsDigest: 'digest', model: { profileId: 'p', modelKey: 'm', label: 'M' }, total: 1, done: 1, failed: 0, deferred: 0 }],
      exports: [{ path: path.join(inputs, 'wrapped.zh-Hans.txt'), name: 'wrapped.zh-Hans.txt', mode: 'target', at: AT }],
    }));
    const current = await load(summary.id);

    const manifest = await importer.resegment(current, { txtSplit: 'line' });
    const after = await load(summary.id);

    expect(after.manifest).toEqual(manifest);
    expect(manifest.structure).toEqual({ txtSplit: 'line', resolved: 'line' });
    expect(manifest.revision).toBe(current.manifest.revision + 1);
    expect(after.table.count).toBeGreaterThan(before.table.count);
    expect(manifest.stats.segments).toBe(after.table.count);
    expect(manifest.counts.pending).toBe(manifest.stats.translatable);
    expect(manifest).toMatchObject({ fullRunStarted: false, sample: null, runs: [], exports: current.manifest.exports, name: 'wrapped.txt' });
    expect(after.replay.records.size).toBe(0);
    expect(after.source).toBe(before.source);
  });

  it('re-decodes the kept original bytes even after the source file is gone (AC-LT-04-3)', async () => {
    // English as UTF-16LE; read as UTF-16BE every letter becomes a CJK ideograph (some only Traditional).
    const file = await input('notes.txt', iconv.encode(ENGLISH, 'utf-16le'));
    const [summary] = (await importer.importFiles([file], { ...DEFAULTS, targetLanguage: 'zh-Hant' })).documents;
    expect(summary.encoding).toEqual({ name: 'utf-16le', confidence: 'high', confirmed: true });
    expect(summary.languages).toMatchObject({ source: 'en', target: 'zh-Hant' });
    await fs.rm(file);

    const swapped = await importer.resegment(await load(summary.id), { encoding: 'utf-16be' });
    expect(swapped.encoding).toEqual({ name: 'utf-16be', confidence: 'high', confirmed: true, lineEnding: '\n' });
    expect(swapped.detected.sourceLanguage).toBe('zh-Hant');
    // A target equal to the new source language moves away from it.
    expect(swapped.settings.targetLanguage).toBe('en');

    const restored = await importer.resegment(await load(summary.id), { encoding: 'utf-16le' });
    expect((await load(summary.id)).source).toBe(ENGLISH);
    expect(restored.detected.sourceLanguage).toBe('en');
    expect(restored.settings.targetLanguage).toBe('zh-Hans');
    expect(restored.revision).toBe(2);
  });

  it('drops materials chosen for a direction the document no longer has', async () => {
    const collection = randomUUID();
    readKnowledge.mockImplementation(() => library([{ id: collection, source: 'zh-Hans', target: 'en' }]));
    const file = await input('novel.txt', await fs.readFile(fixture('encoding/zh-hans.txt')));
    const [summary] = (await importer.importFiles([file], { ...DEFAULTS, targetLanguage: 'en', knowledgeCollectionIds: [collection] })).documents;
    expect((await load(summary.id)).manifest.settings.knowledge?.collectionIds).toEqual([collection]);

    const sameLanguages = await importer.resegment(await load(summary.id), { txtSplit: 'unwrap' });
    expect(sameLanguages.settings.knowledge?.collectionIds).toEqual([collection]);

    const garbled = await importer.resegment(await load(summary.id), { encoding: 'windows-1252' });
    expect(garbled.settings.knowledge).toBeNull();
  });

  it('refuses an encoding change without original bytes', async () => {
    const pasted = await importer.importText('notes', ENGLISH, 'txt', DEFAULTS);
    expect(await errorCode(importer.resegment(await load(pasted.id), { encoding: 'gb18030' }))).toBe('invalid_request');

    const file = await input('novel.txt', ENGLISH);
    const [imported] = (await importer.importFiles([file], DEFAULTS)).documents;
    await fs.rm(path.join(root, 'store', 'documents', imported.id, FILES.original));
    const before = await load(imported.id);
    expect(await errorCode(importer.resegment(before, { encoding: 'gb18030' }))).toBe('source_missing');
    expect((await load(imported.id)).manifest).toEqual(before.manifest);
  });

  it('keeps a Markdown document without a paragraph mode', async () => {
    const summary = await importer.importText('guide', '# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n', 'markdown', DEFAULTS);
    const manifest = await importer.resegment(await load(summary.id), { txtSplit: 'line' });
    expect(manifest.structure).toBeNull();
    expect(manifest.stats.translatable).toBe(3);
  });
});

describe('performance (AC-LT-02-5)', () => {
  it.each([
    ['novel.txt', chineseNovel],
    ['manual.md', englishManual],
  ])('imports a 5 MB %s within 5 s without blocking the event loop for 250 ms', async (name, generate) => {
    const file = await input(name, generate(5 * MiB));
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    const result = await importer.importFiles([file], DEFAULTS);
    const elapsed = performance.now() - started;
    delay.disable();

    expect(result.skipped).toEqual([]);
    expect(elapsed).toBeLessThan(5_000);
    expect(delay.max / 1e6).toBeLessThan(250);
    await expectPagesWithin60(result.documents[0].id);
  });
});

/** Opens the document as the reader would and reads every page. */
async function expectPagesWithin60(id: string) {
  const ratio: RatioModel = { create: () => ({ value: 1, push: () => undefined }), sample: () => null };
  const document = await LoadedDocument.open(repository, id, { ratio });
  if ('unavailable' in document) throw new Error('unavailable');
  const sizes = document.pages.map((_, page) => document.readPage(page).rows.length);
  await document.close();
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(60);
}

const HANZI = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光';

/** Chinese prose in full-width-indented lines, with a chapter title every 120 lines; UTF-8, at least `bytes` long. */
function chineseNovel(bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let line = 0; size < bytes; line++) {
    let text = line % 120 === 0 ? `第${line / 120 + 1}章　风雪` : '　　';
    if (line % 120) {
      for (let k = 0; k < 90; k++) text += HANZI[(line * 7 + k * 13) % HANZI.length] + (k % 15 === 14 ? '，' : '');
      text += '。';
    }
    lines.push(text);
    size += Buffer.byteLength(text) + 1;
  }
  return lines.join('\n');
}

/** An English Markdown manual with headings, prose with inline markup, lists, code blocks and tables. */
function englishManual(bytes: number): string {
  const sections: string[] = [];
  let size = 0;
  for (let section = 0; size < bytes; section++) {
    const text = [
      `## Section ${section}: configuring the *build* pipeline`,
      '',
      `The \`build\` command reads [the configuration](https://example.com/docs/${section}) and writes **every** artifact to \`dist/\`. ` +
        'It keeps going when a single step fails, and reports each failure at the end so that nothing is lost.',
      '',
      '- Install the dependencies with `pnpm install`.',
      '- Run the checks before you commit, see <https://example.com/checks>.',
      '  1. Lint the sources.',
      '  2. Run the unit tests.',
      '',
      '```ts',
      `export const section${section} = { retries: 3, timeoutMs: 1_000 };`,
      '```',
      '',
      '| Option | Meaning |',
      '| --- | --- |',
      '| `retries` | How often a failed step runs again |',
      '| `timeoutMs` | How long a step may take |',
      '',
      '> Note: the pipeline never deletes files it did not create.',
      '',
    ].join('\n');
    sections.push(text);
    size += Buffer.byteLength(text) + 1;
  }
  return sections.join('\n');
}
