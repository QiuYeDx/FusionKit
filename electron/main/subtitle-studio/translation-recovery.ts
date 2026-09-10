import { createHash } from 'node:crypto';
import { StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { projectTranslationUnits } from '../../../src/subtitle-studio/translation-protocol';
import { normalizeTranslationModel, type TranslationCheckpoint, type TranslationModel } from '../../../src/subtitle-studio/translation-contract';
import { validateSnapshot, type DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import type { DocumentRepository } from './document-repository';
import { buildTranslationRequest, requestTokenEstimate, sourceDigest, type TranslationPlan } from './translation-planner';

export function documentSourceDigest(document: SubtitleDocument): string {
  return createHash('sha256').update(JSON.stringify(document.cues.map(cue => [cue.id, cue.sourceRevision, sourceDigest(cue)]))).digest('hex');
}

export function checkpointForPlan(plan: TranslationPlan, document: SubtitleDocument, trackRevision = 1): TranslationCheckpoint {
  return { version: 1, sourceDigest: documentSourceDigest(document), trackRevision,
    batches: plan.batches.map(batch => ({ id: batch.id, cueIds: batch.units.map(unit => unit.cueId), before: [...batch.before], after: [...batch.after], estimatedInputTokens: batch.estimatedInputTokens, priorContextReserve: batch.priorContextReserve })) };
}

export function sameTranslationModel(first: TranslationModel | null, second: TranslationModel): boolean {
  if (!first) return false;
  try {
    const a = normalizeTranslationModel(first);
    const b = normalizeTranslationModel(second);
    return (['profileId', 'modelKey', 'endpoint', 'apiFormat', 'outputTokenParameter', 'thinkingEnabled'] as const).every(key => a[key] === b[key]);
  } catch { return false; }
}

export async function publishTransaction(repository: DocumentRepository, documentId: string, revision: number, action: (snapshot: DocumentSnapshot) => void, guard: () => void = () => {}): Promise<DocumentSnapshot> {
  let expected: string | undefined;
  try {
    return await repository.transact(documentId, revision, value => {
      action(value);
      const candidate = structuredClone(value);
      candidate.document.revision++;
      expected = JSON.stringify(validateSnapshot(candidate));
    }, guard);
  } catch (error) {
    if (expected !== undefined) {
      try {
        const current = await repository.readSnapshot(documentId);
        if (JSON.stringify(current) === expected) return current;
      } catch { /* Preserve the original failure when no complete intended commit is visible. */ }
    }
    throw error;
  }
}

export function restoreTranslationPlan(snapshot: DocumentSnapshot, taskId: string): TranslationPlan {
  const task = snapshot.tasks.find(item => item.id === taskId);
  const progress = task?.translation;
  const checkpoint = progress?.checkpoint;
  if (!task || !progress || !checkpoint) throw new StudioError('invalid_input');
  const track = snapshot.document.translationTracks.find(item => item.id === task.trackId);
  if (!track || track.revision !== checkpoint.trackRevision || documentSourceDigest(snapshot.document) !== checkpoint.sourceDigest) throw new StudioError('revision_conflict');
  const projected = projectTranslationUnits(snapshot.document);
  const cues = new Map(snapshot.document.cues.map(cue => [cue.id, cue]));
  const units = new Map(projected.map(unit => [unit.cueId, { ...unit, sourceHash: sourceDigest(cues.get(unit.cueId)!) }]));
  const memberships = checkpoint.batches.flatMap(batch => batch.cueIds);
  if (memberships.length !== projected.length || memberships.some((id, index) => id !== projected[index].cueId)
    || new Set(checkpoint.batches.map(batch => batch.id)).size !== checkpoint.batches.length) throw new StudioError('invalid_input');
  const batches = checkpoint.batches.map(batch => ({ ...batch, units: batch.cueIds.map(id => units.get(id)!) }));
  const completed = new Set(task.completedBatchIds);
  if (task.completedBatchIds.some((id, index) => id !== batches[index]?.id)) throw new StudioError('invalid_input');
  for (const batch of batches) {
    if (requestTokenEstimate(buildTranslationRequest(progress.config, batch)) > batch.estimatedInputTokens || batch.estimatedInputTokens + progress.config.maxOutputTokens > progress.config.contextWindow) throw new StudioError('limit_exceeded');
    for (const unit of batch.units) {
      const entry = track.entries[unit.cueId];
      if (completed.has(batch.id) ? !entry || entry.sourceRevision !== unit.sourceRevision || entry.sourceHash !== unit.sourceHash : !!entry) throw new StudioError('revision_conflict');
    }
  }
  return { config: progress.config, documentId: snapshot.document.id, revision: snapshot.document.revision, batches };
}

/** FIFO slots represent physical supplier requests and remain occupied until they settle. */
export class TranslationScheduler {
  private active = 0;
  private queue: { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }[] = [];
  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new StudioError('invalid_input');
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new StudioError('interrupted'));
    if (this.queue.length >= 10000) return Promise.reject(new StudioError('limit_exceeded'));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        signal.removeEventListener('abort', entry.abort);
        reject(new StudioError('interrupted'));
      } };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()!;
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.reject(new StudioError('interrupted')); continue; }
      this.active++;
      let released = false;
      entry.resolve(() => { if (!released) { released = true; this.active--; this.drain(); } });
    }
  }
}

export const translationScheduler = new TranslationScheduler();
