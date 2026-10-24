import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry, RunView } from '../../src/long-text/contract';
import { emptyUsage } from '../../src/long-text/journal';
import type { Flag, TranslationRecord } from '../../src/long-text/model';
import {
  LoadedDocument, needsAttention, settingsDigest, type LoadedDocumentOptions, type RatioModel,
} from '../../electron/main/long-text/document-state';
import { DocumentFiles, FILES, LongTextRepository, runRecordView, type NewDocument } from '../../electron/main/long-text/repository';
import { AT, buildDocument, lines, removeRoot, run, RUN_ID, temporaryRoot, translated } from './document-test-utils';

const MARKUP: Flag = { code: 'markup_missing', dismissed: false, detail: { items: ['https://example.com'] } };
const SHORT: Flag = { code: 'length_short', dismissed: false, detail: { ratio: 0.31 } };

let root: string;
let clock: number;
let repository: LongTextRepository;
let opened: LoadedDocument[];
let ratio: { model: RatioModel; created: number; pushed: number[] };

beforeEach(async () => {
  root = await temporaryRoot();
  clock = AT;
  repository = new LongTextRepository(root);
  await repository.recover();
  opened = [];
  ratio = {
    created: 0,
    pushed: [],
    model: {
      create: () => {
        ratio.created++;
        ratio.pushed = [];
        return { value: 1, push: value => ratio.pushed.push(value) };
      },
      sample: (document, index) => (document.translationAt(index)?.target?.length ?? 0) / 10,
    },
  };
});

afterEach(async () => {
  vi.useRealTimers();
  for (const document of opened) await document.close();
  await repository.idle();
  repository.dispose();
  await removeRoot(root);
});

async function open(id: string, options: Partial<LoadedDocumentOptions> = {}): Promise<LoadedDocument> {
  const document = await LoadedDocument.open(repository, id, { ratio: ratio.model, now: () => clock, ...options });
  if ('unavailable' in document) throw new Error(`unavailable: ${document.unavailable}`);
  opened.push(document);
  return document;
}

/** Closes the document and loads it again from disk. */
async function reopen(document: LoadedDocument): Promise<LoadedDocument> {
  await document.close();
  opened.splice(opened.indexOf(document), 1);
  return open(document.id);
}

async function create(S = lines(130), options: Parameters<typeof buildDocument>[1] = {}): Promise<NewDocument> {
  const document = await buildDocument(S, options);
  await repository.createDocument(document);
  return document;
}

/** 130 one-line segments on three pages: 0–59, 60–119, 120–129. */
async function novel(S = lines(130)): Promise<LoadedDocument> {
  return open((await create(S)).manifest.id);
}

const errorCode = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => (error as { code: string }).code);
const indices = (rows: ReadonlyArray<{ index: number }>) => rows.map(row => row.index);
const failed = (index: number): TranslationRecord => ({ ...translated(index, 1, ''), status: 'failed', target: null, origin: null, failure: { code: 'protocol_invalid' } });

describe('pages and rows', () => {
  it('reads every row of a page and shows segments in flight as translating', async () => {
    const document = await novel();
    expect(document.pages.map(page => [page.start, page.end])).toEqual([[0, 59], [60, 119], [120, 129]]);

    const page = document.readPage(1);
    expect(page).toMatchObject({ documentId: document.id, revision: 0, page: { index: 1, start: 60, end: 119, translatable: 60, done: 0, attention: 0, inFlight: false } });
    expect(page.rows).toHaveLength(60);
    expect(page.rows[0]).toEqual({
      index: 60, ordinal: 61, page: 1, rev: 0, kind: 'line', level: 0, marker: '', translatable: true,
      source: 'Line number 60 of the story.', target: null, status: 'pending', origin: null, locked: false, flags: [], failure: null, canUndo: false,
    });

    expect(document.markInFlight([60, 61])).toBe(true);
    expect(document.markInFlight([61, 62])).toBe(false);
    const busy = document.readPage(1);
    expect(busy.rows.slice(0, 3).map(row => row.status)).toEqual(['translating', 'translating', 'pending']);
    expect(busy.page.inFlight).toBe(true);
    document.releaseInFlight([60, 61]);
    expect(document.readPage(1).page.inFlight).toBe(false);
    expect(document.readPage(1).rows[0].status).toBe('pending');
    expect(() => document.readPage(3)).toThrow('invalid_request');
  });

  it('cuts verbatim rows to 2,000 characters', async () => {
    const block = Array.from({ length: 60 }, (_, k) => `const value${k} = ${'x'.repeat(40)};`).join('\n');
    const { manifest } = await create(`# Code\n\n\`\`\`js\n${block}\n\`\`\`\n`, { format: 'markdown' });
    const document = await open(manifest.id);
    const code = document.readPage(0).rows.find(row => row.kind === 'verbatim')!;
    expect(code).toMatchObject({ verbatimKind: 'code', translatable: false, ordinal: 0 });
    expect(code.source).toHaveLength(2_000);
    expect(document.query({ kind: 'search', text: 'value1' }, 0, 10).total).toBe(0);
  });
});

