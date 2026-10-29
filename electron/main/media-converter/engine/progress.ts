/**
 * Progress of an ffmpeg run (design §4), as pure functions: a bounded line parser for
 * `-progress pipe:1`, the share of a job done across weighted phases, a smoothed estimate of the
 * time left, and the redaction of paths in ffmpeg's log. No I/O and no timers; time comes in as
 * arguments. Throttling what reaches the renderer is the queue's job (T-ENGINE-05, FK-PIT-0077).
 */

export const PROGRESS_LIMITS = Object.freeze({
  /** A longer line is dropped whole (FK-PIT-0040): progress keys are short, so it can only be garbage. */
  maxLineBytes: 16 * 1024,
  /** The share shown while a phase runs: 100 % only once ffmpeg says `progress=end`. */
  maxRunningFraction: 0.99,
});

/** One `-progress` block, ended by `progress=continue|end`. A field ffmpeg left out or sent as `N/A` or negative is null. */
export interface ProgressBlock {
  /** Media time written so far, µs. */
  readonly outTimeUs: number | null;
  /** Bytes written to the output so far. */
  readonly totalSize: number | null;
  /** Media seconds per second, as ffmpeg averages it since the start. */
  readonly speed: number | null;
  readonly fps: number | null;
  /** Video frames written; ffmpeg reports none for an output without video. */
  readonly frame: number | null;
  /** `progress=end`: every output is finished, trailer included. */
  readonly ended: boolean;
}

type MutableBlock = { -readonly [K in keyof ProgressBlock]: ProgressBlock[K] } & { outTimeMsUs: number | null; outTimeClockUs: number | null };
const emptyBlock = (): MutableBlock => ({ outTimeUs: null, outTimeMsUs: null, outTimeClockUs: null, totalSize: null, speed: null, fps: null, frame: null, ended: false });

const INTEGER = /^-?\d{1,20}$/;
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
/** `HH:MM:SS.micro`, as `out_time` writes it; a negative one is ignored like any negative value. */
const CLOCK = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/;

