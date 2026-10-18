import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  windows: new Set<unknown>(),
  partitions: [] as { partition: string; options: unknown; session: { setProxy: (...args: unknown[]) => Promise<void>; closeAllConnections: () => Promise<void> } }[],
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  session: {
    defaultSession: undefined,
    fromPartition: (partition: string, options: unknown) => {
      const session = { setProxy: vi.fn(async () => undefined), closeAllConnections: vi.fn(async () => undefined) };
      electron.partitions.push({ partition, options, session });
      return session;
    },
  },
  BrowserWindow: { fromWebContents: (contents: unknown) => (electron.windows.has(contents) ? {} : null) },
}));

import { NETWORK_CHANNELS, type NetworkSettings } from '../../src/network/contract';
import { NETWORK_SETTINGS_FILE, NetworkSettingsStore, normalizeNetworkSettings } from '../../electron/main/network/settings';
import { sessionProxyConfig, setupNetwork, UPDATER_SESSION_PARTITION } from '../../electron/main/network';
import { getAxiosProxyConfig, getNetworkAgents, getProxyResolver } from '../../electron/main/network/runtime';
import { assertLegacyNetworkChannelAllowed, createNetworkApi } from '../../electron/preload/network-api';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-net-settings-'));
  roots.push(root);
  return root;
}
const custom = (host: string, port: string): NetworkSettings => ({ proxy: { mode: 'custom', host, port }, downloadSource: 'auto' });

describe('saved network settings', () => {
  it('starts with the system proxy and automatic download source, and remembers changes across launches', async () => {
    const root = await directory();
    const store = new NetworkSettingsStore({ directory: root });
    expect(store.load()).toEqual({ proxy: { mode: 'system', host: '', port: '' }, downloadSource: 'auto' });
    expect(store.snapshot().stored).toBe(false);
    const listener = vi.fn();
    store.onChanged(listener);
    expect(store.update({ proxy: { mode: 'custom', host: ' 127.0.0.1 ', port: '7890' } })).toEqual({
      proxy: { mode: 'custom', host: '127.0.0.1', port: '7890' }, downloadSource: 'auto', stored: true,
    });
    store.update({ downloadSource: 'mirror' });
    store.update({ downloadSource: 'mirror' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(path.join(root, NETWORK_SETTINGS_FILE), 'utf8'))).toEqual({
      schemaVersion: 1, proxy: { mode: 'custom', host: '127.0.0.1', port: '7890' }, downloadSource: 'mirror',
    });
    const relaunched = new NetworkSettingsStore({ directory: root });
    expect(relaunched.load()).toEqual({ proxy: { mode: 'custom', host: '127.0.0.1', port: '7890' }, downloadSource: 'mirror' });
    expect(relaunched.snapshot().stored).toBe(true);
  });

  it('rejects invalid changes and repairs a damaged file to the defaults', async () => {
    const root = await directory();
    const store = new NetworkSettingsStore({ directory: root });
    store.load();
    expect(() => store.update({ proxy: { mode: 'tor' } })).toThrow();
    expect(() => store.update({ proxy: { port: '80a' } })).toThrow();
    expect(() => store.update({ unknown: true })).toThrow();
    expect(store.settings.proxy.mode).toBe('system');
    await writeFile(path.join(root, NETWORK_SETTINGS_FILE), '{ not json');
    expect(new NetworkSettingsStore({ directory: root }).load()).toEqual(normalizeNetworkSettings(undefined));
    expect(normalizeNetworkSettings({ proxy: { mode: 'none', host: 5, port: '99999999' }, downloadSource: 'ftp' }))
      .toEqual({ proxy: { mode: 'none', host: '', port: '' }, downloadSource: 'auto' });
  });
});

