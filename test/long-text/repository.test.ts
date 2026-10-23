import * as fs from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary, LedgerEntry } from '../../src/long-text/contract';
import { emptyUsage, formatLines, segmentLine, usageLine } from '../../src/long-text/journal';
import type { DocumentManifest } from '../../src/long-text/model';
import { displayAt } from '../../src/long-text/segments';
import {
  compactionSnapshot, FILES, LongTextOperationError, LongTextRepository, manifestSummary,
  type DocumentFile, type StoredDocument,
} from '../../electron/main/long-text/repository';
import { AT, buildDocument, lines, removeRoot, run, RUN_ID, temporaryRoot, translated } from './document-test-utils';

// Renames and truncations pass through unless a test makes them fail.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), truncate: vi.fn(actual.truncate) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const fsError = (code: string) => Object.assign(new Error(code), { code });

const OTHER_RUN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

let root: string;
let clock: number;
let repository: LongTextRepository;

beforeEach(async () => {
  root = await temporaryRoot();
  clock = AT;
  repository = new LongTextRepository(root, { now: () => clock });
  await repository.recover();
});

afterEach(async () => {
  vi.mocked(fs.rename).mockImplementation(actualFs.rename);
  vi.mocked(fs.truncate).mockImplementation(actualFs.truncate);
  await repository.idle();
  repository.dispose();
  await removeRoot(root);
});

const documentsDir = () => path.join(root, 'documents');
const fileOf = (id: string, file: DocumentFile) => path.join(documentsDir(), id, FILES[file]);
const folders = async () => (await fs.readdir(documentsDir())).sort();

async function load(id: string): Promise<StoredDocument> {
  const stored = await repository.withDocument(id, files => files.load());
  if ('unavailable' in stored) throw new Error(`unavailable: ${stored.unavailable}`);
  return stored;
}

async function create(S = lines(3)): Promise<DocumentManifest> {
  const document = await buildDocument(S);
  await repository.createDocument(document);
  return document.manifest;
}

const errorCode = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => (error as LongTextOperationError).code);

describe('creating and loading documents', () => {
  it('writes a document through a staging folder and loads every file back', async () => {
    const S = '# Title\n\nSee [the guide][Guide] and [Guide].\n\n[guide]: https://example.com\n';
    const original = new TextEncoder().encode(S);
    const document = await buildDocument(S, { format: 'markdown', original });
    expect(document.refs.length).toBeGreaterThan(0);
    await repository.createDocument(document);

    expect(await folders()).toEqual([document.manifest.id]);
    const stored = await load(document.manifest.id);
    expect(stored.manifest).toEqual(document.manifest);
    expect(stored.source).toBe(S);
    expect(stored.table.count).toBe(document.records.length);
    expect(stored.pages).toEqual(document.pages);
    expect(stored.refs).toEqual(document.refs);
    expect(stored.replay.records.size).toBe(0);
    expect(stored).toMatchObject({ ledger: [], issues: 0, journal: { bytes: 0, lines: 0 } });
    expect(await repository.withDocument(document.manifest.id, files => files.readOriginal())).toEqual(Buffer.from(original));
  });

  it('refuses an existing id and leaves no staging folder behind', async () => {
    const document = await buildDocument(lines(3));
    await repository.createDocument(document);
    expect(await errorCode(repository.createDocument(document))).toBe('conflict');
    expect(await folders()).toEqual([document.manifest.id]);
  });

  it('rejects ids that are not UUIDs and reports a missing document', async () => {
    expect(await errorCode(repository.withDocument('..', async () => undefined))).toBe('invalid_request');
    expect(await errorCode(repository.withDocument('0f8fad5b-d9cb-469f-a165-70867728950f', files => files.load()))).toBe('not_found');
  });

  it('treats a missing or broken segmentation file as a damaged document', async () => {
    const pagesGone = await create();
    await fs.rm(fileOf(pagesGone.id, 'pages'));
    expect(await repository.withDocument(pagesGone.id, files => files.load())).toEqual({ unavailable: 'damaged', name: pagesGone.name });

    const brokenSegments = await create();
    await fs.writeFile(fileOf(brokenSegments.id, 'segments'), '{"i":0}\n');
    expect(await repository.withDocument(brokenSegments.id, files => files.load())).toMatchObject({ unavailable: 'damaged' });

    const brokenSource = await create();
    await fs.writeFile(fileOf(brokenSource.id, 'source'), Buffer.from([0xff, 0xfe, 0x00]));
    expect(await repository.withDocument(brokenSource.id, files => files.load())).toMatchObject({ unavailable: 'damaged' });
  });

  it('keeps a leading U+FEFF of S, so segment offsets still fit after a reload', async () => {
    // A UTF-8 file with a doubled byte order mark decodes to an S that starts with U+FEFF.
    for (const S of ['\uFEFFFirst line here.\nSecond line here.\nThird line', '\uFEFFFirst line here.\nSecond line here.\nThird line\n']) {
      const document = await buildDocument(S);
      await repository.createDocument(document);
      const stored = await load(document.manifest.id);
      expect(stored.source).toBe(S);
      const displays = Array.from({ length: stored.table.count }, (_, index) => displayAt(stored.source, stored.table, index));
      expect(displays.slice(1, 3)).toEqual(['Second line here.', 'Third line']);
      expect(displays[0]).toContain('First line here.');
    }
  });
});

