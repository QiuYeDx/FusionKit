import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeEventSchema, type LongTextChangeEvent } from '../../src/long-text/channels';
import type { ImportDefaults, LongTextRequest, LongTextSettings } from '../../src/long-text/contract';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { LoadedDocument } from '../../electron/main/long-text/document-state';
import { LongTextRepository, type NewDocument } from '../../electron/main/long-text/repository';
import { LongTextService, type LongTextServiceOptions } from '../../electron/main/long-text/service';
import { buildDocument, lines, removeRoot, run, temporaryRoot } from './document-test-utils';
import { API_KEY, MODEL, modelError } from './runner-test-utils';

const DEFAULTS: ImportDefaults = {
  targetLanguage: 'zh-Hans', style: null, instructions: '', profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
  knowledgeCollectionIds: [],
};

/** A model that translates every item as `【译】` + its text; `hold` keeps requests waiting until `release` or an abort. */
function fakeModel() {
  let held = false;
  const waiting = new Set<() => void>();
  const model = {
    requests: [] as ModelRuntimeTextRequest[],
    /** Called with each request aborted while held. */
    onAbort: null as ((request: ModelRuntimeTextRequest) => void) | null,
    hold() {
      held = true;
    },
    release() {
      held = false;
      for (const go of [...waiting]) go();
    },
    send: async (request: ModelRuntimeTextRequest): Promise<ModelRuntimeTextResult> => {
      model.requests.push(request);
      if (held) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            waiting.delete(go);
            model.onAbort?.(request);
            reject(modelError('aborted'));
          };
          const go = () => {
            waiting.delete(go);
            request.signal?.removeEventListener('abort', abort);
            resolve();
          };
          if (request.signal?.aborted) return abort();
          request.signal?.addEventListener('abort', abort, { once: true });
          waiting.add(go);
        });
      }
      const payload = JSON.parse(request.messages[1].content) as { items: Array<{ id: string; text: string }> };
      return {
        content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `【译】${item.text}` })), terms: [] }),
        finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 40 }, apiFormat: 'chat_completions',
      };
    },
  };
  return model;
}

let root: string;
let services: LongTextService[];

beforeEach(async () => {
  root = await temporaryRoot();
  services = [];
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const service of services) {
    service.dispose();
    await service.idle();
  }
  await removeRoot(root);
});

type Selection = { canceled: boolean; filePaths: string[] };

async function createService(options: Partial<Pick<LongTextServiceOptions, 'send' | 'clipboard'>> & { select?: () => Selection } = {}) {
  const events: LongTextChangeEvent[] = [];
  const repository = new LongTextRepository(path.join(root, 'long-text'));
  const showOpenDialog = vi.fn(async (..._args: unknown[]) => options.select?.() ?? { canceled: true, filePaths: [] });
  const service = new LongTextService({
    repository,
    readKnowledge: () => { throw new Error('No library in this test'); },
    send: options.send ?? fakeModel().send,
    emit: event => events.push(event),
    dialog: { showOpenDialog } as unknown as LongTextServiceOptions['dialog'],
    clipboard: options.clipboard ?? { writeText: vi.fn() },
    shell: { showItemInFolder: vi.fn() },
    paths: { getPath: () => root },
  });
  services.push(service);
  await service.ready();
  return { service, repository, events, showOpenDialog };
}

/** Writes documents before the service starts, as a previous session would have left them. */
async function seed(...documents: NewDocument[]): Promise<void> {
  const repository = new LongTextRepository(path.join(root, 'long-text'));
  await repository.recover();
  for (const document of documents) await repository.createDocument(document);
  await repository.idle();
}

const documentDir = (id: string) => path.join(root, 'long-text', 'documents', id);

