import { z } from 'zod';
import { documentSchema, idSchema, StudioError, validateDocument } from './domain';
import { translationProgressSchema } from './translation-contract';

export const taskCheckpointSchema = z.object({
  id: idSchema, generation: z.number().int().positive().safe(), trackId: idSchema,
  status: z.enum(['queued', 'running', 'interrupted', 'needs_configuration', 'completed', 'failed', 'cancelled']),
  completedBatchIds: z.array(z.string().min(1).max(100)).max(100000),
  uncertainBatchIds: z.array(z.string().min(1).max(100)).max(100000),
  attempts: z.number().int().nonnegative().safe(),
  translation: translationProgressSchema.optional(),
}).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal(1), document: documentSchema, tasks: z.array(taskCheckpointSchema).max(1000) }).strict();
export type DocumentSnapshot = z.infer<typeof snapshotSchema>;

export function validateSnapshot(value: unknown): DocumentSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) throw new StudioError('invalid_input');
  const snapshot = result.data;
  validateDocument(snapshot.document);
  const tracks = new Set(snapshot.document.translationTracks.map(track => track.id));
  if (new Set(snapshot.tasks.map(task => task.id)).size !== snapshot.tasks.length) throw new StudioError('invalid_input');
  for (const task of snapshot.tasks) {
    const completed = new Set(task.completedBatchIds);
    if (!tracks.has(task.trackId) || completed.size !== task.completedBatchIds.length || new Set(task.uncertainBatchIds).size !== task.uncertainBatchIds.length || task.uncertainBatchIds.some(id => completed.has(id))) throw new StudioError('invalid_input');
  }
  return snapshot;
}
