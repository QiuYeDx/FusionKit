import { useSyncExternalStore } from 'react';
import i18n from '@/i18n';
import { showSystemNotification } from '@/utils/notification';
import { formatBytes } from '@/pages/Tools/Media/MediaConverter/format';
import {
  ITEM_FAILURE_CODES,
  mediaConverterSnapshotSchema,
  QUEUE_LIMITS,
  type AddFilesResult,
  type BatchSummary,
  type CapabilityDefaults,
  type ConversionSettings,
  type EngineStatus,
  type ItemJob,
  type ItemProgress,
  type ItemSummary,
  type MediaConverterApi,
  type MediaConverterErrorCode,
  type MediaConverterResult,
  type MediaConverterSnapshot,
  type OutputDirectory,
  type PickFileFilter,
  type PreviewPlanResult,
  type QueueEvent,
  type QueueNotice,
  type QueueOptions,
  type QueueOptionsPatch,
  type ResolvedEncoders,
  type RetryRequest,
  type StartRequest,
  type StartResult,
  type VideoEncoderId,
} from '@/media-converter/contract';

/**
 * The renderer's view of the media converter queue (module-workbench design 渲染进程架构): one
 * module singleton that the page reads through `useSyncExternalStore`. The main process owns the
 * queue; this keeps its last snapshot, applies only change events with a larger sequence, shows
 * progress at most every 250 ms per item, and stays subscribed when the page unmounts so a batch
 * that finishes in the background still notifies.
 */

/** A failed `window.mediaConverter` call; `code` selects the message (`media:errors.<code>`). */
export class MediaConverterClientError extends Error {
  constructor(readonly code: MediaConverterErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'MediaConverterClientError';
  }
}

/** The code of a failed call; anything that is not a `MediaConverterClientError` is `unknown`. */
export const mediaErrorCodeOf = (error: unknown): MediaConverterErrorCode => error instanceof MediaConverterClientError ? error.code : 'unknown';

const isErrorCode = (value: unknown): value is MediaConverterErrorCode =>
  typeof value === 'string' && (ITEM_FAILURE_CODES as readonly string[]).includes(value);

/**
 * The value of a successful call, else a `MediaConverterClientError`: a rejected invoke means the
 * main-process module never registered (`unknown`), a malformed answer is `unknown` as well.
 */
export async function unwrapMediaResult<T>(pending: Promise<MediaConverterResult<T>>): Promise<T> {
  let result: MediaConverterResult<T>;
  try {
    result = await pending;
  } catch (cause) {
    throw new MediaConverterClientError('unknown', { cause });
  }
  if (result?.ok === true) return result.value;
  const code: unknown = result?.ok === false ? result.error?.code : undefined;
  throw new MediaConverterClientError(isErrorCode(code) ? code : 'unknown');
}

export interface MediaConverterState {
  /** `idle` before the first subscriber, `failed` when the snapshot could not be read (see `error`). */
  readonly phase: 'idle' | 'loading' | 'ready' | 'failed';
  /** Why the snapshot could not be read; `platform_unsupported` without the API or outside Windows. */
  readonly error: MediaConverterErrorCode | null;
  /** The sequence of the last applied snapshot or event. */
  readonly sequence: number;
  readonly engine: EngineStatus | null;
  /** In the order the files were added. */
  readonly items: readonly ItemSummary[];
  readonly options: QueueOptions | null;
  readonly outputDirectories: readonly OutputDirectory[];
  /** What the encoder chains resolve to: the detection's when ready, else the snapshot's (CPU encoders before a detection). */
  readonly resolvedEncoders: ResolvedEncoders | null;
  readonly defaults: CapabilityDefaults | null;
  /** `state_reset`, until the page took it (`takeNotice`). */
  readonly notice: QueueNotice | null;
  /** A "detect again" request is on its way. */
  readonly redetecting: boolean;
  /** A `set-options` request is on its way. */
  readonly savingOptions: boolean;
}

type Timer = () => void;

