export type BoundedAsyncQueueDropReason =
  | "stopped"
  | "backlog_limit"
  | "byte_limit"
  | "stale";

export interface BoundedAsyncQueueTask {
  id: string;
  sizeBytes: number;
  enqueuedAtMs?: number;
  run: (signal: AbortSignal) => Promise<void>;
  cancel?: () => void | Promise<void>;
}

export interface BoundedAsyncQueueOptions {
  maxPendingItems: number;
  maxPendingBytes: number;
  maxQueueAgeMs: number;
  now?: () => number;
  onDrop?: (
    task: BoundedAsyncQueueTask,
    reason: BoundedAsyncQueueDropReason,
  ) => void;
  onTaskError?: (task: BoundedAsyncQueueTask, error: unknown) => void;
}

export interface BoundedAsyncQueueSnapshot {
  accepting: boolean;
  queuedIds: string[];
  inFlightId: string | null;
  pendingBytes: number;
}

interface QueueEntry {
  task: BoundedAsyncQueueTask;
  enqueuedAtMs: number;
}

/**
 * Owns a bounded serial task queue. Queued work is distinct from the one
 * in-flight task so abort only sends a remote cancellation for work that was
 * actually started.
 */
export class BoundedAsyncQueue {
  private readonly options: BoundedAsyncQueueOptions;
  private readonly now: () => number;
  private accepting = true;
  private queued: QueueEntry[] = [];
  private inFlight: {
    entry: QueueEntry;
    controller: AbortController;
  } | null = null;
  private pendingBytes = 0;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;
  private abortPromise: Promise<void> | null = null;

  constructor(options: BoundedAsyncQueueOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  enqueue(task: BoundedAsyncQueueTask): BoundedAsyncQueueDropReason | null {
    if (!this.accepting) return this.drop(task, "stopped");
    const pendingItems = this.queued.length + (this.inFlight ? 1 : 0);
    if (pendingItems >= this.options.maxPendingItems) {
      return this.drop(task, "backlog_limit");
    }
    if (this.pendingBytes + task.sizeBytes > this.options.maxPendingBytes) {
      return this.drop(task, "byte_limit");
    }

    const entry: QueueEntry = {
      task,
      enqueuedAtMs: task.enqueuedAtMs ?? this.now(),
    };
    this.queued.push(entry);
    this.pendingBytes += task.sizeBytes;
    this.ensureIdlePromise();
    this.pump();
    return null;
  }

  seal(): Promise<void> {
    this.accepting = false;
    this.resolveIdleIfNeeded();
    return this.idlePromise;
  }

  abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    const abortPromise = this.abortOnce();
    this.abortPromise = abortPromise;
    return abortPromise;
  }

  private async abortOnce(): Promise<void> {
    this.accepting = false;
    const queued = this.queued;
    this.queued = [];
    for (const entry of queued) {
      this.pendingBytes -= entry.task.sizeBytes;
      this.options.onDrop?.(entry.task, "stopped");
    }

    const inFlight = this.inFlight;
    if (inFlight) {
      inFlight.controller.abort();
      try {
        await inFlight.entry.task.cancel?.();
      } catch {
        // Remote cancellation is best-effort; the task signal is authoritative.
      }
    }
    this.resolveIdleIfNeeded();
  }

  getSnapshot(): BoundedAsyncQueueSnapshot {
    return {
      accepting: this.accepting,
      queuedIds: this.queued.map((entry) => entry.task.id),
      inFlightId: this.inFlight?.entry.task.id ?? null,
      pendingBytes: Math.max(0, this.pendingBytes),
    };
  }

  private pump(): void {
    if (this.inFlight) return;
    const entry = this.queued.shift();
    if (!entry) {
      this.resolveIdleIfNeeded();
      return;
    }
    if (this.now() - entry.enqueuedAtMs > this.options.maxQueueAgeMs) {
      this.pendingBytes -= entry.task.sizeBytes;
      this.options.onDrop?.(entry.task, "stale");
      this.pump();
      return;
    }

    const controller = new AbortController();
    this.inFlight = { entry, controller };
    void entry.task.run(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.options.onTaskError?.(entry.task, error);
        }
      })
      .finally(() => {
        this.pendingBytes -= entry.task.sizeBytes;
        if (this.inFlight?.entry === entry) {
          this.inFlight = null;
        }
        this.pump();
      });
  }

  private drop(
    task: BoundedAsyncQueueTask,
    reason: BoundedAsyncQueueDropReason,
  ): BoundedAsyncQueueDropReason {
    this.options.onDrop?.(task, reason);
    return reason;
  }

  private ensureIdlePromise(): void {
    if (this.resolveIdle) return;
    this.idlePromise = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
  }

  private resolveIdleIfNeeded(): void {
    if (this.inFlight || this.queued.length > 0) return;
    this.pendingBytes = 0;
    const resolve = this.resolveIdle;
    this.resolveIdle = null;
    resolve?.();
  }
}
