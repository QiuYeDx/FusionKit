import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  VIDEO_ENCODERS, type DiskSpace, type ItemFailureCode, type ItemPhase, type ItemProgress, type PlanSummary, type PlanWarning, type PlanWarningCode,
  type VariantKey, type VideoEncoderId,
} from '../../../../src/media-converter/contract';
import { toFfmpegArgs } from '../plan/args';
import { buildPlan } from '../plan/stream-plan';
import type { ConversionPlan, PlannedOutput } from '../plan/types';
import type {
  CapabilitiesAnswer, ExecutionHooks, ExecutionJob, ExecutionOutcome, MediaExecutor, OutputTargetName, PublishedOutput, QueuePlanner,
} from '../queue/types';
import type { MediaFailCode, MediaFailInjection } from '../test-hooks';
import { isHardwareConfiguration } from './capabilities';
import type { InputRegistry } from './inputs';
import { OutputError, numberedName, type MediaOutputs, type OutputConflictPolicy, type PartialFile, type PublishResult } from './output';
import type { ProbeOutcome } from './probe';
import {
  ENCODE_PROCESS_POLICY, encodeEnvironment, judgeEncode, runEncodeProcess, runFailure,
  type EncodeFailure, type EncodeFailureReason, type EncodeProcessDependencies, type EncodeRunResult, type PlannedStreamCounts,
} from './process';
import { ProgressTracker, utf8Tail, type ProgressState } from './progress';
import { runtimeFailureCode, type MediaRuntime, type MediaTools } from './runtime';

/**
 * The executor (design §5, R-ENGINE-03/04/06): one item of the queue from start to end, where the
 * engine and encode meet. It takes the verified runtime (verified again, and the run tried once
 * more, when ffmpeg cannot be started: design §1), checks the input once more, then checks
 * every output before anything runs (`output_is_input`, the batch's names, the folder, FAT32 and the
 * space of each volume, AC-ENGINE-06-3/4). Each output is then written to its own exclusive partial
 * (recorded in partials.json first, AC-ENGINE-06-1) with exactly `toFfmpegArgs`, which alone adds
 * `-fs` and `-t`; the run is judged (AC-ENGINE-04-5), the partial probed again, a compress result
 * compared with its source (`not_smaller`), and only then published, numbered or over a confirmed
 * file moved to the recycle bin. A hardware encoder that fails before its first frame is degraded
 * for the session and the item planned again once, from its frozen settings and the current table
 * (AC-ENGINE-03-3). Several outputs ("all tracks") are published one by one; a failure after some
 * were published is a failure that lists them ("partly done m/n"), and so is a cancel (the files
 * stay and can be shown). Whatever ends the item, ffmpeg is seen closing before its partial, its
 * 2-pass logs and its work folder are removed (AC-ENGINE-04-3).
 */

export const EXECUTOR_POLICY = Object.freeze({
  /**
   * After a cancel or a failure, how long the clean-up waits for ffmpeg to close before it removes
   * the files anyway. What it cannot remove then stays in partials.json for the startup cleanup.
   */
  closeWaitMs: 10_000,
  /** Lines of unexpected warnings logged after a successful run. */
  warningLinesLogged: 8,
});

/**
 * Warnings the bundled ffmpeg prints on runs exactly as the planner meant them (module-encode design
 * §7b): they never fail a run, and are not reported. Every other warning of a successful run is
 * logged for diagnosis; none fails it (AC-ENGINE-04-5 judges the output, not the log).
 */
export const TOLERATED_WARNINGS: readonly RegExp[] = Object.freeze([
  // swscale's note on yuvj sources (MJPEG, JPEG pictures); the planner sets the range itself (design §4).
  /\[warning\] deprecated pixel format used, make sure you did set range correctly/,
  // The ipod muxer (M4A) writes the `.partial`, an extension it does not know; the published name has the right one.
  /\[ipod @ [^\]]*\] \[warning\] Warning, extension is not \.m4a nor \.m4v/,
  // The native AAC encoder keeping a frame within the format's maximum.
  /\[(?:enc:)?aac @ [^\]]*\] \[warning\] Too many bits [\d.]+ > \d+ per frame requested, clamping to max/,
  // PCM without a channel mask: ffmpeg takes the usual layout of that channel count.
  /\[warning\] Guessed Channel Layout: /,
  // openh264 on every run of the planner's parameters: bit-rate mode without frame skipping, which the planner chose (no dropped frames).
  /\[libopenh264 @ [^\]]*\] \[warning\] \[OpenH264\] this = 0x[0-9a-f]+, Warning:bEnableFrameSkip = 0,bitrate can't be controlled for /i,
]);

/** A line of a `level+warning` log at warning level or worse. */
const WARNING_LINE = /\[(?:warning|error|fatal|panic)\]/;

