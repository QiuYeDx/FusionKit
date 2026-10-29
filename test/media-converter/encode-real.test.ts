import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import { MediaRuntime, type MediaTools } from '../../electron/main/media-converter/engine/runtime';
import { MediaProber } from '../../electron/main/media-converter/engine/probe';
import { buildPlan } from '../../electron/main/media-converter/plan/stream-plan';
import { probeArgs, toFfmpegArgs } from '../../electron/main/media-converter/plan/args';
import { VIDEO_TABLE } from '../../electron/main/media-converter/plan/video';
import type { ConversionPlan, PlannedOutput, PlannerCapabilities } from '../../electron/main/media-converter/plan/types';
import {
  defaultCompressSettings, type CompressCodec, type ConversionSettings, type MediaInfo, type Tier, type VariantKey, type VideoEncoderId,
} from '../../src/media-converter/contract';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * V-ENCODE-02-2: every encoder the bundled ffmpeg can run on this computer encodes a 2 s, 640×360
 * lavfi clip (testsrc2 with temporal noise, so every frame carries real detail) at each tier, with
 * exactly the planner's arguments. Checked with ffprobe: every frame decodes, the sizes fall
 * strictly from quality to balanced to size, the codec, profile and bit depth are the designed
 * ones (AC-ENCODE-02-4: H.264 High also from Media Foundation, HEVC Main10 where 10-bit, AV1
 * 10-bit), HEVC carries `hvc1`, the MP4 is fast-start, and the `level+warning` log has no silent
 * substitution. A 12 s, 160×120 clip checks that keyframes come about every 5 s (±1 s). The
 * hardware encoders also open 2 black frames at the edges of the size range the planner allows
 * them, which is the one place the inputs exceed 640×360 (up to 8192 wide).
 *
 * The test does not depend on the capability detection: each configuration is tried directly. One
 * whose device or runtime is missing (no GPU of that vendor, no MFT) is skipped with the reason;
 * with an NVIDIA driver installed, NVENC is required, so the test cannot pass by skipping it.
 * `FUSIONKIT_MEDIA_REQUIRE_ENCODERS=all` requires every configuration. Every ffmpeg runs at idle
 * priority with the runtime's reduced environment, in a run folder under test-results/media-converter;
 * ffprobe runs through the verified runtime, below normal. Skipped when the runtime is not staged.
 *
 * V-ENCODE-03-2 (`-t correctness`): the picture's correctness on small lavfi sources (≤ 2 s,
 * ≤ 640×360): a display-matrix rotation turned into pixels by a re-encode and kept by a remux; an
 * HDR10 source with mastering display and content light metadata kept by AV1 (and 10-bit HEVC on
 * NVENC) and tone mapped to BT.709 by H.264; full range measured back at YMAX ≤ 940; a variable
 * frame rate kept frame for frame; an interlaced source deinterlaced.
 */

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
const LIMITS = { timeoutMs: 60_000, stdoutMaxBytes: 4 * 1024 * 1024, stderrMaxBytes: 1024 * 1024 };
const FFMPEG_DEADLINE_MS = 120_000;
/** What the engine's process wrapper puts in front (without the progress pipe, which nothing reads here). */
const PREFIX = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning'];
/** Warnings that mean ffmpeg silently did something other than asked (module-encode tasks, common conventions). */
const SILENT_SUBSTITUTION = /Invalid option|Error parsing option|auto-selecting format|only the last/;
/** The capability categories that mean "not on this computer" (engine design §3), which skip rather than fail. */
const DEVICE_MISSING: readonly (readonly [RegExp, string])[] = [
  [/No capable devices found|No NVENC capable devices found|MFX session|No device available for encoder/i, 'no_device'],
  [/Cannot load nvcuda\.dll|Cannot load nvEncodeAPI64\.dll|amfrt64\.dll|could not find any MFT/i, 'runtime_missing'],
];
/** NVENC refusing a picture size: under its minimum, or over its maximum (which it follows with "No capable devices found"). */
const SIZE_REFUSED = /Frame Dimensions? (?:are )?less than the minimum|(?:Width|Height) \d+ exceeds \d+/i;
const NVIDIA_DRIVER = process.platform === 'win32' && existsSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvcuda.dll'));
const REQUIRE_ALL = process.env.FUSIONKIT_MEDIA_REQUIRE_ENCODERS === 'all';
const TIERS: readonly Tier[] = ['quality', 'balanced', 'size'];

