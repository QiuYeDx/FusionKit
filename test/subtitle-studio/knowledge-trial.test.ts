import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult } from '../../electron/main/ai/model-runtime-client';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';
import type { KnowledgeTrialRequest } from '../../src/subtitle-studio/knowledge-trial-contract';
import { KnowledgeTrialService } from '../../electron/main/subtitle-studio/knowledge-trial';
import { requestTokenEstimate } from '../../electron/main/subtitle-studio/translation-planner';
import { TranslationScheduler } from '../../electron/main/subtitle-studio/translation-recovery';
import { ModelRuntimeClientError } from '../../electron/main/ai/model-runtime-errors';

const config = (overrides: Partial<TranslationConfig> = {}): TranslationConfig => ({
  model: { profileId: 'trial-fixture', modelKey: 'test-model', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' },
  language: 'zh-Hans', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 20, ...overrides,
});
const parse = (text = '[00:01]starport\n[00:02]Next line\n[00:03]Return to starport') => importSubtitleText(text, {
  format: 'lrc', displayName: 'knowledge-trial.lrc', encoding: 'utf-8', digest: 'a'.repeat(64),
}, randomUUID);
// Pure local fixture: trial tests do not depend on knowledge storage internals.
const library = (): LibrarySnapshot => ({ generation: 1, data: {
  format: 'fusionkit.translation-knowledge', schemaVersion: 1,
  package: { id: randomUUID(), revision: 1, name: 'Trial knowledge fixture', description: '', purpose: 'backup', createdAt: '2026-09-14T00:00:00Z', generator: { name: 'Knowledge trial test' } },
  subjects: [], collections: [], sources: [], entries: [], styles: [], recipes: [], preferenceTemplates: [],
}, approvals: {}, imports: [] });
const selection = (collectionIds: string[] = []): KnowledgeSelection => ({ version: 1, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds, bindings: [], confirmations: [], disabledEntryIds: [] });
function trustedTerm() {
  const snapshot = library();
  const collectionId = randomUUID(), sourceId = randomUUID(), entryId = randomUUID();
  snapshot.data.collections.push({ id: collectionId, revision: 1, archived: false, name: 'Trial glossary', description: '', aboutSubjectIds: [] });
  snapshot.data.sources.push({ id: sourceId, revision: 1, kind: 'user_note', title: 'Private evidence', excerpt: 'PRIVATE_EVIDENCE_NOT_SENT' });
  const term = { id: entryId, revision: 1, title: 'Starport', kind: 'term' as const, collectionId, aboutSubjectIds: [], state: 'ready' as const,
    scope: { languagePair: { source: 'en', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' as const } }, evidence: [{ sourceId, support: 'direct' as const }], derivedFrom: [],
    payload: { source: 'starport', target: '星际港口', aliases: [], sense: '', match: { mode: 'whole_term' as const, caseSensitive: false }, strength: 'required' as const } };
  snapshot.data.entries.push(term);
  snapshot.approvals[entryId] = { revision: 1, digest: sha256Canonical(term), method: 'human', approvedAt: new Date().toISOString() };
  return { snapshot, selection: selection([collectionId]), term, sourceId };
}
const success = (request: ModelRuntimeTextRequest): ModelRuntimeTextResult => ({
  apiFormat: request.model.apiFormat, finishReason: 'stop', rawStatus: 'completed', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  content: JSON.stringify({ items: (JSON.parse(request.messages[1].content).items as { id: string; text: string }[]).map(item => ({ id: item.id, text: `译文 ${item.id}` })) }),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
async function fixture(text?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-trial-'));
  roots.push(root);
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const document = parse(text);
  await repository.create(document);
  return { root, repository, document };
}
const request = (current: Awaited<ReturnType<typeof fixture>>, knowledge = selection(), overrides: Partial<KnowledgeTrialRequest> = {}): KnowledgeTrialRequest => ({ documentId: current.document.id, knowledgeGeneration: 1, revision: current.document.revision, config: config(), knowledge, ...overrides });
const serviceFor = (current: Awaited<ReturnType<typeof fixture>>, read = async () => library(), send: (input: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult> = async input => success(input), now?: () => number) => {
  const service = new KnowledgeTrialService(current.repository, read, send, new TranslationScheduler(1), now);
  cleanup.push(() => service.dispose());
  return service;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('isolated subtitle knowledge trials', () => {
  it.each(['chat_completions', 'responses'] as const)('sends frozen applicable knowledge through the actual %s protocol without writing tracks or evidence', async apiFormat => {
    const current = await fixture();
    const initial = await current.repository.readSnapshot(current.document.id);
    const term = trustedTerm();
    const sent: ModelRuntimeTextRequest[] = [];
    const service = serviceFor(current, async () => term.snapshot, async input => { sent.push(input); return success(input); });
    const input = request(current, { ...term.selection, instructions: 'Use concise dialogue.' }, { config: config({ language: 'Japanese', instructions: 'OLD_INSTRUCTION_IGNORED', model: { ...config().model, apiFormat } }) });
    const plan = await service.plan(1, input);
    expect(plan.canRun).toBe(true);
    expect(plan.batches.flatMap(batch => batch.knowledge.items).some(item => item.entryId === term.term.id)).toBe(true);
    const previewPayload = plan.batches[0].knowledge.items[0].payload;
    if ('target' in previewPayload) previewPayload.target = 'UI_PREVIEW_MUTATION';
    term.term.payload.target = 'MUTATED_AFTER_PREVIEW';
    term.snapshot.generation++;
    const result = await service.run(1, { planId: plan.planId, apiKey: 'PRIVATE_API_KEY' });
    expect(result.status).toBe('completed');
    expect(result.requestCount).toBe(plan.batchCount);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].issues.some(issue => issue.code === 'required_term_suspect')).toBe(true);
    for (const [index, input] of sent.entries()) {
      const payload = JSON.parse(input.messages[1].content);
      expect(payload.targetLanguage).toBe('zh-Hans');
      expect(payload.translationRequirements).toBe('Use concise dialogue.');
      expect(payload.context.priorModelTranslations).toEqual([]);
      expect(payload.translationKnowledge.items[0].applicableItemIds).toEqual(['u1', 'u3']);
      const body = JSON.stringify(input.messages);
      expect(body).toContain('星际港口');
      for (const privateValue of [term.term.id, term.sourceId, current.document.id, 'PRIVATE_EVIDENCE_NOT_SENT', 'MUTATED_AFTER_PREVIEW', 'UI_PREVIEW_MUTATION', 'OLD_INSTRUCTION_IGNORED']) expect(body).not.toContain(privateValue);
      expect(requestTokenEstimate(input)).toBe(plan.batches[index].estimatedInputTokens);
      expect(input.retry).toEqual({ maxRetries: 0 });
    }
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(await current.repository.readSnapshot(current.document.id)).toEqual(initial);
    await expect(service.run(1, { planId: plan.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('inherits the current form instructions unless the trial explicitly clears them', async () => {
    const current = await fixture();
    const service = serviceFor(current);
    const inherited = await service.plan(1, request(current, selection(), { config: config({ instructions: 'Keep the dialogue concise.' }) }));
    expect(inherited.batches[0].knowledge.instructions).toBe('Keep the dialogue concise.');
    const cleared = await service.plan(1, request(current, { ...selection(), instructions: '' }, { config: config({ instructions: 'Keep the dialogue concise.' }) }));
    expect(cleared.batches[0].knowledge.instructions).toBe('');
  });

  it('defaults to twenty source cues and orders an explicit sample by document order', async () => {
    const current = await fixture(Array.from({ length: 24 }, (_, index) => `[00:${String(index + 1).padStart(2, '0')}]Line ${index + 1}`).join('\n'));
    const service = serviceFor(current);
    const plan = await service.plan(1, request(current));
    expect(plan.cues.map(cue => cue.id)).toEqual(current.document.cues.slice(0, 20).map(cue => cue.id));
    const chosen = [current.document.cues[5].id, current.document.cues[1].id];
    const subset = await service.plan(1, request(current, selection(), { cueIds: chosen }));
    expect(subset.cues.map(cue => cue.id)).toEqual([...chosen].reverse());
    await expect(service.plan(1, request(current, selection(), { cueIds: [chosen[0], chosen[0]] }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.plan(1, request(current, selection(), { cueIds: [randomUUID()] }))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('keeps unmatched and untrusted knowledge out of requests and represents missing usage as unknown', async () => {
    const current = await fixture();
    const term = trustedTerm(); delete term.snapshot.approvals[term.term.id];
    const send = vi.fn(async (input: ModelRuntimeTextRequest) => ({ ...success(input), usage: undefined }));
    const service = serviceFor(current, async () => term.snapshot, send);
    const plan = await service.plan(1, request(current, term.selection));
    expect(plan.issues.some(issue => issue.code === 'untrusted')).toBe(true);
    expect(plan.canRun).toBe(true);
    const result = await service.run(1, { planId: plan.planId, apiKey: 'key' });
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(JSON.parse(send.mock.calls[0][0].messages[1].content).translationKnowledge.items).toEqual([]);
  });

  it('blocks a minimum cue whose mandatory knowledge cannot fit and never calls the provider', async () => {
    const current = await fixture();
    const term = trustedTerm();
    term.term.payload.target = 'required terminology '.repeat(1200);
    term.snapshot.approvals[term.term.id].digest = sha256Canonical(term.term);
    const send = vi.fn(async (input: ModelRuntimeTextRequest) => success(input));
    const service = serviceFor(current, async () => term.snapshot, send);
    const plan = await service.plan(1, request(current, term.selection, { config: config({ contextWindow: 2048, maxOutputTokens: 256 }) }));
    expect(plan.canRun).toBe(false);
    expect(plan.issues.some(issue => issue.code === 'budget_required')).toBe(true);
    await expect(service.run(1, { planId: plan.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(send).not.toHaveBeenCalled();
  });

  it('drops optional references as whole entries before splitting a fitting source sample', async () => {
    const current = await fixture();
    const term = trustedTerm();
    const contextId = randomUUID();
    const context = { ...structuredClone(term.term), id: contextId, title: 'Optional background', kind: 'context' as const, payload: { text: 'optional reference detail '.repeat(1000), assertion: 'fact' as const, core: false } };
    term.snapshot.data.entries.push(context);
    term.snapshot.approvals[context.id] = { ...term.snapshot.approvals[term.term.id], digest: sha256Canonical(context) };
    const service = serviceFor(current, async () => term.snapshot);
    const plan = await service.plan(1, request(current, term.selection, { config: config({ contextWindow: 2048, maxOutputTokens: 256 }) }));
    expect(plan.canRun).toBe(true);
    expect(plan.batchCount).toBe(1);
    expect(plan.batches[0].knowledge.items.map(item => item.entryId)).toEqual([term.term.id]);
    expect(plan.issues.some(issue => issue.code === 'budget_excluded' && issue.entryIds.includes(context.id))).toBe(true);
  });

  it('rejects another owner, expired plans and stale document revisions before sending', async () => {
    const current = await fixture(); let now = 1;
    const send = vi.fn(async (input: ModelRuntimeTextRequest) => success(input));
    const service = serviceFor(current, undefined, send, () => now);
    const plan = await service.plan(1, request(current));
    await expect(service.run(2, { planId: plan.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'access_denied' });
    now += 16 * 60 * 1000;
    await expect(service.run(1, { planId: plan.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'revision_conflict' });
    const next = await service.plan(1, request(current));
    await current.repository.transact(current.document.id, 1, () => {});
    expect(await service.run(1, { planId: next.planId, apiKey: 'key' })).toMatchObject({ status: 'failed', error: 'revision_conflict', requestCount: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('fences an older in-flight plan when a newer preview or owner release wins', async () => {
    const current = await fixture();
    const read = deferred<LibrarySnapshot>(); let reads = 0;
    const service = serviceFor(current, () => ++reads === 1 ? read.promise : Promise.resolve(library()));
    const older = service.plan(1, request(current));
    await vi.waitFor(() => expect(reads).toBe(1));
    const newer = await service.plan(1, request(current));
    const failed = expect(older).rejects.toMatchObject({ code: 'access_denied' });
    read.resolve(library()); await failed;
    service.forgetOwner(1);
    await expect(service.run(1, { planId: newer.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('joins an in-flight knowledge read during shutdown and fences its late plan', async () => {
    const current = await fixture();
    const read = deferred<LibrarySnapshot>(); let reading = false;
    const service = serviceFor(current, () => { reading = true; return read.promise; });
    const plan = service.plan(1, request(current));
    const rejected = expect(plan).rejects.toMatchObject({ code: 'access_denied' });
    await vi.waitFor(() => expect(reading).toBe(true));
    let closed = false;
    const close = service.dispose().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    read.resolve(library()); await rejected; await close;
    expect(closed).toBe(true);
  });

  it.each(['cancel', 'dispose', 'forgetOwner'] as const)('aborts and joins a supplier that ignores cancellation on %s', async operation => {
    const current = await fixture();
    const response = deferred<ModelRuntimeTextResult>(); let outgoing: ModelRuntimeTextRequest | undefined;
    const service = serviceFor(current, undefined, async input => { outgoing = input; return response.promise; });
    const plan = await service.plan(1, request(current));
    const run = service.run(1, { planId: plan.planId, apiKey: 'key' });
    await vi.waitFor(() => expect(outgoing).toBeDefined());
    await expect(service.run(1, { planId: plan.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'resource_busy' });
    let joined = false;
    const close = operation === 'cancel' ? service.cancel(1) : operation === 'dispose' ? service.dispose() : (service.forgetOwner(1), service.dispose());
    void close.then(() => { joined = true; });
    expect(outgoing!.signal!.aborted).toBe(true);
    await Promise.resolve(); expect(joined).toBe(false);
    response.resolve(success(outgoing!));
    expect(await run).toMatchObject({ status: 'cancelled', error: 'interrupted', requestCount: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    await close;
    expect(joined).toBe(true);
    expect((await current.repository.readSnapshot(current.document.id)).tasks).toEqual([]);
  });

  it('aborts late results after document edits and rejects invalid protocol without a retry or write', async () => {
    const current = await fixture();
    const response = deferred<ModelRuntimeTextResult>(); let outgoing: ModelRuntimeTextRequest | undefined;
    const service = serviceFor(current, undefined, async input => { outgoing = input; return response.promise; });
    const plan = await service.plan(1, request(current));
    const run = service.run(1, { planId: plan.planId, apiKey: 'key' });
    await vi.waitFor(() => expect(outgoing).toBeDefined());
    await current.repository.transact(current.document.id, 1, () => {});
    expect(outgoing!.signal!.aborted).toBe(true);
    response.resolve(success(outgoing!));
    expect(await run).toMatchObject({ status: 'cancelled', error: 'interrupted', requestCount: 1 });
    const invalidSend = vi.fn(async (input: ModelRuntimeTextRequest) => ({ ...success(input), content: '{"items":[]}' }));
    const invalidService = serviceFor(current, undefined, invalidSend);
    const next = await invalidService.plan(2, request(current, selection(), { revision: 2 }));
    expect(await invalidService.run(2, { planId: next.planId, apiKey: 'key' })).toMatchObject({ status: 'failed', error: 'translation_protocol_invalid', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    expect(invalidSend).toHaveBeenCalledTimes(1);
    expect((await current.repository.readSnapshot(current.document.id)).document.translationTracks).toEqual([]);
  });

  it('retains partial results and records unknown supplier usage when a later request fails', async () => {
    const current = await fixture(); let requests = 0;
    const service = serviceFor(current, undefined, async input => {
      if (++requests === 1) return success(input);
      throw new ModelRuntimeClientError('network_error', 'offline', true);
    });
    const plan = await service.plan(1, request(current, selection(), { config: config({ maxBatchCues: 1 }) }));
    const result = await service.run(1, { planId: plan.planId, apiKey: 'key' });
    expect(result).toMatchObject({ status: 'failed', error: 'translation_failed', requestCount: 2, usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
    expect(result.items).toHaveLength(1);
    expect((await current.repository.readSnapshot(current.document.id)).document.translationTracks).toEqual([]);
  });

  it('keeps a large selected library blocked and rejects an oversized evidence preview rather than truncating it', async () => {
    const current = await fixture();
    const term = trustedTerm();
    for (let index = 0; index < 500; index++) term.snapshot.data.entries.push({ ...structuredClone(term.term), id: randomUUID(), title: `Term ${index}` });
    const service = serviceFor(current, async () => term.snapshot);
    const plan = await service.plan(1, request(current, term.selection));
    expect(plan.canRun).toBe(false);
    expect(plan.issues.some(issue => issue.code === 'resource_limit' && issue.severity === 'error')).toBe(true);
    const large = trustedTerm();
    large.snapshot.data.sources[0].excerpt = 'e'.repeat(32000);
    for (let index = 0; index < 299; index++) {
      const entry = { ...structuredClone(large.term), id: randomUUID(), title: `Evidence ${index}` };
      large.snapshot.data.entries.push(entry);
      large.snapshot.approvals[entry.id] = { ...large.snapshot.approvals[large.term.id], digest: sha256Canonical(entry) };
    }
    const largeService = serviceFor(current, async () => large.snapshot);
    await expect(largeService.plan(2, request(current, large.selection, { config: config({ contextWindow: 1000000 }) }))).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});
