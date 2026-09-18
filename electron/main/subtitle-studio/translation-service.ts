import { randomUUID } from 'node:crypto';
import { StudioError } from '../../../src/subtitle-studio/domain';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import { assertExecutionRecordsSize } from '../../../src/subtitle-studio/execution-record-contract';
import type { TranslationConfig, TranslationModel, TranslationPlanSummary, TranslationUsage } from '../../../src/subtitle-studio/translation-contract';
import { validateTranslationResponse } from '../../../src/subtitle-studio/translation-protocol';
import { sendModelRuntimeText, type ModelRuntimeTextRequest, type ModelRuntimeTextResult, type ModelRuntimeUsage } from '../ai/model-runtime-client';
import { ModelRuntimeClientError } from '../ai/model-runtime-errors';
import { DocumentRepository } from './document-repository';
import { buildTranslationRequest, planTranslation, requestTokenEstimate, type TranslationPlan } from './translation-planner';
import { checkpointForPlan, documentSourceDigest, publishTransaction, restoreTranslationPlan, sameTranslationModel, translationScheduler, type TranslationScheduler } from './translation-recovery';
import { assertKnowledgeExecutionCapacity, createExecutionRecord, requestForExecution, resolveExecutionRecord, runtimeExecutionRequest, type PreparedKnowledgeExecution } from './execution-records';
import type { KnowledgeTaskGate, KnowledgeTaskReference } from '../../../src/translation-knowledge/task-reference-contract';
import { knowledgeResourceReferences } from '../../../src/translation-knowledge/snapshot-contract';
import { automaticKnowledgeExecutionPolicy, validateFrozenAutomaticKnowledge } from '../../../src/translation-knowledge/automatic-snapshot-contract';
import { prepareKnowledgeTranslation } from './knowledge-translation';
import type { KnowledgeIssue } from '../../../src/translation-knowledge/execution-contract';
import { createAutomaticKnowledgeReport } from './automatic-knowledge-report';

type Task = DocumentSnapshot['tasks'][number];
type AttemptReceipt = { batchId: string; attempt: number; usage: TranslationUsage; uncertain: boolean };
type Run = { taskId: string; documentId: string; generation: number; controller: AbortController; done: Promise<void>; receipt?: AttemptReceipt; knowledgeReference?: KnowledgeTaskReference };
const activeStatus = (task: Task) => ['queued', 'running'].includes(task.status);
const canResume = (task: Task) => ['failed', 'interrupted', 'needs_configuration'].includes(task.status);

