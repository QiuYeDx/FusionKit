import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DocumentRepository, type CommitStage } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionDocumentSink } from '../../electron/main/subtitle-studio/transcription/document-sink';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { createAutomaticTranslationCoordinator } from '../../electron/main/subtitle-studio/automatic-translation';
import { BilingualService } from '../../electron/main/subtitle-studio/bilingual-service';
import { automaticTranslationIntentSchema } from '../../src/subtitle-studio/automatic-translation-contract';
import { validateSnapshot } from '../../src/subtitle-studio/persistence-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';

const config: TranslationConfig = { model: { profileId: 'profile', modelKey: 'deepseek-chat', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions', thinkingEnabled: true }, language: 'ja', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 32 };
const transcript = { schemaVersion: 1, source: { displayName: 'synthetic.wav', durationMs: 4000 }, model: { engine: 'whisper_cpp', modelId: 'base', modelHash: 'a'.repeat(64), backend: 'cpu' }, segments: [{ id: 'one', startMs: 100, endMs: 1500, text: 'Hello world.' }] };
const reply = async (request: ModelRuntimeTextRequest): Promise<ModelRuntimeTextResult> => ({ apiFormat: request.model.apiFormat, content: JSON.stringify({ items: JSON.parse(request.messages[1].content).items.map((item: { id: string; text: string }) => ({ ...item, text: `Translated ${item.text}` })) }), finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(options: { automatic?: boolean; fault?: (stage: CommitStage) => void; send?: typeof reply } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-auto-'));
  const repository = new DocumentRepository(root, { fault: options.fault });
  const send = vi.fn(options.send ?? reply), translation = new TranslationService(repository, send);
  const coordinator = createAutomaticTranslationCoordinator({ repository, translation });
  const taskId = randomUUID(), intent = { intentId: randomUUID(), sourceTaskId: taskId, generation: 1 as const, state: 'pending' as const, config: structuredClone(config) };
  const sink = createTranscriptionDocumentSink({ repository, owner: { webContentsId: 21, ownerSessionId: 'owner' }, taskId, generation: 1, assertActive: () => {}, ...(options.automatic === false ? {} : { automaticTranslation: intent }) });
  cleanups.push(async () => { await coordinator.shutdown(); await translation.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, repository, send, translation, coordinator, sink, intent };
}
async function diskText(root: string): Promise<string> { return (await Promise.all((await readdir(root, { withFileTypes: true })).map(entry => entry.isDirectory() ? diskText(path.join(root, entry.name)) : readFile(path.join(root, entry.name), 'utf8')))).join('\n'); }

it('leaves default-off publication without intent, task or provider request', async () => {
  const f = await fixture({ automatic: false }); await f.sink.publish(transcript); await f.coordinator.initialize();
  const value = await f.repository.readSnapshot(f.sink.documentId);
  expect(value.automaticTranslation).toBeUndefined(); expect(value.tasks).toEqual([]); expect(f.send).not.toHaveBeenCalled();
});
it('publishes document and intent atomically, preserving one identity after failure and replay', async () => {
  let fail = true; const f = await fixture({ fault: stage => { if (fail && stage === 'current-publish') throw new Error('controlled publication fault'); } });
  await expect(f.sink.publish(transcript)).rejects.toThrow(); expect(await f.repository.list()).toEqual([]);
  fail = false; await f.sink.publish(transcript); await f.sink.publish(transcript);
  const value = await f.repository.readSnapshot(f.sink.documentId);
  expect(value.automaticTranslation).toEqual(f.intent); expect(await f.repository.list()).toHaveLength(1);
  expect(automaticTranslationIntentSchema.safeParse({ ...f.intent, apiKey: 'forbidden' }).success).toBe(false);
  expect(() => validateSnapshot({ ...value, automaticTranslation: { ...f.intent, state: 'admitted', translationTaskId: randomUUID() } })).toThrow();
});
it('initializes a just-published intent then starts the same logical task exactly once and never persists its key', async () => {
  const f = await fixture(); await f.sink.publish(transcript);
  const first = f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'secret-do-not-persist');
  expect(f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'secret-do-not-persist')).toBe(first);
  const result = await first; await f.translation.settled(result.taskId);
  expect(await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'other-key')).toEqual(result);
  const value = await f.repository.readSnapshot(f.sink.documentId);
  expect(value.tasks).toHaveLength(1); expect(value.tasks[0].status).toBe('completed'); expect(value.document.translationTracks).toHaveLength(1);
  expect(value.tasks[0].translation?.config.model.thinkingEnabled).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(1); expect(await diskText(f.root)).not.toContain('secret-do-not-persist');
});
it('recovers pending intent after restart as visible needs_configuration with checkpoint and normal resume', async () => {
  const f = await fixture(); await f.sink.publish(transcript); await f.translation.initialize();
  let value = await f.repository.readSnapshot(f.sink.documentId), task = value.tasks[0];
  expect(task.status).toBe('needs_configuration'); expect(task.translation?.checkpoint).toBeDefined(); expect(f.send).not.toHaveBeenCalled();
  expect(value.automaticTranslation).toMatchObject({ state: 'admitted', translationTaskId: task.id });
  const resumed = await f.translation.resume(value.document.id, value.document.revision, task.id, task.translation!.config.model, 'key');
  expect(resumed.taskId).toBe(task.id); await f.translation.settled(task.id);
  value = await f.repository.readSnapshot(f.sink.documentId); expect(value.tasks[0].status).toBe('completed');
});
it('preserves a committed document and linked admission across uncertain directory sync', async () => {
  let fail = true; const f = await fixture({ fault: stage => { if (fail && stage === 'current-directory-sync') throw new Error('controlled sync fault'); } });
  expect(await f.sink.publish(transcript)).toMatchObject({ status: 'committed', durability: 'uncertain' });
  fail = false; const result = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key'); await f.translation.settled(result.taskId);
  expect((await f.repository.readSnapshot(f.sink.documentId)).tasks).toHaveLength(1);
});
it('makes impossible frozen planning visible without discarding the source document', async () => {
  const f = await fixture(); f.intent.config.contextWindow = 2048; f.intent.config.maxOutputTokens = 2047;
  const taskId = f.intent.sourceTaskId;
  const sink = createTranscriptionDocumentSink({ repository: f.repository, owner: { webContentsId: 21, ownerSessionId: 'owner' }, taskId, generation: 1, assertActive: () => {}, automaticTranslation: f.intent });
  await sink.publish(transcript); await f.translation.initialize();
  const value = await f.repository.readSnapshot(sink.documentId);
  expect(value.document.cues).toHaveLength(1); expect(value.tasks[0].status).toBe('failed'); expect(value.tasks[0].translation?.checkpoint).toBeUndefined(); expect(f.send).not.toHaveBeenCalled();
});
it.each(['task', 'track', 'document'] as const)('does not resurrect automatic translation after removing its %s', async removal => {
  const f = await fixture(); await f.sink.publish(transcript); const admitted = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key'); await f.translation.settled(admitted.taskId);
  const value = await f.repository.readSnapshot(f.sink.documentId), task = value.tasks[0];
  if (removal === 'task') await f.repository.removeTask(value.document.id, value.document.revision, task.id);
  else if (removal === 'track') await new BilingualService(f.repository).removeTrack(value.document.id, value.document.revision, task.trackId);
  else await f.repository.delete(value.document.id, value.document.revision);
  await expect(f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key')).rejects.toBeDefined();
  if (removal !== 'document') { const current = await f.repository.readSnapshot(f.sink.documentId); expect(current.tasks).toEqual([]); expect(current.automaticTranslation?.state).toBe('cancelled'); }
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('never replays a failed provider attempt automatically', async () => {
  const f = await fixture({ send: async () => { throw new Error('controlled provider failure'); } }); await f.sink.publish(transcript);
  const task = await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key'); await f.translation.settled(task.taskId);
  const calls = f.send.mock.calls.length;
  expect((await f.repository.readSnapshot(f.sink.documentId)).tasks[0].status).toBe('failed');
  expect(await f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key')).toEqual(task); expect(f.send).toHaveBeenCalledTimes(calls);
});
it('fences a handoff synchronously during shutdown without issuing a request', async () => {
  const f = await fixture(); await f.sink.publish(transcript);
  const operation = f.coordinator.handoff(f.sink.documentId, f.intent.intentId, 'key');
  const rejected = expect(operation).rejects.toMatchObject({ code: 'interrupted' }); await f.coordinator.shutdown(); await rejected;
  expect(f.send).not.toHaveBeenCalled(); expect((await f.repository.readSnapshot(f.sink.documentId)).automaticTranslation?.state).toBe('pending');
});