describe('commits', () => {
  it('writes records whose rev follows, skips locked ones when asked, and sums usage', async () => {
    const document = await novel();
    const usage = { ...emptyUsage(), inputTokens: 100, outputTokens: 60, requests: 1 };
    const written = await document.commit([translated(0, 1, '甲'), translated(1, 1, '乙'), translated(2, 2, '丙'), translated(0, 1, '重复')], { runId: RUN_ID, usage }, { skipLocked: true });
    expect(written).toEqual([0, 1]);
    expect(document.rev(0)).toBe(1);
    expect(document.translationAt(0)?.target).toBe('甲');
    expect(document.summary().counts).toMatchObject({ translatable: 130, done: 2, pending: 128 });
    expect(document.pageInfo(0).done).toBe(2);

    await document.setLocked(1, 1, true);
    expect(await document.commit([translated(1, 3, 'X')], null, { skipLocked: true })).toEqual([]);
    expect(await document.commit([translated(1, 3, 'X')], null, { skipLocked: false })).toEqual([1]);

    await document.updateManifest(manifest => { manifest.runs = [run({ status: 'completed' })]; }, { immediate: true });
    expect(document.summary()).toMatchObject({ usage, run: { id: RUN_ID, status: 'completed', usage } });

    const again = await reopen(document);
    expect(again.summary().counts).toEqual(document.summary().counts);
    expect(again.summary().usage).toEqual(usage);
    expect(again.summary().run?.usage).toEqual(usage);
    expect(again.readPage(0).rows.slice(0, 2)).toEqual(document.readPage(0).rows.slice(0, 2));
  });

  it('changes nothing when a commit cannot be written', async () => {
    const document = await novel();
    const broken = { ...translated(3, 1, 'x'), target: null };
    await expect(document.commit([broken], null, { skipLocked: false })).rejects.toThrow();
    expect(document.translationAt(3)).toBeUndefined();
    expect(document.summary().counts.done).toBe(0);

    expect(await document.commit([translated(3, 1, '好')], null, { skipLocked: false })).toEqual([3]);
    expect((await reopen(document)).translationAt(3)?.target).toBe('好');
  });
});

