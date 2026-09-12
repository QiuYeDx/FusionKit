import { StudioError, type ErrorCode } from '../../subtitle-studio/domain';
import type { StudioEvent, SubtitleStudioApi, TranslationTasksSnapshot } from '../../subtitle-studio/ipc-contract';

type Api = Pick<SubtitleStudioApi, 'listTranslationTasks' | 'subscribe'>;
type CancelTimer = () => void;
export interface TranslationOverviewState {
  readonly snapshot: TranslationTasksSnapshot | null;
  readonly round: TranslationTasksSnapshot | null;
  readonly roundTaskIds: readonly string[];
  readonly offset: number;
  readonly pageSize: number;
  readonly detailsOpen: boolean;
  readonly refreshing: boolean;
  readonly error: ErrorCode | null;
}
export interface TranslationOverviewOptions {
  getApi?: () => Api;
  schedule?: (callback: () => void, delayMs: number) => CancelTimer;
}
type StatePatch = { -readonly [Key in keyof TranslationOverviewState]?: TranslationOverviewState[Key] };
const active = (snapshot: TranslationTasksSnapshot | null) => !!snapshot && snapshot.counts.queued + snapshot.counts.running > 0;
export function getTranslationRoundProgress(state: TranslationOverviewState): number | null {
  const round = state.round;
  if (!round || round.total !== state.roundTaskIds.length || !round.totalBatches) return null;
  return Math.min(100, Math.max(0, Math.floor(round.completedBatches / round.totalBatches * 100)));
}

/** Session-wide observations and the IDs actually accepted by the latest submission. */
export class StudioTranslationOverviewController {
  private readonly api: () => Api;
  private readonly schedule: NonNullable<TranslationOverviewOptions['schedule']>;
  private readonly listeners = new Set<() => void>();
  private state: TranslationOverviewState = Object.freeze({ snapshot: null, round: null, roundTaskIds: [], offset: 0,
    pageSize: 20, detailsOpen: false, refreshing: false, error: null });
  private unsubscribe?: () => void;
  private timer?: CancelTimer;
  private read?: Promise<void>;
  private version = 0;
  private minimumSequence = -1;
  private dirty = false;
  private disposed = false;
  constructor(options: TranslationOverviewOptions = {}) {
    this.api = options.getApi ?? (() => window.subtitleStudio);
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
  }
  getState = (): TranslationOverviewState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); this.connect(); void this.refresh();
    return () => { this.listeners.delete(listener); this.armPoll(); };
  };
  private emit(patch: Partial<TranslationOverviewState>) {
    if (this.disposed) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* A view cannot interrupt observations. */ } }
  }
  private connect() {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.api().subscribe((event: StudioEvent) => {
      if (event.sequence <= this.minimumSequence) return;
      this.minimumSequence = event.sequence; this.version++; this.dirty = true;
      if (this.listeners.size || active(this.state.snapshot) || this.state.roundTaskIds.length) void this.refresh();
    });
  }
  /** Each accepted single/batch submission starts a new, explicitly scoped round. */
  trackStarted = (taskIds: readonly string[]): void => {
    const ids = [...new Set(taskIds)];
    if (!ids.length) return;
    if (ids.length > 100) { this.emit({ error: 'limit_exceeded' }); return; }
    this.connect(); this.version++; this.dirty = true;
    this.emit({ roundTaskIds: Object.freeze(ids), round: null, error: null });
    void this.refresh();
  };
  setDetailsOpen = (open: boolean): void => { this.emit({ detailsOpen: open }); if (open) void this.refresh(); };
  setOffset = (offset: number): void => {
    const value = Math.max(0, Math.floor(offset / this.state.pageSize) * this.state.pageSize);
    if (!Number.isFinite(value) || value === this.state.offset) return;
    this.version++; this.dirty = true; this.emit({ offset: value }); void this.refresh();
  };
  refresh = (): Promise<void> => {
    if (this.read) return this.read;
    if (this.disposed) return Promise.resolve();
    this.connect(); this.timer?.(); this.timer = undefined;
    const version = this.version;
    const { offset, pageSize, roundTaskIds } = this.state;
    this.dirty = false;
    this.read = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        this.api().listTranslationTasks({ offset, pageSize }),
        roundTaskIds.length ? this.api().listTranslationTasks({ offset: 0, pageSize: 100, taskIds: [...roundTaskIds] }) : Promise.resolve(null),
      ]);
      if (this.disposed) return;
      if (version !== this.version) { this.dirty = true; return; }
      const patch: StatePatch = { error: null };
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') { patch.error = 'document_unavailable'; continue; }
        if (!result.value) continue;
        if (!result.value.ok) { patch.error = result.value.error; continue; }
        const snapshot = result.value.value;
        const previous = index ? this.state.round : this.state.snapshot;
        if (snapshot.sequence < Math.max(this.minimumSequence, previous?.sequence ?? -1)) { this.dirty = true; continue; }
        if (index) patch.round = snapshot;
        else {
          patch.snapshot = snapshot;
          if (offset > 0 && offset >= snapshot.total) {
            patch.offset = Math.max(0, Math.ceil(snapshot.total / pageSize) - 1) * pageSize;
            this.version++; this.dirty = true;
          }
        }
      }
      this.emit(patch);
    }).catch(error => this.emit({ error: error instanceof StudioError ? error.code : 'document_unavailable' })).finally(() => {
      this.read = undefined; this.emit({ refreshing: false }); this.armPoll();
    });
    this.emit({ refreshing: true });
    return this.read;
  };
  private armPoll() {
    this.timer?.(); this.timer = undefined;
    if (this.disposed || this.read) return;
    const running = active(this.state.snapshot) || active(this.state.round) || (!!this.state.roundTaskIds.length && !this.state.round);
    if (!this.listeners.size && !running && !this.dirty) return;
    this.timer = this.schedule(() => { this.timer = undefined; void this.refresh(); }, this.dirty ? 100 : running ? 1000 : 5000);
  }
  /** Only application/test teardown; route unmounts retain the current round. */
  dispose = (): void => { this.disposed = true; this.timer?.(); this.unsubscribe?.(); this.listeners.clear(); };
}
export const createStudioTranslationOverviewController = (options: TranslationOverviewOptions = {}) => new StudioTranslationOverviewController(options);
let controller: StudioTranslationOverviewController | undefined;
export function getStudioTranslationOverviewController() { return controller ??= createStudioTranslationOverviewController(); }
