import { describe, expect, it, vi } from 'vitest';
import {
  mediaConverterSnapshotSchema,
  type BatchSummary,
  type ConversionSettings,
  type EngineStatus,
  type ItemProgress,
  type ItemSummary,
  type MediaConverterApi,
  type MediaConverterSnapshot,
  type QueueEvent,
  type ResolvedEncoder,
  type ResolvedEncoders,
} from '@/media-converter/contract';

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key, language: 'en' } }));
vi.mock('@/utils/notification', () => ({ showSystemNotification: vi.fn() }));

const { createMediaConverterController, hardwareEncodeRunning, jobUsesHardwareEncoder, MediaConverterClientError, settingsSignature, unwrapMediaResult } =
  await import('./controller');

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const encoder = (id: ResolvedEncoder['encoder'], variant: ResolvedEncoder['variant'], hardware: boolean, weak = false): ResolvedEncoder =>
  ({ encoder: id, variant, hardware, weak, nameKey: `media:encoders.${id}` });
const CPU: ResolvedEncoders = {
  av1: { gpuOff: encoder('libsvtav1', '10bit', false), gpuOn: encoder('libsvtav1', '10bit', false) },
  hevc: { gpuOff: encoder('libkvazaar', '8bit', false, true), gpuOn: encoder('libkvazaar', '8bit', false, true) },
  h264: { gpuOff: encoder('libopenh264', '8bit', false, true), gpuOn: encoder('libopenh264', '8bit', false, true) },
};
const NVENC: ResolvedEncoders = {
  av1: { gpuOff: encoder('libsvtav1', '10bit', false), gpuOn: encoder('av1_nvenc', '10bit_uhq', true) },
  hevc: { gpuOff: encoder('hevc_nvenc', '10bit_uhq', true), gpuOn: encoder('hevc_nvenc', '10bit_uhq', true) },
  h264: { gpuOff: encoder('h264_nvenc', '8bit', true), gpuOn: encoder('h264_nvenc', '8bit', true) },
};
const READY_ENGINE: EngineStatus = {
  runtime: { state: 'ready', version: 'n8.1.2' },
  capabilities: { state: 'ready', hardwareEncoders: ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc'], degraded: [], driverUpdates: [], resolvedEncoders: NVENC, defaults: { compressCodec: 'hevc' } },
};
const DETECTING_ENGINE: EngineStatus = { runtime: { state: 'ready', version: 'n8.1.2' }, capabilities: { state: 'detecting' } };
const COMPRESS: ConversionSettings = { task: 'compress', tier: 'balanced', codec: 'hevc', container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: true };

function item(id: string, patch: Partial<ItemSummary> = {}): ItemSummary {
  return { id, displayName: `${id}.mp4`, folderName: 'videos', media: null, state: { status: 'idle' }, job: null, progress: null, result: null, log: null, addedAt: 1, finishedAt: null, ...patch };
}

function runningJob(encoderId: 'hevc_nvenc' | 'libsvtav1' | 'h264_mf', variant: '10bit_uhq' | '10bit' | '8bit_sw' | '8bit'): ItemSummary['job'] {
  return {
    settings: COMPRESS,
    plan: {
      task: 'compress', remuxOnly: false, encoders: [{ encoder: encoderId, variant }], warnings: [], confirmations: [],
      outputs: [{ container: 'mp4', extension: 'mp4', track: null, streams: [], attachments: { count: 0, kept: true }, chapters: { count: 0, kept: true }, dataStreamsDropped: 0 }],
    },
    output: { mode: 'source', directoryName: null, conflict: 'number' },
  };
}

const progress = (fraction: number): ItemProgress => ({ fraction, processedUs: null, writtenBytes: null, speed: null, fps: null, etaMs: null, outputIndex: 0, outputCount: 1 });

function snapshot(patch: Partial<MediaConverterSnapshot> = {}): MediaConverterSnapshot {
  return mediaConverterSnapshotSchema.parse({
    sequence: 10, engine: DETECTING_ENGINE, items: [item('a'), item('b')], options: { concurrency: 1, lowUsage: false },
    outputDirectories: [{ id: 'dir1', displayName: 'Exports' }], notice: null, resolvedEncoders: CPU, defaults: { compressCodec: 'h264' }, ...patch,
  });
}

/** A fake `window.mediaConverter` with a manual clock and timers, and the controller under test. */
function harness(options: { snapshot?: MediaConverterSnapshot; focused?: boolean; supported?: boolean } = {}) {
  const listeners = new Set<(event: QueueEvent) => void>();
  let resolveSnapshot: ((value: unknown) => void) | undefined;
  const api = {
    supported: options.supported ?? true,
    getSnapshot: vi.fn(() => new Promise(resolve => { resolveSnapshot = resolve; })),
    addDroppedFiles: vi.fn(async () => ({ ok: true, value: { added: [], duplicates: [], rejected: [], truncated: 0 } })),
    pickFiles: vi.fn(async () => ({ ok: true, value: { added: ['c'], duplicates: [], rejected: [], truncated: 0 } })),
    pickOutputDirectory: vi.fn(async () => ({ ok: true, value: { directory: { id: 'dir2', displayName: 'Out' } } })),
    previewPlan: vi.fn(async () => ({ ok: true, value: { status: 'ready', plan: runningJob('hevc_nvenc', '10bit_uhq')!.plan } })),
    start: vi.fn(async () => ({ ok: true, value: { started: [], skipped: [], rejected: [], needsConfirmation: null } })),
    cancel: vi.fn(async () => ({ ok: true, value: { affected: 1 } })),
    remove: vi.fn(async () => ({ ok: true, value: { affected: 1 } })),
    retry: vi.fn(async () => ({ ok: true, value: { affected: 1 } })),
    clear: vi.fn(async () => ({ ok: true, value: { removed: 1 } })),
    revealOutput: vi.fn(async () => ({ ok: true, value: {} })),
    setOptions: vi.fn(async (patch: { lowUsage?: boolean }) => ({ ok: true, value: { concurrency: 1, lowUsage: patch.lowUsage ?? false } })),
    redetectCapabilities: vi.fn(async () => ({ ok: true, value: {} })),
    onChanged: vi.fn((listener: (event: QueueEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
  };
  let now = 1_000;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  const notifyBatch = vi.fn<(batch: BatchSummary) => void>();
  let focused = options.focused ?? true;
  const controller = createMediaConverterController({
    getApi: () => api as unknown as MediaConverterApi,
    now: () => now,
    schedule: (callback, delay) => { const timer = { at: now + delay, callback, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    isWindowFocused: () => focused,
    notifyBatch,
  });
  const views: number[] = [];
  return {
    api, controller, notifyBatch,
    /** Emits as the preload would. */
    emit: (event: QueueEvent) => { for (const listener of listeners) listener(event); },
    answerSnapshot: async (value: MediaConverterSnapshot = options.snapshot ?? snapshot()) => {
      await flush();
      resolveSnapshot?.({ ok: true, value });
      await flush();
    },
    advance: (ms: number) => {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.cancelled || timer.at > now) continue;
        timer.cancelled = true;
        timer.callback();
      }
    },
    setFocused: (value: boolean) => { focused = value; },
    /** Subscribes like the page and counts the renders a change would cause. */
    view: () => controller.subscribe(() => views.push(views.length)),
    renders: () => views.length,
    state: () => controller.getState(),
    listenerCount: () => listeners.size,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const progressOf = (h: ReturnType<typeof harness>, id: string) => h.state().items.find(entry => entry.id === id)?.progress?.fraction ?? null;

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────

describe('media converter controller', () => {
  it('reads the snapshot on the first subscription and keeps listening after the page unsubscribes', async () => {
    const h = harness();
    expect(h.state().phase).toBe('idle');
    const unsubscribe = h.view();
    expect(h.state().phase).toBe('loading');
    expect(h.api.onChanged).toHaveBeenCalledTimes(1);
    await h.answerSnapshot();
    expect(h.state()).toMatchObject({ phase: 'ready', sequence: 10, defaults: { compressCodec: 'h264' }, options: { lowUsage: false } });
    expect(h.state().items.map(entry => entry.id)).toEqual(['a', 'b']);
    expect(h.state().resolvedEncoders).toEqual(CPU);

    // Leaving the page: the queue view and its event subscription stay (design 渲染进程架构).
    unsubscribe();
    h.view();
    expect(h.api.getSnapshot).toHaveBeenCalledTimes(1);
    expect(h.listenerCount()).toBe(1);
    h.emit({ sequence: 11, kind: 'items', items: [item('c')], removed: [] });
    expect(h.state().items.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('applies the events that arrive during the snapshot read only when they are newer than it', async () => {
    const h = harness();
    h.view();
    h.emit({ sequence: 9, kind: 'items', items: [item('a', { displayName: 'stale.mp4' })], removed: [] });
    h.emit({ sequence: 10, kind: 'items', items: [], removed: ['b'] });
    h.emit({ sequence: 11, kind: 'items', items: [item('a', { state: { status: 'queued' } })], removed: [] });
    expect(h.state().phase).toBe('loading');
    await h.answerSnapshot();
    expect(h.state().sequence).toBe(11);
    // 9 and 10 were covered by the snapshot (sequence 10): b stays, the stale name never shows.
    expect(h.state().items.map(entry => [entry.id, entry.displayName, entry.state.status])).toEqual([['a', 'a.mp4', 'queued'], ['b', 'b.mp4', 'idle']]);
  });

  it('drops duplicated and out-of-order events by sequence', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    h.emit({ sequence: 12, kind: 'items', items: [item('a', { state: { status: 'queued' } })], removed: [] });
    h.emit({ sequence: 11, kind: 'items', items: [item('a', { state: { status: 'succeeded' } })], removed: ['b'] });
    h.emit({ sequence: 12, kind: 'items', items: [], removed: ['a'] });
    expect(h.state().sequence).toBe(12);
    expect(h.state().items.map(entry => [entry.id, entry.state.status])).toEqual([['a', 'queued'], ['b', 'idle']]);
    h.emit({ sequence: 13, kind: 'options', options: { concurrency: 1, lowUsage: true }, outputDirectories: [] });
    h.emit({ sequence: 12, kind: 'options', options: { concurrency: 1, lowUsage: false }, outputDirectories: [] });
    expect(h.state().options).toEqual({ concurrency: 1, lowUsage: true });
    expect(h.state().outputDirectories).toEqual([]);
  });

  it('merges item changes: replaces in place, appends new items, removes ids', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    const before = h.state().items;
    h.emit({ sequence: 11, kind: 'items', items: [item('d'), item('b', { state: { status: 'queued' } }), item('c')], removed: ['a'] });
    expect(h.state().items.map(entry => [entry.id, entry.state.status])).toEqual([['b', 'queued'], ['d', 'idle'], ['c', 'idle']]);
    // Unchanged items keep their identity so only changed rows re-render.
    const [firstB, firstD, firstC] = h.state().items;
    h.emit({ sequence: 12, kind: 'items', items: [item('c', { state: { status: 'queued' } })], removed: [] });
    expect(h.state().items[0]).toBe(firstB);
    expect(h.state().items[1]).toBe(firstD);
    expect(h.state().items[2]).not.toBe(firstC);
    expect(h.state().items[2].state.status).toBe('queued');
    expect(before).not.toBe(h.state().items);
    const b = h.state().items.find(entry => entry.id === 'b');
    h.emit({ sequence: 13, kind: 'items', items: [item('d', { state: { status: 'queued' } })], removed: [] });
    expect(h.state().items.find(entry => entry.id === 'b')).toBe(b);
  });

  it('replaces only the progress of its item, at most every 250 ms per item, the latest one winning', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    const b = h.state().items[1];
    h.emit({ sequence: 11, kind: 'progress', itemId: 'a', progress: progress(0.1) });
    expect(progressOf(h, 'a')).toBe(0.1);
    expect(h.state().items[1]).toBe(b);
    const renders = h.renders();
    h.advance(100);
    h.emit({ sequence: 12, kind: 'progress', itemId: 'a', progress: progress(0.2) });
    h.emit({ sequence: 13, kind: 'progress', itemId: 'a', progress: progress(0.3) });
    // Another item has its own window and shows at once.
    h.emit({ sequence: 14, kind: 'progress', itemId: 'b', progress: progress(0.5) });
    expect(progressOf(h, 'a')).toBe(0.1);
    expect(progressOf(h, 'b')).toBe(0.5);
    expect(h.state().sequence).toBe(14);
    h.advance(149);
    expect(progressOf(h, 'a')).toBe(0.1);
    h.advance(1);
    expect(progressOf(h, 'a')).toBe(0.3);
    // One render for b, one for a's coalesced 0.2/0.3.
    expect(h.renders() - renders).toBe(2);
    // A progress older than the shown one is dropped by its sequence.
    h.emit({ sequence: 13, kind: 'progress', itemId: 'a', progress: progress(0.25) });
    h.advance(1_000);
    expect(progressOf(h, 'a')).toBe(0.3);
    // Unknown items get none.
    h.emit({ sequence: 15, kind: 'progress', itemId: 'zzz', progress: progress(0.9) });
    expect(h.state().items.map(entry => entry.id)).toEqual(['a', 'b']);
  });

  it('drops a waiting progress when a newer summary of its item arrives', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    h.emit({ sequence: 11, kind: 'progress', itemId: 'a', progress: progress(0.4) });
    h.emit({ sequence: 12, kind: 'progress', itemId: 'a', progress: progress(0.9) });
    h.emit({ sequence: 13, kind: 'items', items: [item('a', { state: { status: 'succeeded' } })], removed: [] });
    h.advance(1_000);
    expect(h.state().items[0]).toMatchObject({ state: { status: 'succeeded' }, progress: null });
  });

  it('notifies a finished batch only when the window is not in front', async () => {
    const h = harness({ focused: true });
    h.view();
    await h.answerSnapshot();
    const batch: BatchSummary = { succeeded: 2, failed: 1, skipped: 0, cancelled: 0, savedBytes: 5_000_000 };
    h.emit({ sequence: 11, kind: 'batch-finished', batch });
    expect(h.notifyBatch).not.toHaveBeenCalled();
    h.setFocused(false);
    h.emit({ sequence: 12, kind: 'batch-finished', batch });
    expect(h.notifyBatch).toHaveBeenCalledTimes(1);
    expect(h.notifyBatch).toHaveBeenCalledWith(batch);
    // A replayed event and a batch the user only cancelled say nothing.
    h.emit({ sequence: 12, kind: 'batch-finished', batch });
    h.emit({ sequence: 13, kind: 'batch-finished', batch: { succeeded: 0, failed: 0, skipped: 0, cancelled: 3, savedBytes: 0 } });
    expect(h.notifyBatch).toHaveBeenCalledTimes(1);
    expect(h.state().sequence).toBe(13);
  });

  it('sends the default notification through the system notification of the app, with the saved size only when there is one', async () => {
    const { showSystemNotification } = await import('@/utils/notification');
    const notify = vi.mocked(showSystemNotification);
    notify.mockClear();
    const listeners = new Set<(event: QueueEvent) => void>();
    const api = {
      supported: true,
      getSnapshot: vi.fn(async () => ({ ok: true, value: snapshot() })),
      onChanged: vi.fn((listener: (event: QueueEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    };
    const controller = createMediaConverterController({ getApi: () => api as unknown as MediaConverterApi, isWindowFocused: () => false });
    controller.subscribe(() => undefined);
    await flush();
    expect(controller.getState().phase).toBe('ready');
    for (const listener of listeners) listener({ sequence: 11, kind: 'batch-finished', batch: { succeeded: 1, failed: 0, skipped: 0, cancelled: 0, savedBytes: 3 * 1024 ** 3 } });
    for (const listener of listeners) listener({ sequence: 12, kind: 'batch-finished', batch: { succeeded: 0, failed: 1, skipped: 0, cancelled: 0, savedBytes: 0 } });
    expect(notify.mock.calls).toEqual([
      ['media:notifications.batch_title', 'media:notifications.batch_body media:notifications.batch_saved'],
      ['media:notifications.batch_title', 'media:notifications.batch_body'],
    ]);
    controller.dispose();
    expect(listeners.size).toBe(0);
  });

  it('takes the detection results from engine events and keeps the last known ones while detecting', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    h.emit({ sequence: 11, kind: 'engine', engine: READY_ENGINE });
    expect(h.state()).toMatchObject({ resolvedEncoders: NVENC, defaults: { compressCodec: 'hevc' }, engine: READY_ENGINE });
    h.emit({ sequence: 12, kind: 'engine', engine: DETECTING_ENGINE });
    expect(h.state()).toMatchObject({ resolvedEncoders: NVENC, defaults: { compressCodec: 'hevc' } });
    expect(h.state().engine?.capabilities.state).toBe('detecting');
  });

  it('prefers a ready snapshot engine over the snapshot-level CPU defaults', async () => {
    const h = harness({ snapshot: snapshot({ engine: READY_ENGINE }) });
    h.view();
    await h.answerSnapshot();
    expect(h.state().defaults).toEqual({ compressCodec: 'hevc' });
    expect(h.state().resolvedEncoders).toEqual(NVENC);
  });

  it('sends queue options to the main process and shows what it kept', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    const saved = await h.controller.setOptions({ lowUsage: true });
    expect(h.api.setOptions).toHaveBeenCalledWith({ lowUsage: true });
    expect(saved).toEqual({ concurrency: 1, lowUsage: true });
    expect(h.state()).toMatchObject({ options: { lowUsage: true }, savingOptions: false });

    // An options event that arrives before the answer is newer than it: the answer does not undo it.
    let answer: ((value: unknown) => void) | undefined;
    h.api.setOptions.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }) as never);
    const pending = h.controller.setOptions({ lowUsage: false });
    expect(h.state().savingOptions).toBe(true);
    h.emit({ sequence: 11, kind: 'options', options: { concurrency: 1, lowUsage: true }, outputDirectories: [] });
    answer?.({ ok: true, value: { concurrency: 1, lowUsage: false } });
    await pending;
    expect(h.state().options).toEqual({ concurrency: 1, lowUsage: true });
  });

  it('caches plans by item and settings signature until the item or the engine changes', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    const first = h.controller.previewPlan('a', COMPRESS);
    expect(h.controller.previewPlan('a', { ...COMPRESS })).toBe(first);
    expect(h.controller.previewPlan('a', { discardIfNotSmaller: true, useGpuForAv1: false, maxShortSide: null, container: 'auto', codec: 'hevc', tier: 'balanced', task: 'compress' })).toBe(first);
    expect(h.api.previewPlan).toHaveBeenCalledTimes(1);
    h.controller.previewPlan('a', { ...COMPRESS, tier: 'size' });
    h.controller.previewPlan('b', COMPRESS);
    expect(h.api.previewPlan).toHaveBeenCalledTimes(3);
    h.emit({ sequence: 11, kind: 'items', items: [item('a', { displayName: 'renamed.mp4' })], removed: [] });
    h.controller.previewPlan('a', COMPRESS);
    h.controller.previewPlan('b', COMPRESS);
    expect(h.api.previewPlan).toHaveBeenCalledTimes(4);
    h.emit({ sequence: 12, kind: 'engine', engine: READY_ENGINE });
    h.controller.previewPlan('b', COMPRESS);
    expect(h.api.previewPlan).toHaveBeenCalledTimes(5);
    // A failed request is asked again next time.
    h.api.previewPlan.mockResolvedValueOnce({ ok: false, error: { code: 'task_not_applicable' } } as never);
    await expect(h.controller.previewPlan('c', COMPRESS)).rejects.toMatchObject({ code: 'task_not_applicable' });
    await h.controller.previewPlan('c', COMPRESS);
    expect(h.api.previewPlan).toHaveBeenCalledTimes(7);
    expect(settingsSignature(COMPRESS)).not.toBe(settingsSignature({ ...COMPRESS, codec: 'av1' }));
  });

  it('reports a missing or unsupported API and a malformed snapshot as a failed load, and retries on the next view', async () => {
    const unsupported = harness({ supported: false });
    unsupported.view();
    expect(unsupported.state()).toMatchObject({ phase: 'failed', error: 'platform_unsupported' });
    await expect(unsupported.controller.pickFiles('all')).rejects.toBeInstanceOf(MediaConverterClientError);

    const h = harness();
    h.view();
    await h.answerSnapshot({ sequence: -1 } as never);
    expect(h.state()).toMatchObject({ phase: 'failed', error: 'unknown' });
    h.view();
    await flush();
    expect(h.api.getSnapshot).toHaveBeenCalledTimes(2);
    await h.answerSnapshot();
    expect(h.state().phase).toBe('ready');
  });

  it('turns failed answers into client errors with the main process code', async () => {
    await expect(unwrapMediaResult(Promise.resolve({ ok: false, error: { code: 'busy' } }))).rejects.toMatchObject({ code: 'busy' });
    await expect(unwrapMediaResult(Promise.resolve({ ok: false, error: { code: 'not-a-code' } } as never))).rejects.toMatchObject({ code: 'unknown' });
    await expect(unwrapMediaResult(Promise.reject(new Error('no handler')))).rejects.toMatchObject({ code: 'unknown' });
    await expect(unwrapMediaResult(Promise.resolve({ ok: true, value: 3 }))).resolves.toBe(3);
  });

  it('passes commands through and flags the detect-again request while it runs', async () => {
    const h = harness();
    h.view();
    await h.answerSnapshot();
    await h.controller.retry(['a'], 'not_smaller');
    expect(h.api.retry).toHaveBeenCalledWith({ itemIds: ['a'], override: 'not_smaller' });
    await h.controller.reveal('a');
    expect(h.api.revealOutput).toHaveBeenCalledWith({ itemId: 'a' });
    expect(await h.controller.pickOutputDirectory()).toEqual({ id: 'dir2', displayName: 'Out' });
    // Known as the first folder even before the main process's `options` event says so.
    expect(h.state().outputDirectories.map(directory => directory.id)).toEqual(['dir2', 'dir1']);
    h.api.redetectCapabilities.mockResolvedValueOnce({ ok: false, error: { code: 'busy' } } as never);
    const pending = h.controller.redetect();
    expect(h.state().redetecting).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'busy' });
    expect(h.state().redetecting).toBe(false);
  });

  it('knows when a hardware encode runs', async () => {
    expect(jobUsesHardwareEncoder(runningJob('hevc_nvenc', '10bit_uhq'))).toBe(true);
    expect(jobUsesHardwareEncoder(runningJob('libsvtav1', '10bit'))).toBe(false);
    expect(jobUsesHardwareEncoder(runningJob('h264_mf', '8bit_sw'))).toBe(false);
    expect(jobUsesHardwareEncoder(runningJob('h264_mf', '8bit'))).toBe(true);
    const h = harness();
    h.view();
    await h.answerSnapshot();
    expect(hardwareEncodeRunning(h.state())).toBe(false);
    h.emit({ sequence: 11, kind: 'items', items: [item('a', { state: { status: 'queued' }, job: runningJob('hevc_nvenc', '10bit_uhq') })], removed: [] });
    expect(hardwareEncodeRunning(h.state())).toBe(false);
    h.emit({ sequence: 12, kind: 'items', items: [item('a', { state: { status: 'running', phase: 'encoding' }, job: runningJob('hevc_nvenc', '10bit_uhq') })], removed: [] });
    expect(hardwareEncodeRunning(h.state())).toBe(true);
  });
});