describe('single-segment commands', () => {
  it('edits, dismisses, unlocks and undoes, one rev at a time', async () => {
    const document = await novel();
    const edited = await document.edit(5, 0, '  手动译文\r\n第二行 ', [MARKUP]);
    expect(edited).toMatchObject({ rev: 1, status: 'done', target: '手动译文\n第二行', origin: 'user', locked: true, canUndo: true, flags: [{ code: 'markup_missing' }] });
    expect(document.summary().counts).toMatchObject({ edited: 1, locked: 1, attention: 1 });

    expect(await document.dismissFlag(5, 1, 'markup_missing')).toMatchObject({ rev: 2, flags: [], canUndo: true });
    expect(document.summary().counts.attention).toBe(0);
    expect(await document.dismissFlag(5, 2, 'markup_missing')).toMatchObject({ rev: 2 });
    expect(await document.setLocked(5, 2, false)).toMatchObject({ rev: 3, locked: false });
    expect(await document.undo(5, 3)).toMatchObject({ rev: 4, status: 'pending', target: null, canUndo: false });
    expect(await document.edit(5, 4, '   ')).toMatchObject({ rev: 4, status: 'pending' });

    await document.edit(6, 0, '用户');
    expect(await document.edit(6, 1, '')).toMatchObject({ rev: 2, status: 'pending', canUndo: true });
    expect(await document.undo(6, 2)).toMatchObject({ rev: 3, target: '用户', locked: true });
    expect(document.summary().counts).toMatchObject({ done: 1, edited: 1, locked: 1 });
  });

  it('refuses stale revs, segments in flight, and segments that cannot take the command', async () => {
    const document = await novel();
    await document.edit(5, 0, '译文');
    expect(await errorCode(document.edit(5, 0, 'x'))).toBe('revision_conflict');
    document.markInFlight([5]);
    expect(await errorCode(document.edit(5, 1, 'x'))).toBe('busy');
    expect(await errorCode(document.undo(5, 1))).toBe('busy');
    document.releaseInFlight([5]);
    expect(await errorCode(document.setLocked(7, 0, true))).toBe('invalid_request');
    expect(await errorCode(document.edit(999, 0, 'x'))).toBe('invalid_request');
  });

  it('clears for a run without touching locked or in-flight segments; the clear command may include locked ones', async () => {
    const document = await novel();
    await document.commit([0, 1, 2, 3, 4].map(index => translated(index, 1, `译${index}`)), null, { skipLocked: false });
    await document.setLocked(1, 1, true);
    document.markInFlight([2]);
    expect(await document.clear([0, 1, 2, 3, 7, 3], RUN_ID)).toEqual([0, 3]);
    expect(document.readPage(0).rows[0]).toMatchObject({ status: 'pending', canUndo: true, rev: 2 });
    expect(document.translationAt(0)?.runId).toBe(RUN_ID);
    expect(await document.undo(0, 2)).toMatchObject({ target: '译0', status: 'done' });

    document.releaseInFlight([2]);
    expect(await document.clearAll(true)).toEqual([0, 2, 4]);
    expect(await document.clearAll(false)).toEqual([1]);
    expect(document.summary().counts).toMatchObject({ done: 0, locked: 0, pending: 130 });
  });
});

describe('attention, filters and search', () => {
  it('counts failed, flagged unlocked, and locked markup_missing segments as attention (AC-LT-16-4)', async () => {
    const document = await novel();
    await document.commit([
      failed(10),
      translated(11, 1, '短', { flags: [SHORT] }),
      translated(12, 1, '锁', { flags: [SHORT], locked: true }),
      translated(13, 1, '缺', { flags: [MARKUP], locked: true, origin: 'user' }),
      translated(14, 1, '略', { flags: [{ ...SHORT, dismissed: true }] }),
      translated(15, 1, '好'),
    ], null, { skipLocked: false });

    expect(document.summary().counts).toEqual({ translatable: 130, done: 5, pending: 124, failed: 1, attention: 3, edited: 1, locked: 2 });
    expect(document.pageInfo(0).attention).toBe(3);
    expect(indices(document.query({ kind: 'attention' }, 0, 100).rows)).toEqual([10, 11, 13]);
    expect(document.query({ kind: 'untranslated' }, 0, 100)).toMatchObject({ total: 125, truncated: false });
    expect(indices(document.query({ kind: 'edited' }, 0, 100).rows)).toEqual([13]);
    expect(document.readPage(0).rows[12].flags).toEqual([{ code: 'length_short', detail: { ratio: 0.31 } }]);
    expect(document.readPage(0).rows[14].flags).toEqual([]);
    expect(needsAttention(document.translationAt(12))).toBe(false);
  });

  it('locates the next and previous attention segment, wrapping at either end', async () => {
    const document = await novel();
    expect(document.locate(0, 'next')).toBeNull();
    await document.commit([failed(10), translated(70, 1, '短', { flags: [SHORT] }), translated(125, 1, '锁', { flags: [SHORT], locked: true })], null, { skipLocked: false });

    expect(document.locate(0, 'next')).toEqual({ index: 10, page: 0, wrapped: false });
    expect(document.locate(10, 'next')).toEqual({ index: 70, page: 1, wrapped: false });
    expect(document.locate(70, 'next')).toEqual({ index: 10, page: 0, wrapped: true });
    expect(document.locate(10, 'previous')).toEqual({ index: 70, page: 1, wrapped: true });
    expect(document.locate(129, 'previous')).toEqual({ index: 70, page: 1, wrapped: false });
    expect(() => document.locate(130, 'next')).toThrow('invalid_request');
  });

  it('searches display sources and targets after NFKC and lower-casing (AC-LT-16-7)', async () => {
    const document = await novel(lines(130, index => (index === 7 ? 'ＡＬＩＣＥ met the queen.' : `Line number ${index} of the story.`)));
    await document.commit([translated(65, 1, '爱丽丝遇见了 Alice。')], null, { skipLocked: false });

    const found = document.query({ kind: 'search', text: 'alice' }, 0, 100);
    expect(found).toMatchObject({ total: 2, offset: 0, truncated: false });
    expect(found.rows.map(row => [row.index, row.page])).toEqual([[7, 0], [65, 1]]);
    expect(document.query({ kind: 'search', text: 'Ａｌｉｃｅ' }, 0, 100).total).toBe(2);
    expect(indices(document.query({ kind: 'search', text: 'line NUMBER' }, 2, 3).rows)).toEqual([2, 3, 4]);

    await document.commit([translated(65, 2, '无关')], null, { skipLocked: false });
    expect(indices(document.query({ kind: 'search', text: 'alice' }, 0, 100).rows)).toEqual([7]);
  });

  it('stops a search at 5,000 results', async () => {
    const document = await novel(lines(5_100));
    const result = document.query({ kind: 'search', text: 'story' }, 4_950, 100);
    expect(result).toMatchObject({ total: 5_000, offset: 4_950, truncated: true });
    expect(result.rows).toHaveLength(50);
    expect(result.rows.at(-1)?.index).toBe(4_999);
  });
});

