import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_CONVERT_SETTINGS, defaultCompressSettings, itemProgressSchema, planSummarySchema,
  type ConversionSettings, type ItemPhase, type ItemProgress, type MediaInfo, type VideoEncoderId,
} from '../../src/media-converter/contract';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { MediaCapabilities, classifyEncoderFailure } from '../../electron/main/media-converter/engine/capabilities';
import {
  MediaConversionExecutor, TOLERATED_WARNINGS, unexpectedWarnings, type ExecutorCapabilities, type ExecutorRuntime,
} from '../../electron/main/media-converter/engine/executor';
import { InputRegistry } from '../../electron/main/media-converter/engine/inputs';
import { MediaOutputs, type MediaOutputsOptions } from '../../electron/main/media-converter/engine/output';
import { MediaProber, type ProbeOutcome } from '../../electron/main/media-converter/engine/probe';
import { runEncodeProcess, type EncodeProcessDependencies, type EncodeProcessRequest, type EncodeRunResult } from '../../electron/main/media-converter/engine/process';
import { MediaRuntime, MediaRuntimeError, type MediaSpawn, type MediaTools } from '../../electron/main/media-converter/engine/runtime';
import { ffmpegSeconds, toFfmpegArgs } from '../../electron/main/media-converter/plan/args';
import { outputFileName } from '../../electron/main/media-converter/plan/naming';
import { buildPlan } from '../../electron/main/media-converter/plan/stream-plan';
import type { ConversionPlan, PlannerCapabilities } from '../../electron/main/media-converter/plan/types';
import type { ExecutionHooks, ExecutionJob, ExecutionOutcome } from '../../electron/main/media-converter/queue/types';
import {
  MEDIA_FAIL_CODES, TEST_MEDIA_CAPS_ENV, TEST_MEDIA_FAIL_ENV, TEST_MEDIA_REVEAL_ENV, parseMediaFailInjection, parseMediaRevealOverride, resolveMediaTestHooks,
  type MediaFailInjection, type MediaTestEnvironment,
} from '../../electron/main/media-converter/test-hooks';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * The executor (T-ENGINE-07, design §5): one item end to end with the real bundled ffmpeg, on lavfi
 * samples of at most 2 s and 640×360 made when the file starts. Every ffmpeg runs at idle priority
 * (the process wrapper's priority call is replaced by one that records what was asked and sets
 * IDLE); a few runs read their input at half speed (`-readrate 0.5`, added by the spawn wrapper) so
 * they can be cancelled or stopped in the middle. Compress, convert and extract publish and are
 * probed back; a pre-compressed still picture compressed at the quality tier stops at its cap and
 * is skipped (`not_smaller`); a cancel removes the partial, the work folder and the 2-pass log in
 * it; a hardware failure before the first frame (FUSIONKIT_TEST_MEDIA_FAIL) falls back once and
 * says so in the plan summary, a failure after it does not (with real NVENC where the computer has
 * it, and on any computer with libopenh264 standing in for it), and a cancel while it is planned
 * again settles cancelled; an ffmpeg that cannot be started has
 * the runtime verified again and is tried once more; `statfs` and the FAT32 check refuse
 * before anything runs (`disk_space_low` with the bytes needed and free); of two extracted tracks,
 * the one that works is published when the other fails ("partly done"), and a cancel during the
 * second lists the first; an output is published only when it passes the check of AC-ENGINE-04-5;
 * raw H.264 and HEVC streams, which a remux cannot time, are re-encoded for MP4, MKV and compress,
 * raw MPEG-2 remuxes with `+genpts`, and the probe admits no other raw video stream (module-encode
 * design §7b).
 * Everything happens in a run folder under test-results/media-converter (FK-PIT-0099), removed at
 * the end. The test switches' parsing and gate need no ffmpeg; the rest is skipped when the runtime
 * has not been staged (build/subtitle-studio-resources/transcription).
 */

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
const NVIDIA_DRIVER = process.platform === 'win32' && existsSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvcuda.dll'));
/** Warnings that mean ffmpeg silently did something other than asked (module-engine tasks, common conventions). */
const SILENT_SUBSTITUTION = /Invalid option|Error parsing option|auto-selecting format|only the last/;
const HUGE = { bavail: 1n << 40n, bsize: 4096n };
const GiB = 1024 ** 3;
/** Free space every volume keeps beyond the caps (AC-ENGINE-06-4). */
const HEADROOM = 512 * 1024 * 1024;
const REAL_TIMEOUT = 120_000;

type Fixture = { path: string; info: MediaInfo };
let root: string, media: string, runtime: MediaRuntime, prober: MediaProber, tools: MediaTools;
let rich: Fixture, clip: Fixture, clip60: Fixture, still: Fixture, tracks: Fixture, raw: Fixture, rawHevc: Fixture, rawMpeg2: Fixture;

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

/** The bundled ffmpeg at idle priority makes a fixture; a silent substitution fails it like an error. */
function make(name: string, ...args: string[]): Promise<string> {
  const output = path.join(media, name);
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'level+warning', '-y', ...args, output],
      { cwd: media, env: { ...tools.environment } as NodeJS.ProcessEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* Exited already. */ }
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 && !SILENT_SUBSTITUTION.test(stderr) ? resolve(output) : reject(new Error(`ffmpeg ${code}: ${stderr}`)));
  });
}
async function fixture(file: Promise<string>): Promise<Fixture> {
  const filePath = await file;
  const outcome = await prober.probe(filePath);
  if (!outcome.ok) throw new Error(`${path.basename(filePath)}: ${outcome.code}`);
  return { path: filePath, info: outcome.info };
}
async function probed(filePath: string): Promise<MediaInfo> {
  const outcome = await prober.probe(filePath);
  if (!outcome.ok) throw new Error(`${path.basename(filePath)}: ${outcome.code}`);
  return outcome.info;
}

// ── Harness ────────────────────────────────────────────────────────────────────────────────────

interface HarnessOptions {
  /** The capability table; by default the real `MediaCapabilities` with "CPU only". */
  capabilities?: ExecutorCapabilities;
  failure?: MediaFailInjection | null;
  outputs?: Partial<MediaOutputsOptions>;
  /** Changes a real run's arguments before ffmpeg gets them; `call` counts the real runs from 1. */
  tamper?: (args: string[], call: number) => string[];
  /** Runs (by spawn count from 1) that read their input at half speed, so they last about 4 s. */
  slow?: (call: number) => boolean;
  onSpawn?: (child: ChildProcess, options: SpawnOptions, call: number) => void;
  /** Changes what the executor's probe of a file reads. */
  probe?: (filePath: string, outcome: ProbeOutcome) => ProbeOutcome;
  /** The executor's runtime; by default the real one of this file. */
  runtime?: ExecutorRuntime;
}

interface Harness {
  readonly dir: string;
  readonly out: string;
  readonly state: string;
  readonly inputs: InputRegistry;
  readonly outputs: MediaOutputs;
  readonly capabilities: ExecutorCapabilities;
  executor: MediaConversionExecutor;
  readonly runs: { request: EncodeProcessRequest; result: EncodeRunResult }[];
  readonly spawns: { args: string[]; cwd: string; child: ChildProcess }[];
  readonly priorities: number[];
  readonly affinities: bigint[];
  readonly degraded: VideoEncoderId[];
  readonly logs: string[];
  readonly trashed: string[];
}

/** "CPU only", as FUSIONKIT_TEST_MEDIA_CAPS gives it: the real capability class, without test encodes. */
const cpuOnly = (state: string) => new MediaCapabilities({ runtime, root: state, gpuInfo: async () => null, isHardwareEncodeRunning: () => false,
  override: { kind: 'cpu_only' }, log: () => {} });

/** A fixed table of measured configurations, with the session's degradations applied as `MediaCapabilities` applies them. */
function tableCaps(encoders: PlannerCapabilities['encoders']): ExecutorCapabilities {
  const degraded: VideoEncoderId[] = [];
  return {
    planner: async () => ({ ok: true, capabilities: { encoders, degraded: [...degraded], nvencMin: { width: 129, height: 33 } } }),
    markDegraded: encoder => { if (!degraded.includes(encoder)) degraded.push(encoder); },
  };
}

