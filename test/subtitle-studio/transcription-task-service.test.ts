import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { createTranscriptionTaskService, type TranscriptionTaskServiceOptions } from '../../electron/main/subtitle-studio/transcription/task-service';
import { LocalSubtitleCapabilityLeaseCoordinator, LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry } from '../../electron/main/subtitle-studio/transcription/native/authorizations';
import { LocalSubtitleBackendResolver } from '../../electron/main/subtitle-studio/transcription/native/backend-resolver';
import { verifyLocalSubtitleRuntimeBundle } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import type { LocalSubtitleJobBatchRuntime } from '../../electron/main/subtitle-studio/transcription/native/job-manager';
import type { TranscriptionTaskExecutionContext, TranscriptExecutionResult } from '../../electron/main/subtitle-studio/transcription/transcript-executor';
import type { EnqueueTranscriptionRequest } from '../../src/subtitle-studio/transcription/task-contract';
import { createRuntimeFixture } from './transcription/runtimeFixture';
import { StudioError } from '../../src/subtitle-studio/domain';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { createAutomaticTranslationCoordinator } from '../../electron/main/subtitle-studio/automatic-translation';
import type { AutomaticTranslationRequest } from '../../src/subtitle-studio/automatic-translation-contract';
import { buildFrozenAutomaticKnowledge } from '../../src/translation-knowledge/automatic-snapshot-contract';
import { knowledgeFixture } from '../translation-knowledge/fixtures';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const ownerA = { webContentsId: 31, ownerSessionId: 'owner-a' };
const ownerB = { webContentsId: 32, ownerSessionId: 'owner-b' };
const config: EnqueueTranscriptionRequest['config'] = { modelId: 'test-model', devicePreference: 'cpu', language: 'en',
  taskMode: 'transcribe', vadEnabled: false, advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500,
    maxCueDurationMs: 7000, maxCueChars: 80, maxLineChars: 40 } };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const automaticRequest = (): AutomaticTranslationRequest => ({ config: { model: { profileId: 'profile', modelKey: 'model', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' }, language: 'ja', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 32 }, apiKey: 'private-task-key' });
async function eventually(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Condition did not occur.');
}

async function fixture() {
  const bundle = await createRuntimeFixture();
  const verified = await verifyLocalSubtitleRuntimeBundle({ environment: bundle.environment, scope: 'server', signatureVerifier: async () => true });
  const inputs = new LocalSubtitleInputAuthorizationRegistry();
  const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry();
  const leases = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs);
  const repository = new DocumentRepository(path.join(bundle.tempRoot, 'documents'));
  const model = { storage: 'managed' as const, id: config.modelId, absolutePath: path.join(bundle.tempRoot, 'model.bin'), byteSize: 42, sha256: 'a'.repeat(64) };
  const modelResolver = { resolveManagedModel: vi.fn(async () => model), resolveManagedVad: vi.fn(async () => { throw new Error('Unexpected VAD.'); }) };
  const backendResolver = new LocalSubtitleBackendResolver({ verifyServerRuntime: async () => verified });
  const media = { verifyRuntime: vi.fn(async () => ({ runtimeGeneration: verified.runtimeGeneration })),
    bindTaskMediaSelection: vi.fn(), releaseTaskMediaSelection: vi.fn() };
  const transcript = { schemaVersion: 1 as const, source: { displayName: 'speech.wav', durationMs: 5000 },
    model: { engine: 'whisper_cpp' as const, modelId: model.id, modelHash: model.sha256, backend: 'cpu' as const },
    segments: [{ id: 'segment-1', startMs: 0, endMs: 3000, text: 'Hello world.' }] };
  const executor = { beginBatchSlice: vi.fn(() => ({} as LocalSubtitleJobBatchRuntime)),
    execute: vi.fn(async (_context: TranscriptionTaskExecutionContext): Promise<TranscriptExecutionResult> => ({ status: 'transcript_ready',
      transcript, durationMs: 5000, cueSummary: { cueCount: 1, exceedsTargetCount: 0 } })), endBatchSlice: vi.fn() };
  const timers: { callback: () => void; cancelled: boolean }[] = [];
  const scheduleLeaseRenewal = vi.fn((callback: () => void) => { const timer = { callback, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; });
  const options: TranscriptionTaskServiceOptions = { inputs, leases, repository, media, modelResolver, backendResolver, executor, scheduleLeaseRenewal };
  const service = createTranscriptionTaskService(options);
  let sequence = 0;
  const request = async (owner = ownerA, count = 1, streams = false): Promise<EnqueueTranscriptionRequest> => {
    const files = [];
    for (let index = 0; index < count; index++) {
      const filePath = path.join(bundle.tempRoot, `input-${++sequence}.wav`); await writeFile(filePath, `audio-${sequence}`);
      const input = await inputs.authorize(owner, filePath, ['probe', 'transcribe', 'derive_source_output']);
      files.push({ fileToken: input.fileToken, ...(streams ? { audioStreamId: `audio-${index}` } : {}) });
    }
    return { files, config: structuredClone(config) };
  };
  disposals.push(async () => { await service.shutdown(); service.confirmCleanup(); await bundle.cleanup(); });
  return { service, inputs, leases, repository, model, modelResolver, backendResolver, media, executor, request, timers, options, transcript };
}

it('admits bounded media capabilities and sequentially publishes complete documents without output authority', async () => {
  const f = await fixture(), request = await f.request(ownerA, 2, true);
  const admission = await f.service.enqueue(ownerA, request);
  await f.service.waitForIdle();
  const tasks = f.service.list(ownerA);
  expect(tasks.map(task => task.status)).toEqual(['completed', 'completed']);
  expect(await f.repository.list()).toHaveLength(2);
  expect(f.executor.execute).toHaveBeenCalledTimes(2);
  for (const [context] of f.executor.execute.mock.calls) {
    expect(Object.isFrozen(context.config)).toBe(true);
    expect(Object.isFrozen(context.config.inference.advanced)).toBe(true);
    expect(context.config).not.toHaveProperty('output'); expect(context.config).not.toHaveProperty('postAction');
  }
  expect(f.media.bindTaskMediaSelection).toHaveBeenCalledTimes(2);
  expect(f.media.releaseTaskMediaSelection).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(tasks)).not.toContain(request.files[0]!.fileToken);
  expect(JSON.stringify(tasks)).not.toContain('absolutePath');
  const document = await f.repository.read(tasks[0]!.documentId!);
  expect(document.origin.format).toBe('media'); expect(document.cues[0]!.source.plain).toBe('Hello world.');
  await expect(f.inputs.resolveTaskLease(ownerA, admission.tasks[0]!.taskId, 'transcribe')).rejects.toBeDefined();
  expect(f.service.isResourceBusy(config.modelId)).toBe(false);
});

it('finishes an empty result, releases all references and continues the queue without creating an empty document or translating it', async () => {
  const f = await fixture(), handoff = vi.fn(async (_documentId: string) => ({ taskId: '00000000-0000-4000-8000-000000000001' }));
  const release = vi.fn();
  Object.assign(f.options, { automaticTranslation: { handoff },
    automaticKnowledge: { capture: vi.fn(async () => ({ snapshot: automaticKnowledgeSnapshot(), release })) } });
  f.executor.execute.mockResolvedValueOnce({ status: 'no_content', durationMs: 5000 });
  const request = { ...await f.request(ownerA, 2, true), autoTranslation: automaticKnowledgeRequest() };
  await f.service.enqueue(ownerA, request); await f.service.waitForIdle();
  const tasks = f.service.list(ownerA);
  expect(tasks.map(task => task.status)).toEqual(['no_content', 'completed']);
  expect(tasks[0]).toMatchObject({ progress: 100, durationMs: 5000 });
  expect(tasks[0].documentId).toBeUndefined(); expect(tasks[0].error).toBeUndefined();
  expect(tasks[0].automaticTranslation).toBeUndefined(); expect(tasks[0].documentDurability).toBeUndefined();
  expect(await f.repository.list()).toHaveLength(1); expect(handoff).toHaveBeenCalledOnce();
  expect(handoff.mock.calls[0][0]).toBe(tasks[1].documentId); expect(release).toHaveBeenCalledOnce();
  expect(f.media.releaseTaskMediaSelection).toHaveBeenCalledTimes(2);
  await expect(f.inputs.resolveTaskLease(ownerA, tasks[0].taskId, 'transcribe')).rejects.toBeDefined();
  expect(f.service.isResourceBusy(config.modelId)).toBe(false);
  expect(f.service.cancel(ownerA, tasks[0].taskId).status).toBe('no_content');
  f.service.remove(ownerA, tasks[0].taskId); expect(f.service.list(ownerA)).toHaveLength(1);
});

it.each(['batch', 'binding', 'cancel'] as const)('keeps %s cleanup or cancellation authoritative over an empty transcription', async kind => {
  const f = await fixture(), release = vi.fn(), handoff = vi.fn();
  Object.assign(f.options, { automaticTranslation: { handoff },
    automaticKnowledge: { capture: vi.fn(async () => ({ snapshot: automaticKnowledgeSnapshot(), release })) } });
  f.executor.execute.mockResolvedValueOnce({ status: 'no_content', durationMs: 5000 });
  if (kind === 'binding') f.media.releaseTaskMediaSelection.mockImplementationOnce(() => { throw new Error('binding cleanup failed'); });
  if (kind === 'batch') f.executor.endBatchSlice.mockImplementationOnce(() => { throw new Error('batch cleanup failed'); });
  if (kind === 'cancel') f.executor.endBatchSlice.mockImplementationOnce(() => {
    f.service.cancel(ownerA, f.service.list(ownerA)[0].taskId);
  });
  await f.service.enqueue(ownerA, { ...await f.request(ownerA, 1, true), autoTranslation: automaticKnowledgeRequest() });
  await f.service.waitForIdle();
  const task = f.service.list(ownerA)[0];
  expect(task.status).toBe(kind === 'cancel' ? 'cancelled' : 'failed');
  if (kind !== 'cancel') expect(task).toMatchObject({ error: { code: 'cleanup_failed' }, cleanupPending: true });
  expect(task.documentId).toBeUndefined(); expect(task.automaticTranslation).toBeUndefined();
  expect(await f.repository.list()).toEqual([]); expect(handoff).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
});

it('hands two real published intents to one real translation service with one task each and no credentials in summaries', async () => {
  const f = await fixture();
  const send = vi.fn(async (request: import('../../electron/main/ai/model-runtime-client').ModelRuntimeTextRequest) => ({ apiFormat: request.model.apiFormat, content: JSON.stringify({ items: JSON.parse(request.messages[1].content).items.map((item: { id: string; text: string }) => ({ ...item, text: `Translated ${item.text}` })) }), finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }));
  const translation = new TranslationService(f.repository, send), automatic = createAutomaticTranslationCoordinator({ repository: f.repository, translation });
  Object.assign(f.options, { automaticTranslation: automatic });
  try {
    await automatic.initialize(); const request = { ...await f.request(ownerA, 2), autoTranslation: automaticRequest() };
    await f.service.enqueue(ownerA, request); await f.service.waitForIdle();
    const tasks = f.service.list(ownerA); expect(tasks.map(task => task.status)).toEqual(['completed', 'completed']);
    for (const task of tasks) {
      expect(task.automaticTranslation?.status).toBe('admitted'); await translation.settled(task.automaticTranslation!.taskId!);
      const snapshot = await f.repository.readSnapshot(task.documentId!);
      expect(snapshot.automaticTranslation).toMatchObject({ state: 'admitted', sourceTaskId: task.taskId, translationTaskId: task.automaticTranslation!.taskId });
      expect(snapshot.tasks).toHaveLength(1); expect(snapshot.tasks[0].status).toBe('completed');
      expect(JSON.stringify(snapshot)).not.toContain(request.autoTranslation.apiKey);
    }
    expect(send).toHaveBeenCalledTimes(2); expect(JSON.stringify(tasks)).not.toContain(request.autoTranslation.apiKey);
  } finally { await automatic.shutdown(); await translation.dispose(); }
});
it('keeps successful ASR publication when automatic handoff fails and clears automatic plans on cancellation', async () => {
  const f = await fixture(), handoff = vi.fn(async () => { throw new Error('controlled handoff failure'); }); Object.assign(f.options, { automaticTranslation: { handoff } });
  await f.service.enqueue(ownerA, { ...await f.request(), autoTranslation: automaticRequest() }); await f.service.waitForIdle();
  const completed = f.service.list(ownerA)[0]; expect(completed).toMatchObject({ status: 'completed', automaticTranslation: { status: 'needs_configuration' } });
  expect((await f.repository.readSnapshot(completed.documentId!)).automaticTranslation?.state).toBe('pending');
  f.executor.execute.mockResolvedValueOnce({ status: 'cancelled' });
  await f.service.enqueue(ownerA, { ...await f.request(), autoTranslation: automaticRequest() }); await f.service.waitForIdle();
  expect(f.service.list(ownerA)[1]).toMatchObject({ status: 'cancelled' }); expect(f.service.list(ownerA)[1].automaticTranslation).toBeUndefined();
  expect(handoff).toHaveBeenCalledOnce(); expect(await f.repository.list()).toHaveLength(1);
});
it('rejects enabled automatic translation without a coordinator before creating input leases', async () => {
  const f = await fixture(), request = { ...await f.request(), autoTranslation: automaticRequest() };
  await expect(f.service.enqueue(ownerA, request)).rejects.toMatchObject({ code: 'needs_configuration' });
  expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.service.list(ownerA)).toEqual([]);
  await expect(f.inputs.resolveDraft(ownerA, request.files[0].fileToken, 'transcribe')).resolves.toBeDefined();
});

const automaticKnowledgeRequest = (): AutomaticTranslationRequest => ({ ...automaticRequest(), knowledge: {
  knowledgeGeneration: 1,
  selection: { version: 1, languagePair: { source: 'en', target: 'ja' }, collectionIds: [], disabledEntryIds: [] },
  documentTopicIds: [],
} });
const automaticKnowledgeSnapshot = () => buildFrozenAutomaticKnowledge({
  generation: 1, data: knowledgeFixture(), approvals: {}, imports: [],
}, automaticKnowledgeRequest().knowledge!);

it('rejects automatic knowledge without capture support before any native admission instead of dropping its selection', async () => {
  const f = await fixture(), handoff = vi.fn(); Object.assign(f.options, { automaticTranslation: { handoff } });
  const request = { ...await f.request(), autoTranslation: automaticKnowledgeRequest() };
  await expect(f.service.enqueue(ownerA, request)).rejects.toMatchObject({ code: 'unsupported_feature' });
  expect(f.modelResolver.resolveManagedModel).not.toHaveBeenCalled(); expect(f.media.verifyRuntime).not.toHaveBeenCalled();
  expect(f.executor.execute).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
  await expect(f.inputs.resolveDraft(ownerA, request.files[0].fileToken, 'transcribe')).resolves.toBeDefined();
});

it('rejects a forged non-English knowledge source for English ASR output before capture or native work', async () => {
  const f = await fixture(), capture = vi.fn(), handoff = vi.fn(), automatic = automaticKnowledgeRequest();
  automatic.knowledge!.selection.languagePair.source = 'ja';
  Object.assign(f.options, { automaticTranslation: { handoff }, automaticKnowledge: { capture } });
  const request = { ...await f.request(), config: { ...config, taskMode: 'translate_to_english' as const }, autoTranslation: automatic };
  await expect(f.service.enqueue(ownerA, request)).rejects.toMatchObject({ code: 'invalid_input' });
  expect(capture).not.toHaveBeenCalled(); expect(f.modelResolver.resolveManagedModel).not.toHaveBeenCalled();
  expect(f.media.verifyRuntime).not.toHaveBeenCalled(); expect(f.executor.execute).not.toHaveBeenCalled();
});

it('rejects a failed knowledge capture before native authorities and retains reusable input drafts', async () => {
  const f = await fixture(), capture = vi.fn(async () => { throw new StudioError('revision_conflict'); }), handoff = vi.fn();
  Object.assign(f.options, { automaticTranslation: { handoff }, automaticKnowledge: { capture } });
  const request = { ...await f.request(), autoTranslation: automaticKnowledgeRequest() };
  await expect(f.service.enqueue(ownerA, request)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(capture).toHaveBeenCalledOnce(); expect(f.modelResolver.resolveManagedModel).not.toHaveBeenCalled();
  expect(f.media.verifyRuntime).not.toHaveBeenCalled(); expect(f.executor.execute).not.toHaveBeenCalled();
  expect(handoff).not.toHaveBeenCalled(); expect(await f.repository.list()).toEqual([]);
  await expect(f.inputs.resolveDraft(ownerA, request.files[0].fileToken, 'transcribe')).resolves.toBeDefined();
});

it('captures once before native admission and holds the batch reference until every document has its durable intent', async () => {
  const f = await fixture(), snapshot = automaticKnowledgeSnapshot(), release = vi.fn(), gate = deferred();
  const capture = vi.fn(async () => ({ snapshot, release }));
  const handoff = vi.fn(async (documentId: string) => {
    expect((await f.repository.readSnapshot(documentId)).automaticTranslation?.knowledge).toEqual(snapshot);
    return { taskId: '00000000-0000-4000-8000-000000000001' };
  });
  Object.assign(f.options, { automaticTranslation: { handoff }, automaticKnowledge: { capture } });
  f.modelResolver.resolveManagedModel.mockImplementationOnce(async () => {
    expect(capture).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled(); return f.model;
  });
  f.executor.execute.mockImplementationOnce(async () => ({ status: 'transcript_ready', transcript: f.transcript }))
    .mockImplementationOnce(async () => { await gate.promise; return { status: 'transcript_ready', transcript: f.transcript }; });
  const admission = await f.service.enqueue(ownerA, { ...await f.request(ownerA, 2), autoTranslation: automaticKnowledgeRequest() });
  await eventually(() => f.executor.execute.mock.calls.length === 2);
  expect(release).not.toHaveBeenCalled(); expect(handoff).toHaveBeenCalledOnce();
  const first = f.service.list(ownerA)[0];
  expect((await f.repository.readSnapshot(first.documentId!)).automaticTranslation?.knowledge?.digest).toBe(snapshot.digest);
  gate.resolve(); await f.service.waitForIdle();
  expect(release).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledOnce(); expect(handoff).toHaveBeenCalledTimes(2);
  for (const task of f.service.list(ownerA)) {
    const saved = await f.repository.readSnapshot(task.documentId!);
    expect(saved.automaticTranslation).toMatchObject({ sourceTaskId: task.taskId, knowledge: snapshot });
    expect(JSON.stringify(saved)).not.toContain(automaticKnowledgeRequest().apiKey);
  }
  await f.service.releaseOwner(ownerA); expect(release).toHaveBeenCalledOnce();
  expect(admission.tasks).toHaveLength(2);
});

it('releases the shared knowledge reference after queued and executing tasks cancel without publishing', async () => {
  const f = await fixture(), release = vi.fn(), gate = deferred(), handoff = vi.fn();
  Object.assign(f.options, { automaticTranslation: { handoff }, automaticKnowledge: { capture: vi.fn(async () => ({ snapshot: automaticKnowledgeSnapshot(), release })) } });
  f.executor.execute.mockImplementationOnce(async () => { await gate.promise; return { status: 'cancelled' }; });
  const admission = await f.service.enqueue(ownerA, { ...await f.request(ownerA, 2), autoTranslation: automaticKnowledgeRequest() });
  await eventually(() => f.executor.execute.mock.calls.length === 1);
  f.service.cancel(ownerA, admission.tasks[1].taskId); expect(release).not.toHaveBeenCalled();
  f.service.cancel(ownerA, admission.tasks[0].taskId); expect(release).not.toHaveBeenCalled();
  gate.resolve(); await f.service.waitForIdle();
  expect(release).toHaveBeenCalledOnce(); expect(handoff).not.toHaveBeenCalled(); expect(await f.repository.list()).toEqual([]);
});

it('joins an in-flight capture during shutdown and releases its late lease without starting native work', async () => {
  const f = await fixture(), release = vi.fn(), gate = deferred();
  const capture = vi.fn(async () => { await gate.promise; return { snapshot: automaticKnowledgeSnapshot(), release }; });
  Object.assign(f.options, { automaticTranslation: { handoff: vi.fn() }, automaticKnowledge: { capture } });
  const pending = f.service.enqueue(ownerA, { ...await f.request(), autoTranslation: automaticKnowledgeRequest() });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'access_denied' });
  let stopped = false; const shutdown = f.service.shutdown().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(release).not.toHaveBeenCalled();
  gate.resolve(); await rejected; await shutdown;
  expect(release).toHaveBeenCalledOnce(); expect(f.modelResolver.resolveManagedModel).not.toHaveBeenCalled();
  expect(f.media.verifyRuntime).not.toHaveBeenCalled(); expect(f.executor.execute).not.toHaveBeenCalled();
});

it('releases captured knowledge when later native admission fails', async () => {
  const f = await fixture(), release = vi.fn();
  Object.assign(f.options, { automaticTranslation: { handoff: vi.fn() }, automaticKnowledge: { capture: vi.fn(async () => ({ snapshot: automaticKnowledgeSnapshot(), release })) } });
  f.media.bindTaskMediaSelection.mockImplementationOnce(() => { throw new StudioError('invalid_input'); });
  await expect(f.service.enqueue(ownerA, { ...await f.request(ownerA, 2, true), autoTranslation: automaticKnowledgeRequest() })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(release).toHaveBeenCalledOnce(); expect(f.executor.execute).not.toHaveBeenCalled();
  expect(f.service.list(ownerA)).toEqual([]); expect(await f.repository.list()).toEqual([]);
});

it('transfers knowledge before a delayed handoff and joins a late owner release without revoking the committed intent', async () => {
  const f = await fixture(), release = vi.fn(), gate = deferred(), snapshot = automaticKnowledgeSnapshot();
  const handoff = vi.fn(async (documentId: string) => {
    expect(release).toHaveBeenCalledOnce();
    expect((await f.repository.readSnapshot(documentId)).automaticTranslation?.knowledge).toEqual(snapshot);
    await gate.promise; return { taskId: '00000000-0000-4000-8000-000000000001' };
  });
  Object.assign(f.options, { automaticTranslation: { handoff }, automaticKnowledge: { capture: vi.fn(async () => ({ snapshot, release })) } });
  let released: Promise<void> | undefined, joined = false;
  const unsubscribe = f.repository.subscribe(() => { released = f.service.releaseOwner(ownerA).then(() => { joined = true; }); });
  try {
    await f.service.enqueue(ownerA, { ...await f.request(), autoTranslation: automaticKnowledgeRequest() });
    await eventually(() => handoff.mock.calls.length === 1); expect(joined).toBe(false);
    gate.resolve(); await f.service.waitForIdle(); await released;
    expect(joined).toBe(true); expect(release).toHaveBeenCalledOnce();
    const documents = await f.repository.list(); expect(documents).toHaveLength(1);
    expect((await f.repository.readSnapshot(documents[0].id)).automaticTranslation?.knowledge).toEqual(snapshot);
  } finally { gate.resolve(); unsubscribe(); }
});

it('shows a knowledge conflict as automatic translation needing attention while retaining the successful transcription', async () => {
  const f = await fixture(), data = knowledgeFixture(), release = vi.fn(), automatic = automaticKnowledgeRequest();
  automatic.config.language = 'zh-Hans'; automatic.knowledge!.selection.languagePair.target = 'zh-Hans';
  automatic.knowledge!.selection.collectionIds = [data.collections[0].id]; automatic.knowledge!.documentTopicIds = [data.subjects[0].id];
  const term = data.entries.find(entry => entry.kind === 'term')!;
  term.state = 'ready'; term.scope.condition = { mode: 'none' }; if (term.kind === 'term') term.payload.strength = 'required';
  const conflicting = { ...structuredClone(term), id: '50000000-0000-4000-8000-000000000011', payload: { ...term.payload, target: '检查站' } };
  data.entries.push(conflicting);
  const approvals = Object.fromEntries([term, conflicting].map(entry => [entry.id, { revision: entry.revision, digest: sha256Canonical(entry), method: 'human' as const, approvedAt: '2026-09-14T00:00:00Z' }]));
  const snapshot = buildFrozenAutomaticKnowledge({ generation: 1, data, approvals, imports: [] }, automatic.knowledge!);
  f.transcript.segments[0].text = 'We reached the checkpoint.';
  const send = vi.fn(), translation = new TranslationService(f.repository, send);
  const coordinator = createAutomaticTranslationCoordinator({ repository: f.repository, translation });
  Object.assign(f.options, { automaticTranslation: coordinator, automaticKnowledge: { capture: vi.fn(async () => ({ snapshot, release })) } });
  try {
    await coordinator.initialize(); await f.service.enqueue(ownerA, { ...await f.request(), autoTranslation: automatic }); await f.service.waitForIdle();
    const task = f.service.list(ownerA)[0], saved = await f.repository.readSnapshot(task.documentId!);
    expect(task).toMatchObject({ status: 'completed', automaticTranslation: { status: 'needs_configuration', taskId: saved.tasks[0].id } });
    expect(saved.tasks[0]).toMatchObject({ status: 'failed', attempts: 0, translation: { error: 'knowledge_check_failed' } });
    expect(saved.document.cues[0].source.plain).toBe('We reached the checkpoint.');
    expect(saved.automaticTranslation?.knowledge).toEqual(snapshot); expect(send).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); await translation.dispose(); }
});

it('claims FIFO before await even when the later owner finishes admission first', async () => {
  const f = await fixture(), a = await f.request(), b = await f.request(ownerB), gate = deferred();
  f.modelResolver.resolveManagedModel.mockImplementationOnce(async () => { await gate.promise; return f.model; });
  const first = f.service.enqueue(ownerA, a);
  await f.service.enqueue(ownerB, b);
  expect(f.executor.execute).not.toHaveBeenCalled();
  gate.resolve(); await first; await f.service.waitForIdle();
  expect(f.executor.execute.mock.calls.map(([context]) => context.owner)).toEqual([ownerA, ownerB]);
});

it('skips a released pending admission without blocking another owner and joins late work', async () => {
  const f = await fixture(), a = await f.request(), b = await f.request(ownerB), gate = deferred();
  f.modelResolver.resolveManagedModel.mockImplementationOnce(async () => { await gate.promise; return f.model; });
  const first = f.service.enqueue(ownerA, a); void first.catch(() => undefined);
  await f.service.enqueue(ownerB, b);
  const released = f.service.releaseOwner(ownerA);
  let joined = false; void released.then(() => { joined = true; });
  await f.service.waitForIdle(ownerB);
  expect(joined).toBe(false); expect(f.executor.execute.mock.calls.map(([context]) => context.owner)).toEqual([ownerB]);
  gate.resolve(); await expect(first).rejects.toMatchObject({ code: 'access_denied' }); await released;
  expect(() => f.service.list(ownerA)).toThrow(StudioError);
});

it('rolls back every input and selection when one file cannot be bound', async () => {
  const f = await fixture(), request = await f.request(ownerA, 2, true);
  f.media.bindTaskMediaSelection.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new StudioError('invalid_input'); });
  await expect(f.service.enqueue(ownerA, request)).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.service.list(ownerA)).toEqual([]); expect(f.executor.execute).not.toHaveBeenCalled();
  expect(f.media.releaseTaskMediaSelection).toHaveBeenCalledTimes(2);
  for (const file of request.files) await expect(f.inputs.resolveDraft(ownerA, file.fileToken, 'transcribe')).resolves.toBeDefined();
  expect(f.service.isResourceBusy(config.modelId)).toBe(false);
});

