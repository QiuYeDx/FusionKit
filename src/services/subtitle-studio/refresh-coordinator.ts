export class StudioRefreshDisposedError extends Error {
  constructor() { super('The document reader was disposed.'); this.name = 'StudioRefreshDisposedError'; }
}

type ForegroundJob = { run: () => Promise<void>; reject: (error: Error) => void };

/** One reader, with coalesced background invalidations and priority for explicit actions. */
export class StudioRefreshCoordinator {
  private readonly foreground: ForegroundJob[] = [];
  private requested = false;
  private scheduled = false;
  private running = false;
  private closed = false;

  constructor(private readonly refresh: () => Promise<void>, private readonly onRefreshError: (error: unknown) => void) {}

  get disposed() { return this.closed; }

  requestRefresh() {
    if (this.closed) return;
    this.requested = true;
    this.schedule();
  }

  runForeground<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StudioRefreshDisposedError());
    return new Promise<T>((resolve, reject) => {
      this.foreground.push({ reject, run: async () => {
        try { resolve(await action()); } catch (error) { reject(error); }
      } });
      this.schedule();
    });
  }

  dispose() {
    this.closed = true;
    this.requested = false;
    for (const job of this.foreground.splice(0)) job.reject(new StudioRefreshDisposedError());
  }

  private schedule() {
    if (this.closed || this.running || this.scheduled) return;
    this.scheduled = true;
    // Coalesce synchronous event bursts, and let StrictMode cleanup fence unstarted reads.
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  private pump() {
    if (this.closed || this.running) return;
    const job = this.foreground.shift();
    if (!job && !this.requested) return;
    if (!job) this.requested = false;
    this.running = true;
    const execute = async () => {
      try {
        if (job) await job.run();
        else await this.refresh();
      } catch (error) {
        if (!this.closed) this.onRefreshError(error);
      } finally {
        this.running = false;
        this.schedule();
      }
    };
    // The callback reports read failures; a throwing reporting callback must not strand the queue.
    void execute().catch(() => {});
  }
}
