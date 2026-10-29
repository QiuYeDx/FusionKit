import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MEDIA_CONVERTER_CHANNELS, mediaConverterEventSchema } from '../../src/media-converter/channels';
import {
  QUEUE_LIMITS, addFilesResultSchema, defaultCompressSettings, mediaConverterSnapshotSchema, mediaInfoSchema, pickOutputDirectoryResultSchema,
  previewPlanResultSchema,
  type ConversionSettings, type MediaConverterResult, type MediaInfo, type QueueEvent,
} from '../../src/media-converter/contract';
import { MediaCapabilities } from '../../electron/main/media-converter/engine/capabilities';
import { InputRegistry, type DropResolveOptions } from '../../electron/main/media-converter/engine/inputs';
import type { ProbeOutcome } from '../../electron/main/media-converter/engine/probe';
import type { MediaTools } from '../../electron/main/media-converter/engine/runtime';
import {
  MEDIA_CONVERTER_METHODS, MediaConverterRequestError, createMediaConverterHandlers, mainWindowTrust, mediaConverterEventSender, mediaConverterRevealer,
  pickFileFilters, registerMediaConverterIpc, toMediaConverterError, type MediaConverterHandlers,
} from '../../electron/main/media-converter/ipc';
import { buildPlan } from '../../electron/main/media-converter/plan/stream-plan';
import { MediaQueue } from '../../electron/main/media-converter/queue/queue';
import { MediaQueueError, type ExecutionHooks, type ExecutionJob, type ExecutionOutcome, type MediaExecutor } from '../../electron/main/media-converter/queue/types';
import { createMediaConverterApi } from '../../electron/preload/media-converter-api';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * The `media-converter:` IPC (T-ENGINE-06, design §8, R-ENGINE-07) over the real queue, input
 * registry and capability table (its `cpu_only` test table over a fake runtime, so no ffmpeg runs),
 * with a fake executor and prober: only the main frame of the application window is served, every
 * malformed request is `invalid_request` and reaches no handler, the renderer cannot hand over a
 * path, "show in folder" opens only this tool's outputs, the drop wrapper's codes (folders, and a
 * %TEMP% copy the resolver cannot trace refused while the rest of the drop is added), and the
 * snapshot and events carry redacted logs without any absolute path. Inputs are real files in a
 * run folder under test-results/media-converter (drops never come from %TEMP%: FK-PIT-0099).
 */

const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const APP_URL = 'http://localhost:5173';
const C = MEDIA_CONVERTER_CHANNELS;
const REQUEST_CHANNELS = Object.entries(C).filter(([key]) => key !== 'changed').map(([, channel]) => channel);
const INVALID = { ok: false, error: { code: 'invalid_request' } };
let root: string;
let runs = 0;
let devServerUrl: string | undefined;

/** A 2 s H.264/AAC MP4 as the probe would describe it. */
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
/** A remux into MKV: no video encoder involved. */
const TO_MKV: ConversionSettings = Object.freeze({ task: 'convert', target: 'mkv', preferRemux: true, tier: 'balanced' });
/** MP4 to MP4 copying every stream: `already_target`. */
const TO_MP4: ConversionSettings = Object.freeze({ task: 'convert', target: 'mp4', preferRemux: true, tier: 'balanced' });
const NO_CONFIRMATION = { lossyToLossless: [], replaceExisting: false };
const startRequest = (itemIds: string[], settings: ConversionSettings = TO_MKV) => ({ itemIds, settings, output: { mode: 'source', conflict: 'number' }, confirmed: NO_CONFIRMATION });

