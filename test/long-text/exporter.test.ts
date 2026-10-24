import type { BrowserWindow, OpenDialogReturnValue } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LongTextFormat } from '../../src/long-text/contract';
import { SEGMENT_FLAG, type LineEnding, type TranslationRecord } from '../../src/long-text/model';
import { rebuild } from '../../src/long-text/rebuild';
import { buildSegmentTable } from '../../src/long-text/segments';
import { exportName, numberedName, sanitizeFileName } from '../../src/long-text/export-name';
import { LoadedDocument, type RatioModel } from '../../electron/main/long-text/document-state';
import {
  LongTextExporter, samePath,
  type ExportDocument, type ExporterOptions, type RevealTarget,
} from '../../electron/main/long-text/exporter';
import { LongTextRepository } from '../../electron/main/long-text/repository';
import { AT, buildDocument, removeRoot, temporaryRoot, translated } from './document-test-utils';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

const RATIO: RatioModel = { create: () => ({ value: 1, push: () => undefined }), sample: () => null };
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let root: string;
let input: string;
let documentsDir: string;
let clock: number;
let repository: LongTextRepository;
let opened: LoadedDocument[];
let showOpenDialog: Mock<(...args: unknown[]) => Promise<OpenDialogReturnValue>>;
let showItemInFolder: Mock<(file: string) => void>;
let writeText: Mock<(text: string) => void>;
let getPath: Mock<(name: 'documents') => string>;

beforeEach(async () => {
  root = await temporaryRoot();
  input = path.join(root, 'input');
  documentsDir = path.join(root, 'Documents');
  await fs.mkdir(input);
  await fs.mkdir(documentsDir);
  clock = AT;
  repository = new LongTextRepository(path.join(root, 'store'));
  await repository.recover();
  opened = [];
  showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
  showItemInFolder = vi.fn();
  writeText = vi.fn();
  getPath = vi.fn((_name: 'documents') => documentsDir);
});

afterEach(async () => {
  vi.mocked(fs.link).mockClear();
  for (const document of opened) await document.close();
  await repository.idle();
  repository.dispose();
  await removeRoot(root);
});

function exporter(options: Partial<ExporterOptions> = {}): LongTextExporter {
  return new LongTextExporter({
    paths: { getPath },
    dialog: { showOpenDialog } as unknown as ExporterOptions['dialog'],
    clipboard: { writeText },
    shell: { showItemInFolder },
    now: () => clock,
    ...options,
  });
}

async function open(id: string): Promise<LoadedDocument> {
  const document = await LoadedDocument.open(repository, id, { ratio: RATIO, now: () => clock });
  if ('unavailable' in document) throw new Error(`unavailable: ${document.unavailable}`);
  opened.push(document);
  return document;
}

interface DocumentOptions { format?: LongTextFormat; lineEnding?: LineEnding; name?: string }

/** A document imported from `<root>/input/<fileName>`, which holds S. */
async function fileDocument(S: string, fileName = 'novel.txt', options: DocumentOptions = {}): Promise<{ document: LoadedDocument; file: string }> {
  const file = path.join(input, fileName);
  await fs.writeFile(file, S);
  const built = await buildDocument(S, { format: options.format, name: fileName });
  const sha256 = createHash('sha256').update(S).digest('hex');
  built.manifest.source = { kind: 'file', path: file, size: Buffer.byteLength(S), mtimeMs: AT, sha256 };
  built.manifest.lineEnding = options.lineEnding ?? '\n';
  await repository.createDocument(built);
  return { document: await open(built.manifest.id), file };
}

async function pastedDocument(S: string, options: DocumentOptions = {}): Promise<LoadedDocument> {
  const built = await buildDocument(S, { format: options.format, name: options.name ?? 'Pasted text' });
  built.manifest.lineEnding = options.lineEnding ?? '\n';
  await repository.createDocument(built);
  return open(built.manifest.id);
}