describe('network composition', () => {
  function fakes() {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    const ipc = { handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => { handlers.set(channel, handler); }) };
    const session = {
      setProxy: vi.fn(async (_config: unknown) => undefined),
      resolveProxy: vi.fn(async (_url: string) => 'PROXY 127.0.0.1:7890'),
      closeAllConnections: vi.fn(async () => undefined),
    };
    const updater = { setProxy: vi.fn(async (_config: unknown) => undefined), closeAllConnections: vi.fn(async () => undefined) };
    const contents = { mainFrame: {} };
    electron.windows.add(contents);
    const trusted = { sender: contents, senderFrame: contents.mainFrame };
    return { handlers, ipc, session, updater, trusted };
  }

  it('applies the saved proxy to Chromium (the window and electron-updater) and to main-process requests before anything connects', async () => {
    const root = await directory();
    await writeFile(path.join(root, NETWORK_SETTINGS_FILE), JSON.stringify({ schemaVersion: 1, ...custom('127.0.0.1', '7890') }));
    const { ipc, session, updater, handlers, trusted } = fakes();
    const network = setupNetwork({ userDataPath: root, session: session as never, otherSessions: [updater as never], ipc: ipc as never });
    await network.ready;
    for (const target of [session, updater]) expect(target.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890' });
    expect(await getProxyResolver().resolve('https://api.deepseek.com/v1')).toEqual([{ kind: 'http', host: '127.0.0.1', port: 7890 }]);
    expect(getAxiosProxyConfig()).toEqual({ proxy: false, httpAgent: getNetworkAgents().http, httpsAgent: getNetworkAgents().https });

    await handlers.get(NETWORK_CHANNELS.setSettings)!(trusted, { proxy: { mode: 'system' } });
    for (const target of [session, updater]) await vi.waitFor(() => expect(target.setProxy).toHaveBeenLastCalledWith({ mode: 'system' }));
    expect(await getProxyResolver().resolve('https://huggingface.co/x')).toEqual([{ kind: 'http', host: '127.0.0.1', port: 7890 }]);
    expect(session.resolveProxy).toHaveBeenCalledWith('https://huggingface.co/');
    expect(await handlers.get(NETWORK_CHANNELS.getSettings)!(trusted)).toMatchObject({ proxy: { mode: 'system' }, stored: true });
    // Once the change has settled, pooled Chromium connections made the old way are closed.
    for (const target of [session, updater]) await vi.waitFor(() => expect(target.closeAllConnections).toHaveBeenCalledOnce(), { timeout: 3_000 });

    // A download-source change leaves Chromium and its connections alone.
    await handlers.get(NETWORK_CHANNELS.setSettings)!(trusted, { downloadSource: 'mirror' });
    expect(session.setProxy).toHaveBeenCalledTimes(2);
  });

  it('forgets a system-proxy answer given while Chromium still had the previous setting', async () => {
    const root = await directory();
    await writeFile(path.join(root, NETWORK_SETTINGS_FILE), JSON.stringify({ schemaVersion: 1, ...custom('127.0.0.1', '7890') }));
    const { ipc, session, updater, handlers, trusted } = fakes();
    // Chromium answers with what it was last told, and taking a new setting takes a moment.
    let chromium = 'PROXY 127.0.0.1:7890';
    let finishSetProxy: (() => void) | undefined;
    session.resolveProxy.mockImplementation(async () => chromium);
    session.setProxy.mockImplementation(async config => {
      if ((config as { mode: string }).mode !== 'system') return;
      await new Promise<void>(resolve => { finishSetProxy = resolve; });
      chromium = 'DIRECT';
    });
    const network = setupNetwork({ userDataPath: root, session: session as never, otherSessions: [updater as never], ipc: ipc as never });
    await network.ready;
    await handlers.get(NETWORK_CHANNELS.setSettings)!(trusted, { proxy: { mode: 'system' } });
    // Asked in between, Chromium still names the old proxy.
    expect(await getProxyResolver().resolve('https://example.com/')).toEqual([{ kind: 'http', host: '127.0.0.1', port: 7890 }]);
    await vi.waitFor(() => expect(finishSetProxy).toBeDefined());
    finishSetProxy!();
    await vi.waitFor(async () => expect(await getProxyResolver().resolve('https://example.com/')).toEqual([{ kind: 'direct' }]));
  });

  it('gives the session electron-updater uses the proxy setting by default', async () => {
    const { ipc, session } = fakes();
    electron.partitions.length = 0;
    await setupNetwork({ userDataPath: await directory(), session: session as never, ipc: ipc as never }).ready;
    expect(electron.partitions).toHaveLength(1);
    expect(electron.partitions[0]).toMatchObject({ partition: 'electron-updater', options: { cache: false } });
    expect(electron.partitions[0]!.session.setProxy).toHaveBeenCalledWith({ mode: 'system' });
    // The partition name must stay the one electron-updater itself uses.
    const require = createRequire(import.meta.url);
    expect(UPDATER_SESSION_PARTITION).toBe(require('electron-updater/out/electronHttpExecutor.js').NET_SESSION_NAME);
  });

  it('serves settings only to the application window', async () => {
    const { ipc, session, updater, handlers } = fakes();
    setupNetwork({ userDataPath: await directory(), session: session as never, otherSessions: [updater as never], ipc: ipc as never });
    const stranger = { sender: { mainFrame: {} }, senderFrame: {} };
    expect(() => handlers.get(NETWORK_CHANNELS.getSettings)!(stranger)).toThrow('only available');
    expect(() => handlers.get(NETWORK_CHANNELS.setSettings)!(stranger, { downloadSource: 'mirror' })).toThrow('only available');
    expect(() => handlers.get(NETWORK_CHANNELS.test)!(stranger, {})).toThrow('only available');
    expect([...handlers.keys()].sort()).toEqual(Object.values(NETWORK_CHANNELS).sort());
  });

  it('gives the shared speech resources one download function for models, voice detection and CUDA', async () => {
    const { ipc, session, updater } = fakes();
    const network = setupNetwork({ userDataPath: await directory(), session: session as never, otherSessions: [updater as never], ipc: ipc as never });
    const { downloadResource, vadOptions, acceleratorOptions } = network.speechDownloads;
    expect(typeof downloadResource).toBe('function');
    expect(vadOptions.downloadResource).toBe(downloadResource);
    expect(acceleratorOptions.downloadResource).toBe(downloadResource);
  });

  it('maps each proxy mode to a Chromium configuration', () => {
    expect(sessionProxyConfig({ proxy: { mode: 'none', host: '', port: '' }, downloadSource: 'auto' })).toEqual({ mode: 'direct' });
    expect(sessionProxyConfig({ proxy: { mode: 'system', host: '', port: '' }, downloadSource: 'auto' })).toEqual({ mode: 'system' });
    expect(sessionProxyConfig(custom('socks5://127.0.0.1', '1080'))).toEqual({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080' });
    expect(sessionProxyConfig(custom('', '7890'))).toEqual({ mode: 'direct' });
  });
});

describe('network preload bridge', () => {
  it('exposes only the fixed channels and blocks them on the generic bridge', async () => {
    const ipc = { invoke: vi.fn(async () => ({})) };
    const api = createNetworkApi(ipc);
    await api.getSettings();
    await api.setSettings({ downloadSource: 'official' });
    await api.test({ modelEndpoints: ['https://api.deepseek.com/v1'] });
    expect(ipc.invoke.mock.calls).toEqual([
      [NETWORK_CHANNELS.getSettings],
      [NETWORK_CHANNELS.setSettings, { downloadSource: 'official' }],
      [NETWORK_CHANNELS.test, { modelEndpoints: ['https://api.deepseek.com/v1'] }],
    ]);
    for (const channel of Object.values(NETWORK_CHANNELS)) expect(() => assertLegacyNetworkChannelAllowed(channel)).toThrow('restricted');
    expect(() => assertLegacyNetworkChannelAllowed('check-update')).not.toThrow();
  });
});
