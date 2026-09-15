import { z } from 'zod';
import { StudioError } from '../../../src/subtitle-studio/domain';
import { validateExecutionRecord, type ExecutionRecord } from '../../../src/subtitle-studio/execution-record-contract';
import type { ExecutionRecordPage } from '../../../src/subtitle-studio/execution-view-contract';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import { compiledKnowledgeSchema, knowledgeResourceReferences } from '../../../src/translation-knowledge/snapshot-contract';
import { validateExecutionRecordBatch } from './execution-records';

// This version describes the persisted request payload, not the current prompt builder.
const payloadSchema = z.object({
  targetLanguage: z.string(), translationRequirements: z.string(),
  context: z.object({ precedingSource: z.array(z.string()), followingSource: z.array(z.string()), priorModelTranslations: z.array(z.string()) }).strict(),
  items: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
  translationKnowledge: z.object({ background: z.string(), items: z.array(z.object({
    kind: z.enum(['context', 'term', 'expression', 'memory', 'rule']), required: z.boolean(),
    payload: compiledKnowledgeSchema.shape.items.element.shape.payload,
    applicableItemIds: z.array(z.string()), condition: z.string().optional(),
  }).strict()) }).strict().optional(),
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
    validateExecutionRecordBatch(record, batch.id);
    const saved = record.requests[batch.id];
    const cueNumbers = new Map(record.plan.batches.flatMap(batch => batch.units).map((unit, index) => [unit.cueId, index + 1]));
    const payload = saved ? payloadSchema.parse(JSON.parse(saved.request.messages.find(message => message.role === 'user')!.content)) : null;
    return {
      state: 'available', recordId: record.id, createdAt: record.createdAt, config: record.plan.config,
      policyVersion: record.policyVersion, totalBatches: record.plan.batches.length,
      preparedBatches: Object.keys(record.requests).length, batchOffset,
      ...(record.knowledge ? { knowledge: {
        digest: record.knowledge.digest, generation: record.knowledge.generation,
        resourceCount: knowledgeResourceReferences(record.knowledge).length,
        ...(record.knowledge.selection.recipeId ? { recipeName: record.knowledge.data.recipes.find(item => item.id === record.knowledge!.selection.recipeId)?.name } : {}),
        collections: record.knowledge.data.collections.map(item => item.name),
        documentTopics: record.knowledge.documentTopicIds.map(id => record.knowledge!.data.subjects.find(item => item.id === id)!.name),
        compiled: record.knowledge.batches[batch.id],
        cues: batch.units.map(unit => ({ cueId: unit.cueId, number: cueNumbers.get(unit.cueId)!, text: unit.text.replace(/<\/?m[1-9]\d{0,2}>/g, '') })),
        entries: record.knowledge.data.entries.filter(entry => record.knowledge!.batches[batch.id].items.some(item => item.entryId === entry.id)
          || record.knowledge!.batches[batch.id].issues.some(issue => issue.entryIds.includes(entry.id))),
      } } : {}),
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
