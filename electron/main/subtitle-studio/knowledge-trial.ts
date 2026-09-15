import { randomUUID } from 'node:crypto';
import { StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { normalizeTranslationModel, translationConfigSchema, type TranslationConfig, type TranslationUsage } from '../../../src/subtitle-studio/translation-contract';
import { projectTranslationUnits, validateTranslationResponse, type TranslationUnit } from '../../../src/subtitle-studio/translation-protocol';
import { sendModelRuntimeText, type ModelRuntimeTextRequest, type ModelRuntimeTextResult, type ModelRuntimeUsage } from '../ai/model-runtime-client';
import { ModelRuntimeClientError } from '../ai/model-runtime-errors';
import type { DocumentRepository } from './document-repository';
import { requestTokenEstimate, sourceDigest } from './translation-planner';
import { documentSourceDigest, translationScheduler, type TranslationScheduler } from './translation-recovery';
import { knowledgeTrialRequestSchemas, type KnowledgeTrialRequest, type KnowledgeTrialPreview, type KnowledgeTrialResult } from '../../../src/subtitle-studio/knowledge-trial-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { normalizeKnowledgeSelection } from '../../../src/translation-knowledge/execution-contract';
import { resolveEnvironment, checkRequiredTerms } from '../../../src/translation-knowledge/execution';
import { planKnowledgeBatches, type PreparedKnowledgeBatch } from './knowledge-planner';

const MAX_TRIAL_CUES = 20;
const PLAN_LIFETIME = 15 * 60 * 1000;
const MAX_PLANS = 32;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
type PreparedPlan = { owner: number; ownerRevision: number; config: TranslationConfig; preview: KnowledgeTrialPreview; batches: PreparedKnowledgeBatch[]; started: boolean };
type ActiveTrial = { owner: number; controller: AbortController; done: Promise<KnowledgeTrialResult> };

function selectUnits(document: SubtitleDocument, cueIds?: readonly string[]): TranslationUnit[] {
  if (cueIds && (!cueIds.length || cueIds.length > MAX_TRIAL_CUES || new Set(cueIds).size !== cueIds.length)) throw new StudioError('invalid_input');
  const requested = cueIds ? new Set(cueIds) : undefined;
  const cues = requested ? document.cues.filter(cue => requested.has(cue.id)) : document.cues.filter(cue => /\S/u.test(cue.source.plain)).slice(0, MAX_TRIAL_CUES);
  if (requested && cues.length !== requested.size) throw new StudioError('invalid_input');
  const originals = new Map(cues.map(cue => [cue.id, cue]));
  const selectedDocument: SubtitleDocument = document.schemaVersion === 1
    ? { ...document, cues: document.cues.filter(cue => originals.has(cue.id)) }
    : { ...document, cues: document.cues.filter(cue => originals.has(cue.id)) };
  const units = projectTranslationUnits(selectedDocument).map(unit => ({ ...unit, sourceHash: sourceDigest(originals.get(unit.cueId)!) }));
  if (requested && units.length !== requested.size) throw new StudioError('invalid_input');
  return units;
}

function normalizedUsage(usage?: ModelRuntimeUsage): TranslationUsage {
  const valid = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : null;
  return { inputTokens: valid(usage?.inputTokens), outputTokens: valid(usage?.outputTokens), totalTokens: valid(usage?.totalTokens) };
}

function mergeUsage(total: TranslationUsage, next: TranslationUsage): void {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const sum = total[key] === null || next[key] === null ? null : total[key]! + next[key]!;
    total[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  }
}

function providerError(error: unknown): StudioError {
  if (error instanceof StudioError) return error;
  if (error instanceof ModelRuntimeClientError) {
    if (['http_unauthorized', 'http_forbidden', 'http_non_retryable'].includes(error.code)) return new StudioError('needs_configuration');
    if (error.code === 'length_truncated') return new StudioError('translation_output_limit');
    if (['empty_response', 'invalid_response'].includes(error.code)) return new StudioError('translation_protocol_invalid');
    if (error.code === 'aborted') return new StudioError('interrupted');
  }
  return new StudioError('translation_failed');
}

/** A bounded, ephemeral trial owns no translation track, review or learning write.
 * Every admitted provider request is joined on cancellation, owner loss and shutdown. */
export class KnowledgeTrialService {
  private readonly plans = new Map<string, PreparedPlan>();
  private readonly ownerRevisions = new Map<number, number>();
  private readonly active = new Map<number, ActiveTrial>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly detach: () => void;
  private closed = false;
  private shutdown?: Promise<void>;

  constructor(private readonly repository: DocumentRepository, private readonly readKnowledge: () => Promise<LibrarySnapshot>,
    private readonly send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = sendModelRuntimeText,
    private readonly scheduler: TranslationScheduler = translationScheduler, private readonly now: () => number = Date.now) {
    this.detach = repository.subscribe(event => {
      for (const plan of this.plans.values()) if (plan.preview.documentId === event.documentId && (event.deleted || plan.preview.revision !== event.revision)) {
        this.active.get(plan.owner)?.controller.abort();
      }
    });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  private assertOwner(owner: number, revision: number, guard: () => void) {
    guard();
    if (this.closed || (this.ownerRevisions.get(owner) ?? 0) !== revision) throw new StudioError('access_denied');
  }
  private replacePlans(owner: number): number {
    const next = (this.ownerRevisions.get(owner) ?? 0) + 1;
    this.ownerRevisions.set(owner, next);
    for (const [id, plan] of this.plans) if (plan.owner === owner) this.plans.delete(id);
    return next;
  }

  plan(owner: number, input: KnowledgeTrialRequest, guard: () => void = () => {}): Promise<KnowledgeTrialPreview> {
    if (this.closed) return Promise.reject(new StudioError('access_denied'));
    if (this.active.has(owner)) return Promise.reject(new StudioError('resource_busy'));
    const parsed = knowledgeTrialRequestSchemas.planKnowledgeTrial.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(owner)) return Promise.reject(new StudioError('invalid_input'));
    const request = parsed.data;
    const ownerRevision = this.replacePlans(owner);
    const alive = () => this.assertOwner(owner, ownerRevision, guard);
    return this.track((async () => {
      alive();
      const document = await this.repository.read(request.documentId); alive();
      if (document.revision !== request.revision) throw new StudioError('revision_conflict');
      const units = selectUnits(document, request.cueIds);
      const originals = new Map(document.cues.map(cue => [cue.id, cue]));
      const snapshot = structuredClone(await this.readKnowledge()); alive();
      if (snapshot.generation !== request.knowledgeGeneration) throw new StudioError('revision_conflict');
      const selection = normalizeKnowledgeSelection(request.knowledge);
      // An explicit trial value (including empty) overrides the parent form.
      if (selection.instructions === undefined && request.config.instructions) selection.instructions = request.config.instructions;
      const environment = resolveEnvironment(snapshot, selection, units.map(unit => ({ id: unit.cueId, text: originals.get(unit.cueId)!.source.plain, sourceLanguage: selection.languagePair.source })));
      const config = translationConfigSchema.parse({ ...request.config, language: selection.languagePair.target, instructions: '' });
      config.model = normalizeTranslationModel(config.model);
      const { batches, issues } = planKnowledgeBatches(document, units, config, environment);
      const current = await this.repository.read(document.id); alive();
      if (current.revision !== document.revision || documentSourceDigest(current) !== documentSourceDigest(document)) throw new StudioError('revision_conflict');
      const preview: KnowledgeTrialPreview = {
        planId: randomUUID(), documentId: document.id, revision: document.revision, sourceDigest: documentSourceDigest(document), knowledgeDigest: environment.digest,
        expiresAt: this.now() + PLAN_LIFETIME, canRun: batches.reduce((sum, item) => sum + item.batch.units.length, 0) === units.length && !issues.some(issue => issue.severity === 'error'),
        cueCount: units.length, batchCount: batches.length, estimatedInputTokens: batches.reduce((sum, item) => sum + item.batch.estimatedInputTokens, 0), outputTokenReserve: batches.length * config.maxOutputTokens,
        cues: units.map(unit => ({ id: unit.cueId, text: originals.get(unit.cueId)!.source.plain })), issues,
        batches: batches.map(item => ({ id: item.batch.id, cueIds: item.batch.units.map(unit => unit.cueId), knowledge: item.knowledge, estimatedInputTokens: item.batch.estimatedInputTokens })),
      };
      if (Buffer.byteLength(JSON.stringify(preview)) > MAX_PLAN_BYTES) throw new StudioError('limit_exceeded');
      for (const [id, plan] of this.plans) if (!plan.started && plan.preview.expiresAt <= this.now()) this.plans.delete(id);
      if (this.plans.size >= MAX_PLANS) throw new StudioError('limit_exceeded');
      this.plans.set(preview.planId, { owner, ownerRevision, config, preview: structuredClone(preview), batches, started: false });
      return structuredClone(preview);
    })());
  }

  run(owner: number, input: { planId: string; apiKey: string }, guard: () => void = () => {}): Promise<KnowledgeTrialResult> {
    const parsed = knowledgeTrialRequestSchemas.runKnowledgeTrial.safeParse(input);
    if (!parsed.success) return Promise.reject(new StudioError('invalid_input'));
    if (!parsed.data.apiKey.trim()) return Promise.reject(new StudioError('needs_configuration'));
    const plan = this.plans.get(parsed.data.planId);
    if (!plan || plan.owner !== owner || this.closed) return Promise.reject(new StudioError('access_denied'));
    if (this.active.has(owner)) return Promise.reject(new StudioError('resource_busy'));
    if (plan.started || plan.preview.expiresAt <= this.now()) return Promise.reject(new StudioError('revision_conflict'));
    if (!plan.preview.canRun) return Promise.reject(new StudioError('invalid_input'));
    plan.started = true;
    const controller = new AbortController();
    const active: ActiveTrial = { owner, controller, done: Promise.resolve(null as never) };
    this.active.set(owner, active);
    active.done = this.track(this.execute(plan, parsed.data.apiKey, controller, guard).finally(() => {
      if (this.active.get(owner) === active) this.active.delete(owner);
    }));
    return active.done;
  }

  private async execute(plan: PreparedPlan, apiKey: string, controller: AbortController, guard: () => void): Promise<KnowledgeTrialResult> {
    const alive = () => {
      if (controller.signal.aborted) throw new StudioError('interrupted');
      this.assertOwner(plan.owner, plan.ownerRevision, guard);
    };
    const verify = async () => {
      alive();
      const document = await this.repository.read(plan.preview.documentId); alive();
      if (document.revision !== plan.preview.revision || documentSourceDigest(document) !== plan.preview.sourceDigest) throw new StudioError('revision_conflict');
    };
    const unregister = this.repository.registerActivity(plan.preview.documentId, controller);
    const output: KnowledgeTrialResult = { status: 'completed', planId: plan.preview.planId, items: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, requestCount: 0 };
    const sources = new Map(plan.preview.cues.map(cue => [cue.id, cue.text]));
    try {
      await verify();
      for (const prepared of plan.batches) {
        const release = await this.scheduler.acquire(controller.signal);
        let sent = false, accounted = false;
        try {
          await verify();
          // Requests were serialized and budgeted at preview time. Credentials and
          // cancellation are attached only now and are never retained in a plan.
          const request: ModelRuntimeTextRequest = { ...structuredClone(prepared.request), model: { ...prepared.request.model, apiKey }, signal: controller.signal };
          if (requestTokenEstimate(request) !== prepared.batch.estimatedInputTokens || requestTokenEstimate(request) + plan.config.maxOutputTokens > plan.config.contextWindow) throw new StudioError('limit_exceeded');
          output.requestCount++; sent = true;
          const response = await this.send(request);
          mergeUsage(output.usage, normalizedUsage(response.usage)); accounted = true;
          await verify();
          if (response.apiFormat !== plan.config.model.apiFormat) throw new StudioError('translation_protocol_invalid');
          if (response.apiFormat === 'chat_completions' && response.finishReason === 'length') throw new StudioError('translation_output_limit');
          if ((response.apiFormat === 'responses' && response.rawStatus && response.rawStatus !== 'completed') || (response.apiFormat === 'chat_completions' && response.finishReason && response.finishReason !== 'stop')) throw new StudioError('translation_protocol_invalid');
          const translations = validateTranslationResponse(response.content, prepared.batch.units, plan.config.maxOutputTokens * 16);
          const issues = checkRequiredTerms(prepared.knowledge, [...translations].map(([cueId, value]) => ({ cueId, text: value.plain })));
          for (const unit of prepared.batch.units) output.items.push({ cueId: unit.cueId, source: sources.get(unit.cueId)!, target: translations.get(unit.cueId)!.plain, issues: issues.filter(issue => issue.cueIds.includes(unit.cueId)) });
        } catch (error) {
          if (sent && !accounted) mergeUsage(output.usage, normalizedUsage(error instanceof ModelRuntimeClientError ? error.details.usage : undefined));
          throw error;
        } finally { release(); }
      }
      alive();
      return output;
    } catch (error) {
      const failure = providerError(error);
      output.status = controller.signal.aborted || this.closed || failure.code === 'interrupted' || failure.code === 'access_denied' ? 'cancelled' : 'failed';
      output.error = failure.code;
      return output;
    }
    finally { unregister(); }
  }

  forgetOwner(owner: number): void {
    this.replacePlans(owner);
    this.active.get(owner)?.controller.abort();
  }
  async cancel(owner: number): Promise<void> {
    const active = this.active.get(owner);
    this.forgetOwner(owner);
    if (active) await Promise.allSettled([active.done]);
  }
  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true; this.detach(); this.plans.clear();
    for (const active of this.active.values()) active.controller.abort();
    this.shutdown = Promise.allSettled([...this.pending]).then(() => undefined);
    return this.shutdown;
  }
}