describe('runs', () => {
  it('offers the candidates of a page and the pages that have any', async () => {
    const document = await novel();
    await document.commit([translated(0, 1, '甲'), failed(3)], null, { skipLocked: false });
    document.markInFlight([1]);

    expect(document.candidates(0, {}).slice(0, 3)).toEqual([2, 3, 4]);
    expect(document.candidates(0, { minIndex: 55 })).toEqual([55, 56, 57, 58, 59]);
    expect(document.candidates(0, { sample: new Set([0, 1, 3, 4]) })).toEqual([3, 4]);
    expect(document.candidates(0, { sample: new Set([3, 4]), skip: index => index === 3 })).toEqual([4]);
    expect(document.candidates(5, {})).toEqual([]);

    expect(document.pagesWithCandidates({})).toEqual([0, 1, 2]);
    expect(document.pagesWithCandidates({ minIndex: 120 })).toEqual([2]);
    expect(document.pagesWithCandidates({ sample: new Set([1]) })).toEqual([]);
    expect(document.pagesWithCandidates({ sample: new Set([1, 70]) })).toEqual([1]);
  });

  it('marks runs left running as interrupted on open; resuming skips done and locked segments (AC-LT-10-3)', async () => {
    const document = await novel();
    await document.updateManifest(manifest => { manifest.runs = [run()]; manifest.fullRunStarted = true; }, { immediate: true });
    await document.commit([translated(0, 1, '甲'), translated(1, 1, '乙')], { runId: RUN_ID, usage: { ...emptyUsage(), requests: 1 } }, { skipLocked: true });
    await document.setLocked(1, 1, true);
    await document.close();
    opened.splice(opened.indexOf(document), 1);
    // The app quit in the middle of the next append.
    await fs.appendFile(path.join(repository.documentDir(document.id), FILES.journal), '{"q":9,"t":"s","i":2,"v":1');

    const resumed = await open(document.id);
    expect(resumed.summary().run).toMatchObject({ id: RUN_ID, status: 'interrupted', inFlight: 0 });
    expect(resumed.manifest.runs[0].status).toBe('interrupted');
    const onDisk = JSON.parse(await fs.readFile(path.join(repository.documentDir(document.id), FILES.manifest), 'utf8'));
    expect(onDisk.runs[0].status).toBe('interrupted');
    expect(resumed.journalIssues).toBe(0);
    expect(resumed.candidates(0, {}).slice(0, 2)).toEqual([2, 3]);
    expect(resumed.summary().counts).toMatchObject({ done: 2, locked: 1 });
  });

  it('after a failed compaction, compacts again only once the journal has grown by another full limit', async () => {
    const document = await novel(lines(20_100));
    // E.g. journal.log held open elsewhere without share-delete: every attempt would rewrite the whole snapshot.
    const compact = vi.spyOn(DocumentFiles.prototype, 'compact').mockRejectedValue(new Error('journal.log is held open'));
    try {
      await document.commit(Array.from({ length: 20_001 }, (_, index) => translated(index, 1, `译${index}`)), null, { skipLocked: false });
      expect(compact).toHaveBeenCalledTimes(1);
      for (let index = 20_001; index < 20_011; index++) await document.commit([translated(index, 1, `译${index}`)], null, { skipLocked: false });
      expect(compact).toHaveBeenCalledTimes(1);
      await document.commit(Array.from({ length: 20_000 }, (_, index) => translated(index, 2, `再译${index}`)), null, { skipLocked: false });
      expect(compact).toHaveBeenCalledTimes(2);
    } finally {
      compact.mockRestore();
    }
    // Nothing was lost: the journal still holds every line.
    const again = await reopen(document);
    expect(again.summary().counts.done).toBe(20_011);
    expect(again.translationAt(0)?.target).toBe('再译0');
  });

  it('compacts the journal past 20,000 lines and keeps numbering after it', async () => {
    const document = await novel(lines(20_100));
    const records = Array.from({ length: 20_100 }, (_, index) => translated(index, 1, `译${index}`));
    expect(await document.commit(records, null, { skipLocked: false })).toHaveLength(20_100);
    const dir = repository.documentDir(document.id);
    expect(await fs.readFile(path.join(dir, FILES.journal), 'utf8')).toBe('');
    await expect(fs.access(path.join(dir, FILES.snapshot))).resolves.toBeUndefined();

    await document.commit([translated(0, 2, '新')], null, { skipLocked: false });
    const again = await reopen(document);
    expect(again.summary().counts.done).toBe(20_100);
    expect(again.translationAt(0)?.target).toBe('新');
    expect(again.translationAt(20_099)?.target).toBe('译20099');
  });
});

