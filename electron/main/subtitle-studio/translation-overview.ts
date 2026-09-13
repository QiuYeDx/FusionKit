import type { z } from 'zod';
import type { DocumentRepository } from './document-repository';
import type { requestSchemas, TranslationTasksSnapshot, TranslationTaskStatus, TranslationTaskSummary } from '../../../src/subtitle-studio/ipc-contract';

const priority: Record<TranslationTaskStatus, number> = { running: 0, queued: 1, needs_configuration: 2, failed: 3, interrupted: 4, completed: 5, cancelled: 6 };

/** Aggregate before pagination; no content, provider credentials or recovery data cross IPC. */
export function selectTranslationTasks(snapshot: Awaited<ReturnType<DocumentRepository['listSnapshot']>>, request: z.infer<typeof requestSchemas.listTranslationTasks>): TranslationTasksSnapshot {
  const requested = request.taskIds ? new Set(request.taskIds) : undefined;
  const counts: TranslationTasksSnapshot['counts'] = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, needs_configuration: 0 };
  const items: TranslationTaskSummary[] = [];
  const usage: TranslationTasksSnapshot['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
    unknownInput: 0, unknownOutput: 0, unknownTotal: 0 };
  let completedBatches = 0; let totalBatches = 0;
  for (const { snapshot: { document, tasks } } of snapshot.records) {
    const hasActive = tasks.some(task => task.status === 'queued' || task.status === 'running');
    for (const task of tasks) {
      if (requested && !requested.has(task.id)) continue;
      const progress = task.translation;
      for (const [field, missing] of [['inputTokens', 'unknownInput'], ['outputTokens', 'unknownOutput'], ['totalTokens', 'unknownTotal']] as const) {
        const value = progress?.usage[field];
        if (value == null || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(usage[field] + value)) usage[missing]++;
        else usage[field] += value;
      }
      const total = progress?.totalBatches ?? task.completedBatchIds.length;
      const completed = Math.min(task.completedBatchIds.length, total);
      counts[task.status]++; totalBatches += total; completedBatches += completed;
      items.push({ documentId: document.id, revision: document.revision, taskId: task.id, trackId: task.trackId,
        displayName: document.origin.displayName, status: task.status,
        language: progress?.config.language ?? document.translationTracks.find(track => track.id === task.trackId)?.language ?? '',
        modelKey: progress?.config.model.modelKey ?? '', completedBatches: completed, totalBatches: total,
        ...(progress?.notBefore !== undefined ? { notBefore: progress.notBefore } : {}),
        canResume: Boolean(progress?.checkpoint) && !hasActive && ['failed', 'interrupted', 'needs_configuration'].includes(task.status),
        ...(progress?.error ? { error: progress.error } : {}) });
    }
  }
  items.sort((a, b) => priority[a.status] - priority[b.status] || a.documentId.localeCompare(b.documentId) || a.taskId.localeCompare(b.taskId));
  return { sequence: snapshot.sequence, total: items.length, unavailableDocuments: snapshot.unavailableDocuments,
    counts, completedBatches, totalBatches, usage, items: items.slice(request.offset, request.offset + request.pageSize) };
}