interface Case {
  name: string;
  codec: CompressCodec;
  useGpuForAv1: boolean;
  caps: PlannerCapabilities['encoders'];
  encoder: VideoEncoderId;
  variant: VariantKey;
  /** What ffprobe must read back. */
  expected: { codec: string; profile: string; pixFmt: string; tag?: string };
}
const v = (encoder: VideoEncoderId, variant: VariantKey): PlannerCapabilities['encoders'] => ({ [encoder]: { variants: { [variant]: true } } });
const AV1 = { codec: 'av1', profile: 'Main', pixFmt: 'yuv420p10le' };
const MAIN10 = { codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', tag: 'hvc1' };
const MAIN = { codec: 'hevc', profile: 'Main', pixFmt: 'yuv420p', tag: 'hvc1' };
const HIGH = { codec: 'h264', profile: 'High', pixFmt: 'yuv420p' };
const CASES: readonly Case[] = [
  { name: 'libsvtav1', codec: 'av1', useGpuForAv1: false, caps: {}, encoder: 'libsvtav1', variant: '10bit', expected: AV1 },
  { name: 'av1_nvenc uhq', codec: 'av1', useGpuForAv1: true, caps: v('av1_nvenc', '10bit_uhq'), encoder: 'av1_nvenc', variant: '10bit_uhq', expected: AV1 },
  { name: 'av1_nvenc hq', codec: 'av1', useGpuForAv1: true, caps: v('av1_nvenc', '10bit'), encoder: 'av1_nvenc', variant: '10bit', expected: AV1 },
  { name: 'hevc_nvenc uhq 10-bit', codec: 'hevc', useGpuForAv1: false, caps: v('hevc_nvenc', '10bit_uhq'), encoder: 'hevc_nvenc', variant: '10bit_uhq', expected: MAIN10 },
  { name: 'hevc_nvenc hq 10-bit', codec: 'hevc', useGpuForAv1: false, caps: v('hevc_nvenc', '10bit'), encoder: 'hevc_nvenc', variant: '10bit', expected: MAIN10 },
  { name: 'hevc_nvenc uhq 8-bit', codec: 'hevc', useGpuForAv1: false, caps: v('hevc_nvenc', '8bit_uhq'), encoder: 'hevc_nvenc', variant: '8bit_uhq', expected: MAIN },
  { name: 'hevc_nvenc hq 8-bit', codec: 'hevc', useGpuForAv1: false, caps: v('hevc_nvenc', '8bit'), encoder: 'hevc_nvenc', variant: '8bit', expected: MAIN },
  { name: 'h264_nvenc', codec: 'h264', useGpuForAv1: false, caps: v('h264_nvenc', '8bit'), encoder: 'h264_nvenc', variant: '8bit', expected: HIGH },
  { name: 'h264_mf hardware', codec: 'h264', useGpuForAv1: false, caps: v('h264_mf', '8bit'), encoder: 'h264_mf', variant: '8bit', expected: HIGH },
  { name: 'h264_mf software', codec: 'h264', useGpuForAv1: false, caps: v('h264_mf', '8bit_sw'), encoder: 'h264_mf', variant: '8bit_sw', expected: HIGH },
  { name: 'hevc_mf hardware', codec: 'hevc', useGpuForAv1: false, caps: v('hevc_mf', '8bit'), encoder: 'hevc_mf', variant: '8bit', expected: MAIN },
  { name: 'libkvazaar', codec: 'hevc', useGpuForAv1: false, caps: {}, encoder: 'libkvazaar', variant: '8bit', expected: MAIN },
  { name: 'libopenh264', codec: 'h264', useGpuForAv1: false, caps: {}, encoder: 'libopenh264', variant: '8bit', expected: HIGH },
];
const required = (item: Case) => REQUIRE_ALL || (NVIDIA_DRIVER && item.encoder.endsWith('_nvenc'));

let root: string, runtime: MediaRuntime, prober: MediaProber, tools: MediaTools, clip: { path: string; info: MediaInfo }, long: { path: string; info: MediaInfo };
const report: string[] = [];

type Run = { code: number | null; stderr: string };
/** The bundled ffmpeg at idle priority with the runtime's environment, settled by our own deadline (FK-PIT-0036). */
function ffmpeg(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    // The app augments ProcessEnv with main-process fields; the runtime's reduced environment has none of them (as engine/process.ts).
    const child = spawn(tools.ffmpeg, [...PREFIX, ...args], { cwd: root, env: { ...tools.environment } as NodeJS.ProcessEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* Exited already. */ }
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ffmpeg did not finish in ${FFMPEG_DEADLINE_MS} ms: ${stderr}`)); }, FFMPEG_DEADLINE_MS);
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}
async function generated(name: string, args: string[]) {
  const file = path.join(root, name);
  const run = await ffmpeg(['-y', ...args, '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', '-f', 'matroska', file]);
  if (run.code !== 0) throw new Error(`source ${name}: ${run.stderr}`);
  const outcome = await prober.probe(file);
  if (!outcome.ok) throw new Error(`${name}: ${outcome.code}`);
  return { path: file, info: outcome.info };
}

type ProbedStream = { codec_name: string; profile?: string; pix_fmt?: string; codec_tag_string?: string; width: number; height: number; nb_read_frames?: string };
async function ffprobe(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await runtime.run('ffprobe', ['-hide_banner', ...args], LIMITS);
  expect(result.exitCode, result.stderr.toString('utf8')).toBe(0);
  return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
}
/** Decodes every frame (`-count_frames`) and reads the stream back; any decoder error is a failure. */
async function decoded(file: string): Promise<ProbedStream> {
  const { stdout, stderr } = await ffprobe(['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,codec_tag_string,width,height,nb_read_frames', '-of', 'json', `file:${file}`]);
  expect(stderr.trim(), `decode errors in ${path.basename(file)}`).toBe('');
  return JSON.parse(stdout).streams[0];
}
/** Seconds of every keyframe; a row can carry empty side-data fields after the time, so only the first field is read. */
async function keyframeTimes(file: string): Promise<number[]> {
  const { stdout } = await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', `file:${file}`]);
  return stdout.split(/\r?\n/).filter(Boolean).map(line => Number(line.split(',')[0]));
}
/** The top-level MP4 boxes in order; `+faststart` puts `moov` before `mdat`. */
async function topLevelBoxes(file: string): Promise<string[]> {
  const bytes = await readFile(file);
  const boxes: string[] = [];
  for (let at = 0; at + 8 <= bytes.length;) {
    let size = bytes.readUInt32BE(at);
    boxes.push(bytes.toString('latin1', at + 4, at + 8));
    if (size === 1) size = Number(bytes.readBigUInt64BE(at + 8));
    if (size === 0) break;
    if (size < 8) throw new Error(`bad box at ${at}`);
    at += size;
  }
  return boxes;
}

function planFor(item: Case, source: MediaInfo, tier: Tier): PlannedOutput {
  const settings = { ...defaultCompressSettings(item.codec), tier, useGpuForAv1: item.useGpuForAv1 };
  const outcome = buildPlan(source, settings, { encoders: item.caps, degraded: [], nvencMin: { width: 144, height: 120 } });
  if (outcome.status !== 'ready') throw new Error(`no plan: ${outcome.status}`);
  return outcome.plan.outputs[0];
}
/** Runs the plan's arguments; `skip` when the device or runtime of this configuration is missing here. */
async function encode(item: Case, source: { path: string; info: MediaInfo }, tier: Tier, name: string, lowUsage = false) {
  const output = planFor(item, source.info, tier);
  const file = path.join(root, `${name}.${output.container.extension}`);
  const args = toFfmpegArgs(output, { inputPath: source.path, demuxer: source.info.container.demuxer, partialPath: file, lowUsage });
  const run = await ffmpeg(args);
  if (run.code !== 0) {
    const missing = DEVICE_MISSING.find(([pattern]) => pattern.test(run.stderr));
    if (missing) return { skip: `${missing[1]}: ${run.stderr.split(/\r?\n/).find(line => missing[0].test(line))?.trim()}` } as const;
    throw new Error(`${item.name} ${tier} failed (${run.code}): ${run.stderr}`);
  }
  expect(run.stderr, `${item.name} ${tier} log`).not.toMatch(SILENT_SUBSTITUTION);
  return { output, file, args, stderr: run.stderr, bytes: (await stat(file)).size } as const;
}

beforeAll(async () => {
  if (!available) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'encode-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'encode-')));
  runtime = new MediaRuntime({ environment, workingDirectory: path.join(root, 'work') });
  prober = new MediaProber({ runtime });
  tools = await runtime.acquire();
  // Moving test pattern with temporal noise: every frame differs, as a real camera clip's would.
  clip = await generated('clip.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-vf', 'noise=alls=12:allf=t+u']);
  long = await generated('long.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=12', '-vf', 'noise=alls=8:allf=t+u']);
}, 180_000);
afterAll(async () => {
  if (report.length) console.log(['V-ENCODE-02-2 results', ...report].join('\n'));
  prober?.dispose();
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});

describe.skipIf(!available)('encoding with the planner arguments and the real ffmpeg', () => {
  it('starts from sources the planner reads as 640×360 and 160×120 at 30 fps, without audio', () => {
    expect(clip.info.video[0]).toMatchObject({ width: 640, height: 360, fps: 30 });
    expect(long.info.video[0]).toMatchObject({ width: 160, height: 120, fps: 30 });
    expect([clip.info.audio.length, long.info.audio.length]).toEqual([0, 0]);
    expect(Math.round((long.info.durationUs ?? 0) / 1e6)).toBe(12);
  });

  it.each(CASES)('$name: three tiers that decode, shrink strictly and carry the designed stream; keyframes about every 5 s', async item => {
    const results = [];
    for (const tier of TIERS) {
      const planned = planFor(item, clip.info, tier).streams.find(decision => decision.source.kind === 'video');
      expect(planned?.action === 'encode' && `${planned.encode.encoder}/${planned.encode.variant}`).toBe(`${item.encoder}/${item.variant}`);
      const result = await encode(item, clip, tier, `${item.name.replace(/\W+/g, '-')}-${tier}`);
      if ('skip' in result) {
        report.push(`${item.name}: skipped (${result.skip})`);
        expect(required(item), `${item.name} is required here but was skipped: ${result.skip}`).toBe(false);
        return;
      }
      results.push(result);
    }

    const [quality, balanced, size] = results;
    report.push(`${item.name} (${item.encoder}/${item.variant}): ${results.map((result, i) => `${TIERS[i]} ${result.bytes} B`).join(', ')}`);
    expect(quality.bytes, `${item.name}: quality > balanced`).toBeGreaterThan(balanced.bytes);
    expect(balanced.bytes, `${item.name}: balanced > size`).toBeGreaterThan(size.bytes);

    for (const [i, result] of results.entries()) {
      const stream = await decoded(result.file);
      expect(stream, `${item.name} ${TIERS[i]}`).toMatchObject({
        codec_name: item.expected.codec, profile: item.expected.profile, pix_fmt: item.expected.pixFmt, width: 640, height: 360, nb_read_frames: '60',
      });
      if (item.expected.tag) expect(stream.codec_tag_string).toBe(item.expected.tag);
      expect(result.output.container).toMatchObject({ id: 'mp4', faststart: true });
      const boxes = await topLevelBoxes(result.file);
      expect(boxes.indexOf('moov'), `${item.name} ${TIERS[i]} boxes ${boxes.join(',')}`).toBeGreaterThan(-1);
      expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
      const warnings = result.stderr.split(/\r?\n/).filter(line => /\[(?:warning|error)\]/.test(line));
      if (warnings.length) report.push(`  ${TIERS[i]} log: ${warnings.join(' | ')}`);
    }

    // Keyframes: 12 s at 30 fps, so about 0, 5 and 10 s.
    const gop = await encode(item, long, 'balanced', `${item.name.replace(/\W+/g, '-')}-gop`);
    if ('skip' in gop) throw new Error(`${item.name}: the 160×120 clip was refused (${gop.skip})`);
    const times = await keyframeTimes(gop.file);
    report.push(`  keyframes at ${times.map(time => time.toFixed(2)).join(', ')} s`);
    expect(times[0]).toBeCloseTo(0, 1);
    expect(times.length, `${item.name} keyframes ${times.join(', ')}`).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < times.length; i++) {
      const interval = times[i] - times[i - 1];
      expect(interval, `${item.name} keyframe interval ${i}: ${times.join(', ')}`).toBeGreaterThanOrEqual(4);
      expect(interval, `${item.name} keyframe interval ${i}: ${times.join(', ')}`).toBeLessThanOrEqual(6);
    }
  }, 300_000);

  it('runs SVT-AV1 with lp=1 in low-usage mode without a warning', async () => {
    const result = await encode(CASES[0], clip, 'balanced', 'svt-low-usage', true);
    if ('skip' in result) throw new Error(result.skip);
    expect(result.args).toContain('-svtav1-params:v:0');
    expect(result.args[result.args.indexOf('-svtav1-params:v:0') + 1]).toBe('lp=1');
    expect(result.stderr).toMatch(/Level of Parallelism: 1/);
    expect(result.stderr).not.toMatch(/\[(?:warning|error)\]/);
    expect((await decoded(result.file)).nb_read_frames).toBe('60');
  }, 120_000);

  /**
   * The size ranges the planner keeps the hardware encoders in (`VIDEO_TABLE.hardwareFrame`): an
   * encoder that fails to open is degraded for the session, so the planner must never hand one a
   * picture it refuses. Each configuration encodes 2 black frames with its probe arguments at the
   * smallest and the widest picture of its codec, which must open; NVENC must refuse one step
   * outside. The MF hardware encoder may be another vendor's, so only its inside sizes are required.
   */
  it('opens the hardware encoders at the edges of the sizes the planner gives them, and NVENC refuses one step outside', async () => {
    const configurations = [
      ['h264_nvenc', '8bit', 'h264'], ['hevc_nvenc', '10bit', 'hevc'], ['av1_nvenc', '10bit', 'av1'], ['h264_mf', '8bit', 'h264'], ['hevc_mf', '8bit', 'hevc'],
    ] as const;
    for (const [encoder, variant, codec] of configurations) {
      // The planner encodes even sides only: the smallest it gives is the first even size within the
      // range of AC-ENCODE-02-2 (H.264 145×49 → 146×50, HEVC 129×33 → 130×34, AV1 129×65 → 130×66).
      const even = (side: number) => Math.ceil(side / 2) * 2;
      const { maxSide } = VIDEO_TABLE.hardwareFrame[codec];
      const [minWidth, minHeight] = [even(VIDEO_TABLE.hardwareFrame[codec].minWidth), even(VIDEO_TABLE.hardwareFrame[codec].minHeight)];
      const nvenc = encoder.endsWith('_nvenc');
      const open = (width: number, height: number) =>
        ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${width}x${height}:r=30`, '-frames:v', '2', ...probeArgs(encoder, variant), '-f', 'null', '-']);
      const inside = [[minWidth, minHeight], [maxSide, 1088]] as const;
      const outside = [[minWidth - 2, minHeight], [minWidth, minHeight - 2], [maxSide + 16, 1088], [1088, maxSide + 16]] as const;
      const first = await open(...inside[0]);
      const missing = first.code !== 0 && !SIZE_REFUSED.test(first.stderr) ? DEVICE_MISSING.find(([pattern]) => pattern.test(first.stderr)) : undefined;
      if (missing) {
        report.push(`size range ${encoder}: skipped (${missing[1]})`);
        expect(REQUIRE_ALL || (NVIDIA_DRIVER && nvenc), `${encoder} is required here but was skipped`).toBe(false);
        continue;
      }
      const results: string[] = [];
      for (const [i, [width, height]] of inside.entries()) {
        const run = i === 0 ? first : await open(width, height);
        expect(run.code, `${encoder} ${width}×${height} must open: ${run.stderr}`).toBe(0);
        results.push(`${width}×${height} opens`);
      }
      for (const [width, height] of outside) {
        const run = await open(width, height);
        results.push(`${width}×${height} ${run.code === 0 ? 'opens' : 'refused'}`);
        if (!nvenc) continue;
        expect(run.code, `${encoder} ${width}×${height} must be refused`).not.toBe(0);
        expect(run.stderr).toMatch(SIZE_REFUSED);
      }
      report.push(`size range ${encoder}: ${results.join(', ')}`);
    }
  }, 300_000);
});

