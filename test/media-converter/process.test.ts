import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import type { MediaInfo } from '../../src/media-converter/contract';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { MediaRuntime, type MediaSpawn, type MediaTools } from '../../electron/main/media-converter/engine/runtime';
import { MediaProber } from '../../electron/main/media-converter/engine/probe';
import type { ProgressState } from '../../electron/main/media-converter/engine/progress';
import {
  assertGuardedInputs, assessStall, capSlackBytes, classifyStderrLine, durationToleranceUs, encodeEnvironment, ENCODE_PROCESS_POLICY, externalizeLongFilters,
  FFMPEG_COMMON_PREFIX, ffmpegInput, judgeEncode, lowUsageAffinityMask, runEncodeProcess, runFailure, setAffinityWithPowerShell, STALL_THRESHOLDS,
  type EncodeClock, type EncodeProcessDependencies, type EncodeProcessRequest, type EncodeRunResult, type PlannedStreamCounts, type StallThresholds,
} from '../../electron/main/media-converter/engine/process';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * The encoding process (design §4, R-ENGINE-04). The first half drives `runEncodeProcess` with a
 * scripted child and a manual clock (the production thresholds, kill and close handling); the
 * second runs the real bundled ffmpeg on lavfi samples of at most 2 s and 320×180 — 64×36 for the
 * stderr flood, and a 2 s clip whose timestamps jump to 20 s for stalls and durations (once with
 * 20 s of 8 kHz audio beside it, for a video cut short under a long container). Fixtures are
 * made at idle priority; the runs under test lower themselves (that is what is checked). Skipped
 * when the runtime has not been staged (build/subtitle-studio-resources/transcription).
 */

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
/** AC-ENGINE-04-4: stderr kept in memory. */
const STDERR_KEPT = 256 * 1024;
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const nodeSpawn: MediaSpawn = (command, args, options) => spawn(command, [...args], options);

// ── A scripted child and a manual clock ────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  kill() { this.kills++; return true; }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) { this.emit('exit', code, signal); this.emit('close', code, signal); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function manualClock() {
  let now = 0;
  const ticks = new Set<() => void>();
  const clock: EncodeClock & { advance(ms: number): void; watching(): number } = {
    now: () => now,
    every: (_intervalMs, tick) => { ticks.add(tick); return () => ticks.delete(tick); },
    advance: ms => { now += ms; for (const tick of [...ticks]) tick(); },
    watching: () => ticks.size,
  };
  return clock;
}

let scratch: string;
const FAKE_FFMPEG = path.resolve(os.tmpdir(), 'fk-fake', 'ffmpeg.exe');
const FAKE_INPUT = path.resolve(os.tmpdir(), 'fk-fake', 'in.mkv');
const fakeRequest = (fields: Partial<EncodeProcessRequest> = {}): EncodeProcessRequest => ({
  ffmpeg: FAKE_FFMPEG, args: [...ffmpegInput(FAKE_INPUT, 'matroska'), '-c', 'copy', '-f', 'matroska', '-y', 'file:C:\\out\\x.mkv'],
  workDirectory: path.join(scratch, 'work'), env: { PATH: 'C:\\x' }, expectedDurationUs: 10_000_000, capBytes: null, outputPath: null, lowUsage: false,
  redaction: { inputs: [FAKE_INPUT] }, ...fields,
});
/** Starts a run on a scripted child; nothing touches a real process (priority is stubbed, the pid is made up). */
function fakeRun(fields: Partial<EncodeProcessRequest> = {}, dependencies: EncodeProcessDependencies = {}) {
  const child = new FakeChild();
  const clock = manualClock();
  const priorities: number[] = [];
  const logs: string[] = [];
  const spawned: { args: readonly string[]; options: SpawnOptions }[] = [];
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const result = runEncodeProcess(fakeRequest(fields), {
    spawn: (_command, args, options) => {
      spawned.push({ args, options });
      setImmediate(() => { child.emit('spawn'); markReady(); });
      return child as unknown as ChildProcess;
    },
    setPriority: (_pid, priority) => { priorities.push(priority); },
    setAffinity: async () => undefined,
    clock, closeGraceMs: 50, log: message => { logs.push(message); }, ...dependencies,
  });
  return { child, clock, priorities, logs, spawned, result, ready };
}
const progressBlock = (fields: Record<string, string | number>) => Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join('');