it('rejects unbranded backend proof before input leases or execution', async () => {
  const f = await fixture(), request = await f.request();
  const real = await f.backendResolver.resolveBackend({ model: f.model, devicePreference: 'cpu',
    admittedRuntimeGeneration: (await f.media.verifyRuntime()).runtimeGeneration });
  vi.spyOn(f.backendResolver, 'resolveBackend').mockResolvedValue({ ...real });
  await expect(f.service.enqueue(ownerA, request)).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.executor.execute).not.toHaveBeenCalled();
  await expect(f.inputs.resolveDraft(ownerA, request.files[0]!.fileToken, 'transcribe')).resolves.toBeDefined();
});

it('revalidates managed identity at execution and never publishes if it changed', async () => {
  const f = await fixture(), request = await f.request();
  f.modelResolver.resolveManagedModel.mockResolvedValueOnce(f.model).mockResolvedValue({ ...f.model, sha256: 'b'.repeat(64) });
  await f.service.enqueue(ownerA, request); await f.service.waitForIdle();
  expect(f.service.list(ownerA)[0]).toMatchObject({ status: 'failed', error: { code: 'model_corrupt' } });
  expect(f.executor.execute).not.toHaveBeenCalled(); expect(await f.repository.list()).toEqual([]);
});

it('fences active cancellation, cancels a queued sibling, and prevents document publication', async () => {
  const f = await fixture(), gate = deferred();
  f.executor.execute.mockImplementation(async context => { await gate.promise;
    expect(context.signal.aborted).toBe(true); return { status: 'cancelled' }; });
  const admission = await f.service.enqueue(ownerA, await f.request(ownerA, 2));
  await eventually(() => f.executor.execute.mock.calls.length === 1);
  expect(() => f.service.remove(ownerA, admission.tasks[0]!.taskId)).toThrow(StudioError);
  expect(() => f.service.cancel(ownerB, admission.tasks[0]!.taskId)).toThrow(StudioError);
  f.service.cancel(ownerA, admission.tasks[0]!.taskId); f.service.cancel(ownerA, admission.tasks[1]!.taskId);
  gate.resolve(); await f.service.waitForIdle();
  expect(f.service.list(ownerA).map(task => task.status)).toEqual(['cancelled', 'cancelled']);
  expect(f.executor.execute).toHaveBeenCalledTimes(1); expect(await f.repository.list()).toEqual([]);
  for (const task of admission.tasks) f.service.remove(ownerA, task.taskId);
  expect(f.service.list(ownerA)).toEqual([]);
});

