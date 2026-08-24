export interface BoundedCleanupRetryQueueOptions<TRequest> {
  retryDelaysMs: readonly number[];
  ttlMs: number;
  attemptTimeoutMs: number;
  operation: (request: TRequest) => Promise<boolean>;
  expiryPolicy?: "earliest" | "latest";
  now?: () => number;
}

interface PendingCleanup<TRequest> {
  key: string;
  request: TRequest;
  expiresAt: number;
  attemptCount: number;
  inFlight?: Promise<boolean>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export class BoundedCleanupRetryQueue<TRequest> {
  private readonly pending = new Map<string, PendingCleanup<TRequest>>();
  private readonly now: () => number;

  constructor(
    private readonly options: BoundedCleanupRetryQueueOptions<TRequest>,
  ) {
    if (
      options.retryDelaysMs.length === 0 ||
      options.retryDelaysMs.some(
        (delay) => !Number.isFinite(delay) || delay <= 0,
      )
    ) {
      throw new Error("Cleanup retry delays must be a non-empty positive list.");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("Cleanup retry TTL must be positive.");
    }
    if (
      !Number.isFinite(options.attemptTimeoutMs) ||
      options.attemptTimeoutMs <= 0
    ) {
      throw new Error("Cleanup attempt timeout must be positive.");
    }
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.pending.size;
  }

  queue(
    key: string,
    request: TRequest,
    expiresAt = this.now() + this.options.ttlMs,
  ): Promise<boolean> {
    const existing = this.pending.get(key);
    const pending = existing ?? {
      key,
      request,
      expiresAt,
      attemptCount: 0,
    };
    pending.request = request;
    if (existing) {
      pending.expiresAt =
        this.options.expiryPolicy === "earliest"
          ? Math.min(pending.expiresAt, expiresAt)
          : Math.max(pending.expiresAt, expiresAt);
    }
    this.pending.set(key, pending);
    this.clearRetry(pending);
    return this.attempt(pending);
  }

  async flush(): Promise<void> {
    await Promise.all(
      Array.from(this.pending.values(), (pending) => {
        this.clearRetry(pending);
        return this.attempt(pending);
      }),
    );
  }

  settle(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    this.clearRetry(pending);
  }

  reset(): void {
    for (const pending of this.pending.values()) {
      this.clearRetry(pending);
    }
    this.pending.clear();
  }

  private attempt(pending: PendingCleanup<TRequest>): Promise<boolean> {
    if (pending.inFlight) return pending.inFlight;
    const remainingTtlMs = pending.expiresAt - this.now();
    if (remainingTtlMs <= 0) {
      this.pending.delete(pending.key);
      return Promise.resolve(false);
    }

    pending.attemptCount += 1;
    const operationAttempt = (async () => {
      const succeeded = await runBoundedCleanupAttempt(
        () => this.options.operation(pending.request),
        Math.min(this.options.attemptTimeoutMs, remainingTtlMs),
      );
      if (this.pending.get(pending.key) !== pending) return false;
      if (succeeded) {
        this.pending.delete(pending.key);
        this.clearRetry(pending);
        return true;
      }
      this.scheduleRetry(pending);
      return false;
    })();
    const trackedAttempt = operationAttempt.finally(() => {
      if (pending.inFlight === trackedAttempt) pending.inFlight = undefined;
    });
    pending.inFlight = trackedAttempt;
    return trackedAttempt;
  }

  private scheduleRetry(pending: PendingCleanup<TRequest>): void {
    if (this.pending.get(pending.key) !== pending) return;
    if (this.now() >= pending.expiresAt) {
      this.pending.delete(pending.key);
      return;
    }
    const delayIndex = Math.min(
      pending.attemptCount - 1,
      this.options.retryDelaysMs.length - 1,
    );
    const delay = Math.min(
      this.options.retryDelaysMs[delayIndex] ?? 0,
      Math.max(0, pending.expiresAt - this.now()),
    );
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = undefined;
      void this.attempt(pending);
    }, delay);
  }

  private clearRetry(pending: PendingCleanup<TRequest>): void {
    if (pending.retryTimer === undefined) return;
    clearTimeout(pending.retryTimer);
    pending.retryTimer = undefined;
  }
}

export async function runBoundedCleanupAttempt<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