export function normalizeUsage(usage?: ModelRuntimeUsage): TranslationUsage {
  const valid = (value: number | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { inputTokens: valid(usage?.inputTokens), outputTokens: valid(usage?.outputTokens), totalTokens: valid(usage?.totalTokens) };
}
function addUsage(total: TranslationUsage, usage: TranslationUsage) {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const sum = total[key] === null || usage[key] === null ? null : total[key]! + usage[key]!;
    total[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  }
}
function accountAttempt(task: Task, usage: TranslationUsage, uncertain: boolean) {
  const progress = task.translation!;
  const batchId = progress.inFlightBatchId;
  if (!batchId) return;
  addUsage(progress.usage, usage);
  if (uncertain) {
    progress.uncertainAttempts = (progress.uncertainAttempts ?? 0) + 1;
    if (!task.uncertainBatchIds.includes(batchId)) task.uncertainBatchIds.push(batchId);
  }
  delete progress.inFlightBatchId;
}
function interruptTask(task: Task, status: 'interrupted' | 'cancelled', receipt?: AttemptReceipt) {
  if (task.translation) {
    const received = receipt?.batchId === task.translation.inFlightBatchId && receipt?.attempt === task.attempts ? receipt : undefined;
    accountAttempt(task, received?.usage ?? normalizeUsage(), received?.uncertain ?? true);
    if (status === 'interrupted') task.translation.error = 'interrupted';
    else delete task.translation.error;
  }
  task.status = status;
  task.generation++;
}
function failureCode(error: unknown): 'needs_configuration' | 'translation_protocol_invalid' | 'translation_output_limit' | 'translation_record_unavailable' | 'translation_failed' | 'knowledge_check_failed' | 'limit_exceeded' | 'revision_conflict' | 'interrupted' {
  if (error instanceof StudioError && ['needs_configuration', 'translation_protocol_invalid', 'translation_output_limit', 'translation_record_unavailable', 'knowledge_check_failed', 'limit_exceeded', 'revision_conflict', 'interrupted'].includes(error.code)) return error.code as ReturnType<typeof failureCode>;
  if (error instanceof ModelRuntimeClientError) {
    if (['http_unauthorized', 'http_forbidden', 'http_non_retryable'].includes(error.code)) return 'needs_configuration';
    if (error.code === 'length_truncated') return 'translation_output_limit';
    if (['empty_response', 'invalid_response'].includes(error.code)) return 'translation_protocol_invalid';
    if (error.code === 'aborted') return 'interrupted';
  }
  return 'translation_failed';
}
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new StudioError('interrupted')); return; }
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new StudioError('interrupted')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export class TranslationService {
  private plans = new Map<string, { owner: number; created: number; plan: TranslationPlan }>();
  private running = new Map<string, Run>();
  private handles = new Set<Run>();
  private initialized?: Promise<void>;
  private shutdown?: Promise<void>;
  private closed = false;
  private automaticAdmissions = new Map<string, Promise<{ taskId: string }>>();
  constructor(private repository: DocumentRepository, private send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = sendModelRuntimeText,
    private scheduler: TranslationScheduler = translationScheduler, private knowledgeGate?: KnowledgeTaskGate) {}

  /** Physical provider ownership outlives cancellation and retained task deletion. */
  activeKnowledgeReferences(): KnowledgeTaskReference[] {
    return [...this.handles].flatMap(run => run.knowledgeReference ? [structuredClone(run.knowledgeReference)] : []);
  }

  initialize(): Promise<void> {
    if (!this.initialized) this.initialized = (async () => {
      for (const document of await this.repository.list()) {
        const current = await this.repository.readSnapshot(document.id);
        if (!current.tasks.some(activeStatus) && current.automaticTranslation?.state !== 'pending') continue;
        const automatic = current.automaticTranslation?.state === 'pending' ? await this.automaticPlan(current) : undefined;
        await publishTransaction(this.repository, document.id, current.document.revision, value => {
          for (const task of value.tasks) if (activeStatus(task)) interruptTask(task, 'interrupted');
          if (automatic) this.appendAutomaticTask(value, automatic, false);
        }, () => this.assertOpen());
      }
    })().catch(error => {
      // Share an in-flight initialization, but allow retry after a temporary storage failure.
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }
  private assertOpen() { if (this.closed) throw new StudioError('interrupted'); }
  forgetOwner(owner: number) { for (const [id, entry] of this.plans) if (entry.owner === owner) this.plans.delete(id); }

  async plan(owner: number, documentId: string, revision: number, config: TranslationConfig, guard: () => void = () => {}): Promise<TranslationPlanSummary> {
    this.assertOpen(); await this.initialize(); this.assertOpen();
    const doc = await this.repository.read(documentId);
    guard();
    if (doc.revision !== revision) throw new StudioError('revision_conflict');
    const plan = planTranslation(doc, config);
    this.forgetOwner(owner);
    for (const [id, entry] of this.plans) if (Date.now() - entry.created > 15 * 60000) this.plans.delete(id);
    const planId = randomUUID();
    this.plans.set(planId, { owner, created: Date.now(), plan });
    return { planId, documentId, revision, cueCount: plan.batches.reduce((n, batch) => n + batch.units.length, 0), batchCount: plan.batches.length,
      estimatedInputTokens: plan.batches.reduce((n, batch) => n + batch.estimatedInputTokens, 0), outputTokenReserve: plan.batches.length * config.maxOutputTokens,
      contextTokenReserve: plan.batches.reduce((n, batch) => n + batch.priorContextReserve, 0) };
  }

  async start(owner: number, documentId: string, revision: number, planId: string, apiKey: string, guard: () => void = () => {}) {
    this.assertOpen(); await this.initialize(); this.assertOpen();
    const entry = this.plans.get(planId);
    if (!entry || entry.owner !== owner) throw new StudioError('access_denied');
    const { plan } = entry;
    if (Date.now() - entry.created > 15 * 60000 || plan.documentId !== documentId || plan.revision !== revision) throw new StudioError('revision_conflict');
    const result = await this.admit(plan, apiKey, guard);
    this.plans.delete(planId);
    return result;
  }

  /** Main-only batch admission; independent of the single-document preview cache. */
  async startConfigured(documentId: string, revision: number, config: TranslationConfig, apiKey: string, guard: () => void = () => {}) {
    this.assertOpen(); await this.initialize(); this.assertOpen();
    const doc = await this.repository.read(documentId); guard();
    if (doc.revision !== revision) throw new StudioError('revision_conflict');
    return this.admit(planTranslation(doc, config), apiKey, guard);
  }

  /** Main-only prepared admission. Its coordinator owns the shared knowledge gate. */
  async startPreparedKnowledge(input: PreparedKnowledgeExecution, apiKey: string, guard: () => void = () => {}) {
    const prepared = structuredClone(input);
    this.assertOpen(); await this.initialize(); this.assertOpen(); guard();
    return this.admit(prepared.plan, apiKey, guard, prepared);
  }

  private async automaticPlan(snapshot: DocumentSnapshot): Promise<{ plan?: TranslationPlan; knowledge?: PreparedKnowledgeExecution; error?: ReturnType<typeof failureCode>; issues?: KnowledgeIssue[] }> {
    const intent = snapshot.automaticTranslation!;
    try {
      if (!intent.knowledge) return { plan: planTranslation(snapshot.document, intent.config) };
      // The durable pre-transcription material is the only source of knowledge.
      // Initialization uses this same path, with no live-library reads or calls.
      const frozen = validateFrozenAutomaticKnowledge(intent.knowledge);
      if (frozen.selection.languagePair.target !== (intent.config.language === 'zh' ? 'zh-Hans' : intent.config.language)) return { error: 'knowledge_check_failed' };
      const result = await prepareKnowledgeTranslation(this.repository, { documentId: snapshot.document.id, revision: snapshot.document.revision,
        config: intent.config, knowledgeGeneration: frozen.generation,
        knowledge: { ...frozen.selection, bindings: [], confirmations: [] }, documentTopicIds: frozen.documentTopicIds },
      { generation: frozen.generation, data: frozen.data, approvals: frozen.approvals, imports: [] }, () => this.assertOpen(), undefined, automaticKnowledgeExecutionPolicy(frozen.policyVersion));
      if (!result.prepared || !result.preview.canRun) return { error: 'knowledge_check_failed', issues: result.preview.issues };
      return { plan: result.prepared.plan, knowledge: result.prepared, issues: result.preview.issues };
    } catch (error) {
      return { error: intent.knowledge && !(error instanceof StudioError) ? 'knowledge_check_failed' : failureCode(error) };
    }
  }
  private appendAutomaticTask(snapshot: DocumentSnapshot, prepared: Awaited<ReturnType<TranslationService['automaticPlan']>>, launch: boolean): string {
    const intent = snapshot.automaticTranslation!;
    if (intent.state !== 'pending') throw new StudioError('revision_conflict');
    const taskId = randomUUID(), trackId = randomUUID();
    let plan = prepared.plan;
    let preparationError = prepared.error;
    let execution: ReturnType<typeof createExecutionRecord> | undefined;
    if (plan) {
      try {
        execution = createExecutionRecord(plan, documentSourceDigest(snapshot.document), taskId, trackId, prepared.knowledge);
        assertExecutionRecordsSize({ ...snapshot.executionRecords, [execution.record.id]: execution.record });
        if (prepared.knowledge) assertKnowledgeExecutionCapacity(snapshot, execution.record, 64 * 1024);
      } catch (error) {
        // An unpersistable automatic plan must remain visible without blocking startup.
        preparationError = failureCode(error); plan = undefined; execution = undefined;
      }
    }
    const conflict = launch && snapshot.tasks.some(activeStatus);
    const status = !plan || conflict ? 'failed' : launch ? 'queued' : 'needs_configuration';
    const error = preparationError ?? (conflict ? 'revision_conflict' : launch ? undefined : 'needs_configuration');
    const track: DocumentSnapshot['document']['translationTracks'][number] = { id: trackId, revision: 1,
      language: plan?.config.language ?? intent.knowledge?.selection.languagePair.target ?? intent.config.language,
      origin: 'ai', entries: {}, ...(execution ? { executionRef: execution.ref } : {}) };
    const task: Task = { id: taskId, trackId, generation: 1, status, completedBatchIds: [], uncertainBatchIds: [], attempts: 0,
      translation: { config: plan?.config ?? intent.config, totalBatches: plan?.batches.length ?? 1,
        estimatedInputTokens: plan?.batches.reduce((n, batch) => n + batch.estimatedInputTokens, 0) ?? 0,
        outputTokenReserve: (plan?.batches.length ?? 1) * intent.config.maxOutputTokens,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, uncertainAttempts: 0,
        ...(plan && execution ? { checkpoint: checkpointForPlan(plan, snapshot.document, 1, execution.ref) } : {}), ...(error ? { error } : {}) } };
    if (prepared.knowledge && execution) {
      try {
        const candidate = { ...snapshot, document: { ...snapshot.document, translationTracks: [...snapshot.document.translationTracks, track] },
          tasks: [...snapshot.tasks, task], executionRecords: { ...snapshot.executionRecords, [execution.record.id]: execution.record } };
        restoreTranslationPlan(candidate, taskId);
        assertKnowledgeExecutionCapacity(candidate, execution.record);
      } catch (error) {
        task.status = 'failed'; task.translation!.error = failureCode(error);
        delete task.translation!.checkpoint; delete track.executionRef; execution = undefined;
      }
    }
    if (execution) (snapshot.executionRecords ??= {})[execution.record.id] = execution.record;
    snapshot.document.translationTracks.push(track); snapshot.tasks.push(task);
    intent.state = 'admitted'; intent.translationTaskId = taskId;
    if (intent.knowledge && task.status === 'failed') {
      try { intent.preparationReport = createAutomaticKnowledgeReport(snapshot, taskId, task.translation!.error!, prepared.issues); }
      catch {
        try { intent.preparationReport = createAutomaticKnowledgeReport(snapshot, taskId, task.translation!.error!); }
        catch { /* Even unhashable legacy material must still publish a visible failed task. */ }
      }
    }
    return taskId;
  }

  /** Main-only durable handoff. The persisted intent-to-task link is authoritative even
   * after completion; the in-memory Promise only coalesces concurrent callers. */
  startAutomatic(documentId: string, intentId: string, apiKey: string, guard: () => void = () => {}): Promise<{ taskId: string }> {
    const key = JSON.stringify([documentId, intentId]);
    const existing = this.automaticAdmissions.get(key);
    if (existing) return existing;
    const operation = Promise.resolve().then(async () => {
      this.assertOpen(); guard(); await this.initialize(); this.assertOpen(); guard();
      const current = await this.repository.readSnapshot(documentId); guard();
      const intent = current.automaticTranslation;
      if (intent?.state === 'cancelled') throw new StudioError('interrupted');
      if (!intent || intent.intentId !== intentId) throw new StudioError('access_denied');
      const configured = typeof apiKey === 'string' && !!apiKey.trim() && apiKey.length <= 8000;
      if (intent.state === 'admitted') {
        const task = current.tasks.find(task => task.id === intent.translationTaskId)!;
        // A pending intent may have been materialized by initialization just above.
        // Never resume a provider attempt, failure, cancellation or completed task here.
        if (configured && task.status === 'needs_configuration' && task.attempts === 0 && task.translation?.checkpoint) {
          return this.resume(documentId, current.document.revision, task.id, task.translation.config.model, apiKey, guard);
        }
        return { taskId: task.id };
      }
      const prepared = await this.automaticPlan(current);
      let taskId = '';
      const admit = async () => {
        const snapshot = await publishTransaction(this.repository, documentId, current.document.revision, value => {
          if (value.automaticTranslation?.intentId !== intentId) throw new StudioError('revision_conflict');
          taskId = this.appendAutomaticTask(value, prepared, configured);
        }, () => { this.assertOpen(); guard(); });
        if (prepared.plan && snapshot.tasks.find(task => task.id === taskId)?.status === 'queued') this.launch(prepared.plan, snapshot, taskId, apiKey);
        return { taskId };
      };
      return intent.knowledge && this.knowledgeGate ? this.knowledgeGate.run(admit) : admit();
    });
    this.automaticAdmissions.set(key, operation);
    const release = () => { if (this.automaticAdmissions.get(key) === operation) this.automaticAdmissions.delete(key); };
    void operation.then(release, release);
    return operation;
  }

  private async admit(plan: TranslationPlan, apiKey: string, guard: () => void, prepared?: PreparedKnowledgeExecution) {
    const { documentId, revision } = plan;
    if (!apiKey.trim() || apiKey.length > 8000) throw new StudioError('needs_configuration');
    const taskId = randomUUID(); const trackId = randomUUID();
    const snapshot = await publishTransaction(this.repository, documentId, revision, value => {
      if (value.tasks.some(activeStatus)) throw new StudioError('revision_conflict');
      const execution = createExecutionRecord(plan, documentSourceDigest(value.document), taskId, trackId, prepared);
      (value.executionRecords ??= {})[execution.record.id] = execution.record;
      value.document.translationTracks.push({ id: trackId, language: plan.config.language, revision: 1, origin: 'ai', entries: {}, executionRef: execution.ref });
      value.tasks.push({ id: taskId, trackId, generation: 1, status: 'queued', completedBatchIds: [], uncertainBatchIds: [], attempts: 0,
        translation: { config: plan.config, totalBatches: plan.batches.length, estimatedInputTokens: plan.batches.reduce((n, batch) => n + batch.estimatedInputTokens, 0), outputTokenReserve: plan.batches.length * plan.config.maxOutputTokens,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, checkpoint: checkpointForPlan(plan, value.document, 1, execution.ref), uncertainAttempts: 0 } });
      if (prepared) {
        restoreTranslationPlan(value, taskId);
        assertKnowledgeExecutionCapacity(value, execution.record);
      }
    }, () => { this.assertOpen(); guard(); });
    this.launch(plan, snapshot, taskId, apiKey);
    return { taskId };
  }

  async cancel(documentId: string, revision: number, taskId: string, guard: () => void = () => {}): Promise<{ taskId: string }> {
    this.assertOpen(); await this.initialize(); this.assertOpen();
    await publishTransaction(this.repository, documentId, revision, value => {
      const task = value.tasks.find(item => item.id === taskId);
      if (!task || (!activeStatus(task) && !canResume(task))) throw new StudioError('invalid_input');
      const run = this.running.get(taskId);
      interruptTask(task, 'cancelled', run?.generation === task.generation ? run.receipt : undefined);
    }, guard);
    for (const handle of this.handles) if (handle.taskId === taskId) handle.controller.abort();
    return { taskId };
  }

  resume(documentId: string, revision: number, taskId: string, model: TranslationModel | null, apiKey: string, guard: () => void = () => {}): Promise<{ taskId: string }> {
    const resume = () => this.resumeWithinGate(documentId, revision, taskId, model, apiKey, guard);
    return this.knowledgeGate ? this.knowledgeGate.run(resume) : resume();
  }

  private async resumeWithinGate(documentId: string, revision: number, taskId: string, model: TranslationModel | null, apiKey: string, guard: () => void): Promise<{ taskId: string }> {
    this.assertOpen(); await this.initialize(); this.assertOpen();
    const current = await this.repository.readSnapshot(documentId);
    if (current.document.revision !== revision) throw new StudioError('revision_conflict');
    const task = current.tasks.find(item => item.id === taskId);
    if (!task || !canResume(task) || !task.translation?.checkpoint) throw new StudioError('invalid_input');
    const plan = restoreTranslationPlan(current, taskId);
    if (task.translation.checkpoint.version === 2) assertKnowledgeExecutionCapacity(current, resolveExecutionRecord(current, taskId));
    const configured = !!apiKey.trim() && apiKey.length <= 8000 && sameTranslationModel(model, plan.config.model);
    const snapshot = await publishTransaction(this.repository, documentId, revision, value => {
      const currentTask = value.tasks.find(item => item.id === taskId)!;
      if (!canResume(currentTask) || value.tasks.some(item => item.id !== taskId && activeStatus(item))) throw new StudioError('revision_conflict');
      currentTask.generation++;
      currentTask.status = configured ? 'queued' : 'needs_configuration';
      if (configured) delete currentTask.translation!.error;
      else currentTask.translation!.error = 'needs_configuration';
    }, () => { this.assertOpen(); guard(); });
    for (const handle of this.handles) if (handle.taskId === taskId) handle.controller.abort();
    if (configured) this.launch(plan, snapshot, taskId, apiKey);
    return { taskId };
  }

  private launch(plan: TranslationPlan, snapshot: DocumentSnapshot, taskId: string, apiKey: string) {
    const controller = new AbortController();
    const generation = snapshot.tasks.find(task => task.id === taskId)!.generation;
    const unregister = this.repository.registerActivity(plan.documentId, controller);
    const run: Run = { taskId, documentId: plan.documentId, generation, controller, done: Promise.resolve() };
    const task = snapshot.tasks.find(item => item.id === taskId)!;
    if (task.translation?.checkpoint?.version === 2) {
      const record = resolveExecutionRecord(snapshot, taskId);
      if (record.knowledge) run.knowledgeReference = { documentId: plan.documentId, taskId, trackId: task.trackId, recordId: record.id,
        displayName: snapshot.document.origin.displayName, status: 'active', resources: knowledgeResourceReferences(record.knowledge) };
    }
    this.running.set(taskId, run); this.handles.add(run);
    if (this.closed) controller.abort();
    run.done = this.execute(plan, snapshot, run, apiKey).finally(() => {
      unregister(); this.handles.delete(run);
      if (this.running.get(taskId) === run) this.running.delete(taskId);
    });
  }
  async settled(taskId: string) { await this.running.get(taskId)?.done; }
  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true; this.plans.clear();
    this.shutdown = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.automaticAdmissions.values()]);
      await this.interruptOwnedRuns();
    });
    return this.shutdown;
  }
  private async interruptOwnedRuns() {
    const runs = [...this.handles];
    for (const run of runs) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const current = await this.repository.readSnapshot(run.documentId);
          const task = current.tasks.find(item => item.id === run.taskId);
          if (task?.generation === run.generation && activeStatus(task)) await publishTransaction(this.repository, run.documentId, current.document.revision, value => {
            const task = value.tasks.find(item => item.id === run.taskId)!;
            if (task.generation === run.generation && activeStatus(task)) interruptTask(task, 'interrupted', run.receipt);
          });
          break;
        } catch (error) {
          // A concurrent commit can move the revision without taking ownership of this run.
          if (!(error instanceof StudioError) || error.code !== 'revision_conflict') break;
        }
      }
      run.controller.abort();
    }
  }

  private async execute(plan: TranslationPlan, initial: DocumentSnapshot, run: Run, apiKey: string) {
    let snapshot = initial;
    const signal = run.controller.signal;
    let trackRevision = initial.tasks.find(task => task.id === run.taskId)!.translation!.checkpoint!.trackRevision;
    const digest = initial.tasks.find(task => task.id === run.taskId)!.translation!.checkpoint!.sourceDigest;
    const sameGeneration = (value: DocumentSnapshot) => {
      const task = value.tasks.find(item => item.id === run.taskId);
      if (!task || task.generation !== run.generation || !activeStatus(task)) throw new StudioError('revision_conflict');
      return task;
    };
    const ensureActive = (value: DocumentSnapshot) => {
      if (signal.aborted || this.closed) throw new StudioError('interrupted');
      const task = sameGeneration(value);
      const track = value.document.translationTracks.find(item => item.id === task.trackId);
      if (!track || track.revision !== trackRevision || task.translation!.checkpoint!.trackRevision !== trackRevision || documentSourceDigest(value.document) !== digest) throw new StudioError('revision_conflict');
      return { task, track };
    };
    // A failure after current-pointer publication can still represent a complete commit.
    const mutate = async (action: (value: DocumentSnapshot) => void, published: (value: DocumentSnapshot) => boolean) => {
      try {
        snapshot = await this.repository.transact(plan.documentId, snapshot.document.revision, action, () => { if (signal.aborted) throw new StudioError('interrupted'); });
      } catch (error) {
        const current = await this.repository.readSnapshot(plan.documentId);
        if (!signal.aborted && current.tasks.find(task => task.id === run.taskId)?.generation === run.generation && published(current)) { snapshot = current; return; }
        throw error;
      }
    };
    const progressOf = (value: DocumentSnapshot) => value.tasks.find(task => task.id === run.taskId)?.translation;
    try {
      const notBefore = progressOf(snapshot)?.notBefore ?? 0;
      while (notBefore > Date.now()) await wait(Math.min(60000, notBefore - Date.now()), signal);
      for (const [index, batch] of plan.batches.entries()) {
        if (snapshot.tasks.find(task => task.id === run.taskId)!.completedBatchIds.includes(batch.id)) continue;
        const { track } = ensureActive(snapshot);
        const previous = index ? plan.batches[index - 1].units.slice(-2).map(unit => track.entries[unit.cueId]?.text.plain).filter((text): text is string => text !== undefined) : [];
        const frozen = progressOf(snapshot)?.checkpoint?.version === 2 ? requestForExecution(resolveExecutionRecord(snapshot, run.taskId), batch.id, previous) : undefined;
        const request = frozen ? runtimeExecutionRequest(frozen, apiKey, signal) : buildTranslationRequest(plan.config, batch, previous, apiKey, signal);
        if (requestTokenEstimate(request) > batch.estimatedInputTokens || requestTokenEstimate(request) + plan.config.maxOutputTokens > plan.config.contextWindow) throw new StudioError('limit_exceeded');
        for (let attempt = 0; ; attempt++) {
          const release = await this.scheduler.acquire(signal);
          let responseReceived = false;
          let usage: ModelRuntimeUsage | undefined;
          let attempted = false;
          const attemptNumber = snapshot.tasks.find(task => task.id === run.taskId)!.attempts + 1;
          try {
            await mutate(value => {
              const { task } = ensureActive(value);
              if (frozen) {
                const record = resolveExecutionRecord(value, run.taskId);
                const existing = record.requests[batch.id];
                if (existing && existing.digest !== frozen.digest) throw new StudioError('revision_conflict');
                record.requests[batch.id] = frozen;
                value.executionRecords![record.id] = record;
              }
              task.status = 'running'; task.attempts++; task.translation!.inFlightBatchId = batch.id;
              delete task.translation!.notBefore;
            }, value => progressOf(value)?.inFlightBatchId === batch.id && value.tasks.find(task => task.id === run.taskId)?.attempts === attemptNumber
              && (!frozen || resolveExecutionRecord(value, run.taskId).requests[batch.id]?.digest === frozen.digest));
            attempted = true; run.receipt = { batchId: batch.id, attempt: attemptNumber, usage: normalizeUsage(), uncertain: true };
            if (signal.aborted || this.closed) throw new StudioError('interrupted');
            let result: ModelRuntimeTextResult;
            try { result = await this.send(frozen ? runtimeExecutionRequest(frozen, apiKey, signal) : request); } finally { release(); }
            responseReceived = true; usage = result.usage;
            run.receipt = { batchId: batch.id, attempt: attemptNumber, usage: normalizeUsage(usage), uncertain: false };
            if (signal.aborted) throw new StudioError('interrupted');
            if (result.apiFormat === 'chat_completions' && result.finishReason === 'length') throw new StudioError('translation_output_limit');
            if ((result.apiFormat === 'responses' && result.rawStatus && result.rawStatus !== 'completed') || (result.apiFormat === 'chat_completions' && result.finishReason && result.finishReason !== 'stop')) throw new StudioError('translation_protocol_invalid');
            const translations = validateTranslationResponse(result.content, batch.units, plan.config.maxOutputTokens * 16);
            await mutate(value => {
              const { task, track } = ensureActive(value);
              for (const unit of batch.units) track.entries[unit.cueId] = { sourceRevision: unit.sourceRevision, sourceHash: unit.sourceHash, text: translations.get(unit.cueId)!, origin: 'ai', reviewStatus: 'unreviewed' };
              track.revision++; task.translation!.checkpoint!.trackRevision = track.revision;
              accountAttempt(task, normalizeUsage(usage), false);
              task.completedBatchIds.push(batch.id);
              task.uncertainBatchIds = task.uncertainBatchIds.filter(id => id !== batch.id);
              if (index === plan.batches.length - 1) task.status = 'completed';
            }, value => value.tasks.find(task => task.id === run.taskId)?.completedBatchIds.includes(batch.id) === true);
            delete run.receipt; trackRevision++;
            break;
          } catch (error) {
            release();
            if (!attempted) throw error;
            if (error instanceof ModelRuntimeClientError) { usage = error.details.usage; if (error.code === 'length_truncated') responseReceived = true; }
            run.receipt = { batchId: batch.id, attempt: attemptNumber, usage: normalizeUsage(usage), uncertain: !responseReceived };
            if (signal.aborted) throw new StudioError('interrupted');
            const suppliedDelay = error instanceof ModelRuntimeClientError ? error.details.retryAfterMs : undefined;
            const hasSupplierDelay = typeof suppliedDelay === 'number' && Number.isFinite(suppliedDelay) && suppliedDelay >= 0;
            const retryable = error instanceof StudioError ? error.code === 'translation_protocol_invalid' : error instanceof ModelRuntimeClientError && error.code !== 'length_truncated' && error.retryable;
            const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 100);
            const delay = Math.max(hasSupplierDelay ? suppliedDelay : 0, backoff);
            await mutate(value => {
              const { task } = ensureActive(value);
              accountAttempt(task, normalizeUsage(usage), !responseReceived);
              if (hasSupplierDelay || (retryable && attempt < 1)) task.translation!.notBefore = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.ceil(delay));
            }, value => !progressOf(value)?.inFlightBatchId && value.tasks.find(task => task.id === run.taskId)?.attempts === attemptNumber);
            delete run.receipt;
            if (!retryable || attempt >= 1 || delay > 30000) throw error;
            await wait(delay, signal);
          }
        }
      }
    } catch (error) {
      try {
        const current = await this.repository.readSnapshot(plan.documentId);
        await publishTransaction(this.repository, plan.documentId, current.document.revision, value => {
          const task = sameGeneration(value);
          const code = failureCode(error);
          if (run.receipt) accountAttempt(task, run.receipt.usage, run.receipt.uncertain);
          task.status = code === 'interrupted' ? 'interrupted' : code === 'needs_configuration' ? 'needs_configuration' : 'failed';
          task.translation!.error = code;
        });
      } catch { /* A tombstone or a newer generation owns the document; late responses cannot write. */ }
    }
  }
}