export interface MediaConverterControllerOptions {
  readonly getApi?: () => MediaConverterApi | undefined;
  /** Monotonic milliseconds for the progress throttle. */
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => Timer;
  /** Whether the application window is in front; a finished batch notifies only when it is not. */
  readonly isWindowFocused?: () => boolean;
  /** Shows the system notification of a finished batch. */
  readonly notifyBatch?: (batch: BatchSummary) => void;
  /** Progress shown per item at most this often; defaults to the main process's 250 ms. */
  readonly progressIntervalMs?: number;
}

const EMPTY_STATE: MediaConverterState = Object.freeze({
  phase: 'idle', error: null, sequence: 0, engine: null, items: Object.freeze([]), options: null, outputDirectories: Object.freeze([]),
  resolvedEncoders: null, defaults: null, notice: null, redetecting: false, savingOptions: false,
});

/** Hardware video encoders: a running job that uses one makes "detect again" answer `busy` (R-WORKBENCH-05). */
const HARDWARE_VIDEO_ENCODERS: ReadonlySet<VideoEncoderId> = new Set([
  'av1_nvenc', 'av1_qsv', 'av1_amf', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf',
]);

/** The job encodes video on a graphics card or media engine (h264_mf's software mode is a CPU encoder). */
export function jobUsesHardwareEncoder(job: ItemJob | null): boolean {
  return !!job?.plan.encoders.some(({ encoder, variant }) =>
    HARDWARE_VIDEO_ENCODERS.has(encoder as VideoEncoderId) && !(encoder === 'h264_mf' && variant === '8bit_sw'));
}

/** A hardware encode is running: "detect again" is unavailable until it ends. */
export const hardwareEncodeRunning = (state: MediaConverterState): boolean =>
  state.items.some(item => item.state.status === 'running' && jobUsesHardwareEncoder(item.job));

/** Same key for equal settings, whatever order their fields were written in. */
export function settingsSignature(settings: ConversionSettings): string {
  return JSON.stringify(Object.keys(settings).sort().map(key => [key, settings[key as keyof ConversionSettings]]));
}

/** The default notification: how many files succeeded, failed or were skipped, and what compression saved. */
function notifyBatchFinished(batch: BatchSummary): void {
  const counts = i18n.t('media:notifications.batch_body', { succeeded: batch.succeeded, failed: batch.failed, skipped: batch.skipped });
  const saved = batch.savedBytes > 0 ? i18n.t('media:notifications.batch_saved', { size: formatBytes(batch.savedBytes, i18n.language) }) : '';
  showSystemNotification(i18n.t('media:notifications.batch_title'), saved ? `${counts} ${saved}` : counts);
}

const freezeItem = (item: ItemSummary): ItemSummary => Object.freeze(item);

export class MediaConverterController {
  readonly #getApi: () => MediaConverterApi | undefined;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => Timer;
  readonly #isFocused: () => boolean;
  readonly #notify: (batch: BatchSummary) => void;
  readonly #progressInterval: number;
  readonly #listeners = new Set<() => void>();
  #state: MediaConverterState = EMPTY_STATE;
  #load?: Promise<void>;
  #unsubscribe?: () => void;
  /** Events that arrive while a snapshot is being read; those newer than it are applied after it. */
  #buffer: QueueEvent[] | null = null;
  /** Progress waiting for its item's 250 ms; it keeps the item's place in the throttle. */
  readonly #pendingProgress = new Map<string, ItemProgress>();
  readonly #shownAt = new Map<string, number>();
  #progressTimer?: Timer;
  /** Plans by item and settings signature; an item's change or an engine change drops them. */
  readonly #plans = new Map<string, Map<string, Promise<PreviewPlanResult>>>();
  /** Bumped by every `options` event, so a late `set-options` answer never overrides a newer one. */
  #optionsVersion = 0;

  constructor(options: MediaConverterControllerOptions = {}) {
    this.#getApi = options.getApi ?? (() => (typeof window === 'undefined' ? undefined : window.mediaConverter));
    this.#now = options.now ?? (() => performance.now());
    this.#schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
    this.#isFocused = options.isWindowFocused ?? (() => typeof document === 'undefined' || document.hasFocus());
    this.#notify = options.notifyBatch ?? notifyBatchFinished;
    this.#progressInterval = options.progressIntervalMs ?? QUEUE_LIMITS.progressIntervalMs;
  }

