import { BrowserWindow, ipcMain, session as electronSession, type IpcMain, type IpcMainInvokeEvent, type Session } from 'electron';
import { NETWORK_CHANNELS, type NetworkSettings } from '../../../src/network/contract';
import { createReachabilityProbe, testNetworkTargets } from './connectivity';
import { createHttpsDownloadRequest, createResourceDownloader, DownloadSourceRouter } from './download-transport';
import { formatHost, parseCustomProxy } from './proxy-resolver';
import { configureNetworkRuntime, getNetworkAgents, getProxyResolver, networkRouteChanged } from './runtime';
import { NetworkSettingsStore } from './settings';
import { recommendedSpeechModelUrl, speechResourceDownloadOptions, speechResourceExpectedFiles } from './speech-downloads';

export { getAxiosProxyConfig, getNetworkAgents } from './runtime';

/** Startup waits at most this long for Chromium to take the saved proxy. */
const SESSION_PROXY_WAIT_MS = 3_000;
/** Pooled Chromium connections are closed once the proxy setting has been still this long. */
const CONNECTION_RESET_DELAY_MS = 1_000;
/**
 * electron-updater sends its requests through this session (its NET_SESSION_NAME, created with
 * `{ cache: false }`), not the default one, so it has to get the proxy setting as well.
 */
export const UPDATER_SESSION_PARTITION = 'electron-updater';

type ProxySession = Pick<Session, 'setProxy' | 'closeAllConnections'>;

export interface SetupNetworkOptions {
  readonly userDataPath: string;
  /** Answers system-proxy lookups and follows the setting; the default session unless given. */
  readonly session?: ProxySession & Pick<Session, 'resolveProxy'>;
  /** Other sessions that follow the setting; electron-updater's unless given. */
  readonly otherSessions?: readonly ProxySession[];
  readonly ipc?: Pick<IpcMain, 'handle'>;
}

export interface NetworkComposition {
  readonly store: NetworkSettingsStore;
  /** Settles once Chromium (renderer requests, electron-updater) uses the saved proxy too. */
  readonly ready: Promise<void>;
  /** Spread into the shared speech resource service so its downloads use the network layer. */
  readonly speechDownloads: ReturnType<typeof speechResourceDownloadOptions>;
}

/**
 * Loads the saved network settings before anything connects, applies them to every main-process
 * request and to Chromium, and serves the settings page. Call once, after `app` is ready.
 */
export function setupNetwork(options: SetupNetworkOptions): NetworkComposition {
  const store = new NetworkSettingsStore({ directory: options.userDataPath });
  store.load();
  const session = options.session ?? electronSession.defaultSession;
  configureNetworkRuntime({ getSettings: () => store.settings, resolveSystemProxy: url => session.resolveProxy(url) });

  const agents = getNetworkAgents();
  const request = createHttpsDownloadRequest({ agent: agents.https });
  const router = new DownloadSourceRouter({ request });
  const expectedFiles = speechResourceExpectedFiles();
  const downloader = createResourceDownloader({
    router,
    request,
    getMode: () => store.settings.downloadSource,
    expectedFile: url => { try { return expectedFiles.get(new URL(url).href); } catch { return undefined; } },
  });

  const sessions: readonly ProxySession[] = [
    session,
    ...(options.otherSessions ?? [electronSession.fromPartition(UPDATER_SESSION_PARTITION, { cache: false })]),
  ];
  let appliedProxy = store.settings.proxy;
  let chromiumConfig = sessionProxyConfig(store.settings);
  let applied = applySessionProxy(sessions, chromiumConfig);
  let connectionReset: ReturnType<typeof setTimeout> | undefined;
  store.onChanged(settings => {
    router.reset();
    if (JSON.stringify(settings.proxy) === JSON.stringify(appliedProxy)) return;
    appliedProxy = settings.proxy;
    networkRouteChanged();
    const config = sessionProxyConfig(settings);
    if (JSON.stringify(config) === JSON.stringify(chromiumConfig)) return;
    chromiumConfig = config;
    applied = applied.then(async () => {
      await applySessionProxy(sessions, config);
      // A system-proxy lookup made while Chromium still had the old setting gave the old answer.
      networkRouteChanged();
      // Chromium keeps using pooled connections made the old way; close them once typing stops.
      if (connectionReset !== undefined) clearTimeout(connectionReset);
      connectionReset = setTimeout(() => {
        connectionReset = undefined;
        for (const target of sessions) void target.closeAllConnections().catch(() => undefined);
      }, CONNECTION_RESET_DELAY_MS);
      connectionReset.unref?.();
    });
  });

  const probe = createReachabilityProbe(agents);
  const ipc = options.ipc ?? ipcMain;
  ipc.handle(NETWORK_CHANNELS.getSettings, event => {
    assertTrusted(event);
    return store.snapshot();
  });
  ipc.handle(NETWORK_CHANNELS.setSettings, (event, patch: unknown) => {
    assertTrusted(event);
    return store.update(patch);
  });
  ipc.handle(NETWORK_CHANNELS.test, (event, input: unknown) => {
    assertTrusted(event);
    return testNetworkTargets(input, {
      settings: store.settings,
      probe,
      resolveRoutes: url => getProxyResolver().resolve(url),
      modelDownloadUrl: recommendedSpeechModelUrl(),
    });
  });

  return {
    store,
    ready: Promise.race([applied, new Promise<void>(resolve => setTimeout(resolve, SESSION_PROXY_WAIT_MS).unref?.())]),
    speechDownloads: speechResourceDownloadOptions(downloader),
  };
}

/** The Chromium proxy configuration matching the settings; an incomplete custom proxy is direct. */
export function sessionProxyConfig(settings: NetworkSettings): Electron.ProxyConfig {
  if (settings.proxy.mode === 'system') return { mode: 'system' };
  if (settings.proxy.mode === 'custom') {
    const route = parseCustomProxy(settings.proxy.host, settings.proxy.port);
    if (route) return { mode: 'fixed_servers', proxyRules: `${route.kind}://${formatHost(route.host)}:${route.port}` };
  }
  return { mode: 'direct' };
}

async function applySessionProxy(sessions: readonly ProxySession[], config: Electron.ProxyConfig): Promise<void> {
  await Promise.all(sessions.map(async target => {
    try {
      await target.setProxy(config);
    } catch (error) {
      console.error('[network] Chromium proxy could not be applied:', (error as Error)?.message ?? error);
    }
  }));
}

/** Only the application's own windows, from their main frame, may read or change settings. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Network settings are only available to the application window.');
  }
}
