import type { AppUpdater, CancellationToken, ProgressInfo, UpdateCheckResult, UpdateInfo } from 'electron-updater';
import type { DownloadSourceMode } from '../../../src/network/contract';
import {
  LATEST_RELEASE_URL,
  releasePageUrl,
  type AppUpdateError,
  type AppUpdateInstallMode,
  type AppUpdateManifestTrust,
  type AppUpdateProgress,
  type AppUpdateState,
} from '../../../src/app-update/contract';
import { classifyUpdateError, describeUpdateError, mostTellingFailure, type UpdateAttempt, type UpdateFailure } from './errors';
import { createFusionKitProviderClass, type UpdaterClasses, type UpdateSourcePlan } from './provider';
import { manifestWitnessSources, manualDownloadLinks, updateSources, type UpdateSource } from './sources';

/** The part of electron-updater's AppUpdater the service drives. */
export interface UpdaterLike {
  setFeedURL(options: Parameters<AppUpdater['setFeedURL']>[0]): void;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(cancellationToken?: CancellationToken): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface AppUpdateServiceOptions {
  readonly updater: UpdaterLike;
  readonly classes: UpdaterClasses;
  readonly currentVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  /** False for a development build, which never checks (electron-updater would not either). */
  readonly active: boolean;
  readonly getDownloadSourceMode: () => DownloadSourceMode;
  /** UI tests replace GitHub and its mirrors with local servers. */
  readonly sources?: (mode: DownloadSourceMode) => readonly UpdateSource[];
  /** Hosts that only confirm a mirror's latest.yml; none by default when sources are replaced. */
  readonly witnessSources?: (mode: DownloadSourceMode) => readonly UpdateSource[];
  /** Runs before the installer starts (stops the local transcription server). */
  readonly prepareInstall?: () => Promise<void>;
  /** Quits and starts FusionKit again, without installing (after a failed install). */
  readonly relaunch?: () => void;
  readonly onState?: (state: AppUpdateState) => void;
  /** Each source gets this long to answer a check (default 15 s). */
  readonly checkTimeoutMs?: number;
  /** A download that receives nothing for this long moves to the next source (default 60 s). */
  readonly stallTimeoutMs?: number;
  /** Still running this long after the installer was started means it did not start (default 20 s, 0 never). */
  readonly installTimeoutMs?: number;
}

/**
 * Checks for a new version, downloads and installs it (Windows) or links to its DMG (macOS), and
 * reports one state that the update dialog shows. Sources follow the download-source setting:
 * "official" reads only github.com, "auto" github.com first and then the mirrors, "mirror" the
 * mirrors first. A download starts at the source that answered the check and moves on when one
 * fails (connection, missing file, SHA-512 mismatch or a stall), through the sources after it and
 * then those before it, but not for a full disk or a cancel. When every source failed, the
 * answer that says most is reported (see mostTellingFailure), not just the last one. Update
 * information that only one mirror vouched for is shown but never downloaded in the app (see
 * AppUpdateManifestTrust): the user gets the download links instead.
 */
export class AppUpdateService {
  private readonly options: AppUpdateServiceOptions;
  private readonly plan: ServiceSourcePlan;
  private readonly installMode: AppUpdateInstallMode;
  private current: AppUpdateState;
  private checking?: Promise<AppUpdateState>;
  private downloading?: Promise<void>;
  private token?: CancellationToken;
  private cancelRequested = false;
  private stalled = false;
  private watchdog?: ReturnType<typeof setTimeout>;
  private installTimer?: ReturnType<typeof setTimeout>;
  /** The installer was asked to start; electron-updater ignores any further start. */
  private installerStarted = false;

  constructor(options: AppUpdateServiceOptions) {
    this.options = options;
    this.installMode = !options.active ? 'unsupported' : options.platform === 'win32' ? 'in_app' : 'manual';
    this.plan = new ServiceSourcePlan(options.platform, options.checkTimeoutMs ?? 15_000, this.installMode === 'in_app');
    this.current = Object.freeze({
      phase: 'idle',
      installMode: this.installMode,
      currentVersion: options.currentVersion,
      downloadSourceMode: safeMode(options.getDownloadSourceMode),
      releaseUrl: LATEST_RELEASE_URL,
    });
    if (!options.active) return;
    const FusionKitUpdateProvider = createFusionKitProviderClass(options.classes);
    options.updater.setFeedURL({ provider: 'custom', updateProvider: FusionKitUpdateProvider, plan: this.plan });
    options.updater.on('download-progress', info => this.onProgress(info));
    options.updater.on('error', error => {
      if (this.current.phase === 'installing') this.failInstall('start', error);
    });
  }