async function paste(service: LongTextService, text = lines(30), format: 'txt' | 'markdown' = 'txt'): Promise<string> {
  return (await service.importText({ text, format, defaults: DEFAULTS })).id;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const start = (documentId: string, extra: Partial<LongTextRequest<'start'>> = {}): LongTextRequest<'start'> =>
  ({ documentId, kind: 'full', model: MODEL, apiKey: API_KEY, ...extra });

async function runStatus(service: LongTextService, documentId: string) {
  return (await service.read({ documentId })).run?.status;
}

async function settings(service: LongTextService, documentId: string, change: Partial<LongTextSettings>) {
  const detail = await service.read({ documentId });
  return { documentId, expectedRevision: detail.revision, settings: { ...detail.settings, ...change } };
}

describe('LongTextService', () => {
  it('refuses clearing, from-here runs, a language change and resegmenting while a run is active', async () => {
    const model = fakeModel();
    const { service, events } = await createService({ send: model.send });
    const id = await paste(service);
    model.hold();
    await service.start(start(id));
    await waitFor(() => model.requests.length > 0);

    await expect(service.clear({ documentId: id, keepLocked: false })).rejects.toMatchObject({ code: 'busy' });
    await expect(service.start(start(id, { kind: 'from', fromIndex: 3 }))).rejects.toMatchObject({ code: 'busy' });
    await expect(service.start(start(id))).rejects.toMatchObject({ code: 'busy' });
    await expect(service.updateSettings({ ...(await settings(service, id, { targetLanguage: 'ja' })), clearTranslations: true }))
      .rejects.toMatchObject({ code: 'busy' });
    await expect(service.resegment({ documentId: id, txtSplit: 'unwrap', discardTranslations: true })).rejects.toMatchObject({ code: 'busy' });
    // Settings other than the languages may change during a run.
    const paced = await service.updateSettings({ ...(await settings(service, id, { pace: 4 })), clearTranslations: false });
    expect(paced.settings.pace).toBe(4);

    expect(await service.pause({ documentId: id, immediate: true })).toEqual({ status: 'paused' });
    await waitFor(async () => (await runStatus(service, id)) === 'paused');
    expect(await service.clear({ documentId: id, keepLocked: false })).toEqual({ changed: 0 });
    for (const event of events) expect(changeEventSchema.safeParse(event).success).toBe(true);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it('saves settings only at the expected revision and gives materials the document languages', async () => {
    const { service } = await createService();
    const id = await paste(service);
    const request = await settings(service, id, { style: 'literary', instructions: 'Keep it short.' });
    await expect(service.updateSettings({ ...request, expectedRevision: request.expectedRevision + 1, clearTranslations: false }))
      .rejects.toMatchObject({ code: 'conflict' });
    const saved = await service.updateSettings({ ...request, clearTranslations: false });
    expect(saved.revision).toBe(request.expectedRevision + 1);
    expect(saved.settings).toMatchObject({ style: 'literary', instructions: 'Keep it short.' });
    await expect(service.updateSettings({ ...request, clearTranslations: false })).rejects.toMatchObject({ code: 'conflict' });

    const collectionId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const withMaterials = await service.updateSettings({
      ...(await settings(service, id, { knowledge: { version: 2, languagePair: { source: 'ja', target: 'ko' }, collectionIds: [collectionId], disabledEntryIds: [] } })),
      clearTranslations: false,
    });
    expect(withMaterials.settings.knowledge).toMatchObject({ languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [collectionId] });
    const noCollections = await service.updateSettings({
      ...(await settings(service, id, { knowledge: { version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [], disabledEntryIds: [] } })),
      clearTranslations: false,
    });
    expect(noCollections.settings.knowledge).toBeNull();
    await expect(service.updateSettings({ ...(await settings(service, id, { targetLanguage: 'en' })), clearTranslations: false }))
      .rejects.toMatchObject({ code: 'same_language' });
  });

  it('clears every translation, locked ones too, when the languages change', async () => {
    const { service } = await createService();
    const id = await paste(service);
    const edited = await service.edit({ documentId: id, index: 0, rev: 0, text: '第一行' });
    expect(edited).toMatchObject({ status: 'done', origin: 'user', locked: true });
    const change = await settings(service, id, { targetLanguage: 'ja' });
    await expect(service.updateSettings({ ...change, clearTranslations: false })).rejects.toMatchObject({ code: 'translations_exist' });
    const detail = await service.updateSettings({ ...change, clearTranslations: true });
    expect(detail.languages.target).toBe('ja');
    expect(detail.counts).toMatchObject({ done: 0, locked: 0, pending: detail.counts.translatable });
    expect((await service.readPage({ documentId: id, page: 0 })).rows[0]).toMatchObject({ target: null, status: 'pending', canUndo: true });
  });

  it('blocks runs until a low-confidence encoding is confirmed and previews other encodings', async () => {
    const original = new TextEncoder().encode(lines(12));
    const document = await buildDocument(lines(12));
    document.manifest.source = { kind: 'file', path: path.join(root, 'legacy.txt'), size: original.length, mtimeMs: 0, sha256: 'a'.repeat(64) };
    document.manifest.encoding = { name: 'windows-1252', confidence: 'low', confirmed: false, lineEnding: '\n' };
    await seed({ ...document, original });
    const model = fakeModel();
    const { service } = await createService({ send: model.send });
    const id = document.manifest.id;

    await expect(service.start(start(id))).rejects.toMatchObject({ code: 'encoding_unconfirmed' });
    expect(model.requests).toHaveLength(0);
    expect(await service.previewEncoding({ documentId: id, encoding: 'utf-8' }))
      .toEqual({ lines: Array.from({ length: 8 }, (_, k) => `Line number ${k} of the story.`), replacementChars: 0 });
    const confirmed = await service.confirmEncoding({ documentId: id });
    expect(confirmed.encoding).toEqual({ name: 'windows-1252', confidence: 'low', confirmed: true });
    await service.start(start(id));
    await waitFor(async () => (await runStatus(service, id)) === 'completed');
    expect((await service.read({ documentId: id })).counts.done).toBe(12);
  });

  it('keeps a document with a run loaded while other documents come and go (three at most)', async () => {
    const model = fakeModel();
    const { service } = await createService({ send: model.send });
    const [a, b, c, d] = [await paste(service), await paste(service, lines(5)), await paste(service, lines(6)), await paste(service, lines(7))];
    const opens = vi.spyOn(LoadedDocument, 'open');
    model.hold();
    await service.start(start(a));
    await waitFor(() => model.requests.length > 0);
    for (const id of [b, c, d]) await service.read({ documentId: id });
    await service.readPage({ documentId: a, page: 0 });
    await service.read({ documentId: b });
    const openedFor = (id: string) => opens.mock.calls.filter(call => call[1] === id).length;
    expect(openedFor(a)).toBe(1);
    // b was the least recently used document without a run, so it was unloaded and opened again.
    expect(openedFor(b)).toBe(2);
    model.release();
    await waitFor(async () => (await runStatus(service, a)) === 'completed');
    expect((await service.readPage({ documentId: a, page: 0 })).rows.every(row => row.status === 'done')).toBe(true);
    expect(openedFor(a)).toBe(1);
  });

  it('stops the run before deleting a document and leaves its source file alone', async () => {
    const model = fakeModel();
    const { service, events } = await createService({ send: model.send });
    const input = path.join(root, 'input');
    await fs.mkdir(input);
    const file = path.join(input, 'novel.txt');
    await fs.writeFile(file, lines(20));
    const imported = await service.importFiles({ paths: [file], source: 'picker', defaults: DEFAULTS });
    const id = imported.documents[0].id;
    let folderAtAbort: boolean | null = null;
    model.onAbort = () => { folderAtAbort ??= existsSync(documentDir(id)); };
    model.hold();
    await service.start(start(id));
    await waitFor(() => model.requests.length > 0);

    expect(await service.remove({ documentId: id })).toEqual({});
    expect(folderAtAbort).toBe(true);
    expect(model.requests[0].signal?.aborted).toBe(true);
    expect(existsSync(documentDir(id))).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect((await service.list()).documents).toEqual([]);
    expect(events.filter(event => event.documentId === id).map(event => event.kind)).toContain('deleted');
    await expect(service.read({ documentId: id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.remove({ documentId: id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists the documents as the storage walk leaves them, so a change sent during it is not rolled back', async () => {
    const { service, repository } = await createService();
    const id = await paste(service);
    const walk = repository.storageBytes.bind(repository);
    vi.spyOn(repository, 'storageBytes').mockImplementation(async () => {
      await service.rename({ documentId: id, name: 'renamed during the walk' });
      return walk();
    });
    expect((await service.list()).documents.find(summary => summary.id === id)?.name).toBe('renamed during the walk');
  });

  it('marks runs left running by a previous session as interrupted at startup', async () => {
    const document = await buildDocument(lines(10));
    document.manifest.runs = [run({ status: 'running' })];
    document.manifest.fullRunStarted = true;
    await seed(document);
    const { service } = await createService();
    const id = document.manifest.id;
    expect((await service.list()).documents[0].run?.status).toBe('interrupted');
    const manifest = JSON.parse(await fs.readFile(path.join(documentDir(id), 'manifest.json'), 'utf8'));
    expect(manifest.runs[0].status).toBe('interrupted');
    expect(await runStatus(service, id)).toBe('interrupted');
  });

  it('merges segment events of a document over 120 ms and sends other events at once', async () => {
    const { service, events } = await createService();
    const id = await paste(service);
    const before = events.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await service.edit({ documentId: id, index: 0, rev: 0, text: '第一行' });
    await service.edit({ documentId: id, index: 3, rev: 0, text: '第四行' });
    expect(events.slice(before).filter(event => event.kind === 'segments')).toHaveLength(0);
    await service.rename({ documentId: id, name: 'Renamed' });
    expect(events.slice(before).map(event => event.kind)).toEqual(['list']);

    vi.advanceTimersByTime(120);
    const added = events.slice(before);
    expect(added.map(event => event.kind)).toEqual(['list', 'segments']);
    const segments = added[1];
    expect(segments).toMatchObject({ documentId: id, range: { start: 0, end: 3 }, pages: [0] });
    expect(segments.summary).toMatchObject({ name: 'Renamed', counts: { edited: 2 } });
    expect(segments.sequence).toBeGreaterThan(added[0].sequence);
    for (const event of added) expect(changeEventSchema.safeParse(event).success).toBe(true);
  });

  it('flags markup a Markdown edit dropped', async () => {
    const { service } = await createService();
    const id = await paste(service, 'See [the guide](https://example.com/guide) before you start.\n', 'markdown');
    const row = await service.edit({ documentId: id, index: 0, rev: 0, text: '开始之前请先阅读指南。' });
    expect(row).toMatchObject({ origin: 'user', locked: true, flags: [{ code: 'markup_missing', detail: { items: ['](https://example.com/guide)'] } }] });
    const kept = await service.edit({ documentId: id, index: 0, rev: row.rev, text: '开始之前请先阅读[指南](https://example.com/guide)。' });
    expect(kept.flags).toEqual([]);
  });

  it('retranslates one segment and keeps the previous version for undo', async () => {
    const model = fakeModel();
    const { service } = await createService({ send: model.send });
    const id = await paste(service, lines(3));
    const row = await service.retranslate({ documentId: id, index: 1, rev: 0, instruction: '更口语', model: MODEL, apiKey: API_KEY });
    expect(row).toMatchObject({ status: 'done', origin: 'model', locked: false, target: '【译】Line number 1 of the story.', canUndo: true });
    expect(JSON.parse(model.requests[0].messages[1].content).revision).toEqual({ request: '更口语' });
    expect(await service.undo({ documentId: id, index: 1, rev: row.rev })).toMatchObject({ status: 'pending', target: null });
  });

  it('resegments only after translations may be discarded, under a new revision', async () => {
    const { service, events } = await createService();
    const id = await paste(service, lines(10));
    const before = await service.read({ documentId: id });
    expect(before.structure).toMatchObject({ resolved: 'line' });
    await service.edit({ documentId: id, index: 0, rev: 0, text: '第一行' });
    // The edit's segments event goes out on its own timer; wait for it so the slice below holds only the resegment's events.
    await vi.waitFor(() => expect(events.some(event => event.documentId === id && event.kind === 'segments')).toBe(true));
    await expect(service.resegment({ documentId: id, txtSplit: 'unwrap', discardTranslations: false })).rejects.toMatchObject({ code: 'translations_exist' });
    await expect(service.resegment({ documentId: id, encoding: 'gb18030', discardTranslations: true })).rejects.toMatchObject({ code: 'invalid_request' });
    const count = events.length;
    const after = await service.resegment({ documentId: id, txtSplit: 'unwrap', discardTranslations: true });
    expect(after).toMatchObject({ revision: before.revision + 1, structure: { txtSplit: 'unwrap', resolved: 'unwrap' }, counts: { done: 0 } });
    expect(after.stats.translatable).toBeLessThan(before.stats.translatable);
    expect(events.slice(count).filter(event => event.documentId === id).map(event => event.kind)).toEqual(['document', 'list']);
    expect((await service.readPage({ documentId: id, page: 0 })).revision).toBe(after.revision);
  });

  it('never sends segment ranges of the old segmentation after resegmenting', async () => {
    const { service, events } = await createService();
    const id = await paste(service, lines(10));
    await service.edit({ documentId: id, index: 0, rev: 0, text: '第一行' });
    await service.resegment({ documentId: id, txtSplit: 'unwrap', discardTranslations: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    const mine = events.filter(event => event.documentId === id).map(event => event.kind);
    expect(mine.slice(mine.lastIndexOf('document'))).toEqual(['document', 'list']);
  });

  it('pauses idempotently and reports unknown and damaged documents', async () => {
    const damaged = await buildDocument(lines(4), { name: 'broken.txt' });
    await seed(damaged);
    await fs.writeFile(path.join(documentDir(damaged.manifest.id), 'manifest.json'), '{');
    const { service } = await createService();
    const id = await paste(service);
    expect(await service.pause({ documentId: id, immediate: false })).toEqual({ status: 'paused' });
    const unknown = '0f8fad5b-d9cb-469f-a165-70867728950f';
    await expect(service.pause({ documentId: unknown, immediate: false })).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.readPage({ documentId: unknown, page: 0 })).rejects.toMatchObject({ code: 'not_found' });

    const listed = (await service.list()).documents.find(summary => summary.id === damaged.manifest.id);
    expect(listed?.unavailable).toBe('damaged');
    await expect(service.read({ documentId: damaged.manifest.id })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await service.remove({ documentId: damaged.manifest.id })).toEqual({});
    expect(existsSync(documentDir(damaged.manifest.id))).toBe(false);
  });

  it('drops a leading BOM of pasted text so the document opens again after a restart', async () => {
    const { service } = await createService();
    const id = await paste(service, `﻿${lines(5)}`);
    service.dispose();
    await service.idle();
    const { service: restarted } = await createService();
    const detail = await restarted.read({ documentId: id });
    expect(detail.unavailable).toBeUndefined();
    expect((await restarted.readPage({ documentId: id, page: 0 })).rows[0].source).toBe('Line number 0 of the story.');
  });

  it('aborts runs before quitting; the next start reports them interrupted', async () => {
    const model = fakeModel();
    const { service } = await createService({ send: model.send });
    const id = await paste(service);
    model.hold();
    await service.start(start(id));
    await waitFor(() => model.requests.length > 0);
    service.dispose();
    expect(model.requests[0].signal?.aborted).toBe(true);
    await service.idle();
    const { service: restarted } = await createService();
    expect(await runStatus(restarted, id)).toBe('interrupted');
    // AC-LT-10-4: the key never reaches the disk.
    const entries = await fs.readdir(path.join(root, 'long-text'), { recursive: true, withFileTypes: true });
    const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect((await fs.readFile(file, 'utf8')).includes(API_KEY)).toBe(false);
  });

  it('exports, copies and records the export folder through the exporter', async () => {
    const writeText = vi.fn();
    const out = path.join(root, 'out');
    const { service, events } = await createService({ clipboard: { writeText }, select: () => ({ canceled: false, filePaths: [out] }) });
    const input = path.join(root, 'input');
    await fs.mkdir(input);
    await fs.mkdir(out);
    const file = path.join(input, 'novel.txt');
    await fs.writeFile(file, lines(3));
    const id = (await service.importFiles({ paths: [file], source: 'drop', defaults: DEFAULTS })).documents[0].id;
    await service.edit({ documentId: id, index: 0, rev: 0, text: '第一行' });
    const count = events.length;
    const exported = await service.export({ documentId: id, mode: 'target', destination: 'source' });
    expect(exported).toMatchObject({ name: 'novel.zh-Hans.txt', translated: 1, untranslated: 2 });
    expect(await fs.readFile(exported.path, 'utf8')).toBe(`第一行\n${lines(3).split('\n').slice(1).join('\n')}`);
    expect(events.slice(count).map(event => event.kind)).toEqual(['document']);
    expect((await service.read({ documentId: id })).lastExport).toMatchObject({ name: 'novel.zh-Hans.txt' });
    expect(await service.copy({ documentId: id, mode: 'target' })).toEqual({ characters: writeText.mock.calls[0][0].length });

    expect(await service.chooseExportFolder({ documentId: id })).toEqual({ path: out });
    expect((await service.read({ documentId: id })).exportFolder).toBe(out);
    const bilingual = await service.export({ documentId: id, mode: 'bilingual', destination: 'folder' });
    expect(bilingual.path).toBe(path.join(out, 'novel.zh-Hans.bilingual.txt'));
  });

  it('imports what the file dialog returns: nothing when cancelled, at most 50 files', async () => {
    let selection: Selection = { canceled: true, filePaths: [] };
    const { service, showOpenDialog } = await createService({ select: () => selection });
    const request = { filterName: '文本与 Markdown', defaults: DEFAULTS };
    expect(await service.pickFiles(request)).toEqual({ documents: [], duplicates: [], skipped: [] });
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile', 'multiSelections'], filters: [{ name: '文本与 Markdown', extensions: ['txt', 'md', 'markdown'] }],
    });

    const input = path.join(root, 'input');
    await fs.mkdir(input);
    const files = Array.from({ length: 52 }, (_, k) => path.join(input, `part-${k}.txt`));
    await fs.writeFile(files[0], lines(3));
    selection = { canceled: false, filePaths: files };
    const result = await service.pickFiles(request);
    expect(result.documents.map(summary => summary.name)).toEqual(['part-0.txt']);
    expect(result.skipped.filter(skip => skip.reason === 'file_unreadable')).toHaveLength(49);
    expect(result.skipped.filter(skip => skip.reason === 'limit_exceeded').map(skip => skip.name)).toEqual(['part-50.txt', 'part-51.txt']);
  });

  it('records the sample and the start of full runs; clearing starts over', async () => {
    const { service } = await createService();
    const id = await paste(service, lines(40));
    await service.start(start(id, { kind: 'sample' }));
    await waitFor(async () => (await runStatus(service, id)) === 'completed');
    const sampled = await service.read({ documentId: id });
    expect(sampled.fullRunStarted).toBe(false);
    expect(sampled.sample).toEqual({ indices: Array.from({ length: 12 }, (_, k) => k), stale: false });
    expect(sampled.counts.done).toBe(12);

    const restyled = await service.updateSettings({ ...(await settings(service, id, { style: 'literary' })), clearTranslations: false });
    expect(restyled.sample?.stale).toBe(true);
    await service.setLocked({ documentId: id, index: 0, rev: 1, locked: true });
    await service.start(start(id, { kind: 'sample', resample: true }));
    await waitFor(async () => (await runStatus(service, id)) === 'completed');
    const resampled = await service.read({ documentId: id });
    expect(resampled.sample).toEqual({ indices: Array.from({ length: 11 }, (_, k) => k + 1), stale: false });
    expect((await service.readPage({ documentId: id, page: 0 })).rows[0]).toMatchObject({ locked: true, rev: 2 });

    await service.start(start(id));
    expect((await service.read({ documentId: id })).fullRunStarted).toBe(true);
    await waitFor(async () => (await runStatus(service, id)) === 'completed');
    expect(await service.clear({ documentId: id, keepLocked: true })).toEqual({ changed: 39 });
    const cleared = await service.read({ documentId: id });
    expect(cleared).toMatchObject({ fullRunStarted: false, sample: null, counts: { done: 1, locked: 1 } });
  });
});