let harnesses = 0;
async function harness(name: string, options: HarnessOptions = {}): Promise<Harness> {
  const dir = path.join(root, `${String(++harnesses).padStart(2, '0')}-${name}`);
  const out = path.join(dir, 'out'), state = path.join(dir, 'state'), trash = path.join(dir, 'trash');
  await mkdir(out, { recursive: true });
  await mkdir(trash, { recursive: true });
  const trashed: string[] = [];
  const outputs = new MediaOutputs({
    root: state, statfs: async () => HUGE, volumeFileSystem: async () => 'ntfs',
    trashItem: async target => { trashed.push(target); await rename(target, path.join(trash, `${trashed.length}-${path.basename(target)}`)); },
    ...options.outputs,
  });
  const degraded: VideoEncoderId[] = [];
  const table = options.capabilities ?? cpuOnly(state);
  const capabilities: ExecutorCapabilities = { planner: () => table.planner(), markDegraded: encoder => { degraded.push(encoder); table.markDegraded(encoder); } };
  const h: Harness = {
    dir, out, state, inputs: new InputRegistry(), outputs, capabilities, executor: undefined!, runs: [], spawns: [], priorities: [], affinities: [], degraded,
    logs: [], trashed,
  };
  let calls = 0, spawned = 0;
  const run: typeof runEncodeProcess = async (request, dependencies) => {
    const call = ++calls;
    const args = options.tamper ? options.tamper([...request.args], call) : [...request.args];
    const result = await runEncodeProcess({ ...request, args }, dependencies);
    h.runs.push({ request: { ...request, args }, result });
    return result;
  };
  const spawnChild: MediaSpawn = (command, args, spawnOptions) => {
    const call = ++spawned;
    const list = [...args];
    // `-readrate` is an input option: before the input's `-f <demuxer>`.
    if (options.slow?.(call)) list.splice(list.indexOf('-i') - 4, 0, '-readrate', '0.5');
    const child = spawn(command, list, spawnOptions);
    h.spawns.push({ args: list, cwd: String(spawnOptions.cwd), child });
    options.onSpawn?.(child, spawnOptions, call);
    return child;
  };
  const dependencies: EncodeProcessDependencies = {
    spawn: spawnChild,
    // Every run of this file is idle, whatever the job asks for; what it asked for is recorded.
    setPriority: (pid, priority) => { h.priorities.push(priority); os.setPriority(pid, os.constants.priority.PRIORITY_LOW); },
    // No PowerShell here: the mask asked for is recorded.
    setAffinity: async (_pid, mask) => { h.affinities.push(mask); },
    log: message => { h.logs.push(message); },
  };
  h.executor = new MediaConversionExecutor({
    runtime: options.runtime ?? runtime, inputs: h.inputs, outputs, capabilities, process: { run, dependencies }, failure: options.failure ?? null,
    prober: { probe: async filePath => { const outcome = await prober.probe(filePath); return options.probe ? options.probe(filePath, outcome) : outcome; } },
    log: message => { h.logs.push(message); },
  });
  return h;
}

interface JobOptions {
  conflict?: ExecutionJob['conflict'];
  confirmedReplace?: string[];
  lowUsage?: boolean;
  inputPaths?: string[];
  plan?: (plan: ConversionPlan) => ConversionPlan;
}
/** The job the queue would hand over: the item planned with the harness's table, named by encode's naming in the harness's output folder. */
async function jobFor(h: Harness, source: Fixture, settings: ConversionSettings, options: JobOptions = {}): Promise<ExecutionJob> {
  const added = await h.inputs.add(source.path);
  if (!added.ok) throw new Error(added.code);
  const caps = await h.capabilities.planner();
  if (!caps.ok) throw new Error(caps.code);
  const outcome = buildPlan(source.info, settings, caps.capabilities);
  if (outcome.status !== 'ready') throw new Error(`The plan is ${outcome.status}.`);
  const plan = options.plan ? options.plan(outcome.plan) : outcome.plan;
  const targets = plan.outputs.map(output => {
    const named = outputFileName({ directory: h.out, sourceFileName: path.basename(source.path), baseName: output.container.baseName,
      extension: output.container.extension, besideSource: false });
    if (!named.ok) throw new Error(named.code);
    return { directory: h.out, baseName: named.fileName.slice(0, -(output.container.extension.length + 1)), extension: output.container.extension };
  });
  return {
    itemId: added.input.id, inputPath: source.path, media: source.info, settings, plan, targets, conflict: options.conflict ?? 'number',
    confirmedReplace: options.confirmedReplace ?? [], lowUsage: options.lowUsage ?? false, inputPaths: options.inputPaths ?? [source.path],
  };
}

/** The queue's side of a run: phases, progress (each checked against the contract), and the cancel. */
function watch() {
  const controller = new AbortController();
  const phases: ItemPhase[] = [];
  const progress: ItemProgress[] = [];
  const invalid: unknown[] = [];
  const hooks: ExecutionHooks = {
    signal: controller.signal,
    phase: phase => { phases.push(phase); },
    progress: value => { const parsed = itemProgressSchema.safeParse(value); if (parsed.success) progress.push(parsed.data); else invalid.push(value); },
  };
  return { controller, hooks, phases, progress, invalid };
}

/** What a run may leave behind: partials in the output folder, records in partials.json, work folders. */
async function leftovers(h: Harness) {
  const partials = (await readdir(h.out)).filter(name => name.endsWith('.partial'));
  const journal: unknown[] = await readFile(path.join(h.state, 'partials.json'), 'utf8').then(text => JSON.parse(text).records, () => []);
  const work = await readdir(path.join(h.state, 'work')).catch(() => [] as string[]);
  return { partials, journal, work };
}
const NOTHING_LEFT = { partials: [], journal: [], work: [] };

/** The `level+warning` log of every run that ended well has no silent substitution and nothing but the tolerated warnings. */
function expectCleanLogs(h: Harness) {
  for (const { result } of h.runs) {
    if (result.exitCode !== 0 || result.capHit) continue;
    const log = result.redactedTail(256 * 1024);
    expect(log).not.toMatch(SILENT_SUBSTITUTION);
    expect(unexpectedWarnings(log)).toEqual([]);
  }
  expect(h.logs.filter(line => line.includes('warned on a successful conversion'))).toEqual([]);
}

/** A probe change that applies to the partials the executor reads back, not to the fixtures or the published files. */
const partialOnly = (change: (info: MediaInfo) => MediaInfo) => (filePath: string, outcome: ProbeOutcome): ProbeOutcome =>
  outcome.ok && filePath.endsWith('.partial') ? { ok: true, info: change(outcome.info) } : outcome;
const argAfter = (args: readonly string[], name: string) => args.filter((_, index) => args[index - 1] === name);
const isSucceeded = (outcome: ExecutionOutcome): outcome is Extract<ExecutionOutcome, { status: 'succeeded' }> => outcome.status === 'succeeded';
const isFailed = (outcome: ExecutionOutcome): outcome is Extract<ExecutionOutcome, { status: 'failed' }> => outcome.status === 'failed';
/** Inserts output options just before the output's `-f <muxer> -y file:<partial>`. */
const beforeOutput = (args: string[], ...extra: string[]) => { args.splice(args.length - 4, 0, ...extra); return args; };
const durationOf = (info: MediaInfo) => info.durationUs ?? 0;

