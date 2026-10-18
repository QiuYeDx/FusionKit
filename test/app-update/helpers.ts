import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import fs, { type WriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppUpdateState } from '../../src/app-update/contract';
import type { DownloadSourceMode } from '../../src/network/contract';
import { AppUpdateService } from '../../electron/main/app-update/service';
import { createTestUpdater, resolveTestUpdateSetup } from '../../electron/main/app-update/test-updater';
import { loadElectronUpdater } from '../../electron/main/app-update/updater-runtime';
import { startHttpServer, type Started } from '../network/local-servers';

const require = createRequire(import.meta.url);
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor') as { ElectronHttpExecutor: new () => { createRequest(options: unknown, callback: unknown): unknown } };

/** electron-updater's HTTP client with Node's http instead of Chromium's net (no Electron in unit tests). */
class NodeHttpExecutor extends ElectronHttpExecutor {
  override createRequest(options: http.RequestOptions & { protocol?: string }, callback: (response: http.IncomingMessage) => void) {
    return (options.protocol === 'https:' ? https : http).request(options, callback);
  }
}

export interface ReleaseFiles {
  readonly version: string;
  readonly installer: Buffer;
  readonly installerName: string;
  readonly sha512: string;
  readonly latestYml: string;
  readonly latestMacYml: string;
}

export function releaseFiles(version = '9.9.9', size = 256 * 1024): ReleaseFiles {
  const installer = randomBytes(size);
  const installerName = `FusionKit_${version}_x64.exe`;
  const sha512 = createHash('sha512').update(installer).digest('base64');
  const latestYml = [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-17T00:00:00.000Z'",
    '',
  ].join('\n');
  const latestMacYml = [
    `version: ${version}`,
    'files:',
    `  - url: FusionKit_${version}_arm64.zip`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length}`,
    `  - url: FusionKit_${version}_arm64.dmg`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length + 1}`,
    `path: FusionKit_${version}_arm64.zip`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-17T00:00:00.000Z'",
    '',
  ].join('\n');
  return { version, installer, installerName, sha512, latestYml, latestMacYml };
}

/**
 * How one stand-in source behaves: the check (latest.yml) and the installer download answer
 * normally, drop the connection, never answer, serve an HTML page, a wrong file or a status.
 */
export interface SourceBehaviour {
  check?: 'ok' | 'drop' | 'hang' | 'html' | number;
  /** "slow" sends the installer in small pieces over about two seconds (slowMs), so progress is visible. */
  download?: 'ok' | 'slow' | 'drop' | 'corrupt' | 'stall' | 'truncate' | number;
  slowMs?: number;
  /**
   * What this source serves instead of the real release: a tampering mirror's own latest.yml and
   * installer (same version and file name, other bytes and SHA-512), or the same release written
   * out differently.
   */
  release?: ReleaseFiles;
}

export interface ReleaseServer extends Started {
  /** Every request as "<source> <path without query>". */
  readonly requests: string[];
  readonly headers: Map<string, http.IncomingHttpHeaders>;
  base(source: string): string;
}

/** One local server standing in for github.com and its mirrors under /<source>/ prefixes. */
export async function startReleaseServer(files: ReleaseFiles, behaviour: Record<string, SourceBehaviour>): Promise<ReleaseServer> {
  const requests: string[] = [];
  const headers = new Map<string, http.IncomingHttpHeaders>();
  const server = await startHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const [, source = '', ...rest] = url.pathname.split('/');
    const filePath = `/${rest.join('/')}`;
    requests.push(`${source} ${filePath}`);
    headers.set(`${source} ${filePath}`, request.headers);
    const plan = behaviour[source] ?? {};
    const served = plan.release ?? files;
    if (/\/latest\/download\/latest(-mac)?\.yml$/.test(filePath)) {
      const answer = plan.check ?? 'ok';
      if (answer === 'drop') { request.socket.destroy(); return; }
      if (answer === 'hang') return;
      if (answer === 'html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html><body>Mirror busy</body></html>'); return; }
      if (typeof answer === 'number') { response.writeHead(answer); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(filePath.endsWith('latest-mac.yml') ? served.latestMacYml : served.latestYml);
      return;
    }
    if (filePath === `/download/v${served.version}/${served.installerName}`) {
      const answer = plan.download ?? 'ok';
      const installer = served.installer;
      if (answer === 'drop') { request.socket.destroy(); return; }
      if (typeof answer === 'number') { response.writeHead(answer); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(installer.length) });
      if (answer === 'corrupt') { response.end(Buffer.alloc(installer.length, 7)); return; }
      if (answer === 'stall' || answer === 'truncate') {
        response.write(installer.subarray(0, 1024));
        if (answer === 'truncate') setTimeout(() => request.socket.destroy(), 20);
        return;
      }
      if (answer === 'slow') {
        let offset = 0;
        const piece = Math.ceil(installer.length / 40);
        const timer = setInterval(() => {
          if (response.destroyed) { clearInterval(timer); return; }
          const next = installer.subarray(offset, offset + piece);
          offset += piece;
          if (offset >= installer.length) { clearInterval(timer); response.end(next); } else response.write(next);
        }, Math.max(10, Math.round((plan.slowMs ?? 2_000) / 40)));
        return;
      }
      response.end(installer);
      return;
    }
    // Blockmaps (differential download) and anything else: not published here.
    response.writeHead(404);
    response.end();
  });
  return {
    ...server,
    requests,
    headers,
    base: source => `http://127.0.0.1:${server.port}/${source}`,
  };
}

