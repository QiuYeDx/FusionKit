import { StudioError, type ErrorCode } from '../../subtitle-studio/domain';
import type { StudioResult, SubtitleStudioApi, TranscriptionResourceJob, TranscriptionResources,
  TranscriptionRuntimeSummary } from '../../subtitle-studio/ipc-contract';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../subtitle-studio/transcription/domain';
import { localSubtitleAuthorizedMediaSchema, localSubtitleMediaProbeSummarySchema, type LocalSubtitleAuthorizedMedia,
  type LocalSubtitleMediaProbeSummary, type LocalSubtitleManagedResourceSummary } from '../../subtitle-studio/transcription/ipc-contract';
import { enqueueTranscriptionRequestSchema, transcriptionTaskConfigSchema, transcriptionTaskSummarySchema,
  type EnqueueTranscriptionRequest, type TranscriptionBatchAdmission, type TranscriptionTaskSummary } from '../../subtitle-studio/transcription/task-contract';

type Config = EnqueueTranscriptionRequest['config'];
type Api = Pick<SubtitleStudioApi, 'selectTranscriptionMedia' | 'probeTranscriptionMedia' | 'revokeTranscriptionMedia'
  | 'inspectTranscriptionRuntime' | 'listTranscriptionResources' | 'importTranscriptionModel' | 'installTranscriptionResource'
  | 'cancelTranscriptionResourceJob' | 'enqueueTranscription' | 'listTranscriptionTasks' | 'cancelTranscriptionTask' | 'removeTranscriptionTask'>;
type Timer = () => void;
export interface StudioTranscriptionDraft {
  readonly id: string; readonly displayName: string;
  readonly media?: LocalSubtitleAuthorizedMedia; readonly probe?: LocalSubtitleMediaProbeSummary;
  readonly audioStreamId?: string;
  readonly status: 'ready' | 'error' | 'expired' | 'probing' | 'submitting' | 'submission_unknown';
  readonly error?: ErrorCode;
}
export interface StudioTranscriptionState {
  readonly phase: 'idle' | 'loading' | 'ready';
  readonly runtime: TranscriptionRuntimeSummary | null;
  readonly resources: readonly LocalSubtitleManagedResourceSummary[];
  readonly resourceJobs: readonly TranscriptionResourceJob[];
  readonly drafts: readonly StudioTranscriptionDraft[];
  readonly tasks: readonly TranscriptionTaskSummary[];
  readonly config: Config;
  readonly error: ErrorCode | null;
  readonly selecting: boolean; readonly submitting: boolean; readonly refreshing: boolean;
  readonly resourceActions: readonly string[]; readonly taskActions: readonly string[];
  readonly cancellingTaskIds: readonly string[]; readonly cleanupPendingCount: number;
}
export interface StudioTranscriptionControllerOptions {
  readonly getApi?: () => Api; readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => Timer;
  readonly taskPollIntervalMs?: number; readonly resourcePollIntervalMs?: number;
  readonly cleanupRetryDelaysMs?: readonly number[]; readonly cleanupAttemptTimeoutMs?: number;
}
export const DEFAULT_STUDIO_TRANSCRIPTION_CONFIG: Config = Object.freeze({
  modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id, devicePreference: 'auto', language: 'auto', taskMode: 'transcribe',
  vadEnabled: true, windowStrategy: 'acoustic_quiet_v1', advanced: Object.freeze({ beamSize: 5, temperature: 0,
    vadMinSilenceMs: 500, maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42 }),
});
const activeTask = (task: TranscriptionTaskSummary) => !['completed', 'failed', 'cancelled'].includes(task.status);
const activeResource = (job: TranscriptionResourceJob) => !['completed', 'failed', 'cancelled'].includes(job.status);
const asError = (error: unknown): ErrorCode => error instanceof StudioError ? error.code : 'transcription_failed';
const freezeConfig = (config: Config): Config => Object.freeze({ ...config, advanced: Object.freeze({ ...config.advanced }) });
async function unwrap<T>(operation: Promise<StudioResult<T>>): Promise<T> {
  const result = await operation;
  if (!result.ok) throw new StudioError(result.error);
  return result.value;
}
export type TranscriptionReadinessReason = 'busy' | 'uncertain_submission' | 'configuration_invalid' | 'runtime_not_ready'
  | 'model_not_ready' | 'vad_not_ready' | 'accelerator_not_ready' | 'no_media';
