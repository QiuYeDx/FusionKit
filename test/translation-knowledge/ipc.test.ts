import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KNOWLEDGE_CHANNELS } from '../../src/translation-knowledge/ipc-contract';
import { createTranslationKnowledgeApi, assertLegacyKnowledgeChannelAllowed, isPublicKnowledgeChannel } from '../../electron/preload/translation-knowledge-api';
import { knowledgeRequestSchemas, trustedKnowledgeUrl } from '../../electron/main/translation-knowledge/ipc';
import type { MaintenanceRequest } from '../../src/translation-knowledge/maintenance-contract';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), listeners: new Map<string, (...args: any[]) => any>(),
  read: vi.fn(async () => ({ generation: 0 })), release: vi.fn(), dispose: vi.fn(async () => {}),
  select: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
  save: vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })),
  export: vi.fn(async () => ({ entries: [] })), plan: vi.fn(),
  planMaintenance: vi.fn(), commitMaintenance: vi.fn(),
  prepareExport: vi.fn(async () => ({ text: '{}\n', preview: { counts: { entries: 0 }, purpose: 'backup' } })),
  planExport: vi.fn(), invalidateExports: vi.fn(), exportGuard: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/unused/knowledge-test', getAppPath: () => process.cwd() },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: state.select, showSaveDialog: state.save },
  ipcMain: {
    on: (channel: string, listener: (...args: any[]) => any) => state.listeners.set(channel, listener),
    handle: (channel: string, listener: (...args: any[]) => any) => state.handlers.set(channel, listener),
    removeListener: (channel: string) => state.listeners.delete(channel),
    removeHandler: (channel: string) => state.handlers.delete(channel),
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
vi.mock('../../electron/main/translation-knowledge/service', () => ({
  KnowledgeService: class { read = state.read; releaseOwner = state.release; dispose = state.dispose; exportPackage = state.export; planImport = state.plan; planMaintenance = state.planMaintenance; commitMaintenance = state.commitMaintenance; },
  KnowledgeServiceError: class extends Error { constructor(public code: string, public diagnostics?: unknown[]) { super(code); } },
}));
vi.mock('../../electron/main/translation-knowledge/export-plans', () => ({
  KnowledgeExportPlans: class {
    prepare = state.prepareExport; plan = state.planExport; invalidate = state.invalidateExports; guard = state.exportGuard;
    releaseOwner() {} dispose() {}
  },
}));
import { publishKnowledgeFile, readKnowledgeFile, registerTranslationKnowledge } from '../../electron/main/translation-knowledge';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('knowledge IPC and native publication', () => {
  it('keeps capabilities private and rejects every protected namespace in the legacy bridge', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const api = createTranslationKnowledgeApi({ sendSync: () => 'capability', invoke });
    await api.read();
    expect(invoke).toHaveBeenCalledWith(KNOWLEDGE_CHANNELS.read, { capability: 'capability', payload: {} });
    expect(Object.keys(api)).not.toContain('invoke');
    for (const channel of Object.values(KNOWLEDGE_CHANNELS)) {
      expect(() => assertLegacyKnowledgeChannelAllowed(channel)).toThrow();
      expect(isPublicKnowledgeChannel(channel)).toBe(channel !== KNOWLEDGE_CHANNELS.register);
    }
    expect(isPublicKnowledgeChannel(`${KNOWLEDGE_CHANNELS.read}:internal`)).toBe(false);
    expect(() => assertLegacyKnowledgeChannelAllowed('translation-knowledge:invented')).toThrow();
    const unavailable = createTranslationKnowledgeApi({ sendSync: () => null, invoke });
    expect(await unavailable.read()).toEqual({ ok: false, error: 'access_denied' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('only permits attached main frames, fences owners on navigation, and disposes handlers', async () => {
    const bridge = registerTranslationKnowledge();
    const contents = Object.assign(new EventEmitter(), { id: 51, mainFrame: { url: pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href }, isDestroyed: () => false });
    const event = { sender: contents, senderFrame: contents.mainFrame, returnValue: undefined as unknown };
    const register = state.listeners.get(KNOWLEDGE_CHANNELS.register)!;
    register(event, {}); expect(event.returnValue).toBeNull();
    bridge.attach(contents as any);
    register(event, {});
    const capability = event.returnValue;
    expect(typeof capability).toBe('string');
    const handler = state.handlers.get(KNOWLEDGE_CHANNELS.read)!;
    expect(await handler(event, { capability, payload: {} })).toEqual({ ok: true, value: { generation: 0 } });
    expect(await handler({ ...event, senderFrame: { url: contents.mainFrame.url } }, { capability, payload: {} })).toEqual({ ok: false, error: 'access_denied' });
    expect(await handler(event, { capability: '00000000-0000-4000-8000-000000000000', payload: {} })).toEqual({ ok: false, error: 'access_denied' });
    expect(await handler(event, { capability, payload: { path: '/private' } })).toEqual({ ok: false, error: 'invalid_input' });
    let resolveRead!: (result: { generation: number }) => void;
    state.read.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const pending = handler(event, { capability, payload: {} });
    contents.emit('did-start-navigation', {}, 'https://example.invalid/', false, true);
    resolveRead({ generation: 0 });
    expect(await pending).toEqual({ ok: false, error: 'access_denied' });
    expect(state.release).toHaveBeenCalledWith(capability);
    const first = bridge.dispose(); expect(bridge.dispose()).toBe(first); await first;
    expect(state.handlers.size).toBe(0); expect(state.listeners.size).toBe(0);
  });

  it('checks URLs exactly apart from hash and rejects duplicate or forged request fields', () => {
    expect(trustedKnowledgeUrl('https://example.test/app#a', 'https://example.test/app#b')).toBe(true);
    expect(trustedKnowledgeUrl('https://example.test/app?extra=1', 'https://example.test/app')).toBe(false);
    const id = '10000000-0000-4000-8000-000000000001';
    expect(knowledgeRequestSchemas.reviewEntries.safeParse({ generation: 0, ids: [id, id], action: 'adopt' }).success).toBe(false);
    expect(knowledgeRequestSchemas.selectImport.safeParse({ filePath: '/etc/passwd' }).success).toBe(false);
    expect(knowledgeRequestSchemas.exportFile.safeParse({ generation: 0, purpose: 'backup', collectionIds: [], includeMemories: false, path: '/etc/passwd' }).success).toBe(false);
    expect(knowledgeRequestSchemas.importDroppedFile.safeParse({ path: '../secret.json' }).success).toBe(false);
    expect(knowledgeRequestSchemas.commitMaintenance.safeParse({ planId: id, action: 'purge', targets: [] }).success).toBe(false);
  });

  it('passes explicit collection deletion through preload and the registered handler while rejecting forged expansion requests', async () => {
    const bridge = registerTranslationKnowledge();
    const contents = Object.assign(new EventEmitter(), { id: 73, mainFrame: { url: pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href }, isDestroyed: () => false });
    bridge.attach(contents as any);
    const event = { sender: contents, senderFrame: contents.mainFrame, returnValue: undefined as unknown };
    const api = createTranslationKnowledgeApi({
      sendSync: (channel, payload) => { state.listeners.get(channel)!(event, payload); return event.returnValue; },
      invoke: async (channel, envelope) => state.handlers.get(channel)!(event, envelope),
    });
    const collectionId = '10000000-0000-4000-8000-000000000001';
    const entryId = '10000000-0000-4000-8000-000000000002';
    const payload: MaintenanceRequest = { generation: 3, action: 'purge', targets: [{ group: 'collections', id: collectionId }], includeCollectionContents: true };
    const preview = { planId: '10000000-0000-4000-8000-000000000003', action: 'purge', canCommit: true };
    state.planMaintenance.mockResolvedValue(preview);
    try {
      expect(await api.planMaintenance(payload)).toEqual({ ok: true, value: preview });
      expect(state.planMaintenance).toHaveBeenCalledWith(event.returnValue, payload);
      for (const invalid of [
        { ...payload, includeCollectionContents: false },
        { ...payload, includeCollectionContents: 'true' },
        { ...payload, targets: [{ group: 'entries', id: entryId }] },
        { ...payload, targets: [...payload.targets, { group: 'entries', id: entryId }] },
        { ...payload, action: 'archive' },
        { ...payload, targets: [payload.targets[0], payload.targets[0]] },
      ]) expect(await api.planMaintenance(invalid as MaintenanceRequest)).toEqual({ ok: false, error: 'invalid_input' });
      expect(state.planMaintenance).toHaveBeenCalledTimes(1);
      const ordinary: MaintenanceRequest = { generation: 3, action: 'purge', targets: [{ group: 'entries', id: entryId }] };
      expect(await api.planMaintenance(ordinary)).toEqual({ ok: true, value: preview });
      expect(state.planMaintenance).toHaveBeenLastCalledWith(event.returnValue, ordinary);
    } finally { await bridge.dispose(); }
  });

  it('converts only OS-backed File objects in the private preload drop method', async () => {
    const native = {} as File;
    const invoke = vi.fn(async () => ({ ok: true, value: {} }));
    const api = createTranslationKnowledgeApi({ sendSync: () => 'capability', invoke }, {
      getPathForFile(file) { if (file !== native) throw new TypeError('Not a native File'); return '/tmp/selected.fktk.json'; },
    });
    expect(await api.importDroppedFile('/etc/passwd' as unknown as File)).toEqual({ ok: false, error: 'invalid_input' });
    expect(await api.importDroppedFile({ path: '/etc/passwd' } as unknown as File)).toEqual({ ok: false, error: 'invalid_input' });
    expect(invoke).not.toHaveBeenCalled();
    await api.importDroppedFile(native);
    expect(invoke).toHaveBeenCalledWith(KNOWLEDGE_CHANNELS.importDroppedFile, { capability: 'capability', payload: { path: '/tmp/selected.fktk.json' } });
  });

  it('checks the export plan again after native selection and fences publication', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-export-plan-')); directories.push(directory);
    const destination = path.join(directory, 'previewed.fktk.json');
    state.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const bridge = registerTranslationKnowledge();
    const contents = Object.assign(new EventEmitter(), { id: 72, mainFrame: { url: pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href }, isDestroyed: () => false });
    bridge.attach(contents as any);
    const event = { sender: contents, senderFrame: contents.mainFrame, returnValue: undefined as unknown };
    state.listeners.get(KNOWLEDGE_CHANNELS.register)!(event, {});
    const planId = '10000000-0000-4000-8000-000000000001';
    const result = await state.handlers.get(KNOWLEDGE_CHANNELS.exportFile)!(event, { capability: event.returnValue, payload: { planId } });
    expect(result).toMatchObject({ ok: true, value: { entries: 0, purpose: 'backup' } });
    expect(state.prepareExport).toHaveBeenCalledTimes(2);
    expect(state.exportGuard).toHaveBeenCalledWith(event.returnValue, planId);
    expect(await readFile(destination, 'utf8')).toBe('{}\n');
    await bridge.dispose();
  });

  it.each(['selectImport', 'exportFile'] as const)('closes while %s has an open dialog and ignores its later selection', async method => {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-dialog-')); directories.push(directory);
    const chosenPath = path.join(directory, 'late-selection.fktk.json');
    let resolveDialog!: (value: any) => void;
    let dialogOpened!: () => void;
    const opened = new Promise<void>(resolve => { dialogOpened = resolve; });
    const dialog = method === 'selectImport' ? state.select : state.save;
    dialog.mockImplementationOnce(() => { dialogOpened(); return new Promise(resolve => { resolveDialog = resolve; }); });
    const bridge = registerTranslationKnowledge();
    const contents = Object.assign(new EventEmitter(), { id: 62, mainFrame: { url: pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href }, isDestroyed: () => false });
    bridge.attach(contents as any);
    const event = { sender: contents, senderFrame: contents.mainFrame, returnValue: undefined as unknown };
    state.listeners.get(KNOWLEDGE_CHANNELS.register)!(event, {});
    const payload = method === 'selectImport' ? {} : { planId: '10000000-0000-4000-8000-000000000001' };
    const operation = state.handlers.get(KNOWLEDGE_CHANNELS[method])!(event, { capability: event.returnValue, payload });
    await opened;
    try {
      // This must settle without the user first dismissing the native dialog.
      await bridge.dispose();
      expect(state.dispose).toHaveBeenCalledTimes(1);
      expect(await operation).toEqual({ ok: false, error: 'access_denied' });
    } finally {
      resolveDialog(method === 'selectImport' ? { canceled: false, filePaths: [chosenPath] } : { canceled: false, filePath: chosenPath });
      await operation;
      await bridge.dispose();
    }
    await Promise.resolve();
    expect(state.plan).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  }, 1000);

  it('continues joining an admitted repository read during shutdown', async () => {
    let resolveRead!: (value: { generation: number }) => void;
    state.read.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const bridge = registerTranslationKnowledge();
    const contents = Object.assign(new EventEmitter(), { id: 63, mainFrame: { url: pathToFileURL(path.join(process.cwd(), 'dist/index.html')).href }, isDestroyed: () => false });
    bridge.attach(contents as any);
    const event = { sender: contents, senderFrame: contents.mainFrame, returnValue: undefined as unknown };
    state.listeners.get(KNOWLEDGE_CHANNELS.register)!(event, {});
    const operation = state.handlers.get(KNOWLEDGE_CHANNELS.read)!(event, { capability: event.returnValue, payload: {} });
    const disposed = bridge.dispose();
    await Promise.resolve();
    expect(state.dispose).not.toHaveBeenCalled();
    resolveRead({ generation: 0 });
    expect(await operation).toEqual({ ok: false, error: 'access_denied' });
    await disposed;
    expect(state.dispose).toHaveBeenCalledTimes(1);
  });

  it('reads UTF-8, rejects malformed bytes and publishes complete files without overwriting', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-native-')); directories.push(directory);
    const destination = path.join(directory, '资料.fktk.json');
    const text = '{"name":"测试"}\n';
    await publishKnowledgeFile(destination, text);
    expect(await readKnowledgeFile(destination)).toBe(text);
    await expect(publishKnowledgeFile(destination, 'changed')).rejects.toMatchObject({ code: 'file_exists' });
    expect(await readFile(destination, 'utf8')).toBe(text);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    const invalid = path.join(directory, 'invalid.json'); await writeFile(invalid, Buffer.from([0xff, 0xfe]));
    await expect(readKnowledgeFile(invalid)).rejects.toMatchObject({ code: 'invalid_input' });
    const cancelled = path.join(directory, 'cancelled.json');
    await expect(publishKnowledgeFile(cancelled, text, () => { throw new Error('owner released'); })).rejects.toThrow('owner released');
    expect(await readdir(directory)).not.toContain('cancelled.json');
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reports an unsupported export destination without leaving partial files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-unsupported-')); directories.push(directory);
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }));
    await expect(publishKnowledgeFile(path.join(directory, 'backup.fktk.json'), '{}')).rejects.toMatchObject({ code: 'unsupported_destination' });
    expect(await readdir(directory)).toEqual([]);
  });
});
