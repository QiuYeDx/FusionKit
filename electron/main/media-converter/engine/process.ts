import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { MEDIA_DEMUXERS, type EngineReasonCode, type MediaDemuxer, type MediaInfo } from '../../../../src/media-converter/contract';
import { buildLocalSubtitleMediaEnvironment } from '../../subtitle-studio/transcription/native/media-process';
import { createLogRedactor, mergeProgress, ProgressParser, redactedLogTail, type ProgressState, type RedactionPaths } from './progress';
import type { MediaSpawn } from './runtime';

/**
 * The ffmpeg process of a conversion (design §4, R-ENGINE-04). Long encodes do not fit the frozen
 * `runLocalSubtitleMediaProcess` (stderr over its cap stops the process, no priority, a 12 h
 * timeout), so this is its own spawn: below normal priority (idle and half the cores in low-usage
 * mode), the common argument prefix, every input pinned to its probed demuxer and the file
 * protocol, `-progress` parsed line by line, the last 256 KB of stderr kept in memory, a stall
 * watchdog per phase, cancellation, and the facts the success judgement needs. Only
 * `buildLocalSubtitleMediaEnvironment` is reused from the native runner.
 */

export const ENCODE_PROCESS_POLICY = Object.freeze({
  /** stderr kept in memory; older output is dropped, never a reason to stop ffmpeg. */
  stderrBytes: 256 * 1024,
  /** The redacted log tail a failure carries by default. */
  tailBytes: 16 * 1024,
  stderrLineBytes: 16 * 1024,
  /** `-fs` stops ffmpeg with exit 0, so an output this close to the cap counts as cut off by it. */
  capSlackBytes: 64 * 1024,
  /** …but never more than this share of the cap, so a small cap's whole output is not mistaken for a cut one. */
  capSlackShare: 0.005,
  /** After the process exits or is killed, how long `close` may take before the run settles without it (FK-PIT-0036). */
  closeGraceMs: 5_000,
  /** A filter longer than this goes to a file in the working directory (`-/filter:v:0`): Windows command lines stop at 32,767 characters. */
  filterFileBytes: 8 * 1024,
  maxCommandLineChars: 32_000,
  maxArguments: 4_096,
  affinityTimeoutMs: 15_000,
  /** Processed time within this of the expected duration is the finalizing phase (trailer, `+faststart` rewrite). */
  finalizingLeadUs: 1_000_000,
});

/** Stall thresholds (AC-ENGINE-04-4); tests inject small ones. */
export interface StallThresholds {
  /** How often the watchdog looks. */
  readonly checkIntervalMs: number;
  /** Before the first output: grace from the start. */
  readonly firstOutputMs: number;
  readonly firstOutputLowUsageMs: number;
  /** While encoding: neither processed time nor written bytes grew for this long. */
  readonly encodingMs: number;
  /** While finalizing: this plus the bytes written at the rate below. */
  readonly finalizingBaseMs: number;
  readonly finalizingBytesPerSecond: number;
}
export const STALL_THRESHOLDS: StallThresholds = Object.freeze({
  checkIntervalMs: 10_000,
  firstOutputMs: 300_000,
  firstOutputLowUsageMs: 600_000,
  encodingMs: 120_000,
  finalizingBaseMs: 120_000,
  finalizingBytesPerSecond: 20_000_000,
});

// ── Arguments ──────────────────────────────────────────────────────────────────────────────────

/** Every converter run starts with these; `level+warning` keeps the warnings that tell of a silent substitution. */
export const FFMPEG_COMMON_PREFIX: readonly string[] = Object.freeze(['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning',
  '-stats_period', '0.5', '-progress', 'pipe:1']);
/** Options the prefix owns, and `-report`, which would write a log with every path into the working directory. */
const RESERVED_OPTIONS = new Set(['-hide_banner', '-nostdin', '-stdin', '-nostats', '-stats', '-loglevel', '-v', '-stats_period', '-progress', '-report']);
const DEMUXERS: ReadonlySet<string> = new Set(MEDIA_DEMUXERS);

function isAbsoluteNormalized(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !/[\u0000-\u001f]/.test(value) && path.isAbsolute(value)
    && path.resolve(value) === value && path.parse(value).root !== value;
}

/**
 * One input as every converter run reads it: the probed demuxer pinned with `-f`, the file
 * protocol only, and a `file:` URL so no part of the name is read as a protocol.
 */
export function ffmpegInput(filePath: string, demuxer: MediaDemuxer): string[] {
  if (!isAbsoluteNormalized(filePath)) throw new TypeError('An ffmpeg input must be an absolute, normalized path.');
  if (!DEMUXERS.has(demuxer)) throw new TypeError('An ffmpeg input must use a media demuxer.');
  return ['-f', demuxer, '-protocol_whitelist', 'file', '-i', `file:${filePath}`];
}