it('keeps completed document receipts when owner release arrives after publication', async () => {
  const f = await fixture();
  let release: Promise<void> | undefined;
  const unsubscribe = f.repository.subscribe(() => { release = f.service.releaseOwner(ownerA); });
  try {
    await f.service.enqueue(ownerA, await f.request()); await f.service.waitForIdle(); await release;
    expect(await f.repository.list()).toHaveLength(1);
    expect(f.service.isResourceBusy(config.modelId)).toBe(false);
  } finally { unsubscribe(); }
});

it('retains native cleanup failures and resource locks until whole-runtime cleanup is confirmed', async () => {
  const f = await fixture();
  f.executor.endBatchSlice.mockImplementation(() => { throw new Error('private /native/path cleanup failed'); });
  const admission = await f.service.enqueue(ownerA, await f.request()); await f.service.waitForIdle();
  expect(f.service.list(ownerA)[0]).toMatchObject({ status: 'failed', error: { code: 'cleanup_failed' }, cleanupPending: true });
  expect(JSON.stringify(f.service.list(ownerA))).not.toContain('/native/path');
  expect(await f.repository.list()).toEqual([]);
  expect(() => f.service.remove(ownerA, admission.tasks[0]!.taskId)).toThrow(StudioError);
  expect(f.service.isResourceBusy(config.modelId)).toBe(true);
  await f.service.shutdown(); expect(f.service.isResourceBusy(config.modelId)).toBe(true);
  f.service.confirmCleanup(); expect(f.service.isResourceBusy(config.modelId)).toBe(false);
});

