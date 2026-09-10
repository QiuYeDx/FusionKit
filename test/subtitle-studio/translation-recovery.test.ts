import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import { normalizeTranslationModel, type TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { ModelRuntimeClientError } from '../../electron/main/ai/model-runtime-errors';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planTranslation, sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';
import { checkpointForPlan, restoreTranslationPlan, TranslationScheduler } from '../../electron/main/subtitle-studio/translation-recovery';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';

const config = (): TranslationConfig => ({ model: { profileId: 'recovery-fixture', modelKey: 'deepseek-chat', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 });
const parse = (suffix = '') => importSubtitleText(`[00:01]First${suffix}\n[00:02]Second${suffix}\n[00:03]Third${suffix}`, { format: 'lrc', displayName: 'synthetic-recovery.lrc', encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const items = (request: ModelRuntimeTextRequest): { id: string; text: string }[] => JSON.parse(request.messages[1].content).items;
const success = (request: ModelRuntimeTextRequest): ModelRuntimeTextResult => ({ apiFormat: 'chat_completions', finishReason: 'stop', usage,
  content: JSON.stringify({ items: items(request).map(item => ({ id: item.id, text: `target ${item.id}` })) }) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const resources: { root: string; services: TranslationService[]; releases: (() => void)[] }[] = [];
async function fixture(repositoryFactory = (root: string) => new DocumentRepository(root)) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-recovery-'));
  const repository = repositoryFactory(path.join(root, 'documents'));
  const resource = { root, services: [] as TranslationService[], releases: [] as (() => void)[] };
  resources.push(resource);
  const doc = parse(); await repository.create(doc);
  const service = (send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult>, scheduler = new TranslationScheduler()) => {
    const value = new TranslationService(repository, send, scheduler); resource.services.push(value); return value;
  };
  return { ...resource, repository, doc, service };
}
async function start(service: TranslationService, repository: DocumentRepository, docId: string) {
  const doc = await repository.read(docId);
  const plan = await service.plan(7, doc.id, doc.revision, config());
  return service.start(7, doc.id, doc.revision, plan.planId, 'fixture-secret');
}
async function seedCrash(current: Awaited<ReturnType<typeof fixture>>, status: 'queued' | 'running' = 'running', withCheckpoint = true) {
  const plan = planTranslation(current.doc, config());
  const taskId = randomUUID(); const trackId = randomUUID();
  await current.repository.transact(current.doc.id, 1, snapshot => {
    const first = snapshot.document.cues[0];
    const text = { plain: 'committed first', spans: [{ text: 'committed first', marks: [] }] };
    snapshot.document.translationTracks.push({ id: trackId, language: 'zh', revision: 2,
      entries: { [first.id]: { sourceRevision: first.sourceRevision, sourceHash: sourceDigest(first), text, origin: 'ai', reviewStatus: 'unreviewed' } } });
    const checkpoint = checkpointForPlan(plan, snapshot.document, 2);
    snapshot.tasks.push({ id: taskId, trackId, generation: 8, status, completedBatchIds: ['b1'], uncertainBatchIds: [], attempts: status === 'running' ? 2 : 1,
      translation: { config: plan.config, totalBatches: 3, estimatedInputTokens: plan.batches.reduce((total, batch) => total + batch.estimatedInputTokens, 0), outputTokenReserve: plan.config.maxOutputTokens * 3, usage,
        ...(withCheckpoint ? { checkpoint, uncertainAttempts: 0, ...(status === 'running' ? { inFlightBatchId: 'b2' } : {}) } : {}) } });
  });
  return { plan, taskId };
}
async function disk(root: string): Promise<string> {
  const content: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) content.push(entry.isDirectory() ? await disk(path.join(root, entry.name)) : await readFile(path.join(root, entry.name), 'utf8'));
  return content.join('\n');
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const current of resources.splice(0)) {
    for (const release of current.releases) release();
    for (const service of current.services) await service.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

describe('translation checkpoint recovery', () => {
  it.each(['queued', 'running'] as const)('initializes crashed %s state once without dispatch and resumes only frozen unfinished batches', async status => {
    const current = await fixture();
    const seeded = await seedCrash(current, status);
    const requests: ModelRuntimeTextRequest[] = [];
    const service = current.service(async request => { requests.push(request); return success(request); });
    await Promise.all([service.initialize(), service.initialize()]);
    const interrupted = await current.repository.readSnapshot(current.doc.id);
    expect(interrupted.tasks[0]).toMatchObject({ status: 'interrupted', generation: 9, completedBatchIds: ['b1'], uncertainBatchIds: status === 'running' ? ['b2'] : [],
      translation: { uncertainAttempts: status === 'running' ? 1 : 0, usage: status === 'running' ? { inputTokens: null, outputTokens: null, totalTokens: null } : usage } });
    expect(interrupted.tasks[0].translation!.inFlightBatchId).toBeUndefined();
    expect(requests).toHaveLength(0);
    await service.initialize();
    expect((await current.repository.read(current.doc.id)).revision).toBe(interrupted.document.revision);
    await service.resume(current.doc.id, interrupted.document.revision, seeded.taskId, config().model, 'new-fixture-secret');
    await service.settled(seeded.taskId);
    expect(requests.map(request => items(request).map(item => item.id))).toEqual([['u2'], ['u3']]);
    expect(JSON.parse(requests[0].messages[1].content).context.priorModelTranslations).toEqual(['committed first']);
    const completed = await current.repository.readSnapshot(current.doc.id);
    expect(completed.tasks[0]).toMatchObject({ status: 'completed', generation: 10, completedBatchIds: ['b1', 'b2', 'b3'], uncertainBatchIds: [], translation: { uncertainAttempts: status === 'running' ? 1 : 0 } });
    expect(completed.tasks[0].translation!.checkpoint!.batches).toEqual(interrupted.tasks[0].translation!.checkpoint!.batches);
    expect(completed.document.translationTracks[0].entries[current.doc.cues[0].id].text.plain).toBe('committed first');
    expect(completed.document.cues).toEqual(current.doc.cues);
    expect(await disk(current.root)).not.toMatch(/fixture-secret|apiKey|AbortController/);
  });

  it('does not invent a resume plan for an older checkpoint-free task', async () => {
    const current = await fixture(); const { taskId } = await seedCrash(current, 'running', false);
    const send = vi.fn(async (request: ModelRuntimeTextRequest) => success(request)); const service = current.service(send);
    await service.initialize(); const doc = await current.repository.read(current.doc.id);
    await expect(service.resume(doc.id, doc.revision, taskId, config().model, 'secret')).rejects.toThrow('invalid_input');
    expect(send).not.toHaveBeenCalled();
    await service.cancel(doc.id, doc.revision, taskId);
    expect((await current.repository.readSnapshot(doc.id)).tasks[0].status).toBe('cancelled');
  });

  it('invalidates an old generation without allowing its cleanup to detach a newer run of the same task', async () => {
    const current = await fixture();
    const oldEntered = deferred<ModelRuntimeTextRequest>(); const oldResult = deferred<ModelRuntimeTextResult>();
    const newEntered = deferred<ModelRuntimeTextRequest>(); const newResult = deferred<ModelRuntimeTextResult>();
    let calls = 0;
    const service = current.service(request => {
      calls++;
      if (calls === 1) { oldEntered.resolve(request); return oldResult.promise; }
      if (calls === 2) { newEntered.resolve(request); return newResult.promise; }
      return Promise.resolve(success(request));
    });
    const started = await start(service, current.repository, current.doc.id);
    const oldRequest = await oldEntered.promise;
    current.releases.push(() => oldResult.resolve(success(oldRequest)));
    // A second service models a restarted owner taking over the still-unsettled old supplier.
    const recovered = current.service(async request => success(request));
    await recovered.initialize();
    const interrupted = await current.repository.readSnapshot(current.doc.id);
    await service.resume(current.doc.id, interrupted.document.revision, started.taskId, config().model, 'secret');
    const newRequest = await newEntered.promise;
    current.releases.push(() => newResult.resolve(success(newRequest)));
    oldResult.resolve(success(oldRequest));
    const waiting = service.settled(started.taskId); let finished = false; void waiting.then(() => { finished = true; });
    await vi.waitFor(() => expect(oldRequest.signal?.aborted).toBe(true));
    expect(finished).toBe(false);
    const stillRunning = await current.repository.readSnapshot(current.doc.id);
    expect(stillRunning.tasks[0]).toMatchObject({ generation: 3, completedBatchIds: [], status: 'running' });
    newResult.resolve(success(newRequest)); await waiting;
    const completed = await current.repository.readSnapshot(current.doc.id);
    expect(completed.tasks[0]).toMatchObject({ generation: 3, status: 'completed', attempts: 4, translation: { uncertainAttempts: 1 } });
  });

  it('persists missing or changed configuration, then resumes after exact frozen profile repair', async () => {
    const current = await fixture(); const { taskId } = await seedCrash(current, 'queued');
    const send = vi.fn(async (request: ModelRuntimeTextRequest) => success(request)); const service = current.service(send);
    await service.initialize();
    for (const model of [null, { ...config().model, profileId: 'other' }, { ...config().model, modelKey: 'other' }, { ...config().model, endpoint: 'https://another.invalid/v1' }, { ...config().model, apiFormat: 'responses' as const }, { ...config().model, thinkingEnabled: true }]) {
      const before = await current.repository.readSnapshot(current.doc.id);
      await service.resume(current.doc.id, before.document.revision, taskId, model, 'secret');
      const after = await current.repository.readSnapshot(current.doc.id);
      expect(after.tasks[0]).toMatchObject({ status: 'needs_configuration', translation: { error: 'needs_configuration', config: before.tasks[0].translation!.config } });
      expect(send).not.toHaveBeenCalled();
    }
    expect(normalizeTranslationModel(config().model).thinkingEnabled).toBe(false);
    const doc = await current.repository.read(current.doc.id);
    await service.resume(doc.id, doc.revision, taskId, { ...config().model, thinkingEnabled: false }, 'repaired-secret');
    await service.settled(taskId);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await current.repository.readSnapshot(doc.id)).tasks[0].status).toBe('completed');
  });

  it('rejects duplicate resume and another active task for the document', async () => {
    const current = await fixture(); const { taskId } = await seedCrash(current, 'queued');
    const entered = deferred<ModelRuntimeTextRequest>(); const release = deferred<ModelRuntimeTextResult>();
    const service = current.service(request => { entered.resolve(request); return release.promise; });
    await service.initialize(); const before = await current.repository.read(current.doc.id);
    const first = service.resume(before.id, before.revision, taskId, config().model, 'secret');
    const second = service.resume(before.id, before.revision, taskId, config().model, 'secret');
    await first; await expect(second).rejects.toThrow('revision_conflict');
    const request = await entered.promise; current.releases.push(() => release.resolve(success(request)));
    const running = await current.repository.read(current.doc.id);
    const plan = await service.plan(8, running.id, running.revision, config());
    await expect(service.start(8, running.id, running.revision, plan.planId, 'secret')).rejects.toThrow('revision_conflict');
    await service.cancel(running.id, running.revision, taskId);
    release.resolve(success(request)); await service.settled(taskId);
  });

  it.each(['source', 'track'] as const)('rejects a recovered %s revision mismatch without sending', async changed => {
    const current = await fixture(); const { taskId } = await seedCrash(current, 'queued');
    const send = vi.fn(async (request: ModelRuntimeTextRequest) => success(request)); const service = current.service(send);
    await service.initialize(); const before = await current.repository.read(current.doc.id);
    await current.repository.transact(before.id, before.revision, value => {
      if (changed === 'source') value.document.cues[1].sourceRevision++;
      else value.document.translationTracks[0].revision++;
    });
    const doc = await current.repository.read(current.doc.id);
    await expect(service.resume(doc.id, doc.revision, taskId, config().model, 'secret')).rejects.toThrow('revision_conflict');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('translation scheduling, cancellation and retry accounting', () => {
  it('cancels a noncooperative supplier promptly, rejects its late result and keeps its physical slot occupied', async () => {
    const current = await fixture(); const scheduler = new TranslationScheduler(1);
    const waiting = deferred<ModelRuntimeTextRequest>(); const release = deferred<ModelRuntimeTextResult>(); const started = deferred<ModelRuntimeTextRequest>();
    const requests: ModelRuntimeTextRequest[] = [];
    const service = current.service(request => { requests.push(request); if (requests.length === 1) { waiting.resolve(request); return release.promise; } started.resolve(request); return Promise.resolve(success(request)); }, scheduler);
    const first = await start(service, current.repository, current.doc.id); const request = await waiting.promise;
    current.releases.push(() => release.resolve(success(request)));
    const secondDoc = parse('other'); await current.repository.create(secondDoc);
    const second = await start(service, current.repository, secondDoc.id);
    const before = await current.repository.read(current.doc.id);
    await service.cancel(before.id, before.revision, first.taskId);
    expect(request.signal!.aborted).toBe(true);
    expect(requests).toHaveLength(1);
    const cancelled = await current.repository.readSnapshot(before.id);
    expect(cancelled.tasks[0]).toMatchObject({ status: 'cancelled', generation: 2, translation: { uncertainAttempts: 1, usage: { inputTokens: null, outputTokens: null, totalTokens: null } } });
    await expect(service.resume(before.id, cancelled.document.revision, first.taskId, config().model, 'secret')).rejects.toThrow('invalid_input');
    release.resolve(success(request)); await started.promise; await service.settled(first.taskId); await service.settled(second.taskId);
    expect(await current.repository.readSnapshot(before.id)).toEqual(cancelled);
    expect((await current.repository.readSnapshot(secondDoc.id)).tasks[0].status).toBe('completed');
  });

  it('runs at most two suppliers in FIFO order and can remove a queued document', async () => {
    const current = await fixture(); const scheduler = new TranslationScheduler(2);
    const entered: ModelRuntimeTextRequest[] = []; const releases: (() => void)[] = [];
    const service = current.service(request => new Promise(resolve => { entered.push(request); releases.push(() => resolve(success(request))); }), scheduler);
    current.releases.push(() => { for (const release of releases) release(); });
    const docs = [current.doc, parse('B'), parse('C'), parse('D')];
    for (const doc of docs.slice(1)) await current.repository.create(doc);
    const tasks = [];
    for (const doc of docs) tasks.push(await start(service, current.repository, doc.id));
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    const queued = await current.repository.read(docs[2].id);
    await service.cancel(queued.id, queued.revision, tasks[2].taskId);
    expect((await current.repository.readSnapshot(queued.id)).tasks[0]).toMatchObject({ status: 'cancelled', attempts: 0, translation: { uncertainAttempts: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } });
    releases[0](); await vi.waitFor(() => expect(entered).toHaveLength(3));
    expect(items(entered[2])[0].text).toBe('FirstD');
    for (const [index, doc] of docs.entries()) {
      if (index === 2) continue;
      const currentDoc = await current.repository.read(doc.id);
      await service.cancel(doc.id, currentDoc.revision, tasks[index].taskId);
    }
    for (const release of releases) release();
    for (const task of tasks) await service.settled(task.taskId);
  });

  it('keeps unknown-attempt history after a retried batch succeeds', async () => {
    const current = await fixture(); let calls = 0;
    const service = current.service(async request => { if (!calls++) throw new ModelRuntimeClientError('network_error', 'synthetic disconnect', true, { retryAfterMs: 0 }); return success(request); });
    const started = await start(service, current.repository, current.doc.id); await service.settled(started.taskId);
    const snapshot = await current.repository.readSnapshot(current.doc.id);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'completed', attempts: 4, completedBatchIds: ['b1', 'b2', 'b3'], uncertainBatchIds: [], translation: { uncertainAttempts: 1, usage: { inputTokens: null, outputTokens: null, totalTokens: null } } });
  });

  it('cancels during retry backoff without dispatching another attempt', async () => {
    const current = await fixture(); const send = vi.fn(async () => { throw new ModelRuntimeClientError('http_rate_limited', 'retry later', true, { retryAfterMs: 20000 }); });
    const service = current.service(send); const started = await start(service, current.repository, current.doc.id);
    await vi.waitFor(async () => expect((await current.repository.readSnapshot(current.doc.id)).tasks[0].translation?.uncertainAttempts).toBe(1));
    const before = await current.repository.read(current.doc.id); await service.cancel(before.id, before.revision, started.taskId); await service.settled(started.taskId);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await current.repository.readSnapshot(before.id)).tasks[0].status).toBe('cancelled');
  });

  it('persists long Retry-After so resume cannot dispatch before its deadline', async () => {
    const current = await fixture(); let calls = 0;
    const service = current.service(async request => { if (!calls++) throw new ModelRuntimeClientError('http_rate_limited', 'retry later', true, { retryAfterMs: 45000 }); return success(request); });
    const started = await start(service, current.repository, current.doc.id); await service.settled(started.taskId);
    const failed = await current.repository.readSnapshot(current.doc.id); const notBefore = failed.tasks[0].translation!.notBefore!;
    expect(notBefore).toBeGreaterThan(Date.now() + 40000);
    await service.resume(current.doc.id, failed.document.revision, started.taskId, config().model, 'secret');
    const queued = await current.repository.readSnapshot(current.doc.id);
    expect(queued.tasks[0].status).toBe('queued'); expect(calls).toBe(1);
    await service.cancel(current.doc.id, queued.document.revision, started.taskId); await service.settled(started.taskId);
    expect(calls).toBe(1);
  });

  it('uses a minimum retry backoff and preserves a second rate-limit deadline after reaching its attempt cap', async () => {
    const current = await fixture(); const callTimes: number[] = [];
    const service = current.service(async () => {
      callTimes.push(Date.now());
      throw new ModelRuntimeClientError('http_rate_limited', 'synthetic rate limit', true, { retryAfterMs: callTimes.length === 1 ? 0 : 5000 });
    });
    const started = await start(service, current.repository, current.doc.id); await service.settled(started.taskId);
    const failed = await current.repository.readSnapshot(current.doc.id);
    expect(callTimes).toHaveLength(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(500);
    expect(failed.tasks[0]).toMatchObject({ status: 'failed', attempts: 2, translation: { uncertainAttempts: 2 } });
    expect(failed.tasks[0].translation!.notBefore).toBeGreaterThan(Date.now() + 4000);
    await service.resume(current.doc.id, failed.document.revision, started.taskId, config().model, 'secret');
    const queued = await current.repository.readSnapshot(current.doc.id);
    expect(queued.tasks[0].status).toBe('queued'); expect(callTimes).toHaveLength(2);
    await service.cancel(current.doc.id, queued.document.revision, started.taskId); await service.settled(started.taskId);
    expect(callTimes).toHaveLength(2);
  });

  it.each(['failed', 'interrupted', 'needs_configuration'] as const)('can permanently cancel a paused %s task', async status => {
    const current = await fixture(); const { taskId } = await seedCrash(current, 'queued');
    const service = current.service(async request => success(request)); await service.initialize();
    const initialized = await current.repository.read(current.doc.id);
    await current.repository.transact(initialized.id, initialized.revision, value => { value.tasks[0].status = status; });
    const before = await current.repository.readSnapshot(current.doc.id);
    await service.cancel(current.doc.id, before.document.revision, taskId);
    const cancelled = await current.repository.readSnapshot(current.doc.id);
    expect(cancelled.tasks[0]).toMatchObject({ status: 'cancelled', generation: before.tasks[0].generation + 1, completedBatchIds: ['b1'] });
    expect(cancelled.document.translationTracks).toEqual(before.document.translationTracks);
    await expect(service.resume(current.doc.id, cancelled.document.revision, taskId, config().model, 'secret')).rejects.toThrow('invalid_input');
  });

  it('accounts a response received while cancellation waits for the repository queue without committing its translations', async () => {
    const current = await fixture(); const entered = deferred<ModelRuntimeTextRequest>(); const release = deferred<ModelRuntimeTextResult>();
    const service = current.service(request => { entered.resolve(request); return release.promise; });
    const started = await start(service, current.repository, current.doc.id); const request = await entered.promise;
    current.releases.push(() => release.resolve(success(request)));
    const doc = await current.repository.read(current.doc.id);
    const gateEntered = deferred<void>(); const unblock = deferred<void>();
    current.releases.push(() => unblock.resolve());
    const gate = current.repository.withDocument(doc.id, doc.revision, async () => { gateEntered.resolve(); await unblock.promise; });
    await gateEntered.promise;
    const cancellationQueued = deferred<void>(); const resultQueued = deferred<void>();
    const transact = current.repository.transact.bind(current.repository); let queued = 0;
    vi.spyOn(current.repository, 'transact').mockImplementation((...args) => {
      const operation = transact(...args);
      if (++queued === 1) cancellationQueued.resolve(); else resultQueued.resolve();
      return operation;
    });
    const cancelling = service.cancel(doc.id, doc.revision, started.taskId);
    await cancellationQueued.promise;
    release.resolve(success(request)); await resultQueued.promise;
    unblock.resolve(); await gate; await cancelling; await service.settled(started.taskId);
    const cancelled = await current.repository.readSnapshot(doc.id);
    expect(cancelled.tasks[0]).toMatchObject({ status: 'cancelled', attempts: 1, generation: 2, completedBatchIds: [], uncertainBatchIds: [], translation: { usage, uncertainAttempts: 0 } });
    expect(cancelled.tasks[0].translation!.inFlightBatchId).toBeUndefined();
    expect(cancelled.document.translationTracks[0].entries).toEqual({});
  });

  it('shares one shutdown promise with concurrent and reentrant callers until interruption is durable', async () => {
    const current = await fixture(); const entered = deferred<ModelRuntimeTextRequest>(); const release = deferred<ModelRuntimeTextResult>();
    const service = current.service(request => { entered.resolve(request); return release.promise; });
    const started = await start(service, current.repository, current.doc.id); const request = await entered.promise;
    current.releases.push(() => release.resolve(success(request)));
    const doc = await current.repository.read(current.doc.id);
    const gateEntered = deferred<void>(); const unblock = deferred<void>();
    current.releases.push(() => unblock.resolve());
    const gate = current.repository.withDocument(doc.id, doc.revision, async () => { gateEntered.resolve(); await unblock.promise; });
    await gateEntered.promise;
    let reentrant: Promise<void> | undefined;
    request.signal!.addEventListener('abort', () => { reentrant = service.dispose(); }, { once: true });
    const shutdown = service.dispose(); const concurrent = service.dispose();
    expect(concurrent).toBe(shutdown);
    let finished = false; void concurrent.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    unblock.resolve(); await gate; await shutdown;
    expect(reentrant).toBe(shutdown); expect(service.dispose()).toBe(shutdown);
    expect((await current.repository.readSnapshot(doc.id)).tasks[0]).toMatchObject({ status: 'interrupted', generation: 2 });
    release.resolve(success(request)); await service.settled(started.taskId);
  });

  it('retries a shutdown revision conflict while an uncooperative request is still unsettled', async () => {
    class ConcurrentCommitRepository extends DocumentRepository {
      advanceNextRead = false;
      override async readSnapshot(id: string) {
        const snapshot = await super.readSnapshot(id);
        if (this.advanceNextRead) {
          this.advanceNextRead = false;
          await super.transact(id, snapshot.document.revision, () => {});
        }
        return snapshot;
      }
    }
    const current = await fixture(root => new ConcurrentCommitRepository(root));
    const repository = current.repository as ConcurrentCommitRepository;
    const entered = deferred<ModelRuntimeTextRequest>(); const release = deferred<ModelRuntimeTextResult>();
    const service = current.service(request => { entered.resolve(request); return release.promise; });
    const started = await start(service, repository, current.doc.id); const request = await entered.promise;
    current.releases.push(() => release.resolve(success(request)));
    repository.advanceNextRead = true;
    await service.dispose();
    const interrupted = await repository.readSnapshot(current.doc.id);
    expect(interrupted.tasks[0]).toMatchObject({ status: 'interrupted', generation: 2, translation: { uncertainAttempts: 1 } });
    expect(request.signal?.aborted).toBe(true);
    release.resolve(success(request)); await service.settled(started.taskId);
    expect(await repository.readSnapshot(current.doc.id)).toEqual(interrupted);
  });

  it('shuts down promptly with a noncooperative request and forbids new work', async () => {
    const current = await fixture(); const entered = deferred<ModelRuntimeTextRequest>(); const release = deferred<ModelRuntimeTextResult>();
    const service = current.service(request => { entered.resolve(request); return release.promise; });
    const started = await start(service, current.repository, current.doc.id); const request = await entered.promise;
    current.releases.push(() => release.resolve(success(request)));
    await service.dispose();
    const snapshot = await current.repository.readSnapshot(current.doc.id);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'interrupted', generation: 2, translation: { uncertainAttempts: 1 } });
    await expect(service.plan(7, current.doc.id, snapshot.document.revision, config())).rejects.toThrow('interrupted');
    await expect(service.resume(current.doc.id, snapshot.document.revision, started.taskId, config().model, 'secret')).rejects.toThrow('interrupted');
    release.resolve(success(request)); await service.settled(started.taskId);
    expect(await current.repository.readSnapshot(current.doc.id)).toEqual(snapshot);
  });
});

describe('translation publication fault recovery', () => {
  it('keeps the first published batch after a later prepublication failure and resumes only unfinished work', async () => {
    let shouldFail = false;
    const current = await fixture(root => new DocumentRepository(root, { fault: stage => {
      if (stage === 'current-publish' && shouldFail) { shouldFail = false; throw new Error('synthetic publication failure'); }
    } }));
    const ids: string[] = []; let failed = false;
    const service = current.service(async request => {
      const id = items(request)[0].id; ids.push(id);
      if (id === 'u2' && !failed) { failed = true; shouldFail = true; }
      return success(request);
    });
    const started = await start(service, current.repository, current.doc.id); await service.settled(started.taskId);
    const failedSnapshot = await current.repository.readSnapshot(current.doc.id);
    expect(failedSnapshot.tasks[0]).toMatchObject({ status: 'failed', completedBatchIds: ['b1'], attempts: 2, translation: { usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } });
    expect(Object.keys(failedSnapshot.document.translationTracks[0].entries)).toEqual([current.doc.cues[0].id]);
    await service.resume(current.doc.id, failedSnapshot.document.revision, started.taskId, config().model, 'secret'); await service.settled(started.taskId);
    expect(ids).toEqual(['u1', 'u2', 'u2', 'u3']);
    const completed = await current.repository.readSnapshot(current.doc.id);
    expect(completed.tasks[0]).toMatchObject({ status: 'completed', attempts: 4, translation: { usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } } });
    expect(completed.document.cues).toEqual(current.doc.cues);
  });

  it('recognizes public start and cancellation commits even when their acknowledgements fail', async () => {
    class AcknowledgementRepository extends DocumentRepository {
      failNext = false;
      override async transact(id: string, revision: number, action: (snapshot: DocumentSnapshot) => void, guard?: () => void) {
        const snapshot = await super.transact(id, revision, action, guard);
        if (this.failNext) { this.failNext = false; throw new Error('synthetic acknowledgement failure'); }
        return snapshot;
      }
    }
    const current = await fixture(root => new AcknowledgementRepository(root));
    const repository = current.repository as AcknowledgementRepository;
    const entered = deferred<ModelRuntimeTextRequest>(); const release = deferred<ModelRuntimeTextResult>();
    const service = current.service(request => { entered.resolve(request); return release.promise; });
    await service.initialize(); repository.failNext = true;
    const started = await start(service, repository, current.doc.id);
    const request = await entered.promise; current.releases.push(() => release.resolve(success(request)));
    const running = await repository.read(current.doc.id); repository.failNext = true;
    await service.cancel(running.id, running.revision, started.taskId);
    expect(request.signal?.aborted).toBe(true);
    const cancelled = await repository.readSnapshot(current.doc.id);
    expect(cancelled.tasks).toHaveLength(1);
    expect(cancelled.tasks[0]).toMatchObject({ status: 'cancelled', generation: 2, attempts: 1 });
    release.resolve(success(request)); await service.settled(started.taskId);
    expect(await repository.readSnapshot(current.doc.id)).toEqual(cancelled);
  });

  it('recognizes a batch already published before a repository exception instead of replaying it', async () => {
    class AfterPublicationRepository extends DocumentRepository {
      failed = false;
      override async transact(id: string, revision: number, action: (snapshot: DocumentSnapshot) => void, guard?: () => void) {
        const result = await super.transact(id, revision, action, guard);
        if (!this.failed && result.tasks[0]?.completedBatchIds.includes('b1')) { this.failed = true; throw new Error('synthetic directory sync failed after publication'); }
        return result;
      }
    }
    const current = await fixture(root => new AfterPublicationRepository(root)); const ids: string[] = [];
    const service = current.service(async request => { ids.push(items(request)[0].id); return success(request); });
    const started = await start(service, current.repository, current.doc.id); await service.settled(started.taskId);
    const snapshot = await current.repository.readSnapshot(current.doc.id);
    expect(ids).toEqual(['u1', 'u2', 'u3']);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'completed', attempts: 3, translation: { usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 } } });
    expect(restoreTranslationPlan(snapshot, started.taskId).batches).toHaveLength(3);
  });
});
