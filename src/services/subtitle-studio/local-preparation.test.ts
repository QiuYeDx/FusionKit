import { describe, expect, it, vi } from 'vitest';
import type { LocalSubtitleManagedResourceSummary } from '../../subtitle-studio/transcription/ipc-contract';
import type { TranscriptionResourceJob } from '../../subtitle-studio/ipc-contract';
import { DEFAULT_STUDIO_TRANSCRIPTION_CONFIG } from '../../subtitle-studio/transcription/preferences-contract';
import { LocalPreparation, preparationPlan, preparationTargets } from './local-preparation';
import type { StudioTranscriptionState } from './transcription-controller';

const MODEL = 'large-v3-q5_0', BEST = 'large-v3', VAD = 'silero-vad-v6.2.0-ggml', CUDA = 'speech-windows-x64-cuda-12.4-v1';
const MB = 1024 * 1024;
function catalog(ready: readonly string[] = []): LocalSubtitleManagedResourceSummary[] {
  const status = (id: string) => (ready.includes(id) ? 'ready' as const : 'not_installed' as const);
  return [
    { resourceId: MODEL, resourceType: 'model', displayName: MODEL, status: status(MODEL), byteSize: 1000 * MB, isDefault: true, compatibleBackends: ['cpu', 'cuda'] },
    { resourceId: BEST, resourceType: 'model', displayName: BEST, status: status(BEST), byteSize: 3000 * MB, isDefault: false, compatibleBackends: ['cpu', 'cuda'] },
    { resourceId: VAD, resourceType: 'vad', displayName: 'Silero VAD v6.2.0', status: status(VAD), byteSize: 1 * MB, isDefault: true, compatibleBackends: ['cpu'] },
    { resourceId: CUDA, resourceType: 'accelerator', displayName: 'CUDA 12.4 accelerator', status: status(CUDA), byteSize: 600 * MB, isDefault: false, compatibleBackends: ['cuda'] },
  ];
}

/** The parts of the Studio controller one-click prepare uses, with controls for the downloads. */
function fakeController(resources: LocalSubtitleManagedResourceSummary[], options: { startFails?: string[]; startGate?: Promise<void> } = {}) {
  let sequence = 0;
  let state = { resources, resourceJobs: [] as TranscriptionResourceJob[], config: { ...DEFAULT_STUDIO_TRANSCRIPTION_CONFIG, modelId: BEST },
    submitting: false, error: null } as unknown as StudioTranscriptionState;
  const listeners = new Set<() => void>();
  const emit = (change: Partial<StudioTranscriptionState>) => { state = { ...state, ...change }; for (const listener of [...listeners]) listener(); };
  const setJob = (resourceId: string, change: Partial<TranscriptionResourceJob>, resourceStatus?: LocalSubtitleManagedResourceSummary['status']) => emit({
    resourceJobs: state.resourceJobs.map(job => job.resourceId === resourceId && !['completed', 'failed', 'cancelled'].includes(job.status) ? { ...job, ...change } : job),
    ...(resourceStatus ? { resources: state.resources.map(resource => resource.resourceId === resourceId ? { ...resource, status: resourceStatus } : resource) } : {}),
  });
  const controller = {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: vi.fn(async () => {}),
    installResource: vi.fn(async (resourceId: string) => {
      await options.startGate;
      if (options.startFails?.includes(resourceId)) { emit({ error: 'resource_busy' }); return; }
      const now = new Date().toISOString();
      const resource = state.resources.find(item => item.resourceId === resourceId)!;
      emit({ resourceJobs: [...state.resourceJobs, { jobId: `job-${++sequence}`, resourceId, resourceType: resource.resourceType, status: 'acquiring', progress: 5, createdAt: now, updatedAt: now }],
        resources: state.resources.map(item => item.resourceId === resourceId ? { ...item, status: 'installing' } : item) });
    }),
    cancelResourceJob: vi.fn(async (jobId: string) => {
      const job = state.resourceJobs.find(item => item.jobId === jobId)!;
      setJob(job.resourceId, { status: 'cancelled' }, 'not_installed');
    }),
    setConfig: vi.fn((config: StudioTranscriptionState['config']) => emit({ config })),
    progress: (resourceId: string, progress: number) => setJob(resourceId, { status: 'acquiring', progress }),
    complete: (resourceId: string) => setJob(resourceId, { status: 'completed', progress: 100 }, 'ready'),
    fail: (resourceId: string, code: string) => setJob(resourceId, { status: 'failed', error: { code } as TranscriptionResourceJob['error'] }, 'not_installed'),
    listenerCount: () => listeners.size,
  };
  return controller;
}

async function settle() { for (let index = 0; index < 5; index++) await Promise.resolve(); }

