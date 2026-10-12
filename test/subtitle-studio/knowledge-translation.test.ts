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
import type { Entry, TermEntry } from '../../src/translation-knowledge/schemas';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { validateFrozenKnowledgeSnapshot } from '../../src/translation-knowledge/snapshot-contract';
import { KNOWLEDGE_EXECUTION_POLICY } from '../../src/translation-knowledge/execution';
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
const pair = { source: 'en', target: 'zh-Hans' };
const termEntry = (collectionId: string, source = 'starport', target = '星港'): TermEntry => ({ id: randomUUID(), revision: 1, collectionId, enabled: true, kind: 'term',
  payload: { source, target, aliases: [], note: '', strength: 'required', match: { mode: 'whole_term', caseSensitive: false } } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(count = 43, send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = async request => success(request)) {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-formal-'));
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const document = importSubtitleText(lines(count), { format: 'lrc', displayName: 'formal-fixture.lrc', encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
  await repository.create(document);
  const collectionId = randomUUID();
  // Origin is record-only provenance; it must never reach the provider request.
  const term: TermEntry = { ...termEntry(collectionId), origin: { kind: 'web', url: 'https://example.invalid/private-origin', title: 'Private origin', note: 'PRIVATE_ORIGIN' } };
  const library: LibrarySnapshot = { generation: 1, data: { format: 'fusionkit.translation-knowledge', schemaVersion: 2,
    package: { id: randomUUID(), revision: 1, name: 'Formal fixture', description: '', createdAt: '2026-09-14T00:00:00Z', generator: { name: 'Test' } },
    collections: [{ id: collectionId, revision: 1, name: 'Glossary', description: '', languagePair: { ...pair }, archived: false }], entries: [term], presets: [] } };
  const sent = vi.fn(send), read = vi.fn(async () => library);
  const translation = new TranslationService(repository, sent, new TranslationScheduler(1));
  const service = new KnowledgeTranslationService(repository, translation, read);
  const releases: (() => void)[] = [];
  cleanups.push(async () => { for (const release of releases) release(); await service.dispose(); await translation.dispose(); for (const task of (await repository.readSnapshot(document.id).catch(() => ({ tasks: [] }))).tasks) await translation.settled(task.id); await rm(root, { recursive: true, force: true }); });
  const request = (overrides: Partial<KnowledgeTranslationRequest> = {}): KnowledgeTranslationRequest => ({ documentId: document.id, revision: document.revision, knowledgeGeneration: library.generation, config: config(), knowledge: { version: 2, languagePair: { ...pair }, collectionIds: [collectionId], disabledEntryIds: [] }, ...overrides });
  return { root, repository, document, library, collectionId, term, service, translation, sent, read, request, releases };
}

describe('formal document knowledge translation', () => {
  it.each(['', 'Keep the dialogue concise.'])('normalizes undefined selection options before preview and admission with parent instructions %j', async instructions => {
    const f = await fixture(1);
    const input = f.request({ config: config({ instructions, trackName: '资料翻译初稿' }) });
    const absent = await prepareKnowledgeTranslation(f.repository, input, f.library);
    input.knowledge = { ...input.knowledge, instructions: undefined, context: undefined };
    const preview = await f.service.plan(1, input);
    expect(preview).toEqual({ ...absent.preview, planId: preview.planId, expiresAt: preview.expiresAt });
    expect(preview.canRun).toBe(true);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' });
    await f.translation.settled(started.taskId);
    const snapshot = await f.repository.readSnapshot(f.document.id), record = resolveExecutionRecord(snapshot, started.taskId);
    expect(snapshot.tasks[0].status).toBe('completed');
    expect(snapshot.document.translationTracks[0].name).toBe('资料翻译初稿');
    expect(JSON.stringify(f.sent.mock.calls)).not.toContain('资料翻译初稿');
    expect(record.knowledge).toEqual(absent.prepared!.knowledge);
    expect(record.knowledge!.selection).not.toHaveProperty('context');
    if (instructions) expect(record.knowledge!.selection.instructions).toBe(instructions);
    else expect(record.knowledge!.selection).not.toHaveProperty('instructions');
    expect(record.baseRequests.b1.request).toEqual(absent.prepared!.baseRequests.b1.request);
    expect(record.baseRequests.b1.httpBody).toBe(absent.prepared!.baseRequests.b1.httpBody);
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(planner.serializeTranslationRequest(f.sent.mock.calls[0][0])).toBe(absent.prepared!.baseRequests.b1.httpBody);
  });

  it('preserves explicitly empty instructions and context through frozen admission without falling back to form guidance', async () => {
    const f = await fixture(1);
    const input = f.request({ config: config({ instructions: 'Parent form instructions.' }) });
    input.knowledge = { ...input.knowledge, instructions: '', context: '' };
    const preview = await f.service.plan(1, input);
    expect(preview.canRun).toBe(true);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' });
    await f.translation.settled(started.taskId);
    const snapshot = await f.repository.readSnapshot(f.document.id), record = resolveExecutionRecord(snapshot, started.taskId);
    expect(snapshot.tasks[0].status).toBe('completed');
    expect(record.knowledge!.selection).toMatchObject({ instructions: '', context: '' });
    expect(JSON.stringify(f.sent.mock.calls)).not.toContain('Parent form instructions.');
    expect(record.knowledge!.batches.b1).toMatchObject({ instructions: '', context: '' });
    expect(JSON.parse(f.sent.mock.calls[0][0].messages[1].content)).toMatchObject({ translationRequirements: '', translationKnowledge: { background: '' } });
  });

  it.each(['chat_completions', 'responses'] as const)('translates all windows with global IDs and frozen %s knowledge, retaining cross-window source and AI context', async apiFormat => {
    const f = await fixture();
    const preview = await f.service.plan(1, f.request({ config: config({ model: { ...config().model, apiFormat } }) }));
    // One frozen collection plus its one entry.
    expect(preview).toMatchObject({ canRun: true, cueCount: 43, batchCount: 3, includedEntryCount: 1, resourceCount: 2 });
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
    expect(record.knowledge!.data.entries[0].origin).toMatchObject({ kind: 'web', note: 'PRIVATE_ORIGIN' });
    for (const [index, request] of requests.entries()) {
      expect(record.requests[`b${index + 1}`].httpBody).toBe(planner.serializeTranslationRequest(request));
      expect(planner.requestTokenEstimate(request)).toBeLessThanOrEqual(record.plan.batches[index].estimatedInputTokens);
      expect(planner.serializeTranslationRequest(request)).not.toMatch(new RegExp(`PRIVATE_ORIGIN|private-origin|${f.collectionId}|${f.term.id}|${f.document.id}`));
    }
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE_KEY|apiKey|signal|proxy/);
  });

  it('applies enabled entries without approval, skips library-disabled ones silently and reports per-run exclusions', async () => {
    const f = await fixture(21);
    const rule: Entry = { id: randomUUID(), revision: 1, collectionId: f.collectionId, enabled: true, kind: 'rule', payload: { text: 'Keep station names short.', required: true } };
    const off: TermEntry = { ...termEntry(f.collectionId, 'starport', '停用译名'), enabled: false };
    f.library.data.entries.push(rule, off);
    const input = f.request(); input.knowledge.disabledEntryIds = [rule.id];
    const preview = await f.service.plan(1, input);
    // Every entry of the selected collection is frozen, including excluded and disabled ones.
    expect(preview).toMatchObject({ canRun: true, includedEntryCount: 1, resourceCount: 4 });
    expect(preview.issues).toEqual([{ code: 'disabled', severity: 'warning', entryIds: [rule.id], cueIds: [] }]);
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' }); await f.translation.settled(started.taskId);
    expect(f.sent.mock.calls.map(([request]) => payload(request).translationKnowledge.items.map(item => item.payload))).toEqual([[f.term.payload], [f.term.payload]]);
    expect(JSON.stringify(f.sent.mock.calls)).not.toMatch(/停用译名|Keep station names short/);
    const knowledge = resolveExecutionRecord(await f.repository.readSnapshot(f.document.id), started.taskId).knowledge!;
    expect(Object.values(knowledge.batches).flatMap(batch => batch.items.map(item => item.entryId))).toEqual([f.term.id, f.term.id]);
    expect(knowledge.data.entries.map(entry => entry.id)).toEqual([f.term.id, rule.id, off.id]);
    expect(knowledge.selection.disabledEntryIds).toEqual([rule.id]);
  });

  it.each(['archived', 'language-mismatched'] as const)('blocks a selected collection that is %s before creating any task', async kind => {
    const f = await fixture(1);
    const collection = f.library.data.collections[0];
    if (kind === 'archived') collection.archived = true; else collection.languagePair = { source: 'ja', target: 'zh-Hans' };
    const preview = await f.service.plan(1, f.request());
    expect(preview.canRun).toBe(false);
    expect(preview.issues).toContainEqual(expect.objectContaining({ code: kind === 'archived' ? 'resource_archived' : 'language_mismatch', severity: 'error' }));
    await expect(f.service.start(1, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.sent).not.toHaveBeenCalled(); expect((await f.repository.readSnapshot(f.document.id)).tasks).toEqual([]);
  });

  it('blocks the whole document when a later window contains conflicting required knowledge', async () => {
    const f = await fixture(21);
    // Only the last cue contains the partly overlapping phrase ("port 21" crosses the end of "starport"), so the conflict appears in the second window.
    const conflicting = termEntry(f.collectionId, 'port 21', '另一个译法'); conflicting.payload.match.mode = 'literal_phrase'; f.library.data.entries.push(conflicting);
    const preview = await f.service.plan(1, f.request());
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

  it('resumes frozen knowledge and exact failed HTTP bytes after live knowledge and prompt builders change', async () => {
    let stop = true;
    const f = await fixture(43, async request => { if (stop && payload(request).items[0].id === 'u21') throw new Error('controlled provider stop'); return success(request); });
    const preview = await f.service.plan(1, f.request());
    const started = await f.service.start(1, { planId: preview.planId, apiKey: 'key' });
    await f.translation.settled(started.taskId);
    const failed = await f.repository.readSnapshot(f.document.id), frozen = resolveExecutionRecord(failed, started.taskId);
    expect(failed.tasks[0].status).toBe('failed'); expect(frozen.requests.b3).toBeUndefined();
    expect(frozen.knowledge!.policyVersion).toBe(KNOWLEDGE_EXECUTION_POLICY);
    f.library.data.entries = []; f.library.generation++; stop = false;
    const rebuilt = vi.spyOn(planner, 'buildTranslationRequest').mockImplementation(() => { throw new Error('do not rebuild'); });
    f.read.mockClear();
    await f.translation.resume(f.document.id, failed.document.revision, started.taskId, config().model, 'rotated-key'); await f.translation.settled(started.taskId);
    const [replayed, last] = f.sent.mock.calls.slice(-2).map(([request]) => request);
    expect(planner.serializeTranslationRequest(replayed)).toBe(frozen.requests.b2.httpBody);
    expect(last.messages[0]).toEqual(frozen.baseRequests.b3.request.messages[0]);
    expect(payload(last).translationKnowledge).toEqual(JSON.parse(frozen.baseRequests.b3.request.messages[1].content).translationKnowledge);
    expect(last.model.apiKey).toBe('rotated-key'); expect(f.read).not.toHaveBeenCalled(); expect(rebuilt).not.toHaveBeenCalled();
    expect((await f.repository.readSnapshot(f.document.id)).tasks[0].status).toBe('completed');
  });

  it('rejects a knowledge execution policy other than the current one even with a recomputed frozen snapshot digest', async () => {
    const f = await fixture(1), result = await prepareKnowledgeTranslation(f.repository, f.request(), f.library);
    const prepared = result.prepared!, knowledge = prepared.knowledge;
    expect(knowledge.policyVersion).toBe(KNOWLEDGE_EXECUTION_POLICY);
    knowledge.policyVersion = 'fktk-execution/99' as typeof KNOWLEDGE_EXECUTION_POLICY;
    for (const batch of Object.values(knowledge.batches)) batch.policyVersion = knowledge.policyVersion;
    const { digest: _digest, ...base } = knowledge; knowledge.digest = sha256Canonical(base);
    expect(() => validateFrozenKnowledgeSnapshot(knowledge)).toThrow('Invalid frozen knowledge snapshot');
    expect(() => records.createExecutionRecord(prepared.plan, prepared.sourceDigest, randomUUID(), randomUUID(), prepared)).toThrow();
    expect(f.sent).not.toHaveBeenCalled();
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

  it('rejects removed v1 selection fields and document topics as invalid input before reading knowledge', async () => {
    const f = await fixture(1), input = f.request();
    for (const forged of [
      { ...input, documentTopicIds: [randomUUID()] },
      { ...input, knowledge: { ...input.knowledge, bindings: [] } },
      { ...input, knowledge: { ...input.knowledge, confirmations: [] } },
      { ...input, knowledge: { ...input.knowledge, recipeId: randomUUID() } },
      { ...input, knowledge: { ...input.knowledge, version: 1 } },
    ]) {
      expect(knowledgeTranslationRequestSchemas.planKnowledgeTranslation.safeParse(forged).success).toBe(false);
      await expect(f.service.plan(1, forged as never)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(f.read).not.toHaveBeenCalled(); expect(f.sent).not.toHaveBeenCalled();
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