/** Absolute paths of any form: drive letters with either slash, UNC shares, `\\?\` and file URLs. */
const ABSOLUTE_PATH = /[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|file:\/\//;

type Handler = (event: unknown, input?: unknown) => Promise<MediaConverterResult<unknown>>;

/** A window's webContents: its main frame shows `url` (a test may navigate it by changing `mainFrame.url`). */
function contents(url = `${APP_URL}/#/tools/media/converter`) {
  const mainFrame = { url, parent: null };
  return { isDestroyed: vi.fn(() => false), getURL: () => mainFrame.url, send: vi.fn(), mainFrame };
}

/** Each run ends with whatever `outcome` answers; by default every output is published under its target name. */
class FakeExecutor implements MediaExecutor {
  readonly jobs: ExecutionJob[] = [];
  outcome: (job: ExecutionJob, hooks: ExecutionHooks) => Promise<ExecutionOutcome> = async job => {
    const outputs = [];
    for (const [index, target] of job.targets.entries()) {
      const file = path.join(target.directory, `${target.baseName}.${target.extension}`);
      await writeFile(file, 'converted');
      outputs.push({ index, path: file, sizeBytes: 9, replaced: false });
    }
    return { status: 'succeeded', outputs, warnings: [] };
  };
  run(job: ExecutionJob, hooks: ExecutionHooks) {
    this.jobs.push(job);
    return this.outcome(job, hooks);
  }
}

interface HarnessOptions {
  drop?: DropResolveOptions;
}

/** The real queue and capability table behind the real handlers and IPC registration, over a fresh run folder with `files` as inputs. */
async function harness(name: string, files: string[] = [], options: HarnessOptions = {}) {
  const dir = path.join(root, `${String(++runs).padStart(2, '0')}-${name}`);
  const media = path.join(dir, 'media');
  const state = path.join(dir, 'state');
  await mkdir(media, { recursive: true });
  for (const file of files) await writeFile(path.join(media, file), `content of ${file}`);
  const file = (fileName: string) => path.join(media, fileName);

  const window = { isDestroyed: vi.fn(() => false), webContents: contents() };
  const getWindow = () => window as never;
  const runtime = {
    acquire: vi.fn(async () => ({}) as MediaTools),
    run: vi.fn(async () => { throw new Error('No ffmpeg runs in this test.'); }),
    status: () => ({ state: 'ready', version: 'n8.1.2' }) as const,
  };
  let queue: MediaQueue | undefined;
  const capabilities = new MediaCapabilities({
    runtime, root: state, override: { kind: 'cpu_only' }, log: () => {}, gpuInfo: async () => null,
    isHardwareEncodeRunning: () => queue?.isHardwareEncodeRunning() ?? false,
  });
  const ensure = vi.spyOn(capabilities, 'ensure');
  const prober = { probe: vi.fn(async (_filePath: string): Promise<ProbeOutcome> => ({ ok: true, info: MEDIA })) };
  const executor = new FakeExecutor();
  const inputs = new InputRegistry();
  const power = { start: vi.fn(() => 1), stop: vi.fn() };
  queue = new MediaQueue({
    root: state, inputs, prober, capabilities, executor, wouldReplace: async () => null, powerSaveBlocker: power, log: () => {},
    emit: mediaConverterEventSender(getWindow),
  });
  const dialog = { showOpenDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePaths: [] as string[] })) };
  const reveal = vi.fn();
  const real = createMediaConverterHandlers({ queue, capabilities, dialog: dialog as never, getWindow, reveal, drop: options.drop, log: () => {} });
  /** The real handlers, each wrapped in a spy. */
  const handlers: Record<string, Mock> = Object.fromEntries(Object.entries(real).map(([method, handler]) => [method, vi.fn(handler)]));
  const ipcHandlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => { ipcHandlers.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel); }),
  };
  const registration = registerMediaConverterIpc({
    ipc: ipc as never, handlers: handlers as unknown as MediaConverterHandlers, ready: queue.restore(), trust: mainWindowTrust(getWindow), log: () => {},
  });
  const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const call = (channel: string, input?: unknown, event: unknown = trusted) => ipcHandlers.get(channel)!(event, input);
  /** The renderer's `window.mediaConverter`, wired to the handlers above as the application window. */
  const api = (files: { getPathForFile(file: File): string } = filePaths()) => createMediaConverterApi({
    invoke: (channel: string, payload?: unknown) => call(channel, payload),
    on: vi.fn(), removeListener: vi.fn(),
  }, files, 'win32');
  const snapshot = async () => {
    const result = await call(C.getSnapshot, {});
    if (!result.ok) throw new Error(`get-snapshot failed: ${result.error.code}`);
    return mediaConverterSnapshotSchema.parse(result.value);
  };
  /** Every payload sent to the application window. */
  const sent = () => window.webContents.send.mock.calls.map(([channel, payload]) => ({ channel, payload }));
  return { dir, media, state, file, window, runtime, capabilities, ensure, prober, executor, queue, inputs, dialog, reveal, handlers, ipc, ipcHandlers, registration, trusted, call, api, snapshot, sent };
}
type Harness = Awaited<ReturnType<typeof harness>>;

/** A `File` of a drop: `webUtils.getPathForFile` knows its path, and refuses anything that is not a `File`. */
class FakeFile {
  constructor(readonly name: string, readonly diskPath: string) {}
}
function filePaths() {
  return {
    getPathForFile: vi.fn((file: File) => {
      if (!(file instanceof FakeFile)) throw new TypeError("Failed to execute 'getPathForFile': parameter 1 is not of type 'File'.");
      return file.diskPath;
    }),
  };
}
const dropOf = (...entries: [string, string][]) => entries.map(([name, diskPath]) => new FakeFile(name, diskPath)) as unknown as File[];

async function addFiles(h: Harness, names: string[]): Promise<string[]> {
  const result = await h.api().addDroppedFiles(dropOf(...names.map(name => [name, h.file(name)] as [string, string])));
  if (!result.ok) throw new Error(`add failed: ${result.error.code}`);
  expect(result.value.added).toHaveLength(names.length);
  await h.queue.drain();
  return result.value.added;
}
const stateOf = async (h: Harness, id: string) => (await h.snapshot()).items.find(item => item.id === id)?.state;

beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'ipc-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'ipc-')));
});
afterAll(async () => {
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});
beforeEach(() => {
  devServerUrl = process.env.VITE_DEV_SERVER_URL;
  process.env.VITE_DEV_SERVER_URL = APP_URL;
});
afterEach(() => {
  if (devServerUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
  else process.env.VITE_DEV_SERVER_URL = devServerUrl;
  vi.restoreAllMocks();
});

// ── Trust and validation (AC-ENGINE-07-1) ──────────────────────────────────────────────────────

describe('media converter IPC: who and what is served', () => {
  it('registers one handler per request channel and removes them all on dispose', async () => {
    const h = await harness('channels');
    expect([...h.ipcHandlers.keys()].sort()).toEqual([...REQUEST_CHANNELS].sort());
    expect(MEDIA_CONVERTER_METHODS.map(method => C[method]).sort()).toEqual([...REQUEST_CHANNELS].sort());
    h.registration.dispose();
    expect(h.ipcHandlers.size).toBe(0);
  });

  it('serves only the main frame of the application window, and nothing else reaches a handler', async () => {
    const h = await harness('trust', ['a.mp4']);
    expect((await h.call(C.getSnapshot, {})).ok).toBe(true);
    const add = { paths: [h.file('a.mp4')] };
    const other = contents();
    const appPage = h.window.webContents.mainFrame.url;
    const untrusted: [string, unknown][] = [
      // Another window, even one showing the app's own page.
      ['another window', { sender: other, senderFrame: other.mainFrame }],
      // A child frame of the application window, on the app's own origin.
      ['child frame', { ...h.trusted, senderFrame: { url: appPage, parent: h.window.webContents.mainFrame } }],
      // A frame of the window that is not its main frame, even with no parent and the app's own page.
      ['not the main frame', { ...h.trusted, senderFrame: { url: appPage, parent: null } }],
      // The sending frame navigated or went away before the request arrived: no frame to judge, only the window's URL.
      ['frame gone', { ...h.trusted, senderFrame: null }],
      ['no frame', { sender: h.window.webContents }],
      // No frame information at all, from a page elsewhere.
      ['page elsewhere', { sender: contents('https://evil.example/') }],
    ];
    const refuse = async (name: string, event: unknown) => {
      expect(await h.call(C.addDroppedFiles, add, event), name).toEqual(INVALID);
      expect(await h.call(C.getSnapshot, {}, event), name).toEqual(INVALID);
      expect(await h.call(C.setOptions, { lowUsage: true }, event), name).toEqual(INVALID);
    };
    for (const [name, event] of untrusted) await refuse(name, event);
    // The application window's main frame showing another page, or a file page that is not the app's own.
    for (const url of ['https://evil.example/', 'file:///C:/Users/Public/evil.html']) {
      h.window.webContents.mainFrame.url = url;
      await refuse(url, h.trusted);
    }
    h.window.webContents.mainFrame.url = appPage;
    // The application window once destroyed, and no window at all.
    h.window.webContents.isDestroyed.mockReturnValue(true);
    expect(await h.call(C.getSnapshot, {})).toEqual(INVALID);
    h.window.webContents.isDestroyed.mockReturnValue(false);
    h.window.isDestroyed.mockReturnValue(true);
    expect(await h.call(C.getSnapshot, {})).toEqual(INVALID);
    h.window.isDestroyed.mockReturnValue(false);

    for (const handler of Object.values(h.handlers)) expect(handler).toHaveBeenCalledTimes(handler === h.handlers.getSnapshot ? 1 : 0);
    expect(h.queue.snapshot().items).toEqual([]);
    expect(h.queue.options.lowUsage).toBe(false);
    // The trusted frame still is.
    expect((await h.call(C.addDroppedFiles, add)).ok).toBe(true);
  });

  it('answers every malformed request with invalid_request without running anything', async () => {
    const h = await harness('invalid', ['a.mp4']);
    const [a] = await addFiles(h, ['a.mp4']);
    for (const handler of Object.values(h.handlers)) handler.mockClear();
    const malformed: [string, unknown][] = [
      [C.getSnapshot, undefined], [C.getSnapshot, null], [C.getSnapshot, 'snapshot'], [C.getSnapshot, { extra: true }],
      [C.addDroppedFiles, {}], [C.addDroppedFiles, { paths: [] }], [C.addDroppedFiles, { paths: [h.file('a.mp4'), 7] }],
      [C.addDroppedFiles, { paths: [`${h.file('a.mp4')}\0.txt`] }],
      [C.addDroppedFiles, { paths: Array.from({ length: QUEUE_LIMITS.filesPerAdd + 1 }, (_, index) => h.file(`f${index}.mp4`)) }],
      [C.pickFiles, {}], [C.pickFiles, { filter: 'exe' }], [C.pickFiles, { filter: 'all', extra: 1 }],
      [C.pickOutputDirectory, { title: 'x' }],
      [C.previewPlan, { itemId: a }], [C.previewPlan, { itemId: 'not an id', settings: TO_MKV }], [C.previewPlan, { itemId: a, settings: { ...TO_MKV, target: 'exe' } }],
      [C.start, { ...startRequest([a]), extra: true }], [C.start, startRequest([])], [C.start, startRequest([a, a])],
      [C.start, { ...startRequest([a]), output: { mode: 'directory', conflict: 'number' } }],
      [C.cancel, { itemIds: [] }], [C.cancel, { itemIds: ['../a'] }], [C.remove, { itemIds: 'a' }],
      [C.retry, { itemIds: [a], override: 'output_cap_exceeded' }], [C.clear, { scope: 'everything' }],
      [C.revealOutput, { itemId: a, outputIndex: -1 }], [C.revealOutput, { itemId: a, outputIndex: 0.5 }], [C.revealOutput, {}],
      [C.setOptions, { concurrency: 3 }], [C.setOptions, { lowUsage: 'yes' }], [C.setOptions, { priority: 'high' }],
      [C.redetectCapabilities, { force: true }],
    ];
    for (const [channel, input] of malformed) expect(await h.call(channel, input), `${channel} ${JSON.stringify(input)}`).toEqual(INVALID);
    for (const handler of Object.values(h.handlers)) expect(handler).not.toHaveBeenCalled();
    expect(h.executor.jobs).toEqual([]);
    expect(h.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(h.queue.options).toEqual({ concurrency: 1, lowUsage: false });
  });

  it('never takes a path from the renderer', async () => {
    const h = await harness('no-renderer-paths', ['a.mp4', 'b.mp4']);
    const [a] = await addFiles(h, ['a.mp4']);
    const before = h.queue.snapshot().items.length;
    // No request schema has a field for a path: every attempt is refused before any handler.
    const attempts: [string, unknown][] = [
      [C.pickFiles, { filter: 'all', paths: [h.file('b.mp4')] }],
      [C.pickOutputDirectory, { directory: h.media }],
      [C.start, { ...startRequest([a]), output: { mode: 'directory', directoryId: h.media, conflict: 'number' } }],
      [C.start, { ...startRequest([a]), output: { mode: 'source', conflict: 'number', directory: h.media } }],
      [C.previewPlan, { itemId: a, settings: TO_MKV, path: h.file('b.mp4') }],
      [C.revealOutput, { itemId: a, path: h.file('a.mp4') }],
      [C.revealOutput, { itemId: h.file('a.mp4') }],
      [C.cancel, { itemIds: [h.file('b.mp4')] }],
    ];
    for (const [channel, input] of attempts) expect(await h.call(channel, input), channel).toEqual(INVALID);

    // The preload sends only the paths of dropped `File`s: strings and look-alike objects are refused, and no IPC is made.
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, value: { added: [], duplicates: [], rejected: [], truncated: 0 } }));
    const files = filePaths();
    const api = createMediaConverterApi({ invoke, on: vi.fn(), removeListener: vi.fn() }, files, 'win32');
    const forged = [h.file('b.mp4'), { name: 'b.mp4', path: h.file('b.mp4') }, { name: 'b.mp4', diskPath: h.file('b.mp4') }] as unknown as File[];
    expect(await api.addDroppedFiles(forged)).toEqual({
      ok: true, value: { added: [], duplicates: [], rejected: forged.map((_, index) => ({ displayName: index === 0 ? '—' : 'b.mp4', code: 'file_unavailable' })), truncated: 0 },
    });
    expect(await api.addDroppedFiles([] as File[])).toEqual(INVALID);
    expect(await api.addDroppedFiles('C:\\Windows\\win.ini' as unknown as File[])).toEqual(INVALID);
    expect(invoke).not.toHaveBeenCalled();
    // Every other method passes its request on unchanged, to its own fixed channel, where the schema decides.
    const methods = Object.keys(api).filter(key => key !== 'supported' && key !== 'onChanged' && key !== 'addDroppedFiles');
    for (const method of methods) await (api as unknown as Record<string, (request?: unknown) => Promise<unknown>>)[method]({ probe: method });
    expect(invoke.mock.calls.map(([channel]) => channel).sort()).toEqual(REQUEST_CHANNELS.filter(channel => channel !== C.addDroppedFiles).sort());
    for (const [channel, payload] of invoke.mock.calls as unknown as [string, unknown][]) {
      const method = Object.entries(C).find(([, value]) => value === channel)![0];
      expect(payload).toEqual(['getSnapshot', 'pickOutputDirectory', 'redetectCapabilities'].includes(method) ? {} : { probe: method });
    }
    expect(h.queue.snapshot().items).toHaveLength(before);
  });

  it('waits for the restore, answers busy once closed, and reports unexpected errors as a code only', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const getSnapshot = vi.fn(async () => ({ sequence: 0 }));
    const handlers = Object.fromEntries(MEDIA_CONVERTER_METHODS.map(method => [method, vi.fn(async () => { throw new Error(`C:\\secret\\${method}`); })])) as unknown as MediaConverterHandlers;
    (handlers as unknown as Record<string, unknown>).getSnapshot = getSnapshot;
    const map = new Map<string, Handler>();
    const log = vi.fn();
    const registration = registerMediaConverterIpc({ ipc: { handle: (channel: string, handler: Handler) => map.set(channel, handler), removeHandler: vi.fn() } as never,
      handlers, ready, trust: () => true, log });
    let settled = false;
    const pending = map.get(C.getSnapshot)!({}, {}).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(getSnapshot).not.toHaveBeenCalled();
    release();
    expect(await pending).toEqual({ ok: true, value: { sequence: 0 } });

    const failed = await map.get(C.setOptions)!({}, { lowUsage: true });
    expect(failed).toEqual({ ok: false, error: { code: 'unknown' } });
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(log).toHaveBeenCalledOnce();
    expect(toMediaConverterError(new MediaQueueError('busy', 'Shutting down.'), log)).toEqual({ code: 'busy' });
    expect(toMediaConverterError(new MediaConverterRequestError('task_not_applicable', 'No.'), log)).toEqual({ code: 'task_not_applicable' });

    registration.close();
    expect(await map.get(C.getSnapshot)!({}, {})).toEqual({ ok: false, error: { code: 'busy' } });
    expect(getSnapshot).toHaveBeenCalledOnce();
  });
});

