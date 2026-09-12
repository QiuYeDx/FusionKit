/** Test-only native boundary. Production main, IPC, preload and repository stay real. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentRepository } from '../../../electron/main/subtitle-studio/document-repository';
import { transcriptToDocument } from '../../../electron/main/subtitle-studio/transcription/document-adapter';
import type { LocalSubtitleOwnerKey } from '../../../electron/main/subtitle-studio/transcription/native/authorizations';
import type { EnqueueTranscriptionRequest, TranscriptionTaskSummary } from '../../../src/subtitle-studio/transcription/task-contract';
import { localSubtitleManagedResourceListSchema, localSubtitleResourceJobSummarySchema } from '../../../src/subtitle-studio/transcription/ipc-contract';

type Owner = LocalSubtitleOwnerKey;
type Task = { owner: string; value: TranscriptionTaskSummary };
type Job = { owner: string; value: ReturnType<typeof localSubtitleResourceJobSummarySchema.parse> };
type Command = { operation: 'snapshot' } | { operation: 'resources-ready' } | { operation: 'probe-recovered' }
  | { operation: 'revoke-failures'; count: number }
  | { operation: 'resource-complete'; resourceId: string }
  | { operation: 'task-state'; taskId: string; status: 'preparing_media' | 'loading_model' | 'transcribing' | 'post_processing' | 'failed'; progress?: number; cleanupPending?: true }
  | { operation: 'complete'; taskId: string }
  | { operation: 'seed-newer-documents' };

export function createTranscriptionRuntime(_options: unknown, _dependencies: unknown, repository?: DocumentRepository) {
  if (!repository) throw new Error('The UI fixture requires the production document repository.');
  const resources = localSubtitleManagedResourceListSchema.parse([
    { resourceId: 'large-v3-q5_0', resourceType: 'model', displayName: 'Large v3 · Q5', status: 'not_installed',
      modelFormat: 'ggml', quantization: 'q5_0', byteSize: 1081140203, isDefault: true, compatibleBackends: ['cpu', 'cuda'] },
    { resourceId: 'large-v3', resourceType: 'model', displayName: 'Large v3 · Full precision', status: 'not_installed',
      modelFormat: 'ggml', quantization: 'f16', byteSize: 3095033483, isDefault: false, compatibleBackends: ['cpu', 'cuda'] },
    { resourceId: 'silero-vad-v6.2.0-ggml', resourceType: 'vad', displayName: 'Silero VAD', status: 'not_installed',
      byteSize: 1048576, isDefault: true, compatibleBackends: ['cpu'] },
    { resourceId: 'whisper-cuda-win32-x64', resourceType: 'accelerator', displayName: 'CUDA · Windows', status: 'not_installed',
      byteSize: 536870912, isDefault: false, compatibleBackends: ['cuda'] },
  ]);
  const tokens = new Map<string, { owner: string; displayName: string; sourceKey: string }>();
  const tasks: Task[] = [], jobs: Job[] = [], traces: Array<{ operation: string; detail?: unknown }> = [];
  const released = new Set<string>();
  let recoveredProbe = false, revokeFailures = 0;
  const key = (owner: Owner) => `${owner.webContentsId}:${owner.ownerSessionId}`;
  const trace = (operation: string, detail?: unknown) => { traces.push({ operation, detail }); if (traces.length > 200) traces.shift(); };
  const check = (owner: Owner) => { if (released.has(key(owner))) throw Object.assign(new Error('Released owner'), { code: 'owner_released' }); return key(owner); };
  const getTask = (id: string) => { const task = tasks.find(item => item.value.taskId === id); if (!task) throw new Error(`Unknown fixture task ${id}`); return task; };
  const active = (status: string) => !['completed', 'cancelled', 'failed'].includes(status);
  const startResource = (owner: Owner, resourceId: string) => {
    const resource = resources.find(item => item.resourceId === resourceId);
    if (!resource) throw Object.assign(new Error('Unknown resource'), { code: 'resource_not_allowed' });
    resource.status = 'installing';
    const now = new Date().toISOString();
    const value = localSubtitleResourceJobSummarySchema.parse({ jobId: randomUUID(), resourceId, resourceType: resource.resourceType,
      status: 'acquiring', progress: 24, bytesCompleted: 24, bytesTotal: 100, createdAt: now, updatedAt: now });
    jobs.push({ owner: check(owner), value });
    return structuredClone(value);
  };
  const control = async (command: Command) => {
    if (command.operation === 'resources-ready') resources.forEach(resource => { resource.status = 'ready'; });
    if (command.operation === 'probe-recovered') recoveredProbe = true;
    if (command.operation === 'revoke-failures') revokeFailures = command.count;
    if (command.operation === 'resource-complete') {
      const resource = resources.find(item => item.resourceId === command.resourceId);
      if (!resource) throw new Error('Unknown fixture resource');
      resource.status = 'ready';
      for (const job of jobs.filter(job => job.value.resourceId === command.resourceId && active(job.value.status))) {
        job.value = { ...job.value, status: 'completed', progress: 100, bytesCompleted: 100, updatedAt: new Date().toISOString() };
      }
    }
    if (command.operation === 'task-state') {
      const task = getTask(command.taskId);
      task.value = { ...task.value, status: command.status, progress: command.progress ?? 37, updatedAt: new Date().toISOString(),
        ...(command.status === 'failed' ? { error: { code: 'runtime_protocol_mismatch' as const } } : {}),
        ...(command.cleanupPending ? { cleanupPending: true } : {}) };
    }
    if (command.operation === 'complete') {
      const task = getTask(command.taskId);
      const document = transcriptToDocument({ schemaVersion: 1, source: { displayName: task.value.displayName, durationMs: 315000 },
        model: { engine: 'whisper_cpp', modelId: task.value.modelId, modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en',
        segments: Array.from({ length: 105 }, (_, index) => ({ id: `segment-${index}`, startMs: index * 3000, endMs: index * 3000 + 2000,
          text: index === 2 ? 'A detailed interview keeps the full original words, punctuation, pauses, and context in the stored document.' : `Recorded interview sentence ${index + 1}.` })) });
      await repository.create(document);
      task.value = { ...task.value, status: 'completed', progress: 100, documentId: document.id, documentDurability: 'confirmed', updatedAt: new Date().toISOString() };
      trace('document-created', { documentId: document.id });
    }
    if (command.operation === 'seed-newer-documents') {
      for (let index = 0; index < 21; index++) await repository.create(transcriptToDocument({ schemaVersion: 1,
        source: { displayName: `Newer recording ${index}.wav`, durationMs: 3000 },
        model: { engine: 'whisper_cpp', modelId: 'large-v3-q5_0', modelHash: 'a'.repeat(64), backend: 'cpu' },
        segments: [{ id: 'newer-segment', startMs: 0, endMs: 1000, text: 'A newer document places the completed result beyond the first library page.' }] }));
      trace('seed-newer-documents', { count: 21 });
    }
    return structuredClone({ resources, jobs: jobs.map(job => job.value), tasks: tasks.map(task => task.value), traces, tokenCount: tokens.size });
  };
  (globalThis as unknown as { __studioT06Control: typeof control }).__studioT06Control = control;
  return {
    async initialize() { trace('initialize'); },
    async shutdown() { trace('shutdown'); tokens.clear(); tasks.length = 0; },
    async releaseOwner(owner: Owner) { trace('release-owner'); released.add(key(owner));
      for (const [id, media] of tokens) if (media.owner === key(owner)) tokens.delete(id);
      for (let index = tasks.length - 1; index >= 0; index--) if (tasks[index].owner === key(owner)) tasks.splice(index, 1);
    },
    async inspectRuntime() { trace('inspect-runtime'); return { status: 'verified', runtimeGeneration: 'a'.repeat(64), target: { platform: 'win32', arch: 'x64' } }; },
    media: {
      async authorizeInput(owner: Owner, filePath: string) {
        const fileToken = randomUUID(), sourceKey = randomUUID(), displayName = path.basename(filePath);
        tokens.set(fileToken, { owner: check(owner), displayName, sourceKey }); trace('authorize-media', { displayName });
        return { fileToken, sourceKey, displayName, byteSize: 64000, expiresAt: Date.now() + 600000 };
      },
      async probe(owner: Owner, fileToken: string) {
        const media = tokens.get(fileToken);
        if (!media || media.owner !== check(owner)) throw Object.assign(new Error('Unknown token'), { code: 'invalid_token' });
        trace('probe-media', { displayName: media.displayName });
        if (media.displayName.startsWith('probe-retry') && !recoveredProbe) throw Object.assign(new Error('Fixture probe failure'), { code: 'unsupported_media' });
        return { fileToken, displayName: media.displayName, durationMs: 315000, autoSelectedStreamId: 'audio-0',
          audioTracks: [{ streamId: 'audio-0', ordinal: 1, isDefault: true, language: 'en', title: 'Original interview', codec: 'pcm_s16le', channels: 2, sampleRateHz: 48000 },
            { streamId: 'audio-1', ordinal: 2, isDefault: false, language: 'ja', title: '通訳音声 · interpretation', codec: 'aac', channels: 2, sampleRateHz: 48000 }] };
      },
      async revokeInput(owner: Owner, fileToken: string) {
        check(owner); trace('revoke-media');
        if (revokeFailures-- > 0) throw Object.assign(new Error('Fixture revoke retry'), { code: 'transcription_failed' });
        return tokens.get(fileToken)?.owner === key(owner) && tokens.delete(fileToken);
      },
    },
    resources: {
      async list(owner: Owner) { check(owner); trace('list-resources'); return structuredClone(resources); },
      snapshot(owner: Owner) { return { resourceJobs: structuredClone(jobs.filter(job => job.owner === check(owner)).map(job => job.value)) }; },
      async importModel(input: { owner: Owner; modelId: string; filePath: string }) { trace('import-model', { modelId: input.modelId }); return startResource(input.owner, input.modelId); },
      async install(owner: Owner, resourceId: string) { trace('install-resource', { resourceId }); return startResource(owner, resourceId); },
      async cancel(owner: Owner, jobId: string) {
        const job = jobs.find(job => job.owner === check(owner) && job.value.jobId === jobId);
        if (!job) return false;
        job.value = { ...job.value, status: 'cancelled', updatedAt: new Date().toISOString() };
        resources.find(resource => resource.resourceId === job.value.resourceId)!.status = 'not_installed'; trace('cancel-resource'); return true;
      },
      async waitForIdle() {},
    },
    tasks: {
      async enqueue(owner: Owner, request: EnqueueTranscriptionRequest) {
        const batchId = randomUUID(), now = new Date().toISOString();
        const created = request.files.map(file => {
          const media = tokens.get(file.fileToken);
          if (!media || media.owner !== check(owner)) throw Object.assign(new Error('Unknown token'), { code: 'invalid_token' });
          const value: TranscriptionTaskSummary = { taskId: randomUUID(), batchId, generation: 1, displayName: media.displayName,
            status: 'queued', progress: 0, createdAt: now, updatedAt: now, modelId: request.config.modelId, resolvedBackend: 'cpu', durationMs: 315000 };
          tasks.push({ owner: check(owner), value }); return value;
        });
        trace('enqueue', structuredClone(request)); return structuredClone({ batchId, tasks: created });
      },
      async list(owner: Owner) { check(owner); trace('list-tasks'); return structuredClone(tasks.filter(task => task.owner === key(owner)).map(task => task.value)); },
      async cancel(owner: Owner, taskId: string) {
        const task = getTask(taskId);
        if (task.owner !== check(owner)) throw Object.assign(new Error('Wrong owner'), { code: 'owner_released' });
        task.value = { ...task.value, status: 'cancelled', updatedAt: new Date().toISOString() }; trace('cancel-task', { taskId }); return structuredClone(task.value);
      },
      async remove(owner: Owner, taskId: string) { const index = tasks.findIndex(task => task.owner === check(owner) && task.value.taskId === taskId); if (index >= 0) tasks.splice(index, 1); trace('remove-task'); },
      async waitForIdle() {},
    },
  };
}