describe('manifest', () => {
  it('falls back to the previous version and never copies a damaged one over it', async () => {
    const manifest = await create();
    await repository.withDocument(manifest.id, files => files.writeManifest({ ...manifest, name: 'second.txt' }));
    await fs.writeFile(fileOf(manifest.id, 'manifest'), '{"schemaVersion":1,');

    const read = await repository.withDocument(manifest.id, files => files.readManifest());
    expect(read).toMatchObject({ previous: true, manifest: { name: 'novel.txt' } });
    expect((await load(manifest.id)).manifest.name).toBe('novel.txt');

    await repository.withDocument(manifest.id, files => files.writeManifest({ ...manifest, name: 'third.txt' }));
    expect(JSON.parse(await fs.readFile(fileOf(manifest.id, 'previousManifest'), 'utf8')).name).toBe('novel.txt');
    expect((await load(manifest.id)).manifest.name).toBe('third.txt');
    await repository.withDocument(manifest.id, files => files.writeManifest({ ...manifest, name: 'fourth.txt' }));
    expect(JSON.parse(await fs.readFile(fileOf(manifest.id, 'previousManifest'), 'utf8')).name).toBe('third.txt');
  });

  it('reports damaged when both versions are unreadable and newer_version for a newer schema (AC-LT-06-5)', async () => {
    const damaged = await create();
    await fs.writeFile(fileOf(damaged.id, 'manifest'), 'not json');
    await fs.writeFile(fileOf(damaged.id, 'previousManifest'), JSON.stringify({ ...damaged, revision: -1 }));
    expect(await repository.withDocument(damaged.id, files => files.load())).toEqual({ unavailable: 'damaged' });

    const foreign = await create();
    await fs.writeFile(fileOf(foreign.id, 'manifest'), JSON.stringify({ ...foreign, id: damaged.id }));
    expect(await repository.withDocument(foreign.id, files => files.load())).toEqual({ unavailable: 'damaged' });

    const newer = await create();
    await repository.withDocument(newer.id, files => files.writeManifest(newer));
    await fs.writeFile(fileOf(newer.id, 'manifest'), JSON.stringify({ schemaVersion: 2, name: 'Future.md', extra: true }));
    expect(await repository.withDocument(newer.id, files => files.load())).toEqual({ unavailable: 'newer_version', name: 'Future.md' });

    const summaries = new Map((await repository.recover()).map(summary => [summary.id, summary]));
    // Nothing cached and nothing readable: the folder name stands in for the document name.
    expect(summaries.get(damaged.id)).toMatchObject({ unavailable: 'damaged', name: damaged.id, counts: { translatable: 0 } });
    expect(summaries.get(newer.id)).toMatchObject({ unavailable: 'newer_version', name: 'Future.md' });
  });
});

