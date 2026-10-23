import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn(() => ''), on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('electron', () => ({ app: electron.app, ipcMain: {}, dialog: {}, clipboard: {}, shell: {} }));

import { changeEventSchema, LONG_TEXT_CHANNELS } from '../../src/long-text/channels';
import type { LongTextResult } from '../../src/long-text/contract';
import { registerLongText } from '../../electron/main/long-text';
import { toLongTextError } from '../../electron/main/long-text/ipc';
import { LongTextOperationError } from '../../electron/main/long-text/repository';
import { LongTextRunError } from '../../electron/main/long-text/runner';
import { createSafeLegacyIpcBridge } from '../../electron/preload/legacy-ipc-bridge';
import { createLongTextApi } from '../../electron/preload/long-text-api';
import { assertLegacyLongTextChannelAllowed } from '../../electron/preload/long-text-channel-policy';
import { removeRoot, temporaryRoot } from './document-test-utils';

type Handler = (event: unknown, input?: unknown) => Promise<LongTextResult<unknown>>;

const APP_URL = 'http://localhost:5173';
const REQUEST_CHANNELS = Object.entries(LONG_TEXT_CHANNELS).filter(([key]) => key !== 'changed').map(([, channel]) => channel);
const DEFAULTS = {
  targetLanguage: 'zh-Hans', style: null, instructions: '', profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
  knowledgeCollectionIds: [],
};

let root: string;
let devServerUrl: string | undefined;
const registrations: Array<{ dispose(): void }> = [];

beforeEach(async () => {
  root = await temporaryRoot();
  devServerUrl = process.env.VITE_DEV_SERVER_URL;
  process.env.VITE_DEV_SERVER_URL = APP_URL;
  electron.app.on.mockClear();
  electron.app.removeListener.mockClear();
});

