import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../subtitle-studio/transcription/domain';
import type { LocalSubtitleManagedResourceSummary } from '../../subtitle-studio/transcription/ipc-contract';
import type { TranscriptionResourceJob } from '../../subtitle-studio/ipc-contract';
import { getStudioTranscriptionController, type StudioTranscriptionController, type StudioTranscriptionState } from './transcription-controller';
import { getSystemSetupStore, vcRuntimeMayExplain } from '../system-setup/system-setup-store';

/**
 * "One-click prepare" for local transcription: installs the recommended model and then voice
 * detection through the Studio controller (the same downloads as the resource rows). On Windows
 * the VC++ runtime is checked first, so nobody downloads 1 GB that cannot load. The resource
 * manager and the welcome wizard share this one run; it continues in the background.
 */
export type LocalPreparationPhase = 'idle' | 'checking' | 'runtime_needed' | 'installing' | 'completed' | 'failed' | 'cancelled';
export type LocalPreparationOrigin = 'studio' | 'wizard';

export interface LocalPreparationStep {
  readonly resourceId: string;
  readonly kind: 'model' | 'vad';
  readonly byteSize: number;
  /** "skipped": not started because an earlier step failed (voice detection needs the model). */
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  /** 0–100 for this resource. */
  readonly progress: number;
  readonly errorCode?: string;
}

export interface LocalPreparationState {
  readonly phase: LocalPreparationPhase;
  readonly steps: readonly LocalPreparationStep[];
  /** 0–100 over all steps, weighted by size. */
  readonly progress: number;
  readonly origin?: LocalPreparationOrigin;
  /** Bumps on every run, so views can tell a new outcome from one they already reported. */
  readonly run: number;
}

type Resource = LocalSubtitleManagedResourceSummary;
type Controller = Pick<StudioTranscriptionController, 'getState' | 'subscribe' | 'start' | 'installResource' | 'cancelResourceJob' | 'setConfig'>;

const TERMINAL_JOB = new Set(['completed', 'failed', 'cancelled']);
export const RECOMMENDED_MODEL_ID = 'large-v3-q5_0';

/** The recommended model (the catalog's default) and voice detection, as listed now. */
export function preparationTargets(resources: readonly Resource[]): { model?: Resource; vad?: Resource } {
  const models = resources.filter(resource => resource.resourceType === 'model');
  return {
    model: models.find(resource => resource.isDefault) ?? models.find(resource => resource.resourceId === RECOMMENDED_MODEL_ID),
    vad: resources.find(resource => resource.resourceId === LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id),
  };
}

/**
 * What one-click prepare would still install: the model first, then voice detection, whose own load
 * check runs with the recommended model and so cannot install before it.
 */
export function preparationPlan(resources: readonly Resource[]) {
  const { model, vad } = preparationTargets(resources);
  const targets = [model, vad].filter((resource): resource is Resource => !!resource);
  const missing = targets.filter(resource => resource.status !== 'ready');
  return { targets, missing, missingBytes: missing.reduce((sum, resource) => sum + resource.byteSize, 0), ready: targets.length === 2 && !missing.length, model, vad };
}

function latestJob(state: StudioTranscriptionState, resourceId: string, exclude?: ReadonlySet<string>): TranscriptionResourceJob | undefined {
  return [...state.resourceJobs].reverse().find(job => job.resourceId === resourceId && !exclude?.has(job.jobId));
}

export interface LocalPreparationOptions {
  readonly controller?: () => Controller;
  /** False when the VC++ runtime is known to be missing or too old. */
  readonly runtimeReady?: () => Promise<boolean>;
  /**
   * Runtime state changes (a repair or a check from any button): a run waiting for the runtime
   * continues once `runtimeRepaired` says it is in place (the state is "ok", not merely unreadable).
   */
  readonly runtimeChanges?: (listener: () => void) => () => void;
  readonly runtimeRepaired?: () => boolean;
}

export class LocalPreparation {
  readonly #controller: () => Controller;
  readonly #runtimeReady: () => Promise<boolean>;
  readonly #listeners = new Set<() => void>();
  #state: LocalPreparationState = Object.freeze({ phase: 'idle', steps: [], progress: 0, run: 0 });
  #operation?: Promise<LocalPreparationState>;
  #cancelled = false;

  readonly #unsubscribeRuntime: () => void;