  state(): AppUpdateState {
    return this.current;
  }

  /**
   * Finds out whether a newer version is published. Does nothing while a download or install
   * runs, nor once the installer was asked to start (only a restart helps then).
   */
  check(): Promise<AppUpdateState> {
    if (this.installMode === 'unsupported' || this.installerStarted) return Promise.resolve(this.current);
    if (this.checking) return this.checking;
    if (['downloading', 'downloaded', 'installing'].includes(this.current.phase)) return Promise.resolve(this.current);
    const operation = this.runCheck();
    this.checking = operation;
    void operation.finally(() => { if (this.checking === operation) this.checking = undefined; });
    return operation;
  }

  /**
   * Windows: downloads the version the last check found. Progress and the end arrive as state.
   * Never for update information that only one mirror vouched for.
   */
  download(): Promise<AppUpdateState> {
    const { phase, error } = this.current;
    const retry = phase === 'error' && error?.during === 'download';
    // The phase guards against a second start: runDownload is "downloading" before it first waits.
    if (this.installMode !== 'in_app' || (phase !== 'available' && !retry)) return Promise.resolve(this.current);
    if (this.current.manifestTrust !== 'official' && this.current.manifestTrust !== 'mirrors_agree') return Promise.resolve(this.current);
    const operation = this.runDownload();
    this.downloading = operation;
    void operation.finally(() => { if (this.downloading === operation) this.downloading = undefined; });
    return Promise.resolve(this.current);
  }

  async cancel(): Promise<AppUpdateState> {
    if (this.current.phase !== 'downloading' || !this.downloading) return this.current;
    this.cancelRequested = true;
    this.token?.cancel();
    await this.downloading;
    return this.current;
  }

  /**
   * Quits and runs the downloaded installer silently (it starts FusionKit again when done). A
   * retry is only offered when stopping FusionKit's services failed: once the installer was asked
   * to start, electron-updater ignores another start, so only a restart helps.
   */
  async install(): Promise<AppUpdateState> {
    const { phase, error } = this.current;
    const retry = phase === 'error' && error?.during === 'install' && error.installStage === 'prepare' && !this.installerStarted;
    if (this.installMode !== 'in_app' || (phase !== 'downloaded' && !retry)) return this.current;
    this.update({ phase: 'installing', error: undefined });
    try {
      await this.options.prepareInstall?.();
    } catch (error) {
      this.failInstall('prepare', error);
      return this.current;
    }
    try {
      this.installerStarted = true;
      this.options.updater.quitAndInstall(true, true);
    } catch (error) {
      this.failInstall('start', error);
      return this.current;
    }
    const timeout = this.options.installTimeoutMs ?? 20_000;
    if (timeout > 0) {
      this.installTimer = setTimeout(() => {
        if (this.current.phase !== 'installing') return;
        this.failInstall('start', new Error(`FusionKit was still running ${Math.round(timeout / 1000)} s after the installer was started.`));
      }, timeout);
      this.installTimer.unref?.();
    }
    return this.current;
  }

  /**
   * After a failed install: FusionKit's services (local transcription, Subtitle Studio) are
   * already stopped, so it quits and starts again. The downloaded update is offered again then.
   */
  async restart(): Promise<AppUpdateState> {
    const { phase, error } = this.current;
    if (phase !== 'error' || error?.during !== 'install') return this.current;
    this.options.relaunch?.();
    return this.current;
  }

