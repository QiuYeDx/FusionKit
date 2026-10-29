import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { isPackaged: false, getGPUInfo: vi.fn(async () => ({ gpuDevice: [] })), getPath: vi.fn(() => '') },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) },
  shell: { showItemInFolder: vi.fn(), trashItem: vi.fn(async () => undefined) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
}));
vi.mock('electron', () => electron);
// The verification entry of the bundled runtime: darwin must never reach it (AC-ENGINE-01-3).
const runtimeVerification = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../../electron/main/subtitle-studio/transcription/native/resource-path', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/main/subtitle-studio/transcription/native/resource-path')>();
  runtimeVerification.verify.mockImplementation(actual.verifyLocalSubtitleRuntimeBundle);
  return { ...actual, verifyLocalSubtitleRuntimeBundle: runtimeVerification.verify };
});

import { MEDIA_CONVERTER_CHANNELS } from '../../src/media-converter/channels';
import { addFilesResultSchema, mediaConverterSnapshotSchema, mediaInfoSchema, type MediaConverterResult, type MediaInfo } from '../../src/media-converter/contract';
import { registerMediaConverter } from '../../electron/main/media-converter';
import { MediaCapabilities } from '../../electron/main/media-converter/engine/capabilities';
import { MediaConversionExecutor } from '../../electron/main/media-converter/engine/executor';
import { MediaProber } from '../../electron/main/media-converter/engine/probe';
import { MediaRuntime, type MediaTools } from '../../electron/main/media-converter/engine/runtime';
import { MediaQueue } from '../../electron/main/media-converter/queue/queue';
import { TEST_MEDIA_CAPS_ENV } from '../../electron/main/media-converter/test-hooks';
import { createSafeLegacyIpcBridge } from '../../electron/preload/legacy-ipc-bridge';
import { createMediaConverterApi } from '../../electron/preload/media-converter-api';
import { assertLegacyMediaConverterChannelAllowed } from '../../electron/preload/media-converter-channel-policy';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * The media converter in the production composition (T-ENGINE-06, FK-PIT-0079), without starting
 * Electron: the preload exposes `window.mediaConverter` and the legacy bridge refuses its channels;
 * the main process registers it before the first window, guarded, and joins its shutdown to the
 * shared application shutdown; `registerMediaConverter` registers every channel, and with the
 * platform stubbed as darwin every channel answers `platform_unsupported`, `supported` is false, and
 * neither the runtime nor anything on disk is touched.
 */

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const APP_URL = 'http://localhost:5173';
const C = MEDIA_CONVERTER_CHANNELS;
const REQUEST_CHANNELS = Object.entries(C).filter(([key]) => key !== 'changed').map(([, channel]) => channel);
/** One valid request per channel. */
const VALID_REQUESTS: Record<string, unknown> = {
  [C.getSnapshot]: {}, [C.addDroppedFiles]: { paths: ['C:\\Media\\clip.mp4'] }, [C.pickFiles]: { filter: 'all' }, [C.pickOutputDirectory]: {},
  [C.previewPlan]: { itemId: 'item', settings: { task: 'convert', target: 'mkv', preferRemux: true, tier: 'balanced' } },
  [C.start]: { itemIds: ['item'], settings: { task: 'convert', target: 'mkv', preferRemux: true, tier: 'balanced' }, output: { mode: 'source', conflict: 'number' },
    confirmed: { lossyToLossless: [], replaceExisting: false } },
  [C.cancel]: { itemIds: ['item'] }, [C.remove]: { itemIds: ['item'] }, [C.retry]: { itemIds: ['item'] }, [C.clear]: { scope: 'finished' },
  [C.revealOutput]: { itemId: 'item' }, [C.setOptions]: { lowUsage: true }, [C.redetectCapabilities]: {},
};
/** A 2 s H.264/AAC MP4 as the probe would describe it (as in ipc.test.ts): converting it to MKV is a remux. */
const MEDIA: MediaInfo = mediaInfoSchema.parse({
  kind: 'video',
  container: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', matroskaDocType: null, extension: 'mp4', identity: 'mp4' },
  sizeBytes: 1_000_000, durationUs: 2_000_000, durationSource: 'format', startTimeUs: 0, bitRate: 4_000_000, primaryVideoIndex: 0,
  video: [{
    index: 0, typeIndex: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', bitDepth: 8, chromaSubsampling: '420', width: 640, height: 360,
    sampleAspectRatio: '1:1', rFrameRate: '25/1', avgFrameRate: '25/1', fps: 25, isVfr: false, rotation: 0, colorPrimaries: 'bt709',
    colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv', fieldOrder: 'progressive', bitRate: 3_800_000, durationUs: 2_000_000,
    language: null, title: null, default: true, hdr: { format: 'none', dolbyVision: null, masteringDisplay: null, contentLight: null },
  }],
  audio: [{
    index: 1, typeIndex: 0, codec: 'aac', profile: 'LC', channels: 2, channelLayout: 'stereo', sampleRate: 48_000, sampleFormat: 'fltp',
    bitsPerRawSample: null, bitRate: 128_000, bitRateSource: 'stream', durationUs: 2_000_000, language: 'eng', title: null, default: true, forced: false,
  }],
  subtitles: [], covers: [], attachments: 0, chapters: 0, dataStreams: 0,
});
let root: string;
let runs = 0;
let saved: Record<string, string | undefined>;