export function getTranscriptionReadiness(state: StudioTranscriptionState): { canEnqueue: boolean; readyCount: number; reason: TranscriptionReadinessReason | null } {
  const readyCount = state.drafts.filter(draft => draft.status === 'ready').length;
  const reason: TranscriptionReadinessReason | null = state.submitting || state.selecting ? 'busy'
    : state.drafts.some(draft => draft.status === 'submission_unknown') ? 'uncertain_submission'
      : !enqueueTranscriptionRequestSchema.safeParse({ files: [{ fileToken: 'validation-token' }], config: state.config }).success ? 'configuration_invalid'
        : state.runtime?.status !== 'verified' ? 'runtime_not_ready'
          : !state.resources.some(resource => resource.resourceType === 'model' && resource.resourceId === state.config.modelId && resource.status === 'ready') ? 'model_not_ready'
            : state.config.vadEnabled && !state.resources.some(resource => resource.resourceId === LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id && resource.status === 'ready') ? 'vad_not_ready'
              : state.config.devicePreference === 'cuda' && !state.resources.some(resource => resource.resourceType === 'accelerator' && resource.compatibleBackends.includes('cuda') && resource.status === 'ready') ? 'accelerator_not_ready'
                : !readyCount ? 'no_media' : null;
  return { canEnqueue: reason === null, readyCount, reason };
}
interface Revocation {
  readonly media: LocalSubtitleAuthorizedMedia; attempts: number; inFlight: boolean; timer?: Timer;
}

/** One renderer-session owner. Route subscribers are views, not capability or task owners. */
export class StudioTranscriptionController {
  private readonly api: () => Api;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => Timer;
  private readonly taskInterval: number;
  private readonly resourceInterval: number;
  private readonly retryDelays: readonly number[];
  private readonly revokeTimeout: number;
  private readonly subscribers = new Set<() => void>();
  private readonly revocations = new Map<string, Revocation>();
  private readonly resourceActions = new Set<string>();
  private readonly taskActions = new Set<string>();
  private readonly cancelling = new Set<string>();
  private readonly probing = new Map<string, object>();
  private state: StudioTranscriptionState = Object.freeze({ phase: 'idle', runtime: null, resources: [], resourceJobs: [], drafts: [], tasks: [],
    config: DEFAULT_STUDIO_TRANSCRIPTION_CONFIG, error: null, selecting: false, submitting: false, refreshing: false,
    resourceActions: [], taskActions: [], cancellingTaskIds: [], cleanupPendingCount: 0 });
  private startOperation?: Promise<void>;
  private refreshOperation?: Promise<void>;
  private taskRead?: Promise<void>;
  private resourceRead?: Promise<void>;
  private selection?: Promise<void>;
  private enqueueOperation?: Promise<TranscriptionBatchAdmission | null>;
  private taskVersion = 0;
  private resourceVersion = 0;
  private taskDirty = false;
  private resourceDirty = false;
  private nextTasksAt = 0;
  private nextResourcesAt = 0;
  private pollTimer?: Timer;
  private draftSequence = 0;
  private disposed = false;
  private configTouched = false;
  private receivedResources = false;