// ── V-ENCODE-03-2: correctness ─────────────────────────────────────────────────────────────────

const CPU_ONLY: PlannerCapabilities = { encoders: {}, degraded: [], nvencMin: { width: 144, height: 120 } };
const correctnessReport: string[] = [];

type SideData = Record<string, string | number> & { side_data_type: string };
/** `num/den` (or a plain number) as a number. */
const ratio = (value: string | number | undefined) => {
  const [num, den = '1'] = String(value ?? 'NaN').split('/');
  return Number(num) / Number(den);
};

describe.skipIf(!available)('correctness (V-ENCODE-03-2) with the planner arguments and the real ffmpeg', () => {
  type Source = { path: string; info: MediaInfo };
  let rotated: Source, hdr10: Source, ramp: Source, rampOdd: Source, jpeg: Source, jpegTv: Source, vfr: Source, interlaced: Source;

  /** Runs ffmpeg to make a source in the run folder, then probes it as the engine would. */
  async function made(name: string, args: string[]): Promise<Source> {
    const file = path.join(root, name);
    const run = await ffmpeg(['-y', ...args, file]);
    if (run.code !== 0) throw new Error(`source ${name}: ${run.stderr}`);
    const outcome = await prober.probe(file);
    if (!outcome.ok) throw new Error(`${name}: ${outcome.code}`);
    return { path: file, info: outcome.info };
  }
  /** Plans and runs one conversion with the planner's arguments. */
  async function converted(source: Source, settings: ConversionSettings, caps: PlannerCapabilities, name: string) {
    const outcome = buildPlan(source.info, settings, caps);
    if (outcome.status !== 'ready') throw new Error(`no plan for ${name}: ${JSON.stringify(outcome).slice(0, 200)}`);
    const output = outcome.plan.outputs[0];
    const file = path.join(root, `${name}.${output.container.extension}`);
    const args = toFfmpegArgs(output, { inputPath: source.path, demuxer: source.info.container.demuxer, partialPath: file });
    const run = await ffmpeg(args);
    const warnings = run.stderr.split(/\r?\n/).filter(line => /\[(?:warning|error)\]/.test(line));
    if (warnings.length) correctnessReport.push(`  ${name} log: ${warnings.join(' | ')}`);
    return { plan: outcome.plan, file, args, run };
  }
  /** `converted`, which must succeed without a silent substitution in its log. */
  async function encoded(source: Source, settings: ConversionSettings, caps: PlannerCapabilities, name: string): Promise<{ plan: ConversionPlan; file: string; args: string[] }> {
    const result = await converted(source, settings, caps, name);
    expect(result.run.code, `${name}: ${result.run.stderr}`).toBe(0);
    expect(result.run.stderr, `${name} log`).not.toMatch(SILENT_SUBSTITUTION);
    return result;
  }
  const filterOf = (args: string[]) => args[args.indexOf('-filter:v:0') + 1];

  type ProbedColor = {
    width: number; height: number; pix_fmt: string; color_range?: string; color_space?: string; color_transfer?: string; color_primaries?: string;
    field_order?: string; side_data_list?: SideData[];
  };
  async function streamOf(file: string): Promise<ProbedColor> {
    const { stdout } = await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,field_order:stream_side_data', '-of', 'json', `file:${file}`]);
    return JSON.parse(stdout).streams[0];
  }
  async function firstFrameSideData(file: string): Promise<SideData[]> {
    const { stdout } = await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame_side_data', '-of', 'json', `file:${file}`]);
    return JSON.parse(stdout).frames[0]?.side_data_list ?? [];
  }
  /** One frame metadata value of a filter (`signalstats`, `idet`) for every frame, as the `metadata` filter prints it to a file. */
  async function frameValues(file: string, filter: string, key: string): Promise<string[]> {
    const listing = `${path.basename(file)}.${filter}.txt`;
    const run = await ffmpeg(['-i', `file:${file}`, '-vf', `${filter},metadata=mode=print:key=${key}:file=${listing}`, '-f', 'null', '-']);
    expect(run.code, run.stderr).toBe(0);
    const text = await readFile(path.join(root, listing), 'utf8');
    return text.split(/\r?\n/).filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1).trim());
  }
  const lumaMax = async (file: string) => Math.max(...(await frameValues(file, 'signalstats', 'lavfi.signalstats.YMAX')).map(Number));
  const lumaMin = async (file: string) => Math.min(...(await frameValues(file, 'signalstats', 'lavfi.signalstats.YMIN')).map(Number));
  /** The first frame as players show it (ffmpeg turns it by the display matrix), as 8-bit grey. */
  async function firstFrameGrey(file: string, width: number, height: number): Promise<(x: number, y: number) => number> {
    const raw = path.join(root, `${path.basename(file)}.grey`);
    const run = await ffmpeg(['-i', `file:${file}`, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-y', raw]);
    expect(run.code, run.stderr).toBe(0);
    const bytes = await readFile(raw);
    expect(bytes.length).toBe(width * height);
    return (x, y) => bytes[y * width + x];
  }
  /** The four corners of a 180×320 picture: is each one white? */
  const corners = (pixel: (x: number, y: number) => number) => [pixel(160, 40), pixel(20, 40), pixel(160, 280), pixel(20, 280)].map(value => value > 128);
  /** The mastering display (every primary, the white point and the luminances, as numbers) and the content light levels. */
  function hdrMetadata(sideData: SideData[]) {
    const mastering = sideData.find(item => item.side_data_type === 'Mastering display metadata');
    const light = sideData.find(item => item.side_data_type === 'Content light level metadata');
    const keys = ['red_x', 'red_y', 'green_x', 'green_y', 'blue_x', 'blue_y', 'white_point_x', 'white_point_y', 'min_luminance', 'max_luminance'];
    return {
      mastering: mastering ? Object.fromEntries(keys.map(key => [key, ratio(mastering[key])])) : null,
      light: light ? { maxCll: Number(light.max_content), maxFall: Number(light.max_average) } : null,
    };
  }
  /**
   * The output's first frame carries the source's metadata (the source's own first frame is the
   * reference), and that is the metadata the source was made with. Each codec stores it in its own
   * steps: AV1 the chromaticities in 1/65536 and the minimum luminance in 1/16384 (0.0001 reads
   * 2/16384), HEVC in 0.00002 and 0.0001 cd/m², so values agree within one step.
   */
  async function expectHdr10Kept(file: string) {
    const [source, output] = [hdrMetadata(await firstFrameSideData(hdr10.path)), hdrMetadata(await firstFrameSideData(file))];
    expect(output.mastering, 'mastering display metadata').not.toBeNull();
    for (const [key, value] of Object.entries(source.mastering ?? {})) {
      const step = key === 'max_luminance' ? 0.5 : key === 'min_luminance' ? 1 / 16384 : 1e-4;
      expect(Math.abs((output.mastering?.[key] ?? Number.NaN) - value), `${key}: ${output.mastering?.[key]} for ${value}`).toBeLessThanOrEqual(step);
    }
    expect(output.light).toEqual(source.light);
    expect(output.light).toEqual({ maxCll: 1000, maxFall: 400 });
    expect(output.mastering?.max_luminance).toBe(1000);
    expect(output.mastering?.min_luminance).toBeCloseTo(0.0001, 4);
    expect(output.mastering?.red_x).toBeCloseTo(0.68, 3);
    expect(output.mastering?.white_point_y).toBeCloseTo(0.329, 3);
    return output;
  }
  const compressTo = (codec: CompressCodec): ConversionSettings => ({ ...defaultCompressSettings(codec), tier: 'balanced' });

  beforeAll(async () => {
    if (!available) return;
    // 320×180 with a white block in the top-left corner, stored landscape and turned 90° clockwise
    // by the display matrix (`-display_rotation -90` is counter-clockwise -90°), as a phone does.
    await made('upright.mp4', ['-f', 'lavfi', '-i', 'color=black:s=320x180:r=30:d=1,drawbox=x=0:y=0:w=80:h=45:color=white:t=fill',
      '-c:v', 'libopenh264', '-b:v', '500k', '-pix_fmt', 'yuv420p', '-f', 'mp4']);
    rotated = await made('rotated.mp4', ['-display_rotation:v:0', '-90', '-i', `file:${path.join(root, 'upright.mp4')}`, '-c', 'copy', '-f', 'mp4']);
    // HDR10: 10-bit BT.2020 + PQ with mastering display (1000 / 0.0001 cd/m²) and content light (1000 / 400)
    // metadata. The luma is brought down so the brightest code is about 1000 cd/m² in PQ, as the
    // metadata says; testsrc2's own white would be 10000 cd/m² and tone map past SDR white.
    hdr10 = await made('hdr10.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1',
      '-vf', 'lutyuv=y=16+(val-16)*0.75,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
      '-c:v', 'libsvtav1', '-preset', '10', '-crf', '30',
      '-svtav1-params', 'mastering-display=G(0.265,0.69)B(0.15,0.06)R(0.68,0.32)WP(0.3127,0.329)L(1000,0.0001):content-light=1000,400', '-f', 'matroska']);
    // Full range: a smooth luma ramp up to 255 (flat white over the right quarter) tagged pc, so no
    // edge rings past the range in the encode; an odd size that needs a scale; and a yuvj* MJPEG.
    const rampArgs = (size: string, pixFmt: string, codec: string[]) => ['-f', 'lavfi', '-i', `color=gray:s=${size}:r=30:d=1,format=${pixFmt}`,
      '-vf', 'geq=lum=min(255\\,X*255*4/(3*W)):cb=128:cr=128', '-color_range', 'pc', ...codec, '-f', 'matroska'];
    ramp = await made('ramp.mkv', rampArgs('320x180', 'yuv420p', ['-c:v', 'ffv1']));
    rampOdd = await made('ramp-odd.mkv', rampArgs('321x181', 'yuv420p', ['-c:v', 'ffv1']));
    jpeg = await made('ramp-jpeg.mkv', rampArgs('320x180', 'yuvj420p', ['-c:v', 'mjpeg', '-q:v', '2']));
    // The same MJPEG with the container tagging it tv: still yuvj*, so still full range to swscale.
    jpegTv = await made('ramp-jpeg-tv.mkv', ['-i', `file:${jpeg.path}`, '-c', 'copy', '-color_range', 'tv', '-f', 'matroska']);
    // Variable rate: 10 fps over the first second, 30 fps over the next (r_frame_rate 30, average 20).
    vfr = await made('vfr.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-vf', 'select=if(lt(t\\,1)\\,not(mod(n\\,3))\\,1)',
      '-fps_mode', 'vfr', '-c:v', 'libopenh264', '-b:v', '600k', '-f', 'mp4']);
    // Interlaced: 59.94 half-height pictures woven into 29.97 top-field-first frames, coded as MPEG-2 fields.
    interlaced = await made('interlaced.ts', ['-f', 'lavfi', '-i', 'testsrc2=s=640x180:r=60000/1001:d=1', '-vf', 'weave=first_field=top,setfield=tff',
      '-c:v', 'mpeg2video', '-flags', '+ildct+ilme', '-b:v', '6M', '-f', 'mpegts']);
  }, 180_000);
  afterAll(() => {
    if (correctnessReport.length) console.log(['V-ENCODE-03-2 results', ...correctnessReport].join('\n'));
  });

  it('starts from sources the planner reads as intended', () => {
    expect(rotated.info.video[0]).toMatchObject({ width: 320, height: 180, rotation: 90 });
    expect(hdr10.info.video[0]).toMatchObject({ bitDepth: 10, colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc', colorRange: 'tv' });
    expect(hdr10.info.video[0].hdr).toMatchObject({ format: 'hdr10', masteringDisplay: { luminance: { min: 0.0001, max: 1000 } }, contentLight: { maxCll: 1000, maxFall: 400 } });
    for (const source of [ramp, rampOdd, jpeg]) expect(source.info.video[0].colorRange).toBe('pc');
    expect(jpeg.info.video[0].pixFmt).toBe('yuvj420p');
    expect(jpegTv.info.video[0]).toMatchObject({ pixFmt: 'yuvj420p', colorRange: 'tv' });
    expect(rampOdd.info.video[0]).toMatchObject({ width: 321, height: 181 });
    expect(vfr.info.video[0]).toMatchObject({ rFrameRate: '30/1', avgFrameRate: '20/1', isVfr: true });
    expect(interlaced.info.video[0]).toMatchObject({ fieldOrder: 'tt', isVfr: false, width: 640, height: 360 });
  });

  it('rotation (AC-ENCODE-03-1): a re-encode turns the pixels and keeps no display matrix; a remux keeps the matrix', async () => {
    const source = await streamOf(rotated.path);
    expect(source.side_data_list?.find(item => item.side_data_type === 'Display Matrix')?.rotation).toBe(-90);
    // What a player shows: turned clockwise, the white block is at the top right of a 180×320 picture.
    expect(corners(await firstFrameGrey(rotated.path, 180, 320))).toEqual([true, false, false, false]);

    const reencoded = await encoded(rotated, compressTo('av1'), CPU_ONLY, 'rotated-av1');
    const stream = await streamOf(reencoded.file);
    expect(stream).toMatchObject({ width: 180, height: 320 });
    expect((stream.side_data_list ?? []).map(item => item.side_data_type)).not.toContain('Display Matrix');
    expect((await firstFrameSideData(reencoded.file)).map(item => item.side_data_type)).not.toContain('Display Matrix');
    expect(corners(await firstFrameGrey(reencoded.file, 180, 320))).toEqual([true, false, false, false]);

    const remuxed = await encoded(rotated, { task: 'convert', target: 'mkv', preferRemux: true, tier: 'balanced' }, CPU_ONLY, 'rotated-remux');
    expect(remuxed.plan.isRemuxOnly).toBe(true);
    const kept = await streamOf(remuxed.file);
    expect(kept).toMatchObject({ width: 320, height: 180 });
    expect(kept.side_data_list?.find(item => item.side_data_type === 'Display Matrix')?.rotation).toBe(-90);
    expect(corners(await firstFrameGrey(remuxed.file, 180, 320))).toEqual([true, false, false, false]);
    correctnessReport.push('rotation: re-encode 180×320 without a display matrix, block top right; remux 320×180 keeping rotation -90');
  }, 120_000);

  it('untagged colour (AC-ENCODE-03-2): BT.709 from 1280 wide or above 576 high, as shown, else BT.601, written into the output', async () => {
    const results: string[] = [];
    // Stored size, the clockwise turn of the display matrix, and the tags the shown picture gets: the
    // last two are SD as stored, but shown 576×1024 (portrait, above 576 high) they are HD.
    for (const [width, height, rotation, expected] of [
      [1280, 544, 0, 'bt709'], [1024, 576, 0, 'smpte170m'], [720, 576, 0, 'smpte170m'], [768, 1280, 0, 'bt709'], [1024, 576, 90, 'bt709'],
    ] as const) {
      const name = `untagged-${width}x${height}-r${rotation}`;
      // Three flat frames without colour tags.
      const stored = await made(`${name}.mp4`, ['-f', 'lavfi', '-i', `color=gray:s=${width}x${height}:r=30:d=0.1`, '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-b:v', '300k', '-f', 'mp4']);
      const source = rotation ? await made(`${name}-turned.mp4`, ['-display_rotation:v:0', String(-rotation), '-i', `file:${stored.path}`, '-c', 'copy', '-f', 'mp4']) : stored;
      expect(source.info.video[0], name).toMatchObject({ width, height, rotation, colorPrimaries: null, colorTransfer: null, colorSpace: null });
      const result = await encoded(source, compressTo('av1'), CPU_ONLY, `${name}-av1`);
      expect(filterOf(result.args), name).toMatch(new RegExp(`setparams=color_primaries=${expected}:color_trc=${expected}:colorspace=${expected}:range=tv$`));
      expect(await streamOf(result.file), name).toMatchObject({ color_primaries: expected, color_transfer: expected, color_space: expected, color_range: 'tv' });
      results.push(`${width}×${height}${rotation ? ` turned ${rotation}°` : ''} → ${expected}`);
    }
    correctnessReport.push(`untagged colour: ${results.join('; ')}`);
  }, 180_000);

  it('HDR10 to AV1 (AC-ENCODE-03-3): BT.2020 + PQ, 10-bit into the encoder, mastering display and content light in the first frame', async () => {
    const result = await encoded(hdr10, compressTo('av1'), CPU_ONLY, 'hdr10-av1');
    expect(await streamOf(result.file)).toMatchObject({ pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv' });
    const metadata = await expectHdr10Kept(result.file);
    expect(filterOf(result.args)).toBe('format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv');
    expect(result.plan.summary.warnings.map(item => item.code)).not.toContain('hdr_tonemapped');
    correctnessReport.push(`HDR10 → AV1: ${JSON.stringify(metadata)}`);
  }, 120_000);

  it.each([
    { name: 'HEVC 10-bit', encoder: 'hevc_nvenc', settings: compressTo('hevc') },
    { name: 'AV1', encoder: 'av1_nvenc', settings: { ...compressTo('av1'), useGpuForAv1: true } },
  ] as const)('HDR10 to $name on NVENC (AC-ENCODE-03-3): kept the same way, where the device is here', async ({ encoder, settings }) => {
    const caps: PlannerCapabilities = { ...CPU_ONLY, encoders: { [encoder]: { variants: { '10bit_uhq': true }, uhq: true } } };
    const result = await converted(hdr10, settings, caps, `hdr10-${encoder}`);
    if (result.run.code !== 0) {
      const missing = DEVICE_MISSING.find(([pattern]) => pattern.test(result.run.stderr));
      if (!missing) throw new Error(result.run.stderr);
      correctnessReport.push(`HDR10 → ${encoder}: skipped (${missing[1]})`);
      expect(REQUIRE_ALL || NVIDIA_DRIVER, `${encoder} is required here but was skipped`).toBe(false);
      return;
    }
    expect(result.plan.summary.encoders).toEqual([{ encoder, variant: '10bit_uhq' }]);
    expect(result.run.stderr).not.toMatch(SILENT_SUBSTITUTION);
    expect(await streamOf(result.file)).toMatchObject({ pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv' });
    const metadata = await expectHdr10Kept(result.file);
    expect(filterOf(result.args)).toBe('format=p010le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv');
    correctnessReport.push(`HDR10 → ${encoder} 10-bit: ${JSON.stringify(metadata)}`);
  }, 120_000);

  it('HDR10 to H.264 (AC-ENCODE-03-3): tone mapped to BT.709 SDR, said so, without the HDR metadata', async () => {
    const result = await encoded(hdr10, compressTo('h264'), CPU_ONLY, 'hdr10-h264');
    const stream = await streamOf(result.file);
    expect(stream).toMatchObject({ pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' });
    expect(stream.side_data_list ?? []).toEqual([]);
    expect(hdrMetadata(await firstFrameSideData(result.file))).toEqual({ mastering: null, light: null });
    // Still a picture, within the limited range.
    const average = (await frameValues(result.file, 'signalstats', 'lavfi.signalstats.YAVG')).map(Number);
    expect(Math.min(...average)).toBeGreaterThan(40);
    expect(await lumaMax(result.file)).toBeLessThanOrEqual(240);
    expect(filterOf(result.args)).toMatch(/^zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,/);
    expect(result.plan.summary.warnings.map(item => item.code)).toContain('hdr_tonemapped');
    correctnessReport.push(`HDR10 → H.264: BT.709 SDR, Y average ${Math.min(...average).toFixed(1)}–${Math.max(...average).toFixed(1)}`);
  }, 120_000);

  it('full range (AC-ENCODE-03-2): pc and yuvj* sources (also one tagged tv) measure YMAX ≤ 940 at 10 bits after conversion, scaled or not', async () => {
    const results: string[] = [];
    for (const [source, name, scale] of [
      [ramp, 'ramp', 'scale=in_range=pc:out_range=tv'],
      [rampOdd, 'ramp-odd', 'scale=w=320:h=180:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv'],
      [jpeg, 'ramp-jpeg', 'scale=in_range=pc:out_range=tv'],
      [jpegTv, 'ramp-jpeg-tv', 'scale=in_range=pc:out_range=tv'],
    ] as const) {
      expect(await lumaMax(source.path), `${name}: the source reaches full range`).toBe(255);
      const result = await encoded(source, compressTo('av1'), CPU_ONLY, `${name}-av1`);
      const [max, min] = [await lumaMax(result.file), await lumaMin(result.file)];
      expect(max, `${name} YMAX`).toBeLessThanOrEqual(940);
      // The bottom moved up as well (0 → 64), give or take the codec's noise.
      expect(min, `${name} YMIN`).toBeGreaterThanOrEqual(56);
      expect(await streamOf(result.file)).toMatchObject({ pix_fmt: 'yuv420p10le', color_range: 'tv' });
      expect(filterOf(result.args).split(',')[0]).toBe(scale);
      results.push(`${name} YMIN ${min} YMAX ${max}`);
    }
    correctnessReport.push(`full range → AV1 10-bit: ${results.join('; ')}`);
  }, 180_000);

  it('variable frame rate (AC-ENCODE-03-5): -fps_mode passthrough keeps every timestamp, the duration within max(0.1 s, 0.5 %)', async () => {
    const result = await encoded(vfr, compressTo('av1'), CPU_ONLY, 'vfr-av1');
    expect(result.args[result.args.indexOf('-fps_mode:v:0') + 1]).toBe('passthrough');
    const timestamps = async (file: string) => (await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', `file:${file}`]))
      .stdout.split(/\r?\n/).filter(Boolean).map(line => Number(line.split(',')[0])).sort((a, b) => a - b);
    const duration = async (file: string) => Number((await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `file:${file}`])).stdout.trim());
    const [before, after] = [await timestamps(vfr.path), await timestamps(result.file)];
    expect(after.length).toBe(before.length);
    for (const [i, time] of before.entries()) expect(Math.abs(after[i] - time), `frame ${i}`).toBeLessThanOrEqual(0.002);
    const [sourceDuration, outputDuration] = [await duration(vfr.path), await duration(result.file)];
    expect(Math.abs(outputDuration - sourceDuration)).toBeLessThanOrEqual(Math.max(0.1, 0.005 * sourceDuration));
    correctnessReport.push(`VFR: ${before.length} → ${after.length} frames, timestamps within 2 ms, duration ${sourceDuration} → ${outputDuration} s`);
  }, 120_000);

  it('interlacing (AC-ENCODE-03-5): a top-field-first source is deinterlaced by bwdif, frame for frame', async () => {
    // AV1: a low-rate openh264 encode leaves line patterns that idet reads as fields even after bwdif.
    const result = await encoded(interlaced, compressTo('av1'), CPU_ONLY, 'interlaced-av1');
    const fields = async (file: string) => {
      const values = await frameValues(file, 'idet', 'lavfi.idet.multiple.current_frame');
      return { frames: values.length, interlaced: values.filter(value => value === 'tff' || value === 'bff').length, progressive: values.filter(value => value === 'progressive').length };
    };
    const [before, after] = [await fields(interlaced.path), await fields(result.file)];
    expect(before.interlaced, JSON.stringify(before)).toBeGreaterThanOrEqual(before.frames - 2);
    expect(after.frames).toBe(before.frames);
    expect(after.progressive, JSON.stringify(after)).toBeGreaterThanOrEqual(after.frames * 0.75);
    expect((await streamOf(result.file)).field_order ?? 'progressive').toBe('progressive');
    expect(filterOf(result.args).split(',')[0]).toBe('bwdif=mode=send_frame:parity=auto:deint=interlaced');
    expect(result.args).not.toContain('-fps_mode:v:0');
    correctnessReport.push(`interlaced: idet source ${JSON.stringify(before)} → output ${JSON.stringify(after)}`);
  }, 120_000);
});