describe('journal', () => {
  it('appends with datasync and cuts a failed append back', async () => {
    const { id } = await create();
    const probe = await fs.open(path.join(root, 'probe'), 'w');
    const handlePrototype = Object.getPrototypeOf(probe) as fs.FileHandle;
    await probe.close();
    try {
      const datasync = vi.spyOn(handlePrototype, 'datasync');
      const first = formatLines([segmentLine(1, translated(0, 1, '甲'))]);
      await repository.withDocument(id, files => files.appendJournal(first, 0));
      expect(datasync).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(fileOf(id, 'journal'), 'utf8')).toBe(first);

      const appendFile = handlePrototype.appendFile;
      vi.spyOn(handlePrototype, 'appendFile').mockImplementationOnce(async function (this: fs.FileHandle) {
        await appendFile.call(this, '{"q":2,"t":"s","i":1');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });
      const second = formatLines([segmentLine(2, translated(1, 1, '乙'))]);
      expect(await errorCode(repository.withDocument(id, files => files.appendJournal(second, Buffer.byteLength(first))))).toBe('storage_failed');
      expect(await fs.readFile(fileOf(id, 'journal'), 'utf8')).toBe(first);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('cuts a torn last line off the file and counts lines it cannot use', async () => {
    const { id } = await create();
    const good = formatLines([segmentLine(1, translated(0, 1, '甲')), segmentLine(2, translated(1, 1, '乙')), segmentLine(3, translated(99, 1, '无'))]);
    const kept = `${good}not a journal line\n`;
    await fs.writeFile(fileOf(id, 'journal'), `${kept}{"q":4,"t":"s","i":2`);

    const stored = await load(id);
    expect([...stored.replay.records.keys()].sort()).toEqual([0, 1]);
    expect(stored.issues).toBe(2);
    expect(stored.journal).toEqual({ bytes: Buffer.byteLength(kept), lines: 4 });
    expect(await fs.readFile(fileOf(id, 'journal'), 'utf8')).toBe(kept);
    expect(stored.replay.lastSeq).toBe(3);
  });

  it('compacts in two steps, and a crash between them replays the same state', async () => {
    const manifest = await create();
    await repository.withDocument(manifest.id, files => files.writeManifest({ ...manifest, runs: [run({ status: 'completed' })] }));
    const usage = { ...emptyUsage(), inputTokens: 120, outputTokens: 80, requests: 1 };
    const journal = formatLines([
      segmentLine(1, translated(0, 1, '甲')), segmentLine(2, translated(1, 1, '乙')), usageLine(3, { runId: RUN_ID, usage }),
      segmentLine(4, translated(1, 2, '乙二')), usageLine(5, { runId: OTHER_RUN, usage }),
    ]);
    await fs.writeFile(fileOf(manifest.id, 'journal'), journal);
    const before = await load(manifest.id);

    const { replay } = before;
    const snapshot = compactionSnapshot({ seq: replay.lastSeq, records: replay.records.values(), usage: replay.usage, runUsage: replay.runUsage }, before.manifest.runs);
    expect([...snapshot.runUsage.keys()]).toEqual([RUN_ID]);
    await repository.withDocument(manifest.id, files => files.compact(snapshot));
    expect(await fs.readFile(fileOf(manifest.id, 'journal'), 'utf8')).toBe('');

    const after = await load(manifest.id);
    expect(after.replay.records).toEqual(replay.records);
    expect(after.replay.usage).toEqual(replay.usage);
    expect(after.replay.lastSeq).toBe(5);

    // A crash after the snapshot rename but before the journal was emptied.
    await fs.writeFile(fileOf(manifest.id, 'journal'), journal);
    const crashed = await load(manifest.id);
    expect(crashed.replay.records).toEqual(replay.records);
    expect(crashed.replay.usage).toEqual(replay.usage);
    expect(crashed.replay.usage.inputTokens).toBe(240);
    expect(crashed.issues).toBe(0);
  });

  it('compacts at load once the journal is over 20,000 lines', async () => {
    const { id } = await create();
    const usage = { ...emptyUsage(), inputTokens: 1, requests: 1 };
    await fs.writeFile(fileOf(id, 'journal'), formatLines(Array.from({ length: 20_001 }, (_, k) => usageLine(k + 1, { runId: null, usage }))));

    const stored = await load(id);
    expect(stored.journal).toEqual({ bytes: 0, lines: 0 });
    expect(stored.replay.usage.requests).toBe(20_001);
    expect(await fs.readFile(fileOf(id, 'journal'), 'utf8')).toBe('');
    expect((await load(id)).replay.usage.requests).toBe(20_001);
  });

  it('writes the snapshot as lines and leaves out only the records it cannot read, keeping a copy', async () => {
    const { id } = await create();
    const usage = { ...emptyUsage(), requests: 3 };
    const state = { seq: 3, records: [translated(0, 1, '甲'), translated(1, 1, '乙'), translated(2, 1, '丙')], usage, runUsage: new Map() };
    await repository.withDocument(id, files => files.compact(state));
    const written = (await fs.readFile(fileOf(id, 'snapshot'), 'utf8')).split('\n');
    expect(written).toHaveLength(5);
    expect(JSON.parse(written[0])).toEqual({ version: 1, seq: 3, usage, runUsage: {} });
    expect((await load(id)).replay.records.size).toBe(3);

    // A record of a newer build (an unknown flag) and a repeated record.
    const damaged = [written[0], written[1], written[2].replace('"f":[]', '"f":[["future_flag",0]]'), written[3], written[1], ''].join('\n');
    await fs.writeFile(fileOf(id, 'snapshot'), damaged);
    const stored = await load(id);
    expect([...stored.replay.records.keys()].sort()).toEqual([0, 2]);
    expect(stored.issues).toBe(2);
    expect(stored.replay).toMatchObject({ lastSeq: 3, usage });
    const copies = (await fs.readdir(path.join(documentsDir(), id))).filter(name => name.startsWith('journal.snapshot.damaged-'));
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(documentsDir(), id, copies[0]), 'utf8')).toBe(damaged);
  });

  it('cuts a failed append back before the next one when the first cut failed, and appends nothing while it fails', async () => {
    const { id } = await create();
    const probe = await fs.open(path.join(root, 'probe'), 'w');
    const handlePrototype = Object.getPrototypeOf(probe) as fs.FileHandle;
    await probe.close();
    const first = formatLines([segmentLine(1, translated(0, 1, '甲'))]);
    const size = Buffer.byteLength(first);
    const append = (text: string) => errorCode(repository.withDocument(id, files => files.appendJournal(text, size)));
    try {
      await repository.withDocument(id, files => files.appendJournal(first, 0));
      const appendFile = handlePrototype.appendFile;
      vi.spyOn(handlePrototype, 'appendFile').mockImplementationOnce(async function (this: fs.FileHandle) {
        await appendFile.call(this, '{"q":2,"t":"s","i":1');
        throw fsError('ENOSPC');
      });
      vi.mocked(fs.truncate).mockRejectedValueOnce(fsError('EPERM')).mockRejectedValueOnce(fsError('EPERM'));
      expect(await append(formatLines([segmentLine(2, translated(1, 1, '乙'))]))).toBe('storage_failed');
      expect(await append(formatLines([segmentLine(3, translated(1, 1, '乙'))]))).toBe('storage_failed');
      expect(await fs.readFile(fileOf(id, 'journal'), 'utf8')).toBe(`${first}{"q":2,"t":"s","i":1`);

      const next = formatLines([segmentLine(4, translated(1, 1, '乙'))]);
      expect(await append(next)).toBe('resolved');
      expect(await fs.readFile(fileOf(id, 'journal'), 'utf8')).toBe(first + next);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('ledger', () => {
  it('reads an absent ledger as empty and a damaged one as null, counted at load', async () => {
    const { id } = await create();
    expect(await repository.withDocument(id, files => files.readLedger())).toEqual([]);
    const entries: LedgerEntry[] = [{ id: RUN_ID, source: 'Alice', target: '爱丽丝', origin: 'model', confirmed: false, firstSeen: 0, updatedAt: AT }];
    await repository.withDocument(id, files => files.writeLedger(entries));
    expect(await repository.withDocument(id, files => files.readLedger())).toEqual(entries);

    await fs.writeFile(fileOf(id, 'ledger'), '{"version":1,"entries":[{}]}');
    expect(await repository.withDocument(id, files => files.readLedger())).toBeNull();
    expect(await load(id)).toMatchObject({ ledger: [], issues: 1 });

    // A copy is kept before any save could replace it, once however often the document is loaded.
    await load(id);
    const copies = (await fs.readdir(path.join(documentsDir(), id))).filter(name => name.startsWith('ledger.damaged-'));
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(documentsDir(), id, copies[0]), 'utf8')).toBe('{"version":1,"entries":[{}]}');
  });
});

describe('startup', () => {
  it('deletes trash and incomplete staging folders and finishes an interrupted rename', async () => {
    const existing = await create();
    const pending = await buildDocument(lines(2));
    await repository.createDocument(pending);
    // Complete staging folders: one whose final rename never happened, one whose document already exists.
    await fs.rename(path.join(documentsDir(), pending.manifest.id), path.join(documentsDir(), '.staging-complete'));
    await fs.cp(path.join(documentsDir(), existing.id), path.join(documentsDir(), '.staging-existing'), { recursive: true });
    await fs.mkdir(path.join(documentsDir(), '.staging-partial'));
    await fs.writeFile(path.join(documentsDir(), '.staging-partial', FILES.source), 'half');
    await fs.mkdir(path.join(documentsDir(), '.trash-old'));
    await fs.writeFile(path.join(documentsDir(), '.trash-old', FILES.journal), 'x');

    const summaries = await repository.recover();
    expect(await folders()).toEqual([existing.id, pending.manifest.id].sort());
    expect(summaries.map(summary => summary.id).sort()).toEqual([existing.id, pending.manifest.id].sort());
    expect((await load(pending.manifest.id)).source).toBe(lines(2));
  });

  it('deletes an import that never finished, even a complete one, instead of restoring it', async () => {
    const document = await buildDocument(lines(2));
    await repository.createDocument(document);
    await fs.rename(path.join(documentsDir(), document.manifest.id), path.join(documentsDir(), '.import-x'));
    expect(await repository.recover()).toEqual([]);
    expect(await folders()).toEqual([]);
  });

  it('rebuilds stale, damaged or missing index entries and marks runs left running as interrupted', async () => {
    const a = await create();
    const b = await create();
    expect((await repository.recover()).map(summary => summary.id).sort()).toEqual([a.id, b.id].sort());
    const indexFile = path.join(root, 'index.json');
    const index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as { version: 1; documents: DocumentSummary[] };
    expect(index.documents).toHaveLength(2);

    // A newer manifest wins over its cached entry; a running run becomes interrupted on disk too.
    await repository.withDocument(a.id, files => files.writeManifest({ ...a, name: 'renamed.txt', runs: [run()] }));
    const cachedB = index.documents.find(summary => summary.id === b.id)!;
    await fs.writeFile(indexFile, JSON.stringify({ version: 1, documents: [index.documents.find(summary => summary.id === a.id), { ...cachedB, journalIssues: 3 }] }));
    const past = new Date(AT - 60_000);
    await fs.utimes(fileOf(a.id, 'manifest'), past, new Date(AT));
    await fs.utimes(fileOf(b.id, 'manifest'), past, past);
    await fs.utimes(indexFile, past, new Date(AT - 30_000));

    let summaries = new Map((await repository.recover()).map(summary => [summary.id, summary]));
    expect(summaries.get(a.id)).toMatchObject({ name: 'renamed.txt', run: { status: 'interrupted' } });
    expect((await load(a.id)).manifest.runs[0].status).toBe('interrupted');
    expect(summaries.get(b.id)?.journalIssues).toBe(3);

    await fs.writeFile(indexFile, '{');
    summaries = new Map((await repository.recover()).map(summary => [summary.id, summary]));
    expect(summaries.get(b.id)).toEqual(manifestSummary(b));

    await repository.remove(b.id);
    expect((await repository.recover()).map(summary => summary.id)).toEqual([a.id]);
    expect((JSON.parse(await fs.readFile(indexFile, 'utf8')) as typeof index).documents.map(summary => summary.id)).toEqual([a.id]);
  });

  it('writes a scheduled index on flush and drops it on dispose', async () => {
    const manifest = await create();
    const indexFile = path.join(root, 'index.json');
    await fs.rm(indexFile, { force: true });
    repository.scheduleIndex(() => [manifestSummary(manifest)]);
    repository.dispose();
    await repository.flushIndex();
    await expect(fs.access(indexFile)).rejects.toThrow();

    repository.scheduleIndex(() => [manifestSummary({ ...manifest, name: 'later.txt' })]);
    await repository.flushIndex();
    expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).documents[0].name).toBe('later.txt');
  });
});

describe('removal, replacement and storage', () => {
  it('sums the files of every document, caches for 10 s, and follows imports and deletions (AC-LT-06-2)', async () => {
    expect(await repository.storageBytes()).toBe(0);
    const { id } = await create();
    const files = await fs.readdir(path.join(documentsDir(), id));
    const sizes = await Promise.all(files.map(name => fs.stat(path.join(documentsDir(), id, name)).then(stat => stat.size)));
    const imported = sizes.reduce((sum, size) => sum + size, 0);
    expect(await repository.storageBytes()).toBe(imported);

    await repository.withDocument(id, files => files.appendJournal('x'.repeat(100) + '\n', 0));
    expect(await repository.storageBytes()).toBe(imported);
    clock += 10_000;
    expect(await repository.storageBytes()).toBe(imported + 101);

    await repository.remove(id);
    expect(await repository.storageBytes()).toBe(0);
  });

  it('removes a document by renaming it to trash first', async () => {
    const { id } = await create();
    await repository.remove(id);
    expect((await folders()).filter(name => !name.startsWith('.trash-'))).toEqual([]);
    await repository.idle();
    expect(await folders()).toEqual([]);
    await expect(repository.remove(id)).resolves.toBeUndefined();
  });

  it('replaces the segmentation, keeping the original bytes and the ledger and starting a new journal', async () => {
    const original = new TextEncoder().encode('one\ntwo');
    const document = await buildDocument('one\ntwo', { original });
    const { id } = document.manifest;
    await repository.createDocument(document);
    const entries: LedgerEntry[] = [{ id: RUN_ID, source: 'one', target: '一', origin: 'user', confirmed: true, firstSeen: null, updatedAt: AT }];
    await repository.withDocument(id, files => files.writeLedger(entries));
    await repository.withDocument(id, files => files.appendJournal(formatLines([segmentLine(1, translated(0, 1, '一'))]), 0));

    const next = await buildDocument('one two', { id });
    await repository.replaceDocument(id, { ...next, manifest: { ...next.manifest, revision: 4 } });
    await repository.idle();

    const stored = await load(id);
    expect(stored.source).toBe('one two');
    expect(stored.manifest.revision).toBe(4);
    expect(stored.replay.records.size).toBe(0);
    expect(stored.ledger).toEqual(entries);
    expect(await repository.withDocument(id, files => files.readOriginal())).toEqual(Buffer.from(original));
    expect(await folders()).toEqual([id]);
    expect(await errorCode(repository.replaceDocument(RUN_ID, next))).toBe('invalid_request');
  });

  it('keeps the new folder for recovery when neither the swap nor its rollback can be renamed', async () => {
    const document = await buildDocument('one\ntwo');
    const { id } = document.manifest;
    await repository.createDocument(document);
    // Windows refuses to rename a folder while another process holds a file in it.
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (/^\.(staging|trash)-/.test(path.basename(String(from)))) throw fsError('EPERM');
      return actualFs.rename(from, to);
    });
    const next = await buildDocument('one two', { id });
    expect(await errorCode(repository.replaceDocument(id, next))).toBe('storage_failed');
    expect(await folders()).not.toContain(id);
    expect((await folders()).filter(name => name.startsWith('.staging-'))).toHaveLength(1);

    // A startup that still cannot rename it keeps it: it is the only copy left.
    const blocked = new LongTextRepository(root);
    expect(await blocked.recover()).toEqual([]);
    expect((await folders()).filter(name => name.startsWith('.staging-'))).toHaveLength(1);
    blocked.dispose();

    vi.mocked(fs.rename).mockImplementation(actualFs.rename);
    const restarted = new LongTextRepository(root);
    expect((await restarted.recover()).map(summary => summary.id)).toEqual([id]);
    const stored = await restarted.withDocument(id, files => files.load());
    expect('source' in stored && stored.source).toBe('one two');
    await restarted.idle();
    restarted.dispose();
  });
});

describe('performance (§6.10)', () => {
  async function blocking<T>(task: () => Promise<T>): Promise<{ value: T; maxDelayMs: number }> {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    try {
      return { value: await task(), maxDelayMs: histogram.max / 1e6 };
    } finally {
      histogram.disable();
    }
  }

  it('compacts and loads 200,000 translations without blocking the event loop for 250 ms', async () => {
    const document = await buildDocument(lines(200_000));
    await repository.createDocument(document);
    const { id } = document.manifest;
    const records = Array.from({ length: 200_000 }, (_, index) => translated(index, 1, `故事的第${index}行，被缓慢而仔细地讲述。`));
    const compacted = await blocking(() => repository.withDocument(id, files => files.compact({ seq: 200_000, records, usage: emptyUsage(), runUsage: new Map() })));
    expect(compacted.maxDelayMs).toBeLessThan(250);
    const loaded = await blocking(() => load(id));
    expect(loaded.maxDelayMs).toBeLessThan(250);
    expect(loaded.value.replay.records.size).toBe(200_000);
    expect(loaded.value.replay.records.get(199_999)?.target).toBe('故事的第199999行，被缓慢而仔细地讲述。');
  });
});
