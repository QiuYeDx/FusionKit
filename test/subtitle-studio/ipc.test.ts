import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';
import { createSubtitleStudioApi } from '../../electron/preload/subtitle-studio-api';

const adapter = vi.hoisted(() => ({ handlers: new Map<string, Function>(), listeners: new Map<string, Function>(), directory: '', open: vi.fn(), save: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => adapter.directory, getAppPath: () => process.cwd() },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: adapter.open, showSaveDialog: adapter.save },
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
  registration?.dispose(); registration = undefined;
  if (adapter.directory) await rm(adapter.directory, { recursive: true, force: true });
  adapter.open.mockReset(); adapter.save.mockReset();
});

describe('production Subtitle Studio IPC handler composition', () => {
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
});