/** The warning and error lines of a log that {@link TOLERATED_WARNINGS} does not cover. */
export function unexpectedWarnings(log: string): string[] {
  return log.split(/\r\n|\n|\r/).filter(line => WARNING_LINE.test(line) && !TOLERATED_WARNINGS.some(pattern => pattern.test(line)));
}

// ── Dependencies ───────────────────────────────────────────────────────────────────────────────

/** The capability table (`MediaCapabilities`): the current table to plan with, and the session's degradations. */
export interface ExecutorCapabilities {
  planner(): Promise<CapabilitiesAnswer>;
  markDegraded(encoder: VideoEncoderId): void;
}

export type ExecutorOutputs = Pick<MediaOutputs, 'preflight' | 'createPartial' | 'discardPartial' | 'publish' | 'release' | 'endBatch' | 'workDirectory'
  | 'removeWorkDirectory'>;

/** `MediaProber.probe`: never rejects; a failure is its code. */
export interface ExecutorProber {
  probe(filePath: string): Promise<ProbeOutcome>;
}

/** `MediaRuntime`: `acquire` gives the verified bundled ffmpeg; `invalidate` makes the next `acquire` verify it again. */
export type ExecutorRuntime = Pick<MediaRuntime, 'acquire'> & Partial<Pick<MediaRuntime, 'invalidate'>>;

export interface MediaConversionExecutorOptions {
  /** The verified bundled ffmpeg; verified again when it cannot be started (design §1). */
  runtime: ExecutorRuntime;
  /** `InputRegistry.verify`: the input is still the file that was added (`input_missing`, `input_changed`). */
  inputs: Pick<InputRegistry, 'verify'>;
  outputs: ExecutorOutputs;
  /** Reads each finished partial back before it is published. */
  prober: ExecutorProber;
  capabilities: ExecutorCapabilities;
  /** `buildPlan`, for the plan of a fallback; tests wrap it. */
  planner?: QueuePlanner;
  /** `runEncodeProcess` and its dependencies (spawn, priority, stall thresholds, clock); tests wrap them. */
  process?: {
    run?: typeof runEncodeProcess;
    dependencies?: EncodeProcessDependencies;
  };
  /** `FUSIONKIT_TEST_MEDIA_FAIL`, as `resolveMediaTestHooks` passed it (never in an installed build). */
  failure?: MediaFailInjection | null;
  /** Item work folders: `work/<8 hex>`. */
  createWorkId?: () => string;
  closeWaitMs?: number;
  /** Where SystemRoot and friends of the reduced environment come from; defaults to `process.env`. */
  sourceEnvironment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform | string;
  log?: (message: string, error?: unknown) => void;
}

// ── Plan facts ─────────────────────────────────────────────────────────────────────────────────

const VIDEO_ENCODER_IDS: ReadonlySet<string> = new Set(VIDEO_ENCODERS);

/** The encoded main video of an output: which encoder and configuration, and the source stream it came from. */
interface VideoEncode {
  readonly encoder: VideoEncoderId;
  readonly variant: VariantKey;
  readonly sourceIndex: number;
  readonly hardware: boolean;
}

function videoEncode(output: PlannedOutput): VideoEncode | null {
  for (const decision of output.streams) {
    if (decision.action !== 'encode' || decision.source.kind !== 'video' || decision.encode.variant === null) continue;
    const encoder = decision.encode.encoder;
    if (!VIDEO_ENCODER_IDS.has(encoder)) continue;
    const variant = decision.encode.variant;
    return { encoder: encoder as VideoEncoderId, variant, sourceIndex: decision.source.index, hardware: isHardwareConfiguration(encoder as VideoEncoderId, variant) };
  }
  return null;
}

/** Streams of each kind the output must hold when probed back. */
function plannedStreams(output: PlannedOutput): PlannedStreamCounts {
  const counts = { video: 0, audio: 0, subtitles: 0, covers: 0 };
  for (const decision of output.streams) {
    if (decision.action === 'drop') continue;
    if (decision.source.kind === 'video') counts.video++;
    else if (decision.source.kind === 'audio') counts.audio++;
    else if (decision.source.kind === 'subtitle') counts.subtitles++;
    else counts.covers++;
  }
  return counts;
}

/** The queue named every output from the plan it started with; a plan whose outputs differ cannot be written under those names. */
const targetsFit = (plan: Readonly<ConversionPlan>, targets: readonly OutputTargetName[]) => plan.outputs.length > 0 && plan.outputs.length === targets.length
  && plan.outputs.every((output, index) => output.container.extension.toLowerCase() === targets[index].extension.toLowerCase());

/**
 * A failure before the first frame that a hardware encoder can cause: it exited, hung or wrote
 * nothing usable. A cancel, a full disk, an output that cannot be opened, the cap or a process
 * that never started are not the encoder's doing.
 */
