import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planTranslation } from '../../electron/main/subtitle-studio/translation-planner';
import { checkpointForPlan } from '../../electron/main/subtitle-studio/translation-recovery';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';

const adapter = vi.hoisted(() => ({ handlers: new Map<string, Function>(), listeners: new Map<string, Function>(), directory: '', open: vi.fn(), save: vi.fn(), reveal: vi.fn(), openFolder: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => adapter.directory, getAppPath: () => process.cwd() },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: adapter.open, showSaveDialog: adapter.save },
  shell: { showItemInFolder: adapter.reveal, openPath: adapter.openFolder },
  ipcMain: { on: (channel: string, handler: Function) => adapter.listeners.set(channel, handler), handle: (channel: string, handler: Function) => adapter.handlers.set(channel, handler), removeAllListeners: (channel: string) => adapter.listeners.delete(channel), removeHandler: (channel: string) => adapter.handlers.delete(channel) },
}));
import { registerSubtitleStudio } from '../../electron/main/subtitle-studio';

let registration: ReturnType<typeof registerSubtitleStudio> | undefined;
let sequence = 0;
const rendererUrl = pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href;
function sender(url = rendererUrl) {
  return Object.assign(new EventEmitter(), { id: ++sequence, mainFrame: { url }, isDestroyed: () => false, send: vi.fn() });
}
function attach(client = sender()) {
  registration!.attach(client as never);
  const event = { sender: client, senderFrame: client.mainFrame, returnValue: null as unknown };
  adapter.listeners.get(STUDIO_CHANNELS.register)!(event, {});
  return { client, capability: event.returnValue, invoke: (method: string, payload: unknown, overrides = {}) => adapter.handlers.get(method)!({ sender: client, senderFrame: client.mainFrame, ...overrides }, { capability: event.returnValue, payload }) };
}
async function setup(content = '[00:01.00]<script>window.injected=true</script>\n') {
  adapter.directory = await mkdtemp(path.join(tmpdir(), 'studio-ipc-'));
  const source = path.join(adapter.directory, 'sample.lrc');
  await writeFile(source, content);
  adapter.open.mockResolvedValue({ canceled: false, filePaths: [source] });
  registration = registerSubtitleStudio();
  const owner = attach();
  const imported = await owner.invoke(STUDIO_CHANNELS.importSubtitle, { encoding: 'utf-8' });
  expect(imported.ok).toBe(true);
  return { owner, doc: imported.value, request: { documentId: imported.value.id, revision: imported.value.revision } };
}
afterEach(async () => {
  await registration?.dispose(); registration = undefined;
  if (adapter.directory) await rm(adapter.directory, { recursive: true, force: true });
  adapter.open.mockReset(); adapter.save.mockReset(); adapter.reveal.mockReset(); adapter.openFolder.mockReset();
});

