import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createStudioTranscriptionController } from '../../src/services/subtitle-studio/transcription-controller';
import { createStudioTranslationOverviewController, getTranslationRoundProgress } from '../../src/services/subtitle-studio/translation-overview-controller';
import type { StudioEvent, StudioResult, SubtitleStudioApi, TranslationTasksSnapshot, TranslationTaskSummary } from '../../src/subtitle-studio/ipc-contract';
import type { TranscriptionTaskSummary } from '../../src/subtitle-studio/transcription/task-contract';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../src/subtitle-studio/transcription/domain';

const disposers: Array<() => void> = [];
const ok = <T>(value: T): StudioResult<T> => ({ ok: true, value });
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const pending = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
function task(number: number, status: TranscriptionTaskSummary['status'], cleanupPending = false): TranscriptionTaskSummary {
  return { taskId: id(number), batchId: id(900), generation: 1, displayName: `speech-${number}.wav`, status, progress: status === 'completed' ? 100 : 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
    resolvedBackend: 'cpu', ...(cleanupPending ? { cleanupPending: true } : {}),
    ...(status === 'completed' ? { documentId: id(number + 100), documentDurability: 'confirmed' as const } : {}) };
}
async function queue(initial: TranscriptionTaskSummary[]) {
  let tasks = initial;
  const api = {
    dropTranscriptionMedia: vi.fn<SubtitleStudioApi['dropTranscriptionMedia']>(),
    selectTranscriptionMedia: vi.fn<SubtitleStudioApi['selectTranscriptionMedia']>().mockResolvedValue(ok(null)),
    probeTranscriptionMedia: vi.fn<SubtitleStudioApi['probeTranscriptionMedia']>(),
    revokeTranscriptionMedia: vi.fn<SubtitleStudioApi['revokeTranscriptionMedia']>(),
    inspectTranscriptionRuntime: vi.fn<SubtitleStudioApi['inspectTranscriptionRuntime']>().mockResolvedValue(ok({ status: 'missing', code: 'missing', stage: 'startup' })),
    listTranscriptionResources: vi.fn<SubtitleStudioApi['listTranscriptionResources']>().mockResolvedValue(ok({ resources: [], jobs: [] })),
    importTranscriptionModel: vi.fn<SubtitleStudioApi['importTranscriptionModel']>(),
    installTranscriptionResource: vi.fn<SubtitleStudioApi['installTranscriptionResource']>(),
    deleteTranscriptionResource: vi.fn<SubtitleStudioApi['deleteTranscriptionResource']>(),
    cancelTranscriptionResourceJob: vi.fn<SubtitleStudioApi['cancelTranscriptionResourceJob']>(),
    enqueueTranscription: vi.fn<SubtitleStudioApi['enqueueTranscription']>(),
    listTranscriptionTasks: vi.fn<SubtitleStudioApi['listTranscriptionTasks']>(async () => ok(tasks)),
    cancelTranscriptionTask: vi.fn<SubtitleStudioApi['cancelTranscriptionTask']>(async ({ taskId }) => ok(tasks.find(item => item.taskId === taskId)!)),
    removeTranscriptionTask: vi.fn<SubtitleStudioApi['removeTranscriptionTask']>(async ({ taskId }) => { tasks = tasks.filter(item => item.taskId !== taskId); return ok(null); }),
  };
  const controller = createStudioTranscriptionController({ getApi: () => api }); disposers.push(controller.dispose);
  await controller.start();
  return { controller, api, getTasks: () => tasks, setTasks: (value: TranscriptionTaskSummary[]) => { tasks = value; } };
}