// ── Drops and dialogs (AC-ENGINE-07-2) ─────────────────────────────────────────────────────────

describe('media converter IPC: adding files', () => {
  it('reads every dropped path at once, sends the first 100 and counts the rest', async () => {
    const order: string[] = [];
    const files = { getPathForFile: vi.fn((file: File) => { order.push('path'); return (file as unknown as FakeFile).diskPath; }) };
    const invoke = vi.fn(async (_channel: string, payload: unknown) => {
      order.push('invoke');
      const count = (payload as { paths: string[] }).paths.length;
      return { ok: true, value: { added: Array.from({ length: count - 2 }, (_, index) => `item-${index}`), duplicates: [], rejected: [], truncated: 2 } };
    });
    const api = createMediaConverterApi({ invoke, on: vi.fn(), removeListener: vi.fn() }, files, 'win32');
    const drop = Array.from({ length: 103 }, (_, index) => new FakeFile(`clip ${index}.mp4`, index === 1 ? '' : `D:\\Media\\clip ${index}.mp4`)) as unknown as File[];
    const pending = api.addDroppedFiles(drop);
    // Synchronously, before the call returned control: the drop's files may be gone after the first await.
    expect(files.getPathForFile).toHaveBeenCalledTimes(100);
    const result = await pending;
    expect(order).toEqual([...Array(100).fill('path'), 'invoke']);
    const sent = (invoke.mock.calls[0][1] as { paths: string[] }).paths;
    expect(invoke).toHaveBeenCalledWith(C.addDroppedFiles, { paths: expect.any(Array) });
    expect(sent).toHaveLength(99);
    expect(sent).not.toContain('');
    expect(result).toEqual({
      ok: true,
      value: { added: expect.any(Array), duplicates: [], rejected: [{ displayName: 'clip 1.mp4', code: 'file_unavailable' }], truncated: 2 + 3 },
    });
    expect(addFilesResultSchema.safeParse((result as { value: unknown }).value).success).toBe(true);
  });

  it('refuses a dropped folder, a missing file and a link, and adds the rest', async () => {
    const h = await harness('drop-codes', ['a.mp4', 'target.mp4']);
    const folder = path.join(h.media, 'Season 1');
    await mkdir(folder);
    const link = path.join(h.media, 'link.mp4');
    let linked = true;
    try { await symlink(h.file('target.mp4'), link, 'file'); } catch { linked = false; }
    const entries: [string, string][] = [['Season 1', folder], ['a.mp4', h.file('a.mp4')], ['gone.mp4', h.file('gone.mp4')], ...(linked ? [['link.mp4', link] as [string, string]] : [])];
    // The real Explorer drop resolver: none of these paths is in %TEMP%.
    const result = await h.api().addDroppedFiles(dropOf(...entries));
    expect(result.ok).toBe(true);
    const value = addFilesResultSchema.parse((result as { value: unknown }).value);
    expect(value.added).toHaveLength(1);
    expect(value.rejected).toEqual([
      { displayName: 'Season 1', code: 'folder_not_supported' },
      { displayName: 'gone.mp4', code: 'file_unavailable' },
      ...(linked ? [{ displayName: 'link.mp4', code: 'not_a_regular_file' }] : []),
    ]);
    await h.queue.drain();
    const items = (await h.snapshot()).items;
    expect(items.map(item => [item.displayName, item.state.status])).toEqual([['a.mp4', 'idle']]);
    // The same file again is a duplicate: its existing item, no new one.
    const again = await h.api().addDroppedFiles(dropOf(['a.mp4', h.file('a.mp4')]));
    expect(again).toEqual({ ok: true, value: { added: [], duplicates: value.added, rejected: [], truncated: 0 } });
  });

  it('refuses only the %TEMP% copy the resolver cannot trace, and adds the file dropped with it', async () => {
    const temp = path.join(root, 'simulated-temp');
    await mkdir(temp, { recursive: true });
    await writeFile(path.join(temp, 'proxy.mp4'), 'Explorer proxy');
    // As the resolver answers when a %TEMP% proxy cannot be matched to an Explorer selection: the whole batch refused.
    const resolve = vi.fn(async (paths: readonly string[]) => paths.map(filePath => ({ fileName: path.basename(filePath), error: 'access_denied' as const })));
    const h = await harness('drop-temp', ['normal.mp4'], { drop: { resolve, tempDirectory: temp } });
    const result = await h.api().addDroppedFiles(dropOf(['proxy.mp4', path.join(temp, 'proxy.mp4')], ['normal.mp4', h.file('normal.mp4')]));
    expect(resolve).toHaveBeenCalledWith([path.join(temp, 'proxy.mp4'), h.file('normal.mp4')]);
    expect(result.ok).toBe(true);
    const value = addFilesResultSchema.parse((result as { value: unknown }).value);
    expect(value.added).toHaveLength(1);
    expect(value.rejected).toEqual([{ displayName: 'proxy.mp4', code: 'temporary_copy_unresolved' }]);
    await h.queue.drain();
    expect((await h.snapshot()).items.map(item => item.displayName)).toEqual(['normal.mp4']);
    expect(h.prober.probe.mock.calls.map(([filePath]) => filePath)).toEqual([h.file('normal.mp4')]);

    // The same with the real %TEMP% folder: only its name is used, nothing is written there.
    const real = await harness('drop-real-temp', ['other.mp4'], { drop: { resolve } });
    const proxy = path.join(await realpath(os.tmpdir()), 'fusionkit-media-proxy-that-is-never-created.mp4');
    const answer = await real.api().addDroppedFiles(dropOf(['proxy.mp4', proxy], ['other.mp4', real.file('other.mp4')]));
    expect(answer).toEqual({ ok: true, value: { added: [expect.any(String)], duplicates: [], rejected: [{ displayName: path.basename(proxy), code: 'temporary_copy_unresolved' }], truncated: 0 } });
  });

  it('adds what the main-process dialog returns, and remembers the output folder it picks', async () => {
    const h = await harness('dialogs', ['a.mp4', 'b.mp3']);
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [h.file('a.mp4'), h.file('b.mp3')] });
    const picked = await h.call(C.pickFiles, { filter: 'video' });
    expect(picked.ok && addFilesResultSchema.parse(picked.value).added).toHaveLength(2);
    const [parent, options] = h.dialog.showOpenDialog.mock.calls[0] as [unknown, { properties: string[]; filters: unknown }];
    expect(parent).toBe(h.window);
    expect(options).toEqual({ properties: ['openFile', 'multiSelections'], filters: pickFileFilters('video') });
    expect(pickFileFilters('audio')[0].extensions).toContain('flac');
    expect(pickFileFilters('all').map(filter => filter.extensions.includes('*'))).toEqual([false, true]);
    // A cancelled dialog adds nothing.
    expect(await h.call(C.pickFiles, { filter: 'all' })).toEqual({ ok: true, value: { added: [], duplicates: [], rejected: [], truncated: 0 } });

    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [h.media] });
    const directory = await h.call(C.pickOutputDirectory, {});
    expect(directory.ok).toBe(true);
    const chosen = pickOutputDirectoryResultSchema.parse((directory as { value: unknown }).value).directory!;
    expect(chosen.displayName).toBe('media');
    expect((await h.snapshot()).outputDirectories).toEqual([chosen]);
    expect(await h.call(C.pickOutputDirectory, {})).toEqual({ ok: true, value: { directory: null } });
  });
});

