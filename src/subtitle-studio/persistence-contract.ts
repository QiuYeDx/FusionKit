import { z } from 'zod';
import { documentSchema, idSchema, LIMITS, StudioError, validateDocument } from './domain';
import { translationProgressSchema } from './translation-contract';
import { automaticTranslationIntentSchema } from './automatic-translation-contract';

export const taskCheckpointSchema = z.object({
  id: idSchema, generation: z.number().int().positive().safe(), trackId: idSchema,
  status: z.enum(['queued', 'running', 'interrupted', 'needs_configuration', 'completed', 'failed', 'cancelled']),
  completedBatchIds: z.array(z.string().min(1).max(100)).max(100000),
  uncertainBatchIds: z.array(z.string().min(1).max(100)).max(100000),
  attempts: z.number().int().nonnegative().safe(),
  translation: translationProgressSchema.optional(),
}).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal(1), document: documentSchema, tasks: z.array(taskCheckpointSchema).max(1000),
  automaticTranslation: automaticTranslationIntentSchema.optional() }).strict();
export type DocumentSnapshot = z.infer<typeof snapshotSchema>;

export function validateSnapshot(value: unknown): DocumentSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) throw new StudioError('invalid_input');
  const snapshot = result.data;
  validateDocument(snapshot.document);
  if (snapshot.automaticTranslation) {
    if (snapshot.document.schemaVersion !== 2) throw new StudioError('invalid_input');
    if (snapshot.automaticTranslation.state === 'admitted' && !snapshot.tasks.some(task => task.id === snapshot.automaticTranslation!.translationTaskId && task.translation)) throw new StudioError('invalid_input');
  }
  const tracks = new Set(snapshot.document.translationTracks.map(track => track.id));
  if (new Set(snapshot.tasks.map(task => task.id)).size !== snapshot.tasks.length) throw new StudioError('invalid_input');
  for (const task of snapshot.tasks) {
    const completed = new Set(task.completedBatchIds);
    if (!tracks.has(task.trackId) || completed.size !== task.completedBatchIds.length || new Set(task.uncertainBatchIds).size !== task.uncertainBatchIds.length || task.uncertainBatchIds.some(id => completed.has(id))) throw new StudioError('invalid_input');
    const progress = task.translation;
    const checkpoint = progress?.checkpoint;
    if (progress?.inFlightBatchId && (!checkpoint || completed.has(progress.inFlightBatchId))) throw new StudioError('invalid_input');
    if (checkpoint) {
      const ids = new Set(checkpoint.batches.map(batch => batch.id));
      const cueIds = checkpoint.batches.flatMap(batch => batch.cueIds);
      if (ids.size !== checkpoint.batches.length || cueIds.length > LIMITS.cues || new Set(cueIds).size !== cueIds.length
        || progress.totalBatches !== checkpoint.batches.length
        || task.completedBatchIds.some((id, index) => id !== checkpoint.batches[index]?.id)
        || task.uncertainBatchIds.some(id => !ids.has(id))
        || (progress.inFlightBatchId && !ids.has(progress.inFlightBatchId))
        || (task.status === 'completed' && completed.size !== checkpoint.batches.length)) throw new StudioError('invalid_input');
    }
  }
  return snapshot;
}
