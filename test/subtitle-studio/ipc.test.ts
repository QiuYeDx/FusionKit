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
async function setup() {
  adapter.directory = await mkdtemp(path.join(tmpdir(), 'studio-ipc-'));
  const source = path.join(adapter.directory, 'sample.lrc');
  await writeFile(source, '[00:01.00]<script>window.injected=true</script>\n');
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
});
