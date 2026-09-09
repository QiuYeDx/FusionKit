import { randomUUID } from 'node:crypto';
import { StudioError } from '../../../src/subtitle-studio/domain';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import type { TranslationConfig, TranslationPlanSummary, TranslationUsage } from '../../../src/subtitle-studio/translation-contract';
import { validateTranslationResponse } from '../../../src/subtitle-studio/translation-protocol';
import { sendModelRuntimeText, type ModelRuntimeTextRequest, type ModelRuntimeTextResult, type ModelRuntimeUsage } from '../ai/model-runtime-client';
import { ModelRuntimeClientError } from '../ai/model-runtime-errors';
import { DocumentRepository } from './document-repository';
import { buildTranslationRequest, planTranslation, requestTokenEstimate, sourceDigest, type TranslationPlan } from './translation-planner';

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
function failureCode(error: unknown): 'needs_configuration' | 'translation_protocol_invalid' | 'translation_output_limit' | 'translation_failed' | 'limit_exceeded' | 'revision_conflict' | 'interrupted' {
  if (error instanceof StudioError && ['needs_configuration', 'translation_protocol_invalid', 'translation_output_limit', 'limit_exceeded', 'revision_conflict', 'interrupted'].includes(error.code)) return error.code as ReturnType<typeof failureCode>;
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
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(private repository: DocumentRepository, private send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = sendModelRuntimeText) {}
  forgetOwner(owner: number) { for (const [id, entry] of this.plans) if (entry.owner === owner) this.plans.delete(id); }
  async plan(owner: number, documentId: string, revision: number, config: TranslationConfig, guard: () => void = () => {}): Promise<TranslationPlanSummary> {
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
    const entry = this.plans.get(planId);
    if (!entry || entry.owner !== owner) throw new StudioError('access_denied');
    const { plan } = entry;
    if (Date.now() - entry.created > 15 * 60000 || plan.documentId !== documentId || plan.revision !== revision) throw new StudioError('revision_conflict');
    if (!apiKey.trim() || apiKey.length > 8000) throw new StudioError('needs_configuration');
    const taskId = randomUUID(); const trackId = randomUUID();
    const snapshot = await this.repository.transact(documentId, revision, value => {
      if (value.tasks.some(task => ['queued', 'running'].includes(task.status))) throw new StudioError('revision_conflict');
      value.document.translationTracks.push({ id: trackId, language: plan.config.language, revision: 1, entries: {} });
      value.tasks.push({ id: taskId, trackId, generation: 1, status: 'queued', completedBatchIds: [], uncertainBatchIds: [], attempts: 0,
        translation: { config: plan.config, totalBatches: plan.batches.length, estimatedInputTokens: plan.batches.reduce((n, batch) => n + batch.estimatedInputTokens, 0), outputTokenReserve: plan.batches.length * plan.config.maxOutputTokens, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } });
    }, guard);
    this.plans.delete(planId);
    const controller = new AbortController();
    const unregister = this.repository.registerActivity(documentId, controller);
    const done = this.execute(plan, snapshot, taskId, apiKey, controller.signal).finally(() => { unregister(); this.running.delete(taskId); });
    this.running.set(taskId, { controller, done });
    return { taskId };
  }
  async settled(taskId: string) { await this.running.get(taskId)?.done; }
  async dispose() {
    this.plans.clear();
    for (const value of this.running.values()) value.controller.abort();
    await Promise.allSettled([...this.running.values()].map(value => value.done));
  }
  private async execute(plan: TranslationPlan, initial: DocumentSnapshot, taskId: string, apiKey: string, signal: AbortSignal) {
    let snapshot = initial;
    let trackRevision = 1;
    let pendingUsage: TranslationUsage | undefined;
    const ensureActive = (value: DocumentSnapshot) => {
      if (signal.aborted) throw new StudioError('interrupted');
      const task = value.tasks.find(item => item.id === taskId);
      const track = value.document.translationTracks.find(item => item.id === task?.trackId);
      if (!task || task.generation !== 1 || !['queued', 'running'].includes(task.status) || !track || track.revision !== trackRevision) throw new StudioError('revision_conflict');
      return { task, track };
    };
    const mutate = async (action: (value: DocumentSnapshot) => void) => {
      snapshot = await this.repository.transact(plan.documentId, snapshot.document.revision, action, () => { if (signal.aborted) throw new StudioError('interrupted'); });
    };
    try {
      for (let index = 0; index < plan.batches.length; index++) {
        const batch = plan.batches[index];
        const { track } = ensureActive(snapshot);
        const previous = index ? plan.batches[index - 1].units.slice(-2).map(unit => track.entries[unit.cueId]?.text.plain).filter((text): text is string => text !== undefined) : [];
        const request = buildTranslationRequest(plan.config, batch, previous, apiKey, signal);
        if (requestTokenEstimate(request) > batch.estimatedInputTokens || requestTokenEstimate(request) + plan.config.maxOutputTokens > plan.config.contextWindow) throw new StudioError('limit_exceeded');
        for (let attempt = 0; ; attempt++) {
          await mutate(value => { const { task } = ensureActive(value); task.status = 'running'; task.attempts++; });
          let usage: ModelRuntimeUsage | undefined;
          let responseReceived = false;
          try {
            pendingUsage = normalizeUsage();
            const result = await this.send(request);
            responseReceived = true; usage = result.usage;
            pendingUsage = normalizeUsage(usage);
            if (result.apiFormat === 'chat_completions' && result.finishReason === 'length') throw new StudioError('translation_output_limit');
            if ((result.apiFormat === 'responses' && result.rawStatus && result.rawStatus !== 'completed') || (result.apiFormat === 'chat_completions' && result.finishReason && result.finishReason !== 'stop')) throw new StudioError('translation_protocol_invalid');
            const translations = validateTranslationResponse(result.content, batch.units, plan.config.maxOutputTokens * 16);
            await mutate(value => {
              const { task, track } = ensureActive(value);
              for (const unit of batch.units) {
                const cue = value.document.cues.find(item => item.id === unit.cueId);
                if (!cue || cue.sourceRevision !== unit.sourceRevision || sourceDigest(cue) !== unit.sourceHash) throw new StudioError('revision_conflict');
                track.entries[unit.cueId] = { sourceRevision: unit.sourceRevision, sourceHash: unit.sourceHash, text: translations.get(unit.cueId)!, origin: 'ai', reviewStatus: 'unreviewed' };
              }
              track.revision++;
              task.completedBatchIds.push(batch.id);
              task.uncertainBatchIds = task.uncertainBatchIds.filter(id => id !== batch.id);
              addUsage(task.translation!.usage, normalizeUsage(usage));
              if (index === plan.batches.length - 1) task.status = 'completed';
            });
            pendingUsage = undefined;
            trackRevision++;
            break;
          } catch (error) {
            if (error instanceof ModelRuntimeClientError) {
              usage = error.details.usage;
              if (error.code === 'length_truncated') responseReceived = true;
            }
            pendingUsage = normalizeUsage(usage);
            if (signal.aborted) throw new StudioError('interrupted');
            await mutate(value => {
              const { task } = ensureActive(value);
              addUsage(task.translation!.usage, normalizeUsage(usage));
              if (!responseReceived && !task.uncertainBatchIds.includes(batch.id)) task.uncertainBatchIds.push(batch.id);
            });
            pendingUsage = undefined;
            const retryable = error instanceof StudioError ? error.code === 'translation_protocol_invalid' : error instanceof ModelRuntimeClientError && error.code !== 'length_truncated' && error.retryable;
            const delay = error instanceof ModelRuntimeClientError ? error.details.retryAfterMs ?? 500 : 500;
            if (!retryable || attempt >= 1 || delay > 30000) throw error;
            await wait(Math.max(0, delay), signal);
          }
        }
      }
    } catch (error) {
      try {
        const current = await this.repository.readSnapshot(plan.documentId);
        await this.repository.transact(plan.documentId, current.document.revision, value => {
          const task = value.tasks.find(item => item.id === taskId);
          if (!task || task.generation !== 1 || !['queued', 'running'].includes(task.status)) throw new StudioError('revision_conflict');
          const code = failureCode(error);
          task.status = code === 'interrupted' ? 'interrupted' : code === 'needs_configuration' ? 'needs_configuration' : 'failed';
          task.translation!.error = code;
          if (pendingUsage) addUsage(task.translation!.usage, pendingUsage);
        });
      } catch { /* Deletion or a newer task generation owns the state now. */ }
    }
  }
}