const ENCODER_FAILURES: ReadonlySet<EncodeFailureReason> = new Set(['exit_code', 'no_progress_end', 'encoder_stalled', 'output_unreadable', 'streams_missing',
  'duration_mismatch', 'nothing_processed']);
/** The failures of one output's own encode; the next output of the item ("all tracks") is still worth writing after them. */
const OUTPUT_FAILURES: ReadonlySet<EncodeFailureReason> = new Set([...ENCODER_FAILURES, 'cap_reached']);

/** The item code of a process failure: an encode that failed for no more specific reason is `encode_failed`. */
const itemCode = (failure: EncodeFailure): ItemFailureCode => failure.code === 'unknown' ? 'encode_failed' : failure.code;

/** What each check of the output adds to the end of the log, so a failed item says why even when ffmpeg did not. */
const REASON_TEXT: Readonly<Partial<Record<EncodeFailureReason, string>>> = {
  exit_code: 'ffmpeg ended with an error.',
  no_progress_end: 'ffmpeg ended without finishing the output.',
  output_unreadable: 'The output could not be read back.',
  streams_missing: 'The output lacks a planned stream.',
  duration_mismatch: 'The output is shorter or longer than its source.',
  nothing_processed: 'Nothing was processed.',
  cap_reached: 'The output reached its size cap.',
  encoder_stalled: 'ffmpeg made no progress and was stopped.',
  disk_full: 'The disk became full.',
  output_open_failed: 'The output file could not be opened.',
  not_started: 'ffmpeg could not be prepared.',
  spawn_failed: 'ffmpeg could not be started.',
};
const withReason = (log: string, reason: string | undefined) => {
  if (!reason) return log;
  const line = `[media-converter] ${reason}`;
  return log ? `${log.replace(/\n+$/, '')}\n${line}` : line;
};

/**
 * `disk_space_low` carries what the volume needs and has (AC-ENGINE-06-4): the outcome hands the
 * bytes to the item's failed state for the interface, and the log says the same in words.
 */
function preflightLog(error: OutputError): string {
  if (error.code !== 'disk_space_low' || !error.space) return `[media-converter] ${error.message}`;
  const { requiredBytes, availableBytes } = error.space;
  const size = (bytes: number) => `${bytes} bytes (${(bytes / 1024 ** 3).toFixed(2)} GiB)`;
  return `[media-converter] Not enough free space on the output volume: ${size(requiredBytes)} needed `
    + `(the size caps of every running output on it plus 512 MB), ${size(availableBytes)} free.`;
}

// ── Injected failures (FUSIONKIT_TEST_MEDIA_FAIL) ─────────────────────────────────────────────

const ADDRESS = '0000000000000000';
/** The stderr lines each failure prints at `level+warning`, as captured from the bundled ffmpeg (test/media-converter/fixtures/capabilities). */
function injectedLines(code: MediaFailCode, encoder: string, muxer: string): string[] {
  const opening = [
    `[vost#0:0/${encoder} @ ${ADDRESS}] [enc:${encoder} @ ${ADDRESS}] [error] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.`,
    `[vost#0:0/${encoder} @ ${ADDRESS}] [enc:${encoder} @ ${ADDRESS}] [error] Could not open encoder before EOF`,
    `[vost#0:0/${encoder} @ ${ADDRESS}] [error] Task finished with error code: -22 (Invalid argument)`,
    `[out#0/${muxer} @ ${ADDRESS}] [error] Nothing was written into output file, because at least one of its streams received no packets.`,
  ];
  switch (code) {
    case 'driver_too_old': return [
      `[${encoder} @ ${ADDRESS}] [error] Driver does not support the required nvenc API version. Required: 13.0 Found: 12.2`,
      `[${encoder} @ ${ADDRESS}] [error] The minimum required Nvidia driver for nvenc is 570.0 or newer`, ...opening];
    case 'no_device': return [`[${encoder} @ ${ADDRESS}] [fatal] No capable devices found`, ...opening];
    case 'session_limit': return [`[${encoder} @ ${ADDRESS}] [error] OpenEncodeSessionEx failed: out of memory (10): (no details)`,
      `[${encoder} @ ${ADDRESS}] [fatal] No capable devices found`, ...opening];
    case 'params_rejected': return [`[${encoder} @ ${ADDRESS}] [error] InitializeEncoder failed: invalid param (8): (no details)`, ...opening];
    case 'unknown': case 'encode_failed': return opening;
    case 'encoder_stalled': return [];
    case 'disk_full': return [`[out#0/${muxer} @ ${ADDRESS}] [error] Error writing trailer: No space left on device`];
    case 'output_open_failed': return [`[out#0/${muxer} @ ${ADDRESS}] [error] Error opening output <output>: Permission denied`];
  }
}

/**
 * The run an injected failure stands for: ended before its first frame, with the failure's own
 * stderr, as `runEncodeProcess` reports the real one. No ffmpeg is started.
 */
