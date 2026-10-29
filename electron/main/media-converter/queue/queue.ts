import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ApplicationShutdownReason } from '../../app-shutdown';
import {
  DEFAULT_QUEUE_OPTIONS, QUEUE_LIMITS, clearRequestSchema, compressCodecSchema, conversionSettingsSchema, diskSpaceSchema, itemFailureCodeSchema, itemIdSchema,
  itemIdsRequestSchema, itemPhaseSchema, itemProgressSchema, planSummarySchema, planWarningCodeSchema, queueOptionsPatchSchema, retryRequestSchema,
  startRequestSchema,
  type AddFilesResult, type BatchSummary, type CompressCodec, type ConversionSettings, type DiskSpace, type ItemFailureCode, type ItemProgress,
  type ItemResult, type ItemState, type ItemSummary, type MediaInfo, type OutputConflict, type OutputDirectory, type PlanSkipCode, type PlanSummary,
  type PlanWarningCode, type QueueEvent, type QueueNotice, type QueueOptions, type QueueSnapshot, type StartResult,
} from '../../../../src/media-converter/contract';
import { fullyQualifiedPath, type InputFileState, type InputRegistry, type RegisteredInput } from '../engine/inputs';
import { createLogRedactor, redactedLogTail, utf8Tail } from '../engine/progress';
import { outputFileName } from '../plan/naming';
import { buildPlan } from '../plan/stream-plan';
import type { ConversionPlan, PlanOutcome, PlannerCapabilities } from '../plan/types';
import { QueueStateStore, type PersistedItem, type PersistedQueueState, type PersistedResult } from './state-store';
import {
  MediaQueueError,
  type CapabilitiesAnswer, type ExecutionHooks, type ExecutionJob, type ExecutionOutcome, type MediaExecutor, type OutputTargetName, type PublishedOutput,
  type QueueCapabilities, type QueueClock, type QueuePlanner, type QueuePowerBlocker, type QueueProber,
} from './types';

/**
 * The conversion queue of the main process (design §6, R-ENGINE-05). It owns every item: added
 * files are probed (probing never takes a conversion slot), `start` plans each item with the
 * settings of the request, asks for the confirmations the plan or an overwrite needs, then freezes
 * settings and plan and queues the item. At most `concurrency` items run (1 by default, 2 allowed),
 * in the order they were started; just before one runs its input is checked again
 * (`input_missing`, `input_changed`). Nothing starts while the encoders are being detected (the
 * first detection or "detect again"): the hardware test encodes would compete with the run and
 * leave `session_limit` verdicts; queued items wait and start once the detection ends. The
 * renderer only sends commands and applies change events whose sequence is newer than its
 * snapshot; progress is coalesced to one event per item every 250 ms (FK-PIT-0077). Items,
 * results (with the redacted end of the log, 16 KB at most), options
 * and the recent output folders are kept in `state.json`; after a restart, what was queued or
 * running is `interrupted` and idle items are checked again. A batch lasts from the queue leaving
 * idle until nothing is queued or running and ends with one `batch-finished`; the power blocker is
 * held meanwhile. `shutdown` stops scheduling, cancels the runs, waits for them (4 s at most) and
 * writes the state.
 */

export const QUEUE_POLICY = Object.freeze({
  /** How long the shutdown waits for the running items to stop (design §6). */
  shutdownWaitMs: 4_000,
  /** The end of a failure log that is redacted before its last 16 KB are kept: as much as ffmpeg's stderr ring holds. */
  redactionWindowBytes: 256 * 1024,
});

type Registry = Pick<InputRegistry, 'add' | 'restore' | 'get' | 'verify' | 'refresh' | 'remove' | 'paths'>;

export interface MediaQueueOptions {
  /** `userData/media-converter`: holds `state.json`. */
  root: string;
  inputs: Registry;
  prober: QueueProber;
  capabilities: QueueCapabilities;
  executor: MediaExecutor;
  /** `MediaOutputs.wouldReplace`: the name of the file an overwrite would move to the recycle bin, else null. */
  wouldReplace: (directory: string, baseName: string, extension: string) => Promise<string | null>;
  powerSaveBlocker: QueuePowerBlocker;
  /** Delivers `media-converter:changed` to the renderer. */
  emit: (event: QueueEvent) => void;
  clock?: QueueClock;
  /** `buildPlan`; tests wrap it. */
  planner?: QueuePlanner;
  /** Output folder ids. */
  createId?: () => string;
  platform?: NodeJS.Platform | string;
  shutdownWaitMs?: number;
  persistDebounceMs?: number;
  /** `atomicWriteUtf8File`; tests inject failures. */
  writeState?: (file: string, content: string) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

/** What one item was started with. Settings and plan are frozen. */
interface Job {
  settings: Readonly<ConversionSettings>;
  /** Null after a restart and for an `already_target` skip: a retry plans again before anything runs. */
  plan: Readonly<ConversionPlan> | null;
  summary: PlanSummary;
  output: {
    mode: 'source' | 'directory';
    directoryId: string | null;
    directory: string;
    conflict: OutputConflict;
    confirmedReplace: readonly string[];
  };
  targets: readonly OutputTargetName[];
  confirmedLossyToLossless: boolean;
  acceptAlreadyTarget: boolean;
  /** Position in the run order: the order of starting. */
  order: number;
}

interface Item {
  readonly id: string;
  media: MediaInfo | null;
  state: ItemState;
  job: Job | null;
  progress: ItemProgress | null;
  result: PersistedResult | null;
  log: string | null;
  addedAt: number;
  finishedAt: number | null;
  /** Bumped when a probe or retry of the item in flight no longer applies. */
  generation: number;
}

interface ActiveRun {
  readonly controller: AbortController;
  done: Promise<void>;
}

interface ProgressGate {
  lastAt: number | null;
  timer: unknown;
}

/** `ok` when the planner answered for the item; `no_encoder_available` comes with the codecs that would work instead. */
export type PreviewPlanResult =
  | { ok: true; status: 'ready'; plan: PlanSummary }
  | { ok: true; status: 'skipped'; reason: 'already_target'; plan: PlanSummary }
  | { ok: true; status: 'error'; reason: 'no_encoder_available'; alternatives: CompressCodec[] }
  | { ok: false; code: ItemFailureCode };

type QueueEventBody = QueueEvent extends infer E ? E extends QueueEvent ? Omit<E, 'sequence'> : never : never;

const FINISHED: ReadonlySet<ItemState['status']> = new Set(['unsupported', 'succeeded', 'skipped', 'failed', 'cancelled', 'interrupted', 'input_changed']);
const RETRYABLE: ReadonlySet<ItemState['status']> = new Set(['unsupported', 'skipped', 'failed', 'cancelled', 'interrupted', 'input_changed']);
const HARDWARE_ENCODER = /_(?:nvenc|qsv|amf|mf)$/;

const systemClock: QueueClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const defaultLog = (message: string, error?: unknown) => console.warn(`[media-converter] ${message}`, error ?? '');

/** Freezes a settings or plan tree, constants it shares included, so nothing can change what a queued item runs with. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  return Object.freeze(value);
}

const nameOf = (filePath: string) => path.basename(String(filePath)).slice(0, 1024) || '—';
/** A folder's own name: `D:` for a drive root, the share for a UNC root. */
function folderName(directory: string): string {
  const trimmed = directory.replace(/[\\/]+$/, '');
  return path.basename(trimmed) || trimmed.split(/[\\/]/).filter(Boolean).pop() || directory;
}

export class MediaQueue {
  readonly #inputs: Registry;
  readonly #prober: QueueProber;
  readonly #capabilities: QueueCapabilities;
  readonly #executor: MediaExecutor;
  readonly #wouldReplace: MediaQueueOptions['wouldReplace'];
  readonly #power: QueuePowerBlocker;
  readonly #emitTarget: (event: QueueEvent) => void;
  readonly #clock: QueueClock;
  readonly #planner: QueuePlanner;
  readonly #createId: () => string;
  readonly #platform: NodeJS.Platform | string;
  readonly #shutdownWaitMs: number;
  readonly #log: (message: string, error?: unknown) => void;
  readonly #store: QueueStateStore;
  readonly #unsubscribe: () => void;