describe('one-click prepare plan', () => {
  it('targets the catalog default model and voice detection, the model first (voice detection loads with it)', () => {
    expect(preparationTargets(catalog())).toMatchObject({ model: { resourceId: MODEL }, vad: { resourceId: VAD } });
    const plan = preparationPlan(catalog());
    expect(plan.missing.map(resource => resource.resourceId)).toEqual([MODEL, VAD]);
    expect(plan.missingBytes).toBe(1001 * MB);
    expect(plan.ready).toBe(false);
    expect(preparationPlan(catalog([VAD])).missing.map(resource => resource.resourceId)).toEqual([MODEL]);
    expect(preparationPlan(catalog([VAD, MODEL]))).toMatchObject({ ready: true, missingBytes: 0 });
    // Another ready model does not count; the catalog's default does.
    expect(preparationPlan(catalog([VAD, BEST])).ready).toBe(false);
    // Without the default flag the recommended id is used.
    expect(preparationTargets(catalog().map(resource => ({ ...resource, isDefault: false }))).model?.resourceId).toBe(MODEL);
    expect(preparationPlan([]).targets).toEqual([]);
  });
});

describe('LocalPreparation', () => {
  it('installs the model, then voice detection, reports weighted progress and selects the model', async () => {
    const controller = fakeController(catalog());
    const runtimeReady = vi.fn(async () => true);
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady });
    const done = preparation.start({ origin: 'wizard' });
    expect(preparation.getState()).toMatchObject({ phase: 'checking', origin: 'wizard', run: 1 });
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(MODEL));
    expect(runtimeReady).toHaveBeenCalledTimes(1);
    expect(preparation.getState().phase).toBe('installing');
    expect(controller.installResource).toHaveBeenCalledTimes(1);
    controller.progress(MODEL, 40);
    expect(preparation.getState().steps[0]).toMatchObject({ resourceId: MODEL, status: 'running', progress: 40 });
    // 40% of 1000 MB, out of 1001 MB.
    expect(preparation.getState().progress).toBeCloseTo((1000 * 40) / 1001, 5);
    controller.complete(MODEL);
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(VAD));
    controller.progress(VAD, 50);
    expect(preparation.getState().progress).toBeCloseTo((1000 * 100 + 1 * 50) / 1001, 5);
    controller.complete(VAD);
    const result = await done;
    expect(result).toMatchObject({ phase: 'completed', progress: 100 });
    expect(result.steps.map(step => [step.resourceId, step.status])).toEqual([[MODEL, 'done'], [VAD, 'done']]);
    expect(controller.setConfig).toHaveBeenCalledWith(expect.objectContaining({ modelId: MODEL }));
    expect(controller.listenerCount()).toBe(0);
  });

  it('stops before downloading when the VC++ runtime is missing, and continues when asked to', async () => {
    const controller = fakeController(catalog());
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady: async () => false });
    expect(await preparation.start()).toMatchObject({ phase: 'runtime_needed', steps: [] });
    expect(controller.installResource).not.toHaveBeenCalled();
    const resumed = preparation.start({ skipRuntimeCheck: true });
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(MODEL));
    controller.complete(MODEL);
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(VAD));
    controller.complete(VAD);
    expect((await resumed).phase).toBe('completed');
    expect(preparation.getState().run).toBe(2);
  });

  it('stops waiting for the runtime when dismissed, so a later repair does not start it', async () => {
    const controller = fakeController(catalog());
    let repaired = false;
    const listeners = new Set<() => void>();
    const preparation = new LocalPreparation({ controller: () => controller, runtimeReady: async () => repaired,
      runtimeChanges: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, runtimeRepaired: () => repaired });
    expect(await preparation.start()).toMatchObject({ phase: 'runtime_needed' });
    await preparation.cancel();
    expect(preparation.getState().phase).toBe('cancelled');
    repaired = true;
    for (const listener of listeners) listener();
    await settle();
    expect(controller.installResource).not.toHaveBeenCalled();
    expect(preparation.getState().phase).toBe('cancelled');
  });

  it('continues by itself once the runtime is repaired from any button', async () => {
    const controller = fakeController(catalog([VAD]));
    let repaired = false;
    const listeners = new Set<() => void>();
    const preparation = new LocalPreparation({ controller: () => controller, runtimeReady: async () => repaired,
      runtimeChanges: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, runtimeRepaired: () => repaired });
    expect(await preparation.start({ origin: 'wizard' })).toMatchObject({ phase: 'runtime_needed' });
    // A change that is not a repair leaves it waiting.
    for (const listener of listeners) listener();
    expect(preparation.getState().phase).toBe('runtime_needed');
    repaired = true;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(MODEL));
    expect(preparation.getState()).toMatchObject({ phase: 'installing', origin: 'wizard' });
    controller.complete(MODEL);
    await vi.waitFor(() => expect(preparation.getState().phase).toBe('completed'));
    preparation.dispose();
    expect(listeners.size).toBe(0);
  });

  it('finishes at once when everything is ready, without checking the runtime or changing a ready choice', async () => {
    const controller = fakeController(catalog([VAD, MODEL, BEST]));
    const runtimeReady = vi.fn(async () => true);
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady });
    expect(await preparation.start()).toMatchObject({ phase: 'completed', progress: 100 });
    expect(runtimeReady).not.toHaveBeenCalled();
    expect(controller.installResource).not.toHaveBeenCalled();
    expect(controller.setConfig).not.toHaveBeenCalled();
  });

  it('stops after a failed download, skipping voice detection, and reports the failure with its code', async () => {
    const controller = fakeController(catalog());
    const runtimeReady = vi.fn(async () => true);
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady });
    const done = preparation.start();
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(MODEL));
    controller.fail(MODEL, 'model_download_failed');
    const result = await done;
    expect(result.phase).toBe('failed');
    expect(result.steps).toMatchObject([{ resourceId: MODEL, status: 'failed', errorCode: 'model_download_failed' }, { resourceId: VAD, status: 'skipped' }]);
    expect(controller.installResource).toHaveBeenCalledTimes(1);
    // A network failure is not the runtime's: no second check.
    expect(runtimeReady).toHaveBeenCalledTimes(1);
    expect(controller.setConfig).not.toHaveBeenCalled();
  });

  it('waits for the runtime when a load check fails because it is missing, and downloads nothing more', async () => {
    const controller = fakeController(catalog());
    // Unreadable at first (so the run starts), missing when asked again after the crash.
    const answers = [true, false];
    const runtimeReady = vi.fn(async () => answers.shift() ?? false);
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady });
    const done = preparation.start();
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(MODEL));
    controller.fail(MODEL, 'runtime_crashed');
    expect(await done).toMatchObject({ phase: 'runtime_needed' });
    expect(runtimeReady).toHaveBeenCalledTimes(2);
    expect(controller.installResource).not.toHaveBeenCalledWith(VAD);

    // With the runtime in place the same kind of failure is reported as it is.
    const other = fakeController(catalog());
    const again = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => other, runtimeReady: async () => true });
    const finished = again.start();
    await vi.waitFor(() => expect(other.installResource).toHaveBeenCalledWith(MODEL));
    other.fail(MODEL, 'model_incompatible');
    expect(await finished).toMatchObject({ phase: 'failed', steps: [{ status: 'failed', errorCode: 'model_incompatible' }, { status: 'skipped' }] });
  });

  it('reports a download that could not start', async () => {
    const controller = fakeController(catalog([VAD]), { startFails: [MODEL] });
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady: async () => true });
    const result = await preparation.start();
    expect(result).toMatchObject({ phase: 'failed', steps: [{ resourceId: MODEL, status: 'failed', errorCode: 'resource_busy' }] });
  });

  it('joins a download already running and shares one run between callers', async () => {
    const controller = fakeController(catalog([MODEL]));
    await controller.installResource(VAD);
    controller.installResource.mockClear();
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady: async () => true });
    const first = preparation.start({ origin: 'studio' });
    const second = preparation.start({ origin: 'wizard' });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(preparation.getState().phase).toBe('installing'));
    controller.complete(VAD);
    expect((await first).phase).toBe('completed');
    expect(controller.installResource).not.toHaveBeenCalled();
    expect(preparation.getState().origin).toBe('studio');
  });

  it('cancels the download in progress and skips the rest', async () => {
    const controller = fakeController(catalog());
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady: async () => true });
    const done = preparation.start();
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(MODEL));
    await settle();
    await preparation.cancel();
    expect(controller.cancelResourceJob).toHaveBeenCalledWith('job-1');
    const result = await done;
    expect(result.phase).toBe('cancelled');
    expect(result.steps.map(step => step.status)).toEqual(['cancelled', 'cancelled']);
    expect(controller.installResource).toHaveBeenCalledTimes(1);
  });

  it('cancels a download that was still starting when cancel was pressed', async () => {
    let started!: () => void;
    const controller = fakeController(catalog(), { startGate: new Promise<void>(resolve => { started = resolve; }) });
    const preparation = new LocalPreparation({ runtimeChanges: () => () => {}, controller: () => controller, runtimeReady: async () => true });
    const done = preparation.start();
    await vi.waitFor(() => expect(controller.installResource).toHaveBeenCalledWith(MODEL));
    // No job exists yet, so there is nothing to cancel at this moment.
    await preparation.cancel();
    expect(controller.cancelResourceJob).not.toHaveBeenCalled();
    started();
    const result = await done;
    expect(controller.cancelResourceJob).toHaveBeenCalledWith('job-1');
    expect(result.phase).toBe('cancelled');
    expect(result.steps.map(step => step.status)).toEqual(['cancelled', 'cancelled']);
    expect(controller.installResource).toHaveBeenCalledTimes(1);
  });
});
