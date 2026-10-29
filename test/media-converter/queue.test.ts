import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  QUEUE_LIMITS, addFilesResultSchema, capabilityStatusSchema, defaultCompressSettings, itemStateSchema, itemSummarySchema, mediaInfoSchema, previewPlanResultSchema,
  queueEventSchema, queueSnapshotSchema, startResultSchema,
  type CapabilityStatus, type ConversionSettings, type EngineStatus, type ItemProgress, type ItemState, type ItemSummary, type MediaInfo, type QueueEvent,
  type QueueSnapshot,
} from '../../src/media-converter/contract';
import { atomicWriteUtf8File } from '../../electron/main/translation/atomic-file';
import { resolveEncoders } from '../../electron/main/media-converter/engine/capabilities';
import { InputRegistry } from '../../electron/main/media-converter/engine/inputs';
import { MediaOutputs } from '../../electron/main/media-converter/engine/output';
import type { ProbeOutcome } from '../../electron/main/media-converter/engine/probe';
import { buildPlan } from '../../electron/main/media-converter/plan/stream-plan';
import { defaultCompressCodec } from '../../electron/main/media-converter/plan/video';
import type { PlanOutcome, PlannerCapabilities } from '../../electron/main/media-converter/plan/types';
import { MediaQueue, QUEUE_POLICY, type MediaQueueOptions } from '../../electron/main/media-converter/queue/queue';
import { STATE_STORE_POLICY } from '../../electron/main/media-converter/queue/state-store';
import {
  MediaQueueError, type CapabilitiesAnswer, type ExecutionHooks, type ExecutionJob, type ExecutionOutcome, type MediaExecutor, type QueueClock,
  type QueuePlanner,
} from '../../electron/main/media-converter/queue/types';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * The main-process queue (T-ENGINE-05, design §6) with a fake executor, prober and capability
 * table, so no ffmpeg runs: run order at concurrency 1 and 2, strictly increasing sequences and a
 * snapshot that later events bring up to date, progress coalesced to at most 4 events per item per
 * second, options owned and persisted by the main process, the input check before a run,
 * interrupted items after a restart, the 500-item cap, a corrupt `state.json`, the 16 KB redacted
 * log tail, the confirmations (`confirmation_required`, `wouldReplace`), retry overrides, the
 * shutdown, the power blocker and one `batch-finished` per batch; and (batch C follow-ups) nothing
 * starting while the encoders are detected, the bytes of `disk_space_low`, the published outputs of
 * a cancelled item, the alternatives of `no_encoder_available` and the full ready capability status.
 * Inputs are real files in a run folder under test-results/media-converter; time runs on a fake clock.
 */

const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
let root: string;
let runs = 0;

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

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
/** A remux into MKV: no video encoder involved, so the plan does not depend on the encoder tables. */
const TO_MKV: ConversionSettings = Object.freeze({ task: 'convert', target: 'mkv', preferRemux: true, tier: 'balanced' });
/** MP4 to MP4 copying every stream: `already_target`. */
const TO_MP4: ConversionSettings = Object.freeze({ task: 'convert', target: 'mp4', preferRemux: true, tier: 'balanced' });
const CAPS: PlannerCapabilities = { encoders: {}, degraded: [], nvencMin: { width: 144, height: 120 } };
const SOURCE = { mode: 'source', conflict: 'number' } as const;
const NO_CONFIRMATION = { lossyToLossless: [], replaceExisting: false };
const startRequest = (itemIds: string[], extra: Record<string, unknown> = {}) => ({ itemIds, settings: TO_MKV, output: SOURCE, confirmed: NO_CONFIRMATION, ...extra });

/** Timers fire only when the test moves time on; wall time follows the monotonic time. */
class FakeClock implements QueueClock {
  #monotonic = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  now() { return 1_800_000_000_000 + this.#monotonic; }
  monotonic() { return this.#monotonic; }
  setTimeout(callback: () => void, milliseconds: number) {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#monotonic + Math.max(0, milliseconds), callback });
    return id;
  }
  clearTimeout(handle: unknown) { this.#timers.delete(handle as number); }
  /** Moves time on by `milliseconds`, firing every timer that falls due, in order. */
  advance(milliseconds: number) {
    const end = this.#monotonic + milliseconds;
    for (;;) {
      const due = [...this.#timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#monotonic = Math.max(this.#monotonic, due[1].at);
      due[1].callback();
    }
    this.#monotonic = end;
  }
}

interface Run {
  readonly job: ExecutionJob;
  readonly hooks: ExecutionHooks;
  settled: boolean;
  settle(outcome: ExecutionOutcome): void;
}
/** Each run waits until the test settles it. */
class FakeExecutor implements MediaExecutor {
  readonly runs: Run[] = [];
  readonly endBatch = vi.fn();
  active = 0;
  maxActive = 0;
  onRun?: (run: Run) => void;
  run(job: ExecutionJob, hooks: ExecutionHooks): Promise<ExecutionOutcome> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise(resolve => {
      const run: Run = {
        job, hooks, settled: false,
        settle: outcome => {
          if (run.settled) return;
          run.settled = true;
          this.active--;
          resolve(outcome);
        },
      };
      this.runs.push(run);
      this.onRun?.(run);
    });
  }
}
/** Every planned output published under its target name. */
const published = (job: ExecutionJob, sizeBytes = 400_000): ExecutionOutcome => ({
  status: 'succeeded', warnings: [],
  outputs: job.targets.map((target, index) => ({ index, path: path.join(target.directory, `${target.baseName}.${target.extension}`), sizeBytes, replaced: false })),
});

/** A ready capability status with every field `MediaCapabilities` sets and the contract requires, for `caps`. */
function readyStatus(caps: PlannerCapabilities = CAPS, hardwareEncoders: Extract<CapabilityStatus, { state: 'ready' }>['hardwareEncoders'] = []): CapabilityStatus {
  return capabilityStatusSchema.parse({
    state: 'ready', hardwareEncoders, degraded: [...caps.degraded], driverUpdates: [], resolvedEncoders: resolveEncoders(caps),
    defaults: { compressCodec: defaultCompressCodec(caps) },
  });
}
const READY: EngineStatus['runtime'] = { state: 'ready', version: 'n8.1.2' };

function fakeCapabilities(answer: CapabilitiesAnswer = { ok: true, capabilities: CAPS }) {
  const listeners = new Set<() => void>();
  let status: EngineStatus = { runtime: READY, capabilities: readyStatus() };
  return {
    planner: vi.fn(async () => answer),
    status: () => status,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: EngineStatus) { status = next; for (const listener of listeners) listener(); },
    listeners,
  };
}
function fakeProber(outcomes: Record<string, ProbeOutcome> = {}) {
  const calls: string[] = [];
  return { calls, probe: vi.fn(async (filePath: string) => { calls.push(path.basename(filePath)); return outcomes[path.basename(filePath)] ?? { ok: true as const, info: MEDIA }; }) };
}

interface Harness {
  dir: string;
  media: string;
  state: string;
  clock: FakeClock;
  executor: FakeExecutor;
  caps: ReturnType<typeof fakeCapabilities>;
  prober: ReturnType<typeof fakeProber>;
  power: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  events: { event: QueueEvent; at: number }[];
  invalid: unknown[];
  queue: MediaQueue;
  file(name: string): string;
}

/** A queue over a fresh run folder with `files` written as inputs; `overrides` replace its dependencies. */
async function harness(name: string, files: string[] = [], overrides: Partial<MediaQueueOptions> = {}): Promise<Harness> {
  const dir = path.join(root, `${String(++runs).padStart(2, '0')}-${name}`);
  const media = path.join(dir, 'media');
  await mkdir(media, { recursive: true });
  for (const file of files) await writeFile(path.join(media, file), `content of ${file}`);
  const h = { dir, media, state: path.join(dir, 'state'), file: (file: string) => path.join(media, file) } as Harness;
  return withQueue(h, overrides);
}
/** A new queue (as after a restart) over the same folders. */
function withQueue(previous: Pick<Harness, 'dir' | 'media' | 'state' | 'file'>, overrides: Partial<MediaQueueOptions> = {}): Harness {
  let powerIds = 0;
  const h: Harness = {
    ...previous,
    clock: new FakeClock(), executor: new FakeExecutor(), caps: fakeCapabilities(), prober: fakeProber(),
    power: { start: vi.fn(() => ++powerIds), stop: vi.fn() }, events: [], invalid: [], queue: undefined as unknown as MediaQueue,
  };
  h.queue = new MediaQueue({
    root: h.state, inputs: new InputRegistry(), prober: h.prober, capabilities: h.caps, executor: h.executor, wouldReplace: async () => null,
    powerSaveBlocker: h.power, clock: h.clock, log: () => {},
    emit: event => {
      const checked = queueEventSchema.safeParse(event);
      if (!checked.success) h.invalid.push({ event, issues: checked.error.issues });
      h.events.push({ event, at: h.clock.monotonic() });
    },
    ...overrides,
  });
  return h;
}

async function addAll(h: Harness, names: string[]): Promise<string[]> {
  const result = await h.queue.add(names.map(h.file));
  expect(addFilesResultSchema.parse(result).added).toHaveLength(names.length);
  await h.queue.drain();
  return result.added;
}
const itemOf = (h: Harness, id: string): ItemSummary => {
  const item = h.queue.snapshot().items.find(candidate => candidate.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item;
};
const stateOf = (h: Harness, id: string): ItemState => itemOf(h, id).state;
const eventsOf = <K extends QueueEvent['kind']>(h: Harness, kind: K) => h.events.map(entry => entry.event).filter((event): event is Extract<QueueEvent, { kind: K }> => event.kind === kind);
async function stateFile(h: Pick<Harness, 'state'>) {
  return JSON.parse(await readFile(path.join(h.state, 'state.json'), 'utf8'));
}
/** Moves the fake clock on until `promise` settles (timers the queue waits on), with real ticks in between for its file work. */
async function settleWithClock<T>(promise: Promise<T>, clock: FakeClock, step = 250, limit = 100): Promise<T> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < limit && !settled; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (!settled) clock.advance(step);
  }
  return promise;
}
const progressAt = (t: number): ItemProgress => ({
  fraction: Math.min(0.99, t / 3000), processedUs: t * 1000, writtenBytes: t * 100, speed: 1.5, fps: 37.5, etaMs: Math.max(0, 3000 - t), outputIndex: 0, outputCount: 1,
});

beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'queue-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'queue-')));
});
afterAll(async () => {
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});

// ── Scheduling ─────────────────────────────────────────────────────────────────────────────────

describe('scheduling', () => {
  it('runs one item at a time by default, in the order started, while probing needs no slot', async () => {
    const h = await harness('concurrency-1', ['a.mp4', 'b.mp4', 'c.mp4', 'late.mp4']);
    const [a, b, c] = await addAll(h, ['a.mp4', 'b.mp4', 'c.mp4']);
    expect(h.queue.options).toEqual({ concurrency: 1, lowUsage: false });
    const request = startRequest([c, a, b], { settings: { ...TO_MKV } });
    const result = startResultSchema.parse(await h.queue.start(request));
    expect(result).toEqual({ started: [c, a, b], skipped: [], rejected: [], needsConfirmation: null });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    expect(h.executor.runs[0].job.itemId).toBe(c);
    expect([stateOf(h, c).status, stateOf(h, a).status, stateOf(h, b).status]).toEqual(['running', 'queued', 'queued']);

    // A file added while a conversion runs is probed at once.
    const late = await h.queue.add([h.file('late.mp4')]);
    await h.queue.drain();
    expect(stateOf(h, late.added[0])).toEqual({ status: 'idle' });
    expect(h.executor.runs).toHaveLength(1);

    // The frozen job does not follow the request object or anything else afterwards.
    (request.settings as { target: string }).target = 'webm';
    const job = h.executor.runs[0].job;
    expect(job.settings).toEqual(TO_MKV);
    expect(Object.isFrozen(job.settings) && Object.isFrozen(job.plan) && Object.isFrozen(job.plan.outputs[0])).toBe(true);
    expect(job.targets).toEqual([{ directory: h.media, baseName: 'c', extension: 'mkv' }]);
    expect(job.inputPath).toBe(h.file('c.mp4'));
    // Every input of the queue when the run started.
    expect([...job.inputPaths].sort()).toEqual([h.file('a.mp4'), h.file('b.mp4'), h.file('c.mp4')]);

    for (const expected of [c, a, b]) {
      const run = h.executor.runs.at(-1)!;
      expect(run.job.itemId).toBe(expected);
      run.settle(published(run.job));
      await vi.waitFor(() => expect(stateOf(h, expected).status).toBe('succeeded'));
    }
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    expect(h.executor.runs.map(run => run.job.itemId)).toEqual([c, a, b]);
    expect(h.executor.maxActive).toBe(1);
    expect(h.invalid).toEqual([]);
  });

  it('runs two items at once with concurrency 2, the third waiting for a slot', async () => {
    const h = await harness('concurrency-2', ['d.mp4', 'e.mp4', 'f.mp4']);
    const [d, e, f] = await addAll(h, ['d.mp4', 'e.mp4', 'f.mp4']);
    expect(await h.queue.setOptions({ concurrency: 2 })).toEqual({ concurrency: 2, lowUsage: false });
    await h.queue.start(startRequest([f, d, e]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    // Both start together; which reaches the executor first depends on whose input check answers first.
    expect(h.executor.runs.map(run => run.job.itemId).sort()).toEqual([f, d].sort());
    expect([stateOf(h, f).status, stateOf(h, d).status, stateOf(h, e).status]).toEqual(['running', 'running', 'queued']);
    const runOf = (id: string) => h.executor.runs.find(run => run.job.itemId === id)!;
    runOf(d).settle(published(runOf(d).job));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(3));
    expect(h.executor.runs[2].job.itemId).toBe(e);
    expect(h.executor.active).toBe(2);
    runOf(f).settle(published(runOf(f).job));
    runOf(e).settle(published(runOf(e).job));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    expect(h.executor.maxActive).toBe(2);
    expect(h.invalid).toEqual([]);
  });

  it('cancels a queued item at once and a running one through its executor', async () => {
    const h = await harness('cancel', ['a.mp4', 'b.mp4']);
    const [a, b] = await addAll(h, ['a.mp4', 'b.mp4']);
    await h.queue.start(startRequest([a, b]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    expect(await h.queue.cancel({ itemIds: [b] })).toEqual({ affected: 1 });
    expect(stateOf(h, b)).toEqual({ status: 'cancelled' });
    expect(await h.queue.cancel({ itemIds: [a] })).toEqual({ affected: 1 });
    const run = h.executor.runs[0];
    expect(run.hooks.signal.aborted).toBe(true);
    // Cancelled only once the executor has stopped ffmpeg and cleaned up.
    expect(stateOf(h, a).status).toBe('running');
    run.settle({ status: 'cancelled' });
    await vi.waitFor(() => expect(stateOf(h, a)).toEqual({ status: 'cancelled' }));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    expect(eventsOf(h, 'batch-finished')[0].batch).toEqual({ succeeded: 0, failed: 0, skipped: 0, cancelled: 2, savedBytes: 0 });
    expect(h.executor.runs).toHaveLength(1);
    // Removing: never a running item; a cancelled one goes with its input.
    expect(await h.queue.remove({ itemIds: [a, b] })).toEqual({ affected: 2 });
    expect(h.queue.snapshot().items).toEqual([]);
    expect(await h.queue.add([h.file('a.mp4')])).toMatchObject({ duplicates: [] });
  });

  it('clears finished items, or everything not queued, running or analyzing', async () => {
    const h = await harness('clear', ['done.mp4', 'idle.mp4', 'run.mp4', 'wait.mp4', 'bad.mp4']);
    h.prober.probe.mockImplementation(async (filePath: string) => path.basename(filePath) === 'bad.mp4'
      ? { ok: false, code: 'probe_failed' } : { ok: true, info: MEDIA });
    const [done, idle, running, waiting, bad] = await addAll(h, ['done.mp4', 'idle.mp4', 'run.mp4', 'wait.mp4', 'bad.mp4']);
    await h.queue.start(startRequest([done]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    h.executor.runs[0].settle(published(h.executor.runs[0].job));
    await vi.waitFor(() => expect(stateOf(h, done).status).toBe('succeeded'));
    await h.queue.start(startRequest([running, waiting]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(await h.queue.remove({ itemIds: [running] })).toEqual({ affected: 0 });
    expect(await h.queue.clear({ scope: 'finished' })).toEqual({ removed: 2 });
    expect(h.queue.snapshot().items.map(item => item.id)).toEqual([idle, running, waiting]);
    expect(eventsOf(h, 'items').at(-1)?.removed).toEqual([done, bad]);
    expect(await h.queue.clear({ scope: 'all_idle' })).toEqual({ removed: 1 });
    expect(h.queue.snapshot().items.map(item => item.id)).toEqual([running, waiting]);
    // Removing the queued one takes it out of the queue: nothing follows the running one.
    expect(await h.queue.remove({ itemIds: [waiting] })).toEqual({ affected: 1 });
    h.executor.runs[1].settle(published(h.executor.runs[1].job));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(2));
    expect(h.executor.runs).toHaveLength(2);
    expect(h.queue.outputPath(done)).toBeNull();
  });

  it('rejects invalid requests as a whole', async () => {
    const h = await harness('invalid', ['a.mp4']);
    const [a] = await addAll(h, ['a.mp4']);
    for (const request of [
      {}, startRequest([]), startRequest([a, a]), startRequest(['../x']), startRequest([a], { settings: { ...TO_MKV, target: 'avi' } }),
      startRequest([a], { output: { mode: 'directory', conflict: 'number' } }), startRequest([a], { extra: true }),
    ]) {
      await expect(h.queue.start(request)).rejects.toMatchObject({ name: 'MediaQueueError', code: 'invalid_request' });
    }
    await expect(h.queue.setOptions({ concurrency: 3 })).rejects.toBeInstanceOf(MediaQueueError);
    await expect(h.queue.retry({ itemIds: [a], override: 'whatever' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(h.queue.clear({ scope: 'everything' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(stateOf(h, a)).toEqual({ status: 'idle' });
  });
});

// ── Events ─────────────────────────────────────────────────────────────────────────────────────

/** What a renderer does with the snapshot and the events after it. */
function applyEvents(snapshot: QueueSnapshot, events: QueueEvent[]): QueueSnapshot {
  const view = structuredClone(snapshot);
  for (const event of events) {
    if (event.sequence <= view.sequence) continue;
    view.sequence = event.sequence;
    if (event.kind === 'items') {
      view.items = view.items.filter(item => !event.removed.includes(item.id));
      for (const item of event.items) {
        const index = view.items.findIndex(known => known.id === item.id);
        if (index >= 0) view.items[index] = item; else view.items.push(item);
      }
    } else if (event.kind === 'progress') {
      const item = view.items.find(known => known.id === event.itemId);
      if (item) item.progress = event.progress;
    } else if (event.kind === 'options') {
      view.options = event.options;
      view.outputDirectories = event.outputDirectories;
    } else if (event.kind === 'engine') view.engine = event.engine;
  }
  return view;
}

describe('events', () => {
  it('numbers every event strictly upwards, and a snapshot plus the later events show the current state', async () => {
    const h = await harness('sequence', ['a.mp4', 'b.mp4']);
    const [a, b] = await addAll(h, ['a.mp4', 'b.mp4']);
    await h.queue.start(startRequest([a, b]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    const run = h.executor.runs[0];
    run.hooks.phase('encoding');
    run.hooks.progress(progressAt(100));
    h.clock.advance(300);
    run.hooks.progress(progressAt(400));

    // The page is left or reloaded here: the renderer takes a snapshot, then applies newer events.
    const snapshot = queueSnapshotSchema.parse(h.queue.snapshot());
    const seen = h.events.length;
    expect(snapshot.sequence).toBe(h.events.at(-1)!.event.sequence);
    expect(snapshot.items.find(item => item.id === a)?.progress).toEqual(progressAt(400));

    h.clock.advance(300);
    run.hooks.progress(progressAt(700));
    h.caps.set({ runtime: READY, capabilities: { state: 'detecting' } });
    await h.queue.setOptions({ lowUsage: true });
    await h.queue.rememberOutputDirectory(path.join(h.dir, 'out'));
    run.settle(published(run.job));
    // Nothing starts while the encoders are detected; b starts once the detection ends.
    await vi.waitFor(() => expect(stateOf(h, a).status).toBe('succeeded'));
    expect(h.executor.runs).toHaveLength(1);
    h.caps.set({ runtime: READY, capabilities: readyStatus() });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    h.executor.runs[1].hooks.progress(progressAt(50));
    h.executor.runs[1].settle({ status: 'failed', code: 'encoder_stalled', outputs: [], log: 'stalled\n' });
    await vi.waitFor(() => expect(stateOf(h, b).status).toBe('failed'));
    await h.queue.remove({ itemIds: [a] });

    const sequences = h.events.map(entry => entry.event.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    const later = h.events.slice(seen).map(entry => entry.event);
    expect(later.every(event => event.sequence > snapshot.sequence)).toBe(true);
    expect(new Set(later.map(event => event.kind))).toEqual(new Set(['items', 'progress', 'engine', 'options', 'batch-finished']));
    const current = h.queue.snapshot();
    expect(applyEvents(snapshot, later)).toEqual(current);
    // Events from before the snapshot change nothing.
    expect(applyEvents(current, h.events.map(entry => entry.event))).toEqual(current);
    expect(h.invalid).toEqual([]);
  });

  it('sends at most four progress events per item per second, the latest value last', async () => {
    const h = await harness('progress', ['a.mp4', 'b.mp4']);
    const [a, b] = await addAll(h, ['a.mp4', 'b.mp4']);
    await h.queue.setOptions({ concurrency: 2 });
    await h.queue.start(startRequest([a, b]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    const runA = h.executor.runs.find(run => run.job.itemId === a)!;
    const runB = h.executor.runs.find(run => run.job.itemId === b)!;
    // ffmpeg reporting every 10 ms for 3 s, both items at once.
    for (let t = 0; t < 3000; t += 10) {
      runA.hooks.progress(progressAt(t));
      runB.hooks.progress(progressAt(t + 5));
      h.clock.advance(10);
    }
    const sent = (id: string) => h.events.filter(entry => entry.event.kind === 'progress' && entry.event.itemId === id);
    for (const [id, last] of [[a, 2990], [b, 2995]] as const) {
      const times = sent(id).map(entry => entry.at);
      let busiest = 0;
      for (let i = 0; i < times.length; i++) busiest = Math.max(busiest, times.filter(time => time >= times[i] && time < times[i] + 1000).length);
      expect(busiest).toBeLessThanOrEqual(4);
      expect(times.length).toBeGreaterThanOrEqual(12);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(QUEUE_LIMITS.progressIntervalMs);
      const final = sent(id).at(-1)!.event;
      expect(final.kind === 'progress' && final.progress).toEqual(progressAt(last));
      expect(itemOf(h, id).progress).toEqual(progressAt(last));
    }
    // An invalid report is dropped, never sent.
    runA.hooks.progress({ ...progressAt(10), fraction: 7 });
    h.clock.advance(1000);
    expect(itemOf(h, a).progress).toEqual(progressAt(2990));

    // After the end no stale progress follows the final state.
    runA.hooks.progress(progressAt(3000));
    runA.settle(published(runA.job));
    runB.settle(published(runB.job));
    await vi.waitFor(() => expect(stateOf(h, a).status).toBe('succeeded'));
    await vi.waitFor(() => expect(stateOf(h, b).status).toBe('succeeded'));
    const count = h.events.length;
    h.clock.advance(2000);
    expect(h.events.length).toBe(count);
    expect(itemOf(h, a).progress).toBeNull();
    expect(h.invalid).toEqual([]);
  });
});

// ── Options and persistence ────────────────────────────────────────────────────────────────────

describe('options and persistence', () => {
  it('keeps the queue options in the main process and in state.json', async () => {
    const h = await harness('options', ['a.mp4']);
    const options = await h.queue.setOptions({ concurrency: 2, lowUsage: true });
    expect(options).toEqual({ concurrency: 2, lowUsage: true });
    expect(eventsOf(h, 'options').at(-1)?.options).toEqual(options);
    // Written once the debounce has passed.
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect((await stateFile(h)).options).toEqual(options);
    expect(await h.queue.setOptions({})).toEqual(options);

    const restarted = withQueue(h);
    // A command that arrives while state.json is read waits for it, so what it writes includes the restored state.
    let restored = false;
    const restoring = restarted.queue.restore().then(() => { restored = true; });
    const directory = await restarted.queue.rememberOutputDirectory(path.join(h.dir, 'out'));
    expect(restored).toBe(true);
    await restoring;
    expect(restarted.queue.snapshot().options).toEqual(options);
    restarted.clock.advance(STATE_STORE_POLICY.debounceMs);
    await restarted.queue.persist();
    expect(await stateFile(h)).toMatchObject({ options, outputDirectories: [{ id: directory.id, path: path.join(h.dir, 'out') }] });
    // Low usage reaches the runs that start from now on.
    const [a] = await addAll(restarted, ['a.mp4']);
    await restarted.queue.start(startRequest([a]));
    await vi.waitFor(() => expect(restarted.executor.runs).toHaveLength(1));
    expect(restarted.executor.runs[0].job.lowUsage).toBe(true);
  });

  it('writes state.json at most once per 500 ms through an atomic write, and again after a failed write', async () => {
    const writes: string[] = [];
    let failing = false;
    const h = await harness('debounce', ['a.mp4', 'b.mp4'], {
      writeState: async (file, content) => {
        if (failing) throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
        await atomicWriteUtf8File(file, content);
        writes.push(content);
      },
    });
    const [a, b] = await addAll(h, ['a.mp4', 'b.mp4']);
    await h.queue.setOptions({ lowUsage: true });
    await h.queue.rememberOutputDirectory(path.join(h.dir, 'out'));
    h.clock.advance(STATE_STORE_POLICY.debounceMs - 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toHaveLength(0);
    h.clock.advance(1);
    await h.queue.persist();
    // Five changes, one write, carrying the state of when it ran.
    expect(writes).toHaveLength(1);
    const written = JSON.parse(writes[0]);
    expect(written).toMatchObject({ version: 1, options: { concurrency: 1, lowUsage: true }, outputDirectories: [{ path: path.join(h.dir, 'out') }] });
    expect(written.items.map((item: { id: string; state: ItemState; input: { path: string } }) => [item.id, item.state.status, item.input.path]))
      .toEqual([[a, 'idle', h.file('a.mp4')], [b, 'idle', h.file('b.mp4')]]);
    expect(await readdir(h.state)).toEqual(['state.json']);

    failing = true;
    await h.queue.setOptions({ lowUsage: false });
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect(writes).toHaveLength(1);
    // The change is still owed: with nothing else changing, the retry writes it.
    failing = false;
    h.clock.advance(STATE_STORE_POLICY.failedWriteRetryMs - 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toHaveLength(1);
    h.clock.advance(1);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(JSON.parse(writes[1]).options.lowUsage).toBe(false);
    expect((await stateFile(h)).options.lowUsage).toBe(false);

    // Or the next flush, whichever comes first; the retry then has nothing left to write.
    failing = true;
    await h.queue.setOptions({ lowUsage: true });
    await h.queue.persist();
    failing = false;
    await h.queue.persist();
    expect(writes).toHaveLength(3);
    h.clock.advance(STATE_STORE_POLICY.failedWriteRetryMs);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toHaveLength(3);
    expect((await stateFile(h)).options.lowUsage).toBe(true);
  });

  it('reads state.json before the first command even when restore was not called, so nothing persisted is written over', async () => {
    const h = await harness('restore-first', ['kept.mp4', 'new.mp4']);
    const [kept] = await addAll(h, ['kept.mp4']);
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();

    // A new queue (the next app start) whose first calls are a snapshot and a command, not restore().
    const restarted = withQueue(h);
    const early = queueSnapshotSchema.parse(restarted.queue.snapshot());
    expect(early.items).toEqual([]);
    expect(await restarted.queue.setOptions({ lowUsage: true })).toEqual({ concurrency: 1, lowUsage: true });
    restarted.clock.advance(STATE_STORE_POLICY.debounceMs);
    await restarted.queue.persist();
    const written = await stateFile(h);
    expect(written.options).toEqual({ concurrency: 1, lowUsage: true });
    expect(written.items.map((item: { id: string }) => item.id)).toEqual([kept]);
    // The early snapshot plus the events after it show what the restore brought back.
    expect(applyEvents(early, restarted.events.map(entry => entry.event))).toEqual(restarted.queue.snapshot());
    expect(restarted.invalid).toEqual([]);
    // The same file again is the restored item, not a second one.
    expect(await restarted.queue.add([h.file('kept.mp4'), h.file('new.mp4')])).toMatchObject({ duplicates: [kept] });
    expect(restarted.queue.snapshot().items.map(item => item.id)[0]).toBe(kept);
  });

  it('checks the input again just before it runs: deleted is input_missing, edited is input_changed', async () => {
    const h = await harness('input-check', ['first.mp4', 'gone.mp4', 'edited.mp4']);
    const [first, gone, edited] = await addAll(h, ['first.mp4', 'gone.mp4', 'edited.mp4']);
    await h.queue.start(startRequest([first, gone, edited]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    await unlink(h.file('gone.mp4'));
    await appendFile(h.file('edited.mp4'), ' and more');
    h.executor.runs[0].settle(published(h.executor.runs[0].job));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    expect(stateOf(h, gone)).toEqual({ status: 'failed', code: 'input_missing', partial: false });
    expect(stateOf(h, edited)).toEqual({ status: 'input_changed' });
    expect(h.executor.runs.map(run => run.job.itemId)).toEqual([first]);
    expect(eventsOf(h, 'batch-finished')[0].batch).toMatchObject({ succeeded: 1, failed: 2 });

    // A retry takes the edited file as it is now and runs it with the frozen settings.
    await h.queue.retry({ itemIds: [edited] });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(h.executor.runs[1].job.itemId).toBe(edited);
    expect(h.executor.runs[1].job.settings).toEqual(TO_MKV);
    // The deleted one fails again.
    await h.queue.retry({ itemIds: [gone] });
    expect(stateOf(h, gone)).toEqual({ status: 'failed', code: 'input_missing', partial: false });
  });

  it('after a restart, running and queued items are interrupted and idle ones are checked again', async () => {
    const h = await harness('restart', ['run.mp4', 'q1.mp4', 'q2.mp4', 'idle.mp4', 'edited.mp4', 'gone.mp4']);
    const [running, q1, q2, idle, edited, gone] = await addAll(h, ['run.mp4', 'q1.mp4', 'q2.mp4', 'idle.mp4', 'edited.mp4', 'gone.mp4']);
    await h.queue.start(startRequest([running, q1, q2]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    h.executor.runs[0].hooks.phase('encoding');
    // The app ends without a shutdown (a crash): only what the debounce wrote survives.
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    const written = await stateFile(h);
    expect(written.items.map((item: { state: ItemState }) => item.state.status)).toEqual(['running', 'queued', 'queued', 'idle', 'idle', 'idle']);
    await appendFile(h.file('edited.mp4'), '!');
    await unlink(h.file('gone.mp4'));

    const restarted = withQueue(h);
    await restarted.queue.restore();
    const snapshot = queueSnapshotSchema.parse(restarted.queue.snapshot());
    expect(snapshot.items.map(item => [item.id, item.state])).toEqual([
      [running, { status: 'interrupted' }], [q1, { status: 'interrupted' }], [q2, { status: 'interrupted' }], [idle, { status: 'idle' }],
      [edited, { status: 'input_changed' }], [gone, { status: 'failed', code: 'input_missing', partial: false }],
    ]);
    expect(snapshot.items[0].job?.settings).toEqual(TO_MKV);
    expect(snapshot.items[0].displayName).toBe('run.mp4');
    expect(restarted.executor.runs).toHaveLength(0);
    expect(restarted.power.start).not.toHaveBeenCalled();

    // Retrying probes and plans again, then runs with the settings frozen before the restart.
    expect(await restarted.queue.retry({ itemIds: [running, q1] })).toEqual({ affected: 2 });
    expect([...restarted.prober.calls].sort()).toEqual(['q1.mp4', 'run.mp4']);
    await vi.waitFor(() => expect(restarted.executor.runs).toHaveLength(1));
    expect(restarted.executor.runs[0].job).toMatchObject({ itemId: running, settings: TO_MKV, targets: [{ directory: h.media, baseName: 'run', extension: 'mkv' }] });
    expect(stateOf(restarted, q1)).toEqual({ status: 'queued' });
  });

  it('keeps at most 500 items, removing the earliest finished first', async () => {
    const names = Array.from({ length: 503 }, (_, index) => `f${String(index).padStart(3, '0')}.mp4`);
    const h = await harness('cap', names);
    const ids: string[] = [];
    for (let start = 0; start < 500; start += 100) ids.push(...(await h.queue.add(names.slice(start, start + 100).map(h.file))).added);
    await h.queue.drain();
    expect(ids).toHaveLength(500);
    // Nothing finished: nothing can make room.
    const full = await h.queue.add([h.file(names[500])]);
    expect(full).toEqual({ added: [], duplicates: [], rejected: [], truncated: 1 });

    // Three items finish, at different times; the two earliest make room for two new files.
    for (const id of [ids[7], ids[3], ids[5]]) {
      await h.queue.start(startRequest([id]));
      await vi.waitFor(() => expect(h.executor.runs.at(-1)?.job.itemId).toBe(id));
      h.clock.advance(1000);
      h.executor.runs.at(-1)!.settle(published(h.executor.runs.at(-1)!.job));
      await vi.waitFor(() => expect(stateOf(h, id).status).toBe('succeeded'));
    }
    const added = await h.queue.add([h.file(names[501]), h.file(names[502])]);
    expect(added.added).toHaveLength(2);
    const kept = h.queue.snapshot().items.map(item => item.id);
    expect(kept).toHaveLength(500);
    expect(kept).not.toContain(ids[7]);
    expect(kept).not.toContain(ids[3]);
    expect(kept).toContain(ids[5]);
    expect(eventsOf(h, 'items').at(-1)?.removed).toEqual([ids[7], ids[3]]);

    // One add takes 100 files at most.
    const many = await h.queue.add(Array.from({ length: 101 }, () => h.file(names[0])));
    expect(many.truncated).toBe(1);
    expect(many.duplicates).toEqual([ids[0]]);
  });

  it('keeps the 500 latest finished items of a restored state.json', async () => {
    const h = await harness('cap-restore');
    const items = Array.from({ length: 505 }, (_, index) => ({
      id: `old-${index}`, input: { path: path.join(h.media, `old-${index}.mp4`), state: { objectIdentity: null, size: 1, mtimeMs: 1 } },
      media: MEDIA, state: { status: 'succeeded' }, job: null, result: null, log: null, addedAt: 1, finishedAt: 1_000_000 + ((index * 7919) % 505) * 1000,
    }));
    await mkdir(h.state, { recursive: true });
    await writeFile(path.join(h.state, 'state.json'), JSON.stringify({ version: 1, options: { concurrency: 1, lowUsage: false }, outputDirectories: [], items }));
    await h.queue.restore();
    const kept = new Set(h.queue.snapshot().items.map(item => item.id));
    expect(kept.size).toBe(500);
    const earliest = [...items].sort((x, y) => x.finishedAt - y.finishedAt).slice(0, 5).map(item => item.id);
    for (const id of earliest) expect(kept.has(id)).toBe(false);
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect((await stateFile(h)).items).toHaveLength(500);
  });

  it('sets a corrupt state.json aside, starts empty and says so once', async () => {
    const h = await harness('corrupt', ['a.mp4']);
    await mkdir(h.state, { recursive: true });
    await writeFile(path.join(h.state, 'state.json'), '{"version":1,"items":[');
    await h.queue.restore();
    expect(await readFile(path.join(h.state, STATE_STORE_POLICY.corruptName), 'utf8')).toBe('{"version":1,"items":[');
    const first = h.queue.snapshot();
    expect(first).toMatchObject({ items: [], notice: 'state_reset', options: { concurrency: 1, lowUsage: false } });
    expect(h.queue.snapshot().notice).toBeNull();
    await addAll(h, ['a.mp4']);
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect((await stateFile(h)).items).toHaveLength(1);

    // A file of the wrong shape is set aside too; a single bad item is only left out.
    const wrong = withQueue(h);
    const valid = await stateFile(h);
    await writeFile(path.join(h.state, 'state.json'), JSON.stringify({ ...valid, items: [...valid.items, { id: 'bad' }] }));
    await wrong.queue.restore();
    expect(wrong.queue.snapshot()).toMatchObject({ notice: null });
    expect(wrong.queue.snapshot().items).toHaveLength(1);
    const shapeless = withQueue(h);
    await writeFile(path.join(h.state, 'state.json'), JSON.stringify({ version: 2, items: [] }));
    await shapeless.queue.restore();
    expect(shapeless.queue.snapshot()).toMatchObject({ items: [], notice: 'state_reset' });
    expect(JSON.parse(await readFile(path.join(h.state, STATE_STORE_POLICY.corruptName), 'utf8'))).toEqual({ version: 2, items: [] });
  });

  it('leaves out restored items whose output folder or outputs are not full paths', async () => {
    const h = await harness('restore-paths', ['a.mp4']);
    const [a] = await addAll(h, ['a.mp4']);
    await h.queue.start(startRequest([a]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    h.executor.runs[0].settle(published(h.executor.runs[0].job));
    await vi.waitFor(() => expect(stateOf(h, a).status).toBe('succeeded'));
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    const valid = await stateFile(h);
    const [item] = valid.items;
    const relativeFolder = { ...item, id: 'relative-folder', job: { ...item.job, output: { ...item.job.output, directory: 'out' } } };
    const relativeOutput = { ...item, id: 'relative-output', result: { ...item.result, outputs: [{ ...item.result.outputs[0], path: 'a.mkv' }] } };
    await writeFile(path.join(h.state, 'state.json'), JSON.stringify({ ...valid, items: [item, relativeFolder, relativeOutput] }));

    const restarted = withQueue(h);
    await restarted.queue.restore();
    expect(restarted.queue.snapshot().items.map(entry => entry.id)).toEqual([a]);
    expect(restarted.queue.outputPath(a)).toBe(path.join(h.media, 'a.mkv'));
    expect(await restarted.queue.retry({ itemIds: ['relative-folder'] })).toEqual({ affected: 0 });
    restarted.clock.advance(STATE_STORE_POLICY.debounceMs);
    await restarted.queue.persist();
    expect((await stateFile(h)).items.map((entry: { id: string }) => entry.id)).toEqual([a]);
  });

  it('keeps only the redacted last 16 KB of a failure log, and no path reaches the renderer', async () => {
    const h = await harness('log-tail', ['clip.mp4']);
    const [clip] = await addAll(h, ['clip.mp4']);
    await h.queue.start(startRequest([clip]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    const input = h.file('clip.mp4');
    const lines: string[] = [];
    // About 270 KB, mostly paths: redacted, still well over 16 KB.
    for (let index = 0; index < 1000; index++) {
      lines.push(`[line ${index}] Error while decoding ${input} near D:\\Elsewhere\\other ${index}.mkv and '${h.dir}/x y.tmp'`);
    }
    lines.push('Conversion failed!');
    h.executor.runs[0].settle({ status: 'failed', code: 'unknown', outputs: [], log: lines.join('\n') });
    await vi.waitFor(() => expect(stateOf(h, clip).status).toBe('failed'));
    const item = itemOf(h, clip);
    // The process's `unknown` is `encode_failed` for an item.
    expect(item.state).toEqual({ status: 'failed', code: 'encode_failed', partial: false });
    const log = item.log!;
    expect(Buffer.byteLength(log, 'utf8')).toBeLessThanOrEqual(QUEUE_LIMITS.logTailBytes);
    expect(Buffer.byteLength(log, 'utf8')).toBeGreaterThan(QUEUE_LIMITS.logTailBytes - 512);
    expect(log.endsWith('Conversion failed!')).toBe(true);
    expect(log.startsWith('[line ')).toBe(true);
    expect(log).toContain('<input>');
    expect(log.toLowerCase()).not.toContain(h.dir.toLowerCase());
    expect(log).not.toMatch(/[A-Za-z]:[\\/]/);
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect((await stateFile(h)).items[0].log).toBe(log);

    // A multi-output item that published one of two outputs is partly done; its outputs show names only.
    const partial = await harness('partial', ['two.mp4'], {
      planner: (media, settings, caps) => {
        const outcome = buildPlan(media, settings, caps);
        return outcome.status === 'ready' ? { ...outcome, plan: { ...outcome.plan, outputs: [outcome.plan.outputs[0], outcome.plan.outputs[0]] } } : outcome;
      },
    });
    const [two] = await addAll(partial, ['two.mp4']);
    await partial.queue.start(startRequest([two]));
    await vi.waitFor(() => expect(partial.executor.runs).toHaveLength(1));
    const first = (published(partial.executor.runs[0].job) as Extract<ExecutionOutcome, { status: 'succeeded' }>).outputs[0];
    partial.executor.runs[0].settle({ status: 'failed', code: 'output_publish_failed', outputs: [first], log: null });
    await vi.waitFor(() => expect(stateOf(partial, two).status).toBe('failed'));
    const summary = itemOf(partial, two);
    expect(summary.state).toEqual({ status: 'failed', code: 'output_publish_failed', partial: true });
    expect(summary.result).toMatchObject({ outputCount: 2, outputs: [{ index: 0, fileName: 'two.mkv', folderName: 'media', sizeBytes: 400_000, replaced: false }] });
    expect(partial.queue.outputPath(two, 0)).toBe(path.join(partial.media, 'two.mkv'));
    expect(partial.queue.outputPath(two, 1)).toBeNull();
    for (const snapshot of [h.queue.snapshot(), partial.queue.snapshot()]) {
      const text = JSON.stringify(snapshot);
      expect(text.toLowerCase()).not.toContain(root.toLowerCase().replace(/\\/g, '\\\\'));
      expect(text).not.toMatch(/[A-Za-z]:\\\\/);
    }
  });
});

// ── Confirmations and retry ────────────────────────────────────────────────────────────────────

describe('confirmations and retry', () => {
  /** buildPlan, with the lossy-to-lossless confirmation encode asks for (AC-ENCODE-04-5). */
  const lossless: QueuePlanner = (media, settings, caps) => {
    const outcome = buildPlan(media, settings, caps);
    return outcome.status === 'ready' ? { ...outcome, plan: { ...outcome.plan, summary: { ...outcome.plan.summary, confirmations: ['lossy_to_lossless'] } } } : outcome;
  };

  it('answers confirmation_required until a lossy-to-lossless conversion is confirmed, starting nothing meanwhile', async () => {
    const h = await harness('lossless', ['a.mp4', 'b.mp4'], { planner: lossless });
    const [a, b] = await addAll(h, ['a.mp4', 'b.mp4']);
    const first = startResultSchema.parse(await h.queue.start(startRequest([a, b], { confirmed: { lossyToLossless: [b], replaceExisting: false } })));
    expect(first).toEqual({
      started: [], skipped: [], rejected: [{ itemId: a, code: 'confirmation_required' }], needsConfirmation: { lossyToLossless: [a], wouldReplace: [] },
    });
    // b needed nothing more, yet waits with a: nothing starts while a confirmation is open.
    expect([stateOf(h, a), stateOf(h, b)]).toEqual([{ status: 'idle' }, { status: 'idle' }]);
    expect(h.executor.runs).toHaveLength(0);
    expect(h.power.start).not.toHaveBeenCalled();
    const second = await h.queue.start(startRequest([a, b], { confirmed: { lossyToLossless: [a, b], replaceExisting: false } }));
    expect(second).toMatchObject({ started: [a, b], rejected: [], needsConfirmation: null });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
  });

  it('lists the files an overwrite would replace and keeps the confirmed names for the executor', async () => {
    const h0 = await harness('overwrite', ['clip.mp4', 'other.mp4', 'third.mp4']);
    const outputs = new MediaOutputs({ root: path.join(h0.dir, 'outputs'), trashItem: async () => {} });
    const h = withQueue(h0, { wouldReplace: (directory, baseName, extension) => outputs.wouldReplace(directory, baseName, extension) });
    const [clip, other, third] = await addAll(h, ['clip.mp4', 'other.mp4', 'third.mp4']);
    await writeFile(h.file('clip.mkv'), 'an older conversion');
    const overwrite = { mode: 'source', conflict: 'overwrite' } as const;

    const asked = await h.queue.start(startRequest([clip, other], { output: overwrite }));
    expect(asked).toEqual({
      started: [], skipped: [], rejected: [{ itemId: clip, code: 'confirmation_required' }],
      needsConfirmation: { lossyToLossless: [], wouldReplace: [{ itemId: clip, fileName: 'clip.mkv' }] },
    });
    expect(h.executor.runs).toHaveLength(0);
    // Numbering instead needs no confirmation.
    const numbered = await h.queue.start(startRequest([other]));
    expect(numbered.started).toEqual([other]);
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    expect(h.executor.runs[0].job).toMatchObject({ conflict: 'number', confirmedReplace: [] });

    const confirmed = await h.queue.start(startRequest([clip], { output: overwrite, confirmed: { lossyToLossless: [], replaceExisting: true } }));
    expect(confirmed).toMatchObject({ started: [clip], needsConfirmation: null });
    h.executor.runs[0].settle(published(h.executor.runs[0].job));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(h.executor.runs[1].job).toMatchObject({
      itemId: clip, conflict: 'overwrite', confirmedReplace: ['clip.mkv'], targets: [{ directory: h.media, baseName: 'clip', extension: 'mkv' }],
    });
    expect(itemOf(h, clip).job?.output).toEqual({ mode: 'source', directoryName: null, conflict: 'overwrite' });

    // A remembered output folder by its id; an unknown id is refused.
    const folder = path.join(h.dir, 'chosen');
    await mkdir(folder);
    const directory = await h.queue.rememberOutputDirectory(folder);
    expect(directory.displayName).toBe('chosen');
    expect((await h.queue.rememberOutputDirectory(folder.toUpperCase())).id).toBe(directory.id);
    expect(h.queue.snapshot().outputDirectories).toEqual([directory]);
    const [late] = (await h.queue.add([h.file('other.mp4')])).duplicates;
    expect(late).toBe(other);
    // An item already started is not started again; a folder id the queue does not know is refused.
    expect((await h.queue.start(startRequest([clip]))).rejected).toEqual([{ itemId: clip, code: 'invalid_request' }]);
    const unknown = await h.queue.start(startRequest([third], { output: { mode: 'directory', directoryId: 'nope', conflict: 'number' } }));
    expect(unknown.rejected).toEqual([{ itemId: third, code: 'output_dir_unwritable' }]);
    const chosen = await h.queue.start(startRequest([third], { output: { mode: 'directory', directoryId: directory.id, conflict: 'number' } }));
    expect(chosen.started).toEqual([third]);
    expect(itemOf(h, third).job?.output).toEqual({ mode: 'directory', directoryName: 'chosen', conflict: 'number' });
    h.executor.runs[1].settle(published(h.executor.runs[1].job));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(3));
    expect(h.executor.runs[2].job.targets).toEqual([{ directory: folder, baseName: 'third', extension: 'mkv' }]);
  });

  it('skips a conversion that changes nothing until "convert anyway" overrides it', async () => {
    const h = await harness('already-target', ['same.mp4']);
    const [same] = await addAll(h, ['same.mp4']);
    const result = await h.queue.start(startRequest([same], { settings: TO_MP4 }));
    expect(result).toEqual({ started: [], skipped: [same], rejected: [], needsConfirmation: null });
    expect(stateOf(h, same)).toEqual({ status: 'skipped', reason: 'already_target' });
    expect(h.executor.runs).toHaveLength(0);
    // Without the override it is skipped again; with it the plan runs, and later retries keep it.
    await h.queue.retry({ itemIds: [same] });
    expect(stateOf(h, same)).toEqual({ status: 'skipped', reason: 'already_target' });
    expect(await h.queue.retry({ itemIds: [same], override: 'already_target' })).toEqual({ affected: 1 });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    expect(h.executor.runs[0].job.targets).toEqual([{ directory: h.media, baseName: 'same-converted', extension: 'mp4' }]);
    h.executor.runs[0].settle({ status: 'cancelled' });
    await vi.waitFor(() => expect(stateOf(h, same)).toEqual({ status: 'cancelled' }));
    await h.queue.retry({ itemIds: [same] });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
  });

  it('turns the not-larger guard off when a compression is retried with the not_smaller override', async () => {
    const seen: ConversionSettings[] = [];
    // The remux plan stands in for a compression plan: the queue only hands settings and plan on.
    const planner: QueuePlanner = (media, settings, caps) => { seen.push(settings); return buildPlan(media, TO_MKV, caps); };
    const h = await harness('not-smaller', ['big.mp4'], { planner });
    const [big] = await addAll(h, ['big.mp4']);
    const compress = defaultCompressSettings('av1');
    await h.queue.start(startRequest([big], { settings: compress }));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    expect(h.executor.runs[0].job.settings).toMatchObject({ task: 'compress', discardIfNotSmaller: true });
    h.executor.runs[0].settle({ status: 'skipped', reason: 'not_smaller' });
    await vi.waitFor(() => expect(stateOf(h, big)).toEqual({ status: 'skipped', reason: 'not_smaller' }));
    expect(eventsOf(h, 'batch-finished').at(-1)?.batch).toMatchObject({ skipped: 1 });

    await h.queue.retry({ itemIds: [big], override: 'not_smaller' });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(seen.at(-1)).toEqual({ ...compress, discardIfNotSmaller: false });
    expect(h.executor.runs[1].job.settings).toEqual({ ...compress, discardIfNotSmaller: false });
    expect(Object.isFrozen(h.executor.runs[1].job.settings)).toBe(true);
    expect(itemOf(h, big).job?.settings).toEqual({ ...compress, discardIfNotSmaller: false });
    h.executor.runs[1].settle(published(h.executor.runs[1].job, 990_000));
    await vi.waitFor(() => expect(stateOf(h, big).status).toBe('succeeded'));
    expect(eventsOf(h, 'batch-finished').at(-1)?.batch).toEqual({ succeeded: 1, failed: 0, skipped: 0, cancelled: 0, savedBytes: 10_000 });
  });

  it('refuses items that cannot start and says why', async () => {
    const h = await harness('rejections', ['bad.mp4', 'good.mp4', 'audio.mp4']);
    h.prober.probe.mockImplementation(async (filePath: string) => {
      const name = path.basename(filePath);
      if (name === 'bad.mp4') return { ok: false, code: 'container_not_allowed' };
      return { ok: true, info: name === 'audio.mp4' ? mediaInfoSchema.parse({ ...MEDIA, kind: 'audio', video: [], primaryVideoIndex: null }) : MEDIA };
    });
    const [bad, good, audio] = await addAll(h, ['bad.mp4', 'good.mp4', 'audio.mp4']);
    expect(stateOf(h, bad)).toEqual({ status: 'unsupported', code: 'container_not_allowed' });
    const compress = await h.queue.start(startRequest([bad, audio, 'missing-id'], { settings: defaultCompressSettings('h264') }));
    expect(compress.rejected).toEqual([
      { itemId: bad, code: 'container_not_allowed' }, { itemId: 'missing-id', code: 'invalid_request' }, { itemId: audio, code: 'task_not_applicable' },
    ]);
    h.caps.planner.mockResolvedValueOnce({ ok: false, code: 'runtime_missing' });
    expect((await h.queue.start(startRequest([good]))).rejected).toEqual([{ itemId: good, code: 'runtime_missing' }]);
    expect(stateOf(h, good)).toEqual({ status: 'idle' });
    expect(await h.queue.previewPlan(good, TO_MP4)).toMatchObject({ ok: true, status: 'skipped', reason: 'already_target' });
    expect(await h.queue.previewPlan(good, TO_MKV)).toMatchObject({ ok: true, status: 'ready', plan: { task: 'convert', remuxOnly: true } });
    expect(await h.queue.previewPlan(bad, TO_MKV)).toEqual({ ok: false, code: 'container_not_allowed' });
    expect(h.executor.runs).toHaveLength(0);
  });
});

// ── Batches, power and shutdown ────────────────────────────────────────────────────────────────

describe('batches, power and shutdown', () => {
  it('holds the power blocker for a batch and sends batch-finished once, late items joining the batch', async () => {
    const h = await harness('batch', ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    const [a, b, c, d] = await addAll(h, ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    expect(h.power.start).not.toHaveBeenCalled();
    await h.queue.start(startRequest([a, b]));
    expect(h.power.start).toHaveBeenCalledTimes(1);
    expect(h.power.start).toHaveBeenCalledWith('prevent-app-suspension');
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    h.executor.runs[0].settle(published(h.executor.runs[0].job));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    // Started after the first item of the batch ended, while the batch still runs: the same batch.
    await h.queue.start(startRequest([c]));
    h.executor.runs[1].settle({ status: 'failed', code: 'disk_full', outputs: [], log: null });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(3));
    expect(h.executor.runs.map(run => run.job.itemId)).toEqual([a, b, c]);
    expect(eventsOf(h, 'batch-finished')).toHaveLength(0);
    expect(h.power.stop).not.toHaveBeenCalled();
    h.executor.runs[2].settle(published(h.executor.runs[2].job));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    expect(eventsOf(h, 'batch-finished')[0].batch).toEqual({ succeeded: 2, failed: 1, skipped: 0, cancelled: 0, savedBytes: 0 });
    expect(h.power.start).toHaveBeenCalledTimes(1);
    expect(h.power.stop).toHaveBeenCalledTimes(1);
    expect(h.power.stop).toHaveBeenCalledWith(1);
    expect(h.executor.endBatch).toHaveBeenCalledTimes(1);

    // The next batch holds and releases the blocker again and finishes once.
    await h.queue.start(startRequest([d]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(4));
    expect(h.power.start).toHaveBeenCalledTimes(2);
    h.executor.runs[3].settle(published(h.executor.runs[3].job));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(2));
    expect(eventsOf(h, 'batch-finished')[1].batch).toEqual({ succeeded: 1, failed: 0, skipped: 0, cancelled: 0, savedBytes: 0 });
    expect(h.power.stop).toHaveBeenCalledTimes(2);
    expect(h.power.stop).toHaveBeenLastCalledWith(2);
    h.clock.advance(5000);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(eventsOf(h, 'batch-finished')).toHaveLength(2);
    expect(h.executor.endBatch).toHaveBeenCalledTimes(2);
    expect(h.invalid).toEqual([]);
  });

  it('shuts down: one promise for every caller, cancels and waits for every run, then writes interrupted items', async () => {
    const h = await harness('shutdown', ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    const [a, b, c, d] = await addAll(h, ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    await h.queue.setOptions({ concurrency: 2 });
    let reentered: Promise<void> | undefined;
    h.executor.onRun = run => run.hooks.signal.addEventListener('abort', () => { reentered ??= h.queue.shutdown('app_quit'); });
    await h.queue.start(startRequest([a, b, c]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(h.power.start).toHaveBeenCalledTimes(1);

    const shutdown = h.queue.shutdown('app_quit');
    expect(h.queue.shutdown('update')).toBe(shutdown);
    let done = false;
    void shutdown.then(() => { done = true; });
    await vi.waitFor(() => expect(h.executor.runs.every(run => run.hooks.signal.aborted)).toBe(true));
    expect(reentered).toBe(shutdown);
    expect(h.power.stop).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(done).toBe(false);
    h.executor.runs[0].settle({ status: 'cancelled' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(done).toBe(false);
    h.executor.runs[1].settle({ status: 'cancelled' });
    await shutdown;
    expect(h.executor.runs).toHaveLength(2);
    expect([a, b, c].map(id => stateOf(h, id))).toEqual([{ status: 'interrupted' }, { status: 'interrupted' }, { status: 'interrupted' }]);
    expect(stateOf(h, d)).toEqual({ status: 'idle' });
    expect(eventsOf(h, 'batch-finished')).toHaveLength(0);
    const written = await stateFile(h);
    expect(written.items.map((item: { state: ItemState }) => item.state.status)).toEqual(['interrupted', 'interrupted', 'interrupted', 'idle']);
    await expect(h.queue.start(startRequest([d]))).rejects.toMatchObject({ code: 'busy' });
    await expect(h.queue.add([h.file('d.mp4')])).rejects.toMatchObject({ code: 'busy' });
  });

  it('stops waiting for an executor that does not stop after the shutdown wait', async () => {
    const h = await harness('shutdown-stuck', ['a.mp4']);
    const [a] = await addAll(h, ['a.mp4']);
    await h.queue.start(startRequest([a]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    const shutdown = h.queue.shutdown();
    await settleWithClock(shutdown, h.clock, 500, QUEUE_POLICY.shutdownWaitMs / 500 + 20);
    expect(h.executor.runs[0].hooks.signal.aborted).toBe(true);
    expect(h.executor.runs[0].settled).toBe(false);
    expect(stateOf(h, a)).toEqual({ status: 'interrupted' });
    expect(h.power.stop).toHaveBeenCalledTimes(1);
    // A late answer changes nothing.
    h.executor.runs[0].settle(published(h.executor.runs[0].job));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stateOf(h, a)).toEqual({ status: 'interrupted' });
    expect((await stateFile(h)).items[0].state).toEqual({ status: 'interrupted' });
  });

  it('fails an item whose run cannot be settled instead of taking it again, and the batch still ends', async () => {
    let checks = 0;
    class BrokenRegistry extends InputRegistry {
      // A real tick first, so a scheduler that took the item again would spin visibly instead of starving the test's timers.
      override async verify(): Promise<never> { checks++; await new Promise(resolve => setTimeout(resolve, 1)); throw new Error('injected check failure'); }
    }
    const h = await harness('unsettled', ['a.mp4', 'b.mp4'], { inputs: new BrokenRegistry() });
    const [a, b] = await addAll(h, ['a.mp4', 'b.mp4']);
    await h.queue.start(startRequest([a, b]));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(checks).toBe(2);
    expect([stateOf(h, a), stateOf(h, b)]).toEqual([
      { status: 'failed', code: 'encode_failed', partial: false }, { status: 'failed', code: 'encode_failed', partial: false },
    ]);
    expect(eventsOf(h, 'batch-finished')[0].batch).toMatchObject({ failed: 2 });
    expect(h.executor.runs).toHaveLength(0);
    expect(h.power.stop).toHaveBeenCalledTimes(1);
    expect(h.invalid).toEqual([]);
  });

  it('takes the plan summary the executor ran with only when it has the summary shape', async () => {
    const h = await harness('summary', ['a.mp4', 'b.mp4']);
    const [a, b] = await addAll(h, ['a.mp4', 'b.mp4']);
    await h.queue.start(startRequest([a, b]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    const planned = itemOf(h, a).job!.plan;
    const fallback = { ...planned, warnings: [...planned.warnings, { code: 'encoder_fallback', streams: [0], count: 1, from: 'hevc_nvenc', to: 'libkvazaar' }] };
    h.executor.runs[0].settle({ ...published(h.executor.runs[0].job), summary: fallback } as ExecutionOutcome);
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(itemOf(h, a).job?.plan).toEqual(fallback);
    h.executor.runs[1].settle({ ...published(h.executor.runs[1].job), summary: { ...planned, task: 'transcode' } } as unknown as ExecutionOutcome);
    await vi.waitFor(() => expect(stateOf(h, b).status).toBe('succeeded'));
    expect(itemOf(h, b).job?.plan).toEqual(planned);
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect((await stateFile(h)).items.map((item: { job: { summary: unknown } }) => item.job.summary)).toEqual([fallback, planned]);
    expect(h.invalid).toEqual([]);
  });

  it('passes engine status changes on and reports a running hardware encode', async () => {
    const h = await harness('engine', ['a.mp4'], {
      planner: (media, settings, caps) => {
        const outcome = buildPlan(media, settings, caps);
        return outcome.status === 'ready'
          ? { ...outcome, plan: { ...outcome.plan, summary: { ...outcome.plan.summary, encoders: [{ encoder: 'hevc_nvenc', variant: '10bit' }] } } } : outcome;
      },
    });
    h.caps.set({ runtime: READY, capabilities: readyStatus(CAPS, ['hevc_nvenc']) });
    expect(eventsOf(h, 'engine').at(-1)?.engine.capabilities).toEqual(readyStatus(CAPS, ['hevc_nvenc']));
    const [a] = await addAll(h, ['a.mp4']);
    h.executor.onRun = run => run.hooks.signal.addEventListener('abort', () => run.settle({ status: 'cancelled' }));
    expect(h.queue.isHardwareEncodeRunning()).toBe(false);
    await h.queue.start(startRequest([a]));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    expect(h.queue.isHardwareEncodeRunning()).toBe(true);
    await h.queue.shutdown();
    expect(h.caps.listeners.size).toBe(0);
    expect(h.invalid).toEqual([]);
  });
});

// ── Batch C follow-ups (2026-10-28) ────────────────────────────────────────────────────────────

describe('detection, disk space, cancelled outputs and preview alternatives', () => {
  /** An MP4 with two AAC tracks, for "all tracks" extraction: two outputs. */
  const TWO_TRACKS: MediaInfo = mediaInfoSchema.parse({
    ...MEDIA, audio: [MEDIA.audio[0], { ...MEDIA.audio[0], index: 2, typeIndex: 1, language: 'jpn', default: false }],
  });
  const ALL_TRACKS: ConversionSettings = Object.freeze({ task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: true });
  const firstOutput = (job: ExecutionJob, sizeBytes: number) => (published(job, sizeBytes) as Extract<ExecutionOutcome, { status: 'succeeded' }>).outputs[0];

  it('a ready capability status carries every field the engine sets: degraded, driver updates, resolved encoders and defaults', () => {
    const full = readyStatus() as Extract<CapabilityStatus, { state: 'ready' }>;
    expect(full).toMatchObject({ state: 'ready', degraded: [], driverUpdates: [], defaults: { compressCodec: 'h264' } });
    for (const field of ['degraded', 'driverUpdates', 'resolvedEncoders', 'defaults'] as const) {
      const without: Record<string, unknown> = { ...full };
      delete without[field];
      expect(capabilityStatusSchema.safeParse(without).success, field).toBe(false);
    }
    expect(capabilityStatusSchema.safeParse({ state: 'ready', hardwareEncoders: [] }).success).toBe(false);
  });

  it('starts nothing while the encoders are detected, and the queued items once the detection ends', async () => {
    let checks = 0;
    class CountingRegistry extends InputRegistry {
      override verify(itemId: string) { checks++; return super.verify(itemId); }
    }
    const h = await harness('detecting', ['a.mp4', 'b.mp4', 'c.mp4'], { inputs: new CountingRegistry() });
    const [a, b, c] = await addAll(h, ['a.mp4', 'b.mp4', 'c.mp4']);
    await h.queue.setOptions({ concurrency: 2 });
    // The first detection or "detect again" runs: the items are queued and the batch holds the power blocker, but none
    // takes a slot, not even for the input check before a run.
    h.caps.set({ runtime: READY, capabilities: { state: 'detecting' } });
    expect((await h.queue.start(startRequest([a, b, c]))).started).toEqual([a, b, c]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.executor.runs).toHaveLength(0);
    expect(checks).toBe(0);
    expect([a, b, c].map(id => stateOf(h, id))).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }]);
    expect(h.power.start).toHaveBeenCalledTimes(1);
    // Another engine event of the same detection changes nothing.
    h.caps.set({ runtime: READY, capabilities: { state: 'detecting' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.executor.runs).toHaveLength(0);

    // It ends: the queued items start in their order, two at once.
    h.caps.set({ runtime: READY, capabilities: readyStatus() });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(h.executor.runs.map(run => run.job.itemId).sort()).toEqual([a, b].sort());
    // A detection begins while two run: they go on, and c waits for its end although a slot frees.
    h.caps.set({ runtime: READY, capabilities: { state: 'detecting' } });
    const first = h.executor.runs[0];
    first.settle(published(first.job));
    await vi.waitFor(() => expect(stateOf(h, first.job.itemId).status).toBe('succeeded'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.executor.runs).toHaveLength(2);
    expect(stateOf(h, c)).toEqual({ status: 'queued' });
    // A detection that ends without a table (the runtime cannot be used) has settled too: the executor answers for c.
    h.caps.set({ runtime: { state: 'unavailable', code: 'runtime_missing' }, capabilities: { state: 'unavailable', code: 'runtime_missing' } });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(3));
    expect(h.executor.runs[2].job.itemId).toBe(c);
    for (const run of h.executor.runs.slice(1)) run.settle(published(run.job));
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    expect(eventsOf(h, 'batch-finished')[0].batch).toMatchObject({ succeeded: 3, failed: 0 });
    expect(h.power.stop).toHaveBeenCalledTimes(1);
    expect(h.invalid).toEqual([]);
  });

  it('gives the slot back when a detection begins during the input check, and runs the item once it ends', async () => {
    let release!: () => void;
    const checked = new Promise<void>(resolve => { release = resolve; });
    let checks = 0;
    class SlowRegistry extends InputRegistry {
      override async verify(itemId: string) {
        if (++checks === 1) await checked;
        return super.verify(itemId);
      }
    }
    const h = await harness('detecting-during-check', ['a.mp4'], { inputs: new SlowRegistry() });
    const [a] = await addAll(h, ['a.mp4']);
    await h.queue.start(startRequest([a]));
    await vi.waitFor(() => expect(checks).toBe(1));
    h.caps.set({ runtime: READY, capabilities: { state: 'detecting' } });
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.executor.runs).toHaveLength(0);
    expect(stateOf(h, a)).toEqual({ status: 'queued' });
    h.caps.set({ runtime: READY, capabilities: readyStatus() });
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    // The input was checked again before the run.
    expect(checks).toBe(2);
    h.executor.runs[0].settle(published(h.executor.runs[0].job));
    await vi.waitFor(() => expect(stateOf(h, a).status).toBe('succeeded'));
    expect(h.invalid).toEqual([]);
  });

  it('keeps the bytes of disk_space_low in the failed state, in state.json and after a restart (AC-ENGINE-06-4)', async () => {
    const h = await harness('disk-space', ['a.mp4', 'b.mp4', 'c.mp4']);
    const [a, b, c] = await addAll(h, ['a.mp4', 'b.mp4', 'c.mp4']);
    await h.queue.start(startRequest([a, b, c]));
    const space = { requiredBytes: 512 * 1024 * 1024 + 980_000, availableBytes: 400 * 1024 * 1024 };
    const settleNext = async (index: number, outcome: ExecutionOutcome) => {
      await vi.waitFor(() => expect(h.executor.runs).toHaveLength(index + 1));
      h.executor.runs[index].settle(outcome);
    };
    await settleNext(0, { status: 'failed', code: 'disk_space_low', outputs: [], log: '[media-converter] Not enough free space on the output volume.', space });
    // Another code never carries it, and bytes out of shape are left out while the code stays.
    await settleNext(1, { status: 'failed', code: 'output_dir_unwritable', outputs: [], log: null, space });
    await settleNext(2, { status: 'failed', code: 'disk_space_low', outputs: [], log: null, space: { requiredBytes: -1, availableBytes: 0.5 } });
    await vi.waitFor(() => expect(stateOf(h, c).status).toBe('failed'));

    const expected = { status: 'failed', code: 'disk_space_low', partial: false, space };
    const others = [{ status: 'failed', code: 'output_dir_unwritable', partial: false }, { status: 'failed', code: 'disk_space_low', partial: false }];
    expect([stateOf(h, a), stateOf(h, b), stateOf(h, c)]).toEqual([expected, ...others]);
    expect(itemSummarySchema.parse(itemOf(h, a)).state).toEqual(expected);
    // The contract itself keeps the bytes to disk_space_low.
    expect(itemStateSchema.safeParse({ status: 'failed', code: 'output_dir_unwritable', partial: false, space }).success).toBe(false);
    // The renderer learns it from the event, which the contract checks.
    expect(eventsOf(h, 'items').flatMap(event => event.items).filter(item => item.id === a).at(-1)?.state).toEqual(expected);
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect((await stateFile(h)).items.map((item: { state: ItemState }) => item.state)).toEqual([expected, ...others]);

    await h.queue.shutdown();
    const restarted = withQueue(h);
    await restarted.queue.restore();
    expect(queueSnapshotSchema.parse(restarted.queue.snapshot()).items.map(item => item.state)).toEqual([expected, ...others]);
    // A retry starts it again without the bytes.
    expect(await restarted.queue.retry({ itemIds: [a] })).toEqual({ affected: 1 });
    expect(stateOf(restarted, a)).toEqual({ status: 'queued' });
    expect(h.invalid).toEqual([]);
    expect(restarted.invalid).toEqual([]);
  });

  it('lists what a cancelled item of several outputs had published, so they can be shown, also when the app quits', async () => {
    const h = await harness('cancelled-outputs', ['tracks.mp4', 'more.mp4', 'plain.mp4'], {
      prober: fakeProber({ 'tracks.mp4': { ok: true, info: TWO_TRACKS }, 'more.mp4': { ok: true, info: TWO_TRACKS } }),
    });
    const [tracks, more, plain] = await addAll(h, ['tracks.mp4', 'more.mp4', 'plain.mp4']);
    await h.queue.start(startRequest([tracks, plain], { settings: ALL_TRACKS }));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(1));
    const run = h.executor.runs[0];
    expect(run.job.targets.map(target => `${target.baseName}.${target.extension}`)).toEqual(['tracks.track1.eng.m4a', 'tracks.track2.jpn.m4a']);
    expect(await h.queue.cancel({ itemIds: [tracks] })).toEqual({ affected: 1 });
    expect(run.hooks.signal.aborted).toBe(true);
    run.settle({ status: 'cancelled', outputs: [firstOutput(run.job, 123_456)], warnings: [] });
    await vi.waitFor(() => expect(stateOf(h, tracks).status).toBe('cancelled'));

    const summary = itemSummarySchema.parse(itemOf(h, tracks));
    expect(summary.state).toEqual({ status: 'cancelled' });
    expect(summary.result).toEqual({
      outputs: [{ index: 0, fileName: 'tracks.track1.eng.m4a', folderName: 'media', sizeBytes: 123_456, replaced: false }],
      outputCount: 2, sourceBytes: MEDIA.sizeBytes, outputBytes: 123_456, warnings: [],
    });
    expect(h.queue.outputPath(tracks, 0)).toBe(path.join(h.media, 'tracks.track1.eng.m4a'));
    expect(h.queue.outputPath(tracks, 1)).toBeNull();
    // A cancel that published nothing has no result.
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(2));
    expect(await h.queue.cancel({ itemIds: [plain] })).toEqual({ affected: 1 });
    h.executor.runs[1].settle({ status: 'cancelled' });
    await vi.waitFor(() => expect(stateOf(h, plain).status).toBe('cancelled'));
    expect(itemOf(h, plain).result).toBeNull();
    await vi.waitFor(() => expect(eventsOf(h, 'batch-finished')).toHaveLength(1));
    expect(eventsOf(h, 'batch-finished')[0].batch).toEqual({ succeeded: 0, failed: 0, skipped: 0, cancelled: 2, savedBytes: 0 });
    h.clock.advance(STATE_STORE_POLICY.debounceMs);
    await h.queue.persist();
    expect((await stateFile(h)).items[0].result.outputs).toEqual([{ index: 0, path: path.join(h.media, 'tracks.track1.eng.m4a'), sizeBytes: 123_456, replaced: false }]);

    // The app quits while the next item writes its second track: interrupted, with its first track listed.
    await h.queue.start(startRequest([more], { settings: ALL_TRACKS }));
    await vi.waitFor(() => expect(h.executor.runs).toHaveLength(3));
    const quitting = h.executor.runs[2];
    quitting.hooks.signal.addEventListener('abort', () => quitting.settle({ status: 'cancelled', outputs: [firstOutput(quitting.job, 77)], warnings: [] }));
    await h.queue.shutdown();
    expect(stateOf(h, more)).toEqual({ status: 'interrupted' });
    expect(itemOf(h, more).result).toMatchObject({ outputs: [{ index: 0, fileName: 'more.track1.eng.m4a', sizeBytes: 77 }], outputCount: 2 });
    const restarted = withQueue(h);
    await restarted.queue.restore();
    expect(restarted.queue.outputPath(more, 0)).toBe(path.join(h.media, 'more.track1.eng.m4a'));
    expect(restarted.queue.outputPath(tracks, 0)).toBe(path.join(h.media, 'tracks.track1.eng.m4a'));
    expect(h.invalid).toEqual([]);
  });

  it('previews no_encoder_available with the codecs that would work instead; other plan errors stay codes', async () => {
    let answer: PlanOutcome = { status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'h264'] };
    const h = await harness('preview-alternatives', ['a.mp4'], { planner: () => answer });
    const [a] = await addAll(h, ['a.mp4']);
    const hevc = defaultCompressSettings('hevc');
    const preview = await h.queue.previewPlan(a, hevc);
    expect(preview).toEqual({ ok: true, status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'h264'] });
    const { ok: _ok, ...value } = preview as Extract<typeof preview, { ok: true }>;
    expect(previewPlanResultSchema.parse(value)).toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'h264'] });
    // None would work; a planner listing a codec twice, or one the contract does not know, is cleaned up.
    answer = { status: 'error', reason: 'no_encoder_available', alternatives: [] };
    expect(await h.queue.previewPlan(a, hevc)).toEqual({ ok: true, status: 'error', reason: 'no_encoder_available', alternatives: [] });
    answer = { status: 'error', reason: 'no_encoder_available', alternatives: ['h264', 'h264', 'vp9' as never] };
    expect(await h.queue.previewPlan(a, hevc)).toEqual({ ok: true, status: 'error', reason: 'no_encoder_available', alternatives: ['h264'] });
    answer = { status: 'error', reason: 'dolby_vision_p5_unsupported', alternatives: [] };
    expect(await h.queue.previewPlan(a, hevc)).toEqual({ ok: false, code: 'dolby_vision_p5_unsupported' });
    answer = { status: 'not_applicable', reason: 'no_audio_stream' };
    expect(await h.queue.previewPlan(a, hevc)).toEqual({ ok: false, code: 'no_audio_stream' });
    // Starting such an item answers the code alone.
    answer = { status: 'error', reason: 'no_encoder_available', alternatives: ['av1'] };
    expect(await h.queue.start(startRequest([a], { settings: hevc }))).toEqual({
      started: [], skipped: [], rejected: [{ itemId: a, code: 'no_encoder_available' }], needsConfirmation: null,
    });
    expect(stateOf(h, a)).toEqual({ status: 'idle' });
  });
});
