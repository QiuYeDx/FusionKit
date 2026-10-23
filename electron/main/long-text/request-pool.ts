import { LONG_TEXT_LIMITS } from '../../../src/long-text/contract';

/**
 * Global model request slots shared by every document (design §6.1): FIFO, 6 at a time. A waiting
 * single-segment retranslation (`interactive`) goes before waiting run requests, but at most 2
 * interactive requests hold a slot at once. A slot stands for one physical request and is held until
 * the caller releases it.
 */

export type RequestPriority = 'run' | 'interactive';

interface Waiter {
  priority: RequestPriority;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

const aborted = () => new DOMException('The wait for a request slot was aborted.', 'AbortError');

export class RequestPool {
  private readonly active: Record<RequestPriority, number> = { run: 0, interactive: 0 };
  private readonly waiting: Waiter[] = [];

  constructor(
    private readonly slots: number = LONG_TEXT_LIMITS.globalRequests,
    private readonly interactiveSlots: number = LONG_TEXT_LIMITS.interactiveRequests,
  ) {
    if (!Number.isInteger(slots) || slots < 1 || !Number.isInteger(interactiveSlots) || interactiveSlots < 1) {
      throw new RangeError('Invalid request pool size');
    }
  }

  /** Requests held right now. */
  get inUse(): number {
    return this.active.run + this.active.interactive;
  }

  /** Resolves with an idempotent release once a slot is free; rejects with an `AbortError` when `signal` aborts first. */
  acquire(signal: AbortSignal, priority: RequestPriority): Promise<() => void> {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority, signal, resolve, reject,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(aborted());
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.inUse < this.slots) {
      const interactive = this.active.interactive < this.interactiveSlots ? this.waiting.findIndex(waiter => waiter.priority === 'interactive') : -1;
      const index = interactive >= 0 ? interactive : this.waiting.findIndex(waiter => waiter.priority === 'run');
      if (index < 0) return;
      const [waiter] = this.waiting.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.abort);
      const { priority } = waiter;
      this.active[priority]++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active[priority]--;
        this.drain();
      });
    }
  }
}