function injectedRun(code: MediaFailCode, output: PlannedOutput, lowUsage: boolean): EncodeRunResult {
  const encoder = videoEncode(output)?.encoder
    ?? output.streams.find(decision => decision.action === 'encode')?.encode.encoder ?? 'ffmpeg';
  const text = [...injectedLines(code, encoder, output.container.muxer), `[FUSIONKIT_TEST_MEDIA_FAIL] ${code} was injected into the first run of this item.`]
    .join('\n') + '\n';
  const failureCode = code === 'encoder_stalled' || code === 'disk_full' || code === 'output_open_failed' ? code : null;
  return Object.freeze({
    status: 'closed', pid: null, exitCode: 1, signalCode: null, errorCode: null, cancelled: false,
    stall: code === 'encoder_stalled' ? { phase: 'before_first_output', quietMs: 300_001, budgetMs: 300_000, stalled: true } : null,
    progress: null, sawEnd: false, firstFrameSeen: false, outputBytes: 0, capHit: false, failureCode, stderrBytes: Buffer.byteLength(text),
    tuning: { priority: lowUsage ? 'idle' : 'below_normal', priorityApplied: false, affinity: 'not_requested', affinityMask: null },
    closed: Promise.resolve(), redactedTail: (maxBytes: number = ENCODE_PROCESS_POLICY.tailBytes) => utf8Tail(text, maxBytes),
  } satisfies EncodeRunResult);
}

// ── The run of one item ────────────────────────────────────────────────────────────────────────

interface ItemRun {
  readonly job: ExecutionJob;
  readonly hooks: ExecutionHooks;
  /** The runtime as last verified: replaced when ffmpeg could not be started and the runtime was verified again. */
  tools: MediaTools;
  readonly workId: string;
  readonly workDirectory: string;
  /** Who holds each output's name and space: the item id with the output's index. */
  readonly owners: readonly string[];
  readonly tracker: ProgressTracker;
  /** The plan as it runs: the frozen one, or the one planned again after a fallback. */
  plan: Readonly<ConversionPlan>;
  /** Set when the plan changed (`encoder_fallback`). */
  summary: PlanSummary | undefined;
  fellBack: boolean;
  readonly warnings: Set<PlanWarningCode>;
  phase: ItemPhase | null;
  progressFailed: boolean;
}

type Attempt =
  | { readonly kind: 'published'; readonly output: PublishedOutput }
  | { readonly kind: 'not_smaller' }
  | { readonly kind: 'cancelled' }
  | {
    readonly kind: 'failed'; readonly code: ItemFailureCode; readonly log: string | null;
    /** The next output of the item may still be written. */
    readonly continuable: boolean;
    /** A hardware encoder failed before its first frame: it was degraded, and the item may plan again once. */
    readonly fallback: VideoEncode | null;
    /** `disk_space_low` of the fallback's own check. */
    readonly space?: DiskSpace;
  };

type Check = { readonly ok: true } | { readonly ok: false; readonly code: ItemFailureCode; readonly log: string | null; readonly space?: DiskSpace };
type Failure = { readonly code: ItemFailureCode; readonly log: string | null; readonly space?: DiskSpace };

const CANCELLED: ExecutionOutcome = Object.freeze({ status: 'cancelled' });
const defaultLog = (message: string, error?: unknown) => console.warn(`[media-converter] ${message}`, error ?? '');
const describe = (error: unknown) => `[media-converter] ${error instanceof Error ? error.message : String(error)}`;

/**
 * `MediaExecutor` of the queue. One instance per app: it keeps which items had their failure
 * injected (`FUSIONKIT_TEST_MEDIA_FAIL`) and releases the batch's names when the queue says so.
 */
export class MediaConversionExecutor implements MediaExecutor {
  readonly #runtime: ExecutorRuntime;
  readonly #inputs: Pick<InputRegistry, 'verify'>;
  readonly #outputs: ExecutorOutputs;
  readonly #prober: ExecutorProber;
  readonly #capabilities: ExecutorCapabilities;
  readonly #planner: QueuePlanner;
  readonly #run: typeof runEncodeProcess;
  readonly #processDependencies: EncodeProcessDependencies | undefined;
  readonly #failure: MediaFailInjection | null;
  readonly #injected = new Set<string>();
  readonly #createWorkId: () => string;
  readonly #closeWaitMs: number;
  readonly #sourceEnvironment: Readonly<Record<string, string | undefined>> | undefined;
  readonly #platform: NodeJS.Platform | string;
  readonly #log: (message: string, error?: unknown) => void;

