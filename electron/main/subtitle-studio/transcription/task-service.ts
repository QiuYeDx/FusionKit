import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StudioError, errorCodeSchema } from '../../../../src/subtitle-studio/domain';
import { LOCAL_SUBTITLE_CUE_POLICY, LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION, LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION, LOCAL_SUBTITLE_PRODUCTION_CONTRACT, LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  createLocalSubtitleError, isLocalSubtitleErrorCode } from '../../../../src/subtitle-studio/transcription/domain';
import { enqueueTranscriptionRequestSchema, transcriptionTaskSummarySchema, type EnqueueTranscriptionRequest,
  type TranscriptionTaskSummary, type TranscriptionBatchAdmission } from '../../../../src/subtitle-studio/transcription/task-contract';
import type { DocumentRepository } from '../document-repository';
import type { AutomaticTranslationCoordinator } from '../automatic-translation';
import type { AutomaticTranslationIntent } from '../../../../src/subtitle-studio/automatic-translation-contract';
import { captureSourceInput } from '../source-location-service';
import { createTranscriptionDocumentSink } from './document-sink';
import { createTranscriptionDocumentProducer } from './document-producer';
import type { TranscriptionExecutor, TranscriptionBatchExecutionContext, TranscriptionTaskExecutionContext } from './transcript-executor';
import type { LocalSubtitleCapabilityLeaseCoordinator, LocalSubtitleInputAuthorizationRegistry, LocalSubtitleOwnerKey,
  LocalSubtitleFileIdentity } from './native/authorizations';
import { isLocalSubtitleVerifiedBackendResolution } from './native/backend-resolver';
import { sameLocalSubtitleFileIdentity } from './native/filesystem-object-identity';
import type { LocalSubtitleJobBackendResolver, LocalSubtitleJobModelResolver, LocalSubtitleJobTaskUpdate } from './native/job-manager';
import type { LocalSubtitleMediaNormalizer } from './native/media-normalizer';
import type { LocalSubtitleServerManagedResourceIdentity } from './native/server-process-contract';
import { LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION } from './native/accelerator-manager';

type Managed = LocalSubtitleServerManagedResourceIdentity<'managed'>;
type Execution = Omit<TranscriptionBatchExecutionContext, 'signal'>;
type PublicError = NonNullable<TranscriptionTaskSummary['error']>;
interface Record {
  readonly owner: LocalSubtitleOwnerKey; readonly ownerKey: string; readonly taskId: string; readonly fileToken: string;
  readonly sourceKey: string; readonly inputIdentity: LocalSubtitleFileIdentity; readonly audioStreamId?: string;
  readonly execution: Execution; readonly controller: AbortController;
  summary: TranscriptionTaskSummary; running: boolean; leased: boolean; selectionBound: boolean; cleanupPending: boolean;
  leaseFailure?: unknown;
  automatic?: { intent: AutomaticTranslationIntent; apiKey?: string };
}
interface Admission {
  readonly ownerKey: string; readonly modelId: string; readonly vad: boolean; readonly device: string;
  readonly controller: AbortController; readonly count: number;
  detach?: () => void;
  state: 'pending' | 'ready' | 'skipped'; records: Record[];
}
interface Owner {
  readonly owner: LocalSubtitleOwnerKey; readonly key: string;
  released: boolean; releaseOperation?: Promise<void>; timer?: () => void; renewal?: Promise<void>;
}
export interface TranscriptionTaskServiceOptions {
  readonly repository: DocumentRepository;
  readonly inputs: LocalSubtitleInputAuthorizationRegistry;
  readonly leases: LocalSubtitleCapabilityLeaseCoordinator;
  readonly media: Pick<LocalSubtitleMediaNormalizer, 'verifyRuntime' | 'bindTaskMediaSelection' | 'releaseTaskMediaSelection'>;
  readonly modelResolver: LocalSubtitleJobModelResolver;
  readonly backendResolver: LocalSubtitleJobBackendResolver;
  readonly executor: Pick<TranscriptionExecutor, 'beginBatchSlice' | 'execute' | 'endBatchSlice'>;
  readonly leaseRenewalIntervalMs?: number;
  readonly scheduleLeaseRenewal?: (operation: () => void, delayMs: number) => () => void;
  readonly automaticTranslation?: Pick<AutomaticTranslationCoordinator, 'handoff'>;
}