it('renews queued and active leases per owner and aborts a task whose lease fails', async () => {
  const f = await fixture(), gate = deferred();
  f.executor.execute.mockImplementation(async () => { await gate.promise; return { status: 'cancelled' }; });
  await f.service.enqueue(ownerA, await f.request()); await eventually(() => f.executor.execute.mock.calls.length === 1);
  const renew = vi.spyOn(f.inputs, 'renewTaskLease').mockRejectedValue(new StudioError('access_denied'));
  f.timers[0]!.callback(); await eventually(() => renew.mock.calls.length === 1);
  await eventually(() => f.executor.execute.mock.calls[0]![0].signal.aborted);
  gate.resolve(); await f.service.waitForIdle();
  expect(f.service.list(ownerA)[0]).toMatchObject({ status: 'failed', error: { code: 'access_denied' } });
  expect(await f.repository.list()).toEqual([]);
});

it('keeps a second owner renewing twice and executing while the first owner renewal is stalled', async () => {
  const f = await fixture(), executionGate = deferred(), renewalGate = deferred();
  f.executor.execute.mockImplementationOnce(async () => { await executionGate.promise; return { status: 'cancelled' }; });
  await f.service.enqueue(ownerA, await f.request()); await eventually(() => f.executor.execute.mock.calls.length === 1);
  await f.service.enqueue(ownerB, await f.request(ownerB));
  const realRenew = f.inputs.renewTaskLease.bind(f.inputs);
  const renew = vi.spyOn(f.inputs, 'renewTaskLease').mockImplementation(async (owner, taskId, ttl) => {
    if (owner.ownerSessionId === ownerA.ownerSessionId) await renewalGate.promise;
    return realRenew(owner, taskId, ttl);
  });
  f.timers[0]!.callback(); f.timers[1]!.callback();
  await eventually(() => f.timers.length === 3);
  f.timers[2]!.callback();
  await eventually(() => renew.mock.calls.filter(([owner]) => owner.ownerSessionId === ownerB.ownerSessionId).length === 2);
  const released = f.service.releaseOwner(ownerA);
  executionGate.resolve();
  await f.service.waitForIdle(ownerB);
  expect(f.service.list(ownerB)[0]!.status).toBe('completed');
  renewalGate.resolve(); await released;
});

