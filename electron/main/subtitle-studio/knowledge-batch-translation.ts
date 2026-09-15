import { randomUUID } from 'node:crypto';
import { documentSchema, errorCodeSchema, StudioError, type ErrorCode } from '../../../src/subtitle-studio/domain';
import type { BatchFailure } from '../../../src/subtitle-studio/batch-contract';
import { knowledgeBatchRequestSchemas, type KnowledgeBatchTranslationRequest, type KnowledgeBatchTranslationPreview, type KnowledgeBatchTranslationResult } from '../../../src/subtitle-studio/knowledge-batch-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import type { KnowledgeTaskGate } from '../../../src/translation-knowledge/task-reference-contract';
import type { DocumentRepository } from './document-repository';
import type { TranslationService } from './translation-service';
import type { PreparedKnowledgeExecution } from './execution-records';
import { prepareKnowledgeTranslation, type KnowledgePreparationBudget } from './knowledge-translation';

export const KNOWLEDGE_BATCH_LIMITS = Object.freeze({
  cues: 10000, scanBytes: 256 * 1024 * 1024, planningBytes: 256 * 1024 * 1024, diagnosticBytes: 8 * 1024 * 1024,
  preparedBytes: 32 * 1024 * 1024, cachedBytes: 32 * 1024 * 1024, plans: 8,
});
const PLAN_LIFETIME = 15 * 60 * 1000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const errorCode = (error: unknown): ErrorCode => error instanceof StudioError ? error.code : 'document_unavailable';
const failure = (documentId: string, displayName: string, error: unknown): BatchFailure => ({ documentId, displayName, ok: false, error: errorCode(error) });
// A JSON-escaped control character costs six bytes per UTF-16 code unit; this
// also bounds non-ASCII names and lone surrogates allowed by the document schema.
const FAILURE_NAME_RESERVE = '\u0000'.repeat(Math.max(...documentSchema.options.map(schema => schema.shape.origin.shape.displayName.maxLength!)));
const FAILURE_CODE_RESERVE = errorCodeSchema.options.reduce((longest, code) => bytes(code) > bytes(longest) ? code : longest);
type CachedBatch = { owner: number; epoch: number; preview: KnowledgeBatchTranslationPreview; prepared: Map<string, PreparedKnowledgeExecution>; started: boolean; bytes: number };

/** A batch owns one frozen library generation and one cache entry, never child plans. */
export class KnowledgeBatchTranslationService {
  private readonly plans = new Map<string, CachedBatch>();
  private readonly epochs = new Map<number, number>();
  private readonly pending = new Map<number, Set<Promise<unknown>>>();
  private readonly retained = new Set<{ bytes: number }>();
  private closed = false;
  private shutdown?: Promise<void>;
  constructor(private readonly repository: DocumentRepository, private readonly translation: TranslationService,
    private readonly readKnowledge: () => Promise<LibrarySnapshot>, private readonly gate: KnowledgeTaskGate) {}

  private track<T>(owner: number, operation: Promise<T>): Promise<T> {
    const pending = this.pending.get(owner) ?? new Set<Promise<unknown>>();
    pending.add(operation); this.pending.set(owner, pending);
    const release = () => { pending.delete(operation); if (!pending.size && this.pending.get(owner) === pending) this.pending.delete(owner); };
    void operation.then(release, release); return operation;
  }
  private replace(owner: number) {
    const epoch = (this.epochs.get(owner) ?? 0) + 1; this.epochs.set(owner, epoch);
    for (const [id, entry] of this.plans) if (entry.owner === owner) {
      this.plans.delete(id); this.retained.delete(entry); entry.prepared.clear();
    }
    return epoch;
  }
  private alive(owner: number, epoch: number, guard: () => void) {
    guard();
    if (this.closed || this.epochs.get(owner) !== epoch) throw new StudioError('access_denied');
  }

