import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  windows: new Set<unknown>(),
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.5.1', getName: () => 'FusionKit', getPath: () => '/nonexistent', whenReady: async () => undefined },
  ipcMain: { handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => { electron.handlers.set(channel, handler); }) },
  BrowserWindow: { fromWebContents: (contents: unknown) => (electron.windows.has(contents) ? {} : null) },
}));

import { APP_UPDATE_CHANNELS } from '../../src/app-update/contract';
import { update } from '../../electron/main/update';
import { resolveTestUpdateSetup } from '../../electron/main/app-update/test-updater';
import { assertLegacyAppUpdateChannelAllowed, createAppUpdateApi } from '../../electron/preload/app-update-api';

describe('update IPC', () => {
  it('serves the application window only, and a development build reports "unsupported" without checking', async () => {
    const sent: unknown[] = [];
    const win = { isDestroyed: () => false, webContents: { send: (...args: unknown[]) => sent.push(args) } } as never;
    update(win, { prepareQuitAndInstall: async () => undefined });
    update(win);
    const channels = [...electron.handlers.keys()];
    for (const channel of Object.values(APP_UPDATE_CHANNELS).filter(channel => channel !== APP_UPDATE_CHANNELS.state)) expect(channels).toContain(channel);
    // The old unrestricted channels are gone, the unused installer download too.
    for (const legacy of ['check-update', 'start-download', 'quit-and-install', 'download-installer']) expect(channels).not.toContain(legacy);

    const contents = { mainFrame: {} };
    electron.windows.add(contents);
    const trusted = { sender: contents, senderFrame: contents.mainFrame };
    const state = await electron.handlers.get(APP_UPDATE_CHANNELS.check)!(trusted, { manual: true });
    expect(state).toMatchObject({ phase: 'idle', installMode: 'unsupported', currentVersion: '0.5.1' });
    expect(await electron.handlers.get(APP_UPDATE_CHANNELS.download)!(trusted)).toMatchObject({ phase: 'idle' });
    expect(await electron.handlers.get(APP_UPDATE_CHANNELS.install)!(trusted)).toMatchObject({ phase: 'idle' });
    // A restart is only for after a failed install.
    expect(await electron.handlers.get(APP_UPDATE_CHANNELS.restart)!(trusted)).toMatchObject({ phase: 'idle' });
    expect(sent).toEqual([]);

    const stranger = { sender: { mainFrame: {} }, senderFrame: {} };
    for (const channel of [APP_UPDATE_CHANNELS.getState, APP_UPDATE_CHANNELS.check, APP_UPDATE_CHANNELS.download, APP_UPDATE_CHANNELS.cancel, APP_UPDATE_CHANNELS.install, APP_UPDATE_CHANNELS.restart]) {
      expect(() => electron.handlers.get(channel)!(stranger)).toThrow('only available');
    }
    expect(() => electron.handlers.get(APP_UPDATE_CHANNELS.install)!({ sender: contents, senderFrame: {} })).toThrow('only available');
  });

  it('lets only an unpackaged test run replace the sources, and only with loopback http servers', () => {
    const sources = JSON.stringify([{ id: 'official', base: 'http://127.0.0.1:5000/official' }, { id: 'ghfast', base: 'http://localhost:5000/mirror/' }]);
    const setup = resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: sources }, { packaged: false })!;
    expect(setup.platform).toBe('win32');
    expect(setup.sources.map(source => [source.id, source.official])).toEqual([['official', true], ['ghfast', false]]);
    expect(setup.sources[1]!.url('https://github.com/QiuYeDx/FusionKit/releases/download/v1.0.0/a.exe')).toBe('http://localhost:5000/mirror/download/v1.0.0/a.exe');
    expect(() => setup.sources[0]!.url('https://example.com/a.exe')).toThrow('Not a release address');
    expect(resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: sources, FUSIONKIT_TEST_UPDATE_PLATFORM: 'darwin' }, { packaged: false })?.platform).toBe('darwin');
    expect(setup.installTimeoutMs).toBe(0);
    expect(resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: sources, FUSIONKIT_TEST_UPDATE_INSTALL_TIMEOUT_MS: '500' }, { packaged: false })?.installTimeoutMs).toBe(500);
    expect(resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: sources, FUSIONKIT_TEST_UPDATE_INSTALL_TIMEOUT_MS: 'soon' }, { packaged: false })?.installTimeoutMs).toBe(0);
    // An installed build, another NODE_ENV, a remote or https address, or nonsense: the real sources.
    expect(resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: sources }, { packaged: true })).toBeUndefined();
    expect(resolveTestUpdateSetup({ NODE_ENV: 'production', FUSIONKIT_TEST_UPDATE_SOURCES: sources }, { packaged: false })).toBeUndefined();
    expect(resolveTestUpdateSetup({ NODE_ENV: 'test' }, { packaged: false })).toBeUndefined();
    for (const base of ['http://example.com/x', 'https://127.0.0.1:5000/x', 'http://user:pw@127.0.0.1/x', 'file:///c:/x']) {
      expect(resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: JSON.stringify([{ id: 'official', base }]) }, { packaged: false })).toBeUndefined();
    }
    expect(resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: '{' }, { packaged: false })).toBeUndefined();
    expect(resolveTestUpdateSetup({ NODE_ENV: 'test', FUSIONKIT_TEST_UPDATE_SOURCES: JSON.stringify([{ id: 'Bad Id', base: 'http://127.0.0.1:1/x' }]) }, { packaged: false })).toBeUndefined();
  });

  it('exposes fixed methods in the preload and keeps the raw channels away from the legacy bridge', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => ({ phase: 'idle' }));
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const api = createAppUpdateApi({
      invoke,
      on: (channel, listener) => { listeners.set(channel, listener); },
      removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); },
    });
    await api.getState();
    await api.check();
    await api.check({ manual: true });
    await api.download();
    await api.cancelDownload();
    await api.install();
    await api.restart();
    expect(invoke.mock.calls).toEqual([
      [APP_UPDATE_CHANNELS.getState], [APP_UPDATE_CHANNELS.check, { manual: false }], [APP_UPDATE_CHANNELS.check, { manual: true }],
      [APP_UPDATE_CHANNELS.download], [APP_UPDATE_CHANNELS.cancel], [APP_UPDATE_CHANNELS.install], [APP_UPDATE_CHANNELS.restart],
    ]);
    const seen: unknown[] = [];
    const stop = api.onState(state => seen.push(state));
    listeners.get(APP_UPDATE_CHANNELS.state)!({}, { phase: 'checking' });
    stop();
    expect(listeners.has(APP_UPDATE_CHANNELS.state)).toBe(false);
    expect(seen).toEqual([{ phase: 'checking' }]);
    expect(Object.isFrozen(api)).toBe(true);
    for (const channel of Object.values(APP_UPDATE_CHANNELS)) expect(() => assertLegacyAppUpdateChannelAllowed(channel)).toThrow('restricted');
    expect(() => assertLegacyAppUpdateChannelAllowed('estimate-subtitle-tokens')).not.toThrow();
  });
});