  constructor(options: MediaConversionExecutorOptions) {
    this.#runtime = options.runtime;
    this.#inputs = options.inputs;
    this.#outputs = options.outputs;
    this.#prober = options.prober;
    this.#capabilities = options.capabilities;
    this.#planner = options.planner ?? buildPlan;
    this.#run = options.process?.run ?? runEncodeProcess;
    this.#processDependencies = options.process?.dependencies;
    this.#failure = options.failure ?? null;
    this.#createWorkId = options.createWorkId ?? (() => randomBytes(4).toString('hex'));
    this.#closeWaitMs = options.closeWaitMs ?? EXECUTOR_POLICY.closeWaitMs;
    this.#sourceEnvironment = options.sourceEnvironment;
    this.#platform = options.platform ?? process.platform;
    this.#log = options.log ?? defaultLog;
  }

  /** The batch is over: the names it published may be taken again. */
  endBatch(): void {
    this.#outputs.endBatch();
  }

  async run(job: ExecutionJob, hooks: ExecutionHooks): Promise<ExecutionOutcome> {
    const { signal } = hooks;
    if (signal.aborted) return CANCELLED;
    let tools: MediaTools;
    try { tools = await this.#runtime.acquire(); }
    catch (error) { return { status: 'failed', code: runtimeFailureCode(error), outputs: [], log: describe(error) }; }
    if (signal.aborted) return CANCELLED;
    // The queue checked the input before the run; the runtime check may have taken a second since.
    const input = await this.#inputs.verify(job.itemId).catch(() => 'input_missing' as const);
    if (input) return { status: 'failed', code: input, outputs: [], log: null };
    if (signal.aborted) return CANCELLED;
    if (!targetsFit(job.plan, job.targets)) {
      return { status: 'failed', code: 'encode_failed', outputs: [], log: '[media-converter] The output names do not match the plan.' };
    }

    let workId: string, workDirectory: string;
    try { workId = this.#createWorkId(); workDirectory = this.#outputs.workDirectory(workId); }
    catch (error) { return { status: 'failed', code: 'encode_failed', outputs: [], log: describe(error) }; }
    const item: ItemRun = {
      job, hooks, tools, workId, workDirectory,
      owners: job.plan.outputs.map((_, index) => `${job.itemId}#${index}`),
      tracker: new ProgressTracker(job.plan.outputs.map(output => ({ weight: 1, expectedDurationUs: output.expectedDurationUs }))),
      plan: job.plan, summary: undefined, fellBack: false, warnings: new Set(), phase: null, progressFailed: false,
    };
    try {
      return await this.#execute(item);
    } finally {
      // Every partial was settled by its attempt, after ffmpeg closed; the names and space go back, the work folder goes.
      for (const owner of item.owners) this.#outputs.release(owner);
      if (!(await this.#outputs.removeWorkDirectory(workId))) this.#log('The work folder of a conversion could not be removed.');
    }
  }

  async #execute(item: ItemRun): Promise<ExecutionOutcome> {
    const { job, hooks: { signal } } = item;
    // Every output is checked before anything runs: an item whose second output cannot be written does not start (AC-ENGINE-06-3/4).
    for (let index = 0; index < item.plan.outputs.length; index++) {
      const check = await this.#preflight(item, index, item.plan.outputs[index]);
      if (!check.ok) return this.#failed(item, check, []);
      if (signal.aborted) return CANCELLED;
    }

    const published: PublishedOutput[] = [];
    let failure: Failure | null = null;
    for (let index = 0; index < item.plan.outputs.length; index++) {
      if (signal.aborted) return this.#cancelled(item, published);
      let attempt = await this.#attempt(item, index);
      if (attempt.kind === 'failed' && attempt.fallback && !item.fellBack) {
        const fallback = await this.#fallBack(item, index, attempt.fallback);
        // Cancelled while the item was planned again: the retry was left out for the cancel, not for the failure.
        if (signal.aborted) return this.#cancelled(item, published);
        if (fallback.ok) attempt = await this.#attempt(item, index);
        else if (fallback.code) attempt = { kind: 'failed', code: fallback.code, log: fallback.log, continuable: false, fallback: null, space: fallback.space };
      }
      if (attempt.kind === 'cancelled') return this.#cancelled(item, published);
      if (attempt.kind === 'published') {
        published.push(attempt.output);
        // Its file now takes the space it held; it keeps its name until the batch ends.
        this.#outputs.release(item.owners[index]);
        continue;
      }
      if (attempt.kind === 'not_smaller') {
        // "Compress" writes one output; nothing of it is kept.
        if (item.plan.outputs.length === 1) return { status: 'skipped', reason: 'not_smaller', ...this.#summary(item) };
        failure ??= { code: 'output_cap_exceeded', log: '[media-converter] The output was not smaller than its source.' };
        continue;
      }
      failure ??= { code: attempt.code, log: attempt.log, space: attempt.space };
      if (!attempt.continuable) break;
    }
    if (failure) return this.#failed(item, failure, published);
    return { status: 'succeeded', outputs: published, warnings: [...item.warnings], ...this.#summary(item) };
  }

  /** `disk_space_low` with the bytes needed and free (AC-ENGINE-06-4); every other failure without them. */
  #failed(item: ItemRun, failure: Failure, outputs: readonly PublishedOutput[]): ExecutionOutcome {
    const space = failure.code === 'disk_space_low' && failure.space ? { space: { ...failure.space } } : {};
    return { status: 'failed', code: failure.code, outputs: [...outputs], log: failure.log, warnings: [...item.warnings], ...this.#summary(item), ...space };
  }

  /** A cancel after some outputs of the item were published: they stay on disk, so the outcome lists them. */
  #cancelled(item: ItemRun, published: readonly PublishedOutput[]): ExecutionOutcome {
    if (!published.length) return CANCELLED;
    return { status: 'cancelled', outputs: [...published], warnings: [...item.warnings], ...this.#summary(item) };
  }

  #summary(item: ItemRun): { summary?: PlanSummary } {
    return item.summary ? { summary: item.summary } : {};
  }

  /** `MediaOutputs.preflight` for one output: reserves its cap on its volume and claims its name for the batch. */
  async #preflight(item: ItemRun, index: number, output: PlannedOutput): Promise<Check> {
    const target = item.job.targets[index];
    try {
      const result = await this.#outputs.preflight({
        owner: item.owners[index], directory: target.directory, baseName: target.baseName, extension: target.extension,
        conflict: this.#conflict(item.job, target), inputs: item.job.inputPaths, capBytes: output.capBytes,
      });
      for (const warning of result.warnings) item.warnings.add(warning);
      return { ok: true };
    } catch (error) {
      if (error instanceof OutputError) {
        const space = error.code === 'disk_space_low' && error.space ? { space: { requiredBytes: error.space.requiredBytes, availableBytes: error.space.availableBytes } } : {};
        return { ok: false, code: error.code, log: preflightLog(error), ...space };
      }
      return { ok: false, code: 'encode_failed', log: describe(error) };
    }
  }

  /**
   * Overwrite only replaces what the user confirmed (design §10): a file of another name, or one that
   * appeared after the confirmation, is never moved to the recycle bin; the output is numbered instead.
   */
  #conflict(job: ExecutionJob, target: OutputTargetName): OutputConflictPolicy {
    if (job.conflict !== 'overwrite') return 'number';
    let name: string;
    try { name = numberedName(target.baseName, target.extension, 0); } catch { return 'number'; }
    const fold = (value: string) => this.#platform === 'win32' ? value.toLowerCase() : value;
    return job.confirmedReplace.some(confirmed => typeof confirmed === 'string' && fold(confirmed) === fold(name)) ? 'overwrite' : 'number';
  }