describe('transcription queue maintenance', () => {
  it('clears only the completed snapshot and preserves active, failed, cleanup-pending tasks and documents', async () => {
    const f = await queue([task(1, 'completed'), task(2, 'failed'), task(3, 'queued'), task(4, 'transcribing'), task(5, 'completed', true)]);
    const savedDocument = f.getTasks()[0].documentId;
    expect(await f.controller.clearCompleted()).toEqual({ action: 'clear_completed', succeeded: 1, failed: 0, skipped: 1 });
    await tick();
    expect(f.api.removeTranscriptionTask.mock.calls).toEqual([[{ taskId: id(1) }]]);
    expect(f.controller.getState().tasks.map(item => item.taskId)).toEqual([id(2), id(3), id(4), id(5)]);
    expect(savedDocument).toBe(id(101)); // The only invoked mutation removes the queue record, never a document.
    expect(f.api.cancelTranscriptionTask).not.toHaveBeenCalled();
  });
  it('continues after individual failure and retains the rejected record while clearing other terminal states', async () => {
    const f = await queue([task(1, 'completed'), task(2, 'failed'), task(3, 'cancelled'), task(4, 'failed', true), task(5, 'queued')]);
    f.api.removeTranscriptionTask.mockImplementationOnce(async () => ({ ok: false, error: 'transcription_failed' }));
    expect(await f.controller.clearTerminal()).toEqual({ action: 'clear_terminal', succeeded: 2, failed: 1, skipped: 1 });
    await tick();
    expect(f.controller.getState().tasks.map(item => item.taskId)).toEqual([id(1), id(4), id(5)]);
    expect(f.controller.getState().error).toBe('transcription_failed');
  });
  it('joins duplicate actions and protects a concurrently completed task outside the trigger snapshot', async () => {
    const f = await queue([task(1, 'completed'), task(2, 'queued')]);
    const gate = pending<StudioResult<null>>();
    f.api.removeTranscriptionTask.mockImplementationOnce(() => gate.promise);
    const operation = f.controller.clearCompleted();
    expect(f.controller.clearTerminal()).toBe(operation);
    await f.controller.cancelTask(id(2)); expect(f.api.cancelTranscriptionTask).not.toHaveBeenCalled();
    f.setTasks([task(2, 'completed')]);
    await tick(); gate.resolve(ok(null)); await operation; await tick();
    expect(f.controller.getState().tasks.map(item => item.taskId)).toEqual([id(2)]);
    expect(f.api.removeTranscriptionTask).toHaveBeenCalledOnce();
  });
  it('sends cancellation for confirmation IDs only and waits for actual terminal state before clearing', async () => {
    const f = await queue([task(1, 'transcribing'), task(2, 'queued'), task(3, 'completed')]);
    const confirmation = [id(1), id(2)];
    f.setTasks([...f.getTasks(), task(4, 'queued')]); await f.controller.refresh();
    expect(await f.controller.cancelTasks(confirmation)).toEqual({ action: 'cancel_active', succeeded: 2, failed: 0, skipped: 0 });
    expect(f.api.cancelTranscriptionTask.mock.calls).toEqual([[{ taskId: id(1) }], [{ taskId: id(2) }]]);
    expect(f.controller.getState().cancellingTaskIds).toEqual(confirmation);
    expect(f.api.removeTranscriptionTask).not.toHaveBeenCalled();
    await tick();
    f.setTasks([task(1, 'cancelled', true), task(2, 'cancelled'), task(3, 'completed'), task(4, 'queued')]);
    await f.controller.refresh(); await f.controller.clearTerminal(); await tick();
    expect(f.controller.getState().tasks.map(item => item.taskId)).toEqual([id(1), id(4)]);
    expect(f.controller.getState().cancellingTaskIds).toEqual([]);
  });
  it('skips already ended or already cancelling confirmation targets and reports a partial cancel failure', async () => {
    const f = await queue([task(1, 'transcribing'), task(2, 'queued'), task(3, 'cancelled')]);
    await f.controller.cancelTask(id(1));
    f.api.cancelTranscriptionTask.mockResolvedValueOnce({ ok: false, error: 'interrupted' });
    expect(await f.controller.cancelTasks([id(1), id(2), id(3), id(4)])).toEqual({ action: 'cancel_active', succeeded: 0, failed: 1, skipped: 3 });
    expect(f.controller.getState().cancellingTaskIds).toEqual([id(1)]);
    expect(f.controller.getState().tasks).toHaveLength(3);
  });
  it('empty actions are no-ops with no mutation requests', async () => {
    const f = await queue([]);
    for (const operation of [f.controller.clearCompleted, f.controller.clearTerminal, () => f.controller.cancelTasks([])]) {
      expect(await operation()).toMatchObject({ succeeded: 0, failed: 0, skipped: 0 });
    }
    expect(f.api.removeTranscriptionTask).not.toHaveBeenCalled(); expect(f.api.cancelTranscriptionTask).not.toHaveBeenCalled();
  });
});