  /** In the order the files were added. */
  readonly #items = new Map<string, Item>();
  /** Items holding a slot: checking their input, then running. */
  readonly #active = new Map<string, ActiveRun>();
  readonly #gates = new Map<string, ProgressGate>();
  /** Probes of added files and retries, so tests and the shutdown can wait for them. */
  readonly #background = new Set<Promise<unknown>>();
  /** Most recently used first. */
  #directories: { id: string; path: string }[] = [];
  #options: Readonly<QueueOptions> = DEFAULT_QUEUE_OPTIONS;
  #sequence = 0;
  #order = 0;
  #batch: BatchSummary | null = null;
  #powerId: number | null = null;
  #notice: QueueNotice | null = null;
  #loaded = false;
  /** A snapshot went out before the restore ended: what the restore brings back is then sent as events too. */
  #snapshotBeforeRestore = false;
  #ready: Promise<void> = Promise.resolve();
  #restoring: Promise<void> | undefined;
  #closing = false;
  #shutdown: Promise<void> | undefined;

  constructor(options: MediaQueueOptions) {
    if (!fullyQualifiedPath(options.root)) throw new TypeError('The media converter state folder must be a full path.');
    this.#inputs = options.inputs;
    this.#prober = options.prober;
    this.#capabilities = options.capabilities;
    this.#executor = options.executor;
    this.#wouldReplace = options.wouldReplace;
    this.#power = options.powerSaveBlocker;
    this.#emitTarget = options.emit;
    this.#clock = options.clock ?? systemClock;
    this.#planner = options.planner ?? buildPlan;
    this.#createId = options.createId ?? randomUUID;
    this.#platform = options.platform ?? process.platform;
    this.#shutdownWaitMs = options.shutdownWaitMs ?? QUEUE_POLICY.shutdownWaitMs;
    this.#log = options.log ?? defaultLog;
    this.#store = new QueueStateStore({
      file: path.join(options.root, 'state.json'), read: () => this.#persisted(), clock: this.#clock, debounceMs: options.persistDebounceMs,
      write: options.writeState, log: this.#log,
    });
    this.#unsubscribe = this.#capabilities.subscribe(() => {
      this.#emit({ kind: 'engine', engine: this.#capabilities.status() });
      // A detection that ended lets the queued items start.
      this.#reconcile();
    });
  }

  // ── Restore ──

  /**
   * Reads `state.json` once: at startup, or at the latest when the first command arrives, so no
   * command can write a state that left the persisted items out. Commands wait for it. What was
   * queued, running or being analyzed is `interrupted`; idle items are checked again
   * (`input_missing`, `input_changed`); at most 500 items are kept. An unreadable file was set
   * aside, and the next snapshot says so once.
   */
  restore(): Promise<void> {
    if (!this.#restoring) {
      this.#restoring = this.#load().catch(error => this.#log('The media converter queue could not be restored.', error)).finally(() => { this.#loaded = true; });
      this.#ready = this.#restoring;
    }
    return this.#restoring;
  }

  /** What every command awaits first. Once the shutdown began nothing is read any more: a command then only finds the queue closed. */
  #whenRestored(): Promise<void> {
    return this.#closing ? this.#ready : this.restore();
  }

  async #load() {
    const loaded = await this.#store.load();
    if (loaded.reset) this.#notice = 'state_reset';
    let changed = loaded.droppedItems > 0;
    const state = loaded.state;
    if (!state) return;
    this.#options = Object.freeze({ ...state.options });
    for (const directory of state.outputDirectories) {
      if (fullyQualifiedPath(directory.path) && !this.#directories.some(known => known.id === directory.id)) this.#directories.push({ ...directory });
    }
    const now = this.#clock.now();
    const toVerify: Item[] = [];
    for (const persisted of state.items) {
      if (this.#items.has(persisted.id)) { changed = true; continue; }
      // The output folder a retry writes to and the outputs "show in folder" opens are full paths, as the queue wrote them.
      const pathsUsable = (!persisted.job || fullyQualifiedPath(persisted.job.output.directory))
        && (persisted.result?.outputs ?? []).every(output => fullyQualifiedPath(output.path));
      if (!pathsUsable) { changed = true; continue; }
      try { this.#inputs.restore({ id: persisted.id, path: persisted.input.path, state: persisted.input.state as InputFileState }); }
      catch { changed = true; continue; }
      const item = this.#restored(persisted);
      const status = item.state.status;
      if (status === 'queued' || status === 'running' || status === 'analyzing' || (status === 'idle' && !item.media)) {
        item.state = { status: 'interrupted' };
        item.finishedAt ??= now;
        changed = true;
      } else if (status === 'idle') toVerify.push(item);
      this.#items.set(item.id, item);
    }
    await Promise.all(toVerify.map(async item => {
      const code = await this.#inputs.verify(item.id);
      if (code === null) return;
      item.state = code === 'input_missing' ? { status: 'failed', code, partial: false } : { status: 'input_changed' };
      item.finishedAt = this.#clock.now();
      changed = true;
    }));
    if (this.#makeRoom(0).length) changed = true;
    if (changed) this.#store.schedule();
    if (this.#snapshotBeforeRestore) {
      this.#emit({ kind: 'options', options: { ...this.#options }, outputDirectories: this.#directoryList() });
      this.#changed([...this.#items.values()], [], { persist: false });
    }
  }

  #restored(persisted: PersistedItem): Item {
    const job = persisted.job;
    return {
      id: persisted.id, media: persisted.media, state: persisted.state, progress: null, result: persisted.result, log: persisted.log,
      addedAt: persisted.addedAt, finishedAt: persisted.finishedAt, generation: 0,
      job: job && {
        settings: deepFreeze(job.settings), plan: null, summary: job.summary, output: { ...job.output, confirmedReplace: [...job.output.confirmedReplace] },
        targets: [], confirmedLossyToLossless: job.confirmedLossyToLossless, acceptAlreadyTarget: job.acceptAlreadyTarget, order: 0,
      },
    };
  }

  // ── Reading ──

  /** Everything the renderer shows; then it applies only events with a larger sequence. */
  snapshot(): QueueSnapshot {
    if (!this.#loaded) this.#snapshotBeforeRestore = true;
    const notice = this.#notice;
    this.#notice = null;
    return {
      sequence: this.#sequence,
      engine: this.#capabilities.status(),
      items: [...this.#items.values()].map(item => this.#summary(item)),
      options: { ...this.#options },
      outputDirectories: this.#directoryList(),
      notice,
    };
  }

  get options(): QueueOptions {
    return { ...this.#options };
  }

  /** A published output of this tool, for "show in folder"; null for anything else. */
  outputPath(itemId: string, outputIndex = 0): string | null {
    return this.#items.get(itemId)?.result?.outputs.find(output => output.index === outputIndex)?.path ?? null;
  }

  /** A running item uses a hardware encoder: detecting the capabilities again would compete with it (AC-ENGINE-03-2). */
  isHardwareEncodeRunning(): boolean {
    for (const id of this.#active.keys()) {
      const item = this.#items.get(id);
      if (item?.state.status !== 'running') continue;
      for (const { encoder, variant } of item.job?.summary.encoders ?? []) if (HARDWARE_ENCODER.test(encoder) && variant !== '8bit_sw') return true;
    }
    return false;
  }

  /** Resolves once no probe or retry of an item is in flight. */
  async drain(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  /** Writes the pending state now. */
  persist(): Promise<void> {
    return this.#store.flush();
  }

  // ── Output folders ──

  /** A folder the main-process dialog returned: it becomes the most recent of the five remembered, under a stable id. */
  async rememberOutputDirectory(directory: string): Promise<OutputDirectory> {
    // After the restore, so the list it changes (and writes) is the persisted one.
    await this.#whenRestored();
    this.#assertOpen();
    if (!fullyQualifiedPath(directory)) throw new MediaQueueError('invalid_request', 'The output folder must be a full path.');
    const normalized = path.normalize(directory);
    const index = this.#directories.findIndex(known => this.#samePath(known.path, normalized));
    const entry = index >= 0 ? this.#directories.splice(index, 1)[0] : { id: this.#createId(), path: normalized };
    if (!itemIdSchema.safeParse(entry.id).success) throw new TypeError('The output folder id is invalid.');
    this.#directories.unshift(entry);
    this.#directories.length = Math.min(this.#directories.length, QUEUE_LIMITS.outputDirectories);
    this.#emit({ kind: 'options', options: { ...this.#options }, outputDirectories: this.#directoryList() });
    this.#store.schedule();
    return { id: entry.id, displayName: folderName(entry.path) };
  }

  #directoryList(): OutputDirectory[] {
    return this.#directories.map(entry => ({ id: entry.id, displayName: folderName(entry.path) }));
  }

  // ── Commands ──

  /**
   * Adds files the main-process dialog or the drop wrapper authorized: at most 100 per call, and no
   * more than the queue's 500 items (finished items are removed, earliest first, to make room).
   * A file already in the queue answers its item. New items are probed in the background.
   */
  async add(paths: readonly string[]): Promise<AddFilesResult> {
    await this.#whenRestored();
    this.#assertOpen();
    if (!Array.isArray(paths) || paths.some(filePath => typeof filePath !== 'string')) throw new MediaQueueError('invalid_request', 'The paths are invalid.');
    const result: AddFilesResult = { added: [], duplicates: [], rejected: [], truncated: Math.max(0, paths.length - QUEUE_LIMITS.filesPerAdd) };
    const added: Item[] = [];
    const removed: string[] = [];
    for (const filePath of paths.slice(0, QUEUE_LIMITS.filesPerAdd)) {
      const registered = await this.#inputs.add(filePath);
      if (this.#closing) {
        if (registered.ok && !this.#items.has(registered.input.id)) this.#inputs.remove(registered.input.id);
        break;
      }
      if (!registered.ok) { result.rejected.push({ displayName: nameOf(filePath), code: registered.code }); continue; }
      const id = registered.input.id;
      if (this.#items.has(id)) { if (!result.duplicates.includes(id)) result.duplicates.push(id); continue; }
      const made = this.#makeRoom(1);
      removed.push(...made);
      if (this.#items.size >= QUEUE_LIMITS.items) {
        this.#inputs.remove(id);
        result.truncated++;
        continue;
      }
      const item: Item = {
        id, media: null, state: { status: 'analyzing' }, job: null, progress: null, result: null, log: null,
        addedAt: this.#clock.now(), finishedAt: null, generation: 0,
      };
      this.#items.set(id, item);
      added.push(item);
      result.added.push(id);
    }
    this.#changed(added, removed);
    for (const item of added) this.#track(this.#probeAdded(item, item.generation));
    return result;
  }

  async #probeAdded(item: Item, generation: number) {
    const input = this.#inputs.get(item.id);
    const outcome = input ? await this.#prober.probe(input.path).catch(() => ({ ok: false as const, code: 'probe_failed' as const }))
      : { ok: false as const, code: 'file_unavailable' as const };
    if (!this.#current(item, generation) || item.state.status !== 'analyzing') return;
    if (outcome.ok) {
      item.media = outcome.info;
      item.state = { status: 'idle' };
      this.#changed([item]);
    } else {
      item.media = null;
      this.#finish(item, { status: 'unsupported', code: outcome.code });
    }
  }

  /**
   * Plans every item with the request's settings and output. Nothing starts while a confirmation is
   * missing: a plan converting lossy audio to a lossless format (`lossy_to_lossless`) needs the item
   * in `confirmed.lossyToLossless`, and with `overwrite` every existing file an output would replace
   * needs `confirmed.replaceExisting`; such items are rejected with `confirmation_required` and
   * `needsConfirmation` lists what to confirm. Otherwise settings, plan, targets and the confirmed
   * replacements are frozen and the items are queued in the order given. A plan that would change
   * nothing (`already_target`) is skipped without running.
   */
  async start(request: unknown): Promise<StartResult> {
    await this.#whenRestored();
    this.#assertOpen();
    const parsed = startRequestSchema.safeParse(request);
    if (!parsed.success) throw new MediaQueueError('invalid_request', 'The start request is invalid.');
    const { itemIds, output, confirmed } = parsed.data;
    const result: StartResult = { started: [], skipped: [], rejected: [], needsConfirmation: null };
    const reject = (itemId: string, code: ItemFailureCode) => { result.rejected.push({ itemId, code }); };

    const candidates: { item: Item; generation: number }[] = [];
    for (const id of itemIds) {
      const item = this.#items.get(id);
      if (!item) reject(id, 'invalid_request');
      else if (item.state.status === 'idle' && item.media) candidates.push({ item, generation: item.generation });
      else if (item.state.status === 'analyzing') reject(id, 'busy');
      else reject(id, item.state.status === 'unsupported' ? item.state.code : 'invalid_request');
    }
    if (!candidates.length) return result;
    const chosen = output.mode === 'directory' ? this.#directories.find(entry => entry.id === output.directoryId)?.path ?? null : null;
    if (output.mode === 'directory' && !chosen) {
      for (const { item } of candidates) reject(item.id, 'output_dir_unwritable');
      return result;
    }
    const caps = await this.#planningCapabilities();
    if (!caps.ok) {
      for (const { item } of candidates) reject(item.id, caps.code);
      return result;
    }

    const settings = deepFreeze(parsed.data.settings);
    const confirmedLossless = new Set(confirmed.lossyToLossless);
    const needs = { lossyToLossless: [] as string[], wouldReplace: [] as { itemId: string; fileName: string }[] };
    type Prepared = { item: Item; generation: number; directory: string; outcome: Extract<PlanOutcome, { plan: ConversionPlan }>; targets: OutputTargetName[]; replacing: string[] };
    const prepared: Prepared[] = [];
    for (const { item, generation } of candidates) {
      const input = this.#inputs.get(item.id);
      if (!input || !item.media) { reject(item.id, 'input_missing'); continue; }
      const directory = chosen ?? path.dirname(input.path);
      const outcome = this.#plan(item.media, settings, caps.capabilities);
      if (outcome.status === 'not_applicable' || outcome.status === 'error' || outcome.status === 'failed') { reject(item.id, outcome.reason); continue; }
      if (outcome.status === 'skipped') { prepared.push({ item, generation, directory, outcome, targets: [], replacing: [] }); continue; }
      const targets = this.#targets(outcome.plan, input, directory);
      if (typeof targets === 'string') { reject(item.id, targets); continue; }
      let waiting = false;
      if (outcome.plan.summary.confirmations.includes('lossy_to_lossless') && !confirmedLossless.has(item.id)) {
        needs.lossyToLossless.push(item.id);
        waiting = true;
      }
      const replacing: string[] = [];
      if (output.conflict === 'overwrite') {
        for (const target of targets) {
          const name = await this.#wouldReplace(target.directory, target.baseName, target.extension).catch(() => null);
          if (name && !replacing.includes(name)) replacing.push(name);
        }
      }
      if (replacing.length && !confirmed.replaceExisting) {
        for (const fileName of replacing) needs.wouldReplace.push({ itemId: item.id, fileName });
        waiting = true;
      }
      if (waiting) reject(item.id, 'confirmation_required');
      else prepared.push({ item, generation, directory, outcome, targets, replacing });
    }
    if (needs.lossyToLossless.length || needs.wouldReplace.length) {
      result.needsConfirmation = needs;
      return result;
    }
    this.#assertOpen();

    const changed: Item[] = [];
    const skipped: Item[] = [];
    for (const { item, generation, directory, outcome, targets, replacing } of prepared) {
      // Everything above awaited: an item removed, started or retried meanwhile is left as it is now.
      if (!this.#current(item, generation) || item.state.status !== 'idle') { reject(item.id, 'invalid_request'); continue; }
      const plan = deepFreeze(outcome.plan);
      item.job = {
        settings, plan: outcome.status === 'ready' ? plan : null, summary: plan.summary,
        output: {
          mode: output.mode, directoryId: output.mode === 'directory' ? output.directoryId : null, directory, conflict: output.conflict,
          confirmedReplace: Object.freeze([...replacing]),
        },
        targets: Object.freeze(targets), confirmedLossyToLossless: confirmedLossless.has(item.id), acceptAlreadyTarget: false, order: ++this.#order,
      };
      item.result = null;
      item.log = null;
      if (outcome.status === 'skipped') { skipped.push(item); continue; }
      item.state = { status: 'queued' };
      item.finishedAt = null;
      this.#beginBatch();
      result.started.push(item.id);
      changed.push(item);
    }
    for (const item of skipped) {
      result.skipped.push(item.id);
      this.#finish(item, { status: 'skipped', reason: 'already_target' }, { emit: false });
      changed.push(item);
    }
    this.#changed(changed);
    this.#reconcile();
    return result;
  }

  /** Cancels queued items at once and running ones through their executor (the state follows once it has cleaned up). */
  async cancel(request: unknown): Promise<{ affected: number }> {
    await this.#whenRestored();
    const { itemIds } = this.#parse(itemIdsRequestSchema, request);
    let affected = 0;
    const changed: Item[] = [];
    for (const id of itemIds) {
      const item = this.#items.get(id);
      if (!item) continue;
      const run = this.#active.get(id);
      const status = item.state.status;
      if (status === 'running') {
        run?.controller.abort();
        affected++;
      } else if (status === 'queued' || (status === 'analyzing' && item.job)) {
        // A queued item may be holding a slot while its input is checked; the check's continuation then finds it cancelled.
        run?.controller.abort();
        item.generation++;
        this.#finish(item, { status: 'cancelled' }, { emit: false });
        changed.push(item);
        affected++;
      }
    }
    this.#changed(changed);
    this.#reconcile();
    return { affected };
  }

  /** Removes items that are not running; a queued one leaves the queue. */
  async remove(request: unknown): Promise<{ affected: number }> {
    await this.#whenRestored();
    const { itemIds } = this.#parse(itemIdsRequestSchema, request);
    const removed = itemIds.filter(id => {
      const item = this.#items.get(id);
      return item && item.state.status !== 'running' && this.#drop(item);
    });
    this.#changed([], removed);
    this.#reconcile();
    return { affected: removed.length };
  }

  /** `finished`: every item that ended; `all_idle`: everything not queued, running or being analyzed. */
  async clear(request: unknown): Promise<{ removed: number }> {
    await this.#whenRestored();
    const { scope } = this.#parse(clearRequestSchema, request);
    const removed: string[] = [];
    for (const item of [...this.#items.values()]) {
      const status = item.state.status;
      const clears = scope === 'finished' ? FINISHED.has(status) : status !== 'queued' && status !== 'running' && status !== 'analyzing';
      if (clears && this.#drop(item)) removed.push(item.id);
    }
    this.#changed([], removed);
    this.#reconcile();
    return { removed: removed.length };
  }

  /**
   * Starts ended items again (failed, cancelled, interrupted, input changed, skipped, unsupported):
   * the file as it is now becomes the reference, it is probed again, and an item that was started
   * is planned again with its frozen settings and output, then queued. `override` is "convert
   * anyway": `already_target` runs the plan that was skipped, `not_smaller` turns the not-larger
   * guard of a compression off. It stays with the item for later retries.
   */
  async retry(request: unknown): Promise<{ affected: number }> {
    await this.#whenRestored();
    this.#assertOpen();
    const { itemIds, override } = this.#parse(retryRequestSchema, request);
    // The run order is the order of the request, whichever probe answers first.
    const accepted: { item: Item; order: number }[] = [];
    for (const id of itemIds) {
      const item = this.#items.get(id);
      if (!item || !RETRYABLE.has(item.state.status)) continue;
      item.generation++;
      item.state = { status: 'analyzing' };
      item.progress = null;
      item.result = null;
      item.log = null;
      item.finishedAt = null;
      accepted.push({ item, order: ++this.#order });
    }
    this.#changed(accepted.map(entry => entry.item));
    const work = Promise.all(accepted.map(({ item, order }) => {
      const generation = item.generation;
      return this.#retryOne(item, generation, order, override).catch(error => {
        this.#log('A media conversion could not be retried.', error);
        if (this.#current(item, generation) && item.state.status === 'analyzing') this.#finish(item, { status: 'failed', code: 'encode_failed', partial: false });
      });
    }));
    this.#track(work);
    await work;
    this.#reconcile();
    return { affected: accepted.length };
  }

  async #retryOne(item: Item, generation: number, order: number, override: PlanSkipCode | undefined) {
    const current = () => this.#current(item, generation) && item.state.status === 'analyzing';
    const fail = (code: ItemFailureCode) => this.#finish(item, { status: 'failed', code, partial: false });
    const refreshed = await this.#inputs.refresh(item.id);
    if (!current()) return;
    if (refreshed === 'input_missing') return fail('input_missing');
    if (refreshed === 'input_changed') return this.#finish(item, { status: 'input_changed' });
    const input = this.#inputs.get(item.id);
    if (!input) return fail('input_missing');
    const probed = await this.#prober.probe(input.path).catch(() => ({ ok: false as const, code: 'probe_failed' as const }));
    if (!current()) return;
    if (!probed.ok) {
      item.media = null;
      return this.#finish(item, item.job ? { status: 'failed', code: probed.code, partial: false } : { status: 'unsupported', code: probed.code });
    }
    item.media = probed.info;
    const job = item.job;
    if (!job) {
      item.state = { status: 'idle' };
      return this.#changed([item]);
    }
    const caps = await this.#planningCapabilities();
    if (!current()) return;
    if (!caps.ok) return fail(caps.code);
    const settings = override === 'not_smaller' && job.settings.task === 'compress' && job.settings.discardIfNotSmaller
      ? deepFreeze({ ...job.settings, discardIfNotSmaller: false }) : job.settings;
    const acceptAlreadyTarget = job.acceptAlreadyTarget || override === 'already_target';
    const outcome = this.#plan(probed.info, settings, caps.capabilities);
    if (outcome.status === 'not_applicable' || outcome.status === 'error' || outcome.status === 'failed') return fail(outcome.reason);
    const plan = deepFreeze(outcome.plan);
    const base = { ...job, settings, summary: plan.summary, acceptAlreadyTarget };
    if (outcome.status === 'skipped' && !acceptAlreadyTarget) {
      item.job = { ...base, plan: null, targets: [] };
      return this.#finish(item, { status: 'skipped', reason: 'already_target' });
    }
    if (plan.summary.confirmations.includes('lossy_to_lossless') && !job.confirmedLossyToLossless) return fail('confirmation_required');
    const targets = this.#targets(plan, input, job.output.directory);
    if (typeof targets === 'string') return fail(targets);
    item.job = { ...base, plan, targets: Object.freeze(targets), order };
    item.state = { status: 'queued' };
    this.#beginBatch();
    this.#changed([item]);
  }

  /** Queue options belong to the main process; a change of concurrency applies to the next start, low usage to the next run. */
  async setOptions(patch: unknown): Promise<QueueOptions> {
    await this.#whenRestored();
    this.#assertOpen();
    const parsed = this.#parse(queueOptionsPatchSchema, patch);
    const next: QueueOptions = {
      concurrency: parsed.concurrency ?? this.#options.concurrency,
      lowUsage: parsed.lowUsage ?? this.#options.lowUsage,
    };
    if (next.concurrency !== this.#options.concurrency || next.lowUsage !== this.#options.lowUsage) {
      this.#options = Object.freeze(next);
      this.#emit({ kind: 'options', options: { ...next }, outputDirectories: this.#directoryList() });
      this.#store.schedule();
      this.#reconcile();
    }
    return { ...this.#options };
  }

  /** The plan an idle item would get with `settings`, for the interface to show before the start. */
  async previewPlan(itemId: unknown, settings: unknown): Promise<PreviewPlanResult> {
    await this.#whenRestored();
    const id = this.#parse(itemIdSchema, itemId);
    const parsedSettings = this.#parse(conversionSettingsSchema, settings);
    const item = this.#items.get(id);
    if (!item) return { ok: false, code: 'invalid_request' };
    if (!item.media) return { ok: false, code: item.state.status === 'unsupported' ? item.state.code : 'busy' };
    const caps = await this.#planningCapabilities();
    if (!caps.ok) return { ok: false, code: caps.code };
    const outcome = this.#plan(item.media, parsedSettings, caps.capabilities);
    if (outcome.status === 'ready') return { ok: true, status: 'ready', plan: outcome.plan.summary };
    if (outcome.status === 'skipped') return { ok: true, status: 'skipped', reason: 'already_target', plan: outcome.plan.summary };
    if (outcome.status === 'error' && outcome.reason === 'no_encoder_available') {
      // "Use X instead": each codec once, only codecs the contract knows.
      const alternatives = [...new Set(Array.isArray(outcome.alternatives) ? outcome.alternatives : [])]
        .filter((codec): codec is CompressCodec => compressCodecSchema.safeParse(codec).success);
      return { ok: true, status: 'error', reason: 'no_encoder_available', alternatives };
    }
    return { ok: false, code: outcome.reason };
  }

  // ── Shutdown ──

  /**
   * Stops scheduling, marks what was queued `interrupted`, cancels every run, waits for the
   * executors to stop ffmpeg and remove their partials (4 s at most), releases the power blocker and
   * writes the state. The same promise for every caller, cached before anything is aborted (FK-PIT-0046).
   */
  shutdown(reason: ApplicationShutdownReason = 'app_quit'): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closing = true;
    // Never rejects: the shared shutdown would only get this same settled Promise again, and quitting must not wait on it.
    this.#shutdown = Promise.resolve().then(() => this.#close(reason)).catch(error => this.#log('The media converter queue did not shut down cleanly.', error));
    return this.#shutdown;
  }

  async #close(_reason: ApplicationShutdownReason) {
    // What is written last must include what the restore read.
    await this.#ready;
    try { this.#unsubscribe(); } catch (error) { this.#log('The engine status subscription could not be ended.', error); }
    const now = this.#clock.now();
    const changed: Item[] = [];
    for (const item of this.#items.values()) {
      const status = item.state.status;
      // A queued item holding a slot is still checking its input; it is settled below with the running ones.
      if ((status === 'queued' && !this.#active.has(item.id)) || status === 'analyzing') {
        item.generation++;
        item.state = { status: 'interrupted' };
        item.finishedAt = now;
        changed.push(item);
      }
    }
    for (const run of this.#active.values()) run.controller.abort();
    this.#batch = null;
    this.#syncPower();
    for (const gate of this.#gates.values()) if (gate.timer !== null) this.#clock.clearTimeout(gate.timer);
    this.#gates.clear();
    this.#changed(changed);

    const finished = await this.#within(Promise.allSettled([...this.#active.values()].map(run => run.done)), this.#shutdownWaitMs);
    if (!finished) this.#log('Media conversions were still stopping when the shutdown wait ended.');
    const late: Item[] = [];
    for (const item of this.#items.values()) {
      if (item.state.status !== 'running' && item.state.status !== 'queued') continue;
      item.state = { status: 'interrupted' };
      item.progress = null;
      item.finishedAt = this.#clock.now();
      late.push(item);
    }
    this.#changed(late);
    await this.#store.close();
  }

  /** True when `promise` settled within `milliseconds`. */
  async #within(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
    let timer: unknown = null;
    const timeout = new Promise<false>(resolve => { timer = this.#clock.setTimeout(() => resolve(false), milliseconds); });
    try { return await Promise.race([promise.then(() => true as const), timeout]); }
    finally { if (timer !== null) this.#clock.clearTimeout(timer); }
  }

  // ── Scheduling ──

  /**
   * Fills free slots in the order items were started, then settles the batch and the power blocker.
   * Nothing starts during a detection; its end calls this again through the engine subscription.
   */
  #reconcile() {
    if (!this.#closing && !this.#detecting()) {
      while (this.#active.size < this.#options.concurrency) {
        const next = this.#nextQueued();
        if (!next) break;
        this.#launch(next);
      }
    }
    this.#endBatchIfIdle();
    this.#syncPower();
  }

  /** The encoders are being detected (the first time, or "detect again"); a status that cannot be read holds nothing back. */
  #detecting(): boolean {
    try { return this.#capabilities.status().capabilities.state === 'detecting'; }
    catch (error) {
      this.#log('The engine status could not be read.', error);
      return false;
    }
  }

  #nextQueued(): Item | undefined {
    let next: Item | undefined;
    for (const item of this.#items.values()) {
      if (item.state.status !== 'queued' || this.#active.has(item.id) || !item.job) continue;
      if (!next || item.job.order < next.job!.order) next = item;
    }
    return next;
  }

  #launch(item: Item) {
    const run: ActiveRun = { controller: new AbortController(), done: Promise.resolve() };
    this.#active.set(item.id, run);
    run.done = this.#execute(item, run)
      .catch(error => {
        this.#log('A media conversion could not be settled.', error);
        // Never left queued or running: the scheduler would take it again at once, and again.
        const status = item.state.status;
        if (!this.#closing && this.#items.get(item.id) === item && this.#active.get(item.id) === run && (status === 'queued' || status === 'running')) {
          this.#finish(item, { status: 'failed', code: 'encode_failed', partial: false });
        }
      })
      .finally(() => {
        if (this.#active.get(item.id) === run) this.#active.delete(item.id);
        this.#reconcile();
      });
  }

  /** The check before the run (AC-ENGINE-05-3), then the executor. */
  async #execute(item: Item, run: ActiveRun) {
    const generation = item.generation;
    const check = await this.#inputs.verify(item.id);
    // A cancel or remove during the check has already settled the item.
    if (!this.#current(item, generation) || item.state.status !== 'queued' || this.#active.get(item.id) !== run) return;
    if (run.controller.signal.aborted) return this.#finish(item, { status: this.#closing ? 'interrupted' : 'cancelled' });
    if (check === 'input_missing') return this.#finish(item, { status: 'failed', code: 'input_missing', partial: false });
    if (check === 'input_changed') return this.#finish(item, { status: 'input_changed' });
    const input = this.#inputs.get(item.id);
    const job = item.job;
    if (!input || !job?.plan || !item.media) return this.#finish(item, { status: 'failed', code: input ? 'encode_failed' : 'input_missing', partial: false });
    // A detection began while the input was checked: the item gives its slot back and stays queued until it ends.
    if (this.#detecting()) return;

    item.state = { status: 'running', phase: 'preparing' };
    item.progress = null;
    this.#changed([item], [], { persist: false });
    const executionJob: ExecutionJob = Object.freeze({
      itemId: item.id, inputPath: input.path, media: item.media, settings: job.settings, plan: job.plan, targets: job.targets,
      conflict: job.output.conflict, confirmedReplace: job.output.confirmedReplace, lowUsage: this.#options.lowUsage,
      inputPaths: Object.freeze(this.#inputs.paths()),
    });
    const hooks: ExecutionHooks = {
      signal: run.controller.signal,
      phase: phase => {
        if (!this.#running(item, run) || !itemPhaseSchema.safeParse(phase).success) return;
        if (item.state.status === 'running' && item.state.phase === phase) return;
        item.state = { status: 'running', phase };
        this.#changed([item], [], { persist: false });
      },
      progress: progress => this.#progress(item, run, progress),
    };
    let outcome: ExecutionOutcome;
    try { outcome = await this.#executor.run(executionJob, hooks); }
    catch (error) {
      this.#log('The media executor failed.', error);
      outcome = { status: 'failed', code: 'encode_failed', outputs: [], log: error instanceof Error ? error.message : null };
    }
    // The shutdown may have given up waiting and marked the item interrupted.
    if (!this.#running(item, run)) return;
    this.#settle(item, outcome);
  }

  #settle(item: Item, outcome: ExecutionOutcome) {
    // The plan as it ran (`encoder_fallback`). It reaches the renderer and state.json, so a summary out of shape is not taken.
    const summary = 'summary' in outcome && outcome.summary !== undefined ? planSummarySchema.safeParse(outcome.summary) : null;
    if (summary && !summary.success) this.#log('The media executor reported a plan summary out of shape; the planned one is kept.');
    if (item.job && summary?.success) item.job = { ...item.job, summary: summary.data };
    switch (outcome.status) {
      case 'succeeded':
        item.result = this.#result(item, outcome.outputs, outcome.warnings);
        return this.#finish(item, { status: 'succeeded' });
      case 'skipped':
        return this.#finish(item, { status: 'skipped', reason: 'not_smaller' });
      case 'failed': {
        const known = itemFailureCodeSchema.safeParse(outcome.code);
        // The process's `unknown` is a capability category; for an item it is an encode that failed.
        const code: ItemFailureCode = !known.success || known.data === 'unknown' ? 'encode_failed' : known.data;
        const result = this.#result(item, outcome.outputs, outcome.warnings ?? []);
        item.result = result.outputs.length ? result : null;
        item.log = this.#redactLog(item, outcome.log, result.outputs);
        // The bytes needed and free, which the interface shows with `disk_space_low` (AC-ENGINE-06-4).
        const space = code === 'disk_space_low' ? this.#space(outcome.space) : null;
        return this.#finish(item, { status: 'failed', code, partial: result.outputs.length > 0, ...(space ? { space } : {}) });
      }
      case 'cancelled': {
        // An item of several outputs keeps those it published before the cancel: listed, they can be shown in their folder.
        const result = this.#result(item, outcome.outputs ?? [], outcome.warnings ?? []);
        item.result = result.outputs.length ? result : null;
        return this.#finish(item, { status: this.#closing ? 'interrupted' : 'cancelled' });
      }
      default:
        return this.#finish(item, { status: 'failed', code: 'encode_failed', partial: false });
    }
  }

  /** What the executor said the volume needs and has; anything out of shape is left out (the code alone still fails the item). */
  #space(space: unknown): DiskSpace | null {
    const parsed = diskSpaceSchema.safeParse(space);
    if (space !== undefined && !parsed.success) this.#log('The media executor reported the disk space out of shape; the item fails without it.');
    return parsed.success ? parsed.data : null;
  }

  #result(item: Item, outputs: readonly PublishedOutput[], warnings: readonly PlanWarningCode[]): PersistedResult {
    const valid = (Array.isArray(outputs) ? outputs : []).filter(output => output && Number.isInteger(output.index) && output.index >= 0
      && fullyQualifiedPath(output.path) && Number.isSafeInteger(output.sizeBytes) && output.sizeBytes >= 0);
    const codes = [...new Set(Array.isArray(warnings) ? warnings : [])].filter(code => planWarningCodeSchema.safeParse(code).success).slice(0, 64);
    return {
      outputs: valid.map(output => ({ index: output.index, path: output.path, sizeBytes: output.sizeBytes, replaced: output.replaced === true })),
      outputCount: Math.max(1, item.job?.plan?.outputs.length ?? item.job?.summary.outputs.length ?? valid.length),
      sourceBytes: item.media?.sizeBytes ?? this.#inputs.get(item.id)?.state.size ?? 0,
      warnings: codes,
    };
  }

  /**
   * The executor redacts with every path of the run; this keeps the item's own paths out once more
   * and keeps the last 16 KB of whole lines of the redacted text. Redaction shortens lines full of
   * paths a lot, so a larger window of the raw log is redacted before the 16 KB are cut.
   */
  #redactLog(item: Item, log: string | null, outputs: PersistedResult['outputs']): string | null {
    if (typeof log !== 'string' || !log) return null;
    const input = this.#inputs.get(item.id);
    const redact = createLogRedactor({
      inputs: input ? [input.path] : [],
      outputs: [...outputs.map(output => output.path), ...(item.job ? [item.job.output.directory] : [])],
    });
    const window = redactedLogTail(Buffer.from(log, 'utf8'), QUEUE_POLICY.redactionWindowBytes, redact);
    return utf8Tail(window, QUEUE_LIMITS.logTailBytes) || null;
  }

  // ── Progress ──

  /** The latest progress is kept; the renderer gets it at most every 250 ms, the last one included. */
  #progress(item: Item, run: ActiveRun, progress: ItemProgress) {
    if (!this.#running(item, run)) return;
    const parsed = itemProgressSchema.safeParse(progress);
    if (!parsed.success) return;
    item.progress = parsed.data;
    let gate = this.#gates.get(item.id);
    if (!gate) this.#gates.set(item.id, gate = { lastAt: null, timer: null });
    if (gate.timer !== null) return;
    const interval = QUEUE_LIMITS.progressIntervalMs;
    const wait = gate.lastAt === null ? 0 : Math.min(interval, gate.lastAt + interval - this.#clock.monotonic());
    if (wait <= 0) return this.#sendProgress(item, gate);
    const pending = gate;
    pending.timer = this.#clock.setTimeout(() => {
      pending.timer = null;
      if (this.#gates.get(item.id) === pending && this.#running(item, run)) this.#sendProgress(item, pending);
    }, wait);
  }

  #sendProgress(item: Item, gate: ProgressGate) {
    if (!item.progress) return;
    gate.lastAt = this.#clock.monotonic();
    this.#emit({ kind: 'progress', itemId: item.id, progress: item.progress });
  }

  #closeGate(id: string) {
    const gate = this.#gates.get(id);
    if (gate?.timer != null) this.#clock.clearTimeout(gate.timer);
    this.#gates.delete(id);
  }

  // ── Transitions ──

  /** An item ends (or is set aside): its progress goes, the batch counts it, and the change is sent and saved. */
  #finish(item: Item, state: ItemState, options: { emit?: boolean } = {}) {
    item.state = state;
    item.progress = null;
    item.finishedAt = this.#clock.now();
    this.#closeGate(item.id);
    const batch = this.#batch;
    if (batch && !this.#closing) {
      if (state.status === 'succeeded') {
        batch.succeeded++;
        if (item.job?.settings.task === 'compress' && item.result) {
          const written = item.result.outputs.reduce((sum, output) => sum + output.sizeBytes, 0);
          batch.savedBytes += Math.max(0, item.result.sourceBytes - written);
        }
      } else if (state.status === 'skipped') batch.skipped++;
      else if (state.status === 'failed' || state.status === 'input_changed') batch.failed++;
      else if (state.status === 'cancelled') batch.cancelled++;
    }
    if (options.emit !== false) {
      this.#changed([item]);
      this.#endBatchIfIdle();
    }
  }

  #beginBatch() {
    this.#batch ??= { succeeded: 0, failed: 0, skipped: 0, cancelled: 0, savedBytes: 0 };
  }

  /** A batch ends when nothing is queued or holding a slot: one `batch-finished`, and the names it published may be used again. */
  #endBatchIfIdle() {
    const batch = this.#batch;
    if (!batch || this.#closing || this.#active.size > 0 || [...this.#items.values()].some(item => item.state.status === 'queued')) return;
    this.#batch = null;
    try { this.#executor.endBatch?.(); } catch (error) { this.#log('The output names of the batch could not be released.', error); }
    this.#emit({ kind: 'batch-finished', batch: { ...batch } });
  }

  /** Held while anything is queued or running (AC-ENGINE-05-5); released when idle and at shutdown. */
  #syncPower() {
    const busy = !this.#closing && (this.#active.size > 0 || [...this.#items.values()].some(item => item.state.status === 'queued'));
    if (busy && this.#powerId === null) {
      try { this.#powerId = this.#power.start('prevent-app-suspension'); }
      catch (error) { this.#log('The power save blocker could not be started.', error); }
    } else if (!busy && this.#powerId !== null) {
      const id = this.#powerId;
      this.#powerId = null;
      try { this.#power.stop(id); } catch (error) { this.#log('The power save blocker could not be stopped.', error); }
    }
  }

  /** Removes an item and its input; a queued item holding a slot is told to stop. */
  #drop(item: Item): boolean {
    if (this.#items.get(item.id) !== item) return false;
    this.#active.get(item.id)?.controller.abort();
    item.generation++;
    this.#items.delete(item.id);
    this.#inputs.remove(item.id);
    this.#closeGate(item.id);
    return true;
  }

  /** Removes finished items, earliest finished first, until `extra` more fit in the 500; returns their ids. */
  #makeRoom(extra: number): string[] {
    const removed: string[] = [];
    while (this.#items.size + extra > QUEUE_LIMITS.items) {
      let oldest: Item | undefined;
      for (const item of this.#items.values()) {
        if (!FINISHED.has(item.state.status)) continue;
        if (!oldest || (item.finishedAt ?? 0) < (oldest.finishedAt ?? 0)) oldest = item;
      }
      if (!oldest || !this.#drop(oldest)) break;
      removed.push(oldest.id);
    }
    // Only a restored file can still be over: what is not finished is kept in the order added, the last ones go.
    if (extra === 0) {
      for (const item of [...this.#items.values()].slice(QUEUE_LIMITS.items).reverse()) if (this.#drop(item)) removed.push(item.id);
    }
    return removed;
  }

  // ── Helpers ──

  /** The capability table; a provider that throws counts as a detection that ended without a verdict. */
  async #planningCapabilities(): Promise<CapabilitiesAnswer> {
    try { return await this.#capabilities.planner(); }
    catch (error) {
      this.#log('The encoder capabilities could not be read.', error);
      return { ok: false, code: 'unknown' };
    }
  }

  #plan(media: MediaInfo, settings: ConversionSettings, caps: PlannerCapabilities): PlanOutcome | { status: 'failed'; reason: 'encode_failed' } {
    try { return this.#planner(media, settings, caps); }
    catch (error) {
      this.#log('The conversion could not be planned.', error);
      return { status: 'failed', reason: 'encode_failed' };
    }
  }

  /** Encode's output names in `directory` (`-converted` beside the source when the extension stays), or `output_path_too_long`. */
  #targets(plan: ConversionPlan, input: RegisteredInput, directory: string): OutputTargetName[] | 'output_path_too_long' {
    const besideSource = this.#samePath(directory, path.dirname(input.path));
    const targets: OutputTargetName[] = [];
    for (const output of plan.outputs) {
      const { baseName, extension } = output.container;
      const named = outputFileName({ directory, sourceFileName: input.displayName, baseName, extension, besideSource });
      if (!named.ok) return named.code;
      targets.push(Object.freeze({ directory, baseName: named.fileName.slice(0, -(extension.length + 1)), extension }));
    }
    return targets;
  }

  #samePath(a: string, b: string) {
    return this.#platform === 'win32' ? path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  }

  #current(item: Item, generation: number) {
    return this.#items.get(item.id) === item && item.generation === generation && !this.#closing;
  }

  #running(item: Item, run: ActiveRun) {
    return this.#items.get(item.id) === item && this.#active.get(item.id) === run && item.state.status === 'running';
  }

  #parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new MediaQueueError('invalid_request', 'The media converter request is invalid.');
    return parsed.data;
  }

  #assertOpen() {
    if (this.#closing) throw new MediaQueueError('busy', 'The media converter is shutting down.');
  }

  #track(task: Promise<unknown>) {
    const tracked = task.catch(error => this.#log('A media converter task failed.', error)).finally(() => this.#background.delete(tracked));
    this.#background.add(tracked);
  }

  // ── Events and state ──

  #emit(body: QueueEventBody) {
    const event = { sequence: ++this.#sequence, ...body } as QueueEvent;
    try { this.#emitTarget(event); } catch (error) { this.#log('A media converter event could not be delivered.', error); }
  }

  #changed(items: readonly Item[], removed: readonly string[] = [], options: { persist?: boolean } = {}) {
    if (!items.length && !removed.length) return;
    const unique = [...new Set(items)].filter(item => this.#items.get(item.id) === item);
    this.#emit({ kind: 'items', items: unique.map(item => this.#summary(item)), removed: [...removed] });
    if (options.persist !== false) this.#store.schedule();
  }

  #summary(item: Item): ItemSummary {
    const input = this.#inputs.get(item.id);
    const job = item.job;
    return {
      id: item.id,
      displayName: input?.displayName || '—',
      folderName: input?.folderName ?? '',
      media: item.media,
      state: item.state,
      job: job && {
        settings: job.settings, plan: job.summary,
        output: { mode: job.output.mode, directoryName: job.output.mode === 'directory' ? folderName(job.output.directory) : null, conflict: job.output.conflict },
      },
      progress: item.progress,
      result: item.result && this.#publicResult(item.result),
      log: item.log,
      addedAt: item.addedAt,
      finishedAt: item.finishedAt,
    };
  }

  #publicResult(result: PersistedResult): ItemResult {
    return {
      outputs: result.outputs.map(output => ({
        index: output.index, fileName: nameOf(output.path), folderName: folderName(path.dirname(output.path)), sizeBytes: output.sizeBytes, replaced: output.replaced,
      })),
      outputCount: result.outputCount,
      sourceBytes: result.sourceBytes,
      outputBytes: result.outputs.reduce((sum, output) => sum + output.sizeBytes, 0),
      warnings: [...result.warnings],
    };
  }

  #persisted(): PersistedQueueState {
    const items: PersistedItem[] = [];
    for (const item of this.#items.values()) {
      const input = this.#inputs.get(item.id);
      if (!input) continue;
      const job = item.job;
      items.push({
        id: item.id,
        input: { path: input.path, state: input.state },
        media: item.media,
        state: item.state,
        job: job && {
          settings: job.settings, summary: job.summary,
          output: { ...job.output, confirmedReplace: [...job.output.confirmedReplace] },
          confirmedLossyToLossless: job.confirmedLossyToLossless, acceptAlreadyTarget: job.acceptAlreadyTarget,
        },
        result: item.result,
        log: item.log,
        addedAt: item.addedAt,
        finishedAt: item.finishedAt,
      });
    }
    return { version: 1, options: { ...this.#options }, outputDirectories: this.#directories.map(entry => ({ ...entry })), items };
  }
}
