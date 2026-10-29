import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeFailureCode, RuntimeStatus } from '../../../../src/media-converter/contract';
import { LOCAL_SUBTITLE_MEDIA_POLICY } from '../../subtitle-studio/transcription/native/media-normalizer';
import { buildLocalSubtitleMediaEnvironment, runLocalSubtitleMediaProcess, type LocalSubtitleMediaProcessResult } from '../../subtitle-studio/transcription/native/media-process';
import { isLocalSubtitleVerifiedRuntimeBundle, verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment,
  type LocalSubtitleVerifiedRuntimeArtifact } from '../../subtitle-studio/transcription/native/resource-path';

/**
 * The bundled ffmpeg/ffprobe of the media converter (design §1). They come only from the verified
 * transcription runtime (`verifyLocalSubtitleRuntimeBundle`, scope `media`), never from PATH, the
 * registry or a user choice (FK-PIT-0023). Verification hashes about 225 MB, so it runs on the first
 * need and its result is reused while both executables keep their size and modification time.
 * A failure is never cached: the next use verifies again.
 */

export type MediaTool = 'ffmpeg' | 'ffprobe';
export type MediaSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type MediaRunResult = LocalSubtitleMediaProcessResult;

export interface MediaTools {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  /** The pinned version both executables reported. */
  readonly version: string;
  /** sha256 of the runtime manifest the executables were verified against. */
  readonly generation: string;
  /** PATH holds only the media directory and System32; TEMP is the working directory. */
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export interface MediaRunLimits {
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly signal?: AbortSignal;
}

/** What the probe and the capability detection need from the runtime; tests substitute it. */
export interface MediaToolRunner {
  run(tool: MediaTool, args: readonly string[], limits: MediaRunLimits): Promise<MediaRunResult>;
}

export class MediaRuntimeError extends Error {
  constructor(readonly code: RuntimeFailureCode, message: string) {
    super(message);
    this.name = 'MediaRuntimeError';
  }
}

type FileStat = { size: number; mtimeMs: number; isFile(): boolean };
export interface MediaRuntimeOptions {
  environment: LocalSubtitleResourceEnvironment;
  /** `userData/media-converter/work`: the short cwd and TEMP of every run (FK-PIT-0036). */
  workingDirectory: string;
  platform?: NodeJS.Platform | string;
  verifyRuntime?: typeof verifyLocalSubtitleRuntimeBundle;
  spawn?: MediaSpawn;
  statFile?: (file: string) => Promise<FileStat>;
  /** The versions the executables must be; tests change them to prove a mismatch is refused. */
  pinnedVersions?: Readonly<Record<'darwin' | 'win32', string>>;
  /** Where SystemRoot and friends come from for the reduced environment; defaults to `process.env`. */
  sourceEnvironment?: Readonly<Record<string, string | undefined>>;
}

const VERSION_TIMEOUT_MS = LOCAL_SUBTITLE_MEDIA_POLICY.runtimeProbeTimeoutMs;
const VERSION_OUTPUT_BYTES = 256 * 1024;

type Verified = { tools: MediaTools; stats: Record<MediaTool, { size: number; mtimeMs: number }> };

/** Spawns below normal priority, so probing and detection never compete with what the user is doing. */
export function belowNormalPriority(spawn: MediaSpawn): MediaSpawn {
  return (command, args, options) => {
    const child = spawn(command, args, options);
    if (child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch { /* The process may have exited already; priority is best effort. */ }
    }
    return child;
  };
}

/**
 * The verified ffmpeg and ffprobe of a runtime proof: exactly one of each, of the media backend,
 * side by side, at the pinned version. Checked as `selectCueAudioFfmpeg` checks it.
 */
export function selectMediaTools(bundle: unknown, pinned: Readonly<Record<'darwin' | 'win32', string>> = LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions) {
  if (!isLocalSubtitleVerifiedRuntimeBundle(bundle) || (bundle.scope !== 'media' && bundle.scope !== 'all') || bundle.noPathFallback !== true || bundle.ready !== true) {
    throw new MediaRuntimeError('runtime_invalid', 'The bundled media runtime proof is invalid.');
  }
  const artifacts = Object.values(bundle.artifactPaths);
  const pick = (kind: MediaTool) => artifacts.filter(artifact => artifact.kind === kind);
  const [ffmpeg, ffprobe] = [pick('ffmpeg'), pick('ffprobe')];
  if (ffmpeg.length !== 1 || ffprobe.length !== 1) throw new MediaRuntimeError('runtime_missing', 'The bundled media runtime lacks ffmpeg or ffprobe.');
  if (ffmpeg[0].backend !== 'media' || ffprobe[0].backend !== 'media' || path.dirname(ffmpeg[0].absolutePath) !== path.dirname(ffprobe[0].absolutePath)) {
    throw new MediaRuntimeError('runtime_invalid', 'The bundled ffmpeg and ffprobe do not belong together.');
  }
  const version = pinned[bundle.target.platform];
  if (ffmpeg[0].version !== version || ffprobe[0].version !== version) {
    throw new MediaRuntimeError('runtime_version_mismatch', 'The bundled media runtime is not the pinned version.');
  }
  return { ffmpeg: ffmpeg[0], ffprobe: ffprobe[0], version, generation: bundle.runtimeGeneration, platform: bundle.target.platform };
}

/** Maps a failed `verifyLocalSubtitleRuntimeBundle` to a runtime reason code. */
export function runtimeFailureCode(error: unknown): RuntimeFailureCode {
  if (error instanceof MediaRuntimeError) return error.code;
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  if (code === 'media_runtime_missing' || code === 'runtime_missing') return 'runtime_missing';
  if (code === 'unsupported_platform' || code === 'unsupported_architecture') return 'platform_unsupported';
  return 'runtime_invalid';
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const succeeded = (result: MediaRunResult) => result.status === 'closed' && result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputExceeded;

export class MediaRuntime implements MediaToolRunner {
  readonly #options: MediaRuntimeOptions;
  readonly #spawn: MediaSpawn;
  #verified: Promise<Verified> | undefined;
  #status: RuntimeStatus = { state: 'unverified' };

  constructor(options: MediaRuntimeOptions) {
    this.#options = options;
    this.#spawn = belowNormalPriority(options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions)));
  }

  /** `unavailable` carries the reason of the latest failure until a later use succeeds. */
  status(): RuntimeStatus {
    return this.#status;
  }

  /** Forgets the verification, so the next use verifies again. */
  invalidate() {
    this.#verified = undefined;
  }

  /** The verified tools; throws {@link MediaRuntimeError}. Verifies on first use, and again when an executable changed. */
  async acquire(): Promise<MediaTools> {
    if ((this.#options.platform ?? process.platform) !== 'win32') return this.#fail(new MediaRuntimeError('platform_unsupported', 'The media converter supports Windows only.'));
    const pending = this.#verified ??= this.#verify();
    let verified: Verified;
    try { verified = await pending; }
    catch (error) {
      if (this.#verified === pending) this.#verified = undefined;
      return this.#fail(error);
    }
    if (await this.#unchanged(verified)) return verified.tools;
    if (this.#verified === pending) this.#verified = undefined;
    const again = this.#verified ??= this.#verify();
    try { return (await again).tools; }
    catch (error) {
      if (this.#verified === again) this.#verified = undefined;
      return this.#fail(error);
    }
  }

  /**
   * Runs a bundled tool below normal priority, with the reduced environment and the working
   * directory as cwd. When it cannot be started, the runtime is verified once more and the run
   * retried once; a second start failure is `runtime_spawn_failed`.
   */
  async run(tool: MediaTool, args: readonly string[], limits: MediaRunLimits): Promise<MediaRunResult> {
    let result = await this.#runOnce(await this.acquire(), tool, args, limits);
    if (result.status !== 'spawn_error' || limits.signal?.aborted) return result;
    this.invalidate();
    result = await this.#runOnce(await this.acquire(), tool, args, limits);
    if (result.status === 'spawn_error' && !limits.signal?.aborted) {
      this.invalidate();
      return this.#fail(new MediaRuntimeError('runtime_spawn_failed', `The bundled ${tool} could not be started.`));
    }
    return result;
  }

  #fail(error: unknown): never {
    const failure = error instanceof MediaRuntimeError ? error : new MediaRuntimeError(runtimeFailureCode(error), 'The bundled media runtime could not be verified.');
    this.#status = { state: 'unavailable', code: failure.code };
    throw failure;
  }

  #runOnce(tools: MediaTools, tool: MediaTool, args: readonly string[], limits: MediaRunLimits) {
    return runLocalSubtitleMediaProcess({ command: tools[tool], args, cwd: tools.workingDirectory, env: tools.environment, runner: this.#spawn,
      timeoutMs: limits.timeoutMs, stdoutMaxBytes: limits.stdoutMaxBytes, stderrMaxBytes: limits.stderrMaxBytes, signal: limits.signal });
  }

  async #verify(): Promise<Verified> {
    let bundle: unknown;
    try { bundle = await (this.#options.verifyRuntime ?? verifyLocalSubtitleRuntimeBundle)({ environment: this.#options.environment, scope: 'media' }); }
    catch (error) { throw new MediaRuntimeError(runtimeFailureCode(error), 'The bundled media runtime could not be verified.'); }
    const selected = selectMediaTools(bundle, this.#options.pinnedVersions);
    const workingDirectory = this.#options.workingDirectory;
    let environment: Readonly<Record<string, string>>;
    try {
      await mkdir(workingDirectory, { recursive: true });
      environment = buildLocalSubtitleMediaEnvironment({ platform: selected.platform, mediaDirectory: path.dirname(selected.ffmpeg.absolutePath),
        tempDirectory: workingDirectory, sourceEnvironment: this.#options.sourceEnvironment });
    } catch { throw new MediaRuntimeError('runtime_spawn_failed', 'The media working directory is unavailable.'); }
    for (const [tool, artifact] of [['ffmpeg', selected.ffmpeg], ['ffprobe', selected.ffprobe]] as const) {
      await this.#checkVersion(tool, artifact, selected.version, workingDirectory, environment);
    }
    const stat = this.#options.statFile ?? lstat;
    const stats = {} as Verified['stats'];
    for (const [tool, artifact] of [['ffmpeg', selected.ffmpeg], ['ffprobe', selected.ffprobe]] as const) {
      const value = await stat(artifact.absolutePath).catch(() => null);
      if (!value?.isFile()) throw new MediaRuntimeError('runtime_missing', `The bundled ${tool} disappeared.`);
      stats[tool] = { size: value.size, mtimeMs: value.mtimeMs };
    }
    const tools: MediaTools = Object.freeze({ ffmpeg: selected.ffmpeg.absolutePath, ffprobe: selected.ffprobe.absolutePath, version: selected.version,
      generation: selected.generation, environment, workingDirectory });
    this.#status = { state: 'ready', version: selected.version };
    return { tools, stats };
  }

  /** `<tool> -version` must start and print the pinned version on its first line. */
  async #checkVersion(tool: MediaTool, artifact: LocalSubtitleVerifiedRuntimeArtifact, version: string, cwd: string, env: Readonly<Record<string, string>>) {
    const result = await runLocalSubtitleMediaProcess({ command: artifact.absolutePath, args: ['-hide_banner', '-version'], cwd, env, runner: this.#spawn,
      timeoutMs: VERSION_TIMEOUT_MS, stdoutMaxBytes: VERSION_OUTPUT_BYTES, stderrMaxBytes: VERSION_OUTPUT_BYTES });
    if (!succeeded(result)) throw new MediaRuntimeError('runtime_spawn_failed', `The bundled ${tool} could not be started.`);
    const firstLine = result.stdout.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    if (!new RegExp(`^${tool} version ${escapeRegExp(version)}(?:\\s|$)`).test(firstLine)) {
      throw new MediaRuntimeError('runtime_version_mismatch', `The bundled ${tool} reports another version.`);
    }
  }

  async #unchanged(verified: Verified): Promise<boolean> {
    const stat = this.#options.statFile ?? lstat;
    for (const tool of ['ffmpeg', 'ffprobe'] as const) {
      const value = await stat(verified.tools[tool]).catch(() => null);
      if (!value?.isFile() || value.size !== verified.stats[tool].size || value.mtimeMs !== verified.stats[tool].mtimeMs) return false;
    }
    return true;
  }
}
