import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  QUEUE_LIMITS, conversionSettingsSchema, itemIdSchema, itemStateSchema, mediaInfoSchema, outputConflictSchema, outputDirectoryIdSchema,
  planSummarySchema, planWarningCodeSchema, queueOptionsSchema,
} from '../../../../src/media-converter/contract';
import { atomicWriteUtf8File } from '../../translation/atomic-file';
import { isMissingPathError } from '../engine/inputs';
import { retryWhileBusy } from '../engine/output';
import type { QueueClock } from './types';

/**
 * `userData/media-converter/state.json` (design §6): the items with their frozen jobs and result
 * summaries (log tails already redacted and cut to 16 KB), the queue options, the last output
 * folders and a version. Paths stay in this file and in the main process; nothing here reaches the
 * renderer as it is. Writes are debounced to one every 500 ms, serialized and atomic
 * (`atomicWriteUtf8File`). A file that cannot be read is renamed to `state.corrupt.json` and the
 * queue starts empty, telling the interface once.
 */

export const STATE_STORE_POLICY = Object.freeze({
  debounceMs: 500,
  /** A write that failed (after `atomicWriteUtf8File`'s own lock retries) is tried again this much later, also when nothing else changes. */
  failedWriteRetryMs: 5_000,
  /** Items read back at most; the queue then keeps 500 by its own rule. */
  maxItems: 10_000,
  corruptName: 'state.corrupt.json',
});

const filePath = z.string().min(1).max(32_767);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const outputIndex = z.number().int().min(0).max(512);

const persistedOutputSchema = z.strictObject({ index: outputIndex, path: filePath, sizeBytes: bytes, replaced: z.boolean() });
const persistedResultSchema = z.strictObject({
  outputs: z.array(persistedOutputSchema).max(512),
  outputCount: z.number().int().min(1).max(512),
  sourceBytes: bytes,
  warnings: z.array(planWarningCodeSchema).max(64),
});
const persistedJobSchema = z.strictObject({
  settings: conversionSettingsSchema,
  /** The plan as the user saw it; the plan itself is made again when a retry runs the item. */
  summary: planSummarySchema,
  output: z.strictObject({
    mode: z.enum(['source', 'directory']),
    directoryId: outputDirectoryIdSchema.nullable(),
    /** The folder itself: the id may leave the list of recent folders while the item is kept. */
    directory: filePath,
    conflict: outputConflictSchema,
    confirmedReplace: z.array(z.string().min(1).max(1024)).max(512),
  }),
  confirmedLossyToLossless: z.boolean(),
  /** "Convert anyway" was chosen for an `already_target` skip: later retries keep running the plan. */
  acceptAlreadyTarget: z.boolean(),
});
const persistedItemSchema = z.strictObject({
  id: itemIdSchema,
  /** `InputEntry`; the input registry checks the state when it takes it back. */
  input: z.strictObject({ path: filePath, state: z.unknown() }),
  media: mediaInfoSchema.nullable(),
  state: itemStateSchema,
  job: persistedJobSchema.nullable(),
  result: persistedResultSchema.nullable(),
  log: z.string().max(QUEUE_LIMITS.logTailBytes).nullable(),
  addedAt: timestamp,
  finishedAt: timestamp.nullable(),
});
const stateFileSchema = z.object({
  version: z.literal(1),
  options: queueOptionsSchema,
  outputDirectories: z.array(z.strictObject({ id: outputDirectoryIdSchema, path: filePath })).max(QUEUE_LIMITS.outputDirectories),
  items: z.array(z.unknown()).max(STATE_STORE_POLICY.maxItems),
});

export type PersistedOutput = z.infer<typeof persistedOutputSchema>;
export type PersistedResult = z.infer<typeof persistedResultSchema>;
export type PersistedJob = z.infer<typeof persistedJobSchema>;
export type PersistedItem = z.infer<typeof persistedItemSchema>;
export interface PersistedQueueState {
  version: 1;
  options: z.infer<typeof queueOptionsSchema>;
  outputDirectories: { id: string; path: string }[];
  items: PersistedItem[];
}

export interface LoadedQueueState {
  /** Null when there was no file, or it could not be read. */
  readonly state: PersistedQueueState | null;
  /** The file could not be read: it was set aside as `state.corrupt.json` (when it could be renamed). */
  readonly reset: boolean;
  /** Items left out because they did not have the persisted shape. */
  readonly droppedItems: number;
}

