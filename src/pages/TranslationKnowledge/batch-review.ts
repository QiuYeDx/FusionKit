import type { Entry } from '@/translation-knowledge/schemas';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { hasArchivedReviewDependency, requiresIndividualReview } from '@/translation-knowledge/review-policy';
import { needsReview } from './model';

export type BatchReviewAction = 'adopt' | 'reject';
export type BatchReviewReason = 'individual' | 'dependency' | 'unavailable';
export function batchReviewReason(entry: Entry, snapshot: LibrarySnapshot, action: BatchReviewAction): BatchReviewReason | undefined {
  if (!needsReview(entry, snapshot) || entry.state === 'archived') return 'unavailable';
  if (hasArchivedReviewDependency(entry, snapshot.data)) return 'dependency';
  if (action === 'adopt' && requiresIndividualReview(entry)) return 'individual';
  return undefined;
}

/** Reconcile only the explicit selection. New records must never be added by refresh. */
export function selectedReviewEntries(snapshot: LibrarySnapshot, ids: readonly string[]): Entry[] {
  const selected = new Set(ids);
  return snapshot.data.entries.filter(entry => selected.has(entry.id) && needsReview(entry, snapshot));
}