beforeAll(async () => { scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fk-process-'))); });
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

describe('the ffmpeg arguments', () => {
  const input = 'D:\\Media\\a clip.mkv';

  it('pins each input to its probed demuxer, the file protocol and a file: path', () => {
    expect(ffmpegInput(input, 'matroska')).toEqual(['-f', 'matroska', '-protocol_whitelist', 'file', '-i', 'file:D:\\Media\\a clip.mkv']);
    expect(() => ffmpegInput('clip.mkv', 'matroska')).toThrow(TypeError);
    expect(() => ffmpegInput(input, 'lavfi' as never)).toThrow(TypeError);
    expect(() => ffmpegInput(input, 'hls' as never)).toThrow(TypeError);
    // Input options may come first; every -i must be guarded, and one at least must exist.
    expect(() => assertGuardedInputs(['-re', '-ss', '3', ...ffmpegInput(input, 'mov'), ...ffmpegInput('E:\\b.mp4', 'mov'), 'file:E:\\o.mkv'])).not.toThrow();
    for (const unguarded of [
      ['-i', `file:${input}`],
      ['-f', 'matroska', '-i', `file:${input}`],
      ['-protocol_whitelist', 'file', '-f', 'matroska', '-i', `file:${input}`],
      ['-f', 'lavfi', '-protocol_whitelist', 'file', '-i', 'testsrc2'],
      ['-f', 'matroska', '-protocol_whitelist', 'file,http', '-i', `file:${input}`],
      ['-f', 'matroska', '-protocol_whitelist', 'file', '-i', input],
      ['-f', 'matroska', '-protocol_whitelist', 'file', '-i', 'file:relative.mkv'],
      [...ffmpegInput(input, 'matroska'), '-f', 'mov', '-i', 'file:E:\\b.mp4'],
      ['-f', 'matroska', '-protocol_whitelist', 'file', '-i'],
      ['-c', 'copy', 'out.mkv'],
    ]) expect(() => assertGuardedInputs(unguarded)).toThrow(TypeError);
  });

  it('adds the common prefix once and refuses what the prefix owns, a cap without -fs, and -fs without a cap', async () => {
    const run = fakeRun();
    await run.ready;
    run.child.close();
    await run.result;
    expect(run.spawned[0].args.slice(0, FFMPEG_COMMON_PREFIX.length)).toEqual(['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning',
      '-stats_period', '0.5', '-progress', 'pipe:1']);
    const already = fakeRun({ args: [...FFMPEG_COMMON_PREFIX, ...fakeRequest().args] });
    await already.ready;
    already.child.close();
    await already.result;
    expect(already.spawned[0].args).toEqual(run.spawned[0].args);
    const body = fakeRequest().args;
    for (const reserved of [['-loglevel', 'error'], ['-v', 'quiet'], ['-progress', 'pipe:2'], ['-stats_period', '5'], ['-nostdin'], ['-report']]) {
      await expect(runEncodeProcess(fakeRequest({ args: [...reserved, ...body] }))).rejects.toThrow(/prefix owns/);
    }
    await expect(runEncodeProcess(fakeRequest({ capBytes: 1000 }))).rejects.toThrow(/-fs/);
    await expect(runEncodeProcess(fakeRequest({ args: [...body.slice(0, -1), '-fs', '1000', body.at(-1)!] }))).rejects.toThrow(/-fs/);
    await expect(runEncodeProcess(fakeRequest({ capBytes: 999, args: [...body.slice(0, -1), '-fs', '1000', body.at(-1)!] }))).rejects.toThrow(/-fs/);
    await expect(runEncodeProcess(fakeRequest({ args: ['-i', 'file:C:\\a.mkv', 'C:\\o.mkv'] }))).rejects.toThrow(/not pinned/);
    await expect(runEncodeProcess(fakeRequest({ workDirectory: 'work' }))).rejects.toThrow(TypeError);
    await expect(runEncodeProcess(fakeRequest({ expectedDurationUs: -1 }))).rejects.toThrow(TypeError);
    // The file measured for the cap is the one ffmpeg writes, named as a file: URL.
    await expect(runEncodeProcess(fakeRequest({ outputPath: 'C:\\out\\other.mkv' }))).rejects.toThrow(/output path/);
    await expect(runEncodeProcess(fakeRequest({ outputPath: 'C:\\out\\x.mkv', args: [...body.slice(0, -1), 'C:\\out\\x.mkv'] }))).rejects.toThrow(/output path/);
    const measured = fakeRun({ outputPath: 'C:\\out\\x.mkv' });
    await measured.ready;
    measured.child.close();
    expect((await measured.result).status).toBe('closed');
  });

  it('moves a filter over 8 KB into a file of the working directory', () => {
    const work = 'C:\\fk\\work\\a1';
    const long = `${'null,'.repeat(1700)}scale=160:90`;
    const short = 'scale=160:90';
    const { args, files } = externalizeLongFilters(['-filter:v:0', long, '-vf', long, '-af', short, '-filter:a:1', long, '-filter_complex', long], work);
    expect(args).toEqual(['-/filter:v:0', `file:${work}\\filter-v0.txt`, '-/filter:v', `file:${work}\\filter-v.txt`, '-af', short,
      '-/filter:a:1', `file:${work}\\filter-a1.txt`, '-filter_complex', long]);
    expect(files.map(file => [path.basename(file.path), file.content.length])).toEqual([['filter-v0.txt', long.length], ['filter-v.txt', long.length],
      ['filter-a1.txt', long.length]]);
    // The limit is 8 KB of UTF-8, and two filters for one stream do not overwrite each other's file.
    expect(externalizeLongFilters(['-vf', 'x'.repeat(ENCODE_PROCESS_POLICY.filterFileBytes)], work).files).toEqual([]);
    expect(externalizeLongFilters(['-vf', `${'x'.repeat(ENCODE_PROCESS_POLICY.filterFileBytes - 1)}é`], work).files).toHaveLength(1);
    expect(externalizeLongFilters(['-vf', long, '-vf', long], work).args).toEqual(['-/filter:v', `file:${work}\\filter-v.txt`, '-/filter:v', `file:${work}\\filter-v-2.txt`]);
  });

  it('refuses a command line Windows cannot start', async () => {
    const huge = Array.from({ length: 40 }, (_, index) => ['-metadata', `k${index}=${'x'.repeat(900)}`]).flat();
    await expect(runEncodeProcess(fakeRequest({ args: [...fakeRequest().args.slice(0, -1), ...huge, 'file:C:\\out\\x.mkv'] }))).rejects.toThrow(RangeError);
  });
});

describe('priority and affinity', () => {
  it('keeps low-usage runs on the upper half of the logical processors', () => {
    expect(lowUsageAffinityMask(20)).toBe(0xffc00n);
    expect(lowUsageAffinityMask(16)).toBe(0xff00n);
    expect(lowUsageAffinityMask(3)).toBe(0b100n);
    expect(lowUsageAffinityMask(2)).toBe(0b10n);
    expect(lowUsageAffinityMask(1)).toBe(1n);
    expect(lowUsageAffinityMask(0)).toBe(1n);
    expect(lowUsageAffinityMask(64)).toBe(0xffffffff00000000n);
    expect(lowUsageAffinityMask(128)).toBe(0xffffffff00000000n);
  });

  it('sets below normal priority on spawn, idle plus affinity in low-usage mode, and only logs a failure', async () => {
    const normal = fakeRun();
    await normal.ready;
    expect(normal.priorities).toEqual([os.constants.priority.PRIORITY_BELOW_NORMAL]);
    normal.child.close();
    expect((await normal.result).tuning).toEqual({ priority: 'below_normal', priorityApplied: true, affinity: 'not_requested', affinityMask: null });

    const masks: bigint[] = [];
    const low = fakeRun({ lowUsage: true }, { platform: 'win32', logicalProcessors: () => 20, setAffinity: async (_pid, mask) => { masks.push(mask); } });
    await low.ready;
    await settle();
    expect(low.priorities).toEqual([os.constants.priority.PRIORITY_LOW]);
    expect(masks).toEqual([0xffc00n]);
    low.child.close();
    expect((await low.result).tuning).toEqual({ priority: 'idle', priorityApplied: true, affinity: 'applied', affinityMask: 0xffc00n });

    const failing = fakeRun({ lowUsage: true }, { platform: 'win32', logicalProcessors: () => 8,
      setPriority: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, setAffinity: async () => { throw new Error('PowerShell missing'); } });
    await failing.ready;
    await settle();
    failing.child.stdout.write(progressBlock({ frame: 1, out_time_us: 40_000, progress: 'end' }));
    await settle();
    failing.child.close();
    const result = await failing.result;
    expect(result.tuning).toEqual({ priority: 'idle', priorityApplied: false, affinity: 'failed', affinityMask: 0xf0n });
    expect(failing.logs).toEqual(['Could not lower the ffmpeg priority', 'Could not limit ffmpeg to the low-usage processors']);
    expect(runFailure(result)).toBe(null);

    // A setter that throws at once, not even returning a promise, fails the affinity only.
    const throwing = fakeRun({ lowUsage: true }, { platform: 'win32', logicalProcessors: () => 4, setAffinity: () => { throw new Error('sync'); } });
    await throwing.ready;
    await settle();
    throwing.child.close();
    expect((await throwing.result).tuning).toEqual({ priority: 'idle', priorityApplied: true, affinity: 'failed', affinityMask: 0b1100n });
  });

  it('does not try the affinity off Windows, and abandons it when ffmpeg ends first', async () => {
    let calls = 0;
    const mac = fakeRun({ lowUsage: true }, { platform: 'darwin', setAffinity: async () => { calls++; } });
    await mac.ready;
    mac.child.close();
    expect((await mac.result).tuning.affinity).toBe('not_requested');
    expect(calls).toBe(0);
    let aborted = false;
    const slow = fakeRun({ lowUsage: true }, { platform: 'win32', setAffinity: (_pid, _mask, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('abandoned')); });
    }) });
    await slow.ready;
    slow.child.close();
    expect((await slow.result).tuning.affinity).toBe('abandoned');
    expect(aborted).toBe(true);
    expect(slow.logs).toEqual([]);
  });

  it('rejects a bad pid or mask before starting PowerShell', async () => {
    await expect(setAffinityWithPowerShell(0, 1n)).rejects.toThrow(TypeError);
    await expect(setAffinityWithPowerShell(1.5, 1n)).rejects.toThrow(TypeError);
    await expect(setAffinityWithPowerShell(10, 0n)).rejects.toThrow(RangeError);
    await expect(setAffinityWithPowerShell(10, 1n << 64n)).rejects.toThrow(RangeError);
    await expect(setAffinityWithPowerShell(10, 1n, undefined, {})).rejects.toThrow(/system root/);
  });
});