/** Commits model translations, `[index, target]`. */
async function translate(document: LoadedDocument, entries: Array<[number, string]>): Promise<void> {
  const records = entries.map(([index, target]) => translated(index, document.rev(index) + 1, target));
  await document.commit(records, null, { skipLocked: false });
}

/** What `rebuild` makes of the document's current translations. */
function rebuilt(document: LoadedDocument, mode: 'target' | 'bilingual'): string {
  const translations = Array.from({ length: document.table.count }, (_, index) => document.translationAt(index));
  return rebuild(document.source, document.table, translations, { mode, format: document.format, lineEnding: document.manifest.lineEnding });
}

const errorCode = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => (error as { code: string }).code);
function thrownCode(call: () => unknown): string {
  try {
    call();
    return 'returned';
  } catch (error) {
    return (error as { code: string }).code;
  }
}
const temporaryFiles = async (folder: string) => (await fs.readdir(folder)).filter(name => name.startsWith('.lt-'));
const linkError = (code: string) => Object.assign(new Error(code), { code });

describe('file names', () => {
  it('replaces unsafe and control characters and trims dots and spaces', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeFileName('tab\there\u0000nul\u007fdel\u0085next')).toBe('tab-here-nul-del-next');
    expect(sanitizeFileName(' .. Chapter one. . ')).toBe('Chapter one');
    expect(sanitizeFileName('夜の森')).toBe('夜の森');
  });

  it('prefixes reserved Windows device names, before any extension and in any case', () => {
    for (const name of ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.backup', 'NUL .notes']) {
      expect(sanitizeFileName(name)).toBe(`_${name}`);
    }
    for (const name of ['CONSOLE', 'COM10', 'LPT0', 'auxiliary', 'my con']) expect(sanitizeFileName(name)).toBe(name);
  });

  it('keeps at most 120 characters without splitting a surrogate pair, and names nothing untitled', () => {
    expect(sanitizeFileName('a'.repeat(200))).toBe('a'.repeat(120));
    expect(sanitizeFileName(`${'a'.repeat(119)}😀tail`)).toBe('a'.repeat(119));
    expect(sanitizeFileName(`${'a'.repeat(110)}         .   x`)).toBe('a'.repeat(110));
    expect(sanitizeFileName(`CON${' '.repeat(200)}x`)).toBe('_CON');
    expect(sanitizeFileName(`CON.${'a'.repeat(200)}`)).toHaveLength(120);
    expect(sanitizeFileName('')).toBe('untitled');
    expect(sanitizeFileName(' ... ')).toBe('untitled');
  });

  it('names an export after the source file, the target language and the mode', () => {
    expect(exportName({ fileName: 'novel.txt', name: 'Renamed', format: 'txt' }, 'zh-Hans', 'target')).toEqual({ stem: 'novel.zh-Hans', ext: '.txt' });
    expect(exportName({ fileName: 'novel.TXT', name: 'novel.TXT', format: 'txt' }, 'zh-Hans', 'bilingual')).toEqual({ stem: 'novel.zh-Hans.bilingual', ext: '.txt' });
    expect(exportName({ fileName: 'guide.md', name: 'guide.md', format: 'markdown' }, 'ja', 'target')).toEqual({ stem: 'guide.ja', ext: '.md' });
    expect(exportName({ fileName: 'README.Markdown', name: 'README.Markdown', format: 'markdown' }, 'en', 'bilingual')).toEqual({ stem: 'README.en.bilingual', ext: '.markdown' });
    expect(exportName({ fileName: 'notes.v2.txt', name: 'notes.v2.txt', format: 'txt' }, 'fr', 'target')).toEqual({ stem: 'notes.v2.fr', ext: '.txt' });
    expect(exportName({ fileName: '.txt', name: '.txt', format: 'txt' }, 'en', 'target')).toEqual({ stem: 'txt.en', ext: '.txt' });
    expect(exportName({ fileName: 'con.txt', name: 'con.txt', format: 'txt' }, 'en', 'target')).toEqual({ stem: '_con.en', ext: '.txt' });
  });

  it('names pasted text after the sanitized document name, Markdown as .md', () => {
    expect(exportName({ fileName: null, name: 'Notes: draft?', format: 'markdown' }, 'zh-Hant', 'target')).toEqual({ stem: 'Notes- draft-.zh-Hant', ext: '.md' });
    expect(exportName({ fileName: null, name: 'Pasted text', format: 'txt' }, 'ko', 'bilingual')).toEqual({ stem: 'Pasted text.ko.bilingual', ext: '.txt' });
  });

  it('numbers candidates from (2) to (99) before the extension', () => {
    const name = { stem: 'novel.zh-Hans.bilingual', ext: '.txt' };
    expect(numberedName(name, 1)).toBe('novel.zh-Hans.bilingual.txt');
    expect(numberedName(name, 2)).toBe('novel.zh-Hans.bilingual (2).txt');
    expect(numberedName(name, 99)).toBe('novel.zh-Hans.bilingual (99).txt');
  });

  it('compares paths without case on win32 and darwin only', () => {
    const a = path.resolve('Folder', 'Novel.zh-Hans.TXT');
    const b = path.resolve('folder', 'novel.zh-hans.txt');
    expect(samePath(a, b, 'win32')).toBe(true);
    expect(samePath(a, b, 'darwin')).toBe(true);
    expect(samePath(a, b, 'linux')).toBe(false);
    expect(samePath(a, path.join(path.resolve('Folder'), '.', 'Novel.zh-Hans.TXT'), 'linux')).toBe(true);
    expect(samePath('Caf\u00e9.txt', 'Cafe\u0301.txt', 'linux')).toBe(true);
  });
});