it('frees the execution slot when a released owner was waiting for its stalled renewal', async () => {
  const f = await fixture(), firstGate = deferred(), renewalGate = deferred();
  f.executor.execute.mockImplementationOnce(async () => { await firstGate.promise; return { status: 'cancelled' }; });
  await f.service.enqueue(ownerB, await f.request(ownerB)); await eventually(() => f.executor.execute.mock.calls.length === 1);
  await f.service.enqueue(ownerA, await f.request());
  await f.service.enqueue(ownerB, await f.request(ownerB));
  const originalRenew = f.inputs.renewTaskLease.bind(f.inputs);
  vi.spyOn(f.inputs, 'renewTaskLease').mockImplementation(async (owner, taskId, ttl) => {
    if (owner.ownerSessionId === ownerA.ownerSessionId) await renewalGate.promise;
    return originalRenew(owner, taskId, ttl);
  });
  f.timers[1]!.callback(); firstGate.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  const released = f.service.releaseOwner(ownerA);
  await f.service.waitForIdle(ownerB);
  expect(f.service.list(ownerB).map(task => task.status)).toEqual(['cancelled', 'completed']);
  renewalGate.resolve(); await released;
});

it('retries a failed lease release but retains the cleanup lock until native cleanup confirmation', async () => {
  const f = await fixture();
  const release = vi.spyOn(f.inputs, 'releaseTaskLease').mockImplementationOnce(() => { throw new Error('private capability cleanup failure'); });
  const admission = await f.service.enqueue(ownerA, await f.request()); await f.service.waitForIdle();
  expect(f.service.list(ownerA)[0]).toMatchObject({ status: 'completed', cleanupPending: true });
  expect(await f.repository.list()).toHaveLength(1);
  expect(() => f.service.remove(ownerA, admission.tasks[0]!.taskId)).toThrow(StudioError);
  await f.service.releaseOwner(ownerA); expect(release).toHaveBeenCalledTimes(2);
  expect(f.service.isResourceBusy(config.modelId)).toBe(true);
  await f.service.shutdown(); f.service.confirmCleanup(); expect(f.service.isResourceBusy(config.modelId)).toBe(false);
});

