import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASES_URL } from '../../../src/app-update/contract';
import type { UpdaterLike } from './service';
import type { UpdateSource } from './sources';
import type { ElectronUpdaterRuntime } from './updater-runtime';

/**
 * UI tests only (NODE_ENV=test in an unpackaged run): JSON like
 * `[{"id":"official","base":"http://127.0.0.1:5000/official"},{"id":"ghfast","base":"…"}]` puts
 * local servers in place of github.com and its mirrors (a base stands for RELEASES_URL), so the
 * real electron-updater checks and downloads against them. Only loopback http addresses count.
 */
export const TEST_UPDATE_SOURCES_ENV = 'FUSIONKIT_TEST_UPDATE_SOURCES';
/** UI tests only: "darwin" shows the macOS (DMG links) flow on any computer. */
export const TEST_UPDATE_PLATFORM_ENV = 'FUSIONKIT_TEST_UPDATE_PLATFORM';
/** UI tests only: milliseconds after "restart and install" until the recorded (never quitting) install counts as failed. */
export const TEST_UPDATE_INSTALL_TIMEOUT_ENV = 'FUSIONKIT_TEST_UPDATE_INSTALL_TIMEOUT_MS';
/** A test run's "restart and install" is recorded here (main-process global) instead of quitting. */
export const TEST_UPDATE_INSTALLS_GLOBAL = '__fusionkitTestUpdateInstalls';
/** A test run's "restart FusionKit" (after a failed install) is counted here instead of quitting. */
export const TEST_UPDATE_RESTARTS_GLOBAL = '__fusionkitTestUpdateRestarts';

export interface TestUpdateSetup {
  readonly sources: readonly UpdateSource[];
  readonly platform: NodeJS.Platform;
  /** 0: a recorded install stays "installing". */
  readonly installTimeoutMs: number;
}

/** The local sources a UI test asked for, or undefined (always for an installed build). */
export function resolveTestUpdateSetup(env: NodeJS.ProcessEnv, options: { packaged: boolean }): TestUpdateSetup | undefined {
  if (env.NODE_ENV !== 'test' || options.packaged) return undefined;
  const raw = env[TEST_UPDATE_SOURCES_ENV];
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 4) return undefined;
  const sources: UpdateSource[] = [];
  for (const entry of parsed) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const base = typeof entry?.base === 'string' ? entry.base.replace(/\/+$/, '') : '';
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || !isLoopbackHttp(base)) return undefined;
    sources.push(Object.freeze({
      id,
      official: id === 'official',
      url: (officialUrl: string) => {
        if (!officialUrl.startsWith(`${RELEASES_URL}/`)) throw new Error(`Not a release address: ${officialUrl}`);
        return `${base}${officialUrl.slice(RELEASES_URL.length)}`;
      },
    }));
  }
  const installTimeout = Number(env[TEST_UPDATE_INSTALL_TIMEOUT_ENV] ?? 0);
  return {
    sources,
    platform: env[TEST_UPDATE_PLATFORM_ENV] === 'darwin' ? 'darwin' : 'win32',
    installTimeoutMs: Number.isSafeInteger(installTimeout) && installTimeout > 0 && installTimeout <= 60_000 ? installTimeout : 0,
  };
}

/**
 * A real electron-updater (the Windows one) that treats the test build as installed: its cache and
 * configuration live in the test profile, it talks through Chromium like the installed app does,
 * and "restart and install" only records the call.
 */
export function createTestUpdater(input: {
  readonly runtime: ElectronUpdaterRuntime;
  readonly userDataPath: string;
  readonly version: string;
  readonly name: string;
  readonly whenReady: () => Promise<void>;
  /** Unit tests run without Chromium and pass a Node HTTP client instead. */
  readonly executor?: unknown;
  /** Silences electron-updater's console log (unit tests). */
  readonly quiet?: boolean;
}): UpdaterLike {
  const configPath = path.join(input.userDataPath, 'app-update-test.yml');
  mkdirSync(input.userDataPath, { recursive: true });
  writeFileSync(configPath, 'provider: custom\nupdaterCacheDirName: fusionkit-test-updater\n');
  const updater = new input.runtime.NsisUpdater(null, {
    version: input.version,
    name: input.name,
    isPackaged: true,
    appUpdateConfigPath: configPath,
    userDataPath: input.userDataPath,
    baseCachePath: path.join(input.userDataPath, 'update-cache'),
    whenReady: input.whenReady,
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  });
  // electron-updater only creates its HTTP client for the default app adapter.
  (updater as unknown as { httpExecutor: unknown }).httpExecutor = input.executor ?? new input.runtime.ElectronHttpExecutor();
  if (input.quiet) updater.logger = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  const installs: { isSilent?: boolean; isForceRunAfter?: boolean }[] = [];
  (globalThis as Record<string, unknown>)[TEST_UPDATE_INSTALLS_GLOBAL] = installs;
  return {
    setFeedURL: options => updater.setFeedURL(options),
    checkForUpdates: () => updater.checkForUpdates(),
    downloadUpdate: token => updater.downloadUpdate(token),
    quitAndInstall: (isSilent, isForceRunAfter) => { installs.push({ isSilent, isForceRunAfter }); },
    on: ((event: 'download-progress' | 'error', listener: (...args: any[]) => void) => updater.on(event, listener)) as UpdaterLike['on'],
  };
}

/** UI tests: counts a restart instead of quitting the app under test. */
export function recordTestRestart(): void {
  const store = globalThis as Record<string, unknown>;
  store[TEST_UPDATE_RESTARTS_GLOBAL] = (typeof store[TEST_UPDATE_RESTARTS_GLOBAL] === 'number' ? store[TEST_UPDATE_RESTARTS_GLOBAL] as number : 0) + 1;
}

function isLoopbackHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