function translation(number: number, status: TranslationTaskSummary['status'], completed = 0, total = 4): TranslationTaskSummary {
  return { taskId: id(number), documentId: id(number + 1000), revision: 1, trackId: id(number + 2000), displayName: `document-${number}.srt`,
    status, language: 'ja', modelKey: 'test-model', completedBatches: completed, totalBatches: total, canResume: status === 'interrupted' };
}
function snapshot(items: TranslationTaskSummary[], sequence = 1): TranslationTasksSnapshot {
  const counts: TranslationTasksSnapshot['counts'] = { queued: 0, running: 0, completed: 0, cancelled: 0, failed: 0, interrupted: 0, needs_configuration: 0 };
  for (const item of items) counts[item.status]++;
  return { sequence, items, total: items.length, counts, completedBatches: items.reduce((sum, item) => sum + item.completedBatches, 0),
    totalBatches: items.reduce((sum, item) => sum + item.totalBatches, 0), unavailableDocuments: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownInput: items.length, unknownOutput: items.length, unknownTotal: items.length } };
}
function overview(initial: TranslationTaskSummary[]) {
  let all = initial, sequence = 1;
  let event!: (value: StudioEvent) => void;
  const api = {
    subscribe: vi.fn<SubtitleStudioApi['subscribe']>(listener => { event = listener; return vi.fn(); }),
    listTranslationTasks: vi.fn<SubtitleStudioApi['listTranslationTasks']>(async request => {
      const value = snapshot(request.taskIds ? all.filter(item => request.taskIds!.includes(item.taskId)) : all, sequence);
      return ok({ ...value, items: value.items.slice(request.offset, request.offset + request.pageSize) });
    }),
  };
  const controller = createStudioTranslationOverviewController({ getApi: () => api }); disposers.push(controller.dispose);
  return { controller, api, changed: (next: number) => event({ documentId: id(1001), revision: next, sequence: next, deleted: false }),
    setItems: (items: TranslationTaskSummary[], next: number) => { all = items; sequence = next; } };
}