export interface QueueStateStoreOptions {
  /** `userData/media-converter/state.json`. */
  file: string;
  /** What to write: the queue's current state. */
  read: () => PersistedQueueState;
  clock: QueueClock;
  debounceMs?: number;
  /** `atomicWriteUtf8File`; tests inject failures. */
  write?: (file: string, content: string) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

const defaultLog = (message: string, error?: unknown) => console.warn(`[media-converter] ${message}`, error ?? '');

export class QueueStateStore {
  readonly #file: string;
  readonly #read: () => PersistedQueueState;
  readonly #clock: QueueClock;
  readonly #debounceMs: number;
  readonly #write: (file: string, content: string) => Promise<void>;
  readonly #log: (message: string, error?: unknown) => void;
  #timer: unknown = null;
  /** Changes not yet on disk. */
  #dirty = false;
  #writes: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: QueueStateStoreOptions) {
    if (!path.isAbsolute(options.file)) throw new TypeError('The media converter state file must be a full path.');
    this.#file = options.file;
    this.#read = options.read;
    this.#clock = options.clock;
    this.#debounceMs = options.debounceMs ?? STATE_STORE_POLICY.debounceMs;
    this.#write = options.write ?? atomicWriteUtf8File;
    this.#log = options.log ?? defaultLog;
  }

  get file() {
    return this.#file;
  }

  /** Reads the file once at startup. Never rejects: a missing file is an empty queue, an unreadable one is set aside. */
  async load(): Promise<LoadedQueueState> {
    let text: string;
    try { text = await retryWhileBusy(() => readFile(this.#file, 'utf8')); }
    catch (error) {
      if (isMissingPathError(error)) return { state: null, reset: false, droppedItems: 0 };
      this.#log('The queue state could not be read; it is set aside and the queue starts empty.', error);
      return this.#reset();
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = undefined; }
    const parsed = stateFileSchema.safeParse(raw);
    if (!parsed.success) return this.#reset();
    const items: PersistedItem[] = [];
    let droppedItems = 0;
    for (const value of parsed.data.items) {
      const item = persistedItemSchema.safeParse(value);
      if (item.success) items.push(item.data); else droppedItems++;
    }
    return { state: { version: 1, options: parsed.data.options, outputDirectories: parsed.data.outputDirectories, items }, reset: false, droppedItems };
  }

  /** At most one write every `debounceMs`, carrying the state of when it runs. */
  schedule() {
    if (this.#closed) return;
    this.#dirty = true;
    this.#arm(this.#debounceMs);
  }

  /** Writes what is pending now; resolves once it is on disk (a failure is logged, stays pending and is tried again later). */
  async flush(): Promise<void> {
    this.#disarm();
    await this.#flushNow();
  }

  /** The last flush; later changes are not written, and a failed last write is not tried again. */
  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
    this.#disarm();
  }

  #arm(milliseconds: number) {
    if (this.#closed || this.#timer !== null) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      void this.#flushNow();
    }, milliseconds);
  }

  #disarm() {
    if (this.#timer === null) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #flushNow(): Promise<void> {
    const run = this.#writes.then(async () => {
      if (!this.#dirty) return;
      this.#dirty = false;
      let content: string;
      try { content = JSON.stringify(this.#read()); }
      catch (error) { this.#log('The queue state could not be serialized.', error); return; }
      try { await this.#write(this.#file, content); }
      catch (error) {
        // Still owed: written by the next schedule or flush, or by the retry, whichever comes first.
        this.#dirty = true;
        this.#log('The queue state could not be written.', error);
        this.#arm(STATE_STORE_POLICY.failedWriteRetryMs);
      }
    });
    this.#writes = run.catch(() => undefined);
    return this.#writes;
  }

  async #reset(): Promise<LoadedQueueState> {
    const backup = path.join(path.dirname(this.#file), STATE_STORE_POLICY.corruptName);
    // Kept for diagnosis; an older copy is replaced.
    await retryWhileBusy(() => rename(this.#file, backup)).catch(error => this.#log('The unreadable queue state could not be set aside.', error));
    return { state: null, reset: true, droppedItems: 0 };
  }
}