describe('the stall watchdog', () => {
  const watch = (fields: Partial<Parameters<typeof assessStall>[0]> = {}) => ({ startedAt: 0, firstOutputAt: null, lastAdvanceAt: 0, outTimeUs: null, totalSize: null, ...fields });

  it('gives 300 s before the first output, 600 s in low-usage mode', () => {
    expect(assessStall(watch(), 300_000, 60_000_000, false)).toEqual({ phase: 'before_first_output', quietMs: 300_000, budgetMs: 300_000, stalled: false });
    expect(assessStall(watch(), 300_001, 60_000_000, false).stalled).toBe(true);
    expect(assessStall(watch(), 600_000, 60_000_000, true)).toMatchObject({ budgetMs: 600_000, stalled: false });
    expect(assessStall(watch(), 600_001, 60_000_000, true).stalled).toBe(true);
  });

  it('stops an encode when neither processed time nor bytes grew for 120 s', () => {
    const encoding = watch({ firstOutputAt: 1_000, lastAdvanceAt: 50_000, outTimeUs: 10_000_000, totalSize: 5_000_000 });
    expect(assessStall(encoding, 170_000, 60_000_000, false)).toEqual({ phase: 'encoding', quietMs: 120_000, budgetMs: 120_000, stalled: false });
    expect(assessStall(encoding, 170_001, 60_000_000, false).stalled).toBe(true);
    // Low-usage mode changes only the first-output grace.
    expect(assessStall(encoding, 170_001, 60_000_000, true).stalled).toBe(true);
  });

  it('gives the finalizing phase 120 s plus the bytes written at 20 MB/s, from 1 s before the expected end', () => {
    const at = (outTimeUs: number, totalSize: number) => watch({ firstOutputAt: 1_000, lastAdvanceAt: 100_000, outTimeUs, totalSize });
    expect(assessStall(at(58_999_999, 4_000_000_000), 100_000, 60_000_000, false).phase).toBe('encoding');
    const finalizing = assessStall(at(59_000_000, 4_000_000_000), 100_000 + 320_000, 60_000_000, false);
    expect(finalizing).toEqual({ phase: 'finalizing', quietMs: 320_000, budgetMs: 320_000, stalled: false });
    expect(assessStall(at(59_000_000, 4_000_000_000), 100_000 + 320_001, 60_000_000, false).stalled).toBe(true);
    expect(assessStall(at(60_000_000, 0), 100_000 + 120_001, 60_000_000, false)).toMatchObject({ phase: 'finalizing', budgetMs: 120_000, stalled: true });
  });

  it('without an expected duration, encoding gets the finalizing budget when it is larger', () => {
    const quiet = watch({ firstOutputAt: 1_000, lastAdvanceAt: 0, outTimeUs: 5_000_000, totalSize: 2_000_000_000 });
    expect(assessStall(quiet, 200_000, null, false)).toEqual({ phase: 'encoding', quietMs: 200_000, budgetMs: 220_000, stalled: false });
    expect(assessStall(watch({ firstOutputAt: 1, outTimeUs: 1, totalSize: 10 }), 120_001, null, false).stalled).toBe(true);
  });

  it('kills the process with the production thresholds and reports encoder_stalled after close', async () => {
    // Before the first output: nothing for 300 s.
    const first = fakeRun();
    await first.ready;
    expect(first.clock.watching()).toBe(1);
    first.clock.advance(300_000);
    expect(first.child.kills).toBe(0);
    first.clock.advance(1);
    expect(first.child.kills).toBe(1);
    first.child.close(null, 'SIGTERM');
    const stalled = await first.result;
    expect(stalled).toMatchObject({ status: 'closed', failureCode: 'encoder_stalled', stall: { phase: 'before_first_output', stalled: true }, cancelled: false });
    expect(runFailure(stalled)).toMatchObject({ reason: 'encoder_stalled', code: 'encoder_stalled' });
    expect(first.clock.watching()).toBe(0);

    // Encoding: blocks keep coming, but time and size stand still.
    const encoding = fakeRun();
    await encoding.ready;
    const write = async (fields: Record<string, string | number>) => { encoding.child.stdout.write(progressBlock(fields)); await settle(); };
    await write({ frame: 10, out_time_us: 400_000, total_size: 595, progress: 'continue' });
    for (let second = 0; second < 119; second++) {
      encoding.clock.advance(1_000);
      await write({ frame: 10, out_time_us: 400_000, total_size: 595, progress: 'continue' });
    }
    expect(encoding.child.kills).toBe(0);
    encoding.clock.advance(1_001);
    expect(encoding.child.kills).toBe(1);
    encoding.child.close(null, 'SIGTERM');
    expect((await encoding.result).stall).toMatchObject({ phase: 'encoding', budgetMs: 120_000 });

    // A slow run that advances a little every 100 s is never stopped, even when the size stands still.
    const slow = fakeRun({ expectedDurationUs: 600_000_000 });
    await slow.ready;
    for (let step = 1; step <= 20; step++) {
      slow.child.stdout.write(progressBlock({ frame: step, out_time_us: step * 1_000, total_size: 1_000, progress: 'continue' }));
      await settle();
      slow.clock.advance(100_000);
    }
    expect(slow.child.kills).toBe(0);
    slow.child.stdout.write(progressBlock({ frame: 21, out_time_us: 600_000_000, total_size: 1_000, progress: 'end' }));
    await settle();
    slow.child.close();
    const slowResult = await slow.result;
    expect(slowResult.stall).toBe(null);
    expect(runFailure(slowResult)).toBe(null);
  });

  it('counts an audio-only output (no frame key) as started once processed time appears', async () => {
    const audio = fakeRun();
    await audio.ready;
    audio.child.stdout.write(progressBlock({ out_time_us: 973_500, total_size: 168, speed: '1.93x', progress: 'continue' }));
    await settle();
    // It has started: the 120 s encoding budget applies, not the 300 s first-output grace.
    audio.clock.advance(120_001);
    expect(audio.child.kills).toBe(1);
    audio.child.close(null, 'SIGTERM');
    const result = await audio.result;
    expect(result.stall?.phase).toBe('encoding');
    expect(result.firstFrameSeen).toBe(false);
  });
});

describe('the run', () => {
  it('does not start when cancelled first, and reports a start failure as spawn_error', async () => {
    let spawned = 0;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runEncodeProcess(fakeRequest({ signal: controller.signal }), { spawn: () => { spawned++; throw new Error('no'); } });
    expect(cancelled).toMatchObject({ status: 'not_started', cancelled: true });
    expect(spawned).toBe(0);
    expect(runFailure(cancelled)?.reason).toBe('cancelled');

    const thrown = await runEncodeProcess(fakeRequest(), { spawn: () => { throw Object.assign(new Error('bad'), { code: 'EINVAL' }); } });
    expect(thrown).toMatchObject({ status: 'spawn_error', errorCode: 'EINVAL', pid: null });
    await thrown.closed;
    expect(runFailure(thrown)).toMatchObject({ reason: 'spawn_failed', code: 'runtime_spawn_failed' });

    const child = new FakeChild();
    child.pid = undefined;
    const missing = runEncodeProcess(fakeRequest(), { spawn: () => {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child as unknown as ChildProcess;
    } });
    expect(await missing).toMatchObject({ status: 'spawn_error', errorCode: 'ENOENT' });
  });

  it('settles at its own deadline when close never comes, and still tells when the process is gone', async () => {
    const controller = new AbortController();
    const heard: ProgressState[] = [];
    const run = fakeRun({ signal: controller.signal, onProgress: state => { heard.push(state); } });
    await run.ready;
    // A last line without its newline: only the parser's finish at close would complete this block.
    run.child.stdout.write('frame=3\nout_time_us=120000\nprogress=end');
    await settle();
    controller.abort();
    expect(run.child.kills).toBe(1);
    const result = await run.result;
    expect(result).toMatchObject({ status: 'close_unconfirmed', cancelled: true, sawEnd: false });
    let gone = false;
    void result.closed.then(() => { gone = true; });
    await settle();
    expect(gone).toBe(false);
    run.child.emit('close', null, 'SIGTERM');
    await settle();
    expect(gone).toBe(true);
    // The late close confirms the process is gone; it reports no progress after the run settled.
    expect(heard).toEqual([]);
  });

  it('keeps the last 256 KB of a flood of stderr without stopping ffmpeg', async () => {
    const run = fakeRun();
    await run.ready;
    const line = `[dec:mpeg4 @ 0001] [error] Decoding error: Invalid data found when processing input ${'x'.repeat(40)}\n`;
    let written = 0;
    for (let chunk = 0; chunk < 64; chunk++) {
      const text = line.repeat(Math.ceil(16_384 / line.length));
      run.child.stderr.write(text);
      written += Buffer.byteLength(text);
      await settle();
    }
    run.child.stdout.write(progressBlock({ frame: 50, out_time_us: 2_000_000, progress: 'end' }));
    await settle();
    expect(run.child.kills).toBe(0);
    run.child.close();
    const result = await run.result;
    expect(written).toBeGreaterThan(1024 * 1024);
    expect(result.stderrBytes).toBe(written);
    expect(result.failureCode).toBe(null);
    const tail = result.redactedTail(4 * 1024 * 1024);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(STDERR_KEPT);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(STDERR_KEPT - 2 * line.length);
    expect(tail.startsWith('[dec:mpeg4')).toBe(true);
    expect(Buffer.byteLength(result.redactedTail())).toBeLessThanOrEqual(ENCODE_PROCESS_POLICY.tailBytes);
  });

  it('names disk_full and output_open_failed from stderr, the disk first, and not from a file name', async () => {
    const lines = {
      disk: '[out#0/mp4 @ 000001] [error] Error submitting a packet to the muxer: No space left on device\n',
      trailer: '[out#0/matroska @ 000001] [error] Error writing trailer: No space left on device\n',
      exists: "[fatal] File 'file:C:\\out\\x.mkv' already exists. Exiting.\n[error] Error opening output file file:C:\\out\\x.mkv.\n",
      open: '[out#0/matroska @ 000002afb0be4c00] [fatal] Error opening output file:C:\\out\\nodir\\x.mkv: No such file or directory\n',
      filter: '[af#0:0 @ 000002] [error] Filtergraph has a video output, cannot connect it to audio output stream\n[error] Error opening output file C:\\out\\x.mka.\n' +
        '[fatal] Error opening output files: Invalid argument\n',
      named: "[warning] could not read 'D:\\No space left on device\\File 'x' already exists. Exiting.mkv'\n",
    };
    const classify = async (text: string, chunked = false) => {
      const run = fakeRun({ redaction: { inputs: ["D:\\No space left on device\\File 'x' already exists. Exiting.mkv"] } });
      await run.ready;
      if (chunked) for (const char of text) run.child.stderr.write(char);
      else run.child.stderr.write(text);
      await settle();
      run.child.close(1);
      return (await run.result).failureCode;
    };
    expect(await classify(lines.disk)).toBe('disk_full');
    expect(await classify(lines.trailer, true)).toBe('disk_full');
    expect(await classify(lines.exists)).toBe('output_open_failed');
    expect(await classify(lines.open, true)).toBe('output_open_failed');
    expect(await classify(lines.open + lines.disk)).toBe('disk_full');
    expect(await classify(lines.filter)).toBe(null);
    expect(await classify(lines.named)).toBe(null);
    expect(classifyStderrLine('[fatal] Not overwriting - exiting')).toBe('output_open_failed');
    // The last line may come without a newline.
    expect(await classify(lines.disk.trimEnd())).toBe('disk_full');

    // ffmpeg that hangs after the disk filled is stopped by the watchdog, but the full disk is what it reports.
    const hung = fakeRun();
    await hung.ready;
    hung.child.stdout.write(progressBlock({ frame: 10, out_time_us: 400_000, total_size: 4096, progress: 'continue' }));
    hung.child.stderr.write(lines.disk);
    await settle();
    hung.clock.advance(STALL_THRESHOLDS.encodingMs + 1);
    expect(hung.child.kills).toBe(1);
    hung.child.close(null, 'SIGTERM');
    const result = await hung.result;
    expect(result.stall).toMatchObject({ phase: 'encoding', stalled: true });
    expect(result.failureCode).toBe('disk_full');
    expect(runFailure(result)).toMatchObject({ reason: 'disk_full', code: 'disk_full' });
  });

  it('survives a progress listener that throws, and stops for a broken pipe', async () => {
    const run = fakeRun({ onProgress: () => { throw new Error('listener'); } });
    await run.ready;
    run.child.stdout.write(progressBlock({ frame: 1, out_time_us: 1, progress: 'continue' }) + progressBlock({ frame: 2, out_time_us: 2, progress: 'end' }));
    await settle();
    run.child.close();
    const result = await run.result;
    expect(result.progress).toMatchObject({ frame: 2, ended: true, blocks: 2 });
    expect(run.logs).toEqual(['A progress listener failed']);

    const broken = fakeRun();
    await broken.ready;
    broken.child.stdout.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' }));
    expect(broken.child.kills).toBe(1);
    broken.child.close(null, 'SIGTERM');
    expect(runFailure(await broken.result)?.reason).toBe('exit_code');
  });
});

