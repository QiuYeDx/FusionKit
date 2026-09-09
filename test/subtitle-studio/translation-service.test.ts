import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubtitleDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';
import type { ModelRuntimeTextRequest, ModelRuntimeTextResult, ModelRuntimeUsage } from '../../electron/main/ai/model-runtime-client';
import { ModelRuntimeClientError } from '../../electron/main/ai/model-runtime-errors';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { buildTranslationRequest, planTranslation, requestTokenEstimate, serializeTranslationRequest, sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';
import { normalizeUsage, TranslationService } from '../../electron/main/subtitle-studio/translation-service';

const config = (overrides: Partial<TranslationConfig> = {}): TranslationConfig => ({
  model: { profileId: 'fixture-profile', modelKey: 'gpt-4o-mini', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' },
  language: 'Japanese', instructions: 'Use natural dialogue.', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 2,
  ...overrides,
});
const parse = (text: string, format: 'srt' | 'lrc' = 'lrc') => importSubtitleText(text, {
  format, displayName: 'private-studio-fixture.srt', encoding: 'utf-8', digest: 'f'.repeat(64),
}, randomUUID);
const document = () => parse('[ar:PRIVATE_ARTIST]\n[offset:125]\n[00:17.11]First source\n[00:20.33]Second source\n[00:25.77]Third source');
type Payload = { targetLanguage: string; translationRequirements: string; context: { precedingSource: string[]; followingSource: string[]; priorModelTranslations: string[] }; items: { id: string; text: string }[] };
const payload = (request: ModelRuntimeTextRequest): Payload => JSON.parse(request.messages[1].content);
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const result = (request: ModelRuntimeTextRequest, overrides: Partial<ModelRuntimeTextResult> = {}): ModelRuntimeTextResult => ({
  apiFormat: request.model.apiFormat,
  content: JSON.stringify({ items: payload(request).items.slice().reverse().map(item => ({ id: item.id, text: ` translated ${item.id}\nsecond line ` })) }),
  finishReason: 'stop', usage,
  ...overrides,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const fixtures: { root: string; service: TranslationService }[] = [];
async function fixture(send: (request: ModelRuntimeTextRequest) => Promise<ModelRuntimeTextResult>, doc = document()) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-translation-service-'));
  const repository = new DocumentRepository(path.join(root, 'documents'));
  const service = new TranslationService(repository, send);
  fixtures.push({ root, service });
  await repository.create(doc);
  return { root, repository, service, doc };
}
async function run(current: Awaited<ReturnType<typeof fixture>>, input = config()) {
  const revision = (await current.repository.read(current.doc.id)).revision;
  const plan = await current.service.plan(21, current.doc.id, revision, input);
  const started = await current.service.start(21, current.doc.id, revision, plan.planId, 'test-secret-do-not-persist');
  await current.service.settled(started.taskId);
  return current.repository.readSnapshot(current.doc.id);
}
async function diskText(root: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    parts.push(entry.isDirectory() ? await diskText(file) : await readFile(file, 'utf8'));
  }
  return parts.join('\n');
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const current of fixtures.splice(0)) {
    await current.service.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
});

describe('subtitle studio translation request planning', () => {
  it.each([
    { modelKey: 'deepseek-chat', apiFormat: 'chat_completions', configured: undefined, expected: false },
    { modelKey: '  DeEpSeEk-V3  ', apiFormat: 'chat_completions', configured: undefined, expected: false },
    { modelKey: 'deepseek-reasoner', apiFormat: 'chat_completions', configured: true, expected: true },
    { modelKey: 'deepseek-chat', apiFormat: 'chat_completions', configured: false, expected: false },
    { modelKey: 'deepseek-chat', apiFormat: 'responses', configured: undefined, expected: undefined },
    { modelKey: 'deepseek-chat', apiFormat: 'responses', configured: true, expected: true },
    { modelKey: 'gpt-4o-mini', apiFormat: 'chat_completions', configured: undefined, expected: undefined },
    { modelKey: 'other-deepseek-chat', apiFormat: 'chat_completions', configured: undefined, expected: undefined },
    { modelKey: 'gpt-4o-mini', apiFormat: 'chat_completions', configured: true, expected: true },
  ] as const)('freezes model thinking policy for $modelKey / $apiFormat / $configured before budgeting', ({ modelKey, apiFormat, configured, expected }) => {
    const input = config({ model: { ...config().model, modelKey, apiFormat, ...(configured === undefined ? {} : { thinkingEnabled: configured }) } });
    const before = structuredClone(input);
    const plan = planTranslation(document(), input);
    expect(plan.config.model.thinkingEnabled).toBe(expected);
    expect(plan.config.model.modelKey).toBe(modelKey.trim());
    for (const batch of plan.batches) {
      const request = buildTranslationRequest(plan.config, batch, ['previous translation']);
      const body = JSON.parse(serializeTranslationRequest(request));
      expect(request.model.thinkingEnabled).toBe(expected);
      if (apiFormat === 'chat_completions' && modelKey.trim().toLowerCase().startsWith('deepseek-')) {
        expect(body.thinking).toEqual({ type: expected ? 'enabled' : 'disabled' });
      } else expect(body).not.toHaveProperty('thinking');
      expect(requestTokenEstimate(request)).toBeLessThanOrEqual(batch.estimatedInputTokens);
      expect(requestTokenEstimate(request) + plan.config.maxOutputTokens).toBeLessThanOrEqual(plan.config.contextWindow);
    }
    expect(input).toEqual(before);
  });

  it.each(['chat_completions', 'responses'] as const)('budgets the complete %s request without adding subtitle structure', apiFormat => {
    const doc = parse('7349944\n00:17:11,111 --> 00:17:13,333\n<b>2026-09-09, item 42, and 00:00:01,000 belong to dialogue.</b>\n\n9998844\n00:17:14,444 --> 00:17:15,555\nSecond source\n\n7778833\n00:17:16,666 --> 00:17:17,777\nThird source', 'srt');
    const input = config({ model: { ...config().model, apiFormat }, maxBatchCues: 1 });
    const before = structuredClone(doc);
    const plan = planTranslation(doc, input);
    expect(plan.batches).toHaveLength(3);
    for (const batch of plan.batches) {
      const request = buildTranslationRequest(input, batch, ['committed translation '.repeat(80), 'another committed line']);
      const body = serializeTranslationRequest(request);
      const sent = payload(request);
      expect(requestTokenEstimate(request)).toBeLessThanOrEqual(batch.estimatedInputTokens);
      expect(batch.estimatedInputTokens + input.maxOutputTokens).toBeLessThanOrEqual(input.contextWindow);
      expect(body).not.toMatch(/7349944|9998844|7778833|00:17:|-->|private-studio-fixture|PRIVATE_ARTIST/);
      expect(body).not.toContain(doc.id);
      expect(body).not.toContain(doc.origin.digest);
      expect(body).toContain('2026-09-09, item 42, and 00:00:01,000');
      expect(sent.items.every(item => Object.keys(item).sort().join(',') === 'id,text')).toBe(true);
      expect(request.retry).toEqual({ maxRetries: 0 });
      for (const unit of batch.units) {
        expect(body).not.toContain(unit.cueId);
        expect(body).not.toContain(unit.sourceHash);
        expect(unit.sourceHash).toBe(sourceDigest(doc.cues.find(cue => cue.id === unit.cueId)!));
        expect(unit.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    expect(plan.batches[0].units[0].text).toContain('<m1>2026-09-09');
    expect(doc).toEqual(before);
  });

  it('bounds committed context and discards optional context when the complete request cannot fit', () => {
    const doc = parse(Array.from({ length: 6 }, (_, index) => `[00:01]body ${index} ${'word '.repeat(20)}`).join('\n'));
    const input = config({ maxBatchCues: 1, contextWindow: 2048, maxOutputTokens: 1024, instructions: 'short '.repeat(220) });
    const plan = planTranslation(doc, input);
    expect(plan.batches.some(batch => batch.before.length === 0 && batch.after.length === 0 && batch.priorContextReserve === 0)).toBe(true);
    for (const batch of plan.batches) {
      for (const previous of [[], ['x'.repeat(20000)], ['short translation', 'word '.repeat(500), 'end']]) {
        const request = buildTranslationRequest(input, batch, previous);
        expect(requestTokenEstimate(request)).toBeLessThanOrEqual(batch.estimatedInputTokens);
        expect(requestTokenEstimate(request) + input.maxOutputTokens).toBeLessThanOrEqual(input.contextWindow);
      }
    }
  });

  it('rejects an overlong unit without truncating it or producing a partial plan', () => {
    const doc = parse(`[00:01]short\n[00:02]${'unabridged body '.repeat(3000)}`);
    const before = structuredClone(doc);
    expect(() => planTranslation(doc, config({ maxOutputTokens: 256 }))).toThrow('limit_exceeded');
    expect(doc).toEqual(before);
  });

  it('fits multiline committed context against its complete HTTP serialization without truncation', () => {
    const previous = ['line\n'.repeat(180)];
    for (const apiFormat of ['chat_completions', 'responses'] as const) {
      const input = config({ model: { ...config().model, apiFormat }, maxBatchCues: 1 });
      const batch = planTranslation(document(), input).batches[1];
      const before = structuredClone(batch);
      const unfitted = buildTranslationRequest(input, { ...batch, estimatedInputTokens: 0 }, previous);
      expect(payload(unfitted).context.priorModelTranslations).toEqual(previous);
      expect(requestTokenEstimate(unfitted)).toBeGreaterThan(batch.estimatedInputTokens);
      const request = buildTranslationRequest(input, batch, previous);
      expect(requestTokenEstimate(request)).toBeLessThanOrEqual(batch.estimatedInputTokens);
      expect(requestTokenEstimate(request) + input.maxOutputTokens).toBeLessThanOrEqual(input.contextWindow);
      expect(payload(request).context.priorModelTranslations).toEqual([]);
      expect(payload(request).items).toEqual(batch.units.map(unit => ({ id: unit.id, text: unit.text })));
      expect(previous).toEqual(['line\n'.repeat(180)]);
      expect(batch).toEqual(before);
    }
  });
});

describe('subtitle studio translation service with an isolated repository', () => {
  it('persists and dispatches the same normalized DeepSeek configuration used by its plan', async () => {
    const requests: ModelRuntimeTextRequest[] = [];
    const input = config({ model: { ...config().model, modelKey: 'DeEpSeEk-chat' } });
    const before = structuredClone(input);
    const current = await fixture(async request => { requests.push(request); return result(request); });
    const planned = planTranslation(current.doc, input);
    const snapshot = await run(current, input);
    expect(snapshot.tasks[0].status).toBe('completed');
    expect(snapshot.tasks[0].translation?.config).toEqual(planned.config);
    expect(snapshot.tasks[0].translation?.config.model.thinkingEnabled).toBe(false);
    expect(snapshot.tasks[0].translation?.estimatedInputTokens).toBe(planned.batches.reduce((total, batch) => total + batch.estimatedInputTokens, 0));
    expect(requests).toHaveLength(planned.batches.length);
    requests.forEach((request, index) => {
      expect(JSON.parse(serializeTranslationRequest(request)).thinking).toEqual({ type: 'disabled' });
      expect(requestTokenEstimate(request)).toBeLessThanOrEqual(planned.batches[index].estimatedInputTokens);
    });
    expect(input).toEqual(before);
  });

  it('commits unordered results to the right cues, preserves source and stores no credentials', async () => {
    const requests: ModelRuntimeTextRequest[] = [];
    const current = await fixture(async request => { requests.push(request); return result(request); });
    const snapshot = await run(current);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'completed', attempts: 2, completedBatchIds: ['b1', 'b2'], translation: { usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } });
    expect(snapshot.document.cues).toEqual(current.doc.cues);
    expect(snapshot.document.preservation).toEqual(current.doc.preservation);
    const track = snapshot.document.translationTracks[0];
    current.doc.cues.forEach((cue, index) => {
      expect(track.entries[cue.id]).toEqual({ sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue),
        text: { plain: ` translated u${index + 1}\nsecond line `, spans: [{ text: ` translated u${index + 1}\nsecond line `, marks: [] }] }, origin: 'ai', reviewStatus: 'unreviewed' });
    });
    expect(payload(requests[1]).context.priorModelTranslations).toEqual([' translated u1\nsecond line ', ' translated u2\nsecond line ']);
    for (const request of requests) {
      expect(serializeTranslationRequest(request)).not.toMatch(/PRIVATE_ARTIST|offset|private-studio-fixture|00:17|00:20|00:25/);
      expect(request.model.apiKey).toBe('test-secret-do-not-persist');
    }
    const stored = await diskText(current.root);
    expect(stored).not.toMatch(/test-secret-do-not-persist|apiKey|AbortController|planId/);
    const reopened = await new DocumentRepository(path.join(current.root, 'documents')).read(current.doc.id);
    expect(reopened.translationTracks).toEqual(snapshot.document.translationTracks);
  });

  it('retries only a failed second batch once and retains the completed first batch', async () => {
    const calls: string[][] = [];
    const current = await fixture(async request => {
      const ids = payload(request).items.map(item => item.id);
      calls.push(ids);
      if (ids[0] === 'u2') throw new ModelRuntimeClientError('http_rate_limited', 'synthetic rate limit', true, { retryAfterMs: 0, usage });
      return result(request);
    });
    const snapshot = await run(current, config({ maxBatchCues: 1 }));
    expect(calls).toEqual([['u1'], ['u2'], ['u2']]);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', attempts: 3, completedBatchIds: ['b1'], uncertainBatchIds: ['b2'],
      translation: { error: 'translation_failed', usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 } } });
    expect(Object.keys(snapshot.document.translationTracks[0].entries)).toEqual([current.doc.cues[0].id]);
    expect(snapshot.document.cues).toEqual(current.doc.cues);
  });

  it.each([
    { mode: 'runtime-error', failingBatch: 1, reportedUsage: usage },
    { mode: 'runtime-error', failingBatch: 2, reportedUsage: usage },
    { mode: 'runtime-error', failingBatch: 1, reportedUsage: undefined },
    { mode: 'runtime-error', failingBatch: 2, reportedUsage: undefined },
    { mode: 'finish-reason', failingBatch: 1, reportedUsage: usage },
    { mode: 'finish-reason', failingBatch: 2, reportedUsage: usage },
    { mode: 'finish-reason', failingBatch: 1, reportedUsage: undefined },
    { mode: 'finish-reason', failingBatch: 2, reportedUsage: undefined },
  ] as const)('stops output truncation without retry or uncertain execution: $mode / batch $failingBatch / $reportedUsage', async ({ mode, failingBatch, reportedUsage }) => {
    const calls: string[][] = [];
    const current = await fixture(async request => {
      const ids = payload(request).items.map(item => item.id);
      calls.push(ids);
      if (ids[0] !== `u${failingBatch}`) return result(request);
      if (mode === 'runtime-error') throw new ModelRuntimeClientError('length_truncated', 'synthetic output limit', false, { usage: reportedUsage });
      return result(request, { finishReason: 'length', usage: reportedUsage });
    });
    const snapshot = await run(current, config({ maxBatchCues: 1 }));
    expect(calls).toEqual(failingBatch === 1 ? [['u1']] : [['u1'], ['u2']]);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', attempts: failingBatch,
      completedBatchIds: failingBatch === 1 ? [] : ['b1'], uncertainBatchIds: [],
      translation: { error: 'translation_output_limit', usage: reportedUsage
        ? { inputTokens: usage.inputTokens * failingBatch, outputTokens: usage.outputTokens * failingBatch, totalTokens: usage.totalTokens * failingBatch }
        : { inputTokens: null, outputTokens: null, totalTokens: null } } });
    const entries = snapshot.document.translationTracks[0].entries;
    expect(Object.keys(entries)).toEqual(failingBatch === 1 ? [] : [current.doc.cues[0].id]);
    if (failingBatch === 2) expect(entries[current.doc.cues[0].id].text.plain).toBe(' translated u1\nsecond line ');
    expect(snapshot.document.cues).toEqual(current.doc.cues);
    expect(snapshot.document.preservation).toEqual(current.doc.preservation);
  });

  it('retries invalid markers without committing any part of their batch', async () => {
    let calls = 0;
    const doc = parse('[00:01]<b>first</b>\n[00:02]second');
    const current = await fixture(async request => {
      calls++;
      return result(request, { content: JSON.stringify({ items: [{ id: 'u2', text: 'valid second' }, { id: 'u1', text: 'missing markers' }] }) });
    }, doc);
    const snapshot = await run(current);
    expect(calls).toBe(2);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', completedBatchIds: [], uncertainBatchIds: [], translation: { error: 'translation_protocol_invalid', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } });
    expect(snapshot.document.translationTracks[0].entries).toEqual({});
  });

  it.each([
    undefined,
    { inputTokens: NaN, outputTokens: Infinity, totalTokens: -1 },
    { inputTokens: 1.5, outputTokens: Number.MAX_SAFE_INTEGER + 1, totalTokens: NaN },
  ] as (ModelRuntimeUsage | undefined)[])('keeps unavailable or invalid usage unknown across subsequent valid calls: %j', async value => {
    let calls = 0;
    const current = await fixture(async request => result(request, { usage: calls++ ? usage : value }));
    const snapshot = await run(current);
    expect(snapshot.tasks[0].translation?.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(snapshot.tasks[0].status).toBe('completed');
    expect(normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(normalizeUsage({ inputTokens: 2 })).toEqual({ inputTokens: 2, outputTokens: null, totalTokens: null });
  });

  it('rejects another owner, an expired plan and stale document revisions before dispatch', async () => {
    const send = vi.fn(async (request: ModelRuntimeTextRequest) => result(request));
    const current = await fixture(send);
    const plan = await current.service.plan(21, current.doc.id, 1, config());
    await expect(current.service.start(22, current.doc.id, 1, plan.planId, 'secret')).rejects.toThrow('access_denied');
    const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
    await expect(current.service.start(21, current.doc.id, 1, plan.planId, 'secret')).rejects.toThrow('revision_conflict');
    date.mockRestore();
    const fresh = await current.service.plan(21, current.doc.id, 1, config());
    await current.repository.transact(current.doc.id, 1, value => { value.document.cues[0].timingRevision++; });
    await expect(current.service.start(21, current.doc.id, 1, fresh.planId, 'secret')).rejects.toThrow('revision_conflict');
    expect(send).not.toHaveBeenCalled();
    expect((await current.repository.readSnapshot(current.doc.id)).tasks).toEqual([]);
  });

  it('does not recreate a deleted document when an in-flight response arrives', async () => {
    const entered = deferred<ModelRuntimeTextRequest>();
    const release = deferred<ModelRuntimeTextResult>();
    const current = await fixture(request => { entered.resolve(request); return release.promise; });
    const plan = await current.service.plan(21, current.doc.id, 1, config());
    const started = await current.service.start(21, current.doc.id, 1, plan.planId, 'secret');
    const request = await entered.promise;
    try {
      const running = await current.repository.read(current.doc.id);
      await current.repository.delete(current.doc.id, running.revision);
      expect(request.signal?.aborted).toBe(true);
    } finally { release.resolve(result(request)); }
    await current.service.settled(started.taskId);
    expect(await current.repository.list()).toEqual([]);
    await expect(current.repository.read(current.doc.id)).rejects.toThrow('document_unavailable');
    expect(await readdir(path.join(current.root, 'documents'))).toEqual(['.deleted']);
  });

  it('records unknown usage when disposal aborts an already dispatched request', async () => {
    const entered = deferred<ModelRuntimeTextRequest>();
    const send = vi.fn((request: ModelRuntimeTextRequest) => new Promise<ModelRuntimeTextResult>((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(new ModelRuntimeClientError('aborted', 'synthetic interruption', false)), { once: true });
      entered.resolve(request);
    }));
    const current = await fixture(send);
    const plan = await current.service.plan(21, current.doc.id, 1, config());
    await current.service.start(21, current.doc.id, 1, plan.planId, 'secret');
    const request = await entered.promise;
    await current.service.dispose();
    const snapshot = await current.repository.readSnapshot(current.doc.id);
    expect(request.signal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'interrupted', attempts: 1, completedBatchIds: [],
      translation: { error: 'interrupted', usage: { inputTokens: null, outputTokens: null, totalTokens: null } } });
    expect(snapshot.document.translationTracks[0].entries).toEqual({});
    expect(snapshot.document.cues).toEqual(current.doc.cues);
  });

  it.each(['source-revision', 'source-hash', 'track-revision'] as const)('rejects stale %s results while retaining known request usage', async change => {
    const entered = deferred<ModelRuntimeTextRequest>();
    const release = deferred<ModelRuntimeTextResult>();
    const current = await fixture(request => { entered.resolve(request); return release.promise; });
    const plan = await current.service.plan(21, current.doc.id, 1, config());
    const started = await current.service.start(21, current.doc.id, 1, plan.planId, 'secret');
    const request = await entered.promise;
    let changed: SubtitleDocument | undefined;
    try {
      const running = await current.repository.read(current.doc.id);
      const updated = await current.repository.transact(current.doc.id, running.revision, value => {
        if (change === 'source-revision') value.document.cues[0].sourceRevision++;
        if (change === 'source-hash') value.document.cues[0].source = { plain: 'new source', spans: [{ text: 'new source', marks: [] }] };
        if (change === 'track-revision') value.document.translationTracks[0].revision++;
      });
      changed = updated.document;
    } finally { release.resolve(result(request)); }
    await current.service.settled(started.taskId);
    const snapshot = await current.repository.readSnapshot(current.doc.id);
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', completedBatchIds: [], translation: { error: 'revision_conflict', usage } });
    expect(snapshot.document.translationTracks[0].entries).toEqual({});
    expect(snapshot.document.cues).toEqual(changed!.cues);
    expect(snapshot.document.translationTracks[0].revision).toBe(changed!.translationTracks[0].revision);
  });
});