/** The bundled ffmpeg at idle priority on a finished file; resolves with its stdout. */
function inspect(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
      { cwd: media, env: { ...tools.environment } as NodeJS.ProcessEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* Exited already. */ }
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`ffmpeg ${code}: ${stderr}`)));
  });
}
/** Every decoded picture of the main video, by its hash, in the order the decoder gives them (display order). */
async function pictures(filePath: string): Promise<string[]> {
  const lines = (await inspect('-i', `file:${filePath}`, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-')).split(/\r?\n/);
  return lines.filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim());
}

beforeAll(async () => {
  if (!available) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'executor-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'executor-')));
  media = path.join(root, 'media');
  await mkdir(media, { recursive: true });
  runtime = new MediaRuntime({ environment, workingDirectory: path.join(root, 'runtime-work') });
  tools = await runtime.acquire();
  prober = new MediaProber({ runtime });
  // One at a time, at idle priority. A rich 640×360 picture with near-lossless MPEG-4 and FLAC: compressing it saves a lot.
  rich = await fixture(make('rich.mkv', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=2:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'flac', '-shortest'));
  clip = await fixture(make('clip.mkv', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libopenh264', '-c:a', 'aac', '-shortest'));
  clip60 = await fixture(make('clip60.mkv', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=60', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libopenh264', '-c:a', 'aac', '-shortest'));
  // One detailed frame held for 2 s, AV1 at CRF 50: about 12 KB, which HEVC at the quality tier cannot undercut.
  still = await fixture(make('still.mkv', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=0.04,loop=loop=49:size=1:start=0,setpts=N/25/TB',
    '-c:v', 'libsvtav1', '-crf', '50', '-preset', '8'));
  tracks = await fixture(make('tracks.mkv', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=2:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libopenh264', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn', '-shortest'));
  // A raw H.264 stream has no duration to check against, nor timing: 25 fps is what ffmpeg assumes, and what it was made with.
  raw = await fixture(make('raw.h264', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=1:r=25', '-c:v', 'libopenh264', '-f', 'h264'));
  // Raw HEVC from kvazaar: hierarchical B-frames (decoded out of order), 30 fps in its VUI.
  rawHevc = await fixture(make('reordered.hevc', '-f', 'lavfi', '-i', 'testsrc2=s=320x184:d=2:r=30', '-c:v', 'libkvazaar', '-pix_fmt', 'yuv420p', '-f', 'hevc'));
  // Raw MPEG-2 video with B-frames: its parser times the frames, a copy gets the rest from +genpts.
  rawMpeg2 = await fixture(make('bframes.m2v', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=30', '-c:v', 'mpeg2video', '-bf', '2', '-g', '15',
    '-f', 'mpeg2video'));
}, REAL_TIMEOUT);

afterAll(async () => {
  prober?.dispose();
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});

// ── Test switches ──────────────────────────────────────────────────────────────────────────────

describe('FUSIONKIT_TEST_MEDIA_FAIL and FUSIONKIT_TEST_MEDIA_REVEAL', () => {
  const testEnv = (values: Record<string, string>): MediaTestEnvironment => ({ NODE_ENV: 'test', ...values });

  it('reads <code>:first_attempt for the failures one run can end with, and nothing else', () => {
    for (const code of MEDIA_FAIL_CODES) expect(parseMediaFailInjection(`${code}:first_attempt`)).toEqual({ code, when: 'first_attempt' });
    expect(parseMediaFailInjection(' no_device:first_attempt ')).toEqual({ code: 'no_device', when: 'first_attempt' });
    for (const value of [undefined, '', 'no_device', 'no_device:', 'no_device:always', 'no_device:first_attempt:x', 'NO_DEVICE:first_attempt',
      'input_missing:first_attempt', 'not_a_code:first_attempt', ':first_attempt', 'no_device,disk_full:first_attempt']) {
      expect(parseMediaFailInjection(value), String(value)).toBeNull();
    }
    expect(parseMediaRevealOverride('record')).toBe('record');
    expect(parseMediaRevealOverride(' record ')).toBe('record');
    for (const value of [undefined, '', 'RECORD', 'open', 'record:1']) expect(parseMediaRevealOverride(value), String(value)).toBeNull();
  });

  it('honours them only in an unpackaged test build, like FUSIONKIT_TEST_MEDIA_CAPS', () => {
    const values = { [TEST_MEDIA_CAPS_ENV]: 'nvenc', [TEST_MEDIA_FAIL_ENV]: 'no_device:first_attempt', [TEST_MEDIA_REVEAL_ENV]: 'record' };
    expect(resolveMediaTestHooks(testEnv(values), { packaged: false })).toEqual({
      caps: { kind: 'nvenc' }, fail: { code: 'no_device', when: 'first_attempt' }, reveal: 'record',
    });
    expect(resolveMediaTestHooks(testEnv(values), { packaged: true })).toEqual({ caps: null, fail: null, reveal: null });
    expect(resolveMediaTestHooks({ ...values, NODE_ENV: 'production' }, { packaged: false })).toEqual({ caps: null, fail: null, reveal: null });
    expect(resolveMediaTestHooks(values, { packaged: false })).toEqual({ caps: null, fail: null, reveal: null });
    expect(resolveMediaTestHooks(testEnv({ [TEST_MEDIA_FAIL_ENV]: 'bogus', [TEST_MEDIA_REVEAL_ENV]: 'open' }), { packaged: false }))
      .toEqual({ caps: null, fail: null, reveal: null });
  });

  it('tolerates exactly the warnings of module-encode design §7b, and the planned openh264 rate-control note', () => {
    const tolerated = [
      '[swscaler @ 000002920c4ad0c0] [warning] deprecated pixel format used, make sure you did set range correctly',
      '[ipod @ 000002e8096d78c0] [warning] Warning, extension is not .m4a nor .m4v Quicktime/Ipod might not play the file',
      '[aac @ 000002e8096dd240] [warning] Too many bits 11888.616780 > 6144 per frame requested, clamping to max',
      '[aist#0:0/pcm_s16le @ 000001d5101400c0] [warning] Guessed Channel Layout: 5.1',
      // Found running the planner's libopenh264 parameters (bit-rate mode without frame skipping, as planned).
      "[libopenh264 @ 000001e697519300] [warning] [OpenH264] this = 0x000001e699aeebe0, Warning:bEnableFrameSkip = 0,bitrate can't be controlled for "
        + 'RC_QUALITY_MODE,RC_BITRATE_MODE and RC_TIMESTAMP_MODE without enabling skip frame.',
    ];
    expect(TOLERATED_WARNINGS).toHaveLength(5);
    expect(unexpectedWarnings(tolerated.join('\n'))).toEqual([]);
    const others = [
      "[hevc_mf @ 0000] [warning] Incompatible pixel format 'p010le' for codec 'hevc_mf', auto-selecting format 'nv12'",
      '[libsvtav1 @ 0000] [error] Error parsing option lp: 1',
      '[mp4 @ 0000] [warning] Non-monotonic DTS',
    ];
    expect(unexpectedWarnings([...tolerated, 'Svt[info]: SVT [config]: preset 6', ...others].join('\r\n'))).toEqual(others);
  });
});

// ── The real ffmpeg ────────────────────────────────────────────────────────────────────────────

describe.skipIf(!available)('the executor with the real ffmpeg', () => {
  it('compresses: one run of exactly the plan\'s arguments into a recorded partial, probed back, published, nothing left behind', async () => {
    const whileRunning: { exists: boolean; recorded: boolean }[] = [];
    const h = await harness('compress', {
      // While ffmpeg runs, its partial exists and partials.json names it with its identity (AC-ENGINE-06-1).
      onSpawn: () => {
        const partial = h.spawns.at(-1)!.args.at(-1)!.slice('file:'.length);
        const records = JSON.parse(readFileSync(path.join(h.state, 'partials.json'), 'utf8')).records as { path: string; identity: unknown }[];
        whileRunning.push({ exists: existsSync(partial), recorded: records.some(record => record.path === partial && record.identity !== null) });
      },
    });
    const job = await jobFor(h, rich, defaultCompressSettings('h264'));
    const output = job.plan.outputs[0];
    expect(output.capSemantics).toBe('not_smaller');
    const seen = watch();
    const outcome = await h.executor.run(job, seen.hooks);

    if (!isSucceeded(outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.outputs).toHaveLength(1);
    const published = outcome.outputs[0];
    expect(published).toMatchObject({ index: 0, path: path.join(h.out, 'rich-compressed.mp4'), replaced: false });
    expect(outcome.summary).toBeUndefined();
    expect(outcome.warnings).toEqual([]);
    // Probed back: the planned streams, the source's duration, smaller than 98 % of the source.
    const back = await probed(published.path);
    expect(back.video.map(stream => stream.codec)).toEqual(['h264']);
    expect(back.audio.map(stream => stream.codec)).toEqual(['aac']);
    expect(Math.abs(durationOf(back) - durationOf(rich.info))).toBeLessThanOrEqual(100_000);
    expect(published.sizeBytes).toBe((await stat(published.path)).size);
    expect(published.sizeBytes).toBeLessThan(output.capBytes);

    // One ffmpeg, given exactly `toFfmpegArgs`: one -fs (the cap) and one -t (the duration ceiling), the input pinned, the partial last.
    expect(h.spawns).toHaveLength(1);
    const args = h.spawns[0].args;
    expect(argAfter(args, '-fs')).toEqual([String(output.capBytes)]);
    expect(argAfter(args, '-t')).toEqual([ffmpegSeconds(output.durationLimitUs!)]);
    expect(args.slice(args.indexOf('-i') - 4, args.indexOf('-i') + 2)).toEqual(['-f', 'matroska', '-protocol_whitelist', 'file', '-i', `file:${rich.path}`]);
    expect(args.slice(-4, -1)).toEqual(['-f', 'mp4', '-y']);
    expect(path.basename(args.at(-1)!)).toMatch(/^\.fusionkit-media-[0-9a-f]{8}\.partial$/);
    expect(path.dirname(args.at(-1)!.slice(5))).toBe(h.out);
    expect(whileRunning).toEqual([{ exists: true, recorded: true }]);
    // Its own short work folder, below normal priority (idle in this file), no affinity outside low-usage mode.
    expect(path.relative(path.join(h.state, 'work'), h.spawns[0].cwd)).toMatch(/^[0-9a-f]{8}$/);
    expect(h.priorities).toEqual([os.constants.priority.PRIORITY_BELOW_NORMAL]);
    expect(h.affinities).toEqual([]);

    // The queue was told what happens, in contract shapes: encoding then finalizing, the share rising to 1.
    expect(seen.invalid).toEqual([]);
    expect(seen.phases).toEqual(['encoding', 'finalizing']);
    expect(seen.progress.length).toBeGreaterThan(0);
    expect(seen.progress.at(-1)).toMatchObject({ fraction: 1, outputIndex: 0, outputCount: 1 });
    const fractions = seen.progress.map(value => value.fraction ?? 0);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expect(await readdir(h.out)).toEqual(['rich-compressed.mp4']);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);

  it('converts by remux and with low usage asks for idle priority and half the cores', async () => {
    const h = await harness('convert');
    const job = await jobFor(h, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }, { lowUsage: true });
    expect(job.plan.isRemuxOnly).toBe(true);
    const outcome = await h.executor.run(job, watch().hooks);

    if (!isSucceeded(outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.outputs).toMatchObject([{ index: 0, path: path.join(h.out, 'clip.mp4'), replaced: false }]);
    const back = await probed(outcome.outputs[0].path);
    expect(back.container.demuxer).toBe('mov');
    expect(back.video.map(stream => stream.codec)).toEqual(['h264']);
    expect(back.audio.map(stream => stream.codec)).toEqual(['aac']);
    expect(Math.abs(durationOf(back) - durationOf(clip.info))).toBeLessThanOrEqual(100_000);
    expect(argAfter(h.spawns[0].args, '-c:v:0')).toEqual(['copy']);
    expect(h.priorities).toEqual([os.constants.priority.PRIORITY_LOW]);
    expect(h.affinities).toHaveLength(1);
    expect(h.runs[0].result.tuning.priority).toBe('idle');
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);

  it('accepts an output whose duration cannot be checked with duration_unverified (AC-ENGINE-04-5)', async () => {
    const h = await harness('unverified');
    expect(raw.info.durationUs).toBeNull();
    const job = await jobFor(h, raw, { ...defaultCompressSettings('h264'), discardIfNotSmaller: false });
    expect(job.plan.outputs[0].expectedDurationUs).toBeNull();
    expect(job.plan.outputs[0].durationLimitUs).toBeNull();
    const outcome = await h.executor.run(job, watch().hooks);
    if (!isSucceeded(outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.warnings).toEqual(['duration_unverified']);
    expect(argAfter(h.spawns[0].args, '-t')).toEqual([]);
    expect((await probed(outcome.outputs[0].path)).video.map(stream => stream.codec)).toEqual(['h264']);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);

  it('publishes only an output that passes the check of AC-ENGINE-04-5: a planned stream missing or a wrong duration fails the item', async () => {
    const missing = await harness('streams-missing', { probe: partialOnly(info => ({ ...info, audio: [] })) });
    const lacking = await missing.executor.run(await jobFor(missing, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }), watch().hooks);
    if (!isFailed(lacking)) throw new Error(JSON.stringify(lacking));
    expect(lacking).toMatchObject({ code: 'encode_failed', outputs: [] });
    expect(lacking.log).toContain('[media-converter] The output lacks a planned stream.');
    expect(missing.runs[0].result).toMatchObject({ exitCode: 0, sawEnd: true, capHit: false });
    expect(await readdir(missing.out)).toEqual([]);
    expect(await leftovers(missing)).toEqual(NOTHING_LEFT);

    // 10 s where 2 s were planned: beyond max(2 s, 1 %), the tolerance (a 2 s sample cannot be shorter by more than that).
    const long = (info: MediaInfo): MediaInfo => ({ ...info, durationUs: 10_000_000, video: info.video.map(stream => ({ ...stream, durationUs: 10_000_000 })),
      audio: info.audio.map(stream => ({ ...stream, durationUs: 10_000_000 })) });
    const off = await harness('duration-off', { probe: partialOnly(long) });
    const wrong = await off.executor.run(await jobFor(off, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }), watch().hooks);
    if (!isFailed(wrong)) throw new Error(JSON.stringify(wrong));
    expect(wrong).toMatchObject({ code: 'encode_failed', outputs: [] });
    expect(wrong.log).toContain('[media-converter] The output is shorter or longer than its source.');
    expect(await readdir(off.out)).toEqual([]);
    expect(await leftovers(off)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('extracts every audio track, each published on its own; the ipod muxer\'s .partial warning is tolerated', async () => {
    const h = await harness('extract');
    const job = await jobFor(h, tracks, { task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: true });
    expect(job.plan.outputs.map(output => output.container.muxer)).toEqual(['ipod', 'ipod']);
    const seen = watch();
    const outcome = await h.executor.run(job, seen.hooks);

    if (!isSucceeded(outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.outputs.map(output => [output.index, path.basename(output.path)])).toEqual([[0, 'tracks.track1.eng.m4a'], [1, 'tracks.track2.jpn.m4a']]);
    for (const output of outcome.outputs) {
      const back = await probed(output.path);
      expect(back.kind).toBe('audio');
      expect(back.audio.map(stream => stream.codec)).toEqual(['aac']);
      expect(Math.abs(durationOf(back) - durationOf(tracks.info))).toBeLessThanOrEqual(100_000);
    }
    expect(h.spawns).toHaveLength(2);
    // The real warning was there, and tolerated.
    expect(h.runs.map(run => /extension is not \.m4a nor \.m4v/.test(run.result.redactedTail(256 * 1024)))).toEqual([true, true]);
    expect(new Set(seen.progress.map(value => `${value.outputIndex}/${value.outputCount}`))).toEqual(new Set(['0/2', '1/2']));
    expect(seen.phases).toEqual(['encoding', 'finalizing']);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);

  it('fails a 2-track extraction whose second track fails, listing the first as published (partly done)', async () => {
    // A real ffmpeg failure for the second track only: a bitstream filter that does not exist.
    const h = await harness('extract-partial', { tamper: (args, call) => call === 2 ? beforeOutput(args, '-bsf:a:0', 'fusionkit_injected_failure') : args });
    const job = await jobFor(h, tracks, { task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: true });
    const outcome = await h.executor.run(job, watch().hooks);

    if (!isFailed(outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.code).toBe('encode_failed');
    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.outputs[0]).toMatchObject({ index: 0, path: path.join(h.out, 'tracks.track1.eng.m4a') });
    expect((await probed(outcome.outputs[0].path)).audio).toHaveLength(1);
    expect(await readdir(h.out)).toEqual(['tracks.track1.eng.m4a']);
    // The redacted end of ffmpeg's log says why; no path of the run is in it.
    expect(outcome.log).toContain('Bitstream filter not found');
    expect(outcome.log).toContain('[media-converter] ffmpeg ended with an error.');
    expect(outcome.log).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(h.degraded).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('still writes the second track when the first fails, and reports the item partly done with the second', async () => {
    const h = await harness('extract-first-fails', { tamper: (args, call) => call === 1 ? beforeOutput(args, '-bsf:a:0', 'fusionkit_injected_failure') : args });
    const outcome = await h.executor.run(await jobFor(h, tracks, { task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: true }), watch().hooks);
    if (!isFailed(outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.code).toBe('encode_failed');
    expect(outcome.outputs.map(output => [output.index, path.basename(output.path)])).toEqual([[1, 'tracks.track2.jpn.m4a']]);
    expect(h.spawns).toHaveLength(2);
    expect(await readdir(h.out)).toEqual(['tracks.track2.jpn.m4a']);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('lists the track it had published when an "all tracks" extraction is cancelled during the next one, so it can be shown', async () => {
    const h = await harness('extract-cancel', { slow: call => call === 2 });
    const job = await jobFor(h, tracks, { task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: true });
    const seen = watch();
    const hooks: ExecutionHooks = {
      ...seen.hooks,
      progress: value => {
        seen.hooks.progress(value);
        if (value.outputIndex === 1 && (value.processedUs ?? 0) > 0) seen.controller.abort();
      },
    };
    const outcome = await h.executor.run(job, hooks);

    expect(seen.controller.signal.aborted).toBe(true);
    if (outcome.status !== 'cancelled') throw new Error(JSON.stringify(outcome));
    expect(outcome.outputs?.map(output => [output.index, output.path, output.replaced])).toEqual([[0, path.join(h.out, 'tracks.track1.eng.m4a'), false]]);
    expect(outcome.warnings).toEqual([]);
    expect(h.runs.map(run => run.result.cancelled)).toEqual([false, true]);
    // The first track is there and whole; nothing of the second is left.
    const first = await probed(outcome.outputs![0].path);
    expect(first.audio.map(stream => stream.codec)).toEqual(['aac']);
    expect(outcome.outputs![0].sizeBytes).toBe(first.sizeBytes);
    expect(await readdir(h.out)).toEqual(['tracks.track1.eng.m4a']);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('re-encodes a raw H.264 or HEVC stream, which a remux cannot time, for MP4, MKV and compress (module-encode design §7b)', async () => {
    const h = await harness('raw-streams');
    const frames = async (filePath: string) => (await pictures(filePath)).length;
    expect([raw.info.container.demuxer, rawHevc.info.container.demuxer]).toEqual(['h264', 'hevc']);
    expect([await frames(raw.path), await frames(rawHevc.path)]).toEqual([25, 60]);
    const cases: { source: Fixture; settings: ConversionSettings; encoder: string; codec: string; name: string; durationUs: number; frames: number }[] = [
      { source: raw, settings: { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }, encoder: 'libopenh264', codec: 'h264', name: 'raw.mp4', durationUs: 1_000_000, frames: 25 },
      { source: raw, settings: { ...DEFAULT_CONVERT_SETTINGS, target: 'mkv' }, encoder: 'libsvtav1', codec: 'av1', name: 'raw.mkv', durationUs: 1_000_000, frames: 25 },
      { source: rawHevc, settings: { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }, encoder: 'libopenh264', codec: 'h264', name: 'reordered.mp4', durationUs: 2_000_000, frames: 60 },
      { source: rawHevc, settings: { ...DEFAULT_CONVERT_SETTINGS, target: 'mkv' }, encoder: 'libsvtav1', codec: 'av1', name: 'reordered.mkv', durationUs: 2_000_000, frames: 60 },
      {
        source: rawHevc, settings: { ...defaultCompressSettings('hevc'), discardIfNotSmaller: false }, encoder: 'libkvazaar', codec: 'hevc',
        name: 'reordered-compressed.mp4', durationUs: 2_000_000, frames: 60,
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const job = await jobFor(h, entry.source, entry.settings);
      // A remux was asked for (or nothing else would do): the video is still encoded, and no +genpts is needed.
      expect(job.plan.isRemuxOnly, entry.name).toBe(false);
      expect(job.plan.outputs[0].generatePts, entry.name).toBe(false);
      const outcome = await h.executor.run(job, watch().hooks);
      if (!isSucceeded(outcome)) throw new Error(`${entry.name}: ${JSON.stringify(outcome)}`);
      expect(path.basename(outcome.outputs[0].path)).toBe(entry.name);
      expect(outcome.warnings).toContain('duration_unverified');
      const args = h.spawns[index].args;
      expect(argAfter(args, '-c:v:0'), entry.name).toEqual([entry.encoder]);
      expect(args).not.toContain('-fflags');
      // ffmpeg reported its progress to the end (a remux of these never leaves out_time=N/A; kvazaar's reordering keeps the last block behind the end).
      expect(h.runs[index].result).toMatchObject({ exitCode: 0, sawEnd: true, capHit: false });
      expect(h.runs[index].result.progress?.outTimeUs ?? 0, entry.name).toBeGreaterThan(entry.durationUs / 2);
      const back = await probed(outcome.outputs[0].path);
      expect(back.video.map(stream => stream.codec), entry.name).toEqual([entry.codec]);
      // Every picture, timed at the source's rate: 25 fps assumed for H.264 without timing, the 30 fps of the HEVC's VUI.
      expect(await frames(outcome.outputs[0].path), entry.name).toBe(entry.frames);
      expect(Math.abs(durationOf(back) - entry.durationUs), entry.name).toBeLessThanOrEqual(100_000);
    }
    expect(h.degraded).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);

  it('never gets the raw streams the probe does not admit: MPEG-4 Part 2 (m4v) and AV1 (obu) are container_not_allowed', async () => {
    const part2 = await make('part2.m4v', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=1:r=25', '-c:v', 'mpeg4', '-f', 'm4v');
    const av1 = await make('av1.obu', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=1:r=25', '-c:v', 'libsvtav1', '-preset', '10', '-f', 'obu');
    for (const file of [part2, av1]) expect(await prober.probe(file), path.basename(file)).toEqual({ ok: false, code: 'container_not_allowed' });
  }, REAL_TIMEOUT);

  it('remuxes a raw MPEG-2 stream with B-frames into MKV with +genpts, every picture as it was', async () => {
    const h = await harness('raw-mpeg2');
    expect(rawMpeg2.info.container.demuxer).toBe('mpegvideo');
    const job = await jobFor(h, rawMpeg2, { ...DEFAULT_CONVERT_SETTINGS, target: 'mkv' });
    expect(job.plan.isRemuxOnly).toBe(true);
    expect(job.plan.outputs[0].generatePts).toBe(true);
    const outcome = await h.executor.run(job, watch().hooks);
    if (!isSucceeded(outcome)) throw new Error(JSON.stringify(outcome));
    const args = h.spawns[0].args;
    expect(args.slice(args.indexOf('-fflags'), args.indexOf('-fflags') + 4)).toEqual(['-fflags', '+genpts', '-f', 'mpegvideo']);
    expect(argAfter(args, '-c:v:0')).toEqual(['copy']);
    expect(h.runs[0].result.progress?.outTimeUs ?? 0).toBeGreaterThan(1_900_000);
    const [source, copied] = await Promise.all([pictures(rawMpeg2.path), pictures(outcome.outputs[0].path)]);
    expect(source).toHaveLength(60);
    expect(copied).toEqual(source);
    expect(Math.abs(durationOf(await probed(outcome.outputs[0].path)) - 2_000_000)).toBeLessThanOrEqual(100_000);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);

  it('fails output_publish_failed when the finished output cannot be put under its name, and leaves neither partial nor placeholder', async () => {
    const injected = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
    // The volume cannot link (as exFAT), and the rename over the placeholder fails too.
    const h = await harness('publish-failed', { outputs: { fs: {
      link: async () => { throw injected('EISDIR'); },
      rename: async () => { throw injected('EIO'); },
    } } });
    const outcome = await h.executor.run(await jobFor(h, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }), watch().hooks);
    expect(outcome).toMatchObject({ status: 'failed', code: 'output_publish_failed', outputs: [] });
    expect(h.runs[0].result).toMatchObject({ exitCode: 0, sawEnd: true });
    expect(await readdir(h.out)).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('skips a pre-compressed still picture at the quality tier as not_smaller when it reaches the cap early, leaving no partial', async () => {
    const h = await harness('not-smaller');
    const job = await jobFor(h, still, { ...defaultCompressSettings('hevc'), tier: 'quality' });
    expect(job.plan.summary.encoders[0].encoder).toBe('libkvazaar');
    const output = job.plan.outputs[0];
    expect(output.capSemantics).toBe('not_smaller');
    expect(output.capBytes).toBe(Math.floor(still.info.sizeBytes * 0.98));
    const outcome = await h.executor.run(job, watch().hooks);

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_smaller' });
    expect(h.runs).toHaveLength(1);
    const run = h.runs[0].result;
    // ffmpeg stopped at the cap (-fs), well before the end of the 2 s picture.
    expect(run.capHit).toBe(true);
    expect(run.outputBytes).toBeGreaterThanOrEqual(output.capBytes - Math.min(64 * 1024, Math.floor(output.capBytes * 0.005)));
    expect(run.progress?.outTimeUs ?? 0).toBeLessThan(durationOf(still.info) - 500_000);
    expect(await readdir(h.out)).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);

    // Finished under the cap's slack but read back at 98 % of the source: not smaller either (module-encode design §7).
    const full = await harness('not-smaller-at-end', { probe: partialOnly(info => ({ ...info, sizeBytes: Math.floor(rich.info.sizeBytes * 0.98) })) });
    const finished = await full.executor.run(await jobFor(full, rich, defaultCompressSettings('h264')), watch().hooks);
    expect(finished).toEqual({ status: 'skipped', reason: 'not_smaller' });
    expect(full.runs[0].result).toMatchObject({ exitCode: 0, sawEnd: true, capHit: false });
    expect(await readdir(full.out)).toEqual([]);
    expect(await leftovers(full)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('cancels: ffmpeg is gone within 3 s, then the partial, the work folder and the 2-pass log in it are removed (AC-ENGINE-04-3)', async () => {
    let exitedAt: number | null = null;
    let passLog = '';
    const h = await harness('cancel', {
      slow: () => true,
      onSpawn: (child, options) => {
        child.once('exit', () => { exitedAt = performance.now(); });
        // What an I2 two-pass run keeps in the work folder.
        passLog = path.join(String(options.cwd), 'ffmpeg2pass-0.log');
        void writeFile(passLog, 'pass 1 statistics');
      },
    });
    const job = await jobFor(h, rich, defaultCompressSettings('h264'));
    const seen = watch();
    let cancelledAt: number | null = null;
    let partialWhileRunning = false;
    const cancelOnProgress = seen.hooks.progress;
    const hooks: ExecutionHooks = {
      ...seen.hooks,
      progress: value => {
        cancelOnProgress(value);
        if (cancelledAt !== null || !(value.processedUs! > 0)) return;
        partialWhileRunning = existsSync(h.spawns[0].args.at(-1)!.slice(5)) && existsSync(passLog);
        cancelledAt = performance.now();
        seen.controller.abort();
      },
    };
    const outcome = await h.executor.run(job, hooks);

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(cancelledAt).not.toBeNull();
    expect(partialWhileRunning).toBe(true);
    expect(exitedAt).not.toBeNull();
    expect(exitedAt! - cancelledAt!).toBeLessThan(3_000);
    expect(h.runs[0].result.cancelled).toBe(true);
    expect(existsSync(passLog)).toBe(false);
    expect(existsSync(h.spawns[0].cwd)).toBe(false);
    expect(await readdir(h.out)).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('falls back once when NVENC fails before its first frame (FUSIONKIT_TEST_MEDIA_FAIL), with encoder_fallback in the plan summary', async () => {
    const hooks = resolveMediaTestHooks({ NODE_ENV: 'test', [TEST_MEDIA_CAPS_ENV]: 'nvenc', [TEST_MEDIA_FAIL_ENV]: 'no_device:first_attempt' }, { packaged: false });
    let table: MediaCapabilities | undefined;
    const h = await harness('fallback', {
      failure: hooks.fail,
      capabilities: {
        planner: () => table!.planner(),
        markDegraded: encoder => table!.markDegraded(encoder),
      },
    });
    table = new MediaCapabilities({ runtime, root: h.state, gpuInfo: async () => null, isHardwareEncodeRunning: () => false, override: hooks.caps, log: () => {} });
    const job = await jobFor(h, clip, defaultCompressSettings('h264'));
    expect(job.plan.summary.encoders[0]).toEqual({ encoder: 'h264_nvenc', variant: '8bit' });
    const seen = watch();
    const outcome = await h.executor.run(job, seen.hooks);

    if (!isSucceeded(outcome)) throw new Error(JSON.stringify(outcome));
    // The injected failure started no ffmpeg; the one run is the retry, on the next encoder of the chain this table has.
    expect(h.degraded).toEqual(['h264_nvenc']);
    expect(h.runs).toHaveLength(1);
    expect(argAfter(h.runs[0].request.args, '-c:v:0')).toEqual(['libopenh264']);
    expect(table.status().capabilities).toMatchObject({ state: 'ready', degraded: ['h264_nvenc'] });
    expect(outcome.warnings).toEqual(['encoder_fallback']);
    const summary = planSummarySchema.parse(outcome.summary);
    expect(summary.encoders[0]).toEqual({ encoder: 'libopenh264', variant: '8bit' });
    const videoIndex = clip.info.primaryVideoIndex!;
    expect(summary.warnings.filter(warning => warning.code === 'encoder_fallback'))
      .toEqual([{ code: 'encoder_fallback', streams: [videoIndex], count: 1, from: 'h264_nvenc', to: 'libopenh264' }]);
    const back = await probed(outcome.outputs[0].path);
    expect(back.video.map(stream => stream.codec)).toEqual(['h264']);
    expect(seen.phases).toEqual(['encoding', 'finalizing']);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);

  it('retries only once: the next hardware encoder failing before its first frame too is degraded, and the item fails', async () => {
    const h = await harness('fallback-once', {
      failure: { code: 'session_limit', when: 'first_attempt' },
      capabilities: tableCaps({ h264_nvenc: { variants: { '8bit': true } }, h264_mf: { variants: { '8bit': true } } }),
      // The retry on Media Foundation fails for real before any frame: an output option ffmpeg cannot set up.
      tamper: args => beforeOutput(args, '-bsf:v:0', 'fusionkit_injected_failure'),
    });
    const job = await jobFor(h, clip, defaultCompressSettings('h264'));
    expect(job.plan.summary.encoders[0].encoder).toBe('h264_nvenc');
    const outcome = await h.executor.run(job, watch().hooks);

    if (!isFailed(outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.code).toBe('encode_failed');
    expect(outcome.outputs).toEqual([]);
    expect(h.degraded).toEqual(['h264_nvenc', 'h264_mf']);
    expect(h.runs).toHaveLength(1);
    expect(argAfter(h.runs[0].request.args, '-c:v:0')).toEqual(['h264_mf']);
    expect(h.runs[0].result.firstFrameSeen).toBe(false);
    expect(planSummarySchema.parse(outcome.summary).warnings.filter(warning => warning.code === 'encoder_fallback'))
      .toEqual([{ code: 'encoder_fallback', streams: [clip.info.primaryVideoIndex!], count: 1, from: 'h264_nvenc', to: 'h264_mf' }]);
    expect(outcome.warnings).toContain('encoder_fallback');
    expect(await readdir(h.out)).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('settles cancelled, not failed, when the cancel comes while a hardware failure is planned again', async () => {
    // The fallback's capability read is the table's second (the first plans the job); the cancel comes during it.
    const table = tableCaps({ h264_nvenc: { variants: { '8bit': true } } });
    let reads = 0;
    let cancel = () => {};
    const h = await harness('fallback-cancelled', {
      failure: { code: 'no_device', when: 'first_attempt' },
      capabilities: { planner: async () => { if (++reads === 2) cancel(); return table.planner(); }, markDegraded: encoder => table.markDegraded(encoder) },
    });
    const job = await jobFor(h, clip, defaultCompressSettings('h264'));
    expect(job.plan.summary.encoders[0].encoder).toBe('h264_nvenc');
    const seen = watch();
    cancel = () => seen.controller.abort();
    const outcome = await h.executor.run(job, seen.hooks);

    expect(reads).toBe(2);
    expect(outcome).toEqual({ status: 'cancelled' });
    // The encoder failed before its first frame all the same: it stays degraded; nothing ran, nothing is left.
    expect(h.degraded).toEqual(['h264_nvenc']);
    expect(h.spawns).toHaveLength(0);
    expect(await readdir(h.out)).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it.skipIf(!NVIDIA_DRIVER)('does not retry when NVENC fails after its first frame', async () => {
    let killed = false;
    let text = '';
    const h = await harness('after-first-frame', {
      capabilities: tableCaps({ h264_nvenc: { variants: { '8bit': true } } }),
      slow: () => true,
      // The encoder dies once a progress block has reported frames. NVENC holds back its look-ahead
      // (32 frames and 3 B-frames), so the clip has 120 frames: the first are written before the end.
      onSpawn: child => {
        child.stdout!.on('data', chunk => {
          text += String(chunk);
          if (!killed && /frame=[1-9]\d*[\s\S]*?progress=continue/.test(text)) { killed = true; child.kill(); }
        });
      },
    });
    const job = await jobFor(h, clip60, defaultCompressSettings('h264'));
    expect(job.plan.summary.encoders[0].encoder).toBe('h264_nvenc');
    const outcome = await h.executor.run(job, watch().hooks);

    if (!isFailed(outcome)) throw new Error(`${JSON.stringify(outcome)}
${text}`);
    expect(killed).toBe(true);
    expect(outcome.code).toBe('encode_failed');
    expect(outcome.summary).toBeUndefined();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].result.firstFrameSeen).toBe(true);
    expect(h.runs[0].result.cancelled).toBe(false);
    expect(h.degraded).toEqual([]);
    expect(await readdir(h.out)).toEqual([]);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('judges a hardware plan by its first frame on any machine: killed after it, no retry; killed before it, one fallback', async () => {
    // The plan, and so the executor, says h264_nvenc; the first process runs the CPU plan's arguments for
    // the same partial, so a real encoder writes real frames on a computer without NVENC too.
    const settings = defaultCompressSettings('h264');
    const cpu = buildPlan(clip.info, settings, { encoders: {}, degraded: [], nvencMin: { width: 129, height: 33 } });
    if (cpu.status !== 'ready') throw new Error(`The CPU plan is ${cpu.status}.`);
    const standIn = (args: string[]) => toFfmpegArgs(cpu.plan.outputs[0],
      { inputPath: clip.path, demuxer: clip.info.container.demuxer, partialPath: args.at(-1)!.slice('file:'.length), lowUsage: false });
    const nvencOnly = () => tableCaps({ h264_nvenc: { variants: { '8bit': true } } });

    let killed = false;
    let text = '';
    const after = await harness('stand-in-after-first-frame', {
      capabilities: nvencOnly(), slow: () => true, tamper: (args, call) => call === 1 ? standIn(args) : args,
      onSpawn: child => child.stdout!.on('data', chunk => {
        text += String(chunk);
        if (!killed && /frame=[1-9]\d*[\s\S]*?progress=continue/.test(text)) { killed = true; child.kill(); }
      }),
    });
    const job = await jobFor(after, clip, settings);
    expect(job.plan.summary.encoders[0].encoder).toBe('h264_nvenc');
    const failed = await after.executor.run(job, watch().hooks);
    if (!isFailed(failed)) throw new Error(`${JSON.stringify(failed)}\n${text}`);
    expect(killed).toBe(true);
    expect(argAfter(after.runs[0].request.args, '-c:v:0')).toEqual(['libopenh264']);
    expect(after.runs[0].result).toMatchObject({ firstFrameSeen: true, cancelled: false, sawEnd: false });
    expect(failed.code).toBe('encode_failed');
    expect(failed.summary).toBeUndefined();
    expect(after.runs).toHaveLength(1);
    expect(after.degraded).toEqual([]);
    expect(await readdir(after.out)).toEqual([]);
    expect(await leftovers(after)).toEqual(NOTHING_LEFT);

    // Killed as it starts: no frame yet, so the hardware encoder is degraded and the item planned again, once.
    const before = await harness('stand-in-before-first-frame', {
      capabilities: nvencOnly(), tamper: (args, call) => call === 1 ? standIn(args) : args,
      onSpawn: (child, _options, call) => { if (call === 1) child.kill(); },
    });
    const retried = await before.executor.run(await jobFor(before, clip, settings), watch().hooks);
    if (!isSucceeded(retried)) throw new Error(JSON.stringify(retried));
    expect(before.runs.map(run => run.result.firstFrameSeen)).toEqual([false, true]);
    expect(before.runs[0].result.exitCode).not.toBe(0);
    expect(before.degraded).toEqual(['h264_nvenc']);
    expect(argAfter(before.runs[1].request.args, '-c:v:0')).toEqual(['libopenh264']);
    expect(retried.warnings).toEqual(['encoder_fallback']);
    expect(planSummarySchema.parse(retried.summary).warnings.filter(warning => warning.code === 'encoder_fallback'))
      .toEqual([{ code: 'encoder_fallback', streams: [clip.info.primaryVideoIndex!], count: 1, from: 'h264_nvenc', to: 'libopenh264' }]);
    expect(await readdir(before.out)).toEqual(['clip-compressed.mp4']);
    expect(await leftovers(before)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('verifies the runtime again when ffmpeg cannot be started, then tries once more (design §1)', async () => {
    // Each verification answers, in turn: tools whose ffmpeg is not there (Windows refuses to start it,
    // ENOENT), the real tools, or a runtime that no longer verifies.
    const missingFfmpeg = path.join(root, 'missing', 'ffmpeg.exe');
    const scripted = (...answers: ('missing' | 'real' | 'unverifiable')[]) => {
      const counts = { acquire: 0, invalidate: 0 };
      const scriptedRuntime: ExecutorRuntime = {
        acquire: async () => {
          const answer = answers[Math.min(counts.acquire++, answers.length - 1)];
          if (answer === 'unverifiable') throw new MediaRuntimeError('runtime_missing', 'The bundled media runtime is missing.');
          const real = await runtime.acquire();
          return answer === 'real' ? real : { ...real, ffmpeg: missingFfmpeg };
        },
        invalidate: () => { counts.invalidate++; },
      };
      return { runtime: scriptedRuntime, counts };
    };
    const convert: ConversionSettings = { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' };

    // Refused once: the runtime is verified again, and its tools start the second run on the same partial.
    const first = scripted('missing', 'real');
    const once = await harness('spawn-once', { runtime: first.runtime });
    const recovered = await once.executor.run(await jobFor(once, clip, convert), watch().hooks);
    if (!isSucceeded(recovered)) throw new Error(JSON.stringify(recovered));
    expect(once.runs.map(run => [run.request.ffmpeg, run.result.status])).toEqual([[missingFfmpeg, 'spawn_error'], [tools.ffmpeg, 'closed']]);
    expect(once.runs[1].request.outputPath).toBe(once.runs[0].request.outputPath);
    expect(first.counts).toEqual({ acquire: 2, invalidate: 1 });
    expect(await readdir(once.out)).toEqual(['clip.mp4']);
    expect(await leftovers(once)).toEqual(NOTHING_LEFT);

    // Refused again: runtime_spawn_failed, and the next use verifies the runtime first.
    const always = scripted('missing');
    const never = await harness('spawn-never', { runtime: always.runtime });
    const refused = await never.executor.run(await jobFor(never, clip, convert), watch().hooks);
    if (!isFailed(refused)) throw new Error(JSON.stringify(refused));
    expect(refused).toMatchObject({ code: 'runtime_spawn_failed', outputs: [] });
    expect(refused.log).toContain('[media-converter] ffmpeg could not be started.');
    expect(never.runs.map(run => run.result.status)).toEqual(['spawn_error', 'spawn_error']);
    expect(always.counts).toEqual({ acquire: 2, invalidate: 2 });
    expect(await readdir(never.out)).toEqual([]);
    expect(await leftovers(never)).toEqual(NOTHING_LEFT);

    // A runtime that no longer verifies fails the item with its own code, without a second start.
    const vanished = scripted('missing', 'unverifiable');
    const gone = await harness('spawn-unverified', { runtime: vanished.runtime });
    const missing = await gone.executor.run(await jobFor(gone, clip, convert), watch().hooks);
    expect(missing).toMatchObject({ status: 'failed', code: 'runtime_missing', outputs: [] });
    expect(gone.runs).toHaveLength(1);
    expect(vanished.counts).toEqual({ acquire: 2, invalidate: 1 });
    expect(await readdir(gone.out)).toEqual([]);
    expect(await leftovers(gone)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('injects only the first run of an item, and a failure that is not the encoder\'s never falls back', async () => {
    // CPU encoder: an injected device failure is an encode failure with the device\'s own log, and the item\'s next run is real.
    const cpu = await harness('injected-cpu', { failure: parseMediaFailInjection('no_device:first_attempt') });
    const job = await jobFor(cpu, clip, defaultCompressSettings('h264'));
    const first = await cpu.executor.run(job, watch().hooks);
    if (!isFailed(first)) throw new Error(JSON.stringify(first));
    expect(first.code).toBe('encode_failed');
    expect(classifyEncoderFailure(first.log!).code).toBe('no_device');
    expect(first.log).toContain('FUSIONKIT_TEST_MEDIA_FAIL');
    expect(cpu.spawns).toHaveLength(0);
    expect(cpu.degraded).toEqual([]);
    expect(await leftovers(cpu)).toEqual(NOTHING_LEFT);
    const second = await cpu.executor.run(job, watch().hooks);
    expect(second.status).toBe('succeeded');
    expect(cpu.spawns).toHaveLength(1);

    // A full disk on a hardware plan: disk_full, no degradation, no retry.
    const disk = await harness('injected-disk', { failure: parseMediaFailInjection('disk_full:first_attempt'),
      capabilities: tableCaps({ h264_nvenc: { variants: { '8bit': true } } }) });
    const nvencJob = await jobFor(disk, clip, defaultCompressSettings('h264'));
    const full = await disk.executor.run(nvencJob, watch().hooks);
    if (!isFailed(full)) throw new Error(JSON.stringify(full));
    expect(full.code).toBe('disk_full');
    expect(full.log).toContain('No space left on device');
    expect(full.summary).toBeUndefined();
    expect(disk.degraded).toEqual([]);
    expect(disk.spawns).toHaveLength(0);
    expect(await leftovers(disk)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('refuses before anything runs when the volume lacks the caps of every running output plus 512 MB (disk_space_low)', async () => {
    let free = HEADROOM;
    let spawnedA!: () => void;
    const aRunning = new Promise<void>(resolve => { spawnedA = resolve; });
    const h = await harness('space', {
      outputs: { statfs: async () => ({ bavail: BigInt(free), bsize: 1n }) },
      slow: call => call === 1,
      onSpawn: (_child, _options, call) => { if (call === 1) spawnedA(); },
    });
    const a = await jobFor(h, clip, defaultCompressSettings('h264'));
    const b = await jobFor(h, rich, defaultCompressSettings('h264'));
    const capA = a.plan.outputs[0].capBytes, capB = b.plan.outputs[0].capBytes;

    // Alone: 512 MB free is not 512 MB plus the cap.
    const alone = await h.executor.run(a, watch().hooks);
    if (!isFailed(alone)) throw new Error(JSON.stringify(alone));
    expect(alone.code).toBe('disk_space_low');
    // The bytes go to the item's failed state for the interface (AC-ENGINE-06-4), and into the log in words.
    expect(alone.space).toEqual({ requiredBytes: HEADROOM + capA, availableBytes: HEADROOM });
    expect(alone.log).toContain(`${HEADROOM + capA} bytes`);
    expect(alone.log).toContain(`${HEADROOM} bytes`);
    expect(h.spawns).toHaveLength(0);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);

    // Room for both caps but one byte: B is refused while A runs on the same volume, and starts once A is done.
    free = HEADROOM + capA + capB - 1;
    const runningA = h.executor.run(a, watch().hooks);
    await aRunning;
    const refused = await h.executor.run(b, watch().hooks);
    if (!isFailed(refused)) throw new Error(JSON.stringify(refused));
    expect(refused.code).toBe('disk_space_low');
    expect(refused.space).toEqual({ requiredBytes: HEADROOM + capA + capB, availableBytes: free });
    expect(refused.log).toContain(`${HEADROOM + capA + capB} bytes`);
    expect(refused.log).toContain(`${free} bytes`);
    expect(h.spawns).toHaveLength(1);
    expect((await runningA).status).toBe('succeeded');
    const later = await h.executor.run(b, watch().hooks);
    expect(later.status).toBe('succeeded');
    expect(h.spawns).toHaveLength(2);

    // An item that failed while running gives its space back too: after C stops at its 20 KB cap, B fits beside nothing else.
    const c = await jobFor(h, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' },
      { plan: plan => ({ ...plan, outputs: plan.outputs.map(output => ({ ...output, capBytes: 20_000 })) }) });
    free = HEADROOM + capB + 20_000 - 1;
    expect(await h.executor.run(c, watch().hooks)).toMatchObject({ status: 'failed', code: 'output_cap_exceeded' });
    expect((await h.executor.run(b, watch().hooks)).status).toBe('succeeded');
    expect(h.spawns).toHaveLength(4);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('checks the input once more when the item starts: an edited file is input_changed, a deleted one input_missing', async () => {
    const h = await harness('input-check');
    const copy = path.join(h.dir, 'copy.mkv');
    await writeFile(copy, await readFile(clip.path));
    const source: Fixture = { path: copy, info: await probed(copy) };
    const job = await jobFor(h, source, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' });
    await appendFile(copy, 'edited after it was added');
    expect(await h.executor.run(job, watch().hooks)).toMatchObject({ status: 'failed', code: 'input_changed', outputs: [] });
    await unlink(copy);
    expect(await h.executor.run(job, watch().hooks)).toMatchObject({ status: 'failed', code: 'input_missing', outputs: [] });
    expect(h.spawns).toHaveLength(0);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('refuses a cap over 4 GiB on FAT32, an output that is an input, and fails a non-compress output that reaches its cap', async () => {
    const fat = await harness('fat32', { outputs: { volumeFileSystem: async () => 'fat32' } });
    const huge = await jobFor(fat, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' },
      { plan: plan => ({ ...plan, outputs: plan.outputs.map(output => ({ ...output, capBytes: 5 * GiB })) }) });
    const refused = await fat.executor.run(huge, watch().hooks);
    expect(refused).toMatchObject({ status: 'failed', code: 'file_too_large_for_volume', outputs: [] });
    // FAT32's 4 GiB limit is no shortage of free space: no bytes to show.
    expect(refused).not.toHaveProperty('space');
    expect(fat.spawns).toHaveLength(0);
    expect(await leftovers(fat)).toEqual(NOTHING_LEFT);

    const same = await harness('output-is-input');
    const existing = path.join(same.out, 'clip.mp4');
    await writeFile(existing, 'another queued input');
    const onInput = await jobFor(same, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }, { inputPaths: [clip.path, existing.toUpperCase()] });
    expect(await same.executor.run(onInput, watch().hooks)).toMatchObject({ status: 'failed', code: 'output_is_input', outputs: [] });
    expect(await readFile(existing, 'utf8')).toBe('another queued input');
    expect(same.spawns).toHaveLength(0);
    expect(await leftovers(same)).toEqual(NOTHING_LEFT);

    const capped = await harness('cap-exceeded');
    const small = await jobFor(capped, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' },
      { plan: plan => ({ ...plan, outputs: plan.outputs.map(output => ({ ...output, capBytes: 20_000 })) }) });
    expect(small.plan.outputs[0].capSemantics).toBe('output_cap_exceeded');
    const cut = await capped.executor.run(small, watch().hooks);
    expect(cut).toMatchObject({ status: 'failed', code: 'output_cap_exceeded', outputs: [] });
    expect(argAfter(capped.spawns[0].args, '-fs')).toEqual(['20000']);
    expect(capped.runs[0].result.capHit).toBe(true);
    expect(await readdir(capped.out)).toEqual([]);
    expect(await leftovers(capped)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('numbers an output whose name another item of the batch holds, even when overwriting, with output_name_collision', async () => {
    const h = await harness('batch-names');
    const twin = path.join(media, 'twin', 'clip.mkv');
    await mkdir(path.dirname(twin), { recursive: true });
    await writeFile(twin, await readFile(clip.path));
    const other: Fixture = { path: twin, info: await probed(twin) };
    const first = await h.executor.run(await jobFor(h, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }), watch().hooks);
    expect(first).toMatchObject({ status: 'succeeded', outputs: [{ path: path.join(h.out, 'clip.mp4') }], warnings: [] });
    // Same name from another source in the same batch: confirmed for overwrite, yet the name the batch published is not replaced.
    const second = await h.executor.run(await jobFor(h, other, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' },
      { conflict: 'overwrite', confirmedReplace: ['clip.mp4'] }), watch().hooks);
    expect(second).toMatchObject({ status: 'succeeded', outputs: [{ path: path.join(h.out, 'clip (1).mp4'), replaced: false }], warnings: ['output_name_collision'] });
    expect(h.trashed).toEqual([]);
    // A new batch may take the name again.
    h.executor.endBatch();
    const third = await h.executor.run(await jobFor(h, other, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }), watch().hooks);
    expect(third).toMatchObject({ status: 'succeeded', outputs: [{ path: path.join(h.out, 'clip (2).mp4') }], warnings: [] });
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
  }, REAL_TIMEOUT);

  it('overwrites only a confirmed file, through the recycle bin; an unconfirmed one is numbered beside', async () => {
    const h = await harness('overwrite');
    const existing = path.join(h.out, 'clip.mp4');
    await writeFile(existing, 'not confirmed');
    const unconfirmed = await jobFor(h, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }, { conflict: 'overwrite', confirmedReplace: [] });
    const numbered = await h.executor.run(unconfirmed, watch().hooks);
    if (!isSucceeded(numbered)) throw new Error(JSON.stringify(numbered));
    expect(numbered.outputs).toMatchObject([{ path: path.join(h.out, 'clip (1).mp4'), replaced: false }]);
    expect(await readFile(existing, 'utf8')).toBe('not confirmed');
    expect(h.trashed).toEqual([]);
    h.executor.endBatch();

    const confirmed = await jobFor(h, clip, { ...DEFAULT_CONVERT_SETTINGS, target: 'mp4' }, { conflict: 'overwrite', confirmedReplace: ['CLIP.mp4'] });
    const replaced = await h.executor.run(confirmed, watch().hooks);
    if (!isSucceeded(replaced)) throw new Error(JSON.stringify(replaced));
    expect(replaced.outputs).toMatchObject([{ path: existing, replaced: true }]);
    expect(h.trashed).toEqual([existing]);
    expect((await probed(existing)).video.map(stream => stream.codec)).toEqual(['h264']);
    expect((await readdir(h.out)).sort()).toEqual(['clip (1).mp4', 'clip.mp4']);
    expect(await leftovers(h)).toEqual(NOTHING_LEFT);
    expectCleanLogs(h);
  }, REAL_TIMEOUT);
});
