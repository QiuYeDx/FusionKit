import type { TextTranslationExecutionMode } from "@/type/textTranslation";

export type ReleaseTextTranslationRequestSlot = () => void;

export interface TextTranslationRequestSchedulerOptions {
  globalLimit?: number;
  parallelTaskLimit?: number;
  sequentialTaskLimit?: number;
}

export interface AcquireTextTranslationRequestSlotOptions {
  taskId: string;
  executionMode?: TextTranslationExecutionMode;
  priority?: number;
  signal?: AbortSignal;
}

export interface TextTranslationRequestSchedulerSnapshot {
  globalLimit: number;
  activeCount: number;
  activeByTask: Record<string, number>;
  waitingByTask: Record<string, number>;
}

interface WaitingRequest {
  id: number;
  taskId: string;
  taskLimit: number;
  priority: number;
  resolve: (release: ReleaseTextTranslationRequestSlot) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export class TextTranslationRequestSchedulerCancelledError extends Error {
  constructor(message = "Text translation request slot wait was cancelled.") {
    super(message);
    this.name = "TextTranslationRequestSchedulerCancelledError";
  }
}

export class TextTranslationRequestScheduler {
  private readonly globalLimit: number;
  private readonly parallelTaskLimit: number;
  private readonly sequentialTaskLimit: number;
  private activeCount = 0;
  private requestSequence = 0;
  private lastGrantedTaskId: string | undefined;
  private readonly activeByTask = new Map<string, number>();
  private readonly waiting: WaitingRequest[] = [];

  constructor(options: TextTranslationRequestSchedulerOptions = {}) {
    this.globalLimit = options.globalLimit ?? 5;
    this.parallelTaskLimit = options.parallelTaskLimit ?? 3;
    this.sequentialTaskLimit = options.sequentialTaskLimit ?? 1;

    if (this.globalLimit <= 0) {
      throw new Error("globalLimit must be greater than zero.");
    }
    if (this.parallelTaskLimit <= 0 || this.sequentialTaskLimit <= 0) {
      throw new Error("per-task limits must be greater than zero.");
    }
  }

  acquire(
    options: AcquireTextTranslationRequestSlotOptions,
  ): Promise<ReleaseTextTranslationRequestSlot> {
    if (options.signal?.aborted) {
      return Promise.reject(new TextTranslationRequestSchedulerCancelledError());
    }

    return new Promise((resolve, reject) => {
      const request: WaitingRequest = {
        id: this.requestSequence++,
        taskId: options.taskId,
        taskLimit: this.getTaskLimit(options.executionMode),
        priority: options.priority ?? 0,
        resolve,
        reject,
        signal: options.signal,
      };

      if (options.signal) {
        request.abortListener = () => {
          this.removeWaitingRequest(request);
          reject(new TextTranslationRequestSchedulerCancelledError());
        };
        options.signal.addEventListener("abort", request.abortListener, {
          once: true,
        });
      }

      this.waiting.push(request);
      this.drain();
    });
  }

  cancelWaiting(taskId: string): void {
    const cancelled = this.waiting.filter((request) => request.taskId === taskId);
    this.waiting.splice(
      0,
      this.waiting.length,
      ...this.waiting.filter((request) => request.taskId !== taskId),
    );

    for (const request of cancelled) {
      this.detachAbortListener(request);
      request.reject(new TextTranslationRequestSchedulerCancelledError());
    }
  }

  snapshot(): TextTranslationRequestSchedulerSnapshot {
    return {
      globalLimit: this.globalLimit,
      activeCount: this.activeCount,
      activeByTask: Object.fromEntries(this.activeByTask),
      waitingByTask: this.countWaitingByTask(),
    };
  }

  private drain(): void {
    while (this.activeCount < this.globalLimit && this.waiting.length > 0) {
      const nextIndex = this.findNextGrantableRequestIndex();
      if (nextIndex < 0) return;

      const [request] = this.waiting.splice(nextIndex, 1);
      this.detachAbortListener(request);
      this.grant(request);
    }
  }

  private findNextGrantableRequestIndex(): number {
    const eligible = this.waiting.filter((request) => this.canGrant(request));
    if (eligible.length === 0) return -1;

    const highestPriority = Math.max(
      ...eligible.map((request) => request.priority),
    );
    const taskIds = [
      ...new Set(
        this.waiting
          .filter(
            (request) =>
              request.priority === highestPriority && this.canGrant(request),
          )
          .map((request) => request.taskId),
      ),
    ];

    const startIndex = this.lastGrantedTaskId
      ? taskIds.indexOf(this.lastGrantedTaskId) + 1
      : 0;
    const rotatedTaskIds = [
      ...taskIds.slice(startIndex < 0 ? 0 : startIndex),
      ...taskIds.slice(0, startIndex < 0 ? 0 : startIndex),
    ];
    const selectedTaskId = rotatedTaskIds[0] ?? taskIds[0];

    return this.waiting.findIndex(
      (request) =>
        request.taskId === selectedTaskId &&
        request.priority === highestPriority &&
        this.canGrant(request),
    );
  }

  private canGrant(request: WaitingRequest): boolean {
    if (this.activeCount >= this.globalLimit) return false;
    return this.getActiveTaskCount(request.taskId) < request.taskLimit;
  }

  private grant(request: WaitingRequest): void {
    this.activeCount += 1;
    this.activeByTask.set(
      request.taskId,
      this.getActiveTaskCount(request.taskId) + 1,
    );
    this.lastGrantedTaskId = request.taskId;

    let released = false;
    request.resolve(() => {
      if (released) return;
      released = true;
      this.release(request.taskId);
    });
  }

  private release(taskId: string): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const nextTaskCount = Math.max(0, this.getActiveTaskCount(taskId) - 1);
    if (nextTaskCount === 0) {
      this.activeByTask.delete(taskId);
    } else {
      this.activeByTask.set(taskId, nextTaskCount);
    }
    this.drain();
  }

  private removeWaitingRequest(request: WaitingRequest): void {
    const index = this.waiting.findIndex((item) => item.id === request.id);
    if (index >= 0) {
      this.waiting.splice(index, 1);
    }
    this.detachAbortListener(request);
  }

  private detachAbortListener(request: WaitingRequest): void {
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
      request.abortListener = undefined;
    }
  }

  private getTaskLimit(mode: TextTranslationExecutionMode = "parallel"): number {
    return mode === "sequential_context"
      ? this.sequentialTaskLimit
      : this.parallelTaskLimit;
  }

  private getActiveTaskCount(taskId: string): number {
    return this.activeByTask.get(taskId) ?? 0;
  }

  private countWaitingByTask(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const request of this.waiting) {
      counts[request.taskId] = (counts[request.taskId] ?? 0) + 1;
    }
    return counts;
  }
}