it('rejects media changed while queued before starting the second executor', async () => {
  const f = await fixture(), gate = deferred(), request = await f.request(ownerA, 2);
  const second = await f.inputs.resolveDraft(ownerA, request.files[1]!.fileToken, 'transcribe');
  f.executor.execute.mockImplementationOnce(async () => { await gate.promise; return { status: 'cancelled' }; });
  await f.service.enqueue(ownerA, request); await eventually(() => f.executor.execute.mock.calls.length === 1);
  await writeFile(second.filePath, 'changed audio source'); gate.resolve(); await f.service.waitForIdle();
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(f.service.list(ownerA)[1]).toMatchObject({ status: 'failed', error: { code: 'media_changed' } });
  expect(await f.repository.list()).toEqual([]);
});

it('surfaces publication failure without manufacturing a completed document or retaining retry authority', async () => {
  const f = await fixture();
  vi.spyOn(f.repository, 'createConfirmed').mockRejectedValueOnce(new StudioError('output_write_failed'));
  const admission = await f.service.enqueue(ownerA, await f.request()); await f.service.waitForIdle();
  expect(f.service.list(ownerA)[0]).toMatchObject({ status: 'failed', error: { code: 'output_write_failed' } });
  expect(f.service.list(ownerA)[0]).not.toHaveProperty('documentId');
  expect(await f.repository.list()).toEqual([]); expect(f.service.isResourceBusy(config.modelId)).toBe(false);
  f.service.remove(ownerA, admission.tasks[0]!.taskId);
});