describe('translation overview observations', () => {
  it('keeps all-document counts when detail pages change and scopes percent to actual latest submitted IDs', async () => {
    const items = [...Array.from({ length: 25 }, (_, index) => translation(index + 1, 'completed', 100, 100)), translation(50, 'running', 1, 4), translation(51, 'queued', 0, 6)];
    const f = overview(items); await f.controller.refresh();
    expect(f.controller.getState().snapshot).toMatchObject({ total: 27, counts: { completed: 25, running: 1, queued: 1 } });
    expect(f.controller.getState().round).toBeNull();
    f.controller.trackStarted([id(50), id(51)]); await tick();
    expect(getTranslationRoundProgress(f.controller.getState())).toBe(10);
    f.controller.setOffset(20); await tick();
    expect(f.controller.getState().snapshot?.items).toHaveLength(7);
    expect(f.controller.getState().snapshot?.total).toBe(27);
    expect(getTranslationRoundProgress(f.controller.getState())).toBe(10);
    expect(f.api.listTranslationTasks).toHaveBeenCalledWith({ offset: 0, pageSize: 100, taskIds: [id(50), id(51)] });
  });
  it('retains cohort and active polling across SPA unmounts, replacing it only on a new successful submission', async () => {
    const f = overview([translation(1, 'running', 1), translation(2, 'queued')]);
    const detach = f.controller.subscribe(vi.fn()); f.controller.trackStarted([id(1)]); await tick(); detach();
    f.setItems([translation(1, 'completed', 4), translation(2, 'queued')], 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getTranslationRoundProgress(f.controller.getState())).toBe(100);
    f.controller.subscribe(vi.fn()); await tick();
    expect(f.controller.getState().roundTaskIds).toEqual([id(1)]);
    f.controller.trackStarted([]); expect(f.controller.getState().roundTaskIds).toEqual([id(1)]);
    f.controller.trackStarted([id(2), id(2)]); await tick();
    expect(f.controller.getState().roundTaskIds).toEqual([id(2)]);
    expect(getTranslationRoundProgress(f.controller.getState())).toBe(0);
  });
  it('drops an in-flight response invalidated by a newer event and performs one joined follow-up', async () => {
    const f = overview([translation(1, 'queued')]); await f.controller.refresh();
    const gate = pending<StudioResult<TranslationTasksSnapshot>>();
    f.api.listTranslationTasks.mockImplementationOnce(() => gate.promise);
    const operation = f.controller.refresh(); await tick();
    f.setItems([translation(1, 'completed', 4)], 3); f.changed(2); f.changed(3);
    expect(f.controller.refresh()).toBe(operation);
    gate.resolve(ok(snapshot([translation(1, 'running', 1)], 1))); await operation;
    expect(f.controller.getState().snapshot?.items[0].status).toBe('queued');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.controller.getState().snapshot?.items[0].status).toBe('completed');
    expect(f.api.listTranslationTasks).toHaveBeenCalledTimes(3);
  });
  it('never rolls a previously accepted snapshot backwards even without a matching event', async () => {
    const f = overview([translation(1, 'completed', 4)]); f.setItems([translation(1, 'completed', 4)], 4); await f.controller.refresh();
    f.api.listTranslationTasks.mockResolvedValueOnce(ok(snapshot([translation(1, 'queued')], 2)));
    await f.controller.refresh();
    expect(f.controller.getState().snapshot?.sequence).toBe(4);
    expect(f.controller.getState().snapshot?.items[0].status).toBe('completed');
  });
  it('does not let the previous round read overwrite a newly submitted round', async () => {
    const f = overview([translation(1, 'completed', 4), translation(2, 'queued')]);
    f.controller.trackStarted([id(1)]); await tick();
    const gate = pending<StudioResult<TranslationTasksSnapshot>>();
    f.api.listTranslationTasks.mockImplementationOnce(() => gate.promise);
    const operation = f.controller.refresh(); await tick(); f.controller.trackStarted([id(2)]);
    gate.resolve(ok(snapshot([translation(1, 'completed', 4), translation(2, 'queued')]))); await operation;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.controller.getState().roundTaskIds).toEqual([id(2)]);
    expect(getTranslationRoundProgress(f.controller.getState())).toBe(0);
  });
  it('retains useful counts on read failure and exposes unavailable documents without claiming complete progress', async () => {
    const f = overview([translation(1, 'running', 2)]); await f.controller.refresh();
    f.controller.trackStarted([id(1), id(2)]); await tick();
    expect(getTranslationRoundProgress(f.controller.getState())).toBeNull();
    const unavailable = { ...snapshot([translation(1, 'running', 2)], 2), unavailableDocuments: 3 };
    f.api.listTranslationTasks.mockResolvedValueOnce(ok(unavailable)); await f.controller.refresh();
    expect(f.controller.getState().snapshot?.unavailableDocuments).toBe(3);
    f.api.listTranslationTasks.mockRejectedValueOnce(new Error('private file location'));
    await f.controller.refresh();
    expect(f.controller.getState().error).toBe('document_unavailable');
    expect(f.controller.getState().snapshot?.counts.running).toBe(1);
  });
  it('counts only confirmed batches when some tasks fail or are cancelled, never forces terminal progress to 100', async () => {
    const f = overview([translation(1, 'completed', 4), translation(2, 'failed', 1), translation(3, 'cancelled', 0)]);
    f.controller.trackStarted([id(1), id(2), id(3)]); await tick();
    expect(getTranslationRoundProgress(f.controller.getState())).toBe(41);
    expect(f.controller.getState().round?.counts).toMatchObject({ completed: 1, failed: 1, cancelled: 1 });
  });
  it('repairs an empty last page after concurrent deletion without changing the global totals', async () => {
    const f = overview(Array.from({ length: 22 }, (_, index) => translation(index + 1, 'completed', 4)));
    f.controller.subscribe(vi.fn()); await tick();
    f.controller.setOffset(20); await tick();
    f.setItems([translation(1, 'completed', 4)], 2); f.changed(2); await tick();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.controller.getState().offset).toBe(0);
    expect(f.controller.getState().snapshot?.items[0].taskId).toBe(id(1));
  });
  it('bounds each cohort request and rejects oversized cohorts without replacing a valid round', async () => {
    const f = overview([translation(1, 'queued')]); f.controller.trackStarted([id(1)]); await tick();
    f.controller.trackStarted(Array.from({ length: 101 }, (_, index) => id(index + 1)));
    expect(f.controller.getState().error).toBe('limit_exceeded');
    expect(f.controller.getState().roundTaskIds).toEqual([id(1)]);
    expect(f.api.listTranslationTasks.mock.calls.every(([request]) => (request.taskIds?.length ?? 0) <= 100)).toBe(true);
  });
});

it('supplies every queue, overview, import, format and export acceptance label in all four locales', () => {
  const files = ['zh', 'en', 'ja', 'zh-Hant'].map(locale => JSON.parse(readFileSync(new URL(`../../src/locales/${locale}/studio.json`, import.meta.url), 'utf8')));
  const groups = ['overview', 'transcription', 'library', 'diagnostics', 'export'];
  const flatten = (value: Record<string, unknown>, prefix = ''): Record<string, string> => Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'string' ? [[`${prefix}${key}`, item]] : Object.entries(flatten(item as Record<string, unknown>, `${prefix}${key}.`))));
  for (const group of groups) {
    const reference = flatten(files[0][group]);
    for (const file of files.slice(1)) {
      const actual = flatten(file[group]); expect(Object.keys(actual).sort()).toEqual(Object.keys(reference).sort());
      for (const [key, value] of Object.entries(reference)) {
        expect(actual[key].trim()).not.toBe('');
        expect(actual[key].match(/\{\{\w+\}\}/g)?.sort() ?? []).toEqual(value.match(/\{\{\w+\}\}/g)?.sort() ?? []);
      }
    }
  }
});
