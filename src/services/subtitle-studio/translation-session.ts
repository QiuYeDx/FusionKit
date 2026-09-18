import type { SubtitleStudioApi } from '@/subtitle-studio/ipc-contract';
import { StudioError } from '@/subtitle-studio/domain';
import type { TranslationConfig, TranslationPlanSummary } from '@/subtitle-studio/translation-contract';
import type { TranslationBatchPlan, TranslationBatchResult, DocumentReference } from '@/subtitle-studio/batch-contract';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import type { KnowledgeTranslationPreview } from '@/subtitle-studio/knowledge-translation-contract';
import type { KnowledgeBatchTranslationPreview } from '@/subtitle-studio/knowledge-batch-contract';
import type { KnowledgeTrialPreview, KnowledgeTrialResult } from '@/subtitle-studio/knowledge-trial-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { unwrapStudio } from './client';

export type TranslationSessionInput = {
  documents: DocumentReference[]; batch: boolean; config: TranslationConfig;
  knowledge?: KnowledgeSelection; generation?: number; documentTopicIds: string[]; cueIds: string[];
};
export type TranslationCheck =
  | { kind: 'plain'; value: TranslationPlanSummary }
  | { kind: 'plain-batch'; value: TranslationBatchPlan }
  | { kind: 'knowledge'; value: KnowledgeTranslationPreview }
  | { kind: 'knowledge-batch'; value: KnowledgeBatchTranslationPreview }
  | { kind: 'trial'; value: KnowledgeTrialPreview };
export type TranslationSubmission = { kind: 'single'; taskId: string } | { kind: 'batch'; value: TranslationBatchResult } | { kind: 'trial'; value: KnowledgeTrialResult };
export const readyCount = (check: TranslationCheck): number => check.kind === 'knowledge-batch' ? check.value.readyCount
  : check.kind === 'plain-batch' ? check.value.items.filter(item => item.ok).length
  : check.kind === 'plain' ? 1 : Number(check.value.canRun);
export const partialCheck = (check: TranslationCheck) => (check.kind === 'knowledge-batch' || check.kind === 'plain-batch') && readyCount(check) < check.value.items.length;