// ── Success judgement ──────────────────────────────────────────────────────────────────────────

const runOf = (fields: Partial<EncodeRunResult> = {}): EncodeRunResult => ({
  status: 'closed', pid: 1, exitCode: 0, signalCode: null, errorCode: null, cancelled: false, stall: null,
  progress: { outTimeUs: 10_000_000, totalSize: 1_000_000, speed: 1, fps: 25, frame: 250, ended: true, blocks: 20 }, sawEnd: true, firstFrameSeen: true,
  outputBytes: 1_000_000, capHit: false, failureCode: null, stderrBytes: 10,
  tuning: { priority: 'below_normal', priorityApplied: true, affinity: 'not_requested', affinityMask: null }, closed: Promise.resolve(),
  redactedTail: () => '[error] tail', ...fields,
});
const infoOf = (fields: { durationUs?: number | null; video?: (number | null)[]; audio?: (number | null)[]; subtitles?: number; covers?: number } = {}) => {
  const video = (fields.video ?? [10_000_000]).map((durationUs, index) => ({ index, durationUs }));
  const audio = (fields.audio ?? [10_000_000]).map((durationUs, index) => ({ index: video.length + index, durationUs }));
  return { durationUs: fields.durationUs === undefined ? 10_000_000 : fields.durationUs, primaryVideoIndex: video.length ? 0 : null, video, audio,
    subtitles: Array.from({ length: fields.subtitles ?? 0 }, () => ({})), covers: Array.from({ length: fields.covers ?? 0 }, () => ({})) } as unknown as MediaInfo;
};
const both = { video: 1, audio: 1, subtitles: 0 };