const ownerSchema = z.object({ webContentsId: z.number().int().positive().safe(),
  ownerSessionId: z.string().min(1).max(128).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)) }).strict();
const keyOf = (owner: LocalSubtitleOwnerKey) => JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
const terminal = (record: Record) => ['completed', 'failed', 'cancelled'].includes(record.summary.status);
const cleanupError = () => createLocalSubtitleError('cleanup_failed', 'Transcription cleanup failed.', { stage: 'cleanup' });
const timestamp = () => new Date().toISOString();

/** Ephemeral document-producing queue. Native proofs and capabilities never cross this boundary. */
export function createTranscriptionTaskService(options: TranscriptionTaskServiceOptions) {
  const records = new Map<string, Record>();
  const owners = new Map<string, Owner>();
  const admissions = new Set<Admission>();
  const tickets: Admission[] = [];
  const sourceClaims = new Set<string>();
  const operations = new Map<Promise<unknown>, string>();
  const waiters = new Set<{ ownerKey?: string; resolve: () => void }>();
  let active: Record | undefined;
  let closed = false;
  let scheduled = false;
  let shutdownOperation: Promise<void> | undefined;
  const interval = options.leaseRenewalIntervalMs ?? Math.max(1, Math.floor(options.inputs.leaseTtlMs / 3));
  if (!Number.isSafeInteger(interval) || interval < 1 || interval >= options.inputs.leaseTtlMs) throw new StudioError('invalid_input');
  const scheduleRenewal = options.scheduleLeaseRenewal ?? ((operation: () => void, delay: number) => {
    const handle = setTimeout(operation, delay); handle.unref?.(); return () => clearTimeout(handle);
  });

  function ownerFor(value: LocalSubtitleOwnerKey, allowReleased = false): Owner {
    const parsed = ownerSchema.safeParse(value);
    if (!parsed.success) throw new StudioError('invalid_input');
    const key = keyOf(parsed.data);
    let owner = owners.get(key);
    if (!allowReleased && (closed || owner?.released)) throw new StudioError('access_denied');
    if (!owner) { owner = { owner: Object.freeze(parsed.data), key, released: false }; owners.set(key, owner); }
    return owner;
  }
  function assertLive(owner: Owner, signal?: AbortSignal) {
    if (closed || owner.released) throw new StudioError('access_denied');
    if (signal?.aborted) throw new StudioError('interrupted');
  }
  function assertActive(record: Record) {
    assertLive(owners.get(record.ownerKey)!, record.controller.signal);
    if (records.get(record.taskId) !== record || terminal(record)) throw new StudioError('interrupted');
    if (record.leaseFailure !== undefined) throw record.leaseFailure;
  }
  function publicSummary(value: TranscriptionTaskSummary): TranscriptionTaskSummary {
    const parsed = transcriptionTaskSummarySchema.parse(value);
    return Object.freeze({ ...parsed, ...(parsed.error ? { error: Object.freeze(parsed.error) } : {}) });
  }
  function update(record: Record, change: Partial<TranscriptionTaskSummary>) {
    record.summary = publicSummary({ ...record.summary, ...change, updatedAt: timestamp() });
  }
  function tracked<T>(promise: Promise<T>, ownerKey: string): Promise<T> {
    operations.set(promise, ownerKey);
    const finish = () => { operations.delete(promise); flushWaiters(); };
    void promise.then(finish, finish);
    return promise;
  }
  function idle(ownerKey?: string) {
    return ![...operations.values()].some(key => ownerKey === undefined || ownerKey === key)
      && ![...records.values()].some(record => (ownerKey === undefined || record.ownerKey === ownerKey) && !terminal(record));
  }
  function flushWaiters() {
    for (const waiter of waiters) if (idle(waiter.ownerKey)) { waiters.delete(waiter); waiter.resolve(); }
  }
  function waitForIdle(value?: LocalSubtitleOwnerKey): Promise<void> {
    const ownerKey = value ? ownerFor(value, true).key : undefined;
    if (idle(ownerKey)) return Promise.resolve();
    return new Promise(resolve => waiters.add({ ownerKey, resolve }));
  }
  function sourceClaim(ownerKey: string, sourceKey: string) { return JSON.stringify([ownerKey, sourceKey]); }
  function releaseBindings(record: Record): unknown[] {
    const failures: unknown[] = [];
    if (record.selectionBound) try { options.media.releaseTaskMediaSelection(record.owner, record.taskId); record.selectionBound = false; }
    catch (error) { failures.push(error); }
    if (record.leased) try { options.inputs.releaseTaskLease(record.owner, record.taskId); record.leased = false; }
    catch (error) { failures.push(error); }
    if (failures.length) { record.cleanupPending = true; update(record, { cleanupPending: true }); }
    return failures;
  }
  function finish(record: Record, change: Partial<TranscriptionTaskSummary>) {
    update(record, { ...change, ...(record.automatic && change.status !== 'completed' ? { automaticTranslation: undefined } : {}) });
    if (record.automatic && change.status !== 'completed') record.automatic.apiKey = undefined;
    if (record.summary.error?.code === 'cleanup_failed' || record.summary.error?.code === 'cancel_failed') record.cleanupPending = true;
    const failures = releaseBindings(record);
    if (record.cleanupPending) update(record, { cleanupPending: true,
      // A committed receipt remains authoritative even if subsequent capability release failed.
      ...(record.summary.status === 'completed' ? {} : { status: 'failed', error: failures.length ? { code: 'cleanup_failed' } : record.summary.error }) });
    if (!record.cleanupPending) sourceClaims.delete(sourceClaim(record.ownerKey, record.sourceKey));
    flushWaiters();
  }
  function schedulePump() {
    if (scheduled) return; scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (active || closed) return;
      while (tickets.length) {
        const ticket = tickets[0]!;
        if (ticket.state === 'pending') return;
        if (ticket.state === 'skipped') { tickets.shift(); continue; }
        const record = ticket.records.shift();
        if (!record) { tickets.shift(); continue; }
        if (terminal(record) || owners.get(record.ownerKey)?.released) continue;
        active = record; record.running = true;
        const work = execute(record).finally(() => { record.running = false; active = undefined; schedulePump(); flushWaiters(); });
        tracked(work, record.ownerKey);
        return;
      }
      flushWaiters();
    });
  }
  async function renew(record: Record) {
    if (!record.leased || terminal(record)) return;
    try { await options.inputs.renewTaskLease(record.owner, record.taskId); }
    catch (error) {
      if (!terminal(record) && !owners.get(record.ownerKey)?.released) {
        record.leaseFailure = error;
        record.controller.abort();
        if (!record.running) finish(record, { status: 'failed', error: publicError(error) });
      }
      throw error;
    }
  }
  function armRenewal(owner: Owner) {
    if (closed || owner.released || owner.timer || owner.renewal
      || ![...records.values()].some(record => record.ownerKey === owner.key && record.leased && !terminal(record))) return;
    try {
      owner.timer = scheduleRenewal(() => {
        owner.timer = undefined;
        if (closed || owner.released) return;
        const work = Promise.allSettled([...records.values()]
          .filter(record => record.ownerKey === owner.key && record.leased && !terminal(record)).map(renew)).then(() => undefined);
        owner.renewal = tracked(work, owner.key);
        void work.finally(() => { owner.renewal = undefined; armRenewal(owner); });
      }, interval);
    } catch (error) {
      for (const record of records.values()) if (record.ownerKey === owner.key && !terminal(record)) {
        record.leaseFailure = error; record.controller.abort();
        if (!record.running) finish(record, { status: 'failed', error: { code: 'cleanup_failed' } });
      }
    }
  }
  async function execute(record: Record) {
    try {
      if (owners.get(record.ownerKey)?.renewal) await waitWhileActive(owners.get(record.ownerKey)!.renewal!, record.controller.signal);
      assertActive(record);
      await renew(record);
      const [model, vad] = await joined([
        options.modelResolver.resolveManagedModel(record.execution.managedModel.id, record.controller.signal),
        record.execution.managedVad ? options.modelResolver.resolveManagedVad(record.execution.managedVad.id, record.controller.signal) : undefined,
      ] as const);
      assertActive(record);
      if (!sameResource(model, record.execution.managedModel) || !sameResource(vad, record.execution.managedVad))
        throw createLocalSubtitleError('model_corrupt', 'Managed transcription resources changed.', { stage: 'loading_model' });
      update(record, { status: 'preparing_media' });
      const batch: TranscriptionBatchExecutionContext = Object.freeze({ ...record.execution, signal: record.controller.signal });
      const task: Omit<TranscriptionTaskExecutionContext, 'batchRuntime'> = Object.freeze({ ...batch,
        taskId: record.taskId, generation: 1, fileToken: record.fileToken,
        ...(record.audioStreamId ? { audioStreamId: record.audioStreamId } : {}),
        update(value: LocalSubtitleJobTaskUpdate) {
          assertActive(record);
          if (value.status === 'exporting') throw new StudioError('unsupported_feature');
          update(record, { status: value.status, progress: Math.max(0, Math.min(100, value.progress.overallProgress)),
            ...(validDuration(value.durationMs) ? { durationMs: value.durationMs } : {}) });
          // The derived executor never reads this legacy callback return value.
          return undefined as unknown as ReturnType<TranscriptionTaskExecutionContext['update']>;
        },
      });
      const sink = createTranscriptionDocumentSink({ repository: options.repository, owner: record.owner,
        taskId: record.taskId, generation: 1, assertActive: () => assertActive(record),
        ...(record.automatic ? { automaticTranslation: record.automatic.intent } : {}),
        async resolveSourceLocation() {
          const input = await options.inputs.resolveTaskLease(record.owner, record.taskId, 'transcribe', record.fileToken);
          const directory = await options.inputs.resolveTaskSourceOutputDirectory(record.owner, record.taskId, record.fileToken);
          const capture = await captureSourceInput(input.filePath, input.identity, directory.identity);
          assertActive(record); return capture;
        } });
      const executor = { beginBatchSlice: options.executor.beginBatchSlice.bind(options.executor),
        execute: options.executor.execute.bind(options.executor),
        async endBatchSlice(runtime: Parameters<TranscriptionExecutor['endBatchSlice']>[0]) {
          try { await options.executor.endBatchSlice(runtime); }
          catch (error) { throw new AggregateError([error], 'Transcription batch cleanup failed.'); }
        } };
      const producer = createTranscriptionDocumentProducer({ executor, sink, batch, task,
        assertActive: () => assertActive(record) });
      const result = await producer.run();
      const duration = validDuration(result.durationMs) ? { durationMs: result.durationMs } : {};
      if (result.status === 'committed') {
        finish(record, { status: 'completed', progress: 100, documentId: result.documentId, documentDurability: result.durability, ...duration });
        if (record.automatic) {
          const apiKey = record.automatic.apiKey ?? ''; record.automatic.apiKey = undefined;
          try {
            // Publication transferred ownership to the durable document. A late ASR
            // owner release must not invalidate its already-authorized translation.
            const translation = await options.automaticTranslation!.handoff(result.documentId, record.automatic.intent.intentId, apiKey);
            update(record, { automaticTranslation: { status: 'admitted', taskId: translation.taskId } });
          } catch {
            // Never turn a committed transcription into a retryable ASR failure.
            update(record, { automaticTranslation: { status: 'needs_configuration' } });
          }
        }
      }
      else if (result.status === 'failed') finish(record, { status: 'failed', error: publicError(result.error), ...duration });
      else finish(record, { status: record.leaseFailure ? 'failed' : 'cancelled',
        ...(record.leaseFailure ? { error: publicError(record.leaseFailure) } : {}), ...duration });
    } catch (error) {
      const code = publicError(record.leaseFailure ?? error);
      const cleanup = code.code === 'cleanup_failed' || code.code === 'cancel_failed';
      finish(record, { status: !cleanup && !record.leaseFailure && record.controller.signal.aborted ? 'cancelled' : 'failed',
        ...(!cleanup && !record.leaseFailure && record.controller.signal.aborted ? {} : { error: code }) });
    }
  }

  function enqueue(value: LocalSubtitleOwnerKey, request: EnqueueTranscriptionRequest, signal?: AbortSignal): Promise<TranscriptionBatchAdmission> {
    const owner = ownerFor(value);
    const parsed = enqueueTranscriptionRequestSchema.safeParse(request);
    if (!parsed.success) return Promise.reject(new StudioError('invalid_input'));
    if (parsed.data.autoTranslation && !options.automaticTranslation) return Promise.reject(new StudioError('needs_configuration'));
    if (signal?.aborted) return Promise.reject(new StudioError('interrupted'));
    if (records.size + [...admissions].reduce((sum, admission) => sum + admission.count, 0) + parsed.data.files.length > LOCAL_SUBTITLE_LIMITS.maxSessionTasks)
      return Promise.reject(new StudioError('limit_exceeded'));
    // Synchronous ticket acquisition preserves invocation order across asynchronous authorities.
    const admission: Admission = { ownerKey: owner.key, modelId: parsed.data.config.modelId, vad: parsed.data.config.vadEnabled,
      device: parsed.data.config.devicePreference, controller: new AbortController(), count: parsed.data.files.length, state: 'pending', records: [] };
    admissions.add(admission); tickets.push(admission);
    if (signal) {
      const abort = () => { admission.state = 'skipped'; admission.controller.abort(); schedulePump(); };
      signal.addEventListener('abort', abort, { once: true });
      admission.detach = () => signal.removeEventListener('abort', abort);
    }
    return tracked(admit(owner, admission, parsed.data), owner.key);
  }
  async function admit(owner: Owner, admission: Admission, request: EnqueueTranscriptionRequest): Promise<TranscriptionBatchAdmission> {
    let transaction: Awaited<ReturnType<LocalSubtitleCapabilityLeaseCoordinator['reserveBatch']>> | undefined;
    const claims: string[] = [];
    const created: Record[] = [];
    let published = false;
    let admissionFailed = false;
    let admissionFailure: unknown;
    try {
      const signal = admission.controller.signal;
      const batchId = randomUUID();
      const [managedModel, managedVad, inputs, runtime] = await joined([
        options.modelResolver.resolveManagedModel(request.config.modelId, signal),
        request.config.vadEnabled ? options.modelResolver.resolveManagedVad(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id, signal) : undefined,
        joined(request.files.map(file => options.inputs.resolveDraft(owner.owner, file.fileToken, 'transcribe'))),
        options.media.verifyRuntime({ owner: owner.owner, signal }),
      ] as const);
      assertLive(owner, signal);
      assertModel(managedModel, request.config.modelId);
      if (request.config.vadEnabled) { assertModel(managedVad!, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id);
        if (managedVad!.sha256 !== LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256) throw new StudioError('invalid_input'); }
      if (!/^[a-f0-9]{64}$/.test(runtime.runtimeGeneration)) throw new StudioError('invalid_input');
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index]!;
        if (inputs.slice(0, index).some(other => sameLocalSubtitleFileIdentity(other.identity, input.identity))) throw new StudioError('invalid_input');
        const claim = sourceClaim(owner.key, input.sourceKey);
        if (sourceClaims.has(claim)) throw createLocalSubtitleError('resource_busy', 'This source already has an active transcription.');
        sourceClaims.add(claim); claims.push(claim);
      }
      const backendResolution = await options.backendResolver.resolveBackend({ model: managedModel,
        devicePreference: request.config.devicePreference, admittedRuntimeGeneration: runtime.runtimeGeneration, signal });
      assertLive(owner, signal);
      if (!isLocalSubtitleVerifiedBackendResolution(backendResolution)
        || backendResolution.runtimeGeneration !== runtime.runtimeGeneration || backendResolution.model.id !== managedModel.id
        || backendResolution.model.sha256 !== managedModel.sha256 || backendResolution.devicePreference !== request.config.devicePreference)
        throw new StudioError('invalid_input');
      const config = freezeConfig(request, managedModel, backendResolution.resolvedBackend);
      const execution: Execution = Object.freeze({ owner: owner.owner, batchId, config,
        managedModel: Object.freeze({ ...managedModel }), ...(managedVad ? { managedVad: Object.freeze({ ...managedVad }) } : {}),
        admittedRuntimeGeneration: runtime.runtimeGeneration, backendResolution });
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index]!, file = request.files[index]!, taskId = randomUUID(), now = timestamp();
        created.push({ owner: owner.owner, ownerKey: owner.key, taskId, fileToken: file.fileToken, sourceKey: input.sourceKey,
          inputIdentity: input.identity, ...(file.audioStreamId ? { audioStreamId: file.audioStreamId } : {}), execution,
          controller: new AbortController(), running: false, leased: false, selectionBound: false, cleanupPending: false,
          ...(request.autoTranslation ? { automatic: { apiKey: request.autoTranslation.apiKey,
            intent: { intentId: randomUUID(), sourceTaskId: taskId, generation: 1 as const, config: structuredClone(request.autoTranslation.config), state: 'pending' as const } } } : {}),
          summary: publicSummary({ taskId, batchId, generation: 1, displayName: input.displayName, status: 'queued', progress: 0,
            createdAt: now, updatedAt: now, modelId: managedModel.id, resolvedBackend: backendResolution.resolvedBackend,
            ...(request.autoTranslation ? { automaticTranslation: { status: 'pending' as const } } : {}) }) });
      }
      transaction = await options.leases.reserveBatch({ owner: owner.owner, batchId,
        inputs: created.map(record => ({ fileToken: record.fileToken, taskId: record.taskId })) });
      assertLive(owner, signal);
      for (const record of created) if (record.audioStreamId) {
        record.selectionBound = true;
        options.media.bindTaskMediaSelection({ owner: owner.owner, taskId: record.taskId, fileToken: record.fileToken,
          audioStreamId: record.audioStreamId, inputIdentity: record.inputIdentity, runtimeGeneration: runtime.runtimeGeneration });
      }
      transaction.commitAndRun(() => {
        assertLive(owner, signal);
        for (const record of created) { record.leased = true; records.set(record.taskId, record); }
      });
      transaction = undefined; published = true;
      admission.records = created; admission.state = 'ready';
      armRenewal(owner); schedulePump();
      return Object.freeze({ batchId, tasks: Object.freeze(created.map(record => record.summary)) });
    } catch (error) {
      admissionFailed = true; admissionFailure = error; throw error;
    } finally {
      const failures: unknown[] = [];
      if (!published) {
        try { transaction?.rollback(); } catch (error) { failures.push(error); }
        for (const record of created) {
          failures.push(...releaseBindings(record));
          if (record.cleanupPending) { records.set(record.taskId, record); finish(record, { status: 'failed', error: { code: 'cleanup_failed' } }); }
          else records.delete(record.taskId);
        }
        for (const claim of claims) if (!created.some(record => record.cleanupPending && sourceClaim(owner.key, record.sourceKey) === claim)) sourceClaims.delete(claim);
        admission.state = 'skipped';
      }
      admission.detach?.(); admissions.delete(admission); schedulePump(); flushWaiters();
      if (failures.length) throw new AggregateError(admissionFailed ? [admissionFailure, ...failures] : failures, 'Transcription admission cleanup failed.');
    }
  }
  function owned(value: LocalSubtitleOwnerKey, taskId: string) {
    const owner = ownerFor(value), record = records.get(taskId);
    if (!record || record.ownerKey !== owner.key) throw new StudioError('access_denied');
    return record;
  }
  function fence(owner: Owner) {
    owner.released = true;
    for (const admission of admissions) if (admission.ownerKey === owner.key) { admission.state = 'skipped'; admission.controller.abort(); }
    for (const record of records.values()) if (record.ownerKey === owner.key && !terminal(record)) {
      record.controller.abort();
      if (!record.running) finish(record, { status: 'cancelled' });
    }
    schedulePump();
  }
  async function cleanupOwner(owner: Owner) {
    const failures: unknown[] = [];
    if (owner.timer) try { owner.timer(); owner.timer = undefined; } catch (error) { failures.push(error); }
    await waitForIdle(owner.owner);
    for (const record of records.values()) if (record.ownerKey === owner.key) {
      failures.push(...releaseBindings(record));
      if (terminal(record) && !record.running && !record.cleanupPending) {
        records.delete(record.taskId); sourceClaims.delete(sourceClaim(record.ownerKey, record.sourceKey));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Transcription owner cleanup failed.');
  }
  function releaseOwner(value: LocalSubtitleOwnerKey): Promise<void> {
    const owner = ownerFor(value, true);
    if (owner.releaseOperation) return owner.releaseOperation;
    const operation = Promise.resolve().then(() => cleanupOwner(owner));
    owner.releaseOperation = operation;
    void operation.catch(() => { if (owner.releaseOperation === operation) owner.releaseOperation = undefined; });
    fence(owner);
    return operation;
  }
  function shutdown(_reason?: unknown): Promise<void> {
    if (shutdownOperation) return shutdownOperation;
    closed = true;
    const operation = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...owners.values()].map(cleanupOwner));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Transcription task shutdown failed.');
    });
    shutdownOperation = operation;
    void operation.catch(() => { if (shutdownOperation === operation) shutdownOperation = undefined; });
    for (const owner of owners.values()) fence(owner);
    return operation;
  }
  return Object.freeze({ enqueue, waitForIdle, releaseOwner, shutdown,
    list(value: LocalSubtitleOwnerKey): readonly TranscriptionTaskSummary[] {
      const owner = ownerFor(value); return Object.freeze([...records.values()].filter(record => record.ownerKey === owner.key).map(record => record.summary));
    },
    cancel(value: LocalSubtitleOwnerKey, taskId: string): TranscriptionTaskSummary {
      const record = owned(value, taskId);
      if (!terminal(record)) { record.controller.abort(); if (!record.running) finish(record, { status: 'cancelled' }); schedulePump(); }
      return record.summary;
    },
    remove(value: LocalSubtitleOwnerKey, taskId: string): void {
      const record = owned(value, taskId);
      if (!terminal(record) || record.running || record.cleanupPending) throw new StudioError('invalid_input');
      const failures = releaseBindings(record); if (failures.length) throw cleanupError();
      records.delete(taskId); sourceClaims.delete(sourceClaim(record.ownerKey, record.sourceKey));
    },
    isResourceBusy(resourceId: string): boolean {
      return [...admissions].some(admission => admission.modelId === resourceId
        || (admission.vad && resourceId === LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id)
        || (['auto', 'cuda'].includes(admission.device) && resourceId === LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION.resourceId))
        || [...records.values()].some(record => (!terminal(record) || record.running || record.cleanupPending)
          && (record.execution.managedModel.id === resourceId || record.execution.managedVad?.id === resourceId
            || record.execution.backendResolution.acceleratorPack?.resourceId === resourceId));
    },
    /** Main-only: called after all native runtime cleanup has succeeded. */
    confirmCleanup(): void {
      if (!closed || !idle() || [...records.values()].some(record => record.leased || record.selectionBound)) throw new StudioError('invalid_input');
      records.clear(); sourceClaims.clear(); tickets.length = 0;
    },
  });
}

