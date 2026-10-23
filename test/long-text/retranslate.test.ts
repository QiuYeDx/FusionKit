import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestPool } from '../../electron/main/long-text/request-pool';
import { retranslate, Run, type RetranslateRequest } from '../../electron/main/long-text/runner';
import {
  abortableDelay, answer, API_KEY, fakeModel, MODEL, memoryDocument, modelError, runnerSetup, settle, storyLines, translateAll,
  type MemoryDocument, type Responder,
} from './runner-test-utils';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(document: MemoryDocument, responder: Responder = translateAll, options: { pool?: RequestPool; delayMs?: number } = {}) {
  const model = fakeModel(document, responder, { delayMs: options.delayMs });
  const wiring = runnerSetup(document, model.send, { pool: options.pool });
  const again = (request: Partial<RetranslateRequest> & { index: number }, signal?: AbortSignal) =>
    retranslate(wiring.target, { rev: document.rev(request.index), model: MODEL, apiKey: API_KEY, ...request }, wiring.services, signal);
  return { model, again, ...wiring };
}

const casual = (call: Parameters<Responder>[0]) => answer(call.payload.items.map(item => ({ id: item.id, text: `【口语】${item.text}` })));

describe('retranslate', () => {
  it('sends the request and the current translation, and replaces the translation unlocked with an undo step', async () => {
    const document = await memoryDocument(storyLines(10));
    document.edit(4, '用户锁定的译文');
    const { model, again } = setup(document, casual);
    const record = await settle(again({ index: 4, instruction: '  更口语一些。 ' }));

    const [call] = model.calls;
    expect(call.payload.revision).toEqual({ request: '更口语一些。', currentTranslation: '用户锁定的译文' });
    expect(call.request.messages[0].content).toContain('"revision.request" is the user\'s request for this item');
    expect(call.payload.items).toEqual([{ id: 's1', text: 'Line number 4 of the story.' }]);
    expect(record).toMatchObject({ index: 4, rev: 2, status: 'done', origin: 'model', locked: false, runId: null, target: '【口语】Line number 4 of the story.' });
    expect(record.previous).toMatchObject({ status: 'done', target: '用户锁定的译文', origin: 'user', locked: true });
    expect(document.inFlight.size).toBe(0);
    expect(document.usage()).toMatchObject({ requests: 1 });
  });

  it('leaves the revision out for an untranslated segment without a request', async () => {
    const document = await memoryDocument(storyLines(3));
    const { model, again } = setup(document);
    await settle(again({ index: 1 }));
    expect(model.calls[0].payload.revision).toBeUndefined();
    expect(model.calls[0].request.messages[0].content).not.toContain('revision');
  });

  it('refuses a segment in flight with busy and an outdated rev with revision_conflict (AC-LT-15-7)', async () => {
    const document = await memoryDocument(storyLines(3));
    document.translate(1, '译文');
    const { model, again } = setup(document);
    document.markInFlight([2]);
    await expect(again({ index: 2 })).rejects.toMatchObject({ code: 'busy' });
    expect(document.inFlight.has(2)).toBe(true);
    await expect(again({ index: 1, rev: 0 })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(document.inFlight.has(1)).toBe(false);
    expect(document.translationAt(1)?.target).toBe('译文');
    expect(model.calls).toHaveLength(0);
  });

  it('takes a segment a run has queued, and the run no longer sends it (AC-LT-15-6)', async () => {
    const document = await memoryDocument(storyLines(10), { settings: { pace: 1 } });
    const pool = new RequestPool(1, 1);
    const hold = await pool.acquire(new AbortController().signal, 'run');
    const model = fakeModel(document, call => (call.payload.revision ? casual(call) : translateAll(call)));
    const wiring = runnerSetup(document, model.send, { pool });
    const run = await Run.start(wiring.target, { kind: 'full', model: MODEL, apiKey: API_KEY, settingsDigest: 'digest' }, wiring.services, wiring.hooks);
    await vi.advanceTimersByTimeAsync(0);
    // The run chose segments 0–9 and waits for the only slot; the retranslation takes segment 5 and waits first in line.
    const pending = retranslate(wiring.target, { index: 5, rev: 0, instruction: '更口语', model: MODEL, apiKey: API_KEY }, wiring.services);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.inFlight.has(5)).toBe(true);
    hold();
    const record = await settle(pending);
    await settle(run.done);

    expect(record.target).toBe('【口语】Line number 5 of the story.');
    expect(model.calls.map(call => call.indices)).toEqual([[5], [0, 1, 2, 3, 4, 6, 7, 8, 9]]);
    expect(document.translationAt(5)?.target).toBe('【口语】Line number 5 of the story.');
  });

  it('fails only itself on a fatal error, while the run goes on', async () => {
    const document = await memoryDocument(storyLines(130), { settings: { pace: 1, batchSourceTokens: 80 } });
    const { model, again, target, services, hooks } = setup(document, async call => {
      if (call.payload.revision || call.indices[0] === 120) return modelError('http_unauthorized', { status: 401, providerMessage: 'Invalid key' });
      await abortableDelay(500, call.request.signal);
      return translateAll(call);
    });
    const run = await Run.start(target, { kind: 'full', model: MODEL, apiKey: API_KEY, settingsDigest: 'digest' }, services, hooks);
    document.translate(125, '已有译文');
    const failed = again({ index: 125, instruction: '更正式' });
    await expect(settle(failed)).rejects.toMatchObject({ code: 'model_failed', error: { code: 'model_failed', category: 'auth', message: 'Invalid key' } });
    expect(document.translationAt(125)?.target).toBe('已有译文');
    expect(run.view().status).toBe('running');
    // The run reaches segment 120 later and stops there on its own.
    const record = await settle(run.done);
    expect(record.error).toMatchObject({ code: 'model_failed', category: 'auth' });
    expect(model.calls.some(call => call.payload.revision !== undefined)).toBe(true);
  });

  it('marks the segment failed after 3 rejected attempts, keeping the old version as the undo step', async () => {
    const document = await memoryDocument(storyLines(3));
    document.translate(1, '旧译文');
    const { model, again } = setup(document, () => answer([]));
    const record = await settle(again({ index: 1 }));
    expect(model.calls).toHaveLength(3);
    expect(record).toMatchObject({ status: 'failed', failure: { code: 'protocol_invalid' }, previous: { status: 'done', target: '旧译文' } });
    expect(document.usage()).toMatchObject({ requests: 3, failedRequests: 3 });
  });

  it('gives up after the transport retries without touching the segment', async () => {
    const document = await memoryDocument(storyLines(3));
    document.translate(1, '旧译文');
    const { model, again } = setup(document, () => modelError('network_error'));
    await expect(settle(again({ index: 1 }))).rejects.toMatchObject({ code: 'model_failed', error: { code: 'model_failed', category: 'network' } });
    expect(model.calls).toHaveLength(4);
    expect(document.translationAt(1)?.target).toBe('旧译文');
    expect(document.inFlight.size).toBe(0);
  });

  it('stops boosting when the provider refuses the doubled output limit, and fails as too_long', async () => {
    const document = await memoryDocument(storyLines(3));
    const { model, again } = setup(document, call => (call.request.maxOutputTokens! > 8192
      ? modelError('http_non_retryable', { status: 400, providerMessage: 'Range of max_tokens should be [1, 8192]' })
      : modelError('length_truncated')));
    const record = await settle(again({ index: 1 }));
    expect(record).toMatchObject({ status: 'failed', failure: { code: 'too_long' } });
    expect(model.calls.map(call => call.request.maxOutputTokens)).toEqual([8192, 16_384, 8192]);
    expect(model.calls.every(call => call.request.responseFormat === 'json_object')).toBe(true);
  });

  it('fails a segment answered with empty content as empty_output, not as a model failure', async () => {
    const document = await memoryDocument(storyLines(3));
    const { model, again } = setup(document, () => modelError('empty_response'));
    const record = await settle(again({ index: 1 }));
    expect(record).toMatchObject({ status: 'failed', failure: { code: 'empty_output' } });
    expect(model.calls).toHaveLength(3);
  });

  it('retries a cut-off answer with twice the output limit and stops when aborted', async () => {
    const document = await memoryDocument(storyLines(3));
    const { model, again } = setup(document, call => (model.calls.length === 1 ? answer([], { finishReason: 'length' }) : translateAll(call)));
    await settle(again({ index: 0 }));
    expect(model.calls.map(call => call.request.maxOutputTokens)).toEqual([8192, 16_384]);

    const slow = setup(document, translateAll, { delayMs: 5_000 });
    const controller = new AbortController();
    const pending = slow.again({ index: 2 }, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(settle(pending)).rejects.toMatchObject({ code: 'unavailable' });
    expect(document.status(2)).toBe('pending');
    expect(document.usage().unknownRequests).toBe(1);
  });
});
