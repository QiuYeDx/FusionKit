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

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const ownerA = { webContentsId: 31, ownerSessionId: 'owner-a' };
const ownerB = { webContentsId: 32, ownerSessionId: 'owner-b' };
const config: EnqueueTranscriptionRequest['config'] = { modelId: 'test-model', devicePreference: 'cpu', language: 'en',
  taskMode: 'transcribe', vadEnabled: false, advanced: { beamSize: 5, temperature: 0, vadMinSilenceMs: 500,
    maxCueDurationMs: 7000, maxCueChars: 80, maxLineChars: 40 } };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
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
      const input = await inputs.authorize(owner, filePath, ['probe', 'transcribe']);
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