  private async runCheck(): Promise<AppUpdateState> {
    const mode = safeMode(this.options.getDownloadSourceMode);
    const witnesses = this.options.witnessSources ?? (this.options.sources ? () => [] : manifestWitnessSources);
    this.plan.reset((this.options.sources ?? updateSources)(mode), witnesses(mode));
    this.update({ phase: 'checking', error: undefined, progress: undefined, source: undefined, manifestTrust: undefined, downloadSourceMode: mode });
    try {
      const result = await this.options.updater.checkForUpdates();
      if (!result) {
        this.update({ phase: 'idle' });
        return this.current;
      }
      const info = result.updateInfo;
      const found = {
        latestVersion: info.version,
        source: this.plan.answered?.id,
        // Only an in-app install depends on it; macOS links to the DMG either way.
        manifestTrust: this.installMode === 'in_app' ? this.plan.trust ?? 'unverified' : undefined,
        releaseUrl: releasePageUrl(info.version),
        downloadSize: installerSize(info, this.options.platform),
      };
      if (result.isUpdateAvailable === false) {
        this.update({ phase: 'up_to_date', ...found, manualDownload: undefined });
      } else {
        // macOS downloads by hand; Windows offers the same links when the in-app update fails.
        const platform = this.options.platform;
        this.update({
          phase: 'available',
          ...found,
          manualDownload: manualDownloadLinks({
            version: info.version, files: info.files, platform, arch: platform === 'darwin' ? this.options.arch : undefined, mode,
          }),
        });
      }
    } catch (error) {
      // No source answered: what the most telling one said. One answered and electron-updater
      // failed afterwards: that error.
      const failure = (!this.plan.answered && mostTellingFailure(this.plan.checkFailures)) || classifyUpdateError(error);
      this.update({ phase: 'error', error: this.failure('check', failure, this.plan.checkAttempts, error) });
    }
    return this.current;
  }

  private async runDownload(): Promise<void> {
    this.plan.restartDownloads();
    const total = this.current.downloadSize ?? 0;
    this.update({ phase: 'downloading', error: undefined, progress: { percent: 0, transferred: 0, total, bytesPerSecond: 0 } });
    for (;;) {
      const source = this.plan.downloadSource();
      this.update({ source: source.id });
      const token = new this.options.classes.CancellationToken();
      this.token = token;
      this.stalled = false;
      this.cancelRequested = false;
      this.armWatchdog();
      try {
        await this.options.updater.downloadUpdate(token);
        this.clearWatchdog();
        const size = this.current.progress?.total || total;
        this.update({ phase: 'downloaded', progress: { percent: 100, transferred: size, total: size, bytesPerSecond: 0 } });
        return;
      } catch (error) {
        this.clearWatchdog();
        if (this.cancelRequested) {
          this.cancelRequested = false;
          this.update({ phase: 'available', progress: undefined });
          return;
        }
        const stalledError = this.stalled
          ? Object.assign(new Error(`No data for ${Math.round((this.options.stallTimeoutMs ?? 60_000) / 1000)} s`), { code: 'ETIMEDOUT' })
          : undefined;
        const failure: UpdateFailure = stalledError ? { kind: 'network', networkCategory: 'timeout' } : classifyUpdateError(error);
        this.plan.downloadFailed(source, failure, stalledError ?? error);
        const switchable = failure.kind !== 'disk' && failure.kind !== 'cancelled';
        if (!switchable || !this.plan.nextDownloadSource()) {
          // A full disk stops at once and is the reason; after every source, the most telling answer.
          const reported = switchable ? mostTellingFailure(this.plan.downloadFailures) ?? failure : failure;
          this.update({ phase: 'error', progress: undefined, error: this.failure('download', reported, this.plan.downloadAttempts, error) });
          return;
        }
        this.update({ progress: { percent: 0, transferred: 0, total, bytesPerSecond: 0 } });
      } finally {
        if (this.token === token) this.token = undefined;
      }
    }
  }

  private onProgress(info: ProgressInfo): void {
    if (this.current.phase !== 'downloading') return;
    this.armWatchdog();
    const progress: AppUpdateProgress = {
      percent: clampPercent(info.percent),
      transferred: Math.max(0, info.transferred || 0),
      total: Math.max(0, info.total || 0),
      bytesPerSecond: Math.max(0, info.bytesPerSecond || 0),
    };
    this.update({ progress });
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.stalled = true;
      this.token?.cancel();
    }, this.options.stallTimeoutMs ?? 60_000);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private failInstall(stage: 'prepare' | 'start', error: unknown): void {
    if (this.installTimer !== undefined) clearTimeout(this.installTimer);
    this.installTimer = undefined;
    this.update({
      phase: 'error',
      error: { kind: 'unknown', during: 'install', installStage: stage, mirrorsTried: false, detail: describeUpdateError(error) },
    });
  }

  private failure(during: AppUpdateError['during'], failure: UpdateFailure, attempts: readonly string[], error: unknown): AppUpdateError {
    return {
      kind: failure.kind === 'cancelled' ? 'unknown' : failure.kind,
      during,
      mirrorsTried: this.plan.triedMirror,
      detail: attempts.length > 0 ? attempts.join('\n') : describeUpdateError(error),
    };
  }