  constructor(options: LocalPreparationOptions = {}) {
    this.#controller = options.controller ?? getStudioTranscriptionController;
    this.#runtimeReady = options.runtimeReady ?? (() => getSystemSetupStore().vcRuntimeReady());
    const repaired = options.runtimeRepaired ?? (() => getSystemSetupStore().getSnapshot().vc?.status === 'ok');
    this.#unsubscribeRuntime = (options.runtimeChanges ?? getSystemSetupStore().subscribe)(() => {
      if (this.#state.phase === 'runtime_needed' && !this.#operation && repaired()) void this.start({ origin: this.#state.origin });
    });
  }

  getState = (): LocalPreparationState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  get busy(): boolean { return this.#state.phase === 'checking' || this.#state.phase === 'installing'; }

  #emit(change: Partial<LocalPreparationState>) {
    const next = { ...this.#state, ...change };
    const steps = next.steps;
    const total = steps.reduce((sum, step) => sum + step.byteSize, 0);
    const progress = total ? steps.reduce((sum, step) => sum + step.byteSize * (step.status === 'done' ? 100 : step.progress), 0) / total : next.phase === 'completed' ? 100 : 0;
    this.#state = Object.freeze({ ...next, steps: Object.freeze(steps.map(step => Object.freeze({ ...step }))), progress: Math.max(0, Math.min(100, progress)) });
    for (const listener of [...this.#listeners]) { try { listener(); } catch { /* A view cannot stop the run. */ } }
  }

  #updateStep(resourceId: string, change: Partial<LocalPreparationStep>) {
    this.#emit({ steps: this.#state.steps.map(step => step.resourceId === resourceId ? { ...step, ...change } : step) });
  }

  /**
   * Starts (or joins) a run. `skipRuntimeCheck` continues after the user chose to download anyway.
   * Resolves with the final state; never rejects.
   */
  start = (options: { origin?: LocalPreparationOrigin; skipRuntimeCheck?: boolean } = {}): Promise<LocalPreparationState> => {
    if (this.#operation) return this.#operation;
    this.#cancelled = false;
    this.#emit({ phase: 'checking', steps: [], origin: options.origin ?? this.#state.origin ?? 'studio', run: this.#state.run + 1 });
    this.#operation = this.#run(options.skipRuntimeCheck === true).catch(() => {
      this.#emit({ phase: 'failed' });
      return this.#state;
    }).finally(() => { this.#operation = undefined; });
    return this.#operation;
  };

  /** Stops after cancelling the download in progress; a run waiting for the runtime stops waiting. */
  cancel = async (): Promise<void> => {
    if (this.#state.phase === 'runtime_needed' && !this.#operation) { this.#emit({ phase: 'cancelled' }); return; }
    if (!this.busy) return;
    this.#cancelled = true;
    const controller = this.#controller();
    const running = this.#state.steps.find(step => step.status === 'running');
    const job = running && latestJob(controller.getState(), running.resourceId);
    if (job && !TERMINAL_JOB.has(job.status)) await controller.cancelResourceJob(job.jobId);
    if (this.#state.phase === 'checking') this.#emit({ phase: 'cancelled' });
  };

  async #run(skipRuntimeCheck: boolean): Promise<LocalPreparationState> {
    const controller = this.#controller();
    await controller.start();
    const plan = preparationPlan(controller.getState().resources);
    if (plan.targets.length < 2) { this.#emit({ phase: 'failed' }); return this.#state; }
    if (plan.ready) { this.#selectModel(controller, plan.model!); this.#emit({ phase: 'completed' }); return this.#state; }
    if (!skipRuntimeCheck && !(await this.#runtimeReady())) { this.#emit({ phase: 'runtime_needed' }); return this.#state; }
    if (this.#cancelled) { this.#emit({ phase: 'cancelled' }); return this.#state; }
    this.#emit({ phase: 'installing', steps: plan.missing.map(resource => ({ resourceId: resource.resourceId, kind: resource.resourceType === 'vad' ? 'vad' as const : 'model' as const,
      byteSize: resource.byteSize, status: 'pending' as const, progress: 0 })) });
    let failed: LocalPreparationStep | undefined;
    for (const step of this.#state.steps) {
      if (this.#cancelled) { this.#updateStep(step.resourceId, { status: 'cancelled' }); continue; }
      // Voice detection cannot install without the model, and nothing else is worth downloading after a failure.
      if (failed) { this.#updateStep(step.resourceId, { status: 'skipped' }); continue; }
      await this.#install(controller, step.resourceId);
      const result = this.#state.steps.find(item => item.resourceId === step.resourceId);
      if (result?.status === 'failed') failed = result;
    }
    const steps = this.#state.steps;
    const phase = steps.every(step => step.status === 'done') ? 'completed' : steps.some(step => step.status === 'cancelled') ? 'cancelled' : 'failed';
    if (phase === 'completed') this.#selectModel(controller, plan.model!);
    // A load check the VC++ runtime can explain asks Windows again: with it missing, the run waits for
    // the repair (and continues after it) instead of ending as a plain failure.
    if (phase === 'failed' && failed && vcRuntimeMayExplain(failed.errorCode) && !(await this.#runtimeReady())) {
      this.#emit({ phase: 'runtime_needed' });
      return this.#state;
    }
    this.#emit({ phase });
    return this.#state;
  }

  /** After preparing, transcription uses the recommended model unless the chosen one is ready. */
  #selectModel(controller: Controller, model: Resource) {
    const state = controller.getState();
    const chosen = state.resources.find(resource => resource.resourceType === 'model' && resource.resourceId === state.config.modelId);
    if (chosen?.status !== 'ready' && !state.submitting) controller.setConfig({ ...state.config, modelId: model.resourceId });
  }

  async #install(controller: Controller, resourceId: string): Promise<void> {
    this.#updateStep(resourceId, { status: 'running', progress: 0 });
    const current = () => controller.getState().resources.find(resource => resource.resourceId === resourceId);
    if (current()?.status === 'ready') { this.#updateStep(resourceId, { status: 'done', progress: 100 }); return; }
    // Join a download someone already started; otherwise start one and follow the new job.
    let job = latestJob(controller.getState(), resourceId);
    if (!job || TERMINAL_JOB.has(job.status)) {
      const before = new Set(controller.getState().resourceJobs.filter(item => item.resourceId === resourceId).map(item => item.jobId));
      await controller.installResource(resourceId);
      job = latestJob(controller.getState(), resourceId, before);
      if (!job) {
        if (current()?.status === 'ready') this.#updateStep(resourceId, { status: 'done', progress: 100 });
        else this.#updateStep(resourceId, { status: this.#cancelled ? 'cancelled' : 'failed', errorCode: controller.getState().error ?? 'transcription_failed' });
        return;
      }
      // Cancel was pressed while the download was being started, before its job was known.
      if (this.#cancelled && !TERMINAL_JOB.has(job.status)) await controller.cancelResourceJob(job.jobId);
    }
    const jobId = job.jobId;
    const outcome = await new Promise<LocalPreparationStep['status']>(resolve => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (status: LocalPreparationStep['status']) => { if (settled) return; settled = true; unsubscribe?.(); resolve(status); };
      const check = () => {
        if (settled) return;
        const state = controller.getState();
        const latest = state.resourceJobs.find(item => item.jobId === jobId);
        const resource = state.resources.find(item => item.resourceId === resourceId);
        if (latest && !TERMINAL_JOB.has(latest.status)) { this.#updateStep(resourceId, { progress: latest.progress }); return; }
        if (latest?.status === 'completed' || resource?.status === 'ready') { finish('done'); return; }
        if (latest?.status === 'cancelled') { finish('cancelled'); return; }
        if (latest?.status === 'failed') { this.#updateStep(resourceId, { errorCode: latest.error?.code }); finish('failed'); return; }
        // The job left the list without finishing (another window removed it): the resource state decides.
        if (!latest && resource && resource.status !== 'installing') finish(this.#cancelled ? 'cancelled' : 'failed');
      };
      unsubscribe = controller.subscribe(check);
      if (settled) unsubscribe();
      check();
    });
    this.#updateStep(resourceId, { status: outcome, ...(outcome === 'done' ? { progress: 100 } : {}) });
  }

  /** Test/application teardown only. */
  dispose = (): void => { this.#unsubscribeRuntime(); this.#listeners.clear(); };
}

let preparation: LocalPreparation | undefined;
export function getLocalPreparation(): LocalPreparation {
  return preparation ??= new LocalPreparation();
}