describe('the success judgement', () => {
  it('needs exit 0, progress=end, no cap, no stall, and a cancelled run is never a success', () => {
    const check = { output: infoOf(), streams: both, expectedDurationUs: 10_000_000 };
    expect(judgeEncode(runOf(), check)).toEqual({ ok: true, warnings: [], durationUs: 10_000_000 });
    const reasons = (run: EncodeRunResult) => { const verdict = judgeEncode(run, check); return verdict.ok ? 'ok' : [verdict.failure.reason, verdict.failure.code]; };
    expect(reasons(runOf({ exitCode: 1 }))).toEqual(['exit_code', 'unknown']);
    expect(reasons(runOf({ status: 'close_unconfirmed' }))).toEqual(['exit_code', 'unknown']);
    expect(reasons(runOf({ sawEnd: false }))).toEqual(['no_progress_end', 'unknown']);
    expect(reasons(runOf({ capHit: true }))).toEqual(['cap_reached', 'output_cap_exceeded']);
    expect(reasons(runOf({ failureCode: 'output_open_failed' }))).toEqual(['output_open_failed', 'output_open_failed']);
    expect(reasons(runOf({ failureCode: 'disk_full', exitCode: 1 }))).toEqual(['disk_full', 'disk_full']);
    expect(reasons(runOf({ failureCode: 'encoder_stalled', capHit: true }))).toEqual(['encoder_stalled', 'encoder_stalled']);
    expect(reasons(runOf({ cancelled: true }))).toEqual(['cancelled', 'unknown']);
    expect(reasons(runOf({ status: 'spawn_error' }))).toEqual(['spawn_failed', 'runtime_spawn_failed']);
    const verdict = judgeEncode(runOf({ exitCode: 1 }), check);
    expect(verdict.ok ? null : verdict.failure.detail).toBe('[error] tail');
  });

  it('needs a readable output with every planned stream', () => {
    const fail = (output: MediaInfo | null, streams: PlannedStreamCounts = both) => { const verdict = judgeEncode(runOf(), { output, streams, expectedDurationUs: 10_000_000 }); return verdict.ok ? 'ok' : verdict.failure.reason; };
    expect(fail(null)).toBe('output_unreadable');
    expect(fail(infoOf({ audio: [] }))).toBe('streams_missing');
    expect(fail(infoOf({ video: [] }))).toBe('streams_missing');
    expect(fail(infoOf(), { video: 1, audio: 2, subtitles: 0 })).toBe('streams_missing');
    expect(fail(infoOf({ subtitles: 1 }), { video: 1, audio: 1, subtitles: 2 })).toBe('streams_missing');
    expect(fail(infoOf(), { video: 1, audio: 1, subtitles: 0, covers: 1 })).toBe('streams_missing');
    expect(fail(infoOf({ subtitles: 2, covers: 1 }), { video: 1, audio: 1, subtitles: 2, covers: 1 })).toBe('ok');
  });

  it('checks the duration within max(2 s, 1 %), on the main stream (the extracted track for audio)', () => {
    const verdict = (output: MediaInfo, expectedDurationUs: number | null, streams = both) => judgeEncode(runOf(), { output, streams, expectedDurationUs });
    expect(durationToleranceUs(10_000_000)).toBe(2_000_000);
    expect(durationToleranceUs(3_600_000_000)).toBe(36_000_000);
    expect(verdict(infoOf({ video: [12_000_000], durationUs: 12_000_000 }), 10_000_000).ok).toBe(true);
    expect(verdict(infoOf({ video: [12_000_001], durationUs: 12_000_001 }), 10_000_000)).toMatchObject({ ok: false, failure: { reason: 'duration_mismatch' } });
    expect(verdict(infoOf({ video: [3_564_000_000], audio: [3_564_000_000], durationUs: 3_564_000_000 }), 3_600_000_000).ok).toBe(true);
    expect(verdict(infoOf({ video: [3_563_999_999], audio: [3_563_999_999], durationUs: 3_563_999_999 }), 3_600_000_000).ok).toBe(false);
    // Extracted audio: the audio track is the main stream.
    const audioOnly = { video: 0, audio: 1, subtitles: 0 };
    expect(verdict(infoOf({ video: [], audio: [4_000_000], durationUs: 4_000_000 }), 10_000_000, audioOnly).ok).toBe(false);
    expect(verdict(infoOf({ video: [], audio: [9_000_000], durationUs: 9_000_000 }), 10_000_000, audioOnly).ok).toBe(true);
    // Without a stream duration, the container's.
    expect(verdict(infoOf({ video: [null], audio: [null], durationUs: 4_000_000 }), 10_000_000).ok).toBe(false);
  });

  it('warns duration_unverified, needing only processed time, when the duration is unknown or contradicts itself', () => {
    const unverified = { ok: true, warnings: ['duration_unverified'], durationUs: null };
    expect(judgeEncode(runOf(), { output: infoOf(), streams: both, expectedDurationUs: null })).toEqual(unverified);
    expect(judgeEncode(runOf(), { output: infoOf({ video: [null], audio: [null], durationUs: null }), streams: both, expectedDurationUs: 10_000_000 })).toEqual(unverified);
    // The source's main stream and container disagree.
    expect(judgeEncode(runOf(), { output: infoOf({ video: [3_000_000], durationUs: 3_000_000 }), streams: both, expectedDurationUs: 3_000_000,
      sourceContainerDurationUs: 3_600_000_000 })).toEqual(unverified);
    expect(judgeEncode(runOf(), { output: infoOf({ video: [3_000_000], durationUs: 3_000_000 }), streams: both, expectedDurationUs: 10_000_000,
      sourceContainerDurationUs: 10_500_000 })).toMatchObject({ ok: false, failure: { reason: 'duration_mismatch' } });
    const nothing = runOf({ progress: { outTimeUs: 0, totalSize: 0, speed: null, fps: null, frame: 0, ended: true, blocks: 1 } });
    expect(judgeEncode(nothing, { output: infoOf(), streams: both, expectedDurationUs: null })).toMatchObject({ ok: false, failure: { reason: 'nothing_processed' } });
    expect(judgeEncode(runOf({ progress: null }), { output: infoOf(), streams: both, expectedDurationUs: null })).toMatchObject({ ok: false });
  });

  it('never excuses an output main stream cut short under a container that another stream kept long', () => {
    // 3 s of video under 10 s of audio: the container says 10 s, the main stream does not.
    const cut = infoOf({ video: [3_000_000], audio: [10_000_000], durationUs: 10_000_000 });
    expect(judgeEncode(runOf(), { output: cut, streams: both, expectedDurationUs: 10_000_000, sourceContainerDurationUs: 10_000_000 }))
      .toMatchObject({ ok: false, failure: { reason: 'duration_mismatch', code: 'unknown' } });
    expect(judgeEncode(runOf(), { output: cut, streams: both, expectedDurationUs: 10_000_000 })).toMatchObject({ ok: false, failure: { reason: 'duration_mismatch' } });
    // An expectation from the source container is held against the output's container, like with like.
    const longerAudio = infoOf({ video: [7_000_000], audio: [10_000_000], durationUs: 10_000_000 });
    expect(judgeEncode(runOf(), { output: longerAudio, streams: both, expectedDurationUs: 10_000_000, expectedFrom: 'container' }))
      .toEqual({ ok: true, warnings: [], durationUs: 10_000_000 });
    expect(judgeEncode(runOf(), { output: infoOf({ video: [10_000_000], durationUs: null }), streams: both, expectedDurationUs: 10_000_000, expectedFrom: 'container' }))
      .toEqual({ ok: true, warnings: [], durationUs: 10_000_000 });
    expect(judgeEncode(runOf(), { output: infoOf({ video: [10_000_000], durationUs: 4_000_000 }), streams: both, expectedDurationUs: 10_000_000, expectedFrom: 'container' }))
      .toMatchObject({ ok: false, failure: { reason: 'duration_mismatch' } });
  });

  it('proves no cap and publishes nothing for a process whose close was never seen', () => {
    expect(runFailure(runOf({ status: 'close_unconfirmed', capHit: true }))).toMatchObject({ reason: 'exit_code', code: 'unknown' });
    expect(runFailure(runOf({ status: 'close_unconfirmed', exitCode: 0, sawEnd: true }))).toMatchObject({ reason: 'exit_code' });
    expect(runFailure(runOf({ capHit: true, exitCode: 1 }))).toMatchObject({ reason: 'cap_reached', code: 'output_cap_exceeded' });
  });

  it('counts an output within 64 KB (at most 0.5 %) of the cap as reaching it', () => {
    expect(capSlackBytes(100_000_000)).toBe(64 * 1024);
    expect(capSlackBytes(1_000_000)).toBe(5_000);
    expect(capSlackBytes(100)).toBe(0);
  });
});

// ── The real ffmpeg ────────────────────────────────────────────────────────────────────────────

/** Warnings that mean ffmpeg silently did something other than asked (module-engine tasks, common conventions). */
const SILENT_SUBSTITUTION = /Invalid option|Error parsing option|auto-selecting format|only the last/;
let root: string, media: string, outputs: string, tools: MediaTools, prober: MediaProber;
let clip: string, gap: string, gapAudio: string, flood: string, raw: string;
let clipInfo: MediaInfo, gapInfo: MediaInfo, gapAudioInfo: MediaInfo, floodInfo: MediaInfo;

/** Runs the bundled ffmpeg at idle priority to make a fixture; a silent substitution fails it like an error. */
function make(output: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'level+warning', '-y', ...args, output], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* Exited already. */ }
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 && !SILENT_SUBSTITUTION.test(stderr) ? resolve(output) : reject(new Error(`ffmpeg ${code}: ${stderr}`)));
  });
}
const probed = async (file: string): Promise<MediaInfo> => {
  const outcome = await prober.probe(file);
  if (!outcome.ok) throw new Error(`${path.basename(file)}: ${outcome.code}`);
  return outcome.info;
};
const probedOrNull = async (file: string) => { const outcome = await prober.probe(file); return outcome.ok ? outcome.info : null; };

/** Priority class and affinity of a live process, as Windows reports them. */
function readProcess(pid: number): Promise<{ priorityClass: string; affinity: bigint }> {
  return new Promise((resolve, reject) => execFile(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.PriorityClass)|$([Int64]$p.ProcessorAffinity)"`], { windowsHide: true, timeout: 15_000 },
  (error, stdout) => {
    if (error) { reject(error); return; }
    const [priorityClass, affinity] = stdout.trim().split('|');
    resolve({ priorityClass, affinity: BigInt.asUintN(64, BigInt(affinity)) });
  }));
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface RealRun {
  id: string;
  args: string[];
  inputs: string[];
  output: string | null;
  capBytes?: number | null;
  expectedDurationUs: number | null;
  lowUsage?: boolean;
  signal?: AbortSignal;
  thresholds?: Partial<StallThresholds>;
  onSpawn?: (pid: number) => void;
  onProgress?: (state: ProgressState) => void;
  setAffinity?: EncodeProcessDependencies['setAffinity'];
}
async function encode(options: RealRun) {
  const work = path.join(root, 'work', options.id);
  let spawned: { command: string; args: string[]; options: SpawnOptions } | undefined;
  const logs: string[] = [];
  const started = performance.now();
  const run = await runEncodeProcess({
    ffmpeg: tools.ffmpeg, args: options.args, workDirectory: work, env: encodeEnvironment(tools.ffmpeg, work), signal: options.signal,
    expectedDurationUs: options.expectedDurationUs, capBytes: options.capBytes ?? null, outputPath: options.output, lowUsage: options.lowUsage ?? false,
    redaction: { inputs: options.inputs, outputs: options.output ? [options.output] : [], work: [work] }, onSpawn: options.onSpawn,
    onProgress: options.onProgress,
  }, {
    spawn: (command, args, spawnOptions) => { spawned = { command, args: [...args], options: spawnOptions }; return nodeSpawn(command, args, spawnOptions); },
    thresholds: options.thresholds, setAffinity: options.setAffinity, log: message => { logs.push(message); },
  });
  return { run, spawned: spawned!, work, logs, elapsedMs: performance.now() - started };
}
const out = (name: string) => path.join(outputs, name);
const toFile = (file: string) => ['-f', path.extname(file) === '.mp4' ? 'mp4' : 'matroska', '-y', `file:${file}`];