describe('production Subtitle Studio IPC handler composition', () => {
  it('reveals a bound source folder without granting path or cross-owner authority', async () => {
    const { owner, doc } = await setup();
    adapter.openFolder.mockResolvedValue('');
    const payload = { kind: 'document', id: doc.id };
    expect(await owner.invoke(STUDIO_CHANNELS.revealSource, payload)).toEqual({ ok: true, value: null });
    expect(adapter.openFolder).toHaveBeenCalledWith(await realpath(adapter.directory));
    adapter.openFolder.mockClear();
    expect(await attach().invoke(STUDIO_CHANNELS.revealSource, payload)).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.revealSource, { ...payload, path: adapter.directory })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.revealSource, payload, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
    await writeFile(path.join(adapter.directory, 'sample.lrc'), 'replaced input');
    expect(await owner.invoke(STUDIO_CHANNELS.revealSource, payload)).toEqual({ ok: false, error: 'output_write_failed' });
    expect(adapter.openFolder).not.toHaveBeenCalled();
  });

  it('imports native dropped files with per-file results and rejects other frames and forged payload fields', async () => {
    const parent = path.resolve('test-results'); await mkdir(parent, { recursive: true });
    adapter.directory = await mkdtemp(path.join(parent, 'studio-drop-ipc-'));
    const first = path.join(adapter.directory, 'one.vtt'); const second = path.join(adapter.directory, 'two.lrc');
    const unsupported = path.join(adapter.directory, 'notes.txt'); const folder = path.join(adapter.directory, 'folder');
    await writeFile(first, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n'); await writeFile(second, '[00:01]Two\n');
    await writeFile(unsupported, 'not subtitles'); await mkdir(folder);
    registration = registerSubtitleStudio(); const owner = attach();
    const input = { encoding: 'utf-8', paths: [first, second, unsupported, folder] };
    expect(await owner.invoke(STUDIO_CHANNELS.importDroppedSubtitles, input, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.importDroppedSubtitles, { ...input, source: 'picker' })).toEqual({ ok: false, error: 'invalid_input' });
    const imported = await owner.invoke(STUDIO_CHANNELS.importDroppedSubtitles, input);
    expect(imported).toMatchObject({ ok: true, value: { items: [{ ok: true, document: { origin: { format: 'vtt' } } }, { ok: true }, { ok: false, error: 'unsupported_feature' }, { ok: false, error: 'invalid_input' }] } });
    expect(adapter.open).not.toHaveBeenCalled();
    const summary = imported.value.items[0].document;
    expect(await owner.invoke(STUDIO_CHANNELS.getSourceLocation, { documentId: summary.id })).toEqual({ ok: true, value: { status: 'ready', origin: 'input' } });
    expect(JSON.stringify(imported)).not.toContain(adapter.directory);
    expect(await readFile(first, 'utf8')).toContain('WEBVTT');
  });

  it('exports beside the persisted source without a picker and fences source rebinding against old plans', async () => {
    const { owner, request } = await setup('[00:01]Preserve input\n');
    const other = attach();
    expect(await other.invoke(STUDIO_CHANNELS.getSourceLocation, { documentId: request.documentId })).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.selectSourceDirectory, { documentId: request.documentId, path: 'C:\\forged' })).toEqual({ ok: false, error: 'invalid_input' });
    const options: ExportOptions = { mode: 'source', format: 'lrc', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' } };
    const planned = await owner.invoke(STUDIO_CHANNELS.planExport, { ...request, options });
    expect(planned).toMatchObject({ ok: true, value: { fileName: 'sample.lrc', sourceLocation: { status: 'ready', origin: 'input' } } });
    const openCount = adapter.open.mock.calls.length;
    const exported = await owner.invoke(STUDIO_CHANNELS.exportDocument, { ...request, planId: planned.value.planId, acceptedLosses: [], destination: 'source-directory' });
    expect(exported).toMatchObject({ ok: true, value: { fileName: 'sample (1).lrc' } });
    expect(adapter.open).toHaveBeenCalledTimes(openCount); expect(adapter.save).not.toHaveBeenCalled();
    expect(await readFile(path.join(adapter.directory, 'sample.lrc'), 'utf8')).toBe('[00:01]Preserve input\n');
    expect(await owner.invoke(STUDIO_CHANNELS.exportSource, { ...request, destination: 'source-directory' })).toMatchObject({ ok: true, value: { fileName: 'sample (2).lrc' } });
    expect(await readFile(path.join(adapter.directory, 'sample (2).lrc'), 'utf8')).toBe('[00:01]Preserve input\n');
    const next = await owner.invoke(STUDIO_CHANNELS.planExport, { ...request, options });
    const replacement = path.join(adapter.directory, 'chosen'); await mkdir(replacement);
    adapter.open.mockResolvedValueOnce({ canceled: false, filePaths: [replacement] });
    expect(await owner.invoke(STUDIO_CHANNELS.selectSourceDirectory, { documentId: request.documentId })).toMatchObject({ ok: true, value: { status: 'ready', origin: 'user-selected-directory' } });
    expect(await owner.invoke(STUDIO_CHANNELS.exportDocument, { ...request, planId: next.value.planId, acceptedLosses: [], destination: 'source-directory' })).toEqual({ ok: false, error: 'revision_conflict' });
    await registration!.dispose(); registration = registerSubtitleStudio();
    const reopened = attach(); await reopened.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 });
    expect(await reopened.invoke(STUDIO_CHANNELS.getSourceLocation, { documentId: request.documentId })).toMatchObject({ ok: true, value: { status: 'ready', origin: 'user-selected-directory' } });
  });

  it('reports an unreadable historical document without blocking native import, preview or restart', async () => {
    adapter.directory = await mkdtemp(path.join(tmpdir(), 'studio-ipc-'));
    const brokenId = randomUUID();
    const folder = path.join(adapter.directory, 'subtitle-studio', 'documents', brokenId);
    await mkdir(folder, { recursive: true });
    const pointer = JSON.stringify({ schemaVersion: 1, generation: randomUUID() });
    await writeFile(path.join(folder, 'current.json'), pointer);
    const source = path.join(adapter.directory, 'new.lrc');
    await writeFile(source, '[00:01]Still usable\n');
    adapter.open.mockResolvedValue({ canceled: false, filePaths: [source] });
    registration = registerSubtitleStudio();
    const owner = attach();
    expect(await owner.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toMatchObject({ ok: true, value: { total: 0, unavailableDocuments: 1 } });
    const imported = await owner.invoke(STUDIO_CHANNELS.importSubtitle, { encoding: 'utf-8' });
    expect(imported.ok).toBe(true);
    expect(adapter.open).toHaveBeenCalledTimes(1);
    expect(await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { documentId: imported.value.id, revision: 1, offset: 0 })).toMatchObject({ ok: true, value: { cues: [{ source: { plain: 'Still usable' } }] } });
    registration.dispose(); registration = registerSubtitleStudio();
    expect(await attach().invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toMatchObject({ ok: true, value: { total: 1, unavailableDocuments: 1 } });
    expect(await readFile(path.join(folder, 'current.json'), 'utf8')).toBe(pointer);
  });
  const exportOptions: ExportOptions = { mode: 'source', format: 'lrc', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' } };
  it('imports a native multiple selection with ordered independent failures and a bounded selection size', async () => {
    const { owner } = await setup();
    const valid = path.join(adapter.directory, '日本語.lrc'); await writeFile(valid, '[00:01]Japanese\n');
    const invalid = path.join(adapter.directory, 'broken.lrc'); await writeFile(invalid, Buffer.from([0xff, 0xfe, 0xff]));
    const other = path.join(adapter.directory, 'second.srt'); await writeFile(other, '1\n00:00:01,000 --> 00:00:02,000\nSecond\n');
    adapter.open.mockResolvedValueOnce({ canceled: false, filePaths: [valid, invalid, other] });
    const result = await owner.invoke(STUDIO_CHANNELS.importSubtitles, { encoding: 'utf-8' });
    expect(adapter.open.mock.calls.at(-1)?.[1].properties).toEqual(['openFile', 'multiSelections']);
    expect(result).toMatchObject({ ok: true, value: { items: [{ fileName: '日本語.lrc', ok: true }, { fileName: 'broken.lrc', ok: false, error: 'encoding_required' }, { fileName: 'second.srt', ok: true }] } });
    expect(await owner.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toMatchObject({ ok: true, value: { total: 3 } });
    const before = adapter.open.mock.calls.length;
    expect(await owner.invoke(STUDIO_CHANNELS.importSubtitles, { encoding: 'utf-8', paths: [valid] })).toEqual({ ok: false, error: 'invalid_input' });
    expect(adapter.open).toHaveBeenCalledTimes(before);
    adapter.open.mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: 101 }, (_, index) => path.join(adapter.directory, `${index}.lrc`)) });
    expect(await owner.invoke(STUDIO_CHANNELS.importSubtitles, { encoding: 'utf-8' })).toEqual({ ok: false, error: 'limit_exceeded' });
    adapter.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await owner.invoke(STUDIO_CHANNELS.importSubtitles, { encoding: 'utf-8' })).toEqual({ ok: true, value: null });
  });
  it('reveals and deletes only an enumerated unreadable record using its exact owner grant and recovery token', async () => {
    const { owner, doc } = await setup();
    const brokenId = randomUUID(); const directory = path.join(adapter.directory, 'subtitle-studio', 'documents', brokenId);
    await mkdir(directory); await writeFile(path.join(directory, 'current.json'), '{}');
    const listed = await owner.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 }); const record = listed.value.unavailable[0];
    const request = { documentId: record.id, token: record.token };
    const other = attach();
    for (const method of [STUDIO_CHANNELS.revealUnavailable, STUDIO_CHANNELS.deleteUnavailable]) {
      expect(await other.invoke(method, request)).toEqual({ ok: false, error: 'access_denied' });
      expect(await owner.invoke(method, { ...request, path: adapter.directory })).toEqual({ ok: false, error: 'invalid_input' });
      expect(await owner.invoke(method, { ...request, token: 'a'.repeat(64) })).toEqual({ ok: false, error: 'access_denied' });
      expect(await owner.invoke(method, { ...request, documentId: doc.id })).toEqual({ ok: false, error: 'access_denied' });
    }
    expect(await owner.invoke(STUDIO_CHANNELS.revealUnavailable, request)).toEqual({ ok: true, value: null });
    expect(adapter.reveal).toHaveBeenCalledTimes(1); expect(adapter.reveal).toHaveBeenCalledWith(directory);
    expect(await owner.invoke(STUDIO_CHANNELS.deleteUnavailable, request)).toEqual({ ok: true, value: { cleanupPending: false } });
    expect(await owner.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toMatchObject({ ok: true, value: { total: 1, unavailableDocuments: 0, unavailable: [] } });
    registration!.dispose(); registration = registerSubtitleStudio();
    expect(await attach().invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toMatchObject({ ok: true, value: { total: 1, unavailableDocuments: 0 } });
    expect(await readFile(path.join(adapter.directory, 'sample.lrc'), 'utf8')).toContain('window.injected');
  });
  it('uses one native directory selection for a batch, preserves cancelled plans and rejects revoked or other owners', async () => {
    const { owner, request } = await setup('[00:01]Original\n');
    const planned = await owner.invoke(STUDIO_CHANNELS.planExportBatch, { documents: [request], options: exportOptions });
    expect(planned).toMatchObject({ ok: true, value: { items: [{ ok: true }] } });
    const execute = { batchId: planned.value.batchId, acceptedLosses: [] };
    expect(await attach().invoke(STUDIO_CHANNELS.exportBatch, execute)).toEqual({ ok: false, error: 'access_denied' });
    adapter.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await owner.invoke(STUDIO_CHANNELS.exportBatch, execute)).toEqual({ ok: true, value: null });
    adapter.open.mockResolvedValueOnce({ canceled: false, filePaths: [adapter.directory] });
    expect(await owner.invoke(STUDIO_CHANNELS.exportBatch, execute)).toMatchObject({ ok: true, value: { items: [{ ok: true, result: { fileName: 'sample (1).lrc' } }] } });
    expect(adapter.open.mock.calls.at(-1)?.[1].properties).toEqual(['openDirectory', 'createDirectory']);
    expect(adapter.save).not.toHaveBeenCalled();
    expect(await readFile(path.join(adapter.directory, 'sample (1).lrc'), 'utf8')).toBe('[00:01.000]Original\n');
    const next = await owner.invoke(STUDIO_CHANNELS.planExportBatch, { documents: [request], options: exportOptions });
    adapter.open.mockImplementationOnce(async () => { owner.client.emit('did-start-navigation', {}, rendererUrl, false, true); return { canceled: false, filePaths: [adapter.directory] }; });
    expect(await owner.invoke(STUDIO_CHANNELS.exportBatch, { batchId: next.value.batchId, acceptedLosses: [] })).toEqual({ ok: false, error: 'access_denied' });
    await expect(readFile(path.join(adapter.directory, 'sample.source (1).lrc'))).rejects.toThrow();
  });
  it('validates export plans and exposes only fixed public export methods', async () => {
    const { owner, request } = await setup('[00:01.00]Original\n');
    const other = attach();
    const payload = { ...request, options: exportOptions };
    expect(await other.invoke(STUDIO_CHANNELS.planExport, payload)).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.planExport, { ...payload, path: '/private/forged' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.planExport, { ...payload, options: { ...exportOptions, unsafe: true } })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.planExport, { ...payload, revision: 2 })).toEqual({ ok: false, error: 'revision_conflict' });
    const planned = await owner.invoke(STUDIO_CHANNELS.planExport, payload);
    expect(planned).toMatchObject({ ok: true, value: { documentId: request.documentId, revision: 1, cueCount: 1 } });
    expect(planned.value.planId).toBeTypeOf('string');
    expect(planned.value).not.toHaveProperty('bytes');
    expect(planned.value).not.toHaveProperty('path');
    const commit = { ...request, planId: planned.value.planId, acceptedLosses: [] };
    expect(await other.invoke(STUDIO_CHANNELS.exportDocument, commit)).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.exportDocument, { ...commit, path: '/private/forged' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.exportDocument, { ...commit, acceptedLosses: ['unknown'] })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.exportDocument, { ...commit, acceptedLosses: ['styles_removed'] })).toEqual({ ok: false, error: 'invalid_input' });
    expect(adapter.save).not.toHaveBeenCalled();
    const capability = randomUUID();
    const ipc = { sendSync: () => capability, invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const api = createSubtitleStudioApi(ipc);
    await api.planExport(payload); await api.exportDocument(commit);
    expect(ipc.invoke.mock.calls).toEqual([[STUDIO_CHANNELS.planExport, { capability, payload }], [STUDIO_CHANNELS.exportDocument, { capability, payload: commit }]]);
  });
  it('keeps a cancelled export plan and publishes its original revision after a new commit during native save', async () => {
    const { owner, request } = await setup('[00:01.00]Original\n');
    const planned = await owner.invoke(STUDIO_CHANNELS.planExport, { ...request, options: exportOptions });
    const commit = { ...request, planId: planned.value.planId, acceptedLosses: [] };
    adapter.save.mockResolvedValueOnce({ canceled: true });
    expect(await owner.invoke(STUDIO_CHANNELS.exportDocument, commit)).toEqual({ ok: true, value: null });
    let finish!: (value: unknown) => void;
    adapter.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = owner.invoke(STUDIO_CHANNELS.exportDocument, commit);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const repository = new DocumentRepository(path.join(adapter.directory, 'subtitle-studio/documents'));
    await repository.transact(request.documentId, 1, value => {
      const cue = value.document.cues[0]; cue.sourceRevision++;
      cue.source = { plain: 'New result', spans: [{ text: 'New result', marks: [] }] };
    });
    const output = path.join(adapter.directory, 'frozen.lrc');
    finish({ canceled: false, filePath: output });
    expect(await pending).toMatchObject({ ok: true, value: { fileName: 'frozen.lrc', revision: 1, mode: 'source', partial: false } });
    expect(await readFile(output, 'utf8')).toBe('[00:01.000]Original\n');
    expect((await repository.read(request.documentId)).cues[0].source.plain).toBe('New result');
  });
  it.each(['delete', 'navigate'])('does not publish a frozen export when %s occurs during native save', async action => {
    const { owner, request } = await setup('[00:01.00]Original\n');
    const planned = await owner.invoke(STUDIO_CHANNELS.planExport, { ...request, options: exportOptions });
    let finish!: (value: unknown) => void;
    adapter.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const output = path.join(adapter.directory, 'preserve.lrc'); await writeFile(output, 'old export');
    const pending = owner.invoke(STUDIO_CHANNELS.exportDocument, { ...request, planId: planned.value.planId, acceptedLosses: [] });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (action === 'delete') expect(await owner.invoke(STUDIO_CHANNELS.deleteDocument, request)).toMatchObject({ ok: true });
    else owner.client.emit('did-start-navigation', {}, rendererUrl, false, true);
    finish({ canceled: false, filePath: output });
    expect(await pending).toEqual({ ok: false, error: action === 'delete' ? 'document_unavailable' : 'access_denied' });
    expect(await readFile(output, 'utf8')).toBe('old export');
  });
  it('uses no-clobber index publication when the native default filename is claimed while its dialog is open', async () => {
    const { owner, request } = await setup('[00:01.00]Original\n');
    const planned = await owner.invoke(STUDIO_CHANNELS.planExport, { ...request, options: exportOptions });
    let claimed = '';
    adapter.save.mockImplementationOnce(async (_window, options) => {
      claimed = options.defaultPath; await writeFile(claimed, 'another export');
      return { canceled: false, filePath: claimed };
    });
    const result = await owner.invoke(STUDIO_CHANNELS.exportDocument, { ...request, planId: planned.value.planId, acceptedLosses: [] });
    expect(result).toMatchObject({ ok: true, value: { fileName: 'sample (2).lrc' } });
    expect(await readFile(claimed, 'utf8')).toBe('another export');
    expect(await readFile(path.join(adapter.directory, result.value.fileName), 'utf8')).toBe('[00:01.000]Original\n');
  });
  it.skipIf(process.platform !== 'win32').each(['exportDocument', 'exportSource'] as const)(
    'preserves a claimed Windows default path when native %s returns different path casing', async method => {
      const original = '[00:01.00]Original\n';
      const { owner, request } = await setup(original);
      const payload = method === 'exportDocument'
        ? { ...request, planId: (await owner.invoke(STUDIO_CHANNELS.planExport, { ...request, options: exportOptions })).value.planId, acceptedLosses: [] }
        : request;
      let claimed = '';
      adapter.save.mockImplementationOnce(async (_window, options) => {
        claimed = options.defaultPath;
        await writeFile(claimed, 'another export');
        const filePath = claimed.replace(/^[a-z]:/i, (drive: string) => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase());
        expect(filePath).not.toBe(claimed);
        return { canceled: false, filePath };
      });
      const result = await owner.invoke(STUDIO_CHANNELS[method], payload);
      expect(result).toMatchObject({ ok: true, value: { fileName: 'sample (2).lrc' } });
      expect(await readFile(claimed, 'utf8')).toBe('another export');
      expect(await readFile(path.join(adapter.directory, 'sample.lrc'), 'utf8')).toBe(original);
      expect(await readFile(path.join(adapter.directory, result.value.fileName), 'utf8'))
        .toBe(method === 'exportSource' ? original : '[00:01.000]Original\n');
    },
  );
  it('rejects cross-owner grants, forged senders/frames/tokens, paths and revisions', async () => {
    const { owner, request } = await setup();
    const other = attach();
    const read = { ...request, offset: 0 };
    expect(await other.invoke(STUDIO_CHANNELS.readDocumentPage, read)).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.readDocumentPage, read, { sender: other.client })).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.readDocumentPage, read, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
    expect(await adapter.handlers.get(STUDIO_CHANNELS.listDocuments)!({ sender: owner.client, senderFrame: owner.client.mainFrame }, { capability: randomUUID(), payload: { offset: 0 } })).toEqual({ ok: false, error: 'access_denied' });
    for (const payload of [{ ...read, path: '/private/file' }, { ...read, documentId: '../escape' }, { ...read, revision: 0 }]) expect(await owner.invoke(STUDIO_CHANNELS.readDocumentPage, payload)).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.exportSource, { ...request, revision: 2 })).toEqual({ ok: false, error: 'revision_conflict' });
    expect(adapter.save).not.toHaveBeenCalled();
    expect(adapter.handlers.has('subtitle-studio:invoke')).toBe(false);
    expect(adapter.handlers.has(STUDIO_CHANNELS.changed)).toBe(false);
    expect(await other.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toMatchObject({ ok: true, value: { total: 1, sequence: 1 } });
    expect(await other.invoke(STUDIO_CHANNELS.readDocumentPage, read)).toMatchObject({ ok: true });
    expect(await other.invoke(STUDIO_CHANNELS.deleteDocument, { ...request, revision: 2 })).toEqual({ ok: false, error: 'revision_conflict' });
  });
  it('denies remote registrations and invalidates capabilities on navigation/destruction', async () => {
    const { owner } = await setup();
    expect(attach(sender('https://example.com')).capability).toBeNull();
    owner.client.emit('did-start-navigation', {}, rendererUrl, false, true);
    expect(await owner.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toEqual({ ok: false, error: 'access_denied' });
    const other = attach(); other.client.emit('destroyed');
    expect(await other.invoke(STUDIO_CHANNELS.listDocuments, { offset: 0 })).toEqual({ ok: false, error: 'access_denied' });
  });
  it('does not publish an export after deletion while its save dialog is open', async () => {
    const { owner, request } = await setup();
    let resolve!: (value: unknown) => void;
    adapter.save.mockImplementation(() => new Promise(done => { resolve = done; }));
    const exportPath = path.join(adapter.directory, 'export.lrc');
    await writeFile(exportPath, 'previous export');
    const exporting = owner.invoke(STUDIO_CHANNELS.exportSource, request);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(await owner.invoke(STUDIO_CHANNELS.deleteDocument, request)).toEqual({ ok: true, value: { cleanupPending: false } });
    resolve({ canceled: false, filePath: exportPath });
    expect(await exporting).toEqual({ ok: false, error: 'document_unavailable' });
    expect(await readFile(exportPath, 'utf8')).toBe('previous export');
    expect(owner.client.send).toHaveBeenCalledWith(STUDIO_CHANNELS.changed, expect.objectContaining({ event: expect.objectContaining({ documentId: request.documentId, deleted: true }) }));
    expect(await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, offset: 0 })).toEqual({ ok: false, error: 'access_denied' });
  });
  it('rejects a delayed dialog response from a revoked owner', async () => {
    const { owner, request } = await setup();
    adapter.save.mockImplementation(async () => {
      owner.client.emit('did-start-navigation', {}, 'https://example.com', false, true);
      return { canceled: false, filePath: path.join(adapter.directory, 'export.lrc') };
    });
    expect(await owner.invoke(STUDIO_CHANNELS.exportSource, request)).toEqual({ ok: false, error: 'access_denied' });
    await expect(readFile(path.join(adapter.directory, 'export.lrc'))).rejects.toThrow();
  });
  it('keeps capabilities and Electron event objects private in the fixed preload API', () => {
    const bus = new EventEmitter();
    const capability = randomUUID();
    const ipc = { sendSync: () => capability, invoke: vi.fn(async () => ({ ok: true })), on: bus.on.bind(bus), removeListener: bus.removeListener.bind(bus) };
    const api = createSubtitleStudioApi(ipc);
    expect(Object.isFrozen(api)).toBe(true);
    expect('invoke' in api || 'capability' in api).toBe(false);
    const listener = vi.fn(); const unsubscribe = api.subscribe(listener);
    const event = { documentId: randomUUID(), sequence: 1, revision: 1, deleted: false };
    bus.emit(STUDIO_CHANNELS.changed, { sender: 'private' }, { capability: randomUUID(), event });
    bus.emit(STUDIO_CHANNELS.changed, {}, { capability, event: { ...event, path: '/private' } });
    expect(listener).not.toHaveBeenCalled();
    bus.emit(STUDIO_CHANNELS.changed, { sender: 'private' }, { capability, event });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe(); expect(bus.listenerCount(STUDIO_CHANNELS.changed)).toBe(0);
  });

  it('previews, applies and clears bilingual content through the three authorized handlers', async () => {
    const source = '[00:01.00]\u3053\u3093\u306b\u3061\u306f\n[00:01.00]Hello\n[00:03.00]\u307e\u305f\u660e\u65e5\n[00:03.00]See you tomorrow\n';
    const { owner, request, doc } = await setup(source);
    const options = { sourceSide: 'first', splitInline: false, overrides: [] };
    expect(doc.bilingualAvailable).toBe(true);
    const before = await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, offset: 0 });
    expect(await owner.invoke(STUDIO_CHANNELS.previewBilingual, { ...request, options, offset: 0 }))
      .toMatchObject({ ok: true, value: { revision: 1, originalCueCount: 4, cueCount: 2, pairedCount: 2 } });
    expect(await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, offset: 0 })).toEqual(before);
    const applied = await owner.invoke(STUDIO_CHANNELS.applyBilingual, { ...request, options });
    expect(applied).toMatchObject({ ok: true, value: { revision: 2, cueCount: 2, bilingualAvailable: false, bilingualImport: { sourceSide: 'first' } } });
    const page = await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, revision: 2, offset: 0 });
    expect(page.ok).toBe(true);
    expect(page.value.translationTracks[0].origin).toBe('imported');
    expect(page.value.rawNodes).toEqual(before.value.rawNodes);
    expect(page.value.cues.map((cue: { source: { plain: string } }) => cue.source.plain)).toEqual(['\u3053\u3093\u306b\u3061\u306f', '\u307e\u305f\u660e\u65e5']);
    const trackId = page.value.translationTracks[0].id;
    expect(await owner.invoke(STUDIO_CHANNELS.removeTranslationTrack, { ...request, revision: 2, trackId }))
      .toMatchObject({ ok: true, value: { revision: 3, cueCount: 2, bilingualAvailable: false } });
    const cleared = await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, revision: 3, offset: 0 });
    expect(cleared.value.translationTracks).toEqual([]);
    expect(cleared.value.cues).toEqual(page.value.cues);
    expect(cleared.value.rawNodes).toEqual(before.value.rawNodes);
    expect(await readFile(path.join(adapter.directory, 'sample.lrc'), 'utf8')).toBe(source);
    expect(owner.client.send).toHaveBeenCalledWith(STUDIO_CHANNELS.changed, expect.objectContaining({ event: expect.objectContaining({ documentId: request.documentId, revision: 3 }) }));
  });

  it('rejects forged bilingual options, paths, duplicate overrides and unauthorized documents', async () => {
    const { owner, request } = await setup('[00:01]\u3053\u3093\u306b\u3061\u306f\n[00:01]Hello\n');
    const options = { sourceSide: 'first', splitInline: false, overrides: [] };
    const other = attach();
    const page = await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, offset: 0 });
    const cueId = page.value.cues[0].id;
    for (const method of [STUDIO_CHANNELS.previewBilingual, STUDIO_CHANNELS.applyBilingual]) {
      const valid = { ...request, options, ...(method === STUDIO_CHANNELS.previewBilingual ? { offset: 0 } : {}) };
      expect(await other.invoke(method, valid)).toEqual({ ok: false, error: 'access_denied' });
      expect(await owner.invoke(method, valid, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
      for (const payload of [
        { ...valid, path: '/private/not-authorized.lrc' },
        { ...valid, documentId: '../escape' },
        { ...valid, options: { ...options, sourceSide: 'third' } },
        { ...valid, options: { ...options, splitInline: 'true' } },
        { ...valid, options: { ...options, language: 'en' } },
        { ...valid, options: { ...options, overrides: [{ cueId, splitAt: null }, { cueId, splitAt: null }] } },
        { ...valid, options: { ...options, overrides: [{ cueId, splitAt: -1 }] } },
        { ...valid, options: { ...options, overrides: [{ cueId: randomUUID(), splitAt: null }] } },
      ]) expect(await owner.invoke(method, payload)).toEqual({ ok: false, error: 'invalid_input' });
      expect(await owner.invoke(method, { ...valid, revision: 2 })).toEqual({ ok: false, error: 'revision_conflict' });
    }
    expect(await owner.invoke(STUDIO_CHANNELS.previewBilingual, { ...request, options, offset: -1 })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, offset: 0 })).toEqual(page);
    await owner.invoke(STUDIO_CHANNELS.applyBilingual, { ...request, options });
    const applied = await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { ...request, revision: 2, offset: 0 });
    const trackId = applied.value.translationTracks[0].id;
    const removal = { ...request, revision: 2, trackId };
    expect(await other.invoke(STUDIO_CHANNELS.removeTranslationTrack, removal)).toEqual({ ok: false, error: 'access_denied' });
    expect(await owner.invoke(STUDIO_CHANNELS.removeTranslationTrack, { ...removal, path: '/private/file' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.removeTranslationTrack, { ...removal, trackId: '../escape' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.removeTranslationTrack, { ...removal, trackId: randomUUID() })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.removeTranslationTrack, { ...removal, revision: 1 })).toEqual({ ok: false, error: 'revision_conflict' });
    owner.client.emit('did-start-navigation', {}, rendererUrl, false, true);
    expect(await owner.invoke(STUDIO_CHANNELS.removeTranslationTrack, removal)).toEqual({ ok: false, error: 'access_denied' });
  });

  it('routes the public bilingual bridge through fixed channels without leaking its capability', async () => {
    const capability = randomUUID();
    const ipc = { sendSync: () => capability, invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const api = createSubtitleStudioApi(ipc);
    const request = { documentId: randomUUID(), revision: 1 };
    const options = { sourceSide: 'first' as const, splitInline: false, overrides: [] };
    await api.previewBilingual({ ...request, options, offset: 0 });
    await api.applyBilingual({ ...request, options });
    const trackId = randomUUID();
    await api.removeTranslationTrack({ ...request, trackId });
    expect(ipc.invoke.mock.calls).toEqual([
      [STUDIO_CHANNELS.previewBilingual, { capability, payload: { ...request, options, offset: 0 } }],
      [STUDIO_CHANNELS.applyBilingual, { capability, payload: { ...request, options } }],
      [STUDIO_CHANNELS.removeTranslationTrack, { capability, payload: { ...request, trackId } }],
    ]);
    expect(Object.keys(api)).not.toContain('capability');
  });

  it('guards recovery and cancellation with owner, exact DTO, task identity and document revision', async () => {
    const { owner, request } = await setup('[00:01]A short sentence.\n');
    const repository = new DocumentRepository(path.join(adapter.directory, 'subtitle-studio/documents'));
    const doc = await repository.read(request.documentId);
    const config = { model: { profileId: 'frozen-profile', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' as const }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 };
    const plan = planTranslation(doc, config);
    const taskId = randomUUID(); const trackId = randomUUID();
    const snapshot = await repository.transact(doc.id, doc.revision, value => {
      value.document.translationTracks.push({ id: trackId, revision: 1, language: 'zh', entries: {} });
      value.tasks.push({ id: taskId, trackId, generation: 1, status: 'interrupted', completedBatchIds: [], uncertainBatchIds: [], attempts: 0,
        translation: { config, totalBatches: 1, estimatedInputTokens: plan.batches[0].estimatedInputTokens, outputTokenReserve: 1024,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, checkpoint: checkpointForPlan(plan, doc) } });
    });
    const current = { documentId: doc.id, revision: snapshot.document.revision, taskId };
    const publicPage = await owner.invoke(STUDIO_CHANNELS.readDocumentPage, { documentId: doc.id, revision: snapshot.document.revision, offset: 0 });
    expect(publicPage.value.tasks[0].translation.checkpoint).toEqual({ version: 1 });
    expect(JSON.stringify(publicPage.value.tasks)).not.toContain('cueIds');
    const other = attach();
    for (const method of [STUDIO_CHANNELS.resumeTask, STUDIO_CHANNELS.cancelTask]) {
      const valid = { ...current, ...(method === STUDIO_CHANNELS.resumeTask ? { model: null, apiKey: '' } : {}) };
      expect(await other.invoke(method, valid)).toEqual({ ok: false, error: 'access_denied' });
      expect(await owner.invoke(method, valid, { senderFrame: { url: rendererUrl } })).toEqual({ ok: false, error: 'access_denied' });
      expect(await owner.invoke(method, { ...valid, path: '/private/forged' })).toEqual({ ok: false, error: 'invalid_input' });
      expect(await owner.invoke(method, { ...valid, revision: 1 })).toEqual({ ok: false, error: 'revision_conflict' });
      expect(await owner.invoke(method, { ...valid, taskId: randomUUID() })).toMatchObject({ ok: false });
    }
    expect(await owner.invoke(STUDIO_CHANNELS.resumeTask, { ...current, model: { ...config.model, apiKey: 'not-a-model-field' }, apiKey: '' })).toEqual({ ok: false, error: 'invalid_input' });
    expect(await owner.invoke(STUDIO_CHANNELS.resumeTask, { ...current, model: null, apiKey: '' })).toEqual({ ok: true, value: { taskId } });
    const waiting = await repository.readSnapshot(doc.id);
    expect(waiting.tasks[0].status).toBe('needs_configuration');
    expect(waiting.tasks[0].attempts).toBe(0);
    expect(await owner.invoke(STUDIO_CHANNELS.cancelTask, { ...current, revision: waiting.document.revision })).toEqual({ ok: true, value: { taskId } });
    const cancelled = await repository.readSnapshot(doc.id);
    expect(cancelled.tasks[0].status).toBe('cancelled');
    expect(cancelled.tasks[0].generation).toBeGreaterThan(waiting.tasks[0].generation);
    expect(cancelled.document.cues).toEqual(doc.cues);
    expect(cancelled.document.translationTracks[0].entries).toEqual({});
    expect(await owner.invoke(STUDIO_CHANNELS.resumeTask, { ...current, revision: cancelled.document.revision, model: null, apiKey: '' })).toMatchObject({ ok: false });
  });

  it('routes resume and cancel through fixed preload channels without exposing credentials in events', async () => {
    const capability = randomUUID();
    const ipc = { sendSync: () => capability, invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const api = createSubtitleStudioApi(ipc);
    const request = { documentId: randomUUID(), revision: 3, taskId: randomUUID() };
    await api.cancelTask(request);
    await api.resumeTask({ ...request, model: null, apiKey: '' });
    expect(ipc.invoke.mock.calls).toEqual([
      [STUDIO_CHANNELS.cancelTask, { capability, payload: request }],
      [STUDIO_CHANNELS.resumeTask, { capability, payload: { ...request, model: null, apiKey: '' } }],
    ]);
    expect(Object.keys(api)).not.toContain('capability');
  });
});