  getState = (): MediaConverterState => this.#state;

  /** The first subscriber reads the snapshot; a failed read is tried again by the next one. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#state.phase === 'idle' || this.#state.phase === 'failed') void this.load();
    return () => { this.#listeners.delete(listener); };
  };

  #emit(change: Partial<MediaConverterState>) {
    this.#state = Object.freeze({ ...this.#state, ...change });
    for (const listener of [...this.#listeners]) { try { listener(); } catch { /* A view cannot stop the others. */ } }
  }

  /**
   * Reads the snapshot. The change listener is registered first, so nothing is lost between the two;
   * the events that arrive meanwhile wait and only those newer than the snapshot are applied.
   */
  load = (): Promise<void> => {
    if (this.#load) return this.#load;
    const api = this.#getApi();
    if (!api || !api.supported) {
      this.#emit({ phase: 'failed', error: 'platform_unsupported' });
      return Promise.resolve();
    }
    this.#unsubscribe ??= api.onChanged(event => this.#receive(event));
    this.#buffer = [];
    this.#load = Promise.resolve().then(async () => {
      const raw = await unwrapMediaResult(api.getSnapshot());
      const parsed = mediaConverterSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new MediaConverterClientError('unknown');
      this.#install(parsed.data);
    }).catch(error => {
      this.#buffer = null;
      this.#emit({ phase: 'failed', error: mediaErrorCodeOf(error) });
    }).finally(() => { this.#load = undefined; });
    this.#emit({ phase: 'loading', error: null });
    return this.#load;
  };

  #install(snapshot: MediaConverterSnapshot) {
    const buffered = this.#buffer ?? [];
    this.#buffer = null;
    // A snapshot older than what was applied before it was asked for cannot happen (the main process
    // answers in order); one that is not newer changes nothing.
    if (snapshot.sequence >= this.#state.sequence) {
      this.#pendingProgress.clear();
      this.#plans.clear();
      const ready = snapshot.engine.capabilities.state === 'ready' ? snapshot.engine.capabilities : null;
      this.#emit({
        phase: 'ready', error: null, sequence: snapshot.sequence, engine: snapshot.engine,
        items: Object.freeze(snapshot.items.map(freezeItem)), options: snapshot.options,
        outputDirectories: Object.freeze([...snapshot.outputDirectories]),
        resolvedEncoders: ready?.resolvedEncoders ?? snapshot.resolvedEncoders,
        defaults: ready?.defaults ?? snapshot.defaults,
        notice: snapshot.notice ?? this.#state.notice,
      });
    } else {
      this.#emit({ phase: 'ready', error: null });
    }
    for (const event of buffered) this.#apply(event);
  }

  #receive(event: QueueEvent) {
    if (this.#buffer) this.#buffer.push(event);
    else if (this.#state.phase === 'ready') this.#apply(event);
  }

  /** Applies one change event; one with a sequence that is not larger than the last applied is stale and dropped. */
  #apply(event: QueueEvent) {
    if (event.sequence <= this.#state.sequence) return;
    switch (event.kind) {
      case 'items': {
        const changed = new Map(event.items.map(item => [item.id, freezeItem(item)]));
        const removed = new Set(event.removed);
        const items = this.#state.items.filter(item => !removed.has(item.id)).map(item => changed.get(item.id) ?? item);
        const known = new Set(items.map(item => item.id));
        for (const item of changed.values()) if (!known.has(item.id) && !removed.has(item.id)) items.push(item);
        for (const id of [...changed.keys(), ...removed]) {
          // The item's own summary is newer than any progress still waiting for it.
          this.#pendingProgress.delete(id);
          this.#plans.delete(id);
          if (removed.has(id)) this.#shownAt.delete(id);
        }
        this.#emit({ sequence: event.sequence, items: Object.freeze(items) });
        return;
      }
      case 'progress':
        this.#state = Object.freeze({ ...this.#state, sequence: event.sequence });
        this.#queueProgress(event.itemId, event.progress);
        return;
      case 'engine': {
        const capabilities = event.engine.capabilities;
        const ready = capabilities.state === 'ready' ? capabilities : null;
        // A detection may change which encoder every plan uses.
        this.#plans.clear();
        this.#emit({
          sequence: event.sequence, engine: event.engine,
          resolvedEncoders: ready?.resolvedEncoders ?? this.#state.resolvedEncoders,
          defaults: ready?.defaults ?? this.#state.defaults,
        });
        return;
      }
      case 'options':
        this.#optionsVersion++;
        this.#emit({ sequence: event.sequence, options: event.options, outputDirectories: Object.freeze([...event.outputDirectories]) });
        return;
      case 'batch-finished':
        this.#state = Object.freeze({ ...this.#state, sequence: event.sequence });
        this.#batchFinished(event.batch);
        return;
    }
  }

  #queueProgress(itemId: string, progress: ItemProgress) {
    if (!this.#state.items.some(item => item.id === itemId)) return;
    this.#pendingProgress.set(itemId, progress);
    const shownAt = this.#shownAt.get(itemId);
    if (shownAt === undefined || this.#now() - shownAt >= this.#progressInterval) this.#flushProgress();
    else this.#armProgress();
  }

  /** Shows every waiting progress whose item's 250 ms are up, in one change; the others wait for the timer. */
  #flushProgress() {
    this.#progressTimer?.();
    this.#progressTimer = undefined;
    const now = this.#now();
    const due = new Map<string, ItemProgress>();
    for (const [id, progress] of this.#pendingProgress) {
      const shownAt = this.#shownAt.get(id);
      if (shownAt !== undefined && now - shownAt < this.#progressInterval) continue;
      due.set(id, progress);
      this.#pendingProgress.delete(id);
      this.#shownAt.set(id, now);
    }
    if (due.size) {
      const items = this.#state.items.map(item => {
        const progress = due.get(item.id);
        return progress ? freezeItem({ ...item, progress }) : item;
      });
      this.#emit({ items: Object.freeze(items) });
    }
    this.#armProgress();
  }

  #armProgress() {
    if (this.#progressTimer || !this.#pendingProgress.size) return;
    const now = this.#now();
    let wait = this.#progressInterval;
    for (const id of this.#pendingProgress.keys()) {
      const shownAt = this.#shownAt.get(id);
      wait = Math.min(wait, shownAt === undefined ? 0 : Math.max(0, shownAt + this.#progressInterval - now));
    }
    this.#progressTimer = this.#schedule(() => {
      this.#progressTimer = undefined;
      this.#flushProgress();
    }, Math.max(1, wait));
  }

  /** A batch ended: a system notification when the window is not in front (AC-WORKBENCH-04-4). A batch the user only cancelled says nothing. */
  #batchFinished(batch: BatchSummary) {
    if (batch.succeeded + batch.failed + batch.skipped === 0) return;
    let focused = true;
    try { focused = this.#isFocused(); } catch { /* Treated as in front: no notification. */ }
    if (focused) return;
    try { this.#notify(batch); } catch { /* A notification never stops the queue view. */ }
  }

  /** Sends one request now (synchronously, so a drop's files are still readable) and unwraps its answer. */
  #invoke<T>(send: (api: MediaConverterApi) => Promise<MediaConverterResult<T>>): Promise<T> {
    const api = this.#getApi();
    if (!api || !api.supported) return Promise.reject(new MediaConverterClientError('platform_unsupported'));
    let pending: Promise<MediaConverterResult<T>>;
    try { pending = send(api); } catch (cause) { return Promise.reject(new MediaConverterClientError('unknown', { cause })); }
    return unwrapMediaResult(pending);
  }

  /** The page shows the notice once. */
  takeNotice = (): QueueNotice | null => {
    const notice = this.#state.notice;
    if (notice) this.#emit({ notice: null });
    return notice;
  };

  /** The preload reads the paths synchronously in this call, before its first await, while the drop still owns them. */
  addDroppedFiles = (files: readonly File[]): Promise<AddFilesResult> => this.#invoke(api => api.addDroppedFiles(files));

  pickFiles = (filter: PickFileFilter): Promise<AddFilesResult> => this.#invoke(api => api.pickFiles({ filter }));

  /** The folder the user picked in the main-process dialog, or null when the dialog was cancelled. */
  pickOutputDirectory = async (): Promise<OutputDirectory | null> => {
    const { directory } = await this.#invoke(api => api.pickOutputDirectory());
    // The main process lists it first now; its `options` event normally came first and says so already.
    if (directory && !this.#state.outputDirectories.some(known => known.id === directory.id)) {
      this.#emit({ outputDirectories: Object.freeze([directory, ...this.#state.outputDirectories].slice(0, QUEUE_LIMITS.outputDirectories)) });
    }
    return directory;
  };

  /**
   * The plan an idle item gets with these settings, cached by item and settings signature until the
   * item or the engine changes. A failed request is not cached.
   */
  previewPlan = (itemId: string, settings: ConversionSettings): Promise<PreviewPlanResult> => {
    const key = settingsSignature(settings);
    let plans = this.#plans.get(itemId);
    const cached = plans?.get(key);
    if (cached) return cached;
    const pending = this.#invoke(api => api.previewPlan({ itemId, settings }));
    if (!plans) this.#plans.set(itemId, plans = new Map());
    plans.set(key, pending);
    pending.catch(() => { if (this.#plans.get(itemId)?.get(key) === pending) this.#plans.get(itemId)!.delete(key); });
    return pending;
  };

  start = (request: StartRequest): Promise<StartResult> => this.#invoke(api => api.start(request));
  cancel = (itemIds: string[]): Promise<{ affected: number }> => this.#invoke(api => api.cancel({ itemIds }));
  remove = (itemIds: string[]): Promise<{ affected: number }> => this.#invoke(api => api.remove({ itemIds }));
  retry = (itemIds: string[], override?: RetryRequest['override']): Promise<{ affected: number }> =>
    this.#invoke(api => api.retry(override ? { itemIds, override } : { itemIds }));
  clear = (scope: 'finished' | 'all_idle'): Promise<{ removed: number }> => this.#invoke(api => api.clear({ scope }));
  reveal = (itemId: string, outputIndex?: number): Promise<Record<string, never>> =>
    this.#invoke(api => api.revealOutput(outputIndex === undefined ? { itemId } : { itemId, outputIndex }));

  /**
   * Changes queue options in the main process, which keeps them (AC-ENGINE-05-2). The `options`
   * event shows the change; the answer is applied as well unless an event came first.
   */
  setOptions = async (patch: QueueOptionsPatch): Promise<QueueOptions> => {
    const version = this.#optionsVersion;
    this.#emit({ savingOptions: true });
    try {
      const options = await this.#invoke(api => api.setOptions(patch));
      if (version === this.#optionsVersion) this.#emit({ options });
      return options;
    } finally {
      this.#emit({ savingOptions: false });
    }
  };

  /** Detects the encoders again; `busy` while a hardware encode runs. The `engine` event shows the detection. */
  redetect = async (): Promise<void> => {
    if (this.#state.redetecting) return;
    this.#emit({ redetecting: true });
    try {
      await this.#invoke(api => api.redetectCapabilities());
    } finally {
      this.#emit({ redetecting: false });
    }
  };

  /** Test and application teardown only; never use this for a route unmount. */
  dispose = (): void => {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#progressTimer?.();
    this.#progressTimer = undefined;
    this.#listeners.clear();
  };
}

export const createMediaConverterController = (options: MediaConverterControllerOptions = {}) => new MediaConverterController(options);

let controller: MediaConverterController | undefined;
/** The one controller of this renderer: the queue view outlives the page. */
export function getMediaConverterController(): MediaConverterController {
  return controller ??= createMediaConverterController();
}

/** The controller's state, re-rendering on every change it emits; a static render sees its current state. */
export function useMediaConverterState(target: MediaConverterController = getMediaConverterController()): MediaConverterState {
  return useSyncExternalStore(target.subscribe, target.getState, target.getState);
}