// Renderer-owner cleanup is serialized across unmount/remount. Old cleanup may
// never cancel a newly opened session's plan after it finishes.
let cleanup: Promise<unknown> = Promise.resolve();
type PlanKind = TranslationCheck['kind'];
const owners = new Map<PlanKind, symbol>();
export class TranslationSession {
  private epoch = 0;
  private planning: Promise<unknown> | undefined;
  private admitted = false;
  private submitting = false;
  private claims = new Map<PlanKind, symbol>();
  private checked = new WeakMap<TranslationCheck, { epoch: number; claim: symbol }>();
  constructor(private api: SubtitleStudioApi) {}
  invalidate(force = false) {
    if (this.admitted && !force) return;
    this.epoch++;
    const pending = this.planning;
    const claims = [...this.claims].filter(([kind, token]) => owners.get(kind) === token);
    this.claims.clear();
    if (!claims.length) return;
    cleanup = cleanup.catch(() => {}).then(async () => {
      const cancel = () => Promise.allSettled(claims.map(([kind, token]) => {
        if (owners.get(kind) !== token) return Promise.resolve();
        if (kind === 'trial') return this.api.cancelKnowledgeTrial({});
        if (kind === 'knowledge') return this.api.cancelKnowledgeTranslationPlan({});
        if (kind === 'knowledge-batch') return this.api.cancelKnowledgeTranslationBatchPlan({});
        return Promise.resolve();
      }));
      await cancel();
      if (pending) {
        await pending.catch(() => {});
        await cancel();
      }
      for (const [kind, token] of claims) if (owners.get(kind) === token) owners.delete(kind);
    });
  }
  async check(input: TranslationSessionInput, trial = false): Promise<TranslationCheck | null> {
    if (this.admitted) return null;
    this.invalidate();
    const epoch = this.epoch;
    await cleanup;
    if (epoch !== this.epoch) return null;
    const kind: PlanKind = trial ? 'trial' : input.knowledge ? input.batch ? 'knowledge-batch' : 'knowledge' : input.batch ? 'plain-batch' : 'plain';
    const claim = Symbol(kind);
    owners.set(kind, claim); this.claims.set(kind, claim);
    const common = { config: input.config, knowledgeGeneration: input.generation!, knowledge: input.knowledge! };
    const operation = (async (): Promise<TranslationCheck> => {
      if (trial) {
        const ids = new Set(input.cueIds);
        const project = <T extends { cueIds: string[] }>(values: T[]) => values.flatMap(value => { const cueIds = value.cueIds.filter(id => ids.has(id)); return cueIds.length ? [{ ...value, cueIds }] : []; });
        if (input.documentTopicIds.length && !ids.size) throw new StudioError('invalid_input');
        const topics = new Set(input.documentTopicIds);
        const bindings = input.cueIds.length ? project(common.knowledge.bindings).filter(binding => binding.role !== 'topic' || !topics.has(binding.subjectId)) : common.knowledge.bindings;
        for (const subjectId of topics) bindings.push({ subjectId, role: 'topic', cueIds: [...ids] });
        if (bindings.length > 100) throw new StudioError('limit_exceeded');
        const knowledge = input.cueIds.length ? { ...common.knowledge, bindings, confirmations: project(common.knowledge.confirmations) } : common.knowledge;
        return { kind: 'trial', value: await unwrapStudio(this.api.planKnowledgeTrial({ ...input.documents[0], ...common, knowledge, ...(input.cueIds.length ? { cueIds: input.cueIds } : {}) })) };
      }
      if (input.knowledge && input.batch) {
        const { bindings: _bindings, confirmations: _confirmations, ...knowledge } = input.knowledge;
        return { kind: 'knowledge-batch', value: await unwrapStudio(this.api.planKnowledgeTranslationBatch({ ...common, knowledge, documents: input.documents, documentTopicIds: input.documentTopicIds })) };
      }
      if (input.knowledge) return { kind: 'knowledge', value: await unwrapStudio(this.api.planKnowledgeTranslation({ ...input.documents[0], ...common, documentTopicIds: input.documentTopicIds })) };
      if (input.batch) return { kind: 'plain-batch', value: await unwrapStudio(this.api.planTranslationBatch({ documents: input.documents, config: input.config })) };
      return { kind: 'plain', value: await unwrapStudio(this.api.planTranslation({ ...input.documents[0], config: input.config })) };
    })();
    this.planning = operation;
    try {
      const value = await operation;
      if (epoch !== this.epoch || owners.get(kind) !== claim) return null;
      this.checked.set(value, { epoch, claim }); return value;
    }
    finally { if (this.planning === operation) this.planning = undefined; }
  }
  async submit(check: TranslationCheck, input: TranslationSessionInput, apiKey: string, readLibrary: () => Promise<LibrarySnapshot>, current: () => boolean): Promise<TranslationSubmission | null> {
    const receipt = this.checked.get(check);
    const owns = () => !!receipt && receipt.epoch === this.epoch && owners.get(check.kind) === receipt.claim;
    if (this.submitting || this.admitted || !readyCount(check) || !current() || !owns()) return null;
    this.submitting = true;
    try {
    const epoch = this.epoch;
    if ('expiresAt' in check.value && check.value.expiresAt <= Date.now()) throw new StudioError('revision_conflict');
    if (input.knowledge) {
      const library = await readLibrary();
      if (library.generation !== input.generation) throw new StudioError('revision_conflict');
    }
    if (epoch !== this.epoch || !current() || !owns()) return null;
    this.admitted = true;
    try {
      if (check.kind === 'trial') return { kind: 'trial', value: await unwrapStudio(this.api.runKnowledgeTrial({ planId: check.value.planId, apiKey })) };
      if (check.kind === 'knowledge') return { kind: 'single', ...(await unwrapStudio(this.api.createKnowledgeTranslation({ planId: check.value.planId, apiKey }))) };
      if (check.kind === 'knowledge-batch') return { kind: 'batch', value: await unwrapStudio(this.api.createKnowledgeTranslationBatch({ planId: check.value.planId, apiKey })) };
      if (check.kind === 'plain-batch') return { kind: 'batch', value: await unwrapStudio(this.api.createTranslationBatch({ batchId: check.value.batchId, apiKey })) };
      return { kind: 'single', ...(await unwrapStudio(this.api.createTranslation({ ...input.documents[0], planId: check.value.planId, apiKey }))) };
    } finally {
      this.admitted = false;
      if (owners.get(check.kind) === receipt!.claim) owners.delete(check.kind);
      this.claims.delete(check.kind); this.checked.delete(check);
    }
    } finally { this.submitting = false; }
  }
  dispose() { this.invalidate(true); }
  cancelTrial() {
    const claim = this.claims.get('trial');
    if (claim && owners.get('trial') === claim) return this.api.cancelKnowledgeTrial({});
    return Promise.resolve({ ok: true as const, value: null });
  }
}