export interface ServiceHarness {
  readonly service: AppUpdateService;
  readonly states: AppUpdateState[];
  readonly installs: { isSilent?: boolean; isForceRunAfter?: boolean }[];
  readonly root: string;
  waitFor(predicate: (state: AppUpdateState) => boolean, timeoutMs?: number): Promise<AppUpdateState>;
}

const roots: string[] = [];
/**
 * electron-updater does not close its file stream when a download is cancelled or cut off (the
 * aborted response never ends the pipe), so the temporary installer stays open until the process
 * exits. The app copes (the next attempt picks another temporary name); tests close the leftovers
 * so their folders can be removed.
 */
const writeStreams = new Set<WriteStream>();
/** Makes the next `remaining` installers electron-updater saves fail like a full disk. */
export const diskFaults = { remaining: 0 };
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = ((...args: Parameters<typeof fs.createWriteStream>) => {
  const stream = createWriteStream(...args);
  writeStreams.add(stream);
  stream.once('close', () => writeStreams.delete(stream));
  if (diskFaults.remaining > 0 && /[\\/]pending[\\/]temp-[^\\/]+\.exe$/.test(String(args[0]))) {
    diskFaults.remaining -= 1;
    setImmediate(() => stream.destroy(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' })));
  }
  return stream;
}) as typeof fs.createWriteStream;

export async function cleanupRoots(): Promise<void> {
  diskFaults.remaining = 0;
  await Promise.all([...writeStreams].map(stream => new Promise<void>(resolve => { stream.once('close', () => resolve()); stream.destroy(); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
}

/**
 * The real update service with the real electron-updater (Windows updater), its sources pointed
 * at the release server through the UI-test switch.
 */
export async function createHarness(server: ReleaseServer, options: {
  readonly sources: readonly string[];
  /** Hosts that only confirm a mirror's latest.yml, served by the same local server. */
  readonly witnesses?: readonly string[];
  readonly mode?: DownloadSourceMode;
  readonly platform?: 'win32' | 'darwin';
  readonly currentVersion?: string;
  readonly checkTimeoutMs?: number;
  readonly stallTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly prepareInstall?: () => Promise<void>;
  readonly relaunch?: () => void;
}): Promise<ServiceHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-app-update-'));
  roots.push(root);
  const setup = resolveTestUpdateSetup({
    NODE_ENV: 'test',
    FUSIONKIT_TEST_UPDATE_SOURCES: JSON.stringify(options.sources.map(id => ({ id, base: server.base(id) }))),
    FUSIONKIT_TEST_UPDATE_PLATFORM: options.platform,
  }, { packaged: false });
  if (!setup) throw new Error('The test sources were refused.');
  const witnessSetup = options.witnesses?.length ? resolveTestUpdateSetup({
    NODE_ENV: 'test',
    FUSIONKIT_TEST_UPDATE_SOURCES: JSON.stringify(options.witnesses.map(id => ({ id, base: server.base(id) }))),
  }, { packaged: false }) : undefined;
  if (options.witnesses?.length && !witnessSetup) throw new Error('The test witness sources were refused.');
  const runtime = loadElectronUpdater();
  const updater = createTestUpdater({
    runtime,
    userDataPath: root,
    version: options.currentVersion ?? '0.5.1',
    name: 'FusionKit',
    whenReady: async () => undefined,
    executor: new NodeHttpExecutor(),
    quiet: true,
  });
  const states: AppUpdateState[] = [];
  const installs = (globalThis as Record<string, unknown>).__fusionkitTestUpdateInstalls as ServiceHarness['installs'];
  const waiters = new Set<() => void>();
  const service = new AppUpdateService({
    updater,
    classes: runtime,
    currentVersion: options.currentVersion ?? '0.5.1',
    platform: setup.platform,
    active: true,
    getDownloadSourceMode: () => options.mode ?? 'auto',
    sources: () => setup.sources,
    witnessSources: () => witnessSetup?.sources ?? [],
    prepareInstall: options.prepareInstall,
    relaunch: options.relaunch,
    onState: state => { states.push(state); for (const wake of [...waiters]) wake(); },
    checkTimeoutMs: options.checkTimeoutMs ?? 2_000,
    stallTimeoutMs: options.stallTimeoutMs ?? 5_000,
    installTimeoutMs: options.installTimeoutMs ?? 0,
  });
  const waitFor = (predicate: (state: AppUpdateState) => boolean, timeoutMs = 10_000) => new Promise<AppUpdateState>((resolve, reject) => {
    const check = () => {
      if (!predicate(service.state())) return false;
      waiters.delete(wake); clearTimeout(timer); resolve(service.state()); return true;
    };
    const wake = () => { check(); };
    const timer = setTimeout(() => { waiters.delete(wake); reject(new Error(`Timed out in state ${JSON.stringify(service.state())}`)); }, timeoutMs);
    waiters.add(wake);
    check();
  });
  return { service, states, installs, root, waitFor };
}