describe('summary, detail and manifest', () => {
  it('summarizes with effective languages, the latest or active run, the sample state and the ledger', async () => {
    const document = await novel();
    expect(document.summary()).toMatchObject({
      name: 'novel.txt', languages: { source: 'en', target: 'zh-Hans', sourceIsAuto: true }, run: null, journalIssues: 0,
    });
    expect(document.summary()).not.toHaveProperty('unavailable');

    await document.updateManifest(manifest => {
      manifest.runs = [run({ status: 'paused', id: 'older', startedAt: AT - 1 }), run({ status: 'paused' })];
      manifest.sample = { indices: [0, 1], settingsDigest: settingsDigest(manifest), at: AT };
    }, { immediate: true });
    expect(document.manifest.runs.map(item => item.id)).toEqual([RUN_ID, 'older']);
    expect(document.detail().sample).toEqual({ indices: [0, 1], stale: false });
    expect(document.summary().run).toEqual(runRecordView(run({ status: 'paused' }), 2, emptyUsage()));

    const live: RunView = { ...runRecordView(run(), 2, emptyUsage()), inFlight: 3, effectiveLanes: 2 };
    document.attachRun(() => live);
    expect(document.summary().run).toBe(live);
    document.attachRun(null);

    await document.updateManifest(manifest => { manifest.settings.style = 'literary'; }, { bump: true, immediate: true });
    const detail = document.detail();
    expect(detail).toMatchObject({ revision: 1, style: 'literary', sample: { stale: true }, structure: { txtSplit: 'line', resolved: 'line' }, exportFolder: null });
    expect(detail.pages).toHaveLength(3);
    expect(detail.pages[2]).toEqual({ index: 2, start: 120, end: 129, title: null, translatable: 10, done: 0, attention: 0, inFlight: false });

    const entry: LedgerEntry = { id: RUN_ID, source: 'Alice', target: '爱丽丝', origin: 'user', confirmed: true, firstSeen: null, updatedAt: AT };
    document.ledger.push(entry, { ...entry, id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', source: 'Bob', confirmed: false });
    expect(document.detail().ledger).toEqual({ total: 2, confirmed: 1 });
    await document.saveLedger();
    expect((await reopen(document)).ledger).toHaveLength(2);
  });

  it('digests the effective settings', async () => {
    const { manifest } = await buildDocument('Hello world.');
    const explicit = { ...manifest, settings: { ...manifest.settings, sourceLanguage: 'en' as const } };
    expect(settingsDigest(explicit)).toBe(settingsDigest(manifest));
    expect(settingsDigest({ ...manifest, settings: { ...manifest.settings, pace: 4 } })).toBe(settingsDigest(manifest));
    expect(settingsDigest({ ...manifest, settings: { ...manifest.settings, instructions: 'Formal.' } })).not.toBe(settingsDigest(manifest));
  });

  it('saves manifest changes after 2 s, at once when immediate, and on close; refuses invalid ones', async () => {
    const document = await novel();
    const file = path.join(repository.documentDir(document.id), FILES.manifest);
    const onDisk = async () => JSON.parse(await fs.readFile(file, 'utf8'));
    await document.commit([translated(0, 1, '甲')], null, { skipLocked: false });
    await document.close();
    expect((await onDisk()).counts.done).toBe(1);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    clock += 5;
    await document.updateManifest(manifest => { manifest.name = 'renamed.txt'; });
    expect((await onDisk()).name).toBe('novel.txt');
    vi.advanceTimersByTime(1_999);
    await repository.idle();
    expect((await onDisk()).name).toBe('novel.txt');
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await repository.idle();
    expect(await onDisk()).toMatchObject({ name: 'renamed.txt', updatedAt: AT + 5, counts: { done: 1 } });

    await document.updateManifest(manifest => { manifest.exportFolder = 'C:\\out'; });
    await document.close();
    expect((await onDisk()).exportFolder).toBe('C:\\out');

    expect(await errorCode(document.updateManifest(manifest => { manifest.name = ''; }))).toBe('internal');
    expect(document.manifest.name).toBe('renamed.txt');
  });

  it('changes nothing when an immediate save fails, unless the change is best effort', async () => {
    const document = await novel();
    const file = path.join(repository.documentDir(document.id), FILES.manifest);
    // A folder where the temporary manifest goes makes every manifest write fail.
    await fs.mkdir(`${file}.tmp`);
    const { revision } = document.manifest;
    expect(await errorCode(document.updateManifest(manifest => { manifest.settings.style = 'literary'; }, { bump: true, immediate: true }))).toBe('storage_failed');
    expect(document.manifest).toMatchObject({ revision, settings: { style: 'general' } });
    expect(await errorCode(document.updateManifest(manifest => { manifest.name = 'kept.txt'; }, { immediate: true, keepOnFailure: true }))).toBe('storage_failed');
    expect(document.manifest.name).toBe('kept.txt');

    await fs.rm(`${file}.tmp`, { recursive: true });
    await document.commit([translated(0, 1, '甲')], null, { skipLocked: false });
    await document.close();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ name: 'kept.txt', revision, settings: { style: 'general' } });
  });

  it('rebuilds the length-ratio reference from the latest model translations, oldest first', async () => {
    const { manifest } = await create();
    let document = await open(manifest.id);
    await document.commit([
      translated(0, 1, '1234567890', { at: AT + 3 }),
      translated(1, 1, '12345', { at: AT + 1 }),
      translated(2, 1, '12', { at: AT + 2 }),
    ], null, { skipLocked: false });
    await document.edit(3, 0, '用户的译文不计入');
    document = await reopen(document);
    expect(ratio.pushed).toEqual([0.5, 0.2, 1]);

    const created = ratio.created;
    await document.updateManifest(next => { next.settings.style = 'technical'; });
    expect(ratio.created).toBe(created);
    await document.updateManifest(next => { next.settings.targetLanguage = 'ja'; });
    expect(ratio.created).toBe(created + 1);
    expect(document.ratio.value).toBe(1);
  });

  it('hands emitted ranges to the listener', async () => {
    const onSegments = vi.fn();
    const { manifest } = await create();
    const document = await open(manifest.id, { onSegments });
    document.emit({ start: 3, end: 9 });
    expect(onSegments).toHaveBeenCalledWith({ start: 3, end: 9 });
  });
});
