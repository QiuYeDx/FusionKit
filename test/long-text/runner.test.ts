import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LongTextSettings } from '../../src/long-text/contract';
import type { KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { Entry } from '../../src/translation-knowledge/schemas';
import type { ModelRuntimeTextRequest } from '../../electron/main/ai/model-runtime-client';
import { LoadedDocument } from '../../electron/main/long-text/document-state';
import { DocumentLedger } from '../../electron/main/long-text/ledger';
import { emptyObserved } from '../../electron/main/long-text/planner';
import { LongTextRepository } from '../../electron/main/long-text/repository';
import { RequestPool } from '../../electron/main/long-text/request-pool';
import { LENGTH_RATIOS, retranslate, Run, type RunStart } from '../../electron/main/long-text/runner';
import { buildDocument, removeRoot, temporaryRoot } from './document-test-utils';
import {
  abortableDelay, answer, API_KEY, fakeModel, MODEL, memoryDocument, modelError, runnerSetup, settle, storyLines, translateAll, USAGE,
  type MemoryDocument, type Responder,
} from './runner-test-utils';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function begin(document: MemoryDocument, responder: Responder = translateAll, options: {
  delayMs?: number; start?: Partial<RunStart>; library?: () => LibrarySnapshot | Promise<LibrarySnapshot>; pool?: RequestPool;
} = {}) {
  const model = fakeModel(document, responder, { delayMs: options.delayMs });
  const setup = runnerSetup(document, model.send, { library: options.library, pool: options.pool });
  const run = await Run.start(setup.target, { kind: 'full', model: MODEL, apiKey: API_KEY, settingsDigest: 'digest', ...options.start }, setup.services, setup.hooks);
  return { run, model, ...setup };
}

const story = (count: number, settings: Partial<LongTextSettings> = {}) => memoryDocument(storyLines(count), { settings });
const sizes = (calls: Array<{ indices: number[] }>) => calls.map(call => call.indices.length);
const pageOf = (index: number) => Math.floor(index / 60);

describe('Run', () => {
  it('translates pages in parallel lanes, each page in order (pace 2)', async () => {
    const document = await story(130, { pace: 2, batchSourceTokens: 80 });
    const activeByPage = new Map<number, number>();
    const { run, model, saved } = await begin(document, async call => {
      const page = pageOf(call.indices[0]);
      expect(call.indices.every(index => pageOf(index) === page)).toBe(true);
      activeByPage.set(page, (activeByPage.get(page) ?? 0) + 1);
      expect(activeByPage.get(page)).toBe(1);
      await abortableDelay(1000, call.request.signal);
      activeByPage.set(page, activeByPage.get(page)! - 1);
      return translateAll(call);
    });
    const record = await settle(run.done);

    expect(record).toMatchObject({ status: 'completed', total: 130, done: 130, failed: 0, deferred: 0 });
    expect(document.translatable().every(index => document.status(index) === 'done')).toBe(true);
    expect(model.maxActive).toBe(2);
    expect(model.calls.slice(0, 2).map(call => pageOf(call.indices[0]))).toEqual([0, 1]);
    for (const page of [0, 1, 2]) {
      const firsts = model.calls.filter(call => pageOf(call.indices[0]) === page).map(call => call.indices[0]);
      expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    }
    expect(saved[0].start).toEqual({ fullRunStarted: true, sample: null });
    expect(saved.at(-1)!.record).toMatchObject({ status: 'completed', done: 130 });
    expect(document.usage()).toMatchObject({ requests: model.calls.length, failedRequests: 0, unknownRequests: 0 });
    expect(run.view()).toMatchObject({ status: 'completed', inFlight: 0, frontier: null, etaSeconds: null });
  });

  it('sends requests strictly in index order, one at a time, with pace 1 (AC-LT-09-1)', async () => {
    const document = await story(130, { pace: 1, batchSourceTokens: 80 });
    const { run, model } = await begin(document, translateAll, { delayMs: 300 });
    await vi.advanceTimersByTimeAsync(10);
    expect(run.view()).toMatchObject({ frontier: 0, frontierPage: 0, inFlight: 1, etaSeconds: null });
    await vi.advanceTimersByTimeAsync(900);
    expect(run.view()).toMatchObject({ frontier: 30, done: 30 });
    expect(run.view().etaSeconds).toBeGreaterThan(0);
    await settle(run.done);
    const firsts = model.calls.map(call => call.indices[0]);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    expect(model.maxActive).toBe(1);
  });

  it('gives each batch the preceding translations of its page and the chapter heading (AC-LT-09-2)', async () => {
    const document = await memoryDocument(['Chapter 1', ...storyLines(70).split('\n')].join('\n'), { settings: { pace: 1, batchSourceTokens: 80 } });
    const { run, model } = await begin(document);
    await settle(run.done);
    const [first, second] = model.calls;
    expect(first.payload.context?.precedingPairs).toBeUndefined();
    const previous = first.indices.slice(-3);
    expect(second.payload.context?.precedingPairs?.map(pair => pair.source)).toEqual(previous.map(index => document.displayAt(index)));
    expect(second.payload.context?.precedingPairs?.[0].translation).toBe(`【译】${document.displayAt(previous[0])}`);
    const pageStart = model.calls.find(call => call.indices[0] === 60)!;
    expect(pageStart.payload.context?.section).toEqual({ heading: 'Chapter 1', translation: '【译】Chapter 1' });
  });

  it('splits a batch whose ids do not match, without costing its other segments an attempt (AC-LT-12-2)', async () => {
    const document = await story(40, { pace: 1 });
    const { run, model } = await begin(document, call => {
      const items = call.payload.items.filter((_, position) => !(call.indices.length > 1 && call.indices[position] === 17));
      return answer(items.map(item => ({ id: item.id, text: `【译】${item.text}` })));
    });
    const record = await settle(run.done);
    expect(sizes(model.calls)[0]).toBe(40);
    const singles = model.calls.filter(call => call.indices.length === 1);
    expect(singles.map(call => call.indices[0])).toEqual([17]);
    expect(record).toMatchObject({ status: 'completed', done: 40, failed: 0, deferred: 0 });
  });

  it('sends only the rejected items again, each on its own (AC-LT-12-5)', async () => {
    const long = (index: number) => `Line number ${index} of the story, told slowly and with great care.`;
    const document = await memoryDocument(storyLines(10, long), { settings: { pace: 1 } });
    const { run, model } = await begin(document, call => answer(call.payload.items.map((item, position) => {
      if (model.calls.length === 1 && call.indices[position] === 2) return { id: item.id, text: '短' };
      if (model.calls.length === 1 && [5, 6].includes(call.indices[position])) return { id: item.id, text: '同一句译文，两段都一样。' };
      return { id: item.id, text: `【译】${item.text}` };
    })));
    await settle(run.done);
    expect(model.calls.map(call => call.indices)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [2], [5], [6]]);
    expect(document.appends[0].records.map(record => record.index)).toEqual([0, 1, 3, 4, 7, 8, 9]);
    expect(document.translatable().every(index => document.status(index) === 'done')).toBe(true);
  });

  it('repairs a missing link on the last attempt and keeps its URL (AC-LT-12-3)', async () => {
    const document = await memoryDocument('Read [the guide](https://example.com/guide) before you start.', { format: 'markdown', settings: { pace: 1 } });
    const { run, model } = await begin(document, call => answer(call.payload.items.map(item => ({ id: item.id, text: `开始之前请阅读${item.text.replace(/<\/?m1>/g, '').replace(/^Read | before you start\.$/g, '')}。` }))));
    const record = await settle(run.done);
    expect(model.calls).toHaveLength(3);
    expect(record).toMatchObject({ done: 1, failed: 0 });
    const translation = document.translationAt(0)!;
    expect(translation.status).toBe('done');
    expect(translation.target).toContain('[the guide](https://example.com/guide)');
    expect(translation.flags).toContainEqual({ code: 'placeholder_repaired', dismissed: false, detail: { kinds: ['link'] } });
  });

  it('defers what is left of a batch once its extra requests are used up (AC-LT-12-4)', async () => {
    const document = await story(4, { pace: 1 });
    const { run, model } = await begin(document, call => (call.indices.length > 1
      ? answer(call.payload.items.slice(1).map(item => ({ id: item.id, text: '译' })))
      : answer([], { usage: USAGE, finishReason: 'stop' })));
    const record = await settle(run.done);
    expect(model.calls.map(call => call.indices)).toEqual([[0, 1, 2, 3], [0, 1], [0], [0], [0], [1], [1], [2, 3]]);
    expect(record).toMatchObject({ status: 'completed', failed: 1, deferred: 3, done: 0 });
    expect(document.translationAt(0)?.failure).toEqual({ code: 'protocol_invalid' });
    expect([1, 2, 3].map(index => document.status(index))).toEqual(['pending', 'pending', 'pending']);
  });

  it('splits cut-off batches and doubles the output limit once for a single segment (AC-LT-12-7)', async () => {
    const document = await story(4, { pace: 1 });
    let cutSingle = false;
    const { run, model } = await begin(document, call => {
      if (call.indices.length > 1) return modelError('length_truncated', { usage: USAGE });
      if (call.indices[0] === 1 && !cutSingle) {
        cutSingle = true;
        return answer([], { finishReason: 'length' });
      }
      return translateAll(call);
    });
    const record = await settle(run.done);
    expect(model.calls.map(call => call.indices)).toEqual([[0, 1, 2, 3], [0, 1], [0], [1], [1], [2, 3], [2], [3]]);
    expect(model.calls.map(call => call.request.maxOutputTokens)).toEqual([8192, 8192, 8192, 8192, 16_384, 8192, 8192, 8192]);
    expect(record).toMatchObject({ done: 4, failed: 0, deferred: 0 });
  });

  it('fails a single segment still cut off after 3 attempts as too_long', async () => {
    const document = await story(1);
    const { run, model } = await begin(document, () => answer([], { finishReason: 'length' }));
    const record = await settle(run.done);
    expect(record).toMatchObject({ done: 0, failed: 1, deferred: 0 });
    expect(document.translationAt(0)?.failure).toEqual({ code: 'too_long' });
    expect(model.calls.map(call => call.request.maxOutputTokens)).toEqual([8192, 16_384, 16_384]);
  });

  it('splits a refused batch, and fails a segment refused 3 times as content_filtered', async () => {
    const document = await story(2, { pace: 1 });
    const { run, model } = await begin(document, call => (call.indices.length > 1 || call.indices[0] === 1 ? answer([], { finishReason: 'content_filter' }) : translateAll(call)));
    const record = await settle(run.done);
    expect(model.calls.map(call => call.indices)).toEqual([[0, 1], [0], [1], [1], [1]]);
    expect(record).toMatchObject({ done: 1, failed: 1 });
    expect(document.translationAt(1)?.failure).toEqual({ code: 'content_filtered' });
  });

  it('fails a single segment whose answers stay empty as empty_output, and unreadable ones as protocol_invalid', async () => {
    const empty = await story(1);
    const first = await begin(empty, () => answer([{ id: 's1', text: '  ' }]));
    expect(await settle(first.run.done)).toMatchObject({ done: 0, failed: 1 });
    expect(first.model.calls).toHaveLength(3);
    expect(empty.translationAt(0)?.failure).toEqual({ code: 'empty_output' });

    const unreadable = await story(1);
    const second = await begin(unreadable, () => modelError('invalid_response'));
    expect(await settle(second.run.done)).toMatchObject({ done: 0, failed: 1 });
    expect(unreadable.translationAt(0)?.failure).toEqual({ code: 'protocol_invalid' });
    expect(unreadable.usage()).toMatchObject({ requests: 3, failedRequests: 3, unknownRequests: 3 });
  });

  it('applies a pace change from the next batch', async () => {
    const document = await story(130, { pace: 1, batchSourceTokens: 80 });
    const { run, model } = await begin(document, translateAll, { delayMs: 500 });
    await vi.advanceTimersByTimeAsync(700);
    expect(model.maxActive).toBe(1);
    document.current = { ...document.current, pace: 2 };
    await settle(run.done);
    expect(model.maxActive).toBe(2);
    expect(run.view()).toMatchObject({ pace: 2, effectiveLanes: 2, done: 130 });
  });

  it('turns the JSON mode off for the run after a first HTTP 400, without counting a failure', async () => {
    const document = await story(130, { pace: 1, batchSourceTokens: 400 });
    const { run, model } = await begin(document, call => (model.calls.length === 1 ? modelError('http_non_retryable', { status: 400 }) : translateAll(call)));
    const record = await settle(run.done);
    expect(record.status).toBe('completed');
    expect(model.calls[0].request.responseFormat).toBe('json_object');
    expect(model.calls.slice(1).every(call => call.request.responseFormat === undefined)).toBe(true);
    expect(model.calls[1].indices).toEqual(model.calls[0].indices);
    expect(document.usage().failedRequests).toBe(0);
  });

  it('waits as long as a 429 asks, drops a lane, and adds it back after 20 good requests (AC-LT-09-7)', async () => {
    const document = await story(130, { pace: 2, batchSourceTokens: 24 });
    const sentAt: number[] = [];
    const { run, model, views } = await begin(document, call => {
      sentAt.push(Date.now());
      return call === model.calls[0] ? modelError('http_rate_limited', { status: 429, retryAfterMs: 5_000 }) : translateAll(call);
    }, { delayMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    expect(run.view().effectiveLanes).toBe(1);
    await settle(run.done);
    const retry = model.calls.findIndex((call, position) => position > 0 && call.indices[0] === model.calls[0].indices[0]);
    expect(sentAt[retry] - sentAt[0]).toBeGreaterThanOrEqual(5_000);
    const lanes = views.map(view => view.effectiveLanes);
    expect(lanes).toEqual([1, 2, 2]);
    expect(document.translatable().every(index => document.status(index) === 'done')).toBe(true);
  });

  it('stops at an authentication error and puts the segments in flight back (AC-LT-11-2)', async () => {
    const document = await story(130, { pace: 2 });
    const { run, model } = await begin(document, async call => {
      if (pageOf(call.indices[0]) === 1) return modelError('http_unauthorized', { status: 401, providerMessage: `Incorrect API key provided: ${API_KEY}.` });
      await abortableDelay(10_000, call.request.signal);
      return translateAll(call);
    });
    const record = await settle(run.done);
    expect(model.calls).toHaveLength(2);
    expect(record).toMatchObject({ status: 'failed', error: { code: 'model_failed', category: 'auth', message: 'Incorrect API key provided: ***.' } });
    expect(document.inFlight.size).toBe(0);
    expect(document.translatable().every(index => document.status(index) === 'pending')).toBe(true);
    expect(document.usage()).toMatchObject({ requests: 2, failedRequests: 1, unknownRequests: 1 });
    expect(run.view().inFlight).toBe(0);
  });

  it('retries transport errors with backoff and stops after 4 batches fail in a row (AC-LT-11-3)', async () => {
    const document = await story(130, { pace: 1, batchSourceTokens: 24 });
    const sentAt: number[] = [];
    const { run, model } = await begin(document, () => {
      sentAt.push(Date.now());
      return modelError('network_error');
    });
    const record = await settle(run.done);
    expect(model.calls).toHaveLength(16);
    expect(sentAt.slice(1, 4).map((at, position) => at - sentAt[position])).toEqual([1_000, 2_000, 4_000]);
    expect(record).toMatchObject({ status: 'failed', error: { code: 'model_failed', category: 'network' }, failed: 12 });
    expect(document.translationAt(0)?.failure).toEqual({ code: 'transport', category: 'network' });
    expect(document.usage()).toMatchObject({ requests: 16, failedRequests: 16 });
  });

  it('stops when the output keeps failing (AC-LT-11-4)', async () => {
    const document = await story(130, { pace: 1 });
    const { run, model } = await begin(document, () => answer([], { finishReason: 'stop' }));
    const record = await settle(run.done);
    expect(model.calls).toHaveLength(20);
    expect(record).toMatchObject({ status: 'failed', error: { code: 'unstable_output' } });
    expect(document.inFlight.size).toBe(0);
  });

  it('stops on a failed write (AC-LT-11-6)', async () => {
    const document = await story(130, { pace: 1 });
    const { run } = await begin(document, call => {
      document.writeError = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return translateAll(call);
    });
    const record = await settle(run.done);
    expect(record).toMatchObject({ status: 'failed', error: { code: 'storage_failed' } });
    expect(document.inFlight.size).toBe(0);
  });

  it('pauses gracefully: requests in flight finish and are saved, nothing new is sent (AC-LT-10-1)', async () => {
    const document = await story(130, { pace: 2 });
    const { run, model, saved } = await begin(document, translateAll, { delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(run.pause(false)).toBe('pausing');
    expect(run.view().status).toBe('pausing');
    const record = await settle(run.done);
    expect(record.status).toBe('paused');
    expect(model.calls).toHaveLength(2);
    const done = document.translatable().filter(index => document.status(index) === 'done');
    expect(done).toEqual(model.calls.flatMap(call => call.indices).sort((a, b) => a - b));
    expect(saved.map(entry => entry.record.status)).toEqual(['running', 'pausing', 'paused']);
  });

  it('stops immediately: requests are aborted and counted as uncertain (AC-LT-10-2)', async () => {
    const document = await story(130, { pace: 2 });
    const { run, model } = await begin(document, translateAll, { delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(run.pause(true)).toBe('paused');
    const record = await settle(run.done);
    expect(record.status).toBe('paused');
    expect(model.calls).toHaveLength(2);
    expect(document.translatable().every(index => document.status(index) === 'pending')).toBe(true);
    expect(document.inFlight.size).toBe(0);
    expect(document.usage()).toMatchObject({ requests: 2, unknownRequests: 2, failedRequests: 0 });
    expect(run.view().usage.unknownRequests).toBe(2);
  });

  it('never overwrites locked segments or segments changed after dispatch', async () => {
    const document = await story(10, { pace: 1 });
    document.edit(3, '锁定的译文');
    const commit = vi.spyOn(document, 'commit');
    const { run, model } = await begin(document, call => {
      document.edit(5, '请求期间的修改', false);
      return translateAll(call);
    });
    await settle(run.done);
    expect(model.calls[0].indices).not.toContain(3);
    expect(document.translationAt(3)?.target).toBe('锁定的译文');
    expect(document.translationAt(5)).toMatchObject({ target: '请求期间的修改', origin: 'user' });
    expect(commit.mock.calls.every(([, , options]) => options.skipLocked)).toBe(true);
  });

  it('clears from the chosen segment first and translates only from there (AC-LT-09-5)', async () => {
    const document = await story(10, { pace: 1 });
    for (let index = 0; index < 10; index++) document.translate(index, `旧译文 ${index}`);
    document.edit(7, '锁定');
    const { run, model, saved } = await begin(document, translateAll, { start: { kind: 'from', fromIndex: 5 } });
    expect(document.appends[0].records.map(record => record.index)).toEqual([5, 6, 8, 9]);
    expect(document.appends[0].records[0].previous).toMatchObject({ status: 'done', target: '旧译文 5' });
    await settle(run.done);
    expect(model.calls.flatMap(call => call.indices)).toEqual([5, 6, 8, 9]);
    expect(document.translationAt(4)?.target).toBe('旧译文 4');
    expect(document.translationAt(7)?.target).toBe('锁定');
    expect(saved[0].start).toEqual({ fullRunStarted: true, sample: null });
  });

  it('samples one small batch, keeps it for the full run, and samples again with new settings (AC-LT-08-1–3)', async () => {
    const document = await story(130, { pace: 2 });
    const sample = await begin(document, translateAll, { start: { kind: 'sample' } });
    await settle(sample.run.done);
    expect(sample.model.calls).toHaveLength(1);
    const indices = sample.model.calls[0].indices;
    expect(indices).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(indices.reduce((sum, index) => sum + document.table.tokens[index], 0)).toBeLessThanOrEqual(800);
    expect(sample.saved[0].start).toEqual({ fullRunStarted: false, sample: indices });

    document.edit(3, '用户认可的译文');
    const again = await begin(document, translateAll, { start: { kind: 'sample', resample: indices } });
    await settle(again.run.done);
    expect(again.model.calls.map(call => call.indices)).toEqual([indices.filter(index => index !== 3)]);
    expect(document.translationAt(3)?.target).toBe('用户认可的译文');

    const full = await begin(document);
    await settle(full.run.done);
    expect(full.model.calls.flatMap(call => call.indices).some(index => indices.includes(index))).toBe(false);
  });

  it('splits a batch the provider refuses for its content (HTTP 400) and keeps the JSON mode on', async () => {
    for (const bad of [30, 5]) {
      // 30: after accepted requests; 5: in the run's first request, which must not be read as a JSON mode rejection.
      const document = await story(60, { pace: 1 });
      const { run, model } = await begin(document, call => (call.indices.includes(bad)
        ? modelError('http_non_retryable', { status: 400, providerCode: 'data_inspection_failed', providerMessage: 'Input data may contain inappropriate content.' })
        : translateAll(call)));
      const record = await settle(run.done);
      expect(record).toMatchObject({ status: 'completed', done: 59, failed: 1, deferred: 0 });
      expect(document.translationAt(bad)?.failure).toEqual({ code: 'content_filtered' });
      expect(model.calls.every(call => call.request.responseFormat === 'json_object')).toBe(true);
    }
  });

  it('splits a batch that overflows the context or gets another HTTP 400 once the run has accepted requests', async () => {
    const overflow = await story(60, { pace: 1 });
    const first = await begin(overflow, call => (call.indices.length > 20
      ? modelError('http_non_retryable', { status: 400, providerCode: 'context_length_exceeded', providerMessage: "This model's maximum context length is 32768 tokens." })
      : translateAll(call)));
    expect(await settle(first.run.done)).toMatchObject({ status: 'completed', done: 60, failed: 0 });

    const other = await story(60, { pace: 1 });
    const second = await begin(other, call => (call.indices.includes(45) ? modelError('http_non_retryable', { status: 400, providerMessage: 'Bad request.' }) : translateAll(call)));
    expect(await settle(second.run.done)).toMatchObject({ status: 'completed', done: 59, failed: 1 });
    expect(other.translationAt(45)?.failure).toEqual({ code: 'protocol_invalid' });
    expect(second.model.calls.every(call => call.request.responseFormat === 'json_object')).toBe(true);
  });

  it('stops boosting when the provider refuses the doubled output limit, and fails the cut-off segment as too_long', async () => {
    const document = await story(60, { pace: 1 });
    const { run, model } = await begin(document, call => {
      if (call.request.maxOutputTokens! > 8192) return modelError('http_non_retryable', { status: 400, providerMessage: 'Range of max_tokens should be [1, 8192]' });
      return call.indices.includes(7) ? modelError('length_truncated', { usage: USAGE }) : translateAll(call);
    });
    const record = await settle(run.done);
    expect(record).toMatchObject({ status: 'completed', done: 59, failed: 1, deferred: 0 });
    expect(document.translationAt(7)?.failure).toEqual({ code: 'too_long' });
    const singles = model.calls.filter(call => call.indices.length === 1 && call.indices[0] === 7);
    expect(singles.map(call => call.request.maxOutputTokens)).toEqual([8192, 16_384, 8192]);
  });

  it('splits a batch answered with empty content and fails only that segment as empty_output', async () => {
    const document = await story(60, { pace: 1 });
    const { run, model } = await begin(document, call => (call.indices.includes(5) ? modelError('empty_response') : translateAll(call)));
    const record = await settle(run.done);
    expect(record).toMatchObject({ status: 'completed', done: 59, failed: 1, deferred: 0 });
    expect(document.translationAt(5)?.failure).toEqual({ code: 'empty_output' });
    expect(sizes(model.calls).slice(0, 2)).toEqual([40, 20]);
    expect(model.calls.filter(call => call.indices.includes(5)).map(call => call.indices.length).slice(-3)).toEqual([1, 1, 1]);
    expect(document.appends.flatMap(append => append.records).some(record => record.failure?.code === 'transport')).toBe(false);
  });

  it('retries a retryable status answered with a gateway page instead of stopping at bad_url', async () => {
    const document = await story(1);
    let sent = 0;
    const { run, model } = await begin(document, call => (++sent === 1 ? modelError('http_retryable', { status: 408, nonJsonResponse: true }) : translateAll(call)));
    expect(await settle(run.done)).toMatchObject({ status: 'completed', done: 1 });
    expect(model.calls).toHaveLength(2);

    const broke = await story(1);
    const quota = await begin(broke, () => modelError('http_rate_limited', { status: 429, providerMessage: 'You exceeded your current quota, please check your plan and billing details.' }));
    expect(await settle(quota.run.done)).toMatchObject({ status: 'failed', error: { code: 'model_failed', category: 'balance' } });
    expect(quota.model.calls).toHaveLength(1);
  });

  it('reads Zhipu sensitive, Mistral model_length and an incomplete Responses answer, and retries DeepSeek busy answers', async () => {
    const sensitive = await story(1);
    const first = await begin(sensitive, () => answer([], { finishReason: 'sensitive' }));
    await settle(first.run.done);
    expect(sensitive.translationAt(0)?.failure).toEqual({ code: 'content_filtered' });

    const long = await story(1);
    const second = await begin(long, () => answer([], { finishReason: 'model_length' }));
    await settle(second.run.done);
    expect(long.translationAt(0)?.failure).toEqual({ code: 'too_long' });
    expect(second.model.calls.map(call => call.request.maxOutputTokens)).toEqual([8192, 16_384, 16_384]);

    const incomplete = await story(1);
    const third = await begin(incomplete, () => ({ content: '', apiFormat: 'responses', rawStatus: 'incomplete', usage: USAGE }));
    await settle(third.run.done);
    expect(incomplete.translationAt(0)?.failure).toEqual({ code: 'content_filtered' });

    const busy = await story(40, { pace: 1 });
    let sent = 0;
    const fourth = await begin(busy, call => (++sent === 1
      ? answer(call.payload.items.map(item => ({ id: item.id, text: '半' })), { finishReason: 'insufficient_system_resource' })
      : translateAll(call)));
    expect(await settle(fourth.run.done)).toMatchObject({ status: 'completed', done: 40, failed: 0 });
    expect(fourth.model.calls.map(call => call.indices.length)).toEqual([40, 40]);
    expect(busy.usage()).toMatchObject({ requests: 2, failedRequests: 1 });
  });

  it('refuses to start without work, with one language, or with an unusable model', async () => {
    const document = await story(3);
    for (const index of [0, 1, 2]) document.translate(index, '译文');
    await expect(begin(document)).rejects.toMatchObject({ code: 'nothing_to_do' });
    const same = await story(3, { sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hans' });
    await expect(begin(same)).rejects.toMatchObject({ code: 'same_language' });
    const fresh = await story(3);
    await expect(begin(fresh, translateAll, { start: { model: { ...MODEL, contextWindow: 4096 } } })).rejects.toMatchObject({ code: 'model_context_too_small' });
    await expect(begin(fresh, translateAll, { start: { model: { ...MODEL, maxOutputTokens: 70_000 } } })).rejects.toMatchObject({ code: 'model_invalid' });
  });
});

describe('usage', () => {
  it('counts the usage of failed requests, and timeouts as uncertain (AC-LT-18-2)', async () => {
    const document = await story(130, { pace: 1, batchSourceTokens: 4000 });
    const { run, model } = await begin(document, call => {
      if (model.calls.length === 1) return modelError('http_retryable', { status: 503, usage: { inputTokens: 30, outputTokens: 0 } });
      if (model.calls.length === 2) return modelError('request_timeout');
      return translateAll(call);
    });
    await settle(run.done);
    const requests = model.calls.length;
    expect(document.usage()).toEqual({
      requests, failedRequests: 2, unknownRequests: 1,
      inputTokens: 30 + (requests - 2) * USAGE.inputTokens!, outputTokens: (requests - 2) * USAGE.outputTokens!,
    });
    expect(run.view().usage).toMatchObject({ requests, failedRequests: 2, unknownRequests: 1 });
  });
});

describe('glossary', () => {
  const alice = (index: number) => (index % 2 ? `Alice met the queen in room ${index}.` : `The rabbit ran past room ${index}.`);

  it('adopts reported names first come, first served (AC-LT-13-1)', async () => {
    const document = await memoryDocument(storyLines(10, alice), { settings: { pace: 1, batchSourceTokens: 40 } });
    const { run, target, model } = await begin(document, call => {
      const name = model.calls.length === 1 ? '爱丽丝' : '艾莉丝';
      return answer(call.payload.items.map(item => ({ id: item.id, text: item.text.replace('Alice', name) })), {
        terms: [{ source: 'Alice', target: name }, { source: 'Hatter', target: '帽匠' }, { source: 'queen', target: '王后' }],
      });
    });
    await settle(run.done);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(model.calls.length).toBeGreaterThan(1);
    expect(target.ledger.entries).toEqual([
      { id: expect.any(String), source: 'Alice', target: '爱丽丝', origin: 'model', confirmed: false, firstSeen: 1, updatedAt: expect.any(Number) },
    ]);
    expect(document.ledgerSaves).toBe(1);
  });

  it('sends the entries found in the batch, confirmed first, at most 60 (AC-LT-13-2)', async () => {
    const names = Array.from({ length: 70 }, (_, index) => `Name${index}`);
    const document = await memoryDocument([names.join(' '), 'Nothing here.'].join('\n'), { settings: { pace: 1 } });
    const at = Date.now();
    document.ledger.push({ id: randomUUID(), source: 'Bob', target: '鲍勃', origin: 'user', confirmed: true, firstSeen: null, updatedAt: at });
    names.forEach((name, index) => document.ledger.push({ id: randomUUID(), source: name, target: `名${index}`, origin: 'model', confirmed: index >= 65, firstSeen: 0, updatedAt: at }));
    const { run, model } = await begin(document);
    await settle(run.done);
    const sent = model.calls[0].payload.termLedger!;
    expect(sent).toHaveLength(60);
    expect(sent.slice(0, 5).map(entry => entry.source)).toEqual(['Name65', 'Name66', 'Name67', 'Name68', 'Name69']);
    expect(sent.some(entry => entry.source === 'Bob')).toBe(false);
  });

  it('flags a translation that misses a confirmed entry (AC-LT-13-3)', async () => {
    const document = await memoryDocument(storyLines(4, alice), { settings: { pace: 1 } });
    document.ledger.push({ id: randomUUID(), source: 'Alice', target: '艾丽丝', origin: 'user', confirmed: true, firstSeen: 1, updatedAt: Date.now() });
    const { run, model } = await begin(document, call => answer(call.payload.items.map(item => ({ id: item.id, text: item.text.replace('Alice', '爱丽丝') }))));
    await settle(run.done);
    expect(model.calls[0].payload.termLedger).toEqual([{ source: 'Alice', target: '艾丽丝' }]);
    expect(document.translationAt(1)?.flags).toContainEqual({ code: 'term_missing', dismissed: false, detail: { source: 'Alice', target: '艾丽丝', more: 0 } });
    expect(document.translationAt(0)?.flags.some(flag => flag.code === 'term_missing')).toBe(false);
  });

  it('applies the user edits at once', async () => {
    const document = await story(2);
    const ledger = new DocumentLedger(document);
    const [entry] = await ledger.update([{ source: 'Alice', target: '爱丽丝', confirmed: false }], []);
    expect(entry).toMatchObject({ origin: 'user', confirmed: false, firstSeen: null });
    const edited = await ledger.update([{ id: entry.id, source: 'Alice', target: '艾丽丝', confirmed: true }, { source: 'Bob', target: '鲍勃', confirmed: true }], []);
    expect(edited.map(item => [item.source, item.target, item.confirmed])).toEqual([['Alice', '艾丽丝', true], ['Bob', '鲍勃', true]]);
    expect(await ledger.update([], [entry.id])).toHaveLength(1);
    expect(document.ledgerSaves).toBe(3);
    await expect(ledger.update([{ id: randomUUID(), source: 'X', target: 'Y', confirmed: true }], [])).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps a model entry the model\'s when the user only confirms it', async () => {
    const document = await story(2);
    const id = randomUUID();
    document.ledger.push({ id, source: 'Alice', target: '爱丽丝', origin: 'model', confirmed: false, firstSeen: 0, updatedAt: Date.now() });
    const ledger = new DocumentLedger(document);
    const [confirmed] = await ledger.update([{ id, source: 'Alice', target: '爱丽丝', confirmed: true }], []);
    expect(confirmed).toMatchObject({ origin: 'model', confirmed: true });
    const [rewritten] = await ledger.update([{ id, source: 'Alice', target: '艾丽丝', confirmed: true }], []);
    expect(rewritten).toMatchObject({ origin: 'user', target: '艾丽丝' });
  });
});

describe('materials', () => {
  const COLLECTION = randomUUID();
  const TERM = randomUUID();

  function library(options: { archived?: boolean } = {}): LibrarySnapshot {
    const term: Entry = {
      id: TERM, revision: 1, collectionId: COLLECTION, enabled: true, kind: 'term',
      payload: { source: 'garden', target: '花园', aliases: [], note: '', strength: 'required', match: { mode: 'whole_term', caseSensitive: false } },
    };
    return {
      generation: 1,
      data: {
        format: 'fusionkit.translation-knowledge', schemaVersion: 2,
        package: { id: randomUUID(), revision: 1, name: 'Library', description: '', createdAt: '2026-10-01T00:00:00Z', generator: { name: 'test' } },
        collections: [{ id: COLLECTION, revision: 1, name: 'Story', description: '', languagePair: { source: 'en', target: 'zh-Hans' }, archived: options.archived ?? false }],
        entries: [term], presets: [],
      },
    };
  }
  const selection: KnowledgeSelection = { version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [COLLECTION], disabledEntryIds: [] };
  const lines = (index: number) => (index % 3 ? `The garden was quiet at hour ${index}.` : `Nothing grew there at hour ${index}.`);

  it('sends required terms to the batches that contain them and flags a translation without them (AC-LT-13-5, AC-LT-13-6)', async () => {
    const document = await memoryDocument(storyLines(50, lines), { settings: { pace: 1, knowledge: selection } });
    const read = vi.fn(() => library());
    const { run, model } = await begin(document, call => answer(call.payload.items.map(item => ({ id: item.id, text: `【译】${item.text}` }))), { library: read });
    await settle(run.done);
    expect(read).toHaveBeenCalledTimes(1);
    expect(model.calls.length).toBeGreaterThan(1);
    expect(Math.max(...sizes(model.calls))).toBeLessThanOrEqual(20);
    const first = model.calls[0];
    const items = first.payload.translationKnowledge!.items;
    expect(items).toEqual([{ kind: 'term', required: true, payload: expect.objectContaining({ source: 'garden', target: '花园' }), applicableItemIds: expect.any(Array) }]);
    expect(items[0].applicableItemIds).toEqual(first.indices.flatMap((index, position) => (index % 3 ? [`s${position + 1}`] : [])));
    expect(first.request.messages[0].content).toContain('"translationKnowledge" holds materials curated by the user.');
    expect(document.translationAt(1)?.flags).toContainEqual({ code: 'term_missing', dismissed: false, detail: { source: 'garden', target: '花园', more: 0 } });
    expect(document.translationAt(0)?.flags.some(flag => flag.code === 'term_missing')).toBe(false);
  });

  it('sends a shorter batch when its materials hit a resolution budget, never one without its required items (§6.9.5)', async () => {
    // 259 terms that occur nowhere: every one adds a no_match diagnostic per segment, so 20 segments pass the
    // 5,000-diagnostic budget and 10 do not. The one term that occurs sorts last and would be dropped.
    const term = (id: string, source: string, target: string): Entry => ({
      id, revision: 1, collectionId: COLLECTION, enabled: true, kind: 'term',
      payload: { source, target, aliases: [], note: '', strength: 'required', match: { mode: 'whole_term', caseSensitive: false } },
    });
    const snapshot = library();
    snapshot.data.entries = [
      ...Array.from({ length: 259 }, (_, k) => term(`0${randomUUID().slice(1)}`, `absent${k}`, `缺${k}`)),
      term('ffffffff-ffff-4fff-bfff-ffffffffffff', 'garden', '花园'),
    ];
    const document = await memoryDocument(storyLines(40, index => `The garden was quiet at hour ${index}.`), { settings: { pace: 1, knowledge: selection } });
    const { run, model } = await begin(document, translateAll, { library: () => snapshot });
    expect(await settle(run.done)).toMatchObject({ status: 'completed', done: 40, failed: 0 });
    expect(Math.max(...sizes(model.calls))).toBeLessThanOrEqual(10);
    for (const call of model.calls) {
      expect(call.payload.translationKnowledge?.items).toContainEqual(expect.objectContaining({ required: true, payload: expect.objectContaining({ source: 'garden' }) }));
    }
  });

  it('fails a segment over 64 KiB on its own when materials are selected, and translates the others', async () => {
    const heading = `# ${'garden '.repeat(10_000)}`;
    const S = ['The garden was quiet.', '', 'Nothing grew there.', '', heading, '', 'The garden woke up.', ''].join('\n');
    const document = await memoryDocument(S, { format: 'markdown', settings: { pace: 1, knowledge: selection } });
    const long = document.translatable().find(index => document.displayAt(index).length > 65_536)!;
    expect(long).toBe(2);
    const { run } = await begin(document, translateAll, { library: () => library() });
    expect(await settle(run.done)).toMatchObject({ status: 'completed', failed: 1 });
    expect(document.translationAt(long)?.failure).toEqual({ code: 'too_long' });
    expect(document.translatable().filter(index => index !== long).every(index => document.status(index) === 'done')).toBe(true);

    // The materials are checked with a clipped probe, so a retranslation of that segment fails it the same way.
    const again = runnerSetup(document, fakeModel(document).send, { library: () => library() });
    const record = await settle(retranslate(again.target, { index: long, rev: document.rev(long), model: MODEL, apiKey: API_KEY }, again.services));
    expect(record).toMatchObject({ status: 'failed', failure: { code: 'too_long' } });
  });

  it('refuses to start when the materials cannot be read or used', async () => {
    const document = await memoryDocument(storyLines(5, lines), { settings: { knowledge: selection } });
    await expect(begin(document, translateAll, { library: () => { throw new Error('locked'); } })).rejects.toMatchObject({ code: 'knowledge_unavailable' });
    await expect(begin(document, translateAll, { library: () => library({ archived: true }) })).rejects.toMatchObject({ code: 'knowledge_invalid' });
    const other = await memoryDocument(storyLines(5, lines), { settings: { knowledge: { ...selection, collectionIds: [randomUUID()] } } });
    await expect(begin(other, translateAll, { library: () => library() })).rejects.toMatchObject({ code: 'knowledge_invalid' });
  });
});

describe('RequestPool', () => {
  it('serves 6 requests at once, interactive ones first but at most 2 of them', async () => {
    const pool = new RequestPool();
    const signal = new AbortController().signal;
    const runs = await Promise.all(Array.from({ length: 6 }, () => pool.acquire(signal, 'run')));
    const order: string[] = [];
    const waiting = [
      pool.acquire(signal, 'run').then(release => { order.push('run'); return release; }),
      pool.acquire(signal, 'interactive').then(release => { order.push('interactive 1'); return release; }),
      pool.acquire(signal, 'interactive').then(release => { order.push('interactive 2'); return release; }),
      pool.acquire(signal, 'interactive').then(release => { order.push('interactive 3'); return release; }),
    ];
    for (const release of runs.slice(0, 4)) release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['interactive 1', 'interactive 2', 'run']);
    expect(pool.inUse).toBe(5);
    (await waiting[1])();
    await vi.advanceTimersByTimeAsync(0);
    expect(order.at(-1)).toBe('interactive 3');
  });

  it('drops a waiter whose signal aborts', async () => {
    const pool = new RequestPool(1, 1);
    const release = await pool.acquire(new AbortController().signal, 'run');
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal, 'run');
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(pool.inUse).toBe(0);
  });
});

describe('with a loaded document', () => {
  let root: string;
  beforeEach(async () => {
    vi.useRealTimers();
    root = await temporaryRoot();
  });
  afterEach(async () => {
    await removeRoot(root);
  });

  it('commits to the journal and measures length ratios on reload', async () => {
    const repository = new LongTextRepository(root);
    await repository.recover();
    const created = await buildDocument(storyLines(130, index => `Line number ${index} of the story, told slowly and with great care.`));
    await repository.createDocument(created);
    const open = async () => {
      const loaded = await LoadedDocument.open(repository, created.manifest.id, { ratio: LENGTH_RATIOS });
      if ('unavailable' in loaded) throw new Error('unavailable');
      return loaded;
    };
    const document = await open();
    const send = vi.fn(async (request: ModelRuntimeTextRequest) => {
      const payload = JSON.parse(request.messages[1].content) as { items: Array<{ id: string; text: string }> };
      return answer(payload.items.map(item => ({ id: item.id, text: `故事的第${item.text.match(/\d+/)![0]}行，被缓慢而仔细地讲述。` })));
    });
    const target = { document, ledger: new DocumentLedger(document), observed: emptyObserved() };
    const saved: string[] = [];
    const run = await Run.start(target, { kind: 'full', model: MODEL, apiKey: API_KEY, settingsDigest: 'digest' }, {
      send, pool: new RequestPool(), readKnowledge: () => { throw new Error('unused'); },
    }, { save: async record => { saved.push(record.status); } });
    const record = await run.done;
    expect(record).toMatchObject({ status: 'completed', done: 130 });
    expect(document.summary().counts).toMatchObject({ done: 130, pending: 0 });
    expect(target.observed.units).toBe(send.mock.calls.length);
    await document.close();
    await repository.idle();

    const reloaded = await open();
    expect(reloaded.summary().counts.done).toBe(130);
    expect(reloaded.summary().usage.requests).toBe(send.mock.calls.length);
    expect(reloaded.ratio.value).not.toBe(LENGTH_RATIOS.create(reloaded.languages()).value);
    await reloaded.close();
    await repository.idle();
    repository.dispose();
  });
});
