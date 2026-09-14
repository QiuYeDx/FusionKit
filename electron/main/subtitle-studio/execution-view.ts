import { z } from 'zod';
import { StudioError } from '../../../src/subtitle-studio/domain';
import { validateExecutionRecord, type ExecutionRecord } from '../../../src/subtitle-studio/execution-record-contract';
import type { ExecutionRecordPage } from '../../../src/subtitle-studio/execution-view-contract';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';

// This version describes the persisted request payload, not the current prompt builder.
const payloadSchema = z.object({
  targetLanguage: z.string(), translationRequirements: z.string(),
  context: z.object({ precedingSource: z.array(z.string()), followingSource: z.array(z.string()), priorModelTranslations: z.array(z.string()) }).strict(),
  items: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
}).strict();

export function readExecutionRecordPage(snapshot: DocumentSnapshot, trackId: string, batchOffset: number): ExecutionRecordPage {
  const track = snapshot.document.translationTracks.find(item => item.id === trackId);
  if (!track) throw new StudioError('revision_conflict');
  if (!track.executionRef) return { state: 'legacy' };
  let record: ExecutionRecord;
  try {
    record = validateExecutionRecord(snapshot.executionRecords?.[track.executionRef.id], {
      ref: track.executionRef, documentId: snapshot.document.id, trackId,
    });
  } catch { return { state: 'unavailable' }; }
  const batch = record.plan.batches[batchOffset];
  if (!batch) throw new StudioError('invalid_input');
  try {
    const saved = record.requests[batch.id];
    const payload = saved ? payloadSchema.parse(JSON.parse(saved.request.messages.find(message => message.role === 'user')!.content)) : null;
    return {
      state: 'available', recordId: record.id, createdAt: record.createdAt, config: record.plan.config,
      policyVersion: record.policyVersion, totalBatches: record.plan.batches.length,
      preparedBatches: Object.keys(record.requests).length, batchOffset,
      batch: {
        id: batch.id, items: payload?.items ?? batch.units.map(({ id, text }) => ({ id, text })),
        before: payload?.context.precedingSource ?? batch.before, after: payload?.context.followingSource ?? batch.after,
        request: saved && payload ? { createdAt: saved.createdAt, priorModelTranslations: payload.context.priorModelTranslations, httpBody: saved.httpBody } : null,
      },
    };
  } catch {
    // Trace failures must not erase the retained document or present a reconstructed request.
    return { state: 'unavailable' };
  }
}
