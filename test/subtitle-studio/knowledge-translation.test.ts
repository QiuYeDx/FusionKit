import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import { knowledgeTranslationRequestSchemas, type KnowledgeTranslationRequest } from '../../src/subtitle-studio/knowledge-translation-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { KnowledgeTaskGate } from '../../src/translation-knowledge/task-reference-contract';
import type { Entry } from '../../src/translation-knowledge/schemas';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { validateFrozenKnowledgeSnapshot } from '../../src/translation-knowledge/snapshot-contract';
import { KNOWLEDGE_EXECUTION_POLICY, LEGACY_KNOWLEDGE_EXECUTION_POLICY } from '../../src/translation-knowledge/execution';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { KnowledgeTranslationService, KNOWLEDGE_TRANSLATION_LIMITS, prepareKnowledgeTranslation } from '../../electron/main/subtitle-studio/knowledge-translation';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { TranslationScheduler } from '../../electron/main/subtitle-studio/translation-recovery';
import { KNOWLEDGE_PRIOR_REQUEST_BYTES, resolveExecutionRecord } from '../../electron/main/subtitle-studio/execution-records';
import * as records from '../../electron/main/subtitle-studio/execution-records';
import * as planner from '../../electron/main/subtitle-studio/translation-planner';

const config = (overrides: Partial<TranslationConfig> = {}): TranslationConfig => ({ model: { profileId: 'knowledge', modelKey: 'fixture', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' }, language: 'zh-Hans', instructions: '', contextWindow: 8192, maxOutputTokens: 2048, maxBatchCues: 20, ...overrides });
const lines = (count: number) => Array.from({ length: count }, (_, index) => `[00:${String(index % 60).padStart(2, '0')}]starport ${index + 1}`).join('\n');
const payload = (request: ModelRuntimeTextRequest) => JSON.parse(request.messages[1].content) as { items: { id: string; text: string }[]; context: { precedingSource: string[]; followingSource: string[]; priorModelTranslations: string[] }; translationKnowledge: { items: { applicableItemIds: string[]; payload: unknown }[] } };
const success = (request: ModelRuntimeTextRequest, text?: string): ModelRuntimeTextResult => ({ apiFormat: request.model.apiFormat, finishReason: 'stop', rawStatus: 'completed', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, content: JSON.stringify({ items: payload(request).items.map(item => ({ id: item.id, text: text ?? `译文 ${item.id}` })) }) });
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
class Gate implements KnowledgeTaskGate {
  calls = 0; active = false; private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    this.calls++;
    const result = this.tail.then(async () => { expect(this.active).toBe(false); this.active = true; try { return await operation(); } finally { this.active = false; } });
    this.tail = result.catch(() => {}); return result;
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(count = 43, send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = async request => success(request)) {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-formal-'));
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const document = importSubtitleText(lines(count), { format: 'lrc', displayName: 'formal-fixture.lrc', encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
  await repository.create(document);
  const topicId = randomUUID(), collectionId = randomUUID(), sourceId = randomUUID();
  const term: Entry = { id: randomUUID(), revision: 1, kind: 'term', title: 'Starport', collectionId, aboutSubjectIds: [], state: 'ready', scope: { languagePair: { source: 'en', target: 'zh-Hans' }, requiredSubjects: [{ subjectId: topicId, role: 'topic' }], condition: { mode: 'none' } }, evidence: [{ sourceId, support: 'direct' }], derivedFrom: [], payload: { source: 'starport', target: '星港', aliases: [], sense: '', match: { mode: 'whole_term', caseSensitive: false }, strength: 'required' } };
  const library: LibrarySnapshot = { generation: 1, data: { format: 'fusionkit.translation-knowledge', schemaVersion: 1, package: { id: randomUUID(), revision: 1, name: 'Formal fixture', description: '', purpose: 'backup', createdAt: '2026-09-14T00:00:00Z', generator: { name: 'Test' } },
    subjects: [{ id: topicId, revision: 1, archived: false, kind: 'person', name: 'Topic subject', aliases: [], tags: [], description: '' }],
    collections: [{ id: collectionId, revision: 1, archived: false, name: 'Glossary', description: '', aboutSubjectIds: [] }], sources: [{ id: sourceId, revision: 1, kind: 'user_note', title: 'Evidence', excerpt: 'PRIVATE_EVIDENCE' }], entries: [term], styles: [], recipes: [], preferenceTemplates: [] }, approvals: {}, imports: [] };
  const approve = () => { for (const entry of library.data.entries) library.approvals[entry.id] = { revision: entry.revision, digest: sha256Canonical(entry), method: 'human', approvedAt: '2026-09-14T00:00:00Z' }; };
  approve();
  const gate = new Gate(), sent = vi.fn(send), read = vi.fn(async () => library);
  const translation = new TranslationService(repository, sent, new TranslationScheduler(1), gate);
  const service = new KnowledgeTranslationService(repository, translation, read, gate);
  const releases: (() => void)[] = [];
  cleanups.push(async () => { for (const release of releases) release(); await service.dispose(); await translation.dispose(); for (const task of (await repository.readSnapshot(document.id).catch(() => ({ tasks: [] }))).tasks) await translation.settled(task.id); await rm(root, { recursive: true, force: true }); });
  const request = (overrides: Partial<KnowledgeTranslationRequest> = {}): KnowledgeTranslationRequest => ({ documentId: document.id, revision: document.revision, knowledgeGeneration: library.generation, config: config(), knowledge: { version: 1, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [collectionId], bindings: [], confirmations: [], disabledEntryIds: [] }, documentTopicIds: [topicId], ...overrides });
  return { root, repository, document, library, term, topicId, sourceId, approve, service, translation, gate, sent, read, request, releases };
}

describe('formal document knowledge translation', () => {
  it.each(['', 'Keep the dialogue concise.'])('normalizes undefined selection options before preview and admission with parent instructions %j', async instructions => {
    const f = await fixture(1);
    const input = f.request({ config: config({ instructions }) });
    const absent = await prepareKnowledgeTranslation(f.repository, input, f.library);
    input.knowledge = { ...input.knowledge, recipeId: undefined, instructions: undefined, context: undefined };
    const preview = await f.service.plan(1, input);
    expect(preview).toEqual({ ...absent.preview, planId: preview.planId, expiresAt: preview.expiresAt });
    expect(preview.canRun).toBe(true);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' });
    await f.translation.settled(started.taskId);
    const snapshot = await f.repository.readSnapshot(f.document.id), record = resolveExecutionRecord(snapshot, started.taskId);
    expect(snapshot.tasks[0].status).toBe('completed');
    expect(record.knowledge).toEqual(absent.prepared!.knowledge);
    expect(record.knowledge!.selection).not.toHaveProperty('recipeId');
    expect(record.knowledge!.selection).not.toHaveProperty('context');
    if (instructions) expect(record.knowledge!.selection.instructions).toBe(instructions);
    else expect(record.knowledge!.selection).not.toHaveProperty('instructions');
    expect(record.baseRequests.b1.request).toEqual(absent.prepared!.baseRequests.b1.request);
    expect(record.baseRequests.b1.httpBody).toBe(absent.prepared!.baseRequests.b1.httpBody);
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(planner.serializeTranslationRequest(f.sent.mock.calls[0][0])).toBe(absent.prepared!.baseRequests.b1.httpBody);
  });

  it('preserves explicitly empty instructions and context through frozen admission without falling back to recipe or form guidance', async () => {
    const f = await fixture(1), recipeId = randomUUID();
    const input = f.request({ config: config({ instructions: 'Parent form instructions.' }) });
    f.library.data.recipes.push({ id: recipeId, revision: 1, archived: false, name: 'Formal recipe', description: '',
      languagePair: input.knowledge.languagePair, readCollectionIds: [], subjectSuggestions: [], modifierStyleIds: [],
      instructions: 'Recipe instructions.', context: 'Recipe context.', inheritGlobalPreferences: false, learningSuggestion: 'off' });
    input.knowledge = { ...input.knowledge, recipeId, instructions: '', context: '' };
    const preview = await f.service.plan(1, input);
    expect(preview.canRun).toBe(true);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' });
    await f.translation.settled(started.taskId);
    const snapshot = await f.repository.readSnapshot(f.document.id), record = resolveExecutionRecord(snapshot, started.taskId);
    expect(snapshot.tasks[0].status).toBe('completed');
    expect(record.knowledge!.selection).toMatchObject({ recipeId, instructions: '', context: '' });
    expect(record.knowledge!.batches.b1).toMatchObject({ instructions: '', context: '' });
    expect(JSON.parse(f.sent.mock.calls[0][0].messages[1].content)).toMatchObject({ translationRequirements: '', translationKnowledge: { background: '' } });
  });

  it.each(['chat_completions', 'responses'] as const)('translates all windows with global IDs and frozen %s knowledge, retaining cross-window source and AI context', async apiFormat => {
    const f = await fixture();
    const preview = await f.service.plan(1, f.request({ config: config({ model: { ...config().model, apiFormat } }) }));
    expect(preview).toMatchObject({ canRun: true, cueCount: 43, batchCount: 3, includedEntryCount: 1, resourceCount: 4 });
    expect(f.sent).not.toHaveBeenCalled(); expect((await f.repository.readSnapshot(f.document.id)).tasks).toEqual([]);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'PRIVATE_KEY' }); await f.translation.settled(started.taskId);
    expect(f.sent).toHaveBeenCalledTimes(3);
    const requests = f.sent.mock.calls.map(([request]) => request);
    expect(requests.flatMap(request => payload(request).items.map(item => item.id))).toEqual(Array.from({ length: 43 }, (_, index) => `u${index + 1}`));
    expect(payload(requests[1]).context).toMatchObject({ precedingSource: ['starport 19', 'starport 20'], followingSource: ['starport 41', 'starport 42'], priorModelTranslations: ['译文 u19', '译文 u20'] });
    expect(payload(requests[1]).translationKnowledge.items[0].applicableItemIds[0]).toBe('u21');
    const snapshot = await f.repository.readSnapshot(f.document.id), record = resolveExecutionRecord(snapshot, started.taskId);
    expect(snapshot.document.translationTracks[0].origin).toBe('ai');
    expect(snapshot.tasks[0].status).toBe('completed'); expect(record.policyVersion).toBe(records.KNOWLEDGE_TRANSLATION_POLICY_VERSION);
    expect(validateFrozenKnowledgeSnapshot(record.knowledge).data.entries[0]).toEqual(f.term);
    expect(record.knowledge!.data.sources[0].excerpt).toBe('PRIVATE_EVIDENCE');
    for (const [index, request] of requests.entries()) {
      expect(record.requests[`b${index + 1}`].httpBody).toBe(planner.serializeTranslationRequest(request));
      expect(planner.requestTokenEstimate(request)).toBeLessThanOrEqual(record.plan.batches[index].estimatedInputTokens);
      expect(planner.serializeTranslationRequest(request)).not.toMatch(new RegExp(`PRIVATE_EVIDENCE|${f.sourceId}|${f.term.id}|${f.document.id}`));
    }
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE_KEY|apiKey|signal|proxy/);
    expect(f.gate.calls).toBe(1); expect(f.translation.activeKnowledgeReferences()).toEqual([]);
  });

  it('projects explicit confirmations across the boundary while a whole-document topic never supplies a speaker identity', async () => {
    const f = await fixture(21);
    f.term.scope.requiredSubjects = [{ subjectId: f.topicId, role: 'speaker' }];
    f.term.scope.condition = { mode: 'requires_confirmation', text: 'Confirmed scene.' }; f.approve();
    const input = f.request();
    input.knowledge.bindings = [{ subjectId: f.topicId, role: 'speaker', cueIds: [f.document.cues[0].id, f.document.cues[20].id] }];
    input.knowledge.confirmations = [{ entryId: f.term.id, cueIds: [f.document.cues[0].id, f.document.cues[20].id] }];
    const preview = await f.service.plan(1, input); expect(preview.canRun).toBe(true);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' }); await f.translation.settled(started.taskId);
    expect(f.sent.mock.calls.map(([request]) => payload(request).translationKnowledge.items[0].applicableItemIds)).toEqual([['u1'], ['u21']]);
    const knowledge = resolveExecutionRecord(await f.repository.readSnapshot(f.document.id), started.taskId).knowledge!;
    expect(knowledge.batches.b1.items[0].applicableCueIds).toEqual([f.document.cues[0].id]);
    expect(knowledge.batches.b2.items[0].applicableCueIds).toEqual([f.document.cues[20].id]);
    expect(knowledge.batches.b1.issues.some(issue => issue.code === 'subject_unbound')).toBe(true);
  });

  it('blocks the whole document when a later window contains conflicting required knowledge', async () => {
    const f = await fixture(21);
    const conflicting = structuredClone(f.term); conflicting.id = randomUUID(); conflicting.scope.condition = { mode: 'requires_confirmation', text: 'Last scene.' };
    if (conflicting.kind !== 'term') throw new Error('fixture'); conflicting.payload.target = '另一个译法'; f.library.data.entries.push(conflicting); f.approve();
    const input = f.request(); input.knowledge.confirmations = [{ entryId: conflicting.id, cueIds: [f.document.cues[20].id] }];
    const preview = await f.service.plan(1, input);
    expect(preview.canRun).toBe(false); expect(preview.issues).toContainEqual(expect.objectContaining({ code: 'term_conflict', severity: 'error', cueIds: [f.document.cues[20].id] }));
    await expect(f.service.start(1, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.sent).not.toHaveBeenCalled(); expect((await f.repository.readSnapshot(f.document.id)).tasks).toEqual([]);
  });

  it('never truncates required knowledge and can release prior reserves to retain mandatory guidance', async () => {
    const f = await fixture(2);
    const input = f.request({ config: config({ contextWindow: 2048, maxOutputTokens: 256, maxBatchCues: 1 }) }); input.knowledge.context = 'a '.repeat(1100);
    const preview = await f.service.plan(1, input); expect(preview.canRun).toBe(true);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' }); await f.translation.settled(started.taskId);
    const record = resolveExecutionRecord(await f.repository.readSnapshot(f.document.id), started.taskId);
    expect(record.plan.batches[1].priorContextReserve).toBe(0); expect(record.knowledge!.batches.b2.items[0].required).toBe(true);
    const next = f.request({ revision: (await f.repository.read(f.document.id)).revision }); next.knowledge.context = 'b '.repeat(1900); next.config = config({ contextWindow: 2048, maxOutputTokens: 256 });
    const blocked = await f.service.plan(1, next); expect(blocked.canRun).toBe(false); expect(blocked.issues.some(issue => issue.code === 'budget_required')).toBe(true);
  });

  it.each([KNOWLEDGE_EXECUTION_POLICY, LEGACY_KNOWLEDGE_EXECUTION_POLICY])('resumes %s frozen knowledge and exact failed HTTP bytes after live knowledge and prompt builders change', async policy => {
    let stop = true;
    const f = await fixture(43, async request => { if (stop && payload(request).items[0].id === 'u21') throw new Error('controlled provider stop'); return success(request); });
    const started = await (async () => {
      if (policy === KNOWLEDGE_EXECUTION_POLICY) {
        const preview = await f.service.plan(1, f.request());
        return f.service.start(1, { planId: preview.planId, apiKey: 'key' });
      }
      const prepared = await prepareKnowledgeTranslation(f.repository, f.request(), f.library, undefined, undefined, policy);
      return f.gate.run(() => f.translation.startPreparedKnowledge(prepared.prepared!, 'key'));
    })();
    await f.translation.settled(started.taskId);
    const failed = await f.repository.readSnapshot(f.document.id), frozen = resolveExecutionRecord(failed, started.taskId);
    expect(failed.tasks[0].status).toBe('failed'); expect(frozen.requests.b3).toBeUndefined();
    expect(frozen.knowledge!.policyVersion).toBe(policy);
    f.library.data.entries = []; f.library.approvals = {}; f.library.generation++; stop = false;
    const rebuilt = vi.spyOn(planner, 'buildTranslationRequest').mockImplementation(() => { throw new Error('do not rebuild'); });
    f.read.mockClear();
    await f.translation.resume(f.document.id, failed.document.revision, started.taskId, config().model, 'rotated-key'); await f.translation.settled(started.taskId);
    const [replayed, last] = f.sent.mock.calls.slice(-2).map(([request]) => request);
    expect(planner.serializeTranslationRequest(replayed)).toBe(frozen.requests.b2.httpBody);
    expect(last.messages[0]).toEqual(frozen.baseRequests.b3.request.messages[0]);
    expect(payload(last).translationKnowledge).toEqual(JSON.parse(frozen.baseRequests.b3.request.messages[1].content).translationKnowledge);
    expect(last.model.apiKey).toBe('rotated-key'); expect(f.read).not.toHaveBeenCalled(); expect(rebuilt).not.toHaveBeenCalled(); expect(f.gate.calls).toBe(2);
    expect((await f.repository.readSnapshot(f.document.id)).tasks[0].status).toBe('completed');
  });

  it('rejects an unknown knowledge execution policy even with a valid frozen snapshot digest', async () => {
    const f = await fixture(1), result = await prepareKnowledgeTranslation(f.repository, f.request(), f.library);
    const prepared = result.prepared!, knowledge = prepared.knowledge;
    knowledge.policyVersion = 'fktk-execution/99';
    for (const batch of Object.values(knowledge.batches)) batch.policyVersion = knowledge.policyVersion;
    const { digest: _digest, ...base } = knowledge; knowledge.digest = sha256Canonical(base);
    expect(validateFrozenKnowledgeSnapshot(knowledge)).toEqual(knowledge);
    expect(() => records.createExecutionRecord(prepared.plan, prepared.sourceDigest, randomUUID(), randomUUID(), prepared)).toThrow('translation_record_unavailable');
    expect(f.sent).not.toHaveBeenCalled();
  });

  it.each(['task', 'document'] as const)('retains physical knowledge references after %s removal until a cancelled supplier settles without holding the purge gate', async removal => {
    const entered = defer<ModelRuntimeTextRequest>(), release = defer<ModelRuntimeTextResult>();
    const f = await fixture(1, request => { entered.resolve(request); return release.promise; });
    const preview = await f.service.plan(1, f.request()), started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' });
    const request = await entered.promise; f.releases.push(() => release.resolve(success(request)));
    expect(await f.gate.run(async () => 'purge gate remains available')).toBe('purge gate remains available');
    let current = await f.repository.readSnapshot(f.document.id);
    await f.translation.cancel(f.document.id, current.document.revision, started.taskId);
    current = await f.repository.readSnapshot(f.document.id);
    if (removal === 'task') await f.repository.removeTask(f.document.id, current.document.revision, started.taskId);
    else await f.repository.delete(f.document.id, current.document.revision);
    expect(f.translation.activeKnowledgeReferences()).toEqual([expect.objectContaining({ taskId: started.taskId, status: 'active', resources: expect.arrayContaining([expect.objectContaining({ id: f.term.id })]) })]);
    release.resolve(success(request)); await f.translation.settled(started.taskId);
    expect(f.translation.activeKnowledgeReferences()).toEqual([]);
  });

  it('bounds escaped dynamic prior growth against the storage capacity reserved at admission', async () => {
    const f = await fixture(2, async request => success(request, '"'.repeat(400)));
    const preview = await f.service.plan(1, f.request({ config: config({ maxBatchCues: 1 }) })), started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' }); await f.translation.settled(started.taskId);
    const record = resolveExecutionRecord(await f.repository.readSnapshot(f.document.id), started.taskId);
    expect(Buffer.byteLength(JSON.stringify(record.requests.b2)) - Buffer.byteLength(JSON.stringify(record.baseRequests.b2))).toBeLessThanOrEqual(KNOWLEDGE_PRIOR_REQUEST_BYTES);
    expect((await f.repository.readSnapshot(f.document.id)).tasks[0].status).toBe('completed');
  });

  it.each(['owner', 'generation', 'document', 'expiry', 'forgery'] as const)('rejects %s changes before admission', async kind => {
    const f = await fixture(1), preview = await f.service.plan(1, f.request());
    if (kind === 'generation') f.library.generation++;
    if (kind === 'document') await f.repository.transact(f.document.id, 1, () => {});
    if (kind === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt + 1);
    const input = { planId: preview.planId, apiKey: 'key', ...(kind === 'forgery' ? { prepared: {} } : {}) };
    await expect(f.service.start(kind === 'owner' ? 2 : 1, input)).rejects.toBeDefined();
    expect(f.sent).not.toHaveBeenCalled(); expect((await f.repository.readSnapshot(f.document.id)).tasks).toEqual([]);
    expect(knowledgeTranslationRequestSchemas.createKnowledgeTranslation.safeParse({ ...input, prepared: {} }).success).toBe(false);
  });

  it('rejects foreign explicit cue references rather than dropping them during window projection', async () => {
    const f = await fixture(21), input = f.request(); input.knowledge.bindings = [{ subjectId: f.topicId, role: 'topic', cueIds: [randomUUID()] }];
    await expect(f.service.plan(1, input)).rejects.toMatchObject({ code: 'invalid_input' }); expect(f.sent).not.toHaveBeenCalled();
  });

  it('invalidates in-progress window planning on cancellation and owner loss without creating tasks', async () => {
    const f = await fixture(100), pending = f.service.plan(1, f.request());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'access_denied' }); await f.service.cancel(1); await rejected;
    const preview = await f.service.plan(1, f.request()); await f.service.forgetOwner(1);
    await expect(f.service.start(1, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'access_denied' });
    expect(f.sent).not.toHaveBeenCalled(); expect((await f.repository.readSnapshot(f.document.id)).tasks).toEqual([]);
  });

  it('rejects documents beyond the whole-plan cue bound without translating a prefix', async () => {
    const f = await fixture(KNOWLEDGE_TRANSLATION_LIMITS.cues + 1);
    await expect(f.service.plan(1, f.request())).rejects.toMatchObject({ code: 'limit_exceeded' }); expect(f.sent).not.toHaveBeenCalled();
  });

  it('checks future execution-record capacity before returning a runnable preview', async () => {
    const f = await fixture(2);
    vi.spyOn(records, 'assertKnowledgeExecutionCapacity').mockImplementationOnce(() => { throw new StudioError('limit_exceeded'); });
    await expect(f.service.plan(1, f.request())).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(f.sent).not.toHaveBeenCalled(); expect((await f.repository.readSnapshot(f.document.id)).tasks).toEqual([]);
  });

  it('reserves missing actual requests even when the current static records still fit the aggregate limit', async () => {
    const f = await fixture(2), preview = await f.service.plan(1, f.request()), started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' }); await f.translation.settled(started.taskId);
    const snapshot = await f.repository.readSnapshot(f.document.id), record = resolveExecutionRecord(snapshot, started.taskId);
    record.requests = {};
    const fillerId = randomUUID(), staticRecords = { [record.id]: record, [fillerId]: '' };
    staticRecords[fillerId] = 'x'.repeat(32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(staticRecords)) - 100);
    snapshot.executionRecords = staticRecords;
    expect(Buffer.byteLength(JSON.stringify(snapshot.executionRecords))).toBeLessThan(32 * 1024 * 1024);
    expect(() => records.assertKnowledgeExecutionCapacity(snapshot, record)).toThrow('limit_exceeded');
  });
});
