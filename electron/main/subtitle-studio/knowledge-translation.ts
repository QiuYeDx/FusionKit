import { randomUUID } from 'node:crypto';
import { StudioError } from '../../../src/subtitle-studio/domain';
import { normalizeTranslationModel, translationConfigSchema } from '../../../src/subtitle-studio/translation-contract';
import { projectTranslationUnits } from '../../../src/subtitle-studio/translation-protocol';
import { knowledgeTranslationRequestSchemas, type KnowledgeTranslationPreview, type KnowledgeTranslationRequest } from '../../../src/subtitle-studio/knowledge-translation-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import type { CompiledKnowledge, KnowledgeIssue, KnowledgeSelection } from '../../../src/translation-knowledge/execution-contract';
import { resolveEnvironment } from '../../../src/translation-knowledge/execution';
import { buildFrozenKnowledgeSnapshot, knowledgeResourceReferences } from '../../../src/translation-knowledge/snapshot-contract';
import type { KnowledgeTaskGate } from '../../../src/translation-knowledge/task-reference-contract';
import { sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import type { DocumentRepository } from './document-repository';
import type { TranslationService } from './translation-service';
import { sourceDigest, type TranslationPlan } from './translation-planner';
import { documentSourceDigest } from './translation-recovery';
import { assertKnowledgeExecutionCapacity, createExecutionRecord, freezeExecutionRequest, type PreparedKnowledgeExecution } from './execution-records';
import { planKnowledgeBatches, type PreparedKnowledgeBatch } from './knowledge-planner';

/** Each window also retains the resolver's 8 MiB scan / 1M conflict-comparison cap. */
export const KNOWLEDGE_TRANSLATION_LIMITS = Object.freeze({
  cues: 2000, windowCues: 20, scanBytes: 128 * 1024 * 1024, planningBytes: 128 * 1024 * 1024,
  preparedBytes: 16 * 1024 * 1024, diagnosticBytes: 4 * 1024 * 1024, cachedBytes: 32 * 1024 * 1024, plans: 32,
});
const PLAN_LIFETIME = 15 * 60 * 1000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const yieldWindow = () => new Promise<void>(resolve => setImmediate(resolve));
type CachedPlan = { owner: number; epoch: number; generation: number; preview: KnowledgeTranslationPreview; prepared?: PreparedKnowledgeExecution; started: boolean; bytes: number };

function scopedSelection(selection: KnowledgeSelection, documentTopicIds: string[], cueIds: string[]): KnowledgeSelection {
  const current = new Set(cueIds);
  const bindings = selection.bindings.flatMap(binding => {
    const ids = binding.cueIds.filter(id => current.has(id));
    return ids.length ? [{ ...binding, cueIds: ids }] : [];
  });
  for (const subjectId of documentTopicIds) {
    const existing = bindings.find(binding => binding.subjectId === subjectId && binding.role === 'topic');
    if (existing) existing.cueIds = [...cueIds];
    else bindings.push({ subjectId, role: 'topic', cueIds: [...cueIds] });
  }
  if (bindings.length > 100) throw new StudioError('limit_exceeded');
  return { ...selection, bindings, confirmations: selection.confirmations.flatMap(value => {
    const ids = value.cueIds.filter(id => current.has(id));
    return ids.length ? [{ ...value, cueIds: ids }] : [];
  }) };
}

function scanCost(library: LibrarySnapshot, selection: KnowledgeSelection) {
  const recipe = library.data.recipes.find(item => item.id === selection.recipeId);
  const collections = new Set([...selection.collectionIds, ...(recipe?.readCollectionIds ?? [])]);
  let variants = 0, textBytes = 0;
  for (const entry of library.data.entries) if (collections.has(entry.collectionId)) {
    if (entry.kind === 'term') {
      variants += entry.payload.aliases.length + 1;
      textBytes += [entry.payload.source, ...entry.payload.aliases, entry.payload.target].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    } else if (entry.kind === 'rule') textBytes += Buffer.byteLength(entry.payload.text);
  }
  return { variants, textBytes };
}

/** Planning owns no task. Only a verified, generation-bound plan can enter formal execution. */
export class KnowledgeTranslationService {
  private readonly plans = new Map<string, CachedPlan>();
  private readonly epochs = new Map<number, number>();
  private readonly pending = new Map<number, Set<Promise<unknown>>>();
  private closed = false;
  private shutdown?: Promise<void>;
  constructor(private readonly repository: DocumentRepository, private readonly translation: TranslationService,
    private readonly readKnowledge: () => Promise<LibrarySnapshot>, private readonly gate: KnowledgeTaskGate) {}

  private track<T>(owner: number, operation: Promise<T>): Promise<T> {
    const pending = this.pending.get(owner) ?? new Set<Promise<unknown>>();
    pending.add(operation); this.pending.set(owner, pending);
    const release = () => { pending.delete(operation); if (!pending.size && this.pending.get(owner) === pending) this.pending.delete(owner); };
    void operation.then(release, release);
    return operation;
  }
  private replace(owner: number) {
    const epoch = (this.epochs.get(owner) ?? 0) + 1;
    this.epochs.set(owner, epoch);
    for (const [id, plan] of this.plans) if (plan.owner === owner) this.plans.delete(id);
    return epoch;
  }
  private alive(owner: number, epoch: number, guard: () => void) {
    guard();
    if (this.closed || this.epochs.get(owner) !== epoch) throw new StudioError('access_denied');
  }

  plan(owner: number, input: KnowledgeTranslationRequest, guard: () => void = () => {}): Promise<KnowledgeTranslationPreview> {
    const parsed = knowledgeTranslationRequestSchemas.planKnowledgeTranslation.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(owner)) return Promise.reject(new StudioError('invalid_input'));
    if (this.closed) return Promise.reject(new StudioError('access_denied'));
    const epoch = this.replace(owner), request = parsed.data;
    const alive = () => this.alive(owner, epoch, guard);
    return this.track(owner, (async () => {
      alive();
      const initial = await this.repository.readSnapshot(request.documentId); alive();
      const document = initial.document;
      if (document.revision !== request.revision) throw new StudioError('revision_conflict');
      const sourceCount = document.cues.filter(cue => /\S/u.test(cue.source.plain)).length;
      if (!sourceCount) throw new StudioError('invalid_input');
      if (sourceCount > KNOWLEDGE_TRANSLATION_LIMITS.cues) throw new StudioError('limit_exceeded');
      const originals = new Map(document.cues.map(cue => [cue.id, cue]));
      if ([...request.knowledge.bindings, ...request.knowledge.confirmations].some(binding => binding.cueIds.some(id => !originals.has(id)))) throw new StudioError('invalid_input');
      const units = projectTranslationUnits(document).map(unit => ({ ...unit, sourceHash: sourceDigest(originals.get(unit.cueId)!) }));
      const translatable = new Set(units.map(unit => unit.cueId));
      if ([...request.knowledge.bindings, ...request.knowledge.confirmations].some(binding => binding.cueIds.some(id => !translatable.has(id)))) throw new StudioError('invalid_input');
      const library = structuredClone(await this.readKnowledge()); alive();
      if (library.generation !== request.knowledgeGeneration) throw new StudioError('revision_conflict');
      const selection = structuredClone(request.knowledge);
      if (selection.instructions === undefined && request.config.instructions) selection.instructions = request.config.instructions;
      const config = translationConfigSchema.parse({ ...request.config, language: selection.languagePair.target, instructions: '' });
      config.model = normalizeTranslationModel(config.model);
      const issues = new Map<string, KnowledgeIssue>();
      const mergeIssues = (values: KnowledgeIssue[]) => {
        for (const issue of values) {
          const key = JSON.stringify([issue.code, issue.severity, issue.entryIds]);
          const existing = issues.get(key);
          if (existing) existing.cueIds = !existing.cueIds.length || !issue.cueIds.length ? [] : [...new Set([...existing.cueIds, ...issue.cueIds])];
          else issues.set(key, structuredClone(issue));
        }
      };
      if (request.documentTopicIds.some(id => !library.data.subjects.some(subject => subject.id === id && !subject.archived))) mergeIssues([{ code: 'selection_invalid', severity: 'error', entryIds: [], cueIds: [] }]);
      const indices = new Map(document.cues.map((cue, index) => [cue.id, index]));
      const batches: PreparedKnowledgeBatch[] = [], digests: string[] = [];
      let scanned = 0, material = 0, planning = 0, diagnostics = 0;
      const cost = scanCost(library, selection);
      for (let offset = 0; offset < units.length; offset += KNOWLEDGE_TRANSLATION_LIMITS.windowCues) {
        await yieldWindow(); alive();
        if ([...issues.values()].some(issue => issue.severity === 'error')) break;
        const window = units.slice(offset, offset + KNOWLEDGE_TRANSLATION_LIMITS.windowCues);
        scanned += window.reduce((sum, unit) => sum + Buffer.byteLength(originals.get(unit.cueId)!.source.plain), 0) * cost.variants + window.length * cost.textBytes;
        if (scanned > KNOWLEDGE_TRANSLATION_LIMITS.scanBytes) throw new StudioError('limit_exceeded');
        const environment = resolveEnvironment(library, scopedSelection(selection, request.documentTopicIds, window.map(unit => unit.cueId)), window.map(unit => ({ id: unit.cueId, text: originals.get(unit.cueId)!.source.plain, sourceLanguage: selection.languagePair.source })));
        digests.push(environment.digest);
        const planned = planKnowledgeBatches(document, window, config, environment, { batchOffset: batches.length, priorContextTokens: 512, cueIndices: indices,
          checkCandidate: candidate => {
            const size = bytes(candidate); planning += size;
            if (planning > KNOWLEDGE_TRANSLATION_LIMITS.planningBytes || material + size > KNOWLEDGE_TRANSLATION_LIMITS.preparedBytes) throw new StudioError('limit_exceeded');
          }, acceptBatch: batch => {
            material += bytes(batch);
            if (material > KNOWLEDGE_TRANSLATION_LIMITS.preparedBytes) throw new StudioError('limit_exceeded');
          } });
        diagnostics += bytes(planned.issues);
        if (diagnostics > KNOWLEDGE_TRANSLATION_LIMITS.diagnosticBytes) throw new StudioError('limit_exceeded');
        mergeIssues(planned.issues);
        batches.push(...planned.batches);
      }
      await yieldWindow(); alive();
      const current = await this.repository.readSnapshot(document.id); alive();
      if (current.document.revision !== document.revision || documentSourceDigest(current.document) !== documentSourceDigest(document)) throw new StudioError('revision_conflict');
      const canRun = batches.reduce((sum, item) => sum + item.batch.units.length, 0) === units.length && ![...issues.values()].some(issue => issue.severity === 'error');
      let prepared: PreparedKnowledgeExecution | undefined;
      let knowledgeDigest = sha256Canonical({ generation: library.generation, selection, documentTopicIds: request.documentTopicIds, digests }), resourceCount = 0;
      if (canRun) {
        const compiled: Record<string, CompiledKnowledge> = Object.fromEntries(batches.map(item => [item.batch.id, item.knowledge]));
        const knowledge = buildFrozenKnowledgeSnapshot(library, selection, request.documentTopicIds, compiled);
        const plan: TranslationPlan = { documentId: document.id, revision: document.revision, config, batches: batches.map(item => item.batch) };
        prepared = { plan, sourceDigest: documentSourceDigest(document), knowledge, baseRequests: Object.fromEntries(batches.map(item => [item.batch.id, freezeExecutionRequest(item.batch.id, item.request)])) };
        if (bytes(prepared) > KNOWLEDGE_TRANSLATION_LIMITS.preparedBytes) throw new StudioError('limit_exceeded');
        const { record } = createExecutionRecord(plan, prepared.sourceDigest, randomUUID(), randomUUID(), prepared);
        assertKnowledgeExecutionCapacity(current, record, 64 * 1024);
        knowledgeDigest = knowledge.digest; resourceCount = knowledgeResourceReferences(knowledge).length;
      }
      const preview: KnowledgeTranslationPreview = { planId: randomUUID(), documentId: document.id, revision: document.revision, expiresAt: Date.now() + PLAN_LIFETIME, canRun,
        cueCount: units.length, batchCount: batches.length, estimatedInputTokens: batches.reduce((sum, item) => sum + item.batch.estimatedInputTokens, 0), outputTokenReserve: batches.length * config.maxOutputTokens,
        knowledgeDigest, resourceCount, includedEntryCount: new Set(batches.flatMap(item => item.knowledge.items.map(entry => entry.entryId))).size, issues: [...issues.values()] };
      const size = bytes({ preview, prepared });
      for (const [id, saved] of this.plans) if (!saved.started && saved.preview.expiresAt <= Date.now()) this.plans.delete(id);
      if (this.plans.size >= KNOWLEDGE_TRANSLATION_LIMITS.plans || [...this.plans.values()].reduce((sum, value) => sum + value.bytes, size) > KNOWLEDGE_TRANSLATION_LIMITS.cachedBytes) throw new StudioError('limit_exceeded');
      alive();
      this.plans.set(preview.planId, { owner, epoch, generation: library.generation, preview, prepared, started: false, bytes: size });
      return structuredClone(preview);
    })());
  }

  start(owner: number, input: { planId: string; apiKey: string }, guard: () => void = () => {}): Promise<{ taskId: string }> {
    const parsed = knowledgeTranslationRequestSchemas.createKnowledgeTranslation.safeParse(input);
    if (!parsed.success) return Promise.reject(new StudioError('invalid_input'));
    if (!parsed.data.apiKey.trim()) return Promise.reject(new StudioError('needs_configuration'));
    const plan = this.plans.get(parsed.data.planId);
    if (!plan || plan.owner !== owner || this.closed) return Promise.reject(new StudioError('access_denied'));
    if (plan.started || plan.preview.expiresAt <= Date.now()) return Promise.reject(new StudioError('revision_conflict'));
    if (!plan.preview.canRun || !plan.prepared) return Promise.reject(new StudioError('invalid_input'));
    plan.started = true;
    return this.track(owner, this.gate.run(async () => {
      this.alive(owner, plan.epoch, guard);
      const library = await this.readKnowledge(); this.alive(owner, plan.epoch, guard);
      if (library.generation !== plan.generation || library.maintenance?.cleanupPending) throw new StudioError('revision_conflict');
      const result = await this.translation.startPreparedKnowledge(plan.prepared!, parsed.data.apiKey, () => this.alive(owner, plan.epoch, guard));
      this.plans.delete(parsed.data.planId);
      return result;
    }).catch(error => { if (this.plans.get(parsed.data.planId) === plan) plan.started = false; throw error; }));
  }

  async cancel(owner: number): Promise<void> { this.replace(owner); await Promise.allSettled([...(this.pending.get(owner) ?? [])]); }
  forgetOwner(owner: number): Promise<void> { return this.cancel(owner); }
  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true; this.plans.clear();
    this.shutdown = Promise.allSettled([...this.pending.values()].flatMap(pending => [...pending])).then(() => {});
    return this.shutdown;
  }
}
