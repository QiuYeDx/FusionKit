import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioError } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { KnowledgeTaskGate } from '../../src/translation-knowledge/task-reference-contract';
import type { Entry } from '../../src/translation-knowledge/schemas';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { KnowledgeTranslationService } from '../../electron/main/subtitle-studio/knowledge-translation';
import * as single from '../../electron/main/subtitle-studio/knowledge-translation';
import { KnowledgeBatchTranslationService, KNOWLEDGE_BATCH_LIMITS } from '../../electron/main/subtitle-studio/knowledge-batch-translation';
import { knowledgeBatchRequestSchemas, type KnowledgeBatchTranslationRequest } from '../../src/subtitle-studio/knowledge-batch-contract';
import { TranslationService } from '../../electron/main/subtitle-studio/translation-service';
import { TranslationScheduler } from '../../electron/main/subtitle-studio/translation-recovery';
import { resolveExecutionRecord } from '../../electron/main/subtitle-studio/execution-records';
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
async function fixture(count = 3, send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = async request => success(request), cueCount = 2) {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-formal-'));
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const documents = [];
  for (let index = 0; index < count; index++) {
    const document = importSubtitleText(lines(cueCount), { format: 'lrc', displayName: `batch-${index + 1}.lrc`, encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
    await repository.create(document); documents.push(document);
  }
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
  const batch = new KnowledgeBatchTranslationService(repository, translation, read, gate);
  const releases: (() => void)[] = [];
  cleanups.push(async () => { for (const release of releases) release(); await batch.dispose(); await service.dispose(); await translation.dispose(); for (const document of documents) for (const task of (await repository.readSnapshot(document.id).catch(() => ({ tasks: [] }))).tasks) await translation.settled(task.id); await rm(root, { recursive: true, force: true }); });
  const request = (overrides: Partial<KnowledgeBatchTranslationRequest> = {}): KnowledgeBatchTranslationRequest => ({ documents: documents.map(document => ({ documentId: document.id, revision: document.revision })), knowledgeGeneration: library.generation, config: config(), knowledge: { version: 1, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [collectionId], disabledEntryIds: [] }, documentTopicIds: [topicId], ...overrides });
  return { root, repository, documents, library, term, topicId, sourceId, approve, service, batch, translation, gate, sent, read, request, releases };
}

describe('formal knowledge batch admission', () => {
  it.each(['instructions', 'context', 'recipeId'] as const)('treats explicit undefined %s from IPC as an absent choice and still admits the frozen plan', async field => {
    const f = await fixture(1), input = f.request();
    const absent = await f.batch.plan(1, input);
    input.knowledge[field] = undefined;
    const explicit = await f.batch.plan(1, input);
    expect(explicit.items).toEqual(absent.items); expect(explicit.readyCount).toBe(1);
    expect(Object.hasOwn(input.knowledge, field)).toBe(true);
    const started = await f.batch.start(1, { planId: explicit.planId, apiKey: 'key' });
    const item = started.items[0]; if (!item.ok) throw new Error(item.error);
    await f.translation.settled(item.taskId);
    const record = resolveExecutionRecord(await f.repository.readSnapshot(item.documentId), item.taskId);
    expect(Object.hasOwn(record.knowledge!.selection, field)).toBe(false);
    expect(record.plan.config.language).toBe('zh-Hans');
    expect(f.sent).toHaveBeenCalledTimes(1);
  });

  it.each(['chat_completions', 'responses'] as const)('freezes one library read for independent %s records and does not consume the single-file preview', async apiFormat => {
    const f = await fixture(); const input = f.request({ config: config({ model: { ...config().model, apiFormat } }) });
    const first = f.documents[0];
    const singlePreview = await f.service.plan(1, { documentId: first.id, revision: first.revision, knowledgeGeneration: 1, config: input.config,
      knowledge: { ...input.knowledge, bindings: [], confirmations: [] }, documentTopicIds: input.documentTopicIds });
    f.read.mockClear();
    const preview = await f.batch.plan(1, { ...input, documents: input.documents.slice(1) });
    expect(f.read).toHaveBeenCalledTimes(1); expect(preview.readyCount).toBe(2);
    expect(preview.items.every(item => item.ok && item.plan.canRun)).toBe(true);
    preview.items.reverse(); // Renderer mutations cannot change cached execution order.
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'PRIVATE_BATCH_KEY' });
    expect(result.items.map(item => item.documentId)).toEqual(input.documents.slice(1).map(item => item.documentId));
    for (const item of result.items) {
      if (!item.ok) throw new Error(`unexpected ${item.error}`);
      await f.translation.settled(item.taskId);
      const snapshot = await f.repository.readSnapshot(item.documentId), record = resolveExecutionRecord(snapshot, item.taskId);
      expect(snapshot.tasks[0].status).toBe('completed'); expect(record.knowledge!.generation).toBe(1);
      expect(record.knowledge!.data.entries[0]).toEqual(f.term);
      expect(record.plan.batches[0].units.map(unit => unit.id)).toEqual(['u1', 'u2']);
      expect(record.requests.b1.httpBody).toBe(planner.serializeTranslationRequest(f.sent.mock.calls.find(([request]) => record.requests.b1.httpBody === planner.serializeTranslationRequest(request))![0]));
      expect(JSON.stringify(record)).not.toMatch(/PRIVATE_BATCH_KEY|apiKey|signal|proxy/);
    }
    const singleTask = await f.service.start(1, { planId: singlePreview.planId, apiKey: 'single-key' }); await f.translation.settled(singleTask.taskId);
    await expect(f.batch.start(1, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('uses the original library snapshot for later documents even if the live object changes during planning', async () => {
    const f = await fixture();
    const original = single.prepareKnowledgeTranslation; let calls = 0;
    vi.spyOn(single, 'prepareKnowledgeTranslation').mockImplementation(async (...args) => {
      const prepared = await original(...args);
      if (!calls++ && f.term.kind === 'term') { f.term.payload.target = 'live mutation'; f.approve(); }
      return prepared;
    });
    const preview = await f.batch.plan(1, f.request()); expect(f.read).toHaveBeenCalledTimes(1);
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' });
    for (const item of result.items) if (item.ok) {
      await f.translation.settled(item.taskId);
      const record = resolveExecutionRecord(await f.repository.readSnapshot(item.documentId), item.taskId);
      expect(record.knowledge!.data.entries[0].payload).toMatchObject({ target: '星港' });
    }
  });

  it('reports a stale document independently and admits ready siblings without recompilation', async () => {
    const f = await fixture(); const input = f.request();
    await f.repository.transact(f.documents[1].id, 1, () => {});
    const preview = await f.batch.plan(1, input);
    expect(preview.readyCount).toBe(2); expect(preview.items[1]).toMatchObject({ ok: false, error: 'revision_conflict' });
    vi.spyOn(single, 'prepareKnowledgeTranslation').mockImplementation(async () => { throw new Error('must never rebuild at admission'); });
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' });
    expect(result.items[1]).toMatchObject({ ok: false, error: 'revision_conflict' });
    for (const item of result.items) if (item.ok) await f.translation.settled(item.taskId);
    expect(f.sent).toHaveBeenCalledTimes(2);
  });

  it('returns knowledge conflicts as blocked previews while retaining runnable documents', async () => {
    const f = await fixture();
    const conflicting = structuredClone(f.term); conflicting.id = randomUUID(); conflicting.scope.requiredSubjects = [];
    if (conflicting.kind !== 'term') throw new Error('fixture'); conflicting.payload.target = '其他术语'; conflicting.payload.source = 'conflict';
    const matching = structuredClone(conflicting); matching.id = randomUUID(); matching.payload.target = '另一个术语';
    f.library.data.entries.push(conflicting, matching); f.approve();
    const doc = f.documents[1]; await f.repository.transact(doc.id, 1, value => { const cue = value.document.cues[0]; cue.source = { plain: 'conflict', spans: [{ text: 'conflict', marks: [] }] }; cue.sourceRevision++; });
    const input = f.request(); input.documents[1].revision++;
    const preview = await f.batch.plan(1, input); expect(preview.readyCount).toBe(2);
    expect(preview.items[1]).toMatchObject({ ok: true, plan: { canRun: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'term_conflict' })]) } });
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' }); expect(result.items[1]).toMatchObject({ ok: false, error: 'invalid_input' });
    for (const item of result.items) if (item.ok) await f.translation.settled(item.taskId);
    expect((await f.repository.readSnapshot(doc.id)).tasks).toEqual([]);
  });

  it('rejects an outdated whole-batch knowledge generation before creating any task', async () => {
    const f = await fixture(), preview = await f.batch.plan(1, f.request()); f.library.generation++;
    await expect(f.batch.start(1, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'revision_conflict' });
    for (const document of f.documents) expect((await f.repository.readSnapshot(document.id)).tasks).toEqual([]);
    expect(f.sent).not.toHaveBeenCalled();
  });

  it('isolates a document changed after preview and does not rebuild its prepared translation', async () => {
    const f = await fixture(), preview = await f.batch.plan(1, f.request());
    await f.repository.transact(f.documents[1].id, 1, () => {});
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' }); expect(result.items.map(item => item.ok)).toEqual([true, false, true]);
    expect(result.items[1]).toMatchObject({ error: 'revision_conflict' });
    for (const item of result.items) if (item.ok) await f.translation.settled(item.taskId);
  });

  it.each(['cancel', 'owner', 'replacement', 'generation', 'dispose'] as const)('preserves admitted task IDs and stops remaining documents after %s races the first acknowledgement', async action => {
    const f = await fixture(), preview = await f.batch.plan(1, f.request());
    const admit = f.translation.startPreparedKnowledge.bind(f.translation); let calls = 0; let operation: Promise<unknown> | undefined;
    vi.spyOn(f.translation, 'startPreparedKnowledge').mockImplementation(async (...args) => {
      const result = await admit(...args);
      if (!calls++) {
        if (action === 'cancel') operation = f.batch.cancel(1);
        if (action === 'owner') operation = f.batch.forgetOwner(1);
        if (action === 'replacement') operation = f.batch.plan(1, f.request({ documents: [f.request().documents[2]] }));
        if (action === 'generation') f.library.generation++;
        if (action === 'dispose') operation = f.batch.dispose();
      }
      return result;
    });
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' }); await operation;
    expect(result.items[0]).toMatchObject({ ok: true, taskId: expect.any(String) });
    expect(result.items.slice(1).map(item => item.ok)).toEqual([false, false]);
    expect(result.items[1]).toMatchObject({ error: action === 'generation' ? 'revision_conflict' : 'access_denied' });
    expect(calls).toBe(1);
    if (result.items[0].ok) await f.translation.settled(result.items[0].taskId);
    for (const document of f.documents.slice(1)) expect((await f.repository.readSnapshot(document.id)).tasks).toEqual([]);
    await expect(f.batch.start(1, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('finishes admission without waiting for the provider and allows other gate operations', async () => {
    const release = defer<ModelRuntimeTextResult>(), entered = defer<ModelRuntimeTextRequest>();
    const f = await fixture(3, request => { entered.resolve(request); return release.promise; });
    const preview = await f.batch.plan(1, f.request()), result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' });
    const request = await entered.promise; f.releases.push(() => release.resolve(success(request)));
    expect(result.items.every(item => item.ok)).toBe(true);
    expect(await f.gate.run(async () => 'available')).toBe('available');
    for (const item of result.items) if (item.ok) {
      const snapshot = await f.repository.readSnapshot(item.documentId);
      expect(resolveExecutionRecord(snapshot, item.taskId).knowledge).toBeDefined();
      await f.translation.cancel(item.documentId, snapshot.document.revision, item.taskId);
    }
    release.resolve(success(request));
    for (const item of result.items) if (item.ok) await f.translation.settled(item.taskId);
  });

  it('rejects duplicate start and caller mutations, owner mismatch and expiry before admission', async () => {
    const f = await fixture(), preview = await f.batch.plan(1, f.request());
    await expect(f.batch.start(2, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'access_denied' });
    await expect(f.batch.start(1, { planId: preview.planId, apiKey: 'key', prepared: {} } as never)).rejects.toMatchObject({ code: 'invalid_input' });
    const start = f.batch.start(1, { planId: preview.planId, apiKey: 'key' });
    await expect(f.batch.start(1, { planId: preview.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'revision_conflict' });
    const result = await start; for (const item of result.items) if (item.ok) await f.translation.settled(item.taskId);
    const next = await f.batch.plan(1, f.request({ documents: [{ documentId: f.documents[0].id, revision: (await f.repository.read(f.documents[0].id)).revision }] }));
    vi.spyOn(Date, 'now').mockReturnValue(next.expiresAt + 1);
    await expect(f.batch.start(1, { planId: next.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('supersedes an in-flight plan and cancels pending work without retaining usable child plans', async () => {
    const f = await fixture();
    const old = f.batch.plan(1, f.request()), rejected = expect(old).rejects.toMatchObject({ code: 'access_denied' });
    const next = await f.batch.plan(1, f.request()); await rejected;
    await f.batch.cancel(1); await expect(f.batch.start(1, { planId: next.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'access_denied' });
    expect(f.sent).not.toHaveBeenCalled();
  });

  it.each(['cues', 'scanBytes', 'planningBytes', 'diagnosticBytes'] as const)('stops consuming later files after the cumulative %s work budget is exhausted', async kind => {
    const f = await fixture(); const prepare = single.prepareKnowledgeTranslation; let count = 0;
    const spy = vi.spyOn(single, 'prepareKnowledgeTranslation').mockImplementation(async (...args) => {
      if (++count === 2) args[4]!.charge(kind, KNOWLEDGE_BATCH_LIMITS[kind] + 1);
      return prepare(...args);
    });
    const preview = await f.batch.plan(1, f.request());
    expect(preview.readyCount).toBe(1); expect(preview.items.slice(1)).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, error: 'limit_exceeded' })])); expect(spy).toHaveBeenCalledTimes(2);
  });

  it('caps retained prepared material across files and never builds the remaining document after exhaustion', async () => {
    const f = await fixture(4), prepare = single.prepareKnowledgeTranslation;
    const spy = vi.spyOn(single, 'prepareKnowledgeTranslation').mockImplementation(async (...args) => {
      const result = await prepare(...args);
      // A synthetic large payload isolates the batch cache bound from single-file schema limits.
      result.prepared!.knowledge.data.package.description = 'x'.repeat(12 * 1024 * 1024);
      return result;
    });
    const preview = await f.batch.plan(1, f.request());
    expect(preview.readyCount).toBe(2); expect(preview.items.map(item => item.ok)).toEqual([true, true, false, false]); expect(spy).toHaveBeenCalledTimes(3);
    expect(preview.items[2]).toMatchObject({ error: 'limit_exceeded' });
  });

  it('keeps the ready prefix runnable when file material fits but the complete cache envelope would exceed its limit', async () => {
    const f = await fixture(2), prepare = single.prepareKnowledgeTranslation;
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    let acceptedMaterial = 0, calls = 0;
    vi.spyOn(single, 'prepareKnowledgeTranslation').mockImplementation(async (...args) => {
      const result = await prepare(...args);
      const summary = { ...result.preview, issueCount: result.preview.issues.length };
      if (++calls === 2) {
        // The previous accounting accepted these two materials at exactly the
        // limit, then rejected the entire batch when adding its actual envelope.
        result.prepared!.knowledge.data.package.description = '';
        result.prepared!.knowledge.data.package.description = 'x'.repeat(KNOWLEDGE_BATCH_LIMITS.cachedBytes - acceptedMaterial - size({ summary, prepared: result.prepared }));
      }
      acceptedMaterial += size({ summary, prepared: result.prepared });
      return result;
    });
    const preview = await f.batch.plan(1, f.request());
    expect(acceptedMaterial).toBe(KNOWLEDGE_BATCH_LIMITS.cachedBytes);
    expect(preview.readyCount).toBe(1); expect(preview.items.map(item => item.ok)).toEqual([true, false]);
    expect(preview.items[1]).toMatchObject({ error: 'limit_exceeded' });
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' });
    expect(result.items[0]).toMatchObject({ ok: true, taskId: expect.any(String) });
    expect(result.items[1]).toMatchObject({ ok: false, error: 'limit_exceeded' });
    if (result.items[0].ok) await f.translation.settled(result.items[0].taskId);
    expect(f.sent).toHaveBeenCalledTimes(1);
  });

  it('reserves escaped failure names and final metadata before retaining material near the cache limit', async () => {
    const f = await fixture(3), prepare = single.prepareKnowledgeTranslation;
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const failureName = '\u0000'.repeat(255);
    await f.repository.transact(f.documents[2].id, 1, snapshot => { snapshot.document.origin.displayName = failureName; });
    let materialBytes = 0;
    vi.spyOn(single, 'prepareKnowledgeTranslation').mockImplementation(async (...args) => {
      const result = await prepare(...args);
      if (args[1].documentId === f.documents[1].id) {
        // Leave just enough room for the reserved failure row and envelope.
        // The remaining file fails before preparation and retains its full name.
        result.prepared!.knowledge.data.package.description = '';
        const extra = KNOWLEDGE_BATCH_LIMITS.cachedBytes - 8192 - materialBytes - size(result.prepared);
        result.prepared!.knowledge.data.package.description = 'x'.repeat(extra);
      }
      materialBytes += size(result.prepared);
      return result;
    });
    const preview = await f.batch.plan(1, f.request());
    expect(preview.readyCount).toBe(2);
    expect(preview.items[2]).toMatchObject({ ok: false, displayName: failureName, error: 'revision_conflict' });
    // The two prepared values are inserted into a JSON array; its brackets are
    // already in this envelope and the extra byte is the separating comma.
    const completeBytes = size({ preview, prepared: [] }) + materialBytes + 1;
    expect(completeBytes).toBeGreaterThan(KNOWLEDGE_BATCH_LIMITS.cachedBytes - 8192);
    expect(completeBytes).toBeLessThanOrEqual(KNOWLEDGE_BATCH_LIMITS.cachedBytes);
    // A second owner cannot steal the bytes reserved for this cached plan.
    const other = await f.batch.plan(2, f.request({ documents: [f.request().documents[0]] }));
    expect(other.readyCount).toBe(0); expect(other.items[0]).toMatchObject({ ok: false, error: 'limit_exceeded' });
    expect(completeBytes + size({ preview: other, prepared: [] })).toBeLessThanOrEqual(KNOWLEDGE_BATCH_LIMITS.cachedBytes);
  });

  it('limits preview diagnostics while preserving the complete prepared knowledge record', async () => {
    const f = await fixture(1, undefined, 30), prepare = single.prepareKnowledgeTranslation;
    const cueIds = f.documents[0].cues.map(cue => cue.id).reverse();
    vi.spyOn(single, 'prepareKnowledgeTranslation').mockImplementation(async (...args) => {
      const result = await prepare(...args);
      result.preview.issues = Array.from({ length: 130 }, () => ({ code: 'untrusted', severity: 'warning', entryIds: [f.term.id], cueIds }));
      return result;
    });
    const preview = await f.batch.plan(1, f.request()), item = preview.items[0];
    if (!item.ok) throw new Error('expected preview');
    expect(item.plan.issueCount).toBe(130); expect(item.plan.issues).toHaveLength(100); expect(item.plan.issues[0].cueIds).toHaveLength(20);
    expect(item.plan.issues[0]).toMatchObject({ cueIds: cueIds.slice(0, 20), cueNumbers: Array.from({ length: 20 }, (_, index) => 30 - index) });
    const result = await f.batch.start(1, { planId: preview.planId, apiKey: 'key' });
    if (result.items[0].ok) { await f.translation.settled(result.items[0].taskId); expect(resolveExecutionRecord(await f.repository.readSnapshot(f.documents[0].id), result.items[0].taskId).knowledge).toBeDefined(); }
  });

  it('rejects more than twenty files, duplicate files and file-scoped roles in shared batch choices', async () => {
    const f = await fixture(1), input = f.request();
    for (const request of [
      { ...input, documents: Array.from({ length: 21 }, () => ({ documentId: randomUUID(), revision: 1 })) },
      { ...input, documents: [input.documents[0], input.documents[0]] },
      { ...input, knowledge: { ...input.knowledge, bindings: [] } },
      { ...input, knowledge: { ...input.knowledge, confirmations: [] } },
    ]) {
      expect(knowledgeBatchRequestSchemas.planKnowledgeTranslationBatch.safeParse(request).success).toBe(false);
      await expect(f.batch.plan(1, request as never)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(f.sent).not.toHaveBeenCalled();
  });
});