beforeAll(async () => {
  if (!available) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'process-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'process-')));
  media = path.join(root, 'media');
  outputs = path.join(root, 'out');
  await mkdir(media, { recursive: true });
  await mkdir(outputs, { recursive: true });
  const runtime = new MediaRuntime({ environment, workingDirectory: path.join(root, 'probe-work') });
  tools = await runtime.acquire();
  prober = new MediaProber({ runtime });
  // One at a time, at idle priority.
  clip = await make(path.join(media, 'clip.mkv'), '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libopenh264', '-c:a', 'aac', '-shortest');
  // 50 frames over 2 s of pictures, but the second half is stamped 18 s later: a 20 s timeline that -re plays with an 18 s silence.
  gap = await make(path.join(media, 'gap.mkv'), '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=2:r=25', '-vf', 'setpts=PTS+if(gte(N\\,25)\\,18/TB\\,0)',
    '-fps_mode', 'passthrough', '-c:v', 'mpeg4');
  // 2000 tiny frames with damaged packets: every frame fails to decode with an error line.
  const clean = await make(path.join(media, 'clean-1000fps.mkv'), '-f', 'lavfi', '-i', 'testsrc2=s=64x36:d=2:r=1000', '-c:v', 'mpeg4', '-q:v', '5');
  flood = await make(path.join(media, 'damaged.mkv'), '-i', clean, '-c:v', 'copy', '-bsf:v', 'noise=amount=20');
  raw = await make(path.join(media, 'raw.h264'), '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=2:r=25', '-c:v', 'libopenh264', '-f', 'h264');
  // The same 20 s picture timeline with 20 s of 8 kHz audio beside it: a cut video can hide under a container the audio keeps long.
  gapAudio = await make(path.join(media, 'gap-audio.mkv'), '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=2:r=25', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=20:sample_rate=8000', '-vf', 'setpts=PTS+if(gte(N\\,25)\\,18/TB\\,0)', '-fps_mode', 'passthrough', '-c:v', 'mpeg4', '-c:a', 'aac');
  [clipInfo, gapInfo, gapAudioInfo, floodInfo] = [await probed(clip), await probed(gap), await probed(gapAudio), await probed(flood)];
}, 120_000);
afterAll(async () => {
  prober?.dispose();
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});

describe.skipIf(!available)('the real ffmpeg', () => {
  it('runs below normal priority, hidden, in the job directory with the reduced environment, every input pinned, and a good output passes', async () => {
    const output = out('normal.mkv');
    let reading: Promise<{ priorityClass: string; affinity: bigint }> | undefined;
    let nodePriority: number | undefined;
    const states: ProgressState[] = [];
    const { run, spawned, work, logs } = await encode({
      id: 'normal', inputs: [clip], output, capBytes: 50_000_000, expectedDurationUs: clipInfo.durationUs,
      // Half speed, so the process lives long enough to be looked at.
      args: ['-readrate', '0.5', ...ffmpegInput(clip, 'matroska'), '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'mpeg4', '-c:a', 'aac', '-fs', '50000000', ...toFile(output)],
      onSpawn: pid => { nodePriority = os.getPriority(pid); reading = readProcess(pid); },
      onProgress: state => states.push(state),
    });
    const windows = await reading!;
    expect(nodePriority).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    expect(windows.priorityClass).toBe('BelowNormal');
    // Not low-usage: every processor stays available.
    expect(windows.affinity).toBe((1n << BigInt(Math.min(64, os.availableParallelism()))) - 1n);

    expect(spawned.command).toBe(tools.ffmpeg);
    expect(spawned.args.slice(0, FFMPEG_COMMON_PREFIX.length)).toEqual([...FFMPEG_COMMON_PREFIX]);
    const inputs = spawned.args.flatMap((arg, index) => arg === '-i' ? [index] : []);
    expect(inputs).toHaveLength(1);
    for (const index of inputs) {
      expect(spawned.args.slice(index - 4, index + 2)).toEqual(['-f', 'matroska', '-protocol_whitelist', 'file', '-i', `file:${clip}`]);
    }
    expect(spawned.options).toMatchObject({ cwd: work, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(spawned.options.detached).toBeUndefined();
    const env = spawned.options.env as Record<string, string>;
    expect(env.PATH.split(';')).toEqual([path.dirname(tools.ffmpeg), path.join(process.env.SystemRoot!, 'System32')]);
    expect([env.TEMP, env.TMP]).toEqual([work, work]);

    expect(run).toMatchObject({ status: 'closed', exitCode: 0, cancelled: false, stall: null, sawEnd: true, firstFrameSeen: true, capHit: false, failureCode: null });
    expect(run.tuning).toEqual({ priority: 'below_normal', priorityApplied: true, affinity: 'not_requested', affinityMask: null });
    expect(logs).toEqual([]);
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.map(state => state.outTimeUs!)).toEqual([...states.map(state => state.outTimeUs!)].sort((a, b) => a - b));
    expect(states.at(-1)).toMatchObject({ ended: true, outTimeUs: expect.any(Number) });
    expect(runFailure(run)).toBe(null);
    const verdict = judgeEncode(run, { output: await probed(output), streams: { video: 1, audio: 1, subtitles: 0 }, expectedDurationUs: clipInfo.durationUs });
    expect(verdict).toMatchObject({ ok: true, warnings: [] });
  }, 60_000);

  it('runs low-usage encodes at idle priority on the upper half of the logical processors', async () => {
    const controller = new AbortController();
    let pid = 0;
    let applied!: () => void;
    const affinityApplied = new Promise<void>(resolve => { applied = resolve; });
    const pending = encode({
      id: 'low', inputs: [clip], output: out('low.mkv'), expectedDurationUs: clipInfo.durationUs, lowUsage: true, signal: controller.signal,
      args: ['-readrate', '0.25', ...ffmpegInput(clip, 'matroska'), '-an', '-c:v', 'mpeg4', ...toFile(out('low.mkv'))],
      onSpawn: id => { pid = id; },
      setAffinity: async (id, mask, signal) => { await setAffinityWithPowerShell(id, mask, signal); applied(); },
    });
    await Promise.race([affinityApplied, pending.then(() => { throw new Error('ffmpeg ended before its affinity was set'); })]);
    const windows = await readProcess(pid);
    controller.abort();
    const { run } = await pending;
    const mask = lowUsageAffinityMask(os.availableParallelism());
    // Worked out apart from the code under test: all processors but the lower half.
    const processors = Math.min(64, os.availableParallelism());
    const upperHalf = ((1n << BigInt(processors)) - 1n) ^ ((1n << BigInt(processors - Math.max(1, Math.floor(processors / 2)))) - 1n);
    expect(windows).toEqual({ priorityClass: 'Idle', affinity: upperHalf });
    expect(run.tuning).toEqual({ priority: 'idle', priorityApplied: true, affinity: 'applied', affinityMask: mask });
    expect(run.cancelled).toBe(true);
  }, 60_000);

  it('stops within 3 s of a cancel, after which the partial output and the job directory can be removed', async () => {
    const controller = new AbortController();
    const output = out('cancel.mkv');
    let pid = 0;
    let abortedAt = 0;
    const { run, work } = await encode({
      id: 'cancel', inputs: [clip], output, expectedDurationUs: clipInfo.durationUs, signal: controller.signal,
      args: ['-readrate', '0.25', ...ffmpegInput(clip, 'matroska'), '-an', '-c:v', 'mpeg4', ...toFile(output)],
      onSpawn: id => { pid = id; },
      onProgress: () => { if (!abortedAt) { abortedAt = performance.now(); controller.abort(); } },
    });
    const stoppedMs = performance.now() - abortedAt;
    expect(abortedAt).toBeGreaterThan(0);
    expect(stoppedMs).toBeLessThan(3_000);
    expect(run).toMatchObject({ status: 'closed', cancelled: true, sawEnd: false });
    expect(runFailure(run)?.reason).toBe('cancelled');
    await run.closed;
    expect(alive(pid)).toBe(false);
    expect(existsSync(output)).toBe(true);
    await rm(output, { maxRetries: 2, retryDelay: 100 });
    await rm(work, { recursive: true, maxRetries: 2, retryDelay: 100 });
    expect([existsSync(output), existsSync(work)]).toEqual([false, false]);
  }, 60_000);

  it('stops a run that shows no output within the first-output grace', async () => {
    const output = out('stall-first.mkv');
    // Half speed from the first frame on, and every frame before 1.9 s dropped: no output for about 3.8 s.
    const { run, elapsedMs } = await encode({
      id: 'stall-first', inputs: [clip], output, expectedDurationUs: clipInfo.durationUs,
      args: ['-readrate', '0.5', '-readrate_initial_burst', '0', ...ffmpegInput(clip, 'matroska'), '-an', '-vf', 'select=gte(t\\,1.9)', '-c:v', 'mpeg4', ...toFile(output)],
      thresholds: { checkIntervalMs: 50, firstOutputMs: 1_500, encodingMs: 60_000, finalizingBaseMs: 60_000 },
    });
    expect(run.failureCode).toBe('encoder_stalled');
    expect(run.stall).toMatchObject({ phase: 'before_first_output', budgetMs: 1_500, stalled: true });
    expect(run.stall!.quietMs).toBeGreaterThan(1_500);
    expect(run.progress).toBe(null);
    expect(run.exitCode).not.toBe(0);
    expect(elapsedMs).toBeLessThan(3_500);
    expect(runFailure(run)).toMatchObject({ reason: 'encoder_stalled', code: 'encoder_stalled' });
  }, 60_000);

  it('stops an encode whose processed time and size stand still', async () => {
    const output = out('stall-encoding.mkv');
    const { run, elapsedMs } = await encode({
      id: 'stall-encoding', inputs: [gap], output, expectedDurationUs: gapInfo.durationUs,
      args: ['-re', ...ffmpegInput(gap, 'matroska'), '-c:v', 'mpeg4', ...toFile(output)],
      thresholds: { checkIntervalMs: 50, firstOutputMs: 10_000, encodingMs: 1_000, finalizingBaseMs: 60_000 },
    });
    expect(gapInfo.durationUs).toBeGreaterThan(19_000_000);
    expect(run.failureCode).toBe('encoder_stalled');
    expect(run.stall).toMatchObject({ phase: 'encoding', budgetMs: 1_000, stalled: true });
    expect(run.firstFrameSeen).toBe(true);
    expect(run.progress!.blocks).toBeGreaterThanOrEqual(2);
    expect(elapsedMs).toBeLessThan(6_000);
  }, 60_000);

  it('stops a finalizing run past its budget of base plus size', async () => {
    const output = out('stall-finalizing.mkv');
    // Expected 1 s: the first output already counts as finalizing; 1000 B/s makes the size term visible.
    const { run, elapsedMs } = await encode({
      id: 'stall-finalizing', inputs: [gap], output, expectedDurationUs: 1_000_000,
      args: ['-re', ...ffmpegInput(gap, 'matroska'), '-c:v', 'mpeg4', ...toFile(output)],
      thresholds: { checkIntervalMs: 50, firstOutputMs: 10_000, encodingMs: 60_000, finalizingBaseMs: 1_000, finalizingBytesPerSecond: 1_000 },
    });
    expect(run.failureCode).toBe('encoder_stalled');
    expect(run.stall).toMatchObject({ phase: 'finalizing', stalled: true });
    expect(run.progress!.totalSize).toBeGreaterThan(0);
    expect(run.stall!.budgetMs).toBeCloseTo(1_000 + run.progress!.totalSize!, 0);
    expect(run.stall!.quietMs).toBeGreaterThan(run.stall!.budgetMs);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 60_000);

  it('lets a slow run finish as long as it keeps advancing', async () => {
    const output = out('slow.mkv');
    const thresholds = { checkIntervalMs: 50, firstOutputMs: 2_000, encodingMs: 2_000, finalizingBaseMs: 2_000, finalizingBytesPerSecond: 1e12 };
    const { run, elapsedMs } = await encode({
      id: 'slow', inputs: [clip], output, expectedDurationUs: clipInfo.durationUs,
      args: ['-readrate', '0.3', ...ffmpegInput(clip, 'matroska'), '-an', '-c:v', 'mpeg4', ...toFile(output)], thresholds,
    });
    // Longer than every threshold twice over, yet never quiet for one of them.
    expect(elapsedMs).toBeGreaterThan(4_000);
    expect(run).toMatchObject({ status: 'closed', exitCode: 0, stall: null, failureCode: null, sawEnd: true });
    expect(run.progress!.blocks).toBeGreaterThanOrEqual(6);
    expect(judgeEncode(run, { output: await probed(output), streams: { video: 1, audio: 0, subtitles: 0 }, expectedDurationUs: clipInfo.durationUs }).ok).toBe(true);
  }, 60_000);

  it('keeps going through more stderr than it keeps, and keeps the last 256 KB', async () => {
    const output = out('flood.mkv');
    const { run } = await encode({
      id: 'flood', inputs: [flood], output, expectedDurationUs: floodInfo.durationUs,
      args: [...ffmpegInput(flood, 'matroska'), '-c:v', 'mpeg4', ...toFile(output)],
    });
    expect(run.stderrBytes).toBeGreaterThan(STDERR_KEPT);
    expect(run).toMatchObject({ status: 'closed', exitCode: 0, sawEnd: true, failureCode: null, stall: null });
    const kept = run.redactedTail(4 * 1024 * 1024);
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(STDERR_KEPT);
    expect(Buffer.byteLength(kept)).toBeGreaterThan(STDERR_KEPT / 2);
    expect(kept).toMatch(/Decoding error|corrupt decoded frame/);
    expect(Buffer.byteLength(run.redactedTail())).toBeLessThanOrEqual(ENCODE_PROCESS_POLICY.tailBytes);
  }, 60_000);

  it('recognizes an output cut off by -fs although ffmpeg exits 0 and reports the end', async () => {
    const output = out('capped.mp4');
    const args = (cap: number, file: string) => [...ffmpegInput(clip, 'matroska'), '-c:v', 'mpeg4', '-q:v', '1', '-c:a', 'aac', '-fs', String(cap), ...toFile(file)];
    const { run } = await encode({ id: 'capped', inputs: [clip], output, capBytes: 100_000, expectedDurationUs: clipInfo.durationUs, args: args(100_000, output) });
    expect(run).toMatchObject({ status: 'closed', exitCode: 0, sawEnd: true, capHit: true });
    expect(run.outputBytes).toBeGreaterThanOrEqual(100_000);
    // The cut is short enough to pass the duration check on its own: only the cap catches it.
    const info = await probed(output);
    expect(Math.abs(info.durationUs! - clipInfo.durationUs!)).toBeLessThanOrEqual(durationToleranceUs(clipInfo.durationUs!));
    expect(info.durationUs!).toBeLessThan(clipInfo.durationUs!);
    expect(judgeEncode(run, { output: info, streams: { video: 1, audio: 1, subtitles: 0 }, expectedDurationUs: clipInfo.durationUs }))
      .toMatchObject({ ok: false, failure: { reason: 'cap_reached', code: 'output_cap_exceeded' } });

    const roomy = out('roomy.mp4');
    const control = await encode({ id: 'roomy', inputs: [clip], output: roomy, capBytes: 50_000_000, expectedDurationUs: clipInfo.durationUs, args: args(50_000_000, roomy) });
    expect(control.run.capHit).toBe(false);
    expect(judgeEncode(control.run, { output: await probed(roomy), streams: { video: 1, audio: 1, subtitles: 0 }, expectedDurationUs: clipInfo.durationUs }).ok).toBe(true);
  }, 60_000);

  it('fails an output that was cut short: unreadable, or shorter than expected', async () => {
    const output = out('cut.mp4');
    const { run } = await encode({ id: 'cut', inputs: [clip], output, expectedDurationUs: clipInfo.durationUs,
      args: [...ffmpegInput(clip, 'matroska'), '-c:v', 'mpeg4', '-c:a', 'aac', ...toFile(output)] });
    expect(runFailure(run)).toBe(null);
    // An MP4 without +faststart keeps its index at the end: half the file has none.
    await truncate(output, Math.floor((await readFile(output)).length / 2));
    const unreadable = await probedOrNull(output);
    expect(unreadable).toBe(null);
    expect(judgeEncode(run, { output: unreadable, streams: { video: 1, audio: 1, subtitles: 0 }, expectedDurationUs: clipInfo.durationUs }))
      .toMatchObject({ ok: false, failure: { reason: 'output_unreadable', code: 'unknown' } });

    // The 20 s timeline stopped after 1 s: the process succeeded, the duration does not match.
    const short = out('short.mkv');
    const stopped = await encode({ id: 'short', inputs: [gap], output: short, expectedDurationUs: gapInfo.durationUs,
      args: [...ffmpegInput(gap, 'matroska'), '-t', '1', '-c:v', 'mpeg4', ...toFile(short)] });
    expect(runFailure(stopped.run)).toBe(null);
    expect(judgeEncode(stopped.run, { output: await probed(short), streams: { video: 1, audio: 0, subtitles: 0 }, expectedDurationUs: gapInfo.durationUs }))
      .toMatchObject({ ok: false, failure: { reason: 'duration_mismatch' } });
    const full = out('full.mkv');
    const whole = await encode({ id: 'full', inputs: [gap], output: full, expectedDurationUs: gapInfo.durationUs,
      args: [...ffmpegInput(gap, 'matroska'), '-c:v', 'mpeg4', ...toFile(full)] });
    expect(judgeEncode(whole.run, { output: await probed(full), streams: { video: 1, audio: 0, subtitles: 0 }, expectedDurationUs: gapInfo.durationUs }))
      .toMatchObject({ ok: true, warnings: [] });
  }, 60_000);

  it('fails an output whose video stopped early while its audio kept the container long', async () => {
    const expected = gapAudioInfo.video[0].durationUs!;
    expect(expected).toBeGreaterThan(19_000_000);
    const check = (output: MediaInfo) => ({ output, streams: { video: 1, audio: 1, subtitles: 0 }, expectedDurationUs: expected,
      sourceContainerDurationUs: gapAudioInfo.durationUs });
    const output = out('video-cut.mkv');
    const { run } = await encode({ id: 'video-cut', inputs: [gapAudio], output, expectedDurationUs: expected,
      args: [...ffmpegInput(gapAudio, 'matroska'), '-map', '0:v:0', '-map', '0:a:0', '-frames:v', '25', '-c:v', 'mpeg4', '-c:a', 'aac', ...toFile(output)] });
    expect(runFailure(run)).toBe(null);
    const info = await probed(output);
    // The audio keeps the container well past the 1 s of video: stream and container disagree beyond the tolerance, which must not excuse it.
    expect(info.video[0].durationUs!).toBeLessThan(2_000_000);
    expect(info.durationUs! - info.video[0].durationUs!).toBeGreaterThan(durationToleranceUs(expected));
    expect(info.audio[0].durationUs!).toBeGreaterThan(info.video[0].durationUs! + durationToleranceUs(expected));
    expect(judgeEncode(run, check(info))).toMatchObject({ ok: false, failure: { reason: 'duration_mismatch' } });
    const whole = out('video-whole.mkv');
    const control = await encode({ id: 'video-whole', inputs: [gapAudio], output: whole, expectedDurationUs: expected,
      args: [...ffmpegInput(gapAudio, 'matroska'), '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'mpeg4', '-c:a', 'aac', ...toFile(whole)] });
    expect(judgeEncode(control.run, check(await probed(whole)))).toMatchObject({ ok: true, warnings: [] });
  }, 60_000);

  it('accepts an input without a duration with the warning duration_unverified', async () => {
    const rawInfo = await probed(raw);
    expect(rawInfo.durationUs).toBe(null);
    const output = out('from-raw.mkv');
    const { run } = await encode({ id: 'raw', inputs: [raw], output, expectedDurationUs: rawInfo.durationUs,
      args: [...ffmpegInput(raw, 'h264'), '-c:v', 'mpeg4', ...toFile(output)] });
    expect(run).toMatchObject({ status: 'closed', exitCode: 0, sawEnd: true });
    expect(run.progress!.outTimeUs).toBeGreaterThan(0);
    expect(judgeEncode(run, { output: await probed(output), streams: { video: 1, audio: 0, subtitles: 0 }, expectedDurationUs: rawInfo.durationUs }))
      .toEqual({ ok: true, warnings: ['duration_unverified'], durationUs: null });
  }, 60_000);

  it('passes a filter over 8 KB through a file that ffmpeg reads with -/filter:v:0', async () => {
    const output = out('filtered.mkv');
    const filter = `${'null,'.repeat(1700)}scale=160:90`;
    const { run, spawned, work } = await encode({ id: 'filter', inputs: [clip], output, expectedDurationUs: clipInfo.durationUs,
      args: [...ffmpegInput(clip, 'matroska'), '-map', '0:v:0', '-filter:v:0', filter, '-c:v', 'mpeg4', ...toFile(output)] });
    const file = path.join(work, 'filter-v0.txt');
    expect(spawned.args).toContain('-/filter:v:0');
    expect(spawned.args[spawned.args.indexOf('-/filter:v:0') + 1]).toBe(`file:${file}`);
    expect(spawned.args).not.toContain(filter);
    expect(await readFile(file, 'utf8')).toBe(filter);
    expect(runFailure(run)).toBe(null);
    const info = await probed(output);
    expect([info.video[0].width, info.video[0].height]).toEqual([160, 90]);
  }, 60_000);

  it('names output_open_failed from real ffmpeg, keeps paths out of the tail, and does not blame the output for a bad filter', async () => {
    const missing = path.join(root, 'no such folder', 'x.mkv');
    const { run } = await encode({ id: 'open', inputs: [clip], output: missing, expectedDurationUs: clipInfo.durationUs,
      args: [...ffmpegInput(clip, 'matroska'), '-an', '-c:v', 'mpeg4', ...toFile(missing)] });
    expect(run.exitCode).not.toBe(0);
    expect(run.failureCode).toBe('output_open_failed');
    const failure = runFailure(run)!;
    expect(failure).toMatchObject({ reason: 'output_open_failed', code: 'output_open_failed' });
    expect(failure.detail).toContain('Error opening output <output>');
    expect(failure.detail).not.toContain(root);
    expect(failure.detail).not.toContain('no such folder');
    expect(failure.detail.toLowerCase()).not.toContain(os.userInfo().username.toLowerCase());

    // -n against an existing file: exit 0 and no progress at all.
    const existing = out('existing.mkv');
    await writeFile(existing, 'taken');
    const refused = await encode({ id: 'exists', inputs: [clip], output: existing, expectedDurationUs: clipInfo.durationUs,
      args: [...ffmpegInput(clip, 'matroska'), '-an', '-c:v', 'mpeg4', '-f', 'matroska', '-n', `file:${existing}`] });
    expect(refused.run).toMatchObject({ exitCode: 0, sawEnd: false, progress: null, failureCode: 'output_open_failed' });
    expect(runFailure(refused.run)?.detail).toContain("File '<output>' already exists");

    // A video filter on the audio stream: ffmpeg also says "Error opening output file", but the file is not the problem.
    const audio = out('bad-filter.mka');
    const filterRun = await encode({ id: 'bad-filter', inputs: [clip], output: audio, expectedDurationUs: clipInfo.durationUs,
      args: [...ffmpegInput(clip, 'matroska'), '-vn', '-filter:a:0', 'scale=160:90', '-c:a', 'aac', '-f', 'matroska', '-y', `file:${audio}`] });
    expect(filterRun.run.exitCode).not.toBe(0);
    expect(filterRun.run.failureCode).toBe(null);
    expect(runFailure(filterRun.run)).toMatchObject({ reason: 'exit_code', code: 'unknown' });
    expect(runFailure(filterRun.run)!.detail).toContain('Error opening output file <output>.');
  }, 60_000);
});