it('rejects cancellation at the final repository publication guard', async () => {
  const f = await fixture(), gate = deferred();
  const publish = f.repository.createConfirmed.bind(f.repository);
  const write = vi.spyOn(f.repository, 'createConfirmed').mockImplementation(async (document, guard) => { await gate.promise; return publish(document, guard); });
  const admission = await f.service.enqueue(ownerA, await f.request()); await eventually(() => write.mock.calls.length === 1);
  f.service.cancel(ownerA, admission.tasks[0]!.taskId); gate.resolve(); await f.service.waitForIdle();
  expect(f.service.list(ownerA)[0]!.status).toBe('cancelled'); expect(await f.repository.list()).toEqual([]);
});

it('aborts a pending enqueue from its lifetime signal and admits the next owner', async () => {
  const f = await fixture(), gate = deferred(), controller = new AbortController();
  f.modelResolver.resolveManagedModel.mockImplementationOnce(async () => { await gate.promise; return f.model; });
  const pending = f.service.enqueue(ownerA, await f.request(), controller.signal); void pending.catch(() => undefined);
  await f.service.enqueue(ownerB, await f.request(ownerB)); controller.abort();
  await f.service.waitForIdle(ownerB); expect(f.service.list(ownerB)[0]!.status).toBe('completed');
  gate.resolve(); await expect(pending).rejects.toMatchObject({ code: 'interrupted' });
});