export type TranscriptionTaskService = ReturnType<typeof createTranscriptionTaskService>;

function publicError(error: unknown): PublicError {
  if (error instanceof AggregateError) return Object.freeze({ code: 'cleanup_failed' });
  if (error && typeof error === 'object') for (const key of ['localSubtitleCode', 'code'] as const) {
    const code = (error as { code?: unknown; localSubtitleCode?: unknown })[key];
    if (typeof code === 'string' && isLocalSubtitleErrorCode(code)) return Object.freeze({ code });
    const studio = errorCodeSchema.safeParse(code); if (studio.success) return Object.freeze({ code: studio.data });
  }
  return Object.freeze({ code: 'transcription_failed' });
}
function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= LOCAL_SUBTITLE_LIMITS.maxDurationMs;
}
/** Join all started authority work, retaining the first rejection instead of orphaning slower siblings. */
async function joined<T extends readonly unknown[]>(values: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  let failed = false;
  let firstFailure: unknown;
  const results = await Promise.allSettled(values.map(value => Promise.resolve(value).catch(error => {
    if (!failed) { failed = true; firstFailure = error; }
    throw error;
  })));
  if (failed) throw firstFailure;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as { [K in keyof T]: Awaited<T[K]> };
}
function waitWhileActive(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new StudioError('interrupted'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new StudioError('interrupted')); };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
function assertModel(model: Managed, id: string) {
  if (!model || model.storage !== 'managed' || model.id !== id || !Number.isSafeInteger(model.byteSize) || model.byteSize <= 0
    || !/^[a-f0-9]{64}$/.test(model.sha256) || typeof model.absolutePath !== 'string' || !model.absolutePath.length)
    throw new StudioError('invalid_input');
}
function sameResource(a: Managed | undefined, b: Managed | undefined) {
  return !a || !b ? a === b : a.storage === b.storage && a.id === b.id && a.absolutePath === b.absolutePath && a.byteSize === b.byteSize && a.sha256 === b.sha256;
}
function freezeConfig(request: EnqueueTranscriptionRequest, model: Managed, backend: Execution['config']['resolvedBackend']): Execution['config'] {
  return Object.freeze({ schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION, serverHttpContractVersion: LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    snapshotId: randomUUID(), createdAt: timestamp(),
    model: Object.freeze({ engine: 'whisper_cpp', engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit, modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
      modelId: model.id, modelHash: model.sha256 }), devicePreference: request.config.devicePreference, resolvedBackend: backend,
    language: request.config.language, taskMode: request.config.taskMode,
    inference: Object.freeze({ cuePolicy: LOCAL_SUBTITLE_CUE_POLICY, windowStrategy: request.config.windowStrategy ?? 'fixed_v1',
      advanced: Object.freeze({ ...request.config.advanced }),
      vad: Object.freeze({ enabled: request.config.vadEnabled, modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
        tokenTimestamps: false, timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy }),
      rawQualityGate: Object.freeze({ maxSegmentDurationMs: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
        repeatedCueThreshold: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCueThreshold,
        repeatedCoverageMs: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.repeatedCoverageMs,
        maxRetryDepth: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth }) }),
  });
}