/** Throws unless every `-i` is written as {@link ffmpegInput} writes it (input options such as `-ss` or `-re` may come before). */
export function assertGuardedInputs(args: readonly string[]): void {
  let inputs = 0;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '-i') continue;
    inputs++;
    const url = args[index + 1];
    if (index < 4 || args[index - 4] !== '-f' || !DEMUXERS.has(args[index - 3]) || args[index - 2] !== '-protocol_whitelist' || args[index - 1] !== 'file'
      || typeof url !== 'string' || !url.startsWith('file:') || !isAbsoluteNormalized(url.slice(5))) {
      throw new TypeError(`ffmpeg input ${inputs} is not pinned to a media demuxer, the file protocol and a file: path.`);
    }
  }
  if (inputs === 0) throw new TypeError('An ffmpeg run of the converter reads at least one input.');
}

const FILTER_OPTION = /^-(?:filter:([va])(?::(\d{1,3}))?|([va])f)$/;
export interface FilterFile { readonly path: string; readonly content: string }

/**
 * Moves every per-stream filter longer than 8 KB into `filter-<v|a><n>.txt` in the working
 * directory and passes it as `-/filter:v:0 file:<path>`. Pure: the caller writes `files`.
 * Multi-input graphs (`-/filter_complex`) are I2's.
 */
export function externalizeLongFilters(args: readonly string[], workDirectory: string, limitBytes: number = ENCODE_PROCESS_POLICY.filterFileBytes) {
  const out: string[] = [];
  const files: FilterFile[] = [];
  const names = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const match = FILTER_OPTION.exec(args[index]);
    const value = args[index + 1];
    if (!match || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= limitBytes) { out.push(args[index]); continue; }
    const type = match[1] ?? match[3];
    const stream = match[2];
    let name = `filter-${type}${stream ?? ''}.txt`;
    for (let suffix = 2; names.has(name); suffix++) name = `filter-${type}${stream ?? ''}-${suffix}.txt`;
    names.add(name);
    const file = path.join(workDirectory, name);
    files.push({ path: file, content: value });
    out.push(`-/filter:${type}${stream === undefined ? '' : `:${stream}`}`, `file:${file}`);
    index++;
  }
  return { args: out, files };
}

/** Rough length of the Windows command line `CreateProcess` gets: quotes and a space around each argument. */
const commandLineChars = (command: string, args: readonly string[]) => args.reduce((sum, arg) => sum + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), command.length + 3);

/** The reduced environment of a job: PATH holds the media directory and System32 only, TEMP is the job's working directory. */
export function encodeEnvironment(ffmpeg: string, workDirectory: string, sourceEnvironment?: Readonly<Record<string, string | undefined>>) {
  return buildLocalSubtitleMediaEnvironment({ platform: process.platform === 'darwin' ? 'darwin' : 'win32', mediaDirectory: path.dirname(ffmpeg),
    tempDirectory: workDirectory, sourceEnvironment });
}

// ── Priority and affinity ──────────────────────────────────────────────────────────────────────

/**
 * Low-usage mode keeps ffmpeg on about half the logical processors: the upper half, which on a
 * hybrid CPU are usually the efficiency cores. One processor group holds at most 64.
 */
export function lowUsageAffinityMask(logicalProcessors: number): bigint {
  const total = Math.min(64, Math.max(1, Math.floor(Number.isFinite(logicalProcessors) ? logicalProcessors : 1)));
  const half = Math.max(1, Math.floor(total / 2));
  return ((1n << BigInt(half)) - 1n) << BigInt(total - half);
}

/** Sets the affinity with one PowerShell call; Node has no API for it. Rejects on any failure. */
export function setAffinityWithPowerShell(pid: number, mask: bigint, signal?: AbortSignal,
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new TypeError('The process id is invalid.'));
  if (mask <= 0n || mask >= 1n << 64n) return Promise.reject(new RangeError('The affinity mask is invalid.'));
  const systemRoot = environment.SystemRoot ?? environment.WINDIR ?? environment.windir;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return Promise.reject(new Error('The Windows system root is unavailable.'));
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Through Int64: a mask with bit 63 set is negative as a signed number, and IntPtr takes it bit for bit.
  const command = `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr][Int64](${BigInt.asIntN(64, mask)})`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('The affinity change was abandoned.')); return; }
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve();
    };
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: ENCODE_PROCESS_POLICY.affinityTimeoutMs, maxBuffer: 64 * 1024, signal },
      (error, _stdout, stderr) => settle(error ? new Error(`PowerShell could not set the affinity: ${String(stderr).trim().slice(0, 300) || error.message}`) : undefined));
    // The caller's own deadline: a callback that never comes must not hold the job (FK-PIT-0036).
    const deadline = setTimeout(() => { try { child.kill(); } catch { /* Gone. */ } settle(new Error('PowerShell did not answer in time.')); },
      ENCODE_PROCESS_POLICY.affinityTimeoutMs + 1_000);
    deadline.unref?.();
  });
}