/** A non-negative safe integer, else null (`N/A`, negative, garbage, beyond 2^53). */
function count(value: string): number | null {
  if (!INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function decimal(value: string): number | null {
  if (!DECIMAL.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function clockUs(value: string): number | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const us = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1_000_000);
  return Number.isSafeInteger(us) ? us : null;
}

/**
 * Applies one `key=value` line to the block being read. Returns true when the line ends the block.
 * `out_time_us` wins over `out_time_ms` (microseconds too, despite its name) and `out_time`; `speed`
 * and `bitrate` come with leading spaces and a unit.
 */
function applyLine(block: MutableBlock, line: string): boolean {
  const separator = line.indexOf('=');
  if (separator <= 0) return false;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  switch (key) {
    case 'frame': block.frame = count(value); return false;
    case 'fps': block.fps = decimal(value); return false;
    case 'total_size': block.totalSize = count(value); return false;
    case 'out_time_us': block.outTimeUs = count(value); return false;
    case 'out_time_ms': block.outTimeMsUs = count(value); return false;
    case 'out_time': block.outTimeClockUs = clockUs(value); return false;
    case 'speed': block.speed = decimal(value.replace(/x$/i, '').trim()); return false;
    case 'progress': block.ended = value === 'end'; return true;
    default: return false;
  }
}

function finished(block: MutableBlock): ProgressBlock {
  return Object.freeze({ outTimeUs: block.outTimeUs ?? block.outTimeMsUs ?? block.outTimeClockUs, totalSize: block.totalSize, speed: block.speed,
    fps: block.fps, frame: block.frame, ended: block.ended });
}

/**
 * Reads `-progress pipe:1` chunk by chunk. It keeps at most one unfinished line of 16 KB and the
 * block being read; nothing of the stream is retained once parsed, however long the run.
 */
export class ProgressParser {
  #pending = '';
  #dropping = false;
  #block = emptyBlock();

  /** Parses a chunk of stdout and returns the blocks it completed, in order. */
  push(chunk: Uint8Array | string): ProgressBlock[] {
    // The keys and values are ASCII; latin1 keeps one character per byte, so the line bound is in bytes.
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1');
    const blocks: ProgressBlock[] = [];
    let start = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      const piece = text.slice(start, newline);
      start = newline + 1;
      if (this.#dropping) { this.#dropping = false; this.#pending = ''; continue; }
      const line = this.#pending + piece;
      this.#pending = '';
      if (line.length > PROGRESS_LIMITS.maxLineBytes) continue;
      this.#line(line, blocks);
    }
    const rest = text.slice(start);
    if (!this.#dropping) {
      this.#pending += rest;
      if (this.#pending.length > PROGRESS_LIMITS.maxLineBytes) { this.#pending = ''; this.#dropping = true; }
    }
    return blocks;
  }

  /** stdout closed: a last line without its newline still counts; a block cut short is dropped. */
  finish(): ProgressBlock[] {
    const blocks: ProgressBlock[] = [];
    if (!this.#dropping && this.#pending) this.#line(this.#pending, blocks);
    this.#pending = '';
    this.#dropping = false;
    this.#block = emptyBlock();
    return blocks;
  }

  #line(line: string, blocks: ProgressBlock[]) {
    if (!applyLine(this.#block, line.endsWith('\r') ? line.slice(0, -1) : line)) return;
    blocks.push(finished(this.#block));
    this.#block = emptyBlock();
  }
}

/** What is known of a run after its latest block: a value ffmpeg reported as N/A keeps the last known one. */
export interface ProgressState {
  /** The largest media time reported, µs: the processed duration. */
  readonly outTimeUs: number | null;
  /** The largest output size reported, bytes. */
  readonly totalSize: number | null;
  readonly speed: number | null;
  readonly fps: number | null;
  readonly frame: number | null;
  readonly ended: boolean;
  readonly blocks: number;
}

const larger = (previous: number | null | undefined, next: number | null) => next === null ? previous ?? null : Math.max(previous ?? 0, next);

export function mergeProgress(state: ProgressState | null, block: ProgressBlock): ProgressState {
  return Object.freeze({
    outTimeUs: larger(state?.outTimeUs, block.outTimeUs),
    totalSize: larger(state?.totalSize, block.totalSize),
    speed: block.speed ?? state?.speed ?? null,
    fps: block.fps ?? state?.fps ?? null,
    frame: larger(state?.frame, block.frame),
    ended: block.ended || (state?.ended ?? false),
    blocks: (state?.blocks ?? 0) + 1,
  });
}

// ── Share done and time left ───────────────────────────────────────────────────────────────────

/** A phase of a job (I2: analysis, pass 1, pass 2), with its share of the work and its own expected media time. */
export interface ProgressPhase {
  readonly weight: number;
  readonly expectedDurationUs: number | null;
}

/** The share of one phase done, 0–1: processed ÷ expected, held below 1 until the phase ends. Null when the duration is unknown. */
export function phaseFraction(outTimeUs: number | null, expectedDurationUs: number | null, ended: boolean): number | null {
  if (ended) return 1;
  if (expectedDurationUs === null || !(expectedDurationUs > 0)) return null;
  return Math.min(PROGRESS_LIMITS.maxRunningFraction, Math.max(0, (outTimeUs ?? 0) / expectedDurationUs));
}

/**
 * The share of the whole job done: the weights of the phases before `current`, plus the current
 * phase's weight times its own share. Null when the current phase's share is unknown, so the
 * interface shows an indeterminate bar with the processed time and size instead.
 */
export function jobFraction(phases: readonly ProgressPhase[], current: number, outTimeUs: number | null, ended: boolean): number | null {
  if (!Number.isInteger(current) || current < 0 || current >= phases.length) throw new RangeError('The progress phase is out of range.');
  if (phases.some(phase => !(Number.isFinite(phase.weight) && phase.weight > 0))) throw new RangeError('A progress phase weight is invalid.');
  const share = phaseFraction(outTimeUs, phases[current].expectedDurationUs, ended);
  if (share === null) return null;
  const total = phases.reduce((sum, phase) => sum + phase.weight, 0);
  const before = phases.slice(0, current).reduce((sum, phase) => sum + phase.weight, 0);
  return Math.min(1, (before + phases[current].weight * share) / total);
}

export interface EtaOptions {
  /** How fast the smoothed rate follows a change of pace: half the weight is gone after this long. */
  readonly halfLifeMs?: number;
  /** No estimate before the job has been watched this long: the first seconds include start-up. */
  readonly warmupMs?: number;
}
export const ETA_DEFAULTS = Object.freeze({ halfLifeMs: 8_000, warmupMs: 3_000 });

/**
 * Time left from the pace of the share done, smoothed with a time-weighted moving average of the
 * observed rate, so one burst or pause moves the estimate a little rather than all the way. Fed
 * the job share (not the phase share), so later phases are part of the estimate by their weight.
 */
export class EtaEstimator {
  readonly #halfLifeMs: number;
  readonly #warmupMs: number;
  #first: { atMs: number } | null = null;
  #last: { atMs: number; fraction: number } | null = null;
  #rate: number | null = null;

  constructor(options: EtaOptions = {}) {
    this.#halfLifeMs = options.halfLifeMs ?? ETA_DEFAULTS.halfLifeMs;
    this.#warmupMs = options.warmupMs ?? ETA_DEFAULTS.warmupMs;
    if (!(this.#halfLifeMs > 0) || !(this.#warmupMs >= 0)) throw new RangeError('The ETA options are invalid.');
  }

  reset() {
    this.#first = null;
    this.#last = null;
    this.#rate = null;
  }

  /** Records the job share at a time, ms on a monotonic clock; returns the time left in ms, or null when it cannot be told yet. */
  observe(atMs: number, fraction: number | null): number | null {
    if (fraction === null || !Number.isFinite(atMs)) { this.reset(); return null; }
    if (fraction >= 1) return 0;
    if (!this.#first || !this.#last) {
      this.#first = { atMs };
      this.#last = { atMs, fraction };
      return null;
    }
    const elapsed = atMs - this.#last.atMs;
    // Time going backwards or a share going down (a phase was restarted) is not a pace.
    if (elapsed > 0 && fraction >= this.#last.fraction) {
      const rate = (fraction - this.#last.fraction) / elapsed;
      const keep = 0.5 ** (elapsed / this.#halfLifeMs);
      this.#rate = this.#rate === null ? rate : this.#rate * keep + rate * (1 - keep);
      this.#last = { atMs, fraction };
    } else if (fraction < this.#last.fraction) {
      this.#last = { atMs, fraction };
    }
    if (atMs - this.#first.atMs < this.#warmupMs || this.#rate === null || !(this.#rate > 0)) return null;
    return Math.round((1 - fraction) / this.#rate);
  }
}

export interface ProgressSnapshot {
  readonly phase: number;
  /** Job share 0–1, or null for an indeterminate bar. */
  readonly fraction: number | null;
  /** Media time processed in the current phase, µs. */
  readonly processedUs: number | null;
  readonly totalSize: number | null;
  readonly speed: number | null;
  readonly fps: number | null;
  readonly etaMs: number | null;
}

/** Combines the phases, the latest run state and the estimator into what the queue shows. */
export class ProgressTracker {
  readonly #phases: readonly ProgressPhase[];
  readonly #eta: EtaEstimator;
  #phase = 0;

  constructor(phases: readonly ProgressPhase[], options: EtaOptions = {}) {
    if (phases.length === 0) throw new RangeError('A job has at least one progress phase.');
    jobFraction(phases, 0, null, false);
    this.#phases = phases;
    this.#eta = new EtaEstimator(options);
  }

  /** The next phase starts (a new ffmpeg run): its processed time starts from zero. */
  beginPhase(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#phases.length) throw new RangeError('The progress phase is out of range.');
    this.#phase = index;
  }

  update(state: ProgressState, atMs: number): ProgressSnapshot {
    const fraction = jobFraction(this.#phases, this.#phase, state.outTimeUs, state.ended);
    return Object.freeze({ phase: this.#phase, fraction, processedUs: state.outTimeUs, totalSize: state.totalSize, speed: state.speed, fps: state.fps,
      etaMs: this.#eta.observe(atMs, fraction) });
  }
}

// ── Log redaction ──────────────────────────────────────────────────────────────────────────────

/** The paths of one run that the log may show. Temporaries are the partial outputs; work is the job's working directory. */
export interface RedactionPaths {
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly temporaries?: readonly string[];
  readonly work?: readonly string[];
}

const ANSI = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-_]/gu;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/gu;
// Paths nobody told us about, after the patterns of `server-diagnostics.ts`; ffmpeg quotes most with ', some with a file: prefix.
const FILE_URL = /\bfile:\/\/[^\s"'`<>]+/giu;
const QUOTED_PATH = /(["'])(?:file:)?(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)(?:(?!\1)[^\r\n])*\1/gu;
// An unquoted path ends before a trailing `:` `;` `,` `.`, as in ffmpeg's "Error opening output <path>: <reason>".
const FILE_PREFIXED_PATH = /\bfile:(?:[A-Za-z]:[\\/]|[\\/])(?:[^\s"'`<>|]*[^\s"'`<>|:;,.])?/giu;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/]+(?:[^\s"'`<>|]*[^\s"'`<>|:;,.])?/gu;
const UNC_PATH = /(^|[\s=(,:;])[\\/]{2,}[^\s"'`<>|]*[^\s"'`<>|:;,.]/gu;
// Unlike the diagnostics pattern, a lone ` / ` (as in SVT's "width / height") is not a path.
const POSIX_PATH = /(^|[\s=(,:;])\/[^\s"'`<>|/](?:[^\s"'`<>|]*[^\s"'`<>|:;,.])?/gu;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spellings ffmpeg may print a path in: as given, with the other slash, with `\\?\`, each with and without `file:`. */
function spellings(value: string): string[] {
  const plain = value.startsWith('\\\\?\\') ? value.slice(4) : value;
  const forms = new Set([plain, plain.replace(/\\/g, '/'), plain.replace(/\//g, '\\'), `\\\\?\\${plain}`]);
  return [...forms].flatMap(form => [`file:${form}`, form]);
}

/**
 * A compiled redactor: the known paths of a run become `<input>`, `<output>` (outputs and their
 * partials) and `<work>`, with or without a `file:` prefix, in either slash and any case; any other
 * absolute path becomes `[path]`. Control characters and terminal escapes are removed.
 */
export function createLogRedactor(paths: RedactionPaths): (text: string) => string {
  const known: { spelling: string; placeholder: string }[] = [];
  const add = (values: readonly string[] | undefined, placeholder: string) => {
    for (const value of values ?? []) if (typeof value === 'string' && value.length >= 3) for (const spelling of spellings(value)) known.push({ spelling, placeholder });
  };
  add(paths.inputs, '<input>');
  add(paths.outputs, '<output>');
  add(paths.temporaries, '<output>');
  add(paths.work, '<work>');
  // Longest first: a partial inside the working directory is an output, not a file of <work>.
  known.sort((a, b) => b.spelling.length - a.spelling.length);
  const pattern = known.length ? new RegExp(known.map(entry => escapeRegExp(entry.spelling)).join('|'), 'giu') : null;
  const placeholders = new Map(known.map(entry => [entry.spelling.toLowerCase(), entry.placeholder]));
  return text => {
    let value = text.replace(/\r\n?/g, '\n').replace(ANSI, '').replace(/\t/g, ' ').replace(CONTROL, '');
    if (pattern) value = value.replace(pattern, match => placeholders.get(match.toLowerCase()) ?? '[path]');
    return value
      .replace(FILE_URL, '[path]')
      .replace(QUOTED_PATH, (_match, quote: string) => `${quote}[path]${quote}`)
      .replace(FILE_PREFIXED_PATH, '[path]')
      .replace(WINDOWS_PATH, '[path]')
      .replace(UNC_PATH, '$1[path]')
      .replace(POSIX_PATH, '$1[path]');
  };
}

export function redactFfmpegLog(text: string, paths: RedactionPaths): string {
  return createLogRedactor(paths)(text);
}

/** The last bytes of a UTF-8 string, starting on a whole line (or a whole character when one line is longer). */
export function utf8Tail(text: string, maxBytes: number): string {
  if (!(maxBytes >= 0)) throw new RangeError('The tail size is invalid.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  if (bytes[start - 1] !== 0x0a) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline !== -1 && newline + 1 < bytes.length) start = newline + 1;
  }
  return bytes.subarray(start).toString('utf8');
}

/**
 * The redacted end of a log kept as raw bytes. Only whole lines are redacted and shown: the line
 * cut by the window (or, with `startsMidway`, by a ring buffer that dropped older output) is
 * dropped, so a path cut in half is never shown in part.
 */
export function redactedLogTail(raw: Uint8Array, maxBytes: number, redact: (text: string) => string, startsMidway = false): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('The tail size is invalid.');
  const margin = 4096;
  const from = Math.max(0, raw.byteLength - maxBytes - margin);
  let text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).subarray(from).toString('utf8');
  if (from > 0 || startsMidway) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  return utf8Tail(redact(text), maxBytes);
}