afterEach(async () => {
  for (const registration of registrations.splice(0)) registration.dispose();
  if (devServerUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
  else process.env.VITE_DEV_SERVER_URL = devServerUrl;
  vi.restoreAllMocks();
  await removeRoot(root);
});

function contents(url = `${APP_URL}/`) {
  return { isDestroyed: () => false, getURL: () => url, send: vi.fn() };
}

/** `registerLongText` with the default trust rule, an injected `ipcMain` and the application window `window`. */
function setup(options: { root?: string } = {}) {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => { handlers.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
  };
  const window = { webContents: contents() };
  const registration = registerLongText({
    getWindow: () => window as never,
    readKnowledge: () => { throw new Error('No library in this test'); },
    root: options.root ?? path.join(root, 'long-text'),
    userData: root,
    ipc: ipc as never,
  });
  registrations.push(registration);
  const trusted = { sender: window.webContents, senderFrame: { url: `${APP_URL}/#/tools/text/translator`, parent: null } };
  const call = (channel: string, input?: unknown, event: unknown = trusted) => handlers.get(channel)!(event, input);
  return { handlers, ipc, window, registration, trusted, call };
}

describe('long text IPC', () => {
  it('registers one handler per request channel and removes them all on dispose', async () => {
    const { handlers, ipc, registration } = setup();
    expect([...handlers.keys()].sort()).toEqual([...REQUEST_CHANNELS].sort());
    expect(electron.app.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
    await registration.ready;
    registration.dispose();
    registration.dispose();
    expect(handlers.size).toBe(0);
    expect(ipc.removeHandler).toHaveBeenCalledTimes(REQUEST_CHANNELS.length);
    expect(electron.app.removeListener).toHaveBeenCalledWith('before-quit', electron.app.on.mock.calls[0][1]);
  });

  it('serves only the main frame of the application window (AC-LT-20-1)', async () => {
    const { call, trusted } = setup();
    expect(await call(LONG_TEXT_CHANNELS.list, {})).toEqual({ ok: true, value: { documents: [], storageBytes: 0 } });
    const unavailable = { ok: false, error: { code: 'unavailable' } };
    // Another window, even one showing the app's own page.
    expect(await call(LONG_TEXT_CHANNELS.list, {}, { ...trusted, sender: contents() })).toEqual(unavailable);
    // A child frame of the application window.
    expect(await call(LONG_TEXT_CHANNELS.list, {}, { ...trusted, senderFrame: { ...trusted.senderFrame, parent: {} } })).toEqual(unavailable);
    // The application window showing another page.
    expect(await call(LONG_TEXT_CHANNELS.list, {}, { ...trusted, senderFrame: { url: 'https://evil.example/', parent: null } })).toEqual(unavailable);
  });

  it('answers malformed requests with invalid_request and handler failures with their code', async () => {
    const { call } = setup();
    const invalid = { ok: false, error: { code: 'invalid_request' } };
    expect(await call(LONG_TEXT_CHANNELS.list, { extra: true })).toEqual(invalid);
    expect(await call(LONG_TEXT_CHANNELS.list)).toEqual(invalid);
    expect(await call(LONG_TEXT_CHANNELS.read, { documentId: 'not-a-uuid' })).toEqual(invalid);
    expect(await call(LONG_TEXT_CHANNELS.importText, { text: 'Hello there.', format: 'txt', defaults: DEFAULTS, path: 'C:\\x.txt' })).toEqual(invalid);
    expect(await call(LONG_TEXT_CHANNELS.read, { documentId: '0f8fad5b-d9cb-469f-a165-70867728950e' })).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('sends change events to the application window', async () => {
    const { call, window } = setup();
    const imported = await call(LONG_TEXT_CHANNELS.importText, { text: 'Hello there.\nGood morning.', format: 'txt', defaults: DEFAULTS });
    expect(imported.ok).toBe(true);
    const [channel, event] = window.webContents.send.mock.calls[0];
    expect(channel).toBe(LONG_TEXT_CHANNELS.changed);
    expect(changeEventSchema.parse(event)).toMatchObject({ kind: 'list', sequence: 1 });
  });

  it('answers unavailable when the module could not start', async () => {
    const file = path.join(root, 'not-a-folder');
    await fs.writeFile(file, '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { call, registration } = setup({ root: file });
    await expect(registration.ready).rejects.toMatchObject({ code: 'storage_failed' });
    expect(await call(LONG_TEXT_CHANNELS.list, {})).toEqual({ ok: false, error: { code: 'unavailable' } });
  });

  it('passes model failures on with their category and the provider message only', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(toLongTextError(new LongTextRunError({ code: 'model_failed', category: 'auth', message: 'Invalid key' }))).toEqual({ code: 'model_failed', category: 'auth', message: 'Invalid key' });
    expect(toLongTextError(new LongTextOperationError('busy'))).toEqual({ code: 'busy' });
    expect(errorLog).not.toHaveBeenCalled();
    expect(toLongTextError(new Error('C:\\secret\\path'))).toEqual({ code: 'internal' });
    expect(errorLog).toHaveBeenCalledOnce();
  });
});

describe('long text preload API', () => {
  function fakeIpc() {
    const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
    return {
      listeners,
      invoke: vi.fn(async (..._args: unknown[]) => ({ ok: true, value: null })),
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
      }),
      removeListener: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        listeners.get(channel)?.delete(listener);
      }),
    };
  }

  it('has exactly one method per request channel, invoking that channel', async () => {
    const ipc = fakeIpc();
    const api = createLongTextApi(ipc);
    expect(Object.isFrozen(api)).toBe(true);
    const methods = Object.keys(LONG_TEXT_CHANNELS).filter(key => key !== 'changed');
    expect(Object.keys(api).sort()).toEqual([...methods, 'onChanged'].sort());
    for (const method of methods) {
      const request = method === 'list' ? undefined : { probe: method };
      await (api as unknown as Record<string, (request?: unknown) => Promise<unknown>>)[method](request);
    }
    expect(ipc.invoke.mock.calls).toEqual(methods.map(method => [
      LONG_TEXT_CHANNELS[method as keyof typeof LONG_TEXT_CHANNELS], method === 'list' ? {} : { probe: method },
    ]));
  });

  it('delivers valid change events only and unsubscribes', () => {
    const ipc = fakeIpc();
    const api = createLongTextApi(ipc);
    const received: unknown[] = [];
    const unsubscribe = api.onChanged(event => received.push(event));
    const [listener] = ipc.listeners.get(LONG_TEXT_CHANNELS.changed)!;
    const valid = { sequence: 3, kind: 'segments', documentId: '0f8fad5b-d9cb-469f-a165-70867728950e', range: { start: 0, end: 4 }, pages: [0] };
    listener({}, valid);
    listener({}, { ...valid, sequence: -1 });
    listener({}, { ...valid, kind: 'renamed' });
    listener({}, { ...valid, path: 'C:\\secret' });
    listener({}, 'list');
    expect(received).toEqual([valid]);
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(LONG_TEXT_CHANNELS.changed, listener);
    expect(ipc.listeners.get(LONG_TEXT_CHANNELS.changed)!.size).toBe(0);
  });

  it('keeps the long-text channels away from the legacy ipcRenderer bridge (AC-LT-20-2)', async () => {
    expect(() => assertLegacyLongTextChannelAllowed(LONG_TEXT_CHANNELS.list)).toThrow('restricted');
    expect(() => assertLegacyLongTextChannelAllowed('show-item-in-folder')).not.toThrow();
    const ipcRenderer = { on: vi.fn(), off: vi.fn(), send: vi.fn(), invoke: vi.fn() };
    const bridge = createSafeLegacyIpcBridge({
      ipcRenderer: ipcRenderer as never,
      assertListenChannelAllowed: assertLegacyLongTextChannelAllowed,
      assertCommandChannelAllowed: assertLegacyLongTextChannelAllowed,
    });
    await expect(bridge.invoke(LONG_TEXT_CHANNELS.list)).rejects.toThrow('restricted');
    expect(() => bridge.on(LONG_TEXT_CHANNELS.changed, () => undefined)).toThrow('restricted');
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });
});