  /** One output from partial to published file, or to nothing: the partial never outlives the attempt. */
  async #attempt(item: ItemRun, index: number): Promise<Attempt> {
    const { job, hooks: { signal } } = item;
    const output = item.plan.outputs[index];
    const target = job.targets[index];
    if (signal.aborted) return { kind: 'cancelled' };
    let partial: PartialFile;
    try { partial = await this.#outputs.createPartial(target.directory); }
    catch (error) {
      const code: ItemFailureCode = error instanceof OutputError ? error.code : 'output_dir_unwritable';
      return { kind: 'failed', code, log: describe(error), continuable: false, fallback: null };
    }
    // Published or discarded by `publish` itself once it is called.
    let handedOver = false;
    try {
      if (signal.aborted) return { kind: 'cancelled' };
      const args = toFfmpegArgs(output, { inputPath: job.inputPath, demuxer: job.media.container.demuxer, partialPath: partial.path, lowUsage: job.lowUsage });
      item.tracker.beginPhase(index);
      this.#phase(item, 'encoding');
      let run = await this.#encode(item, index, output, target, partial, args);
      // Nothing of the run is touched before ffmpeg is gone (AC-ENGINE-04-3).
      await this.#closed(run);
      if (run.cancelled || signal.aborted) return { kind: 'cancelled' };
      if (run.status === 'spawn_error') {
        // Design §1: a start failure verifies the runtime again, then the run is tried once more. ffmpeg
        // never started, so its partial is still the empty file made for it.
        const verified = await this.#verifyAgain(item);
        if (!verified.ok) return { kind: 'failed', code: verified.code, log: verified.log, continuable: false, fallback: null };
        if (signal.aborted) return { kind: 'cancelled' };
        run = await this.#encode(item, index, output, target, partial, args);
        await this.#closed(run);
        if (run.cancelled || signal.aborted) return { kind: 'cancelled' };
        // Refused again (`runtime_spawn_failed` below): the next item verifies the runtime first.
        if (run.status === 'spawn_error') this.#forgetRuntime();
      }

      const early = runFailure(run);
      if (early?.reason === 'cap_reached' && output.capSemantics === 'not_smaller') return { kind: 'not_smaller' };
      if (early) return this.#runFailed(output, run, early);
      if (index === item.plan.outputs.length - 1) this.#phase(item, 'finalizing');

      const probed = await this.#prober.probe(partial.path).catch(() => null);
      if (signal.aborted) return { kind: 'cancelled' };
      const info = probed?.ok ? probed.info : null;
      const verdict = judgeEncode(run, {
        output: info, streams: plannedStreams(output), expectedDurationUs: output.expectedDurationUs,
        expectedFrom: output.expectedFrom === 'stream' ? 'main_stream' : 'container',
        sourceContainerDurationUs: output.expectedFrom === 'stream' ? job.media.durationUs : null,
      });
      if (!verdict.ok || !info) return this.#runFailed(output, run, verdict.ok ? { reason: 'output_unreadable', code: 'unknown', detail: run.redactedTail() } : verdict.failure);
      const sizeBytes = info.sizeBytes;
      // "Discard if not smaller": a finished output at 98 % of the source or more is not kept (module-encode design §7).
      if (output.capSemantics === 'not_smaller' && sizeBytes >= output.capBytes) return { kind: 'not_smaller' };
      this.#reportWarnings(run);

      handedOver = true;
      let result: PublishResult;
      try {
        result = await this.#outputs.publish(partial, {
          owner: item.owners[index], baseName: target.baseName, extension: target.extension, conflict: this.#conflict(job, target), inputs: job.inputPaths,
        });
      } catch (error) {
        // The checks of the start are repeated at the publish (an input or a too long name); anything else could not put the file in place.
        const code: ItemFailureCode = error instanceof OutputError && error.code !== 'output_dir_unwritable' ? error.code : 'output_publish_failed';
        return { kind: 'failed', code, log: describe(error), continuable: false, fallback: null };
      }
      for (const warning of [...verdict.warnings, ...result.warnings]) item.warnings.add(warning);
      return { kind: 'published', output: { index, path: result.path, sizeBytes, replaced: result.replaced } };
    } catch (error) {
      // Arguments the process wrapper refuses, or a plan the argument builder cannot write: a fault of ours, not of the file.
      this.#log('A conversion could not be run.', error);
      return { kind: 'failed', code: 'encode_failed', log: describe(error), continuable: false, fallback: null };
    } finally {
      if (!handedOver && !(await this.#outputs.discardPartial(partial).catch(() => false))) {
        this.#log('A partial output could not be removed; the startup cleanup will remove it.');
      }
    }
  }

  /** The real ffmpeg, or the injected failure of an item's first run. */
  #encode(item: ItemRun, index: number, output: PlannedOutput, target: OutputTargetName, partial: PartialFile, args: string[]): Promise<EncodeRunResult> {
    const { job } = item;
    if (this.#failure && !this.#injected.has(job.itemId)) {
      this.#injected.add(job.itemId);
      return Promise.resolve(injectedRun(this.#failure.code, output, job.lowUsage));
    }
    let finalName: string[] = [];
    try { finalName = [path.join(target.directory, numberedName(target.baseName, target.extension, 0))]; } catch { /* Redacted as a path anyway. */ }
    return this.#run({
      ffmpeg: item.tools.ffmpeg, args, workDirectory: item.workDirectory,
      env: encodeEnvironment(item.tools.ffmpeg, item.workDirectory, this.#sourceEnvironment),
      signal: item.hooks.signal, expectedDurationUs: output.expectedDurationUs, capBytes: output.capBytes, outputPath: partial.path,
      lowUsage: job.lowUsage,
      redaction: { inputs: [job.inputPath], outputs: [...finalName, target.directory], temporaries: [partial.path], work: [item.workDirectory] },
      onProgress: (state, atMs) => this.#progress(item, index, output, state, atMs),
    }, this.#processDependencies);
  }

  /** The runtime verified once more after ffmpeg could not be started; a runtime that fails it fails the item with its own code. */
  async #verifyAgain(item: ItemRun): Promise<{ ok: true } | { ok: false; code: ItemFailureCode; log: string }> {
    this.#forgetRuntime();
    try { item.tools = await this.#runtime.acquire(); return { ok: true }; }
    catch (error) { return { ok: false, code: runtimeFailureCode(error), log: describe(error) }; }
  }

  #forgetRuntime() {
    try { this.#runtime.invalidate?.(); } catch (error) { this.#log('The media runtime could not be set to verify again.', error); }
  }

  /** Waits for ffmpeg to close, `closeWaitMs` at most: a process that never says so must not hold the item forever. */
  async #closed(run: EncodeRunResult) {
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.#closeWaitMs); timer.unref?.(); });
    const closed = await Promise.race([run.closed.then(() => true, () => true), waited]);
    clearTimeout(timer);
    if (!closed) this.#log('ffmpeg did not close in time; its files are removed anyway.');
  }

  /**
   * A run that failed. A hardware encoder that failed before its first frame, whatever the cause
   * (AC-ENGINE-03-3), is degraded for the session even when no retry is left, so later items do
   * not try it again.
   */
  #runFailed(output: PlannedOutput, run: EncodeRunResult, failure: EncodeFailure): Attempt {
    const video = videoEncode(output);
    const fallback = video?.hardware && !run.firstFrameSeen && ENCODER_FAILURES.has(failure.reason) ? video : null;
    if (fallback) {
      try { this.#capabilities.markDegraded(fallback.encoder); } catch (error) { this.#log('An encoder could not be marked degraded.', error); }
    }
    return {
      kind: 'failed', code: itemCode(failure), log: withReason(failure.detail, REASON_TEXT[failure.reason]) || null,
      continuable: OUTPUT_FAILURES.has(failure.reason), fallback,
    };
  }

  /**
   * Plans the item again after a hardware failure (AC-ENGINE-03-3): its frozen settings, the table
   * as it is now (the encoder degraded), the same outputs under the same names. `code` is set when
   * the new plan's cap does not fit where the old one did.
   */
  async #fallBack(item: ItemRun, index: number, failed: VideoEncode): Promise<{ ok: true } | { ok: false; code?: ItemFailureCode; log: string | null; space?: DiskSpace }> {
    item.fellBack = true;
    let answer: CapabilitiesAnswer;
    try { answer = await this.#capabilities.planner(); }
    catch (error) { this.#log('The encoder capabilities could not be read for a fallback.', error); return { ok: false, log: null }; }
    if (!answer.ok || item.hooks.signal.aborted) return { ok: false, log: null };
    let plan: Readonly<ConversionPlan>;
    try {
      const outcome = this.#planner(item.job.media, item.job.settings, answer.capabilities);
      if (outcome.status !== 'ready') return { ok: false, log: null };
      plan = outcome.plan;
    } catch (error) { this.#log('The conversion could not be planned again.', error); return { ok: false, log: null }; }
    if (!targetsFit(plan, item.job.targets)) return { ok: false, log: null };
    const replacement = videoEncode(plan.outputs[index]);
    if (!replacement || replacement.encoder === failed.encoder) return { ok: false, log: null };
    if (plan.outputs[index].capBytes !== item.plan.outputs[index].capBytes) {
      const check = await this.#preflight(item, index, plan.outputs[index]);
      if (!check.ok) return { ok: false, code: check.code, log: check.log, space: check.space };
    }
    const warning: PlanWarning = { code: 'encoder_fallback', streams: [failed.sourceIndex], count: 1, from: failed.encoder, to: replacement.encoder };
    item.plan = plan;
    item.summary = { ...plan.summary, warnings: [...plan.summary.warnings.filter(entry => entry.code !== 'encoder_fallback'), warning] };
    item.warnings.add('encoder_fallback');
    return { ok: true };
  }

  #phase(item: ItemRun, phase: ItemPhase) {
    if (item.phase === phase) return;
    item.phase = phase;
    try { item.hooks.phase(phase); } catch (error) { this.#log('A phase listener failed.', error); }
  }

  /** Every progress block as the queue shows it: the item's share over all its outputs, the current output's time, size, pace and the time left. */
  #progress(item: ItemRun, index: number, output: PlannedOutput, state: ProgressState, atMs: number) {
    const snapshot = item.tracker.update(state, atMs);
    const last = index === item.plan.outputs.length - 1;
    // The trailer and a `+faststart` rewrite report nothing: the last output near its end is finalizing.
    if (last && output.expectedDurationUs !== null && (state.outTimeUs ?? 0) >= output.expectedDurationUs - ENCODE_PROCESS_POLICY.finalizingLeadUs) {
      this.#phase(item, 'finalizing');
    }
    const inRange = (value: number | null, max: number) => value !== null && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
    const whole = (value: number | null, max: number) => { const kept = inRange(value, max); return kept === null ? null : Math.round(kept); };
    const progress: ItemProgress = {
      fraction: inRange(snapshot.fraction, 1), processedUs: whole(snapshot.processedUs, 8_640_000_000_000),
      writtenBytes: whole(snapshot.totalSize, Number.MAX_SAFE_INTEGER), speed: inRange(snapshot.speed, 100_000), fps: inRange(snapshot.fps, 1_000_000),
      etaMs: whole(snapshot.etaMs, 8_640_000_000), outputIndex: index, outputCount: item.plan.outputs.length,
    };
    try { item.hooks.progress(progress); }
    catch (error) {
      if (!item.progressFailed) this.#log('A progress listener failed.', error);
      item.progressFailed = true;
    }
  }

  /** Warnings the planner did not foresee never fail a good output; they are logged so they can be looked into. */
  #reportWarnings(run: EncodeRunResult) {
    const lines = unexpectedWarnings(run.redactedTail());
    if (lines.length) this.#log(`ffmpeg warned on a successful conversion:\n${lines.slice(0, EXECUTOR_POLICY.warningLinesLogged).join('\n')}`);
  }
}