  plan(owner: number, input: KnowledgeBatchTranslationRequest, guard: () => void = () => {}): Promise<KnowledgeBatchTranslationPreview> {
    const parsed = knowledgeBatchRequestSchemas.planKnowledgeTranslationBatch.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(owner)) return Promise.reject(new StudioError('invalid_input'));
    if (this.closed) return Promise.reject(new StudioError('access_denied'));
    const epoch = this.replace(owner), request = parsed.data, alive = () => this.alive(owner, epoch, guard);
    for (const [id, entry] of this.plans) if (!entry.started && entry.preview.expiresAt <= Date.now()) { this.plans.delete(id); this.retained.delete(entry); }
    if (this.retained.size >= KNOWLEDGE_BATCH_LIMITS.plans) return Promise.reject(new StudioError('limit_exceeded'));
    const allocation = { bytes: 0 }; this.retained.add(allocation);
    let cached = false;
    return this.track(owner, (async () => {
      alive();
      const library = structuredClone(await this.readKnowledge()); alive();
      if (library.generation !== request.knowledgeGeneration || library.maintenance?.cleanupPending) throw new StudioError('revision_conflict');
      const preview: KnowledgeBatchTranslationPreview = { planId: randomUUID(), expiresAt: 0, knowledgeGeneration: library.generation,
        items: [], readyCount: 0, totalEstimatedInputTokens: 0, totalOutputTokenReserve: 0 };
      const prepared = new Map<string, PreparedKnowledgeExecution>();
      let preparedMaterialBytes = 0, exhausted = false;
      const failureReserves: BatchFailure[] = request.documents.map(({ documentId }) => ({ documentId, displayName: FAILURE_NAME_RESERVE, ok: false, error: FAILURE_CODE_RESERVE }));
      const reserveBytes = (items: KnowledgeBatchTranslationPreview['items'], materialBytes: number, preparedCount: number) => {
        // The actual cache envelope and every future failure row are accounted
        // for before accepting a file. Bounded numeric fields reserve their full
        // safe-integer width, including the expiry populated after planning.
        const envelope = { preview: { ...preview, expiresAt: Number.MAX_SAFE_INTEGER, readyCount: Number.MAX_SAFE_INTEGER,
          totalEstimatedInputTokens: Number.MAX_SAFE_INTEGER, totalOutputTokenReserve: Number.MAX_SAFE_INTEGER,
          items: [...items, ...failureReserves.slice(items.length)] }, prepared: [] };
        return bytes(envelope) + materialBytes + Math.max(0, preparedCount - 1);
      };
      const otherRetainedBytes = () => [...this.retained].filter(entry => entry !== allocation).reduce((sum, entry) => sum + entry.bytes, 0);
      const initialReservation = reserveBytes([], 0, 0);
      if (otherRetainedBytes() + initialReservation > KNOWLEDGE_BATCH_LIMITS.cachedBytes) throw new StudioError('limit_exceeded');
      allocation.bytes = initialReservation;
      const used = { cues: 0, scanBytes: 0, planningBytes: 0, diagnosticBytes: 0 };
      const budget: KnowledgePreparationBudget = { charge: (kind, amount) => {
        used[kind] += amount;
        if (used[kind] > KNOWLEDGE_BATCH_LIMITS[kind]) { exhausted = true; throw new StudioError('limit_exceeded'); }
      } };
      for (const reference of request.documents) {
        await new Promise<void>(resolve => setImmediate(resolve)); alive();
        let displayName = reference.documentId;
        try {
          if (exhausted) throw new StudioError('limit_exceeded');
          const snapshot = await this.repository.readSnapshot(reference.documentId); alive();
          displayName = snapshot.document.origin.displayName;
          if (snapshot.document.revision !== reference.revision || snapshot.tasks.some(task => ['queued', 'running'].includes(task.status))) throw new StudioError('revision_conflict');
          const result = await prepareKnowledgeTranslation(this.repository, { ...reference, knowledgeGeneration: request.knowledgeGeneration,
            config: request.config, knowledge: { ...request.knowledge, bindings: [], confirmations: [] }, documentTopicIds: request.documentTopicIds }, library, alive, budget);
          alive();
          const cueNumbers = new Map(snapshot.document.cues.map((cue, index) => [cue.id, index + 1]));
          const summary = { ...result.preview, issues: result.preview.issues.slice(0, 100).map(issue => {
            const cueIds = issue.cueIds.slice(0, 20);
            return { ...issue, cueIds, cueNumbers: cueIds.map(id => cueNumbers.get(id)!) };
          }), issueCount: result.preview.issues.length };
          const candidate = { documentId: reference.documentId, displayName: result.displayName, ok: true as const, plan: summary };
          const candidatePrepared = result.prepared && result.preview.canRun ? result.prepared : undefined;
          const candidatePreparedBytes = candidatePrepared ? bytes(candidatePrepared) : 0;
          if (preparedMaterialBytes + candidatePreparedBytes > KNOWLEDGE_BATCH_LIMITS.preparedBytes) { exhausted = true; throw new StudioError('limit_exceeded'); }

          const projectedSize = reserveBytes([...preview.items, candidate], preparedMaterialBytes + candidatePreparedBytes, prepared.size + Number(!!candidatePrepared));
          if (otherRetainedBytes() + projectedSize > KNOWLEDGE_BATCH_LIMITS.cachedBytes) { exhausted = true; throw new StudioError('limit_exceeded'); }

          preparedMaterialBytes += candidatePreparedBytes;
          allocation.bytes = projectedSize;
          preview.items.push(candidate);
          if (result.prepared && result.preview.canRun) {
            prepared.set(reference.documentId, result.prepared);
            preview.readyCount++; preview.totalEstimatedInputTokens += summary.estimatedInputTokens; preview.totalOutputTokenReserve += summary.outputTokenReserve;
          }
        } catch (error) { alive(); preview.items.push(failure(reference.documentId, displayName, error)); }
      }
      alive(); preview.expiresAt = Date.now() + PLAN_LIFETIME;
      const size = bytes({ preview, prepared: [...prepared.values()] });
      // All remaining rows fit the reservation, so releasing the unused bytes
      // cannot reject a prefix whose documents already passed their checks.
      const entry: CachedBatch = Object.assign(allocation, { owner, epoch, preview, prepared, started: false, bytes: size });
      this.plans.set(preview.planId, entry); cached = true;
      return structuredClone(preview);
    })().finally(() => { if (!cached) this.retained.delete(allocation); }));
  }

  start(owner: number, input: { planId: string; apiKey: string }, guard: () => void = () => {}): Promise<KnowledgeBatchTranslationResult> {
    const parsed = knowledgeBatchRequestSchemas.createKnowledgeTranslationBatch.safeParse(input);
    if (!parsed.success) return Promise.reject(new StudioError('invalid_input'));
    if (!parsed.data.apiKey.trim()) return Promise.reject(new StudioError('needs_configuration'));
    const entry = this.plans.get(parsed.data.planId);
    if (!entry || entry.owner !== owner || this.closed) return Promise.reject(new StudioError('access_denied'));
    if (entry.started || entry.preview.expiresAt <= Date.now()) return Promise.reject(new StudioError('revision_conflict'));
    if (!entry.preview.readyCount) return Promise.reject(new StudioError('invalid_input'));
    entry.started = true;
    const alive = () => { this.alive(owner, entry.epoch, guard); if (entry.preview.expiresAt <= Date.now()) throw new StudioError('revision_conflict'); };
    const verifyGeneration = async () => {
      alive(); const library = await this.readKnowledge(); alive();
      if (library.generation !== entry.preview.knowledgeGeneration || library.maintenance?.cleanupPending) throw new StudioError('revision_conflict');
    };
    return this.track(owner, (async () => {
      // A whole-batch generation failure has no admission effects. Once checked,
      // this handle is single-use and every subsequent outcome is returned by file.
      try { await this.gate.run(verifyGeneration); }
      catch (error) {
        // Starting consumes the batch plan even when the shared generation gate
        // rejects it; callers must create a fresh plan instead of replaying a
        // possibly partially admitted batch.
        this.plans.delete(parsed.data.planId);
        entry.prepared.clear(); this.retained.delete(entry);
        throw error;
      }
      const result: KnowledgeBatchTranslationResult = { items: [] };
      let stopped: unknown;
      try {
        for (const item of entry.preview.items) {
          if (stopped) { result.items.push(failure(item.documentId, item.displayName, stopped)); continue; }
          try { alive(); } catch (error) { stopped = error; result.items.push(failure(item.documentId, item.displayName, error)); continue; }
          if (!item.ok) { result.items.push(item); continue; }
          const prepared = entry.prepared.get(item.documentId);
          if (!item.plan.canRun || !prepared) {
            result.items.push({ ...failure(item.documentId, item.displayName, new StudioError('invalid_input')), reason: 'knowledge_check_failed' }); continue;
          }
          try {
            const admitted = await this.gate.run(async () => {
              try { await verifyGeneration(); } catch (error) { stopped = error; throw error; }
              return this.translation.startPreparedKnowledge(prepared, parsed.data.apiKey, alive);
            });
            // Never recheck the owner here: a committed task ID must survive a
            // cancellation/replacement racing with the admission acknowledgement.
            result.items.push({ documentId: item.documentId, displayName: item.displayName, ok: true, taskId: admitted.taskId });
          } catch (error) {
            result.items.push(failure(item.documentId, item.displayName, error));
            try { alive(); } catch (interrupted) { stopped = interrupted; }
          }
          entry.prepared.delete(item.documentId);
        }
        return result;
      } finally {
        entry.prepared.clear();
        this.retained.delete(entry);
        if (this.plans.get(parsed.data.planId) === entry) this.plans.delete(parsed.data.planId);
      }
    })());
  }

  async cancel(owner: number): Promise<void> { this.replace(owner); await Promise.allSettled([...(this.pending.get(owner) ?? [])]); }
  forgetOwner(owner: number): Promise<void> { return this.cancel(owner); }
  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true; this.plans.clear();
    this.shutdown = Promise.allSettled([...this.pending.values()].flatMap(pending => [...pending])).then(() => { this.retained.clear(); }); return this.shutdown;
  }
}