describe('export', () => {
  it('publishes beside the source under a new name each time and never writes the source (AC-LT-17-1)', async () => {
    const S = 'First line.\nSecond line.\nThird line.';
    const { document, file } = await fileDocument(S);
    await translate(document, [[0, '第一行。'], [1, '第二行。']]);
    const first = await exporter().export(document, 'target', 'source');
    expect(first).toEqual({ path: path.join(input, 'novel.zh-Hans.txt'), name: 'novel.zh-Hans.txt', translated: 2, untranslated: 1 });
    expect(await fs.readFile(first.path, 'utf8')).toBe('第一行。\n第二行。\nThird line.');

    await translate(document, [[2, '第三行。']]);
    clock += 1_000;
    const second = await exporter().export(document, 'target', 'source');
    expect(second).toEqual({ path: path.join(input, 'novel.zh-Hans (2).txt'), name: 'novel.zh-Hans (2).txt', translated: 3, untranslated: 0 });
    expect(await fs.readFile(second.path, 'utf8')).toBe('第一行。\n第二行。\n第三行。');
    expect(await fs.readFile(first.path, 'utf8')).toBe('第一行。\n第二行。\nThird line.');
    expect(await fs.readFile(file, 'utf8')).toBe(S);
    expect((await fs.readdir(input)).sort()).toEqual(['novel.txt', 'novel.zh-Hans (2).txt', 'novel.zh-Hans.txt']);
  });

  it('records each export newest first in the saved manifest', async () => {
    const { document } = await fileDocument('One.\nTwo.');
    await exporter().export(document, 'target', 'source');
    clock += 1_000;
    await exporter().export(document, 'bilingual', 'source');
    const expected = [
      { path: path.join(input, 'novel.zh-Hans.bilingual.txt'), name: 'novel.zh-Hans.bilingual.txt', mode: 'bilingual', at: AT + 1_000 },
      { path: path.join(input, 'novel.zh-Hans.txt'), name: 'novel.zh-Hans.txt', mode: 'target', at: AT },
    ];
    expect(document.manifest.exports).toEqual(expected);
    expect(document.summary().lastExport).toEqual({ name: 'novel.zh-Hans.bilingual.txt', at: AT + 1_000 });
    const saved = await repository.withDocument(document.id, files => files.readManifest());
    expect('manifest' in saved && saved.manifest.exports).toEqual(expected);
  });

  it('writes UTF-8 without a BOM and inserts the document line ending (AC-LT-17-7)', async () => {
    const S = 'One.\r\n  Two.\r\nThree.\r\n';
    const { document } = await fileDocument(S, 'crlf.txt', { lineEnding: '\r\n' });
    await translate(document, [[0, '一。\n第二行'], [1, '二。']]);
    const target = await exporter().export(document, 'target', 'source');
    const bilingual = await exporter().export(document, 'bilingual', 'source');
    const targetBytes = await fs.readFile(target.path);
    const bilingualBytes = await fs.readFile(bilingual.path);
    expect(targetBytes.subarray(0, 3).equals(BOM)).toBe(false);
    expect(targetBytes.toString('utf8')).toBe('一。\r\n第二行\r\n  二。\r\nThree.\r\n');
    expect(bilingualBytes.toString('utf8')).toBe('One.\r\n一。\r\n第二行\r\n  Two.\r\n  二。\r\nThree.\r\n');
    expect(bilingualBytes.toString('utf8')).toBe(rebuilt(document, 'bilingual'));
    expect(bilingualBytes.toString('utf8')).not.toMatch(/[^\r]\n/);
  });

  it('drops a byte order mark the text would start with', async () => {
    const { document } = await fileDocument('Hello there.\nSecond line.');
    await translate(document, [[0, '\uFEFF你好。']]);
    const result = await exporter().export(document, 'target', 'folder');
    const bytes = await fs.readFile(result.path);
    expect(bytes.subarray(0, 3).equals(BOM)).toBe(false);
    expect(bytes.toString('utf8')).toBe('你好。\nSecond line.');
  });

  it('exports Markdown through rebuild, verbatim blocks byte for byte (AC-LT-17-2)', async () => {
    const S = '# Title\n\nFirst paragraph.\n\n```js\nconst a = 1;\n```\n\n- item one\n';
    const { document } = await fileDocument(S, 'guide.md', { format: 'markdown' });
    const indices = Array.from({ length: document.table.count }, (_, index) => index).filter(index => document.table.flags[index] & SEGMENT_FLAG.translatable);
    await translate(document, indices.map((index, k) => [index, ['标题', '第一段。', '第一项'][k]]));
    const result = await exporter().export(document, 'bilingual', 'source');
    const text = await fs.readFile(result.path, 'utf8');
    expect(result.name).toBe('guide.zh-Hans.bilingual.md');
    expect(text).toBe(rebuilt(document, 'bilingual'));
    expect(text.split('\n')[0]).toBe('# Title / 标题');
    expect(text).toContain('```js\nconst a = 1;\n```');
    expect(result).toMatchObject({ translated: 3, untranslated: 0 });
  });

  it('counts translatable segments without a translation as untranslated (AC-LT-17-3)', async () => {
    const { document } = await fileDocument('A.\nB.\nC.\nD.');
    await translate(document, [[1, '乙。']]);
    await document.edit(2, document.rev(2), '丙。');
    const result = await exporter().export(document, 'target', 'source');
    expect(result).toMatchObject({ translated: 2, untranslated: 2 });
    expect(await fs.readFile(result.path, 'utf8')).toBe('A.\n乙。\n丙。\nD.');
  });

  it('gives up with name_exhausted after (99) and leaves no temporary file', async () => {
    const { document } = await fileDocument('One.');
    const name = { stem: 'novel.zh-Hans', ext: '.txt' };
    for (let number = 1; number <= 99; number++) await fs.writeFile(path.join(input, numberedName(name, number)), `taken ${number}`);
    expect(await errorCode(exporter().export(document, 'target', 'source'))).toBe('name_exhausted');
    expect(await temporaryFiles(input)).toEqual([]);
    expect(await fs.readFile(path.join(input, 'novel.zh-Hans.txt'), 'utf8')).toBe('taken 1');
    expect(document.manifest.exports).toEqual([]);
  });

  it.each(['win32', 'darwin'] as const)('never publishes to the source path, whatever its case (%s)', async platform => {
    // A 120-character base cuts the language off a source named like an export, so the first candidate is the source.
    const long = 'a'.repeat(120);
    const S = 'Only line.';
    const { document, file } = await fileDocument(S, `${long}.ZH-HANS.TXT`);
    await translate(document, [[0, '唯一一行。']]);
    const result = await exporter({ platform }).export(document, 'target', 'source');
    expect(result.name).toBe(`${long}.zh-Hans (2).txt`);
    const targets = vi.mocked(fs.link).mock.calls.map(([, target]) => String(target));
    expect(targets).toEqual([path.join(input, `${long}.zh-Hans (2).txt`)]);
    expect(await fs.readFile(file, 'utf8')).toBe(S);
  });

  it.each(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EISDIR', 'EINVAL'])('creates the file exclusively when link fails with %s', async code => {
    const { document } = await fileDocument('One.');
    await translate(document, [[0, '一。']]);
    await fs.writeFile(path.join(input, 'novel.zh-Hans.txt'), 'existing');
    vi.mocked(fs.link).mockRejectedValueOnce(linkError(code));
    const result = await exporter().export(document, 'target', 'source');
    expect(result.name).toBe('novel.zh-Hans (2).txt');
    expect(fs.link).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(input, 'novel.zh-Hans.txt'), 'utf8')).toBe('existing');
    expect(await fs.readFile(result.path, 'utf8')).toBe('一。');
    expect(await temporaryFiles(input)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('publishes with the default file mode, as an ordinary save', async () => {
    const { document } = await fileDocument('One.');
    const result = await exporter().export(document, 'target', 'source');
    expect((await fs.stat(result.path)).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it.each([
    ['ENOSPC', 'storage_failed'], ['EACCES', 'destination_unavailable'], ['EROFS', 'destination_unavailable'], ['EIO', 'export_failed'],
  ])('maps %s while publishing to %s and removes the temporary file', async (code, expected) => {
    const { document } = await fileDocument('One.');
    vi.mocked(fs.link).mockRejectedValueOnce(linkError(code));
    expect(await errorCode(exporter().export(document, 'target', 'source'))).toBe(expected);
    expect(await temporaryFiles(input)).toEqual([]);
    expect(await fs.readdir(input)).toEqual(['novel.txt']);
    expect(document.manifest.exports).toEqual([]);
  });

  it('refuses a destination folder that no longer exists', async () => {
    const { document } = await fileDocument('One.');
    await fs.rm(input, { recursive: true });
    expect(await errorCode(exporter().export(document, 'target', 'source'))).toBe('destination_unavailable');
    await fs.rm(documentsDir, { recursive: true });
    expect(await errorCode(exporter().export(document, 'target', 'folder'))).toBe('destination_unavailable');
    getPath.mockImplementation(() => {
      throw new Error('no documents folder');
    });
    expect(await errorCode(exporter().export(document, 'target', 'folder'))).toBe('destination_unavailable');
  });

  it('offers pasted text no source folder and exports it to Documents until a folder is chosen (AC-LT-17-4)', async () => {
    const document = await pastedDocument('# Notes\n\nBody.', { format: 'markdown', name: 'Notes: draft?' });
    expect(await errorCode(exporter().export(document, 'target', 'source'))).toBe('invalid_request');
    const result = await exporter().export(document, 'target', 'folder');
    expect(result.path).toBe(path.join(documentsDir, 'Notes- draft-.zh-Hans.md'));
    expect(document.manifest.exportFolder).toBeNull();
  });
});

describe('export folder', () => {
  it('is set only from the native folder dialog, and kept per document (AC-LT-17-4)', async () => {
    const { document } = await fileDocument('One.');
    const window = { isDestroyed: () => false } as unknown as BrowserWindow;
    const chosen = path.join(root, 'Chosen');
    await fs.mkdir(chosen);

    expect(await exporter({ getWindow: () => window }).chooseFolder(document)).toBeNull();
    expect(showOpenDialog).toHaveBeenLastCalledWith(window, { properties: ['openDirectory', 'createDirectory'], defaultPath: documentsDir });
    expect(document.manifest.exportFolder).toBeNull();

    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [chosen] });
    expect(await exporter({ getWindow: () => window }).chooseFolder(document)).toEqual({ path: chosen });
    expect(document.manifest.exportFolder).toBe(chosen);
    const saved = await repository.withDocument(document.id, files => files.readManifest());
    expect('manifest' in saved && saved.manifest.exportFolder).toBe(chosen);

    await exporter().chooseFolder(document);
    expect(showOpenDialog).toHaveBeenLastCalledWith({ properties: ['openDirectory', 'createDirectory'], defaultPath: chosen });

    const result = await exporter().export(document, 'target', 'folder');
    expect(result.path).toBe(path.join(chosen, 'novel.zh-Hans.txt'));
    expect(document.manifest.exportFolder).toBe(chosen);
  });
});

describe('copy', () => {
  it('writes the target-only export text to the clipboard (AC-LT-17-6)', async () => {
    const { document } = await fileDocument('First line.\nSecond line.');
    await translate(document, [[0, '第一行。']]);
    expect(exporter().copy(document, 'target')).toEqual({ characters: '第一行。\nSecond line.'.length });
    const exported = await exporter().export(document, 'target', 'source');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(await fs.readFile(exported.path, 'utf8'));
  });

  it('copies the bilingual text when asked', async () => {
    const { document } = await fileDocument('First line.');
    await translate(document, [[0, '第一行。']]);
    exporter().copy(document, 'bilingual');
    expect(writeText).toHaveBeenCalledWith('First line.\n第一行。');
  });

  it('refuses more than 20,000,000 characters without touching the clipboard', async () => {
    const built = await buildDocument('one\ntwo');
    const table = buildSegmentTable(built.records);
    const fake = (targets: string[]): ExportDocument => {
      const records: TranslationRecord[] = targets.map((target, index) => translated(index, 1, target));
      return { source: built.source, table, manifest: built.manifest, translationAt: index => records[index], updateManifest: async () => undefined };
    };
    expect(thrownCode(() => exporter().copy(fake(['x'.repeat(10_000_000), 'x'.repeat(10_000_000)]), 'target'))).toBe('limit_exceeded');
    expect(writeText).not.toHaveBeenCalled();
    expect(exporter().copy(fake(['x'.repeat(10_000_000), 'x'.repeat(9_999_999)]), 'target')).toEqual({ characters: 20_000_000 });
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe('reveal', () => {
  it('shows the source file, and reports a missing one (AC-LT-17-5)', async () => {
    const { document, file } = await fileDocument('One.');
    expect(await exporter().reveal(document, 'source')).toEqual({});
    expect(showItemInFolder).toHaveBeenCalledWith(file);
    await fs.rm(file);
    expect(await errorCode(exporter().reveal(document, 'source'))).toBe('source_missing');
    expect(showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('shows only the latest export recorded in the manifest (AC-LT-17-5)', async () => {
    const { document } = await fileDocument('One.');
    expect(await errorCode(exporter().reveal(document, 'export'))).toBe('not_found');
    await exporter().export(document, 'target', 'source');
    clock += 1_000;
    const latest = await exporter().export(document, 'bilingual', 'source');
    await exporter().reveal(document, 'export');
    expect(showItemInFolder).toHaveBeenLastCalledWith(latest.path);
    await fs.rm(latest.path);
    expect(await errorCode(exporter().reveal(document, 'export'))).toBe('not_found');
    expect(showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('accepts no other target and has no source for pasted text', async () => {
    const document = await pastedDocument('One.');
    expect(await errorCode(exporter().reveal(document, 'source'))).toBe('invalid_request');
    const { document: imported, file } = await fileDocument('One.');
    expect(await errorCode(exporter().reveal(imported, file as RevealTarget))).toBe('invalid_request');
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
