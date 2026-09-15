import type { KnowledgeTaskGate } from '../../../src/translation-knowledge/task-reference-contract';

/** Main-process FIFO shared by task admission/resume and permanent knowledge clearing.
 * Callers must not reenter the gate or hold it while waiting for a model response. */
export class KnowledgeTaskSerialGate implements KnowledgeTaskGate {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