  constructor(options: StudioTranscriptionControllerOptions = {}) {
    this.api = options.getApi ?? (() => window.subtitleStudio);
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
    this.taskInterval = options.taskPollIntervalMs ?? 1000;
    this.resourceInterval = options.resourcePollIntervalMs ?? 2000;
    this.retryDelays = options.cleanupRetryDelaysMs ?? [250, 1000, 5000, 15000, 60000];
    this.revokeTimeout = options.cleanupAttemptTimeoutMs ?? 5000;
  }
  getState = (): StudioTranscriptionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    if (!this.startOperation) void this.start();
    else if (this.state.phase === 'ready') void this.readTasks();
    this.armPoll(); this.retryCleanup();
    return () => { this.subscribers.delete(listener); this.armPoll(); };
  };
  private emit(change: Partial<StudioTranscriptionState> = {}) {
    if (this.disposed) return;
    this.state = Object.freeze({ ...this.state, ...change,
      resourceActions: Object.freeze([...this.resourceActions]), taskActions: Object.freeze([...this.taskActions]),
      cancellingTaskIds: Object.freeze([...this.cancelling]), cleanupPendingCount: this.revocations.size });
    for (const listener of [...this.subscribers]) { try { listener(); } catch { /* View observers cannot interrupt capability bookkeeping. */ } }
  }
  clearError = () => { this.emit({ error: null }); };
  start = (): Promise<void> => {
    if (this.startOperation) return this.startOperation;
    this.startOperation = Promise.resolve().then(async () => {
      await this.readTasks();
      await Promise.allSettled([this.readResources(), this.state.tasks.some(activeTask) ? Promise.resolve() : this.readRuntime()]);
      this.expireDrafts(); this.emit({ phase: 'ready' }); this.armPoll();
    }).catch(error => { this.emit({ phase: 'ready', error: asError(error) }); });
    this.emit({ phase: 'loading' });
    return this.startOperation;
  };
  refresh = (): Promise<void> => {
    if (this.refreshOperation) return this.refreshOperation;
    if (!this.startOperation) return this.start();
    this.refreshOperation = Promise.resolve().then(async () => {
      await this.startOperation;
      await this.readTasks();
      await Promise.allSettled([this.readResources(), this.state.tasks.some(activeTask) || this.state.submitting ? Promise.resolve() : this.readRuntime()]);
      this.expireDrafts(); this.retryCleanup();
    }).catch(error => { this.emit({ error: asError(error) }); }).finally(() => {
      this.refreshOperation = undefined; this.emit({ refreshing: false }); this.armPoll();
    });
    this.emit({ refreshing: true, error: null });
    return this.refreshOperation;
  };
  private async readRuntime() {
    try { const runtime = await unwrap(this.api().inspectTranscriptionRuntime({})); this.emit({ runtime }); }
    catch (error) { this.emit({ error: asError(error) }); }
  }
  private readTasks(): Promise<void> {
    if (this.taskRead) return this.taskRead;
    if (this.taskActions.size || this.state.submitting) { this.taskDirty = true; return Promise.resolve(); }
    const version = this.taskVersion;
    this.taskDirty = false;
    this.taskRead = Promise.resolve().then(async () => {
      const raw = await unwrap(this.api().listTranscriptionTasks({}));
      const tasks = Object.freeze(raw.map(value => Object.freeze(transcriptionTaskSummarySchema.parse(value))));
      if (version !== this.taskVersion || this.taskActions.size || this.state.submitting) { this.taskDirty = true; return; }
      for (const id of this.cancelling) if (!tasks.some(task => task.taskId === id && activeTask(task))) this.cancelling.delete(id);
      this.emit({ tasks });
    }).catch(error => { this.emit({ error: asError(error) }); }).finally(() => {
      this.taskRead = undefined;
      this.nextTasksAt = this.now() + (this.state.tasks.some(activeTask) ? this.taskInterval : Math.max(this.taskInterval, 2000));
      if (this.taskDirty && !this.taskActions.size && !this.state.submitting) { this.nextTasksAt = this.now(); }
      this.armPoll();
    });
    return this.taskRead;
  }
  private readResources(): Promise<void> {
    if (this.resourceRead) return this.resourceRead;
    if (this.resourceActions.size) { this.resourceDirty = true; return Promise.resolve(); }
    const version = this.resourceVersion;
    this.resourceDirty = false;
    this.resourceRead = Promise.resolve().then(async () => {
      const result = await unwrap(this.api().listTranscriptionResources({}));
      if (version !== this.resourceVersion || this.resourceActions.size) { this.resourceDirty = true; return; }
      this.installResourceSnapshot(result);
    }).catch(error => { this.emit({ error: asError(error) }); }).finally(() => {
      this.resourceRead = undefined; this.nextResourcesAt = this.now() + this.resourceInterval;
      if (this.resourceDirty && !this.resourceActions.size) this.nextResourcesAt = this.now();
      this.armPoll();
    });
    return this.resourceRead;
  }
  private installResourceSnapshot(result: TranscriptionResources) {
    let config = this.state.config;
    if (!this.receivedResources && !this.configTouched && !result.resources.some(resource => resource.resourceType === 'model' && resource.resourceId === config.modelId)) {
      const model = result.resources.find(resource => resource.resourceType === 'model' && resource.isDefault)
        ?? result.resources.find(resource => resource.resourceType === 'model');
      if (model) config = freezeConfig({ ...config, modelId: model.resourceId });
    }
    this.receivedResources = true;
    this.emit({ resources: Object.freeze(result.resources.map(resource => Object.freeze({ ...resource }))),
      resourceJobs: Object.freeze(result.jobs.map(job => Object.freeze({ ...job }))), config });
  }
  private armPoll() {
    this.pollTimer?.(); this.pollTimer = undefined;
    if (this.disposed || this.state.phase !== 'ready') return;
    const due: number[] = [];
    if (!this.taskRead && !this.taskActions.size && !this.state.submitting
      && (this.subscribers.size || this.state.tasks.some(activeTask) || this.taskDirty || this.state.drafts.some(draft => draft.status === 'submission_unknown'))) due.push(this.nextTasksAt);
    if (!this.resourceRead && !this.resourceActions.size && (this.state.resourceJobs.some(activeResource) || this.resourceDirty)) due.push(this.nextResourcesAt);
    for (const draft of this.state.drafts) if (draft.media && ['ready', 'error'].includes(draft.status)) due.push(draft.media.expiresAt);
    if (!due.length) return;
    this.pollTimer = this.schedule(() => {
      this.pollTimer = undefined;
      this.expireDrafts();
      if (this.nextTasksAt <= this.now() && (this.subscribers.size || this.state.tasks.some(activeTask) || this.taskDirty
        || this.state.drafts.some(draft => draft.status === 'submission_unknown'))) void this.readTasks();
      if (this.nextResourcesAt <= this.now() && (this.state.resourceJobs.some(activeResource) || this.resourceDirty)) void this.readResources();
      this.armPoll();
    }, Math.max(1, Math.min(...due) - this.now()));
  }
  private expireDrafts() {
    let changed = false;
    const drafts = this.state.drafts.map(draft => {
      if (draft.media && draft.media.expiresAt <= this.now() && ['ready', 'error'].includes(draft.status)) {
        changed = true; return Object.freeze({ ...draft, status: 'expired' as const, error: 'access_denied' as const });
      }
      return draft;
    });
    if (changed) this.emit({ drafts: Object.freeze(drafts) });
  }
  setConfig = (value: Config): void => {
    const parsed = transcriptionTaskConfigSchema.safeParse(value);
    if (!parsed.success) { this.emit({ error: 'invalid_input' }); return; }
    this.configTouched = true;
    this.emit({ config: freezeConfig(parsed.data), error: null });
  };
  setAudioStream = (id: string, streamId: string): void => {
    const draft = this.state.drafts.find(row => row.id === id);
    if (!draft || draft.status !== 'ready' || !draft.probe?.audioTracks.some(track => track.streamId === streamId)) { this.emit({ error: 'invalid_input' }); return; }
    this.replaceDraft(id, { ...draft, audioStreamId: streamId });
  };
  selectMedia = (): Promise<void> => {
    if (this.selection) return this.selection;
    if (this.state.submitting || this.state.selecting) return Promise.resolve();
    this.emit({ selecting: true, error: null });
    this.selection = Promise.resolve().then(async () => {
      await this.start();
      const result = await unwrap(this.api().selectTranscriptionMedia({}));
      if (!result) return;
      const drafts = [...this.state.drafts];
      let exceeded = false;
      for (const item of result.items) {
        const media = item.media ? localSubtitleAuthorizedMediaSchema.parse(item.media) : undefined;
        if (this.disposed) { if (media) this.queueRevoke(media); continue; }
        // A repeated token is the existing authority; revoking it would invalidate the retained row.
        if (media && drafts.some(draft => draft.media?.fileToken === media.fileToken)) continue;
        if (media && drafts.some(draft => draft.media?.sourceKey === media.sourceKey)) { this.queueRevoke(media); continue; }
        if (drafts.length >= 20) { exceeded = true; if (media) this.queueRevoke(media); continue; }
        const probe = item.ok ? localSubtitleMediaProbeSummarySchema.parse(item.probe) : undefined;
        if (probe && probe.fileToken !== media?.fileToken) { if (media) this.queueRevoke(media); throw new StudioError('invalid_input'); }
        drafts.push(Object.freeze({ id: media?.fileToken ?? `selection-error-${++this.draftSequence}`, displayName: item.displayName,
          ...(media ? { media: Object.freeze(media) } : {}), ...(probe ? { probe: Object.freeze(probe), audioStreamId: probe.autoSelectedStreamId } : {}),
          status: item.ok ? 'ready' : 'error', ...(!item.ok ? { error: item.error } : {}) }));
      }
      this.emit({ drafts: Object.freeze(drafts), ...(exceeded ? { error: 'limit_exceeded' as const } : {}) }); this.expireDrafts();
    }).catch(error => { this.emit({ error: asError(error) }); }).finally(() => {
      this.selection = undefined; this.emit({ selecting: false }); this.armPoll();
    });
    return this.selection;
  };
  private replaceDraft(id: string, replacement: StudioTranscriptionDraft) {
    this.emit({ drafts: Object.freeze(this.state.drafts.map(draft => draft.id === id ? Object.freeze(replacement) : draft)) });
  }
  retryProbe = async (id: string): Promise<void> => {
    const draft = this.state.drafts.find(row => row.id === id);
    if (!draft?.media || this.probing.has(id) || ['submitting', 'submission_unknown'].includes(draft.status)) return;
    if (draft.media.expiresAt <= this.now()) { this.expireDrafts(); return; }
    const ticket = {}; this.probing.set(id, ticket); this.replaceDraft(id, { ...draft, status: 'probing', error: undefined });
    try {
      const probe = localSubtitleMediaProbeSummarySchema.parse(await unwrap(this.api().probeTranscriptionMedia({ fileToken: draft.media.fileToken })));
      if (probe.fileToken !== draft.media.fileToken) throw new StudioError('invalid_input');
      if (this.probing.get(id) !== ticket || !this.state.drafts.some(row => row.id === id)) return;
      const selection = probe.audioTracks.some(track => track.streamId === draft.audioStreamId) ? draft.audioStreamId! : probe.autoSelectedStreamId;
      this.replaceDraft(id, { ...draft, probe: Object.freeze(probe), audioStreamId: selection, status: 'ready', error: undefined });
      this.expireDrafts();
    } catch (error) {
      if (this.probing.get(id) === ticket && this.state.drafts.some(row => row.id === id)) this.replaceDraft(id, { ...draft, status: 'error', error: asError(error) });
    } finally { if (this.probing.get(id) === ticket) this.probing.delete(id); this.armPoll(); }
  };
  removeDraft = (id: string): void => {
    const draft = this.state.drafts.find(row => row.id === id);
    if (!draft || draft.status === 'submitting') return;
    if (draft.media) this.queueRevoke(draft.media);
    this.probing.delete(id);
    this.emit({ drafts: Object.freeze(this.state.drafts.filter(row => row.id !== id)) }); this.armPoll();
  };
  clearDrafts = (): void => { for (const draft of this.state.drafts) this.removeDraft(draft.id); };
  enqueue = (): Promise<TranscriptionBatchAdmission | null> => {
    if (this.enqueueOperation) return this.enqueueOperation;
    this.expireDrafts();
    if (!getTranscriptionReadiness(this.state).canEnqueue) return Promise.resolve(null);
    const drafts = this.state.drafts.filter(draft => draft.status === 'ready' && draft.media && draft.probe);
    const ids = new Set(drafts.map(draft => draft.id));
    const request = enqueueTranscriptionRequestSchema.parse({ files: drafts.map(draft => ({ fileToken: draft.media!.fileToken, audioStreamId: draft.audioStreamId })), config: this.state.config });
    this.taskVersion++; this.emit({ submitting: true, error: null, drafts: Object.freeze(this.state.drafts.map(draft => ids.has(draft.id) ? Object.freeze({ ...draft, status: 'submitting' as const }) : draft)) });
    this.enqueueOperation = Promise.resolve().then(async () => {
      let response: Awaited<ReturnType<Api['enqueueTranscription']>>;
      try { response = await this.api().enqueueTranscription(request); }
      catch {
        this.emit({ error: 'transcription_failed', drafts: Object.freeze(this.state.drafts.map(draft => ids.has(draft.id)
          ? Object.freeze({ ...draft, status: 'submission_unknown' as const, error: 'transcription_failed' as const }) : draft)) });
        return null;
      }
      if (!response.ok) {
        this.emit({ error: response.error, drafts: Object.freeze(this.state.drafts.map(draft => ids.has(draft.id)
          ? Object.freeze({ ...draft, status: 'ready' as const }) : draft)) });
        return null;
      }
      const admission = response.value;
      const tasks = admission.tasks.map(task => Object.freeze(transcriptionTaskSummarySchema.parse(task)));
      if (tasks.length !== drafts.length || new Set(tasks.map(task => task.taskId)).size !== tasks.length
        || tasks.some(task => task.batchId !== admission.batchId)) throw new StudioError('invalid_input');
      const merged = new Map(this.state.tasks.map(task => [task.taskId, task]));
      for (const task of tasks) merged.set(task.taskId, task);
      for (const draft of drafts) this.queueRevoke(draft.media!);
      this.emit({ tasks: Object.freeze([...merged.values()]), drafts: Object.freeze(this.state.drafts.filter(draft => !ids.has(draft.id))) });
      return admission;
    }).catch(error => {
      // A malformed successful response is also ambiguous: never automatically send it twice.
      this.emit({ error: asError(error), drafts: Object.freeze(this.state.drafts.map(draft => ids.has(draft.id)
        ? Object.freeze({ ...draft, status: 'submission_unknown' as const }) : draft)) });
      return null;
    }).finally(() => {
      this.enqueueOperation = undefined; this.taskVersion++; this.taskDirty = true; this.emit({ submitting: false });
      this.expireDrafts(); void this.readTasks(); this.armPoll();
    });
    return this.enqueueOperation;
  };
  cancelTask = (taskId: string): Promise<void> => this.mutateTask(taskId, async () => {
    this.cancelling.add(taskId); this.emit();
    try {
      const task = transcriptionTaskSummarySchema.parse(await unwrap(this.api().cancelTranscriptionTask({ taskId })));
      if (!activeTask(task)) this.cancelling.delete(taskId);
      this.emit({ tasks: Object.freeze(this.state.tasks.map(current => current.taskId === taskId ? Object.freeze(task) : current)) });
    } catch (error) { this.cancelling.delete(taskId); throw error; }
  });
  removeTask = (taskId: string): Promise<void> => this.mutateTask(taskId, async () => {
    await unwrap(this.api().removeTranscriptionTask({ taskId })); this.cancelling.delete(taskId);
    this.emit({ tasks: Object.freeze(this.state.tasks.filter(task => task.taskId !== taskId)) });
  });
  private async mutateTask(taskId: string, action: () => Promise<void>) {
    if (this.taskActions.has(taskId)) return;
    this.taskActions.add(taskId); this.taskVersion++; this.emit({ error: null });
    try { await action(); } catch (error) { this.emit({ error: asError(error) }); }
    finally { this.taskActions.delete(taskId); this.taskVersion++; this.taskDirty = true; this.emit(); void this.readTasks(); this.armPoll(); }
  }
  importModel = (modelId: string): Promise<void> => this.mutateResource(modelId, () => unwrap(this.api().importTranscriptionModel({ modelId })));
  installResource = (resourceId: string): Promise<void> => this.mutateResource(resourceId, () => unwrap(this.api().installTranscriptionResource({ resourceId })));
  cancelResourceJob = (jobId: string): Promise<void> => this.mutateResource(jobId, async () => { await unwrap(this.api().cancelTranscriptionResourceJob({ jobId })); return null; });
  private async mutateResource(id: string, action: () => Promise<TranscriptionResourceJob | null>) {
    if (this.resourceActions.has(id)) return;
    this.resourceActions.add(id); this.resourceVersion++; this.emit({ error: null });
    try {
      const job = await action();
      if (job) this.emit({ resourceJobs: Object.freeze([...this.state.resourceJobs.filter(current => current.jobId !== job.jobId), Object.freeze(job)]) });
    } catch (error) { this.emit({ error: asError(error) }); }
    finally { this.resourceActions.delete(id); this.resourceVersion++; this.resourceDirty = true; this.emit(); void this.readResources(); this.armPoll(); }
  }
  private queueRevoke(media: LocalSubtitleAuthorizedMedia) {
    if (this.revocations.has(media.fileToken) || media.expiresAt <= this.now()) return;
    const entry: Revocation = { media, attempts: 0, inFlight: false };
    this.revocations.set(media.fileToken, entry); this.emit(); void this.attemptRevoke(entry);
  }
  private async attemptRevoke(entry: Revocation) {
    if (entry.inFlight || this.revocations.get(entry.media.fileToken) !== entry) return;
    entry.timer?.(); entry.timer = undefined;
    if (entry.media.expiresAt <= this.now()) { this.revocations.delete(entry.media.fileToken); this.emit(); return; }
    entry.inFlight = true; entry.attempts++;
    let timeout: Timer | undefined;
    try {
      const response = await Promise.race([Promise.resolve().then(() => this.api().revokeTranscriptionMedia({ fileToken: entry.media.fileToken })),
        new Promise<never>((_resolve, reject) => { timeout = this.schedule(() => reject(new StudioError('interrupted')), this.revokeTimeout); })]);
      if (!response.ok) throw new StudioError(response.error);
      this.revocations.delete(entry.media.fileToken);
    } catch {
      if (!this.disposed && this.revocations.get(entry.media.fileToken) === entry) {
        const retry = this.retryDelays[entry.attempts - 1];
        const delay = retry === undefined ? entry.media.expiresAt - this.now() : Math.min(retry, entry.media.expiresAt - this.now());
        entry.timer = this.schedule(() => { entry.timer = undefined; void this.attemptRevoke(entry); }, Math.max(1, delay));
      }
    } finally { timeout?.(); entry.inFlight = false; this.emit(); }
  }
  retryCleanup = (): void => {
    for (const entry of this.revocations.values()) if (!entry.inFlight) { entry.attempts = 0; void this.attemptRevoke(entry); }
  };
  /** Test/application teardown only; never use this for a route unmount. */
  dispose = (): void => {
    this.disposed = true; this.pollTimer?.(); this.pollTimer = undefined;
    for (const entry of this.revocations.values()) entry.timer?.();
    this.subscribers.clear();
  };
}
export const createStudioTranscriptionController = (options: StudioTranscriptionControllerOptions = {}) => new StudioTranscriptionController(options);
let controller: StudioTranscriptionController | undefined;
export function getStudioTranscriptionController(): StudioTranscriptionController { return controller ??= createStudioTranscriptionController(); }
