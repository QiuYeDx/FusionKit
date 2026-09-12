import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { selectTranslationTasks } from '../../electron/main/subtitle-studio/translation-overview';
import { requestSchemas, type TranslationTaskStatus } from '../../src/subtitle-studio/ipc-contract';
import type { DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';

function fixture() {
  const states: TranslationTaskStatus[] = ['completed', 'cancelled', 'failed', 'interrupted', 'needs_configuration', 'queued', 'running'];
  const records = states.map((status, index) => {
    const document = importSubtitleText('[00:01]PRIVATE SUBTITLE BODY\n', { format: 'lrc', displayName: `Document ${index}.lrc`, encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
    const task: DocumentSnapshot['tasks'][number] = { id: randomUUID(), trackId: randomUUID(), generation: 1, status, completedBatchIds: Array.from({ length: status === 'completed' ? 10 : 2 }, (_, i) => `b${i}`), uncertainBatchIds: [], attempts: 1,
      translation: { config: { model: { profileId: 'PRIVATE PROFILE', modelKey: 'Visible model', endpoint: 'https://private.example/v1', apiFormat: 'chat_completions' }, language: 'zh', instructions: 'PRIVATE INSTRUCTIONS', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 2 }, totalBatches: 10, estimatedInputTokens: 100, outputTokenReserve: 100, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        checkpoint: { version: 1, sourceDigest: 'a'.repeat(64), trackRevision: 1, batches: [] }, ...(status === 'queued' ? { notBefore: 99999999 } : {}), ...(status === 'failed' ? { error: 'translation_failed' as const } : {}) } };
    return { snapshot: { schemaVersion: 1 as const, document, tasks: [task] }, updatedAt: index };
  });
  return { records, documents: records.map(item => item.snapshot.document), unavailable: [], unavailableDocuments: 2, sequence: 19 };
}

describe('global translation overview', () => {
  it('aggregates all documents before paging and sends only the safe task projection', () => {
    const snapshot = fixture(); const result = selectTranslationTasks(snapshot, { offset: 0, pageSize: 2 });
    expect(result).toMatchObject({ sequence: 19, total: 7, unavailableDocuments: 2, counts: { completed: 1, cancelled: 1, failed: 1, interrupted: 1, needs_configuration: 1, queued: 1, running: 1 }, totalBatches: 70, completedBatches: 22 });
    expect(result.items.map(item => item.status)).toEqual(['running', 'queued']);
    expect(result.items[1].notBefore).toBe(99999999);
    const next = selectTranslationTasks(snapshot, { offset: 2, pageSize: 2 });
    expect(next.items.map(item => item.status)).toEqual(['needs_configuration', 'failed']);
    expect(next.items.every(item => item.canResume)).toBe(true);
    const content = JSON.stringify({ result, next });
    for (const secret of ['PRIVATE', 'private.example', 'checkpoint', 'cueIds', 'sourceDigest', 'instructions', 'profileId']) expect(content).not.toContain(secret);
  });
  it('computes the latest cohort separately so history cannot inflate progress', () => {
    const snapshot = fixture(); const taskIds = snapshot.records.slice(-2).map(item => item.snapshot.tasks[0].id);
    const result = selectTranslationTasks(snapshot, { offset: 0, pageSize: 1, taskIds });
    expect(result).toMatchObject({ total: 2, totalBatches: 20, completedBatches: 4, counts: { completed: 0, queued: 1, running: 1 } });
    expect(selectTranslationTasks(snapshot, { offset: 0, pageSize: 10, taskIds: [] })).toMatchObject({ total: 0, totalBatches: 0, completedBatches: 0, items: [] });
    snapshot.records[0].snapshot.tasks.push({ ...snapshot.records[2].snapshot.tasks[0], id: randomUUID(), status: 'running' });
    snapshot.records[0].snapshot.tasks[0].status = 'interrupted';
    expect(selectTranslationTasks(snapshot, { offset: 0, pageSize: 100 }).items.find(item => item.taskId === snapshot.records[0].snapshot.tasks[0].id)?.canResume).toBe(false);
  });
  it('bounds the summary query and rejects raw paths and duplicate task identifiers', () => {
    const id = randomUUID();
    for (const request of [{ offset: -1, pageSize: 20 }, { offset: 0, pageSize: 101 }, { offset: 0, pageSize: 20, taskIds: [id, id] }, { offset: 0, pageSize: 20, documentPath: 'C:\\private' }, { offset: 0, pageSize: 20, taskIds: Array(101).fill(id) }]) expect(requestSchemas.listTranslationTasks.safeParse(request).success).toBe(false);
  });
});