type Handler = (event: unknown, input?: unknown) => Promise<MediaConverterResult<unknown>>;

/** Runs `run` with `process.platform` stubbed, as the preload of another platform sees it. */
function onPlatform<T>(platform: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try { return run(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

function setup(platform: string, userDataPath: string) {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => { handlers.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
  };
  const mainFrame = { url: `${APP_URL}/#/tools/media/converter`, parent: null };
  const contents = { isDestroyed: () => false, getURL: () => mainFrame.url, send: vi.fn(), mainFrame };
  const window = { isDestroyed: () => false, webContents: contents };
  const registration = registerMediaConverter({
    getWindow: () => window as never, environment: { mode: 'development', appRoot: process.cwd() }, userDataPath, platform, ipc: ipc as never,
  });
  const trusted = { sender: contents, senderFrame: mainFrame };
  const call = (channel: string, input?: unknown, event: unknown = trusted) => handlers.get(channel)!(event, input);
  return { handlers, ipc, window, registration, trusted, call };
}

async function userData(name: string) {
  const dir = path.join(root, `${String(++runs).padStart(2, '0')}-${name}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'composition-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'composition-')));
});
afterAll(async () => {
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});
beforeEach(() => {
  saved = { VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL, [TEST_MEDIA_CAPS_ENV]: process.env[TEST_MEDIA_CAPS_ENV], NODE_ENV: process.env.NODE_ENV };
  process.env.VITE_DEV_SERVER_URL = APP_URL;
  runtimeVerification.verify.mockClear();
  for (const group of Object.values(electron)) for (const fn of Object.values(group)) if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('media converter composition', () => {
  it('registers the media converter in the main process before the first window and joins the shared shutdown', () => {
    const main = read('electron/main/index.ts');
    expect(main).toContain('import { registerMediaConverter } from "./media-converter";');
    const registration = main.indexOf('mediaConverter = registerMediaConverter({ getWindow: () => win, environment: localSubtitleResourceEnvironment,');
    expect(registration).toBeGreaterThan(main.indexOf('registerLongText('));
    expect(main.indexOf('  createWindow();')).toBeGreaterThan(registration);
    // Guarded like its neighbours: a failure leaves the rest of the app running.
    expect(main.slice(registration - 'try { '.length, registration)).toBe('try { ');
    expect(main.indexOf('catch { console.error("Media converter initialization failed."); }', registration)).toBeGreaterThan(registration);
    expect(main).toContain('userDataPath: app.getPath("userData"), platform: process.platform });');
    // The shutdown is one of the runtimes of the shared application shutdown (app quit and update install).
    const shutdown = main.indexOf('createSharedResourceApplicationShutdown({');
    const runtimes = main.indexOf('runtimes: [', shutdown);
    const end = main.indexOf('smokeServer:', runtimes);
    expect(shutdown).toBeGreaterThan(-1);
    expect(main.slice(runtimes, end)).toContain('{ shutdown: reason => mediaConverter?.shutdown(reason) ?? Promise.resolve() }]');
    expect(main.match(/registerMediaConverter\(/g)).toHaveLength(1);
  });

  it('exposes window.mediaConverter and guards its channels on both checks of the legacy bridge', () => {
    const preload = read('electron/preload/index.ts');
    expect(preload).toContain("exposeInMainWorld('mediaConverter', createMediaConverterApi(ipcRenderer, webUtils))");
    const command = preload.slice(preload.indexOf('const assertLegacyIpcChannelAllowed'), preload.indexOf('const assertLegacyListenChannelAllowed'));
    const listen = preload.slice(preload.indexOf('const assertLegacyListenChannelAllowed'), preload.indexOf('// --------- Expose some API'));
    expect(command.match(/^ {2}assertLegacyMediaConverterChannelAllowed\(channel\)$/gm)).toHaveLength(1);
    expect(listen.match(/^ {2}assertLegacyMediaConverterChannelAllowed\(channel\)$/gm)).toHaveLength(1);
    expect(read('src/vite-env.d.ts')).toContain("mediaConverter?: import('./media-converter/contract').MediaConverterApi;");
  });

  it('refuses every media-converter: channel on the legacy ipcRenderer bridge', async () => {
    const ipcRenderer = { on: vi.fn(), off: vi.fn(), send: vi.fn(), invoke: vi.fn() };
    const bridge = createSafeLegacyIpcBridge({
      ipcRenderer: ipcRenderer as never,
      assertListenChannelAllowed: assertLegacyMediaConverterChannelAllowed,
      assertCommandChannelAllowed: assertLegacyMediaConverterChannelAllowed,
    });
    for (const channel of [...Object.values(C), 'media-converter:anything-else']) {
      await expect(bridge.invoke(channel, VALID_REQUESTS[channel] ?? {})).rejects.toThrow('restricted');
      expect(() => bridge.send(channel, {})).toThrow('restricted');
      expect(() => bridge.on(channel, () => undefined)).toThrow('restricted');
      expect(() => bridge.off(channel, () => undefined)).toThrow('restricted');
    }
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(ipcRenderer.send).not.toHaveBeenCalled();
    expect(ipcRenderer.on).not.toHaveBeenCalled();
    // Other channels are left to the bridge's other guards.
    await bridge.invoke('show-item-in-folder', 'x');
    expect(ipcRenderer.invoke).toHaveBeenCalledOnce();
  });

  it('exposes one method per request channel, supported on Windows only', () => {
    const ipc = { invoke: vi.fn(async () => ({ ok: true, value: {} })), on: vi.fn(), removeListener: vi.fn() };
    const files = { getPathForFile: vi.fn(() => '') };
    const api = createMediaConverterApi(ipc, files, 'win32');
    expect(Object.isFrozen(api)).toBe(true);
    const methods = Object.keys(C).filter(key => key !== 'changed');
    expect(Object.keys(api).sort()).toEqual([...methods, 'onChanged', 'supported'].sort());
    expect(api.supported).toBe(true);

    // `supported` reads the platform the preload runs on.
    expect(onPlatform('darwin', () => createMediaConverterApi(ipc, files).supported)).toBe(false);
    expect(onPlatform('linux', () => createMediaConverterApi(ipc, files).supported)).toBe(false);
    expect(onPlatform('win32', () => createMediaConverterApi(ipc, files).supported)).toBe(true);
  });

  it('registers every channel on Windows, serves the snapshot and persists through the shared shutdown', async () => {
    const dir = await userData('win32');
    // A test build's capability switch: no test encode runs, and the runtime is not verified.
    process.env.NODE_ENV = 'test';
    process.env[TEST_MEDIA_CAPS_ENV] = 'unavailable:runtime_missing';
    const { handlers, registration, call, trusted } = setup('win32', dir);
    expect([...handlers.keys()].sort()).toEqual([...REQUEST_CHANNELS].sort());
    await registration.ready;
    expect((await readdir(path.join(dir, 'media-converter'))).sort()).toEqual(['work']);

    const snapshot = await call(C.getSnapshot, {});
    expect(snapshot.ok).toBe(true);
    const value = mediaConverterSnapshotSchema.parse((snapshot as { value: unknown }).value);
    await vi.waitFor(async () => {
      const latest = await call(C.getSnapshot, {});
      expect(latest.ok && mediaConverterSnapshotSchema.parse(latest.value).engine).toEqual({
        runtime: { state: 'unavailable', code: 'runtime_missing' }, capabilities: { state: 'unavailable', code: 'runtime_missing' },
      });
    });
    expect(value.items).toEqual([]);
    expect(value.defaults).toEqual({ compressCodec: 'h264' });
    // The default trust: another sender, and a frame of the window that is not its main frame, are refused.
    expect(await call(C.getSnapshot, {}, { ...trusted, sender: { isDestroyed: () => false, getURL: () => `${APP_URL}/` } })).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect(await call(C.getSnapshot, {}, { ...trusted, senderFrame: { ...trusted.senderFrame } })).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect(await call(C.getSnapshot, {}, { ...trusted, senderFrame: null })).toEqual({ ok: false, error: { code: 'invalid_request' } });
    expect(await call(C.setOptions, { lowUsage: true })).toEqual({ ok: true, value: { concurrency: 1, lowUsage: true } });

    await registration.shutdown('app_quit');
    expect(registration.shutdown('update')).toBe(registration.shutdown('app_quit'));
    const state = JSON.parse(await readFile(path.join(dir, 'media-converter', 'state.json'), 'utf8'));
    expect(state.options).toEqual({ concurrency: 1, lowUsage: true });
    // Once the shutdown began, every request is turned away.
    expect(await call(C.getSnapshot, {})).toEqual({ ok: false, error: { code: 'busy' } });
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
    expect(runtimeVerification.verify).not.toHaveBeenCalled();
  });

  it('verifies the runtime and detects the encoders only on demand, never at registration (AC-ENGINE-01-1)', async () => {
    const dir = await userData('win32-lazy');
    // No test switch: the real runtime verification and detection would run if anything asked for them.
    delete process.env[TEST_MEDIA_CAPS_ENV];
    const { registration, call } = setup('win32', dir);
    await registration.ready;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runtimeVerification.verify).not.toHaveBeenCalled();
    expect(electron.app.getGPUInfo).not.toHaveBeenCalled();
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect((await readdir(path.join(dir, 'media-converter'))).sort()).toEqual(['work']);
    await registration.shutdown('app_quit');
    expect(await call(C.getSnapshot, {})).toEqual({ ok: false, error: { code: 'busy' } });
    expect(runtimeVerification.verify).not.toHaveBeenCalled();
    expect(electron.app.getGPUInfo).not.toHaveBeenCalled();
  });

  it('cancels a running conversion at shutdown, waits for it to clean up and keeps it interrupted (AC-ENGINE-05-4)', async () => {
    const dir = await userData('shutdown-run');
    const media = path.join(dir, 'media');
    await mkdir(media);
    const input = path.join(media, 'clip.mp4');
    await writeFile(input, 'clip');
    process.env.NODE_ENV = 'test';
    process.env[TEST_MEDIA_CAPS_ENV] = 'cpu_only';
    // The production composition with only the edges replaced: no runtime is verified, no ffprobe or ffmpeg runs.
    const acquire = vi.spyOn(MediaRuntime.prototype, 'acquire').mockResolvedValue({} as MediaTools);
    const probe = vi.spyOn(MediaProber.prototype, 'probe').mockResolvedValue({ ok: true, info: MEDIA });
    const probesEnded = vi.spyOn(MediaProber.prototype, 'dispose');
    const partials: string[] = [];
    let aborted = false;
    let running!: () => void;
    const started = new Promise<void>(resolve => { running = resolve; });
    // As the executor does on a cancel: ffmpeg is ended, then its partial removed, then the run settles.
    const run = vi.spyOn(MediaConversionExecutor.prototype, 'run').mockImplementation(async (job, hooks) => {
      const partial = path.join(job.targets[0].directory, '.fusionkit-media-0badf00d.partial');
      await writeFile(partial, 'partial');
      partials.push(partial);
      running();
      await new Promise<void>(resolve => hooks.signal.addEventListener('abort', () => resolve(), { once: true }));
      aborted = true;
      await new Promise(resolve => setTimeout(resolve, 100));
      await rm(partial);
      return { status: 'cancelled' };
    });
    try {
      const { registration, call } = setup('win32', dir);
      await registration.ready;
      electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
      const added = await call(C.pickFiles, { filter: 'video' });
      const [id] = addFilesResultSchema.parse((added as { value: unknown }).value).added;
      const stateOf = async () => {
        const snapshot = await call(C.getSnapshot, {});
        return snapshot.ok ? mediaConverterSnapshotSchema.parse(snapshot.value).items.find(item => item.id === id)?.state.status : undefined;
      };
      await vi.waitFor(async () => expect(await stateOf()).toBe('idle'));
      const start = await call(C.start, { ...(VALID_REQUESTS[C.start] as object), itemIds: [id] });
      expect(start).toMatchObject({ ok: true, value: { started: [id] } });
      await started;
      expect(await stateOf()).toBe('running');
      expect(electron.powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');

      const begun = Date.now();
      await registration.shutdown('app_quit');
      // The run was told to stop, and the shutdown waited for it to remove its partial, well within the 4 s wait.
      expect(aborted).toBe(true);
      expect(Date.now() - begun).toBeLessThan(4_000);
      await expect(access(partials[0])).rejects.toThrow();
      expect(electron.powerSaveBlocker.stop).toHaveBeenCalledWith(1);
      expect(probesEnded).toHaveBeenCalledOnce();
      const state = JSON.parse(await readFile(path.join(dir, 'media-converter', 'state.json'), 'utf8'));
      expect(state.items.map((item: { id: string; state: unknown }) => [item.id, item.state])).toEqual([[id, { status: 'interrupted' }]]);
      expect(await call(C.getSnapshot, {})).toEqual({ ok: false, error: { code: 'busy' } });
      expect(run).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalled();
      expect(probe).toHaveBeenCalledWith(input);
    } finally {
      acquire.mockRestore();
      probe.mockRestore();
      probesEnded.mockRestore();
      run.mockRestore();
    }
  });

  it('passes the shutdown reason to the queue, stops the detection and ends the probes last', async () => {
    const dir = await userData('shutdown-order');
    process.env.NODE_ENV = 'test';
    process.env[TEST_MEDIA_CAPS_ENV] = 'unavailable:runtime_invalid';
    const order: string[] = [];
    let releaseQueue!: () => void;
    // The queue's shutdown (cancel, wait for ffmpeg and the partials, write the state) is held open to see what waits for it.
    const queueShutdown = vi.spyOn(MediaQueue.prototype, 'shutdown').mockImplementation(reason => {
      order.push(`queue:${reason}`);
      return new Promise<void>(resolve => { releaseQueue = resolve; });
    });
    const detection = vi.spyOn(MediaCapabilities.prototype, 'dispose').mockImplementation(async () => { order.push('capabilities'); });
    const probes = vi.spyOn(MediaProber.prototype, 'dispose').mockImplementation(() => { order.push('prober'); });
    try {
      const { registration } = setup('win32', dir);
      await registration.ready;
      const stopping = registration.shutdown('update');
      await new Promise(resolve => setTimeout(resolve, 20));
      // The probes are ended only once the queue has settled its runs (an output read back during the wait stays possible).
      expect(order).toEqual(['queue:update', 'capabilities']);
      releaseQueue();
      await stopping;
      expect(order).toEqual(['queue:update', 'capabilities', 'prober']);
      expect(queueShutdown).toHaveBeenCalledOnce();
      expect(detection).toHaveBeenCalledOnce();
      expect(probes).toHaveBeenCalledOnce();
    } finally {
      queueShutdown.mockRestore();
      detection.mockRestore();
      probes.mockRestore();
    }
  });

  it('answers platform_unsupported on every channel on darwin and touches nothing', async () => {
    const dir = await userData('darwin');
    const { handlers, registration, call, trusted } = setup('darwin', dir);
    expect([...handlers.keys()].sort()).toEqual([...REQUEST_CHANNELS].sort());
    await registration.ready;
    const unsupported = { ok: false, error: { code: 'platform_unsupported' } };
    const untrusted = { ...trusted, senderFrame: { url: 'https://evil.example/', parent: {} } };
    for (const channel of REQUEST_CHANNELS) {
      expect(await call(channel, VALID_REQUESTS[channel]), channel).toEqual(unsupported);
      expect(await call(channel, { malformed: true }), channel).toEqual(unsupported);
      expect(await call(channel, VALID_REQUESTS[channel], untrusted), channel).toEqual(unsupported);
    }
    // No runtime verification, no probe, no dialog, no state folder.
    expect(runtimeVerification.verify).not.toHaveBeenCalled();
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled();
    expect(electron.app.getGPUInfo).not.toHaveBeenCalled();
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
    await registration.shutdown('app_quit');
    expect(registration.shutdown('update')).toBe(registration.shutdown('app_quit'));
    expect(await call(C.getSnapshot, {})).toEqual(unsupported);

    // The preload of that platform says so before any request.
    const ipc = { invoke: vi.fn(async (channel: string, payload: unknown) => call(channel, payload)), on: vi.fn(), removeListener: vi.fn() };
    const api = onPlatform('darwin', () => createMediaConverterApi(ipc, { getPathForFile: () => 'C:\\Media\\clip.mp4' }));
    expect(api.supported).toBe(false);
    expect(await api.getSnapshot()).toEqual(unsupported);
    expect(await api.addDroppedFiles([{}] as unknown as File[])).toEqual(unsupported);
  });
});
