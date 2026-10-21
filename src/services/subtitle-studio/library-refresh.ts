import type { ErrorCode } from '../../subtitle-studio/domain';
import type { DocumentDeletion } from '../../subtitle-studio/batch-contract';

/**
 * Whether the library list must be read again. Each change is counted, so a read that started after every
 * counted change can settle them, while a change that arrives during the read keeps the next read queued.
 */
export class StudioLibraryInvalidation {
  private count = 0;
  private pending = false;
  get dirty() { return this.pending; }
  invalidate() { this.count++; this.pending = true; }
  /** Called before a read is sent; main sends a change before it serves a later list, so the read covers every change so far. */
  beginRead(): number { return this.count; }
  /** Called when that read was applied: clears the flag only when nothing changed since it was sent. */
  settle(covered: number) { if (this.count === covered) this.pending = false; }
  /** Takes the flag for a background read; false when there is nothing to read. */
  take(): boolean {
    if (!this.pending) return false;
    this.pending = false;
    return true;
  }
}

export type DeletionBatch = { readonly targets: ReadonlySet<string>; readonly observed: Set<string> };
/** Main's answer to a batch deletion, or the error that replaced it when the request failed as a whole. */
export type DeletionAnswer = { items: readonly DocumentDeletion[] } | { error: ErrorCode };
/** The documents to drop in one update, and one result per target in target order. */
export type DeletionSettlement = { forget: ReadonlySet<string>; items: DocumentDeletion[] };

/** Holds this window's own deletion events during one batch request, so the deleted rows leave together with its result. */
export class StudioDeletionDeferral {
  private batch: DeletionBatch | null = null;
  /** Opens a batch for these documents; a newer batch replaces one still open. */
  open(documentIds: Iterable<string>): DeletionBatch {
    const batch = { targets: new Set(documentIds), observed: new Set<string>() };
    this.batch = batch;
    return batch;
  }
  /** Holds a deletion event of the open batch; false means the caller applies it at once. */
  hold(documentId: string): boolean {
    const batch = this.batch;
    if (!batch?.targets.has(documentId)) return false;
    batch.observed.add(documentId);
    return true;
  }
  /**
   * Closes the batch. Every observed deletion and every successful item is forgotten, even when main reports
   * that item failed (another window deleted it first). When the request failed as a whole, a target whose
   * deletion event arrived is reported deleted: main had already removed it.
   */
  settle(batch: DeletionBatch, answer: DeletionAnswer): DeletionSettlement {
    if (this.batch === batch) this.batch = null;
    const targets = [...batch.targets];
    let items: DocumentDeletion[];
    if ('items' in answer) {
      const reported = new Map(answer.items.map(item => [item.documentId, item]));
      items = targets.map(documentId => reported.get(documentId) ?? { documentId, ok: false, error: 'document_unavailable' });
    } else items = targets.map(documentId => batch.observed.has(documentId) ? { documentId, ok: true } : { documentId, ok: false, error: answer.error });
    const forget = new Set(batch.observed);
    for (const item of items) if (item.ok) forget.add(item.documentId);
    return { forget, items };
  }
}
