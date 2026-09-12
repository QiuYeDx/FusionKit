import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStudioTranscriptionController, getTranscriptionReadiness, type StudioTranscriptionController } from '../../src/services/subtitle-studio/transcription-controller';
import type { SubtitleStudioApi, StudioResult, TranscriptionMediaSelection, TranscriptionResources } from '../../src/subtitle-studio/ipc-contract';
import type { LocalSubtitleAuthorizedMedia, LocalSubtitleMediaProbeSummary } from '../../src/subtitle-studio/transcription/ipc-contract';
import type { TranscriptionTaskSummary } from '../../src/subtitle-studio/transcription/task-contract';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../src/subtitle-studio/transcription/domain';
import { DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES, DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_DRAFT_PREFERENCES } from '../../src/subtitle-studio/transcription/config';
import { DEFAULT_TRANSCRIPTION_PREFERENCES } from '../../src/subtitle-studio/transcription/preferences-contract';

const controllers: StudioTranscriptionController[] = [];
const ok = <T>(value: T): StudioResult<T> => ({ ok: true, value });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T08:00:00Z')); });
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
const task = (id = '11111111-1111-4111-8111-111111111111', status: TranscriptionTaskSummary['status'] = 'queued'): TranscriptionTaskSummary => ({
  taskId: id, batchId: '22222222-2222-4222-8222-222222222222', generation: 1, displayName: 'speech.wav', status, progress: 0,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
  resolvedBackend: 'cpu', ...(status === 'completed' ? { documentId: '33333333-3333-4333-8333-333333333333', documentDurability: 'confirmed' as const } : {}) });
