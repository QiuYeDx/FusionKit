/**
 * Visual acceptance boundary: seed the production classic registry with validated
 * outcomes. IPC, preload, renderer subscriptions and registry transitions stay
 * real. Native execution and JobManager resource ownership are covered separately
 * by their unit tests; fixture-owned rows have no native leases or output files.
 */
import { randomUUID } from 'node:crypto';
import {
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION, LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError, type LocalSubtitleTaskSummary,
} from '../../../src/type/localSubtitle';
import type { LocalSubtitleOwnerKey } from '../../../electron/main/local-subtitle/authorizations';
import type { LocalSubtitleJobManager } from '../../../electron/main/local-subtitle/job-manager';
import type { LocalSubtitleSessionRegistry } from '../../../electron/main/local-subtitle/session-registry';

export function installClassicEmptyQueueControl(registry: LocalSubtitleSessionRegistry, manager: LocalSubtitleJobManager) {
  let owner: LocalSubtitleOwnerKey | undefined;
  const ownedTasks = new Set<string>();
  const originalSnapshot = registry.getSnapshot.bind(registry), originalRemove = manager.removeTask.bind(manager);
  registry.getSnapshot = current => { owner = current; return originalSnapshot(current); };
  manager.removeTask = (current, taskId) => {
    if (!ownedTasks.has(taskId)) return originalRemove(current, taskId);
    const removed = registry.removeTask(current, taskId, new Date().toISOString());
    if (removed) ownedTasks.delete(taskId);
    return { removed: Boolean(removed) };
  };
  const control = (command: { operation: 'seed' | 'snapshot' }) => {
    if (!owner) throw new Error('The classic page must attach its real IPC owner before seeding.');
    if (command.operation === 'seed') {
      const batchId = randomUUID(), now = new Date().toISOString();
      const tasks: LocalSubtitleTaskSummary[] = ['01-speech.wav', '02-silence-or-music.wav', '03-damaged-recording.wav'].map(displayName => ({
        taskId: randomUUID(), batchId, sourceKey: randomUUID(), generation: 1, displayName,
        status: 'queued', progress: { stage: 'queued', stageProgress: 0, overallProgress: 0 },
        model: { engine: 'whisper_cpp', engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
          engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit, modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
          modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id, modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256 },
        resolvedBackend: 'cpu', requestedFormats: ['SRT'], artifactResults: [],
        postAction: { mode: 'export_only', importStatus: 'not_requested', startStatus: 'not_requested' },
        createdAt: now, updatedAt: now,
      }));
      registry.addBatch(owner, { batchId, status: 'queued', config: {
        modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id, devicePreference: 'cpu', resolvedBackend: 'cpu',
        language: 'auto', taskMode: 'transcribe', vadEnabled: false, outputFormats: ['SRT'], outputMode: 'source',
        conflictPolicy: 'index', postActionMode: 'export_only',
      }, tasks, createdAt: now, updatedAt: now });
      for (const task of tasks) {
        ownedTasks.add(task.taskId);
        for (const status of ['preparing_media', 'loading_model', 'transcribing', 'post_processing'] as const) {
          registry.upsertTask(owner, { ...task, status, progress: { stage: status, stageProgress: 0, overallProgress: 0 } });
        }
        if (task.displayName.startsWith('01')) {
          registry.upsertTask(owner, { ...task, status: 'exporting', progress: { stage: 'exporting', stageProgress: 0, overallProgress: 0 } });
          const artifact = { format: 'SRT', status: 'committed', artifact: {
            artifactRef: randomUUID(), displayName: '01-speech.srt', format: 'SRT', expiresAt: Date.now() + 3600000,
          } } as const;
          registry.upsertTask(owner, { ...task, status: 'completed', artifactResults: [artifact],
            completion: { outcome: 'full', artifacts: [artifact], warnings: [] }, cueSummary: { cueCount: 1, exceedsTargetCount: 0 },
            progress: { stage: 'exporting', stageProgress: 100, overallProgress: 100 } });
        } else if (task.displayName.startsWith('02')) {
          registry.upsertTask(owner, { ...task, status: 'no_content',
            progress: { stage: 'post_processing', stageProgress: 100, overallProgress: 100 } });
        } else {
          registry.upsertTask(owner, { ...task, status: 'failed', progress: { stage: 'post_processing', stageProgress: 0, overallProgress: 0 },
            error: createLocalSubtitleError('media_decode_failed', 'Controlled decoder failure.') });
        }
      }
    }
    return originalSnapshot(owner);
  };
  (globalThis as unknown as { __classicEmptyQueueControl: typeof control }).__classicEmptyQueueControl = control;
}