// ── stderr ─────────────────────────────────────────────────────────────────────────────────────

export type StderrFailure = 'disk_full' | 'output_open_failed';
const DISK_FULL = /No space left on device|There is not enough space on the disk|\bENOSPC\b/i;
/** `-n` (or no `-y`) against an existing file: ffmpeg says so and exits 0 without any progress. */
const OUTPUT_EXISTS = /File '.*' already exists\. Exiting|Not overwriting - exiting/;
/**
 * The muxer's own line when the output cannot be created: `[out#0/mp4 @ …] Error opening output <url>: <reason>`.
 * ffmpeg's later `Error opening output file <url>.` follows any output set-up failure (a filter graph that
 * does not fit, too), so that line alone does not mean the file could not be opened.
 */
const OUTPUT_OPEN = /\[out#\d+\/[^\]]*\]\s*(?:\[[a-z]+\]\s*)?Error opening output /;

/** The failure a stderr line names, if any; `disk_full` before `output_open_failed`. Pass redacted lines, so a file name cannot match. */
export function classifyStderrLine(line: string): StderrFailure | null {
  if (DISK_FULL.test(line)) return 'disk_full';
  if (OUTPUT_EXISTS.test(line) || OUTPUT_OPEN.test(line)) return 'output_open_failed';
  return null;
}

/** The last `capacity` bytes written to it. */
class ByteRing {
  #chunks: Buffer[] = [];
  #bytes = 0;
  total = 0;
  constructor(readonly capacity: number) {}
  push(chunk: Buffer) {
    this.total += chunk.length;
    if (chunk.length >= this.capacity) {
      this.#chunks = [Buffer.from(chunk.subarray(chunk.length - this.capacity))];
      this.#bytes = this.capacity;
      return;
    }
    this.#chunks.push(Buffer.from(chunk));
    this.#bytes += chunk.length;
    while (this.#bytes > this.capacity) {
      const excess = this.#bytes - this.capacity;
      const first = this.#chunks[0];
      if (first.length <= excess) { this.#chunks.shift(); this.#bytes -= first.length; }
      else { this.#chunks[0] = first.subarray(excess); this.#bytes -= excess; }
    }
  }
  contents() { return Buffer.concat(this.#chunks, this.#bytes); }
}

// ── Stall watchdog ─────────────────────────────────────────────────────────────────────────────

export type StallPhase = 'before_first_output' | 'encoding' | 'finalizing';
/** What the watchdog knows, times in ms on the injected clock. */
export interface StallWatch {
  readonly startedAt: number;
  /** The first block with a frame or processed time; ffmpeg writes no block before its output is set up. */
  readonly firstOutputAt: number | null;
  /** The last time processed time or written bytes grew. */
  readonly lastAdvanceAt: number;
  readonly outTimeUs: number | null;
  readonly totalSize: number | null;
}
export interface StallAssessment { readonly phase: StallPhase; readonly quietMs: number; readonly budgetMs: number; readonly stalled: boolean }

/**
 * The phase and whether it has stalled (AC-ENGINE-04-4). Finalizing starts when the processed time
 * reaches the expected duration less 1 s, and its budget grows with the bytes written, since a
 * `+faststart` rewrite reports nothing. Without an expected duration the trailer cannot be told
 * apart, so encoding gets the larger of the two budgets.
 */
export function assessStall(watch: StallWatch, now: number, expectedDurationUs: number | null, lowUsage: boolean,
  thresholds: StallThresholds = STALL_THRESHOLDS): StallAssessment {
  if (watch.firstOutputAt === null) {
    const budgetMs = lowUsage ? thresholds.firstOutputLowUsageMs : thresholds.firstOutputMs;
    const quietMs = now - watch.startedAt;
    return { phase: 'before_first_output', quietMs, budgetMs, stalled: quietMs > budgetMs };
  }
  const quietMs = now - watch.lastAdvanceAt;
  const finalizingMs = thresholds.finalizingBaseMs + (watch.totalSize ?? 0) / thresholds.finalizingBytesPerSecond * 1000;
  if (expectedDurationUs !== null && (watch.outTimeUs ?? 0) >= expectedDurationUs - ENCODE_PROCESS_POLICY.finalizingLeadUs) {
    return { phase: 'finalizing', quietMs, budgetMs: finalizingMs, stalled: quietMs > finalizingMs };
  }
  const budgetMs = expectedDurationUs === null ? Math.max(thresholds.encodingMs, finalizingMs) : thresholds.encodingMs;
  return { phase: 'encoding', quietMs, budgetMs, stalled: quietMs > budgetMs };
}

// ── The run ────────────────────────────────────────────────────────────────────────────────────

export interface EncodeProcessRequest {
  /** The verified bundled ffmpeg (`MediaTools.ffmpeg`). */
  readonly ffmpeg: string;
  /** The arguments after {@link FFMPEG_COMMON_PREFIX} (which is added when missing); each input as {@link ffmpegInput} writes it. */
  readonly args: readonly string[];
  /** `userData/media-converter/work/<short id>`: the cwd, TEMP and where long filters are written (FK-PIT-0036). */
  readonly workDirectory: string;
  /** Normally {@link encodeEnvironment}. */
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Of the planned main stream; tells encoding from finalizing. Null when unknown. */
  readonly expectedDurationUs: number | null;
  /** The `-fs` value in `args`, or null when the run has none. */
  readonly capBytes: number | null;
  /** The file ffmpeg writes (the partial), measured after the process closed; the last argument is then `file:<outputPath>`. */
  readonly outputPath: string | null;
  readonly lowUsage: boolean;
  /** The paths the log tail replaces. */
  readonly redaction: RedactionPaths;
  readonly onSpawn?: (pid: number) => void;
  /** Every progress block, unthrottled; `atMs` is on the run's clock. */
  readonly onProgress?: (progress: ProgressState, atMs: number) => void;
}

export interface EncodeClock {
  now(): number;
  /** Calls `tick` every `intervalMs` until the returned function is called. */
  every(intervalMs: number, tick: () => void): () => void;
}
const systemClock: EncodeClock = {
  now: () => performance.now(),
  every: (intervalMs, tick) => {
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

export interface EncodeProcessDependencies {
  readonly spawn?: MediaSpawn;
  readonly setPriority?: (pid: number, priority: number) => void;
  readonly setAffinity?: (pid: number, mask: bigint, signal: AbortSignal) => Promise<void>;
  readonly logicalProcessors?: () => number;
  readonly platform?: NodeJS.Platform | string;
  readonly thresholds?: Partial<StallThresholds>;
  readonly clock?: EncodeClock;
  readonly closeGraceMs?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

export interface EncodeTuning {
  readonly priority: 'below_normal' | 'idle';
  readonly priorityApplied: boolean;
  /** Low-usage mode only; `abandoned` when ffmpeg ended before PowerShell did. */
  readonly affinity: 'not_requested' | 'applied' | 'failed' | 'abandoned';
  readonly affinityMask: bigint | null;
}

export type EncodeFailureCode = Extract<EngineReasonCode, 'encoder_stalled' | 'disk_full' | 'output_open_failed'>;

export interface EncodeRunResult {
  /** `not_started`: cancelled before the start, or the working directory could not be prepared. */
  readonly status: 'closed' | 'spawn_error' | 'close_unconfirmed' | 'not_started';
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  /** The spawn or preparation error code, such as `ENOENT`. */
  readonly errorCode: string | null;
  readonly cancelled: boolean;
  readonly stall: StallAssessment | null;
  readonly progress: ProgressState | null;
  /** `progress=end` arrived. */
  readonly sawEnd: boolean;
  /** A block with `frame > 0`: before it, a hardware encoder failure may fall back to another encoder. */
  readonly firstFrameSeen: boolean;
  /** The larger of the last reported size and the size of `outputPath` after close. */
  readonly outputBytes: number | null;
  /** The output reached the cap: ffmpeg cut it there and still exited 0. */
  readonly capHit: boolean;
  readonly failureCode: EncodeFailureCode | null;
  readonly stderrBytes: number;
  readonly tuning: EncodeTuning;
  /** Resolves when the process has closed; files may be removed only after it (AC-ENGINE-04-3). */
  readonly closed: Promise<void>;
  /** The end of stderr with every known path replaced and other absolute paths hidden. */
  redactedTail(maxBytes?: number): string;
}

const errorCode = (error: unknown, fallback = 'UNKNOWN') => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : fallback;
};
const defaultLog = (message: string, error?: unknown) => console.warn(`[media-converter] ${message}`, error ?? '');
const defaultSpawn: MediaSpawn = (command, args, options) => nodeSpawn(command, [...args], options);

/** Allowed share of the cap below it that still counts as reaching it. */
export const capSlackBytes = (capBytes: number) => Math.min(ENCODE_PROCESS_POLICY.capSlackBytes, Math.floor(capBytes * ENCODE_PROCESS_POLICY.capSlackShare));

function checkedArguments(request: EncodeProcessRequest): string[] {
  if (!isAbsoluteNormalized(request.ffmpeg)) throw new TypeError('The ffmpeg path must be absolute and normalized.');
  if (!isAbsoluteNormalized(request.workDirectory)) throw new TypeError('The working directory must be absolute and normalized.');
  if (request.outputPath !== null && !isAbsoluteNormalized(request.outputPath)) throw new TypeError('The output path must be absolute and normalized.');
  if (!Array.isArray(request.args) || request.args.length > ENCODE_PROCESS_POLICY.maxArguments
    || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('The ffmpeg arguments are invalid.');
  if (typeof request.env !== 'object' || request.env === null || Object.values(request.env).some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new TypeError('The ffmpeg environment is invalid.');
  }
  if (request.expectedDurationUs !== null && !(Number.isSafeInteger(request.expectedDurationUs) && request.expectedDurationUs >= 0)) {
    throw new TypeError('The expected duration is invalid.');
  }
  const prefixed = FFMPEG_COMMON_PREFIX.every((arg, index) => request.args[index] === arg);
  const body = prefixed ? request.args.slice(FFMPEG_COMMON_PREFIX.length) : [...request.args];
  const reserved = body.find(arg => RESERVED_OPTIONS.has(arg));
  if (reserved) throw new TypeError(`The common prefix owns ${reserved}.`);
  assertGuardedInputs(body);
  const cap = body.indexOf('-fs');
  if (request.capBytes === null ? cap !== -1
    : !(Number.isSafeInteger(request.capBytes) && request.capBytes > 0 && cap !== -1 && body[cap + 1] === String(request.capBytes))) {
    throw new TypeError('The byte cap and the -fs argument disagree.');
  }
  // The cap is judged on this file's size after close, so it must be the file ffmpeg writes, as a file: URL.
  if (request.outputPath !== null && body.at(-1) !== `file:${request.outputPath}`) throw new TypeError('The output path is not the file ffmpeg writes.');
  return [...FFMPEG_COMMON_PREFIX, ...body];
}

const tuningOf = (lowUsage: boolean): EncodeTuning => ({ priority: lowUsage ? 'idle' : 'below_normal', priorityApplied: false, affinity: 'not_requested', affinityMask: null });

function unstarted(lowUsage: boolean, cancelled: boolean, code: string | null): EncodeRunResult {
  return Object.freeze({ status: 'not_started', pid: null, exitCode: null, signalCode: null, errorCode: code, cancelled, stall: null, progress: null, sawEnd: false,
    firstFrameSeen: false, outputBytes: null, capHit: false, failureCode: code === 'ENOSPC' ? 'disk_full' : null, stderrBytes: 0, tuning: tuningOf(lowUsage),
    closed: Promise.resolve(), redactedTail: () => '' });
}

/**
 * Runs one ffmpeg pass to the end and reports what happened. Never rejects for a process failure:
 * a start failure is `spawn_error`, a stall or a cancel kills the process, and the result settles
 * once the process has closed (or `closeGraceMs` after it was killed or exited without closing,
 * with `closed` still pending). Throws only for invalid arguments.
 */
export async function runEncodeProcess(request: EncodeProcessRequest, dependencies: EncodeProcessDependencies = {}): Promise<EncodeRunResult> {
  const args = checkedArguments(request);
  const thresholds: StallThresholds = { ...STALL_THRESHOLDS, ...dependencies.thresholds };
  if (Object.values(thresholds).some(value => !(Number.isFinite(value) && value > 0))) throw new TypeError('A stall threshold is invalid.');
  const clock = dependencies.clock ?? systemClock;
  const log = dependencies.log ?? defaultLog;
  const platform = dependencies.platform ?? process.platform;
  if (request.signal?.aborted) return unstarted(request.lowUsage, true, null);

  const prepared = externalizeLongFilters(args, request.workDirectory);
  if (commandLineChars(request.ffmpeg, prepared.args) > ENCODE_PROCESS_POLICY.maxCommandLineChars) throw new RangeError('The ffmpeg command line is too long.');
  try {
    await mkdir(request.workDirectory, { recursive: true });
    for (const file of prepared.files) await writeFile(file.path, file.content, 'utf8');
  } catch (error) {
    return unstarted(request.lowUsage, false, errorCode(error));
  }
  if (request.signal?.aborted) return unstarted(request.lowUsage, true, null);

  const spawn = dependencies.spawn ?? defaultSpawn;
  const redact = createLogRedactor(request.redaction);
  const ring = new ByteRing(ENCODE_PROCESS_POLICY.stderrBytes);
  const parser = new ProgressParser();
  const decoder = new StringDecoder('utf8');
  const tuning: { -readonly [K in keyof EncodeTuning]: EncodeTuning[K] } = tuningOf(request.lowUsage);
  const affinityStop = new AbortController();
  let confirmClose!: () => void;
  const closed = new Promise<void>(resolve => { confirmClose = resolve; });

  return new Promise<EncodeRunResult>(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(request.ffmpeg, prepared.args, { cwd: request.workDirectory, env: { ...request.env } as NodeJS.ProcessEnv, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      confirmClose();
      resolve(Object.freeze({ ...unstarted(request.lowUsage, false, errorCode(error)), status: 'spawn_error' as const, failureCode: null }));
      return;
    }

    let progress: ProgressState | null = null;
    let firstFrameSeen = false;
    let watch: { -readonly [K in keyof StallWatch]: StallWatch[K] } = { startedAt: clock.now(), firstOutputAt: null, lastAdvanceAt: clock.now(), outTimeUs: null, totalSize: null };
    let stall: StallAssessment | null = null;
    let cancelled = false;
    let spawned = false;
    let settled = false;
    let killed = false;
    let spawnError: string | null = null;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let stdioError: string | null = null;
    let stderrPending = '';
    const stderrFailures = new Set<StderrFailure>();
    let progressCallbackFailed = false;
    let stopWatchdog: (() => void) | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    const closeGraceMs = dependencies.closeGraceMs ?? ENCODE_PROCESS_POLICY.closeGraceMs;

    const armCloseDeadline = () => {
      if (closeTimer || settled) return;
      closeTimer = setTimeout(() => finish('close_unconfirmed', exited?.code ?? null, exited?.signal ?? null), closeGraceMs);
      closeTimer.unref?.();
    };
    const kill = () => {
      if (killed || settled) return;
      killed = true;
      // On Windows this is TerminateProcess; files are touched only after `close`.
      try { child.kill(); } catch (error) { stdioError ??= errorCode(error, 'KILL_FAILED'); }
      armCloseDeadline();
    };
    const onAbort = () => { cancelled = true; kill(); };

    const scanStderr = (text: string, final = false) => {
      stderrPending += text;
      const lines = stderrPending.split(/\r\n|\n|\r/);
      stderrPending = final ? '' : lines.pop() ?? '';
      if (stderrPending.length > ENCODE_PROCESS_POLICY.stderrLineBytes) { lines.push(stderrPending); stderrPending = ''; }
      for (const line of lines) {
        if (!line) continue;
        const failure = classifyStderrLine(redact(line.slice(0, ENCODE_PROCESS_POLICY.stderrLineBytes)));
        if (failure) stderrFailures.add(failure);
      }
    };
    const onBlocks = (blocks: ReturnType<ProgressParser['push']>) => {
      for (const block of blocks) {
        const before = progress;
        progress = mergeProgress(progress, block);
        const now = clock.now();
        if ((progress.frame ?? 0) > 0) firstFrameSeen = true;
        if (watch.firstOutputAt === null && ((progress.frame ?? 0) > 0 || (progress.outTimeUs ?? 0) > 0)) watch = { ...watch, firstOutputAt: now, lastAdvanceAt: now };
        if ((progress.outTimeUs ?? 0) > (before?.outTimeUs ?? 0) || (progress.totalSize ?? 0) > (before?.totalSize ?? 0)) watch.lastAdvanceAt = now;
        watch.outTimeUs = progress.outTimeUs;
        watch.totalSize = progress.totalSize;
        try { request.onProgress?.(progress, now); }
        catch (error) {
          if (!progressCallbackFailed) log('A progress listener failed', error);
          progressCallbackFailed = true;
        }
      }
    };

    function onSpawn() {
      spawned = true;
      const pid = child.pid!;
      const now = clock.now();
      watch = { ...watch, startedAt: now, lastAdvanceAt: now };
      try {
        (dependencies.setPriority ?? os.setPriority)(pid, request.lowUsage ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL);
        tuning.priorityApplied = true;
      } catch (error) { log('Could not lower the ffmpeg priority', error); }
      if (request.lowUsage && platform === 'win32') {
        const setAffinity = dependencies.setAffinity ?? ((id: number, value: bigint, signal: AbortSignal) => setAffinityWithPowerShell(id, value, signal));
        // Inside a promise, so even a setter that throws at once only fails the affinity, never the run.
        void Promise.resolve().then(() => {
          const mask = lowUsageAffinityMask((dependencies.logicalProcessors ?? os.availableParallelism)());
          tuning.affinityMask = mask;
          return setAffinity(pid, mask, affinityStop.signal);
        }).then(
          () => { if (!affinityStop.signal.aborted) tuning.affinity = 'applied'; },
          error => { if (!affinityStop.signal.aborted) { tuning.affinity = 'failed'; log('Could not limit ffmpeg to the low-usage processors', error); } });
      }
      try { request.onSpawn?.(pid); } catch (error) { log('A spawn listener failed', error); }
      stopWatchdog = clock.every(thresholds.checkIntervalMs, () => {
        if (settled || killed) return;
        const assessment = assessStall(watch, clock.now(), request.expectedDurationUs, request.lowUsage, thresholds);
        if (assessment.stalled) { stall = assessment; kill(); }
      });
      if (cancelled) kill();
    }
    function onError(error: Error) {
      if (!spawned && !child.pid) { spawnError = errorCode(error); finish('spawn_error', null, null); return; }
      stdioError ??= errorCode(error);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      exited = { code: Number.isInteger(code) ? code : null, signal: signal ?? null };
      armCloseDeadline();
    }
    function onClose(exitCode: number | null, signalCode: NodeJS.Signals | null) {
      confirmClose();
      // A close after the run settled without it only confirms the process is gone; the listener heard the last of it then.
      if (settled) return;
      onBlocks(parser.finish());
      scanStderr(decoder.end(), true);
      finish(spawnError && !spawned ? 'spawn_error' : 'closed', Number.isInteger(exitCode) ? exitCode : null, signalCode ?? null);
    }
    const onStdout = (chunk: Buffer) => onBlocks(parser.push(chunk));
    const onStderr = (chunk: Buffer) => { ring.push(chunk); scanStderr(decoder.write(chunk)); };
    const onStreamError = (error: Error) => { stdioError ??= errorCode(error, 'PIPE_FAILED'); kill(); };

    function finish(status: EncodeRunResult['status'], exitCode: number | null, signalCode: NodeJS.Signals | null) {
      if (settled) return;
      settled = true;
      stopWatchdog?.();
      if (closeTimer) clearTimeout(closeTimer);
      if (tuning.affinityMask !== null && tuning.affinity === 'not_requested') tuning.affinity = 'abandoned';
      affinityStop.abort();
      request.signal?.removeEventListener('abort', onAbort);
      child.removeListener('spawn', onSpawn);
      child.removeListener('exit', onExit);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      if (status === 'close_unconfirmed' || status === 'spawn_error') {
        // Keep listening, so `closed` still tells when the process is really gone.
        child.on('error', () => undefined);
        child.once('close', () => confirmClose());
        child.stdout?.resume();
        child.stderr?.resume();
        if (status === 'spawn_error' && !child.pid) confirmClose();
      }
      void (async () => {
        const fileBytes = request.outputPath && status !== 'spawn_error' ? await stat(request.outputPath).then(info => info.size, () => null) : null;
        const reported = progress?.totalSize ?? null;
        const outputBytes = reported === null && fileBytes === null ? null : Math.max(reported ?? 0, fileBytes ?? 0);
        const capHit = request.capBytes !== null && outputBytes !== null && outputBytes >= request.capBytes - capSlackBytes(request.capBytes);
        const diskFull = stderrFailures.has('disk_full') || stdioError === 'ENOSPC' || spawnError === 'ENOSPC';
        // A full disk is the cause the user can act on, even when ffmpeg then hung on it until the watchdog stopped it.
        const failureCode: EncodeFailureCode | null = diskFull ? 'disk_full' : stall ? 'encoder_stalled' : stderrFailures.has('output_open_failed') ? 'output_open_failed' : null;
        const finalProgress: ProgressState | null = progress;
        resolve(Object.freeze({
          status, pid: child.pid ?? null, exitCode, signalCode, errorCode: spawnError, cancelled, stall, progress: finalProgress,
          sawEnd: finalProgress?.ended ?? false, firstFrameSeen, outputBytes, capHit, failureCode, stderrBytes: ring.total, tuning: Object.freeze({ ...tuning }), closed,
          redactedTail: (maxBytes: number = ENCODE_PROCESS_POLICY.tailBytes) => redactedLogTail(ring.contents(), maxBytes, redact, ring.total > ring.capacity),
        }));
      })();
    }

    child.once('spawn', onSpawn);
    child.on('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
    child.stdout?.on('data', onStdout);
    child.stdout?.on('error', onStreamError);
    child.stderr?.on('data', onStderr);
    child.stderr?.on('error', onStreamError);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
  });
}

// ── Success judgement ──────────────────────────────────────────────────────────────────────────

/**
 * Why a run did not succeed. Each maps to an engine reason code: the three process codes as they
 * are, `cap_reached` to `output_cap_exceeded` (the executor reports the plan's own cap meaning,
 * such as `not_smaller`, instead), a start failure to `runtime_spawn_failed`, everything else to
 * `unknown`, whose detail is the redacted log tail.
 */
export type EncodeFailureReason = 'cancelled' | 'not_started' | 'spawn_failed' | EncodeFailureCode | 'cap_reached' | 'exit_code' | 'no_progress_end'
  | 'output_unreadable' | 'streams_missing' | 'duration_mismatch' | 'nothing_processed';
export interface EncodeFailure { readonly reason: EncodeFailureReason; readonly code: EngineReasonCode; readonly detail: string }

const CODES: Partial<Record<EncodeFailureReason, EngineReasonCode>> = {
  encoder_stalled: 'encoder_stalled', disk_full: 'disk_full', output_open_failed: 'output_open_failed', cap_reached: 'output_cap_exceeded',
  spawn_failed: 'runtime_spawn_failed',
};
const failure = (run: EncodeRunResult, reason: EncodeFailureReason): EncodeFailure => Object.freeze({ reason, code: CODES[reason] ?? 'unknown', detail: run.redactedTail() });

/** What the process alone says against success, before the output is probed; null when the output is worth probing. */
export function runFailure(run: EncodeRunResult): EncodeFailure | null {
  if (run.cancelled) return failure(run, 'cancelled');
  if (run.failureCode) return failure(run, run.failureCode);
  if (run.status === 'not_started') return failure(run, 'not_started');
  if (run.status === 'spawn_error') return failure(run, 'spawn_failed');
  // A process not seen closing may still be writing: its size proves no cap, and nothing may be published or skipped on it.
  if (run.status !== 'closed') return failure(run, 'exit_code');
  if (run.capHit) return failure(run, 'cap_reached');
  if (run.exitCode !== 0) return failure(run, 'exit_code');
  if (!run.sawEnd) return failure(run, 'no_progress_end');
  return null;
}

/** Streams of each kind the plan writes to this output. */
export interface PlannedStreamCounts { readonly video: number; readonly audio: number; readonly subtitles: number; readonly covers?: number }

export interface EncodeOutputCheck {
  /** The output as ffprobe read it after the run; null when it could not be read. */
  readonly output: MediaInfo | null;
  readonly streams: PlannedStreamCounts;
  /** The planned main stream's duration (the extracted track when extracting audio), else the source container's; null when unknown. */
  readonly expectedDurationUs: number | null;
  /**
   * Where the expectation came from, so like is compared with like: the source's main stream
   * (default) against the output's main stream, or the source container (the main stream had no
   * duration) against the output's container.
   */
  readonly expectedFrom?: 'main_stream' | 'container';
  /** The source container's duration, when the expectation came from a stream: the two disagreeing make the duration unverifiable. */
  readonly sourceContainerDurationUs?: number | null;
}

export type EncodeVerdict =
  | { readonly ok: true; readonly warnings: readonly Extract<EngineReasonCode, 'duration_unverified'>[]; readonly durationUs: number | null }
  | { readonly ok: false; readonly failure: EncodeFailure };

/** max(2 s, 1 %) of the expected duration. */
export const durationToleranceUs = (expectedUs: number) => Math.max(2_000_000, Math.round(expectedUs * 0.01));

/**
 * The success judgement of AC-ENGINE-04-5: the process succeeded (exit 0, `progress=end`, no
 * cap, no stall), the output parses and holds every planned stream, and its duration is within
 * max(2 s, 1 %) of the expected one. When that duration is unknown, or the source's stream and
 * container durations contradict each other, only a processed time above zero is required, with
 * the warning `duration_unverified`. The output's own durations are never excused that way: a main
 * stream cut short under a container kept long by another stream is exactly what this catches.
 */
export function judgeEncode(run: EncodeRunResult, check: EncodeOutputCheck): EncodeVerdict {
  const failed = runFailure(run);
  if (failed) return { ok: false, failure: failed };
  const fail = (reason: EncodeFailureReason): EncodeVerdict => ({ ok: false, failure: failure(run, reason) });
  const { output, streams, expectedDurationUs } = check;
  if (!output) return fail('output_unreadable');
  if (output.video.length < streams.video || output.audio.length < streams.audio || output.subtitles.length < streams.subtitles
    || output.covers.length < (streams.covers ?? 0)) return fail('streams_missing');
  const unverified = (): EncodeVerdict => (run.progress?.outTimeUs ?? 0) > 0
    ? { ok: true, warnings: ['duration_unverified'], durationUs: null } : fail('nothing_processed');
  if (expectedDurationUs === null) return unverified();
  const tolerance = durationToleranceUs(expectedDurationUs);
  const source = check.sourceContainerDurationUs ?? null;
  if (source !== null && Math.abs(source - expectedDurationUs) > tolerance) return unverified();
  const main = streams.video > 0 ? output.video.find(video => video.index === output.primaryVideoIndex) ?? output.video[0] : output.audio[0];
  const streamUs = main?.durationUs ?? null;
  const actual = check.expectedFrom === 'container' ? output.durationUs ?? streamUs : streamUs ?? output.durationUs;
  if (actual === null) return unverified();
  if (Math.abs(actual - expectedDurationUs) > tolerance) return fail('duration_mismatch');
  return { ok: true, warnings: [], durationUs: actual };
}
