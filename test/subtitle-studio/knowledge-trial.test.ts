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
import type { Entry, TermEntry } from '../../src/translation-knowledge/schemas';
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
  format: 'fusionkit.translation-knowledge', schemaVersion: 2,
  package: { id: randomUUID(), revision: 1, name: 'Trial knowledge fixture', description: '', createdAt: '2026-09-14T00:00:00Z', generator: { name: 'Knowledge trial test' } },
  collections: [], entries: [], presets: [],
} });
const selection = (collectionIds: string[] = []): KnowledgeSelection => ({ version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds, disabledEntryIds: [] });
/** One enabled required term in a selected collection; enabled entries apply without any approval. */
function glossaryTerm() {
  const snapshot = library();
  const collectionId = randomUUID(), entryId = randomUUID();
  snapshot.data.collections.push({ id: collectionId, revision: 1, name: 'Trial glossary', description: '', languagePair: { source: 'en', target: 'zh-Hans' }, archived: false });
  const term: TermEntry = { id: entryId, revision: 1, collectionId, enabled: true, kind: 'term',
    origin: { kind: 'web', note: 'PRIVATE_ORIGIN_NOT_SENT', url: 'https://private.example/PRIVATE_ORIGIN_URL', title: 'PRIVATE_ORIGIN_TITLE' },
    payload: { source: 'starport', target: '星际港口', aliases: [], note: '', match: { mode: 'whole_term', caseSensitive: false }, strength: 'required' } };
  snapshot.data.entries.push(term);
  return { snapshot, selection: selection([collectionId]), term, collectionId };
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
  it.each(['chat_completions', 'responses'] as const)('sends frozen applicable knowledge through the actual %s protocol without writing tracks or origins', async apiFormat => {
    const current = await fixture();
    const initial = await current.repository.readSnapshot(current.document.id);
    const term = glossaryTerm();
    const sent: ModelRuntimeTextRequest[] = [];
    const service = serviceFor(current, async () => term.snapshot, async input => { sent.push(input); return success(input); });
    const input = request(current, { ...term.selection, instructions: 'Use concise dialogue.' }, { config: config({ language: 'Japanese', instructions: 'OLD_INSTRUCTION_IGNORED', model: { ...config().model, apiFormat } }) });
    const plan = await service.plan(1, input);
    expect(plan.canRun).toBe(true);
    const previewItem = plan.batches.flatMap(batch => batch.knowledge.items).find(item => item.entryId === term.term.id);
    // The preview explains where an entry came from; the provider never sees it.
    expect(previewItem).toMatchObject({ kind: 'term', required: true, origin: term.term.origin });
    const sentPayload = structuredClone(term.term.payload);
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
      expect(payload.translationKnowledge.items).toEqual([{ kind: 'term', required: true, payload: sentPayload, applicableItemIds: ['u1', 'u3'] }]);
      const body = JSON.stringify(input.messages);
      expect(body).toContain('星际港口');
      for (const privateValue of [term.term.id, term.collectionId, current.document.id, 'PRIVATE_ORIGIN_NOT_SENT', 'PRIVATE_ORIGIN_URL', 'PRIVATE_ORIGIN_TITLE', 'MUTATED_AFTER_PREVIEW', 'UI_PREVIEW_MUTATION', 'OLD_INSTRUCTION_IGNORED']) expect(body).not.toContain(privateValue);
      expect(requestTokenEstimate(input)).toBe(plan.batches[index].estimatedInputTokens);
      expect(input.retry).toEqual({ maxRetries: 0 });
    }
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(await current.repository.readSnapshot(current.document.id)).toEqual(initial);
    await expect(service.run(1, { planId: plan.planId, apiKey: 'key' })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('treats explicit undefined selection options as absent in the preview and frozen request', async () => {
    const current = await fixture();
    const term = glossaryTerm();
    const sent: ModelRuntimeTextRequest[] = [];
    const service = serviceFor(current, async () => term.snapshot, async input => { sent.push(input); return success(input); });
    const absent = await service.plan(1, request(current, term.selection));
    expect(await service.run(1, { planId: absent.planId, apiKey: 'key' })).toMatchObject({ status: 'completed' });
    const explicit = await service.plan(1, request(current, { ...term.selection, instructions: undefined, context: undefined }));
    expect(explicit).toEqual({ ...absent, planId: explicit.planId, expiresAt: explicit.expiresAt });
    expect(await service.run(1, { planId: explicit.planId, apiKey: 'key' })).toMatchObject({ status: 'completed' });
    expect(sent).toHaveLength(2);
    expect(sent[1].messages).toEqual(sent[0].messages);
  });

  it('rejects selections carrying removed or older fields as invalid input', async () => {
    const current = await fixture();
    const term = glossaryTerm();
    const send = vi.fn(async (input: ModelRuntimeTextRequest) => success(input));
    const service = serviceFor(current, async () => term.snapshot, send);
    const invalid = [{ ...term.selection, version: 1 }, { ...term.selection, recipeId: randomUUID() }, { ...term.selection, bindings: [] }, { ...term.selection, confirmations: [] }];
    for (const knowledge of invalid) await expect(service.plan(1, request(current, knowledge as unknown as KnowledgeSelection))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(send).not.toHaveBeenCalled();
  });

  it('inherits the current form instructions unless the trial explicitly clears them and sends only the chosen context', async () => {
    const current = await fixture();
    const sent = vi.fn(async (input: ModelRuntimeTextRequest) => success(input));
    const service = serviceFor(current, async () => library(), sent);
    const inherited = await service.plan(1, request(current, { ...selection(), instructions: undefined, context: 'Selection context.' }, { config: config({ instructions: 'Keep the dialogue concise.' }) }));
    expect(inherited.batches[0].knowledge.instructions).toBe('Keep the dialogue concise.');
    expect(inherited.batches[0].knowledge.context).toBe('Selection context.');
    const unset = await service.plan(1, request(current, selection(), { config: config({ instructions: 'Keep the dialogue concise.' }) }));
    expect(unset.batches[0].knowledge.context).toBe('');
    const cleared = await service.plan(1, request(current, { ...selection(), instructions: '', context: '' }, { config: config({ instructions: 'Keep the dialogue concise.' }) }));
    expect(cleared.batches[0].knowledge.instructions).toBe('');
    expect(cleared.batches[0].knowledge.context).toBe('');
    expect(await service.run(1, { planId: cleared.planId, apiKey: 'key' })).toMatchObject({ status: 'completed' });
    expect(JSON.parse(sent.mock.calls[0][0].messages[1].content)).toMatchObject({ translationRequirements: '', translationKnowledge: { background: '' } });
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

  it('keeps unmatched and disabled knowledge out of requests and represents missing usage as unknown', async () => {
    const current = await fixture();
    const term = glossaryTerm(); term.term.enabled = false;
    const unmatched: TermEntry = { ...structuredClone(term.term), id: randomUUID(), enabled: true, payload: { ...term.term.payload, source: 'absent phrase', target: '不存在' } };
    term.snapshot.data.entries.push(unmatched);
    const send = vi.fn(async (input: ModelRuntimeTextRequest) => ({ ...success(input), usage: undefined }));
    const service = serviceFor(current, async () => term.snapshot, send);
    const plan = await service.plan(1, request(current, term.selection));
    // A disabled entry is skipped silently; an enabled one that matches no cue is reported.
    expect(plan.issues.some(issue => issue.entryIds.includes(term.term.id))).toBe(false);
    expect(plan.issues.some(issue => issue.code === 'no_match' && issue.severity === 'warning' && issue.entryIds.includes(unmatched.id))).toBe(true);
    expect(plan.batches.flatMap(batch => batch.knowledge.items)).toEqual([]);
    expect(plan.canRun).toBe(true);
    const result = await service.run(1, { planId: plan.planId, apiKey: 'key' });
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(JSON.parse(send.mock.calls[0][0].messages[1].content).translationKnowledge.items).toEqual([]);
  });

  it('excludes an entry disabled for this run only and reports the exclusion', async () => {
    const current = await fixture();
    const term = glossaryTerm();
    const service = serviceFor(current, async () => term.snapshot);
    const plan = await service.plan(1, request(current, { ...term.selection, disabledEntryIds: [term.term.id] }));
    expect(plan.canRun).toBe(true);
    expect(plan.batches.flatMap(batch => batch.knowledge.items)).toEqual([]);
    expect(plan.issues).toContainEqual({ code: 'disabled', severity: 'warning', entryIds: [term.term.id], cueIds: [] });
    const unknown = await service.plan(1, request(current, { ...term.selection, disabledEntryIds: [randomUUID()] }));
    expect(unknown.canRun).toBe(false);
    expect(unknown.issues.some(issue => issue.code === 'selection_invalid' && issue.severity === 'error')).toBe(true);
  });

  it('blocks a minimum cue whose mandatory knowledge cannot fit and never calls the provider', async () => {
    const current = await fixture();
    const term = glossaryTerm();
    term.term.payload.target = 'required terminology '.repeat(1200);
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
    const term = glossaryTerm();
    const context: Entry = { id: randomUUID(), revision: 1, collectionId: term.collectionId, enabled: true, kind: 'context', payload: { text: 'optional reference detail '.repeat(1000), required: false } };
    term.snapshot.data.entries.push(context);
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

  it('keeps a large selected library blocked and rejects an oversized origin preview rather than truncating it', async () => {
    const current = await fixture();
    const term = glossaryTerm();
    for (let index = 0; index < 500; index++) term.snapshot.data.entries.push({ ...structuredClone(term.term), id: randomUUID() });
    const service = serviceFor(current, async () => term.snapshot);
    const plan = await service.plan(1, request(current, term.selection));
    expect(plan.canRun).toBe(false);
    expect(plan.issues.some(issue => issue.code === 'resource_limit' && issue.severity === 'error')).toBe(true);
    // Origins stay out of the request but are part of the preview, which is bounded as a whole.
    const large = glossaryTerm();
    large.term.origin = { kind: 'manual', note: 'e'.repeat(32000) };
    for (let index = 0; index < 299; index++) large.snapshot.data.entries.push({ ...structuredClone(large.term), id: randomUUID() });
    const largeService = serviceFor(current, async () => large.snapshot);
    await expect(largeService.plan(2, request(current, large.selection, { config: config({ contextWindow: 1000000 }) }))).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});