  private update(patch: Partial<AppUpdateState>): void {
    const next: Record<string, unknown> = { ...this.current, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    this.current = Object.freeze(next) as unknown as AppUpdateState;
    this.options.onState?.(this.current);
  }
}

/** The plan the provider reads, with what each source answered this time. */
class ServiceSourcePlan implements UpdateSourcePlan {
  readonly platform: NodeJS.Platform;
  readonly checkTimeoutMs: number;
  readonly corroborateMirrors: boolean;
  private sources: readonly UpdateSource[] = [];
  private witnesses: readonly UpdateSource[] = [];
  /** The order downloads try: the answering source, those after it, then those before it. */
  private downloadOrder: readonly UpdateSource[] = [];
  private downloadIndex = 0;
  answered?: UpdateSource;
  trust?: AppUpdateManifestTrust;
  triedMirror = false;
  checkAttempts: string[] = [];
  downloadAttempts: string[] = [];
  checkFailures: UpdateAttempt[] = [];
  downloadFailures: UpdateAttempt[] = [];

  constructor(platform: NodeJS.Platform, checkTimeoutMs: number, corroborateMirrors: boolean) {
    this.platform = platform;
    this.checkTimeoutMs = checkTimeoutMs;
    this.corroborateMirrors = corroborateMirrors;
  }

  reset(sources: readonly UpdateSource[], witnesses: readonly UpdateSource[] = []): void {
    this.sources = sources;
    this.witnesses = witnesses;
    this.downloadOrder = sources;
    this.answered = undefined;
    this.trust = undefined;
    this.downloadIndex = 0;
    this.triedMirror = false;
    this.checkAttempts = [];
    this.downloadAttempts = [];
    this.checkFailures = [];
    this.downloadFailures = [];
  }

  checkSources(): readonly UpdateSource[] {
    return this.sources;
  }

  witnessSources(): readonly UpdateSource[] {
    return this.witnesses;
  }

  checkAnswered(source: UpdateSource): void {
    this.answered = source;
    if (!source.official) this.triedMirror = true;
  }

  checkTrusted(trust: AppUpdateManifestTrust): void {
    this.trust = trust;
  }

  checkFailed(source: UpdateSource, error: unknown): void {
    if (!source.official) this.triedMirror = true;
    this.checkAttempts.push(`${source.id} (check): ${describeUpdateError(error)}`);
    this.checkFailures.push({ official: source.official, failure: classifyUpdateError(error) });
  }

  /**
   * Downloads start at the source that answered, then try those after it, and last the ones
   * before it: a source that missed the check's time limit may well serve the download.
   */
  restartDownloads(): void {
    const start = Math.max(0, this.answered ? this.sources.indexOf(this.answered) : 0);
    this.downloadOrder = [...this.sources.slice(start), ...this.sources.slice(0, start)];
    this.downloadIndex = 0;
    this.downloadAttempts = [];
    this.downloadFailures = [];
  }

  downloadSource(): UpdateSource {
    return this.downloadOrder[this.downloadIndex] ?? this.sources[0]!;
  }

  downloadFailed(source: UpdateSource, failure: UpdateFailure, error: unknown): void {
    if (!source.official) this.triedMirror = true;
    this.downloadAttempts.push(`${source.id} (download): ${describeUpdateError(error)}`);
    this.downloadFailures.push({ official: source.official, failure });
  }

  /** Moves to the next source; false when every source was tried. */
  nextDownloadSource(): boolean {
    if (this.downloadIndex + 1 >= this.downloadOrder.length) return false;
    this.downloadIndex += 1;
    if (!this.downloadSource().official) this.triedMirror = true;
    return true;
  }
}

/** The installer's size (Windows .exe, macOS .dmg) as latest.yml lists it. */
function installerSize(info: UpdateInfo, platform: NodeJS.Platform): number | undefined {
  const extension = platform === 'darwin' ? '.dmg' : '.exe';
  const file = info.files?.find(item => typeof item.url === 'string' && item.url.toLowerCase().endsWith(extension)) ?? info.files?.[0];
  return typeof file?.size === 'number' && file.size > 0 ? file.size : undefined;
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function safeMode(read: () => DownloadSourceMode): DownloadSourceMode {
  try {
    const mode = read();
    return mode === 'official' || mode === 'mirror' ? mode : 'auto';
  } catch {
    return 'auto';
  }
}