it.each(['runtime', 'draft'] as const)('joins a held %s validator after a peer rejects before reporting owner idle or shutdown', async held => {
  const f = await fixture(), gate = deferred(), request = await f.request(ownerA, 2), rejected = new StudioError('invalid_input');
  if (held === 'runtime') {
    f.modelResolver.resolveManagedModel.mockRejectedValueOnce(rejected);
    const runtime = await f.media.verifyRuntime();
    f.media.verifyRuntime.mockImplementationOnce(async () => { await gate.promise; return runtime; });
  } else {
    const resolve = f.inputs.resolveDraft.bind(f.inputs);
    vi.spyOn(f.inputs, 'resolveDraft').mockImplementationOnce(async (...args) => { await gate.promise; return resolve(...args); })
      .mockRejectedValueOnce(rejected);
  }
  const pending = f.service.enqueue(ownerA, request); void pending.catch(() => undefined);
  let idle = false, stopped = false;
  const waiting = f.service.waitForIdle(ownerA).then(() => { idle = true; });
  const shutdown = f.service.shutdown().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(idle).toBe(false); expect(stopped).toBe(false);
  gate.resolve(); await expect(pending).rejects.toBe(rejected); await waiting; await shutdown;
  expect(f.executor.execute).not.toHaveBeenCalled();
});

it('caches shutdown before synchronous abort listeners can reenter it', async () => {
  const f = await fixture(), gate = deferred(); let reentrant: Promise<void> | undefined;
  f.executor.execute.mockImplementation(async context => { context.signal.addEventListener('abort', () => { reentrant = f.service.shutdown(); gate.resolve(); }, { once: true });
    await gate.promise; return { status: 'cancelled' }; });
  await f.service.enqueue(ownerA, await f.request()); await eventually(() => f.executor.execute.mock.calls.length === 1);
  const outer = f.service.shutdown(); expect(reentrant).toBe(outer); expect(f.service.shutdown()).toBe(outer); await outer;
});

it('retries failed timer cancellation and attempts capability release before reporting shutdown failure', async () => {
  const f = await fixture();
  await f.service.enqueue(ownerA, await f.request()); await f.service.waitForIdle();
  const timer = f.timers[0]!;
  const release = vi.spyOn(f.inputs, 'releaseTaskLease');
  const service = createTranscriptionTaskService({ ...f.options, scheduleLeaseRenewal: () => {
    let attempts = 0; return () => { if (++attempts === 1) throw new Error('timer cancellation failed'); timer.cancelled = true; };
  } });
  await service.enqueue(ownerB, await f.request(ownerB)); await service.waitForIdle();
  await expect(service.shutdown()).rejects.toThrow('shutdown');
  await expect(service.shutdown()).resolves.toBeUndefined(); service.confirmCleanup();
  expect(timer.cancelled).toBe(true); expect(release).toHaveBeenCalled();
});

it('reclaims clean released-owner task history so later owners do not inherit exhausted capacity', async () => {
  const f = await fixture();
  f.executor.execute.mockResolvedValue({ status: 'cancelled' });
  for (let batch = 0; batch < 50; batch++) {
    await f.service.enqueue(ownerA, await f.request(ownerA, 20)); await f.service.waitForIdle();
  }
  expect(f.service.list(ownerA)).toHaveLength(1000);
  const later = await f.request(ownerB);
  await expect(f.service.enqueue(ownerB, later)).rejects.toMatchObject({ code: 'limit_exceeded' });
  await f.service.releaseOwner(ownerA);
  await expect(f.service.enqueue(ownerB, later)).resolves.toBeDefined(); await f.service.waitForIdle();
  expect(f.service.list(ownerB)).toHaveLength(1);
}, 15000);

it('reveals only the admitted unchanged source for the live owner, including after lease release', async () => {
  const f = await fixture(), request = await f.request();
  const source = await f.inputs.resolveDraft(ownerA, request.files[0].fileToken, 'transcribe');
  const admission = await f.service.enqueue(ownerA, request), id = admission.tasks[0].taskId;
  await f.service.waitForIdle();
  const reveal = vi.fn();
  await f.service.revealInput(ownerA, id, reveal, () => {});
  expect(reveal).toHaveBeenCalledWith(source.filePath);
  expect(JSON.stringify(f.service.list(ownerA))).not.toContain(source.filePath);
  reveal.mockClear();
  await expect(f.service.revealInput(ownerB, id, reveal, () => {})).rejects.toMatchObject({ code: 'access_denied' });
  await expect(f.service.revealInput(ownerA, id, reveal, () => { throw new StudioError('access_denied'); })).rejects.toMatchObject({ code: 'access_denied' });
  await writeFile(source.filePath, 'replaced source content');
  await expect(f.service.revealInput(ownerA, id, reveal, () => {})).rejects.toMatchObject({ code: 'output_write_failed' });
  f.service.remove(ownerA, id);
  await expect(f.service.revealInput(ownerA, id, reveal, () => {})).rejects.toMatchObject({ code: 'access_denied' });
  expect(reveal).not.toHaveBeenCalled();
});