function media(id = '1', expiresAt = Date.now() + 60000): LocalSubtitleAuthorizedMedia {
  return { fileToken: `ls-input-${id}`, sourceKey: `ls-source-${id}`, displayName: `speech-${id}.wav`, byteSize: 1000, expiresAt };
}
function probe(input = media()): LocalSubtitleMediaProbeSummary {
  return { fileToken: input.fileToken, displayName: input.displayName, durationMs: 6000, autoSelectedStreamId: 'stream-1',
    audioTracks: [{ streamId: 'stream-1', ordinal: 1, isDefault: true, language: 'en' }, { streamId: 'stream-2', ordinal: 2, isDefault: false, language: 'ja' }] };
}
function selected(...inputs: LocalSubtitleAuthorizedMedia[]): TranscriptionMediaSelection {
  return { items: inputs.map(input => ({ displayName: input.displayName, ok: true, media: input, probe: probe(input) })) };
}
function resources(): TranscriptionResources {
  return { resources: [
    { resourceId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id, resourceType: 'model', displayName: 'Whisper model', status: 'ready', byteSize: 100,
      isDefault: true, compatibleBackends: ['cpu', 'cuda', 'metal'] },
    { resourceId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id, resourceType: 'vad', displayName: 'VAD', status: 'ready', byteSize: 100,
      isDefault: true, compatibleBackends: ['cpu', 'cuda', 'metal'] },
    { resourceId: 'cuda-pack', resourceType: 'accelerator', displayName: 'CUDA', status: 'ready', byteSize: 100,
      isDefault: false, compatibleBackends: ['cuda'] },
  ], jobs: [] };
}
function fixture(sharedResources?: import('../../src/speech-resources/events').SpeechResourcesNotifications, options: import('../../src/services/subtitle-studio/transcription-controller').StudioTranscriptionControllerOptions = {}) {
  const api = {
    selectTranscriptionMedia: vi.fn<SubtitleStudioApi['selectTranscriptionMedia']>().mockResolvedValue(ok(null)),
    dropTranscriptionMedia: vi.fn<SubtitleStudioApi['dropTranscriptionMedia']>().mockResolvedValue(ok({ items: [] })),
    probeTranscriptionMedia: vi.fn<SubtitleStudioApi['probeTranscriptionMedia']>().mockResolvedValue(ok(probe())),
    revokeTranscriptionMedia: vi.fn<SubtitleStudioApi['revokeTranscriptionMedia']>().mockResolvedValue(ok({ revoked: true })),
    inspectTranscriptionRuntime: vi.fn<SubtitleStudioApi['inspectTranscriptionRuntime']>().mockResolvedValue(ok({ status: 'verified', runtimeGeneration: 'a'.repeat(64), target: { platform: 'win32', arch: 'x64' } })),
    listTranscriptionResources: vi.fn<SubtitleStudioApi['listTranscriptionResources']>().mockResolvedValue(ok(resources())),
    listTranscriptionTasks: vi.fn<SubtitleStudioApi['listTranscriptionTasks']>().mockResolvedValue(ok([])),
    enqueueTranscription: vi.fn<SubtitleStudioApi['enqueueTranscription']>().mockResolvedValue(ok({ batchId: task().batchId, tasks: [task()] })),
    cancelTranscriptionTask: vi.fn<SubtitleStudioApi['cancelTranscriptionTask']>().mockResolvedValue(ok(task(undefined, 'cancelled'))),
    removeTranscriptionTask: vi.fn<SubtitleStudioApi['removeTranscriptionTask']>().mockResolvedValue(ok(null)),
    importTranscriptionModel: vi.fn<SubtitleStudioApi['importTranscriptionModel']>().mockResolvedValue(ok(null)),
    deleteTranscriptionResource: vi.fn<SubtitleStudioApi['deleteTranscriptionResource']>().mockResolvedValue(ok({ deleted: true })),
    installTranscriptionResource: vi.fn<SubtitleStudioApi['installTranscriptionResource']>().mockResolvedValue(ok({ jobId: 'job-1', resourceId: 'cuda-pack', resourceType: 'accelerator',
      status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
    cancelTranscriptionResourceJob: vi.fn<SubtitleStudioApi['cancelTranscriptionResourceJob']>().mockResolvedValue(ok({ cancelled: true })),
  };
  const controller = createStudioTranscriptionController({ getApi: () => api, sharedResources, cleanupRetryDelaysMs: [100, 200], cleanupAttemptTimeoutMs: 500, ...options });
  controllers.push(controller);
  const choose = async (...inputs: LocalSubtitleAuthorizedMedia[]) => { api.selectTranscriptionMedia.mockResolvedValueOnce(ok(selected(...inputs))); await controller.selectMedia(); };
  return { controller, api, choose };
}

it('captures native dropped Files synchronously before initialization and shares selection ownership', async () => {
  const f = fixture(), pending = deferred<StudioResult<TranscriptionMediaSelection>>();
  f.api.dropTranscriptionMedia.mockReturnValueOnce(pending.promise);
  const files = [{ name: 'native.wav' }] as File[];
  const dropped = f.controller.dropMedia(files);
  expect(f.api.dropTranscriptionMedia).toHaveBeenCalledWith(files);
  expect(f.api.listTranscriptionTasks).not.toHaveBeenCalled();
  expect(f.controller.selectMedia()).toBe(dropped); expect(f.api.selectTranscriptionMedia).not.toHaveBeenCalled();
  pending.resolve(ok(selected(media()))); await dropped;
  expect(f.controller.getState().drafts[0].status).toBe('ready');
  await f.controller.dropMedia(Array.from({ length: 21 }, () => files[0]));
  expect(f.api.dropTranscriptionMedia).toHaveBeenCalledOnce(); expect(f.controller.getState().error).toBe('limit_exceeded');
});
it('hydrates transcription config before the first snapshot and saves no transient authority', async () => {
  const saved = structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES); saved.config.language = 'ja'; saved.config.advanced.beamSize = 8;
  const write = vi.fn(); const f = fixture(undefined, { preferences: { read: () => saved, write } });
  expect(f.controller.getState().config).toEqual(saved.config);
  await f.choose(media()); f.controller.setConfig({ ...saved.config, language: 'en' });
  expect(write).toHaveBeenLastCalledWith({ ...saved, config: { ...saved.config, language: 'en' } });
  expect(JSON.stringify(write.mock.calls)).not.toContain('ls-input');
  expect(JSON.stringify(write.mock.calls)).not.toContain('drafts');
});
it('omits default-off automatic translation and freezes enabled model configuration and credentials at submission', async () => {
  const automatic = { config: { model: { profileId: 'p', modelKey: 'deepseek-chat', endpoint: 'https://example.invalid/v1', apiFormat: 'chat_completions' as const, thinkingEnabled: true }, language: 'ja', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 32 }, apiKey: 'first-key' };
  const resolver = vi.fn(() => automatic);
  const f = fixture(undefined, { resolveAutomaticTranslation: resolver }); await f.choose(media());
  await f.controller.enqueue(); expect(f.api.enqueueTranscription.mock.calls[0][0]).not.toHaveProperty('autoTranslation'); expect(resolver).not.toHaveBeenCalled();
  await f.choose(media('2')); f.controller.setAutoTranslation({ ...DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation, enabled: true, profileId: 'p' });
  const pending = f.controller.enqueue(); automatic.apiKey = 'changed-key'; automatic.config.language = 'en'; await pending;
  expect(f.api.enqueueTranscription.mock.calls[1][0].autoTranslation).toMatchObject({ apiKey: 'first-key', config: { language: 'ja', model: { thinkingEnabled: true } } });
  expect(JSON.stringify(f.controller.getState())).not.toContain('first-key');
});
it('blocks missing automatic configuration before enqueue and allows disabling it without losing drafts', async () => {
  const f = fixture(undefined, { resolveAutomaticTranslation: () => null }); await f.choose(media());
  f.controller.setAutoTranslation({ ...DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation, enabled: true });
  expect(getTranscriptionReadiness(f.controller.getState()).reason).toBe('automatic_translation_not_ready');
  expect(await f.controller.enqueue()).toBeNull(); expect(f.api.enqueueTranscription).not.toHaveBeenCalled();
  f.controller.setAutoTranslation({ ...f.controller.getState().autoTranslation, enabled: false });
  expect(f.controller.getState().drafts).toHaveLength(1); expect(getTranscriptionReadiness(f.controller.getState()).canEnqueue).toBe(true);
});

it('keeps shared invalidation during a pending read and refreshes off-route without runtime probes', async () => {
  let changed!: (event: { revision: number }) => void;
  const unsubscribe = vi.fn();
  const status = { shared: true as const, revision: 0, busyResourceIds: [], migrationIssues: [], cleanupPending: false };
  const f = fixture({ onChanged: listener => { changed = listener; return unsubscribe; }, getStatus: vi.fn(async () => status) });
  await f.controller.start();
  const pending = deferred<StudioResult<TranscriptionResources>>();
  f.api.listTranscriptionResources.mockReturnValueOnce(pending.promise);
  changed({ revision: 1 }); await tick();
  changed({ revision: 2 });
  const next = resources(); next.resources[0].status = 'not_installed'; next.shared = { ...status, revision: 2 };
  f.api.listTranscriptionResources.mockResolvedValue(ok(next));
  pending.resolve(ok(resources())); await tick(); await vi.advanceTimersByTimeAsync(2); await tick();
  expect(f.controller.getState().resources[0].status).toBe('not_installed');
  expect(f.api.inspectTranscriptionRuntime).toHaveBeenCalledOnce();
  expect(f.api.listTranscriptionResources).toHaveBeenCalledTimes(3);
  changed({ revision: 1 }); await tick(); expect(f.api.listTranscriptionResources).toHaveBeenCalledTimes(3);
  f.controller.dispose(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it('reads shared occupancy without catalog hashing and prevents busy delete/import/install', async () => {
  const id = LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id;
  const status = { shared: true as const, revision: 1, busyResourceIds: [id], migrationIssues: [], cleanupPending: false };
  const getStatus = vi.fn(async () => status);
  const f = fixture({ onChanged: () => () => {}, getStatus });
  await f.controller.start(); await f.controller.refreshSharedStatus();
  await f.controller.installResource(id); await f.controller.importModel(id);
  expect(await f.controller.deleteResource(id)).toBe(false);
  expect(f.api.installTranscriptionResource).not.toHaveBeenCalled(); expect(f.api.importTranscriptionModel).not.toHaveBeenCalled();
  expect(f.api.deleteTranscriptionResource).not.toHaveBeenCalled(); expect(f.controller.getState().error).toBe('resource_busy');
  expect(f.api.listTranscriptionResources).toHaveBeenCalledOnce(); expect(f.api.inspectTranscriptionRuntime).toHaveBeenCalledOnce();
  getStatus.mockResolvedValue({ ...status, busyResourceIds: [] }); await f.controller.refreshSharedStatus();
  f.api.deleteTranscriptionResource.mockResolvedValueOnce({ ok: false, error: 'resource_busy' });
  expect(await f.controller.deleteResource(id)).toBe(false); expect(f.controller.getState().error).toBe('resource_busy');
  await tick(); expect(await f.controller.deleteResource(id)).toBe(true);
  expect(f.api.deleteTranscriptionResource).toHaveBeenLastCalledWith({ resourceId: id });
});

it('initializes once, preserves drafts and config across SPA subscriptions, and refreshes idle viewed task state', async () => {
  const f = fixture(); const detach = f.controller.subscribe(vi.fn()); await f.controller.start();
  await f.choose(media()); f.controller.setConfig({ ...f.controller.getState().config, language: 'ja' });
  f.controller.setAudioStream('ls-input-1', 'stream-2'); detach();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.api.inspectTranscriptionRuntime).toHaveBeenCalledTimes(1);
  const before = f.api.listTranscriptionTasks.mock.calls.length;
  const detachAgain = f.controller.subscribe(vi.fn()); await tick();
  expect(f.controller.getState().drafts[0]!.audioStreamId).toBe('stream-2');
  expect(f.controller.getState().config.language).toBe('ja');
  f.api.listTranscriptionTasks.mockResolvedValue(ok([task(undefined, 'completed')]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.api.listTranscriptionTasks.mock.calls.length).toBeGreaterThan(before);
  expect(f.controller.getState().tasks[0]!.status).toBe('completed'); expect(f.api.inspectTranscriptionRuntime).toHaveBeenCalledTimes(1); detachAgain();
});

it('keeps active task polling without a view and skips manual runtime preflight until idle', async () => {
  const f = fixture(); f.api.listTranscriptionTasks.mockResolvedValue(ok([task()]));
  await f.controller.start(); expect(f.api.inspectTranscriptionRuntime).not.toHaveBeenCalled();
  await f.controller.refresh(); expect(f.api.inspectTranscriptionRuntime).not.toHaveBeenCalled();
  f.api.listTranscriptionTasks.mockResolvedValue(ok([task(undefined, 'completed')]));
  await vi.advanceTimersByTimeAsync(1000); expect(f.controller.getState().tasks[0]!.status).toBe('completed');
  const calls = f.api.listTranscriptionTasks.mock.calls.length; await vi.advanceTimersByTimeAsync(3000);
  expect(f.api.listTranscriptionTasks).toHaveBeenCalledTimes(calls);
  await f.controller.refresh(); expect(f.api.inspectTranscriptionRuntime).toHaveBeenCalledTimes(1);
});

it('deduplicates appended source selections while preserving existing audio choices and bounds draft count', async () => {
  const f = fixture(); await f.choose(...Array.from({ length: 20 }, (_, index) => media(String(index))));
  f.controller.setAudioStream('ls-input-0', 'stream-2');
  const duplicate = { ...media('new'), sourceKey: 'ls-source-0' };
  await f.choose(duplicate, media('excess')); await tick();
  expect(f.controller.getState().drafts).toHaveLength(20); expect(f.controller.getState().drafts[0]!.audioStreamId).toBe('stream-2');
  expect(f.controller.getState().error).toBe('limit_exceeded');
  expect(f.api.revokeTranscriptionMedia.mock.calls.map(([request]) => request.fileToken)).toEqual(['ls-input-new', 'ls-input-excess']);
});

it('retains failed revoke handles across navigation and accepts revoked:false on retry', async () => {
  const f = fixture(); f.api.revokeTranscriptionMedia.mockResolvedValueOnce({ ok: false, error: 'access_denied' }).mockResolvedValueOnce(ok({ revoked: false }));
  const detach = f.controller.subscribe(vi.fn()); await f.choose(media());
  f.controller.removeDraft('ls-input-1'); detach(); await tick();
  expect(f.controller.getState().drafts).toEqual([]); expect(f.controller.getState().cleanupPendingCount).toBe(1);
  await vi.advanceTimersByTimeAsync(100); expect(f.controller.getState().cleanupPendingCount).toBe(0);
  expect(f.api.revokeTranscriptionMedia).toHaveBeenCalledTimes(2);
});

it('bounds cleanup retries and drops authority at its expiry even after repeated transport rejection', async () => {
  const f = fixture(); f.api.revokeTranscriptionMedia.mockRejectedValue(new Error('IPC failed'));
  await f.choose(media('1', Date.now() + 1000)); f.controller.removeDraft('ls-input-1'); await tick();
  await vi.advanceTimersByTimeAsync(999); expect(f.controller.getState().cleanupPendingCount).toBe(1);
  expect(f.api.revokeTranscriptionMedia).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); expect(f.controller.getState().cleanupPendingCount).toBe(0);
});

it('times out a hung revoke and retries without losing its handle', async () => {
  const f = fixture(); f.api.revokeTranscriptionMedia.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(ok({ revoked: false }));
  await f.choose(media()); f.controller.removeDraft('ls-input-1'); await tick();
  await vi.advanceTimersByTimeAsync(600); expect(f.api.revokeTranscriptionMedia).toHaveBeenCalledTimes(2);
  expect(f.controller.getState().cleanupPendingCount).toBe(0);
});

it('retries failed probes and ignores a late probe response after its draft is removed', async () => {
  const f = fixture(), input = media();
  f.api.selectTranscriptionMedia.mockResolvedValueOnce(ok({ items: [{ displayName: input.displayName, ok: false, error: 'transcription_failed', media: input }] }));
  await f.controller.selectMedia(); await f.controller.retryProbe(input.fileToken);
  expect(f.controller.getState().drafts[0]!.status).toBe('ready');
  const pending = deferred<StudioResult<LocalSubtitleMediaProbeSummary>>(); f.api.probeTranscriptionMedia.mockReturnValueOnce(pending.promise);
  const retried = f.controller.retryProbe(input.fileToken); f.controller.removeDraft(input.fileToken);
  pending.resolve(ok(probe(input))); await retried;
  expect(f.controller.getState().drafts).toEqual([]); expect(f.api.revokeTranscriptionMedia).toHaveBeenCalledTimes(1);
});

it('prevents duplicate enqueue, freezes captured choices, then revokes consumed draft capabilities', async () => {
  const f = fixture(), pending = deferred<Awaited<ReturnType<SubtitleStudioApi['enqueueTranscription']>>>();
  await f.choose(media()); f.api.enqueueTranscription.mockReturnValueOnce(pending.promise);
  const first = f.controller.enqueue(), second = f.controller.enqueue(); expect(first).toBe(second);
  await tick(); expect(f.api.enqueueTranscription).toHaveBeenCalledTimes(1);
  f.controller.setConfig({ ...f.controller.getState().config, language: 'ja' });
  expect(f.api.enqueueTranscription.mock.calls[0]![0].config.language).toBe('auto');
  f.api.listTranscriptionTasks.mockResolvedValue(ok([task()])); pending.resolve(ok({ batchId: task().batchId, tasks: [task()] })); await first; await tick();
  expect(f.controller.getState().drafts).toEqual([]); expect(f.controller.getState().tasks).toHaveLength(1);
  expect(f.api.revokeTranscriptionMedia).toHaveBeenCalledWith({ fileToken: 'ls-input-1' });
});

it('restores editable drafts on definite enqueue rejection but blocks retries after uncertain transport failure', async () => {
  const f = fixture(); await f.choose(media());
  f.api.enqueueTranscription.mockResolvedValueOnce({ ok: false, error: 'needs_configuration' });
  await f.controller.enqueue(); expect(f.controller.getState().drafts[0]!.status).toBe('ready');
  f.api.enqueueTranscription.mockRejectedValueOnce(new Error('response lost'));
  await f.controller.enqueue(); expect(f.controller.getState().drafts[0]!.status).toBe('submission_unknown');
  expect(getTranscriptionReadiness(f.controller.getState()).reason).toBe('uncertain_submission');
  await f.controller.enqueue(); expect(f.api.enqueueTranscription).toHaveBeenCalledTimes(2);
  expect(f.api.revokeTranscriptionMedia).not.toHaveBeenCalled();
});

it('rejects stale task polls across successful removal and refreshes a current snapshot', async () => {
  const f = fixture(); f.api.listTranscriptionTasks.mockResolvedValue(ok([task(undefined, 'completed')])); await f.controller.start();
  const stale = deferred<Awaited<ReturnType<SubtitleStudioApi['listTranscriptionTasks']>>>(); f.api.listTranscriptionTasks.mockReturnValueOnce(stale.promise);
  const detach = f.controller.subscribe(vi.fn()); await tick();
  await f.controller.removeTask(task().taskId); f.api.listTranscriptionTasks.mockResolvedValue(ok([]));
  stale.resolve(ok([task(undefined, 'completed')])); await tick(); await vi.advanceTimersByTimeAsync(1);
  expect(f.controller.getState().tasks).toEqual([]); detach();
});

it('keeps cancelling state until a terminal poll and catches failed cancellation', async () => {
  const f = fixture(); f.api.listTranscriptionTasks.mockResolvedValue(ok([task()])); await f.controller.start();
  f.api.cancelTranscriptionTask.mockResolvedValueOnce(ok(task(undefined, 'transcribing')));
  await f.controller.cancelTask(task().taskId); await tick(); expect(f.controller.getState().cancellingTaskIds).toEqual([task().taskId]);
  f.api.listTranscriptionTasks.mockResolvedValue(ok([task(undefined, 'cancelled')])); await vi.advanceTimersByTimeAsync(1000);
  expect(f.controller.getState().cancellingTaskIds).toEqual([]);
  f.api.cancelTranscriptionTask.mockRejectedValueOnce(new Error('private failure')); await f.controller.cancelTask(task().taskId);
  expect(f.controller.getState().error).toBe('transcription_failed'); expect(f.controller.getState().taskActions).toEqual([]);
});

it('polls installation jobs until terminal and does not poll resources for task progress alone', async () => {
  const f = fixture(); await f.controller.start();
  const activeJob = { jobId: 'job-1', resourceId: 'cuda-pack', resourceType: 'accelerator' as const, status: 'acquiring' as const,
    progress: 30, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  f.api.listTranscriptionResources.mockResolvedValue(ok({ ...resources(), jobs: [activeJob] }));
  await f.controller.installResource('cuda-pack'); await tick();
  const calls = f.api.listTranscriptionResources.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000); expect(f.api.listTranscriptionResources.mock.calls.length).toBeGreaterThan(calls);
  f.api.listTranscriptionResources.mockResolvedValue(ok({ ...resources(), jobs: [{ ...activeJob, status: 'completed' }] }));
  await vi.advanceTimersByTimeAsync(2000); const finished = f.api.listTranscriptionResources.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000); expect(f.api.listTranscriptionResources).toHaveBeenCalledTimes(finished);
});

it('uses catalog fallback only for the initial untouched default and verifies model/VAD/CUDA readiness', async () => {
  const f = fixture(); const catalog = resources(); catalog.resources[0] = { ...catalog.resources[0]!, resourceId: 'fixture-model' };
  f.api.listTranscriptionResources.mockResolvedValue(ok(catalog)); await f.choose(media());
  expect(f.controller.getState().config.modelId).toBe('fixture-model'); expect(getTranscriptionReadiness(f.controller.getState()).canEnqueue).toBe(true);
  f.controller.setConfig({ ...f.controller.getState().config, modelId: 'absent-model' }); await f.controller.refresh();
  expect(f.controller.getState().config.modelId).toBe('absent-model'); expect(getTranscriptionReadiness(f.controller.getState()).reason).toBe('model_not_ready');
  f.controller.setConfig({ ...f.controller.getState().config, modelId: 'fixture-model', devicePreference: 'cuda' });
  catalog.resources[2] = { ...catalog.resources[2]!, status: 'not_installed' }; await f.controller.refresh();
  expect(getTranscriptionReadiness(f.controller.getState()).reason).toBe('accelerator_not_ready');
  catalog.resources[1] = { ...catalog.resources[1]!, status: 'not_installed' }; await f.controller.refresh();
  expect(getTranscriptionReadiness(f.controller.getState()).reason).toBe('vad_not_ready');
});

it('marks expired drafts without sending enqueue or probe requests', async () => {
  const f = fixture(); await f.choose(media('1', Date.now() + 100));
  await vi.advanceTimersByTimeAsync(100); expect(f.controller.getState().drafts[0]!.status).toBe('expired');
  await f.controller.enqueue(); await f.controller.retryProbe('ls-input-1');
  expect(f.api.enqueueTranscription).not.toHaveBeenCalled(); expect(f.api.probeTranscriptionMedia).not.toHaveBeenCalled();
});

it('publishes shared startup/refresh promises before observers can synchronously reenter them', async () => {
  const f = fixture(); let nestedStart: Promise<void> | undefined, nestedRefresh: Promise<void> | undefined;
  const detach = f.controller.subscribe(() => {
    if (f.controller.getState().phase === 'loading') nestedStart = f.controller.start();
    if (f.controller.getState().refreshing) nestedRefresh = f.controller.refresh();
  });
  const started = f.controller.start(); expect(nestedStart).toBe(started); await started;
  const refreshed = f.controller.refresh(); expect(nestedRefresh).toBe(refreshed); await refreshed;
  expect(f.api.inspectTranscriptionRuntime).toHaveBeenCalledTimes(2); detach();
});

it('ignores invalid audio selection and configuration while preserving accepted choices', async () => {
  const f = fixture(); await f.choose(media());
  f.controller.setAudioStream('ls-input-1', 'not-returned-by-main');
  expect(f.controller.getState().drafts[0]!.audioStreamId).toBe('stream-1'); expect(f.controller.getState().error).toBe('invalid_input');
  const config = f.controller.getState().config;
  f.controller.setConfig({ ...config, advanced: { ...config.advanced, beamSize: 99 } });
  expect(f.controller.getState().config).toBe(config); f.controller.clearError(); expect(f.controller.getState().error).toBeNull();
});

it('keeps all production inference defaults aligned with the inherited baseline without output settings', () => {
  const f = fixture(), actual = f.controller.getState().config, baseline = DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES;
  for (const key of ['modelId', 'devicePreference', 'language', 'vadEnabled', 'windowStrategy'] as const) expect(actual[key]).toBe(baseline[key]);
  for (const key of ['beamSize', 'temperature', 'vadMinSilenceMs', 'maxCueDurationMs', 'maxCueChars', 'maxLineChars'] as const)
    expect(actual.advanced[key]).toBe(baseline[key]);
  expect(actual.taskMode).toBe(DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_DRAFT_PREFERENCES.taskMode);
  expect(actual.advanced.initialPrompt ?? '').toBe(DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_DRAFT_PREFERENCES.initialPrompt);
  expect(actual).not.toHaveProperty('output'); expect(actual).not.toHaveProperty('postAction');
});

it('retains one row without revoking its authority if a malformed duplicate changes sourceKey but reuses its token', async () => {
  const f = fixture(); await f.choose(media());
  await f.choose({ ...media(), sourceKey: 'ls-source-other' });
  expect(f.controller.getState().drafts).toHaveLength(1); expect(f.api.revokeTranscriptionMedia).not.toHaveBeenCalled();
});

it('blocks automatic retry when a successful enqueue response cannot account for captured files', async () => {
  const f = fixture(); await f.choose(media());
  f.api.enqueueTranscription.mockResolvedValueOnce(ok({ batchId: task().batchId, tasks: [] }));
  await f.controller.enqueue(); expect(f.controller.getState().drafts[0]!.status).toBe('submission_unknown');
  await f.controller.enqueue(); expect(f.api.enqueueTranscription).toHaveBeenCalledTimes(1);
  expect(f.api.revokeTranscriptionMedia).not.toHaveBeenCalled();
});

it('does not let a stale resource snapshot erase a resource job just admitted by an install', async () => {
  const f = fixture(); await f.controller.start();
  const stale = deferred<Awaited<ReturnType<SubtitleStudioApi['listTranscriptionResources']>>>();
  f.api.listTranscriptionResources.mockReturnValueOnce(stale.promise);
  const refresh = f.controller.refresh(); await tick();
  const job = { jobId: 'job-fresh', resourceId: 'cuda-pack', resourceType: 'accelerator' as const,
    status: 'acquiring' as const, progress: 10, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  f.api.installTranscriptionResource.mockResolvedValueOnce(ok(job));
  await f.controller.installResource('cuda-pack');
  expect(f.controller.getState().resourceJobs.map(item => item.jobId)).toEqual(['job-fresh']);
  f.api.listTranscriptionResources.mockResolvedValue(ok({ ...resources(), jobs: [job] }));
  stale.resolve(ok(resources())); await refresh; await tick(); await vi.advanceTimersByTimeAsync(1);
  expect(f.controller.getState().resourceJobs.map(item => item.jobId)).toEqual(['job-fresh']);
});

it('does not reset an in-flight cleanup attempt when a view reattaches', async () => {
  const f = fixture(), pending = deferred<Awaited<ReturnType<SubtitleStudioApi['revokeTranscriptionMedia']>>>();
  f.api.revokeTranscriptionMedia.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok({ revoked: false }));
  await f.choose(media()); f.controller.removeDraft('ls-input-1'); await tick();
  const detach = f.controller.subscribe(vi.fn());
  pending.resolve({ ok: false, error: 'transcription_failed' }); await tick();
  await vi.advanceTimersByTimeAsync(100); expect(f.api.revokeTranscriptionMedia).toHaveBeenCalledTimes(2);
  expect(f.controller.getState().cleanupPendingCount).toBe(0); detach();
});