// ── What the renderer gets (AC-ENGINE-07-3) ────────────────────────────────────────────────────

describe('media converter IPC: what reaches the renderer', () => {
  it('starts the encoder detection on the first snapshot or added file, never at registration', async () => {
    const h = await harness('lazy-detection', ['a.mp4']);
    await h.queue.restore();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.runtime.acquire).not.toHaveBeenCalled();
    const first = await h.snapshot();
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(first.engine.capabilities.state).toBe('detecting');
    await vi.waitFor(async () => expect((await h.snapshot()).engine.capabilities.state).toBe('ready'));
    const later = await h.snapshot();
    expect(later.resolvedEncoders).toEqual(h.capabilities.resolvedEncoders());
    expect(later.resolvedEncoders.hevc.gpuOff?.encoder).toBe('libkvazaar');
    expect(later.defaults).toEqual({ compressCodec: 'h264' });
    // The engine status follows as an event too.
    expect(h.sent().some(({ payload }) => (payload as { kind: string }).kind === 'engine')).toBe(true);

    const other = await harness('lazy-detection-add', ['b.mp4']);
    await addFiles(other, ['b.mp4']);
    expect(other.ensure).toHaveBeenCalled();
  });

  it('previews the plan an item would get, or answers the code', async () => {
    const h = await harness('preview', ['a.mp4']);
    const [a] = await addFiles(h, ['a.mp4']);
    const ready = await h.call(C.previewPlan, { itemId: a, settings: TO_MKV });
    expect(ready.ok && previewPlanResultSchema.parse(ready.value)).toMatchObject({ status: 'ready', plan: { task: 'convert', remuxOnly: true } });
    const skipped = await h.call(C.previewPlan, { itemId: a, settings: TO_MP4 });
    expect(skipped.ok && previewPlanResultSchema.parse(skipped.value)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(await h.call(C.previewPlan, { itemId: 'no-such-item', settings: TO_MKV })).toEqual(INVALID);
  });

  it('previews no_encoder_available with the codecs that would work instead, so the interface can offer them', async () => {
    const h = await harness('preview-alternatives', ['tiny.mp4']);
    // 7×7: kvazaar needs sides it can round down to multiples of 8, and no HEVC hardware encoder is in the CPU-only table.
    const tiny = mediaInfoSchema.parse({ ...MEDIA, video: [{ ...MEDIA.video[0], width: 7, height: 7 }] });
    h.prober.probe.mockResolvedValue({ ok: true, info: tiny });
    const [a] = await addFiles(h, ['tiny.mp4']);
    const hevc = defaultCompressSettings('hevc');
    const caps = await h.capabilities.planner();
    if (!caps.ok) throw new Error(caps.code);
    const planned = buildPlan(tiny, hevc, caps.capabilities);
    if (planned.status !== 'error') throw new Error(`The plan is ${planned.status}.`);
    expect(planned.reason).toBe('no_encoder_available');
    expect(planned.alternatives.length).toBeGreaterThan(0);

    const preview = await h.call(C.previewPlan, { itemId: a, settings: hevc });
    expect(preview).toEqual({ ok: true, value: { status: 'error', reason: 'no_encoder_available', alternatives: [...planned.alternatives] } });
    expect(preview.ok && previewPlanResultSchema.parse(preview.value)).toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: [...planned.alternatives] });
    // As the renderer calls it, through the preload API.
    expect(await h.api().previewPlan({ itemId: a, settings: hevc })).toEqual(preview);
    // A codec it suggests plans; starting with the one that cannot answers the code alone.
    const instead = await h.call(C.previewPlan, { itemId: a, settings: defaultCompressSettings(planned.alternatives[0]) });
    expect(instead.ok && previewPlanResultSchema.parse(instead.value).status).toBe('ready');
    expect(await h.call(C.start, startRequest([a], hevc))).toEqual({
      ok: true, value: { started: [], skipped: [], rejected: [{ itemId: a, code: 'no_encoder_available' }], needsConfirmation: null },
    });
  });

  it('shows in its folder only an output this tool published', async () => {
    const h = await harness('reveal', ['a.mp4', 'b.mp4', 'c.mp4']);
    const [a, b, c] = await addFiles(h, ['a.mp4', 'b.mp4', 'c.mp4']);
    h.executor.outcome = async job => job.itemId === c
      ? { status: 'failed', code: 'encode_failed', outputs: [], log: 'Conversion failed!' }
      : new FakeExecutor().outcome(job, undefined as never);
    expect((await h.call(C.start, startRequest([a, c]))).ok).toBe(true);
    await vi.waitFor(async () => expect([await stateOf(h, a), await stateOf(h, c)]).toEqual([{ status: 'succeeded' }, { status: 'failed', code: 'encode_failed', partial: false }]));

    expect(await h.call(C.revealOutput, { itemId: a })).toEqual({ ok: true, value: {} });
    expect(h.reveal).toHaveBeenCalledOnce();
    expect(h.reveal).toHaveBeenCalledWith(h.file('a.mkv'));
    // Another output position, an item that published nothing, an idle item and an unknown id.
    for (const request of [{ itemId: a, outputIndex: 1 }, { itemId: c }, { itemId: b }, { itemId: 'no-such-item' }]) {
      expect(await h.call(C.revealOutput, request), JSON.stringify(request)).toEqual(INVALID);
    }
    // The output was moved away since.
    await rm(h.file('a.mkv'));
    expect(await h.call(C.revealOutput, { itemId: a })).toEqual({ ok: false, error: { code: 'file_unavailable' } });
    expect(h.reveal).toHaveBeenCalledOnce();

    // `FUSIONKIT_TEST_MEDIA_REVEAL=record` records the file name instead of opening Explorer.
    const shell = { showItemInFolder: vi.fn() };
    const record = vi.fn();
    mediaConverterRevealer('record', shell, record)(h.file('a.mkv'));
    expect(record).toHaveBeenCalledWith('a.mkv');
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    mediaConverterRevealer(null, shell, record)(h.file('a.mkv'));
    expect(shell.showItemInFolder).toHaveBeenCalledWith(h.file('a.mkv'));
  });

  it('carries redacted logs and no absolute path in the snapshot and the events', async () => {
    const h = await harness('redaction', ['clip one.mp4', 'b.mp4']);
    const [a, b] = await addFiles(h, ['clip one.mp4', 'b.mp4']);
    const workLog = path.join(h.state, 'work', '1a2b3c4d', 'ffmpeg2pass-0.log');
    h.executor.outcome = async job => {
      if (job.itemId === b) return new FakeExecutor().outcome(job, undefined as never);
      // The worst case: a log nobody redacted before, naming the input, the output, its partial, the work folder and other files.
      const target = path.join(job.targets[0].directory, `${job.targets[0].baseName}.${job.targets[0].extension}`);
      const partial = path.join(job.targets[0].directory, '.fusionkit-media-0badf00d.partial');
      return {
        status: 'failed', code: 'encode_failed', outputs: [],
        log: [
          `[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0000020a] [error] Error opening input file file:${job.inputPath}.`,
          `[out#0/matroska @ 0000020b] [error] Error opening output ${partial}: Invalid argument`,
          `[warning] Would have written ${target}`,
          `[error] Could not open ${workLog}`,
          `[error] Also read "C:\\Users\\Someone Else\\Videos\\secret clip.mp4" and D:/Media/other.mkv`,
          '[error] Share \\\\nas\\share\\movies\\clip.mkv and file:///C:/Users/Public/clip.mp4',
          'Conversion failed!',
        ].join('\n'),
      };
    };
    expect((await h.call(C.start, startRequest([a, b]))).ok).toBe(true);
    await vi.waitFor(async () => expect([(await stateOf(h, a))?.status, (await stateOf(h, b))?.status]).toEqual(['failed', 'succeeded']));

    const snapshot = await h.snapshot();
    const failed = snapshot.items.find(item => item.id === a)!;
    expect(failed.log).toContain('<input>');
    expect(failed.log).toContain('<output>');
    expect(failed.log).toContain('[path]');
    expect(failed.log).toContain('Conversion failed!');
    const succeeded = snapshot.items.find(item => item.id === b)!;
    expect(succeeded.result?.outputs).toEqual([{ index: 0, fileName: 'b.mkv', folderName: 'media', sizeBytes: 9, replaced: false }]);
    expect(succeeded.displayName).toBe('b.mp4');
    expect(succeeded.folderName).toBe('media');

    const snapshotText = JSON.stringify(snapshot);
    expect(snapshotText).not.toMatch(ABSOLUTE_PATH);
    expect(snapshotText).not.toContain(root);
    expect(snapshotText).not.toContain('Someone Else');

    const events = h.sent();
    expect(events.length).toBeGreaterThan(0);
    for (const { channel, payload } of events) {
      expect(channel).toBe(C.changed);
      expect(mediaConverterEventSchema.safeParse(payload).success).toBe(true);
    }
    const failedEvents = events.filter(({ payload }) => JSON.stringify(payload).includes('Conversion failed!'));
    expect(failedEvents.length).toBeGreaterThan(0);
    const eventText = JSON.stringify(events.map(({ payload }) => payload));
    expect(eventText).not.toMatch(ABSOLUTE_PATH);
    expect(eventText).not.toContain(root);
    expect(eventText).not.toContain('Someone Else');
  });

  it('sends events only to a live application window', () => {
    const live = { isDestroyed: () => false, webContents: contents() };
    const event: QueueEvent = { sequence: 1, kind: 'items', items: [], removed: [] };
    mediaConverterEventSender(() => live as never)(event);
    expect(live.webContents.send).toHaveBeenCalledWith(C.changed, event);
    const closed = { isDestroyed: () => true, get webContents(): never { throw new Error('Object has been destroyed'); } };
    expect(() => mediaConverterEventSender(() => closed as never)(event)).not.toThrow();
    const gone = { isDestroyed: () => false, webContents: { ...contents(), isDestroyed: () => true } };
    mediaConverterEventSender(() => gone as never)(event);
    expect(gone.webContents.send).not.toHaveBeenCalled();
    expect(() => mediaConverterEventSender(() => null)(event)).not.toThrow();
  });

  it('delivers valid change events only and unsubscribes', () => {
    const listeners = new Set<(event: unknown, payload: unknown) => void>();
    const ipc = {
      invoke: vi.fn(),
      on: vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.add(listener); }),
      removeListener: vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.delete(listener); }),
    };
    const api = createMediaConverterApi(ipc, filePaths(), 'win32');
    const received: unknown[] = [];
    const unsubscribe = api.onChanged(event => received.push(event));
    expect(ipc.on).toHaveBeenCalledWith(C.changed, expect.any(Function));
    const [listener] = listeners;
    const valid = { sequence: 4, kind: 'options', options: { concurrency: 1, lowUsage: true }, outputDirectories: [] };
    listener({}, valid);
    listener({}, { ...valid, sequence: 0 });
    listener({}, { ...valid, kind: 'paths' });
    listener({}, { ...valid, path: 'C:\\secret' });
    listener({}, { sequence: 5, kind: 'progress', itemId: 'a', progress: { fraction: 2 } });
    listener({}, 'options');
    expect(received).toEqual([valid]);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });

  it('answers busy for "detect again" while a hardware encode runs', async () => {
    const h = await harness('redetect');
    vi.spyOn(h.queue, 'isHardwareEncodeRunning').mockReturnValue(true);
    expect(await h.call(C.redetectCapabilities, {})).toEqual({ ok: false, error: { code: 'busy' } });
    vi.spyOn(h.queue, 'isHardwareEncodeRunning').mockReturnValue(false);
    expect(await h.call(C.redetectCapabilities, {})).toEqual({ ok: true, value: {} });
    await vi.waitFor(() => expect(h.capabilities.status().capabilities.state).toBe('ready'));
  });
});
