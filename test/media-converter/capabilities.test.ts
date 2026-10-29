import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITY_POLICY, MediaCapabilities, NVENC_MIN_FRAME, REQUIRED_SOFTWARE, SILENT_SUBSTITUTION, argumentsDigest, capabilityCandidates, classifyEncoderFailure,
  expectedStream, gpuKeyOf, keyHasDrivers, missingSoftware, parseEncoderList, parseFilterList, parseMuxerList, probeEncodeArgs, probeVerifyArgs,
  readStreamFacts, resolveEncoders, type CapabilityClock, type CapabilityRuntime, type EncodedStreamFacts, type MediaCapabilitiesOptions,
} from '../../electron/main/media-converter/engine/capabilities';
import { MediaRuntime, MediaRuntimeError, type MediaRunLimits, type MediaRunResult, type MediaTools } from '../../electron/main/media-converter/engine/runtime';
import { probeArgs } from '../../electron/main/media-converter/plan/args';
import { buildPlan } from '../../electron/main/media-converter/plan/stream-plan';
import { PROBE_PICTURE } from '../../electron/main/media-converter/plan/video';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import {
  VIDEO_ENCODERS, defaultCompressSettings, engineStatusSchema, mediaInfoSchema, resolvedEncodersSchema, type EngineStatus, type VariantKey, type VideoEncoderId,
} from '../../src/media-converter/contract';

/**
 * The encoder capability detection (T-ENGINE-03, module-engine design §3). Most of it runs against
 * a scripted runtime and a manual clock, answering each test encode with the stderr this machine
 * really printed (fixtures/capabilities, redacted; the `synthetic-*` ones are built from ffmpeg's
 * own messages for cases this machine cannot produce: an old NVIDIA driver, the session limit, no
 * CUDA, no MFT). The last block runs the real detection with the bundled ffmpeg (skipped when the
 * runtime is not staged); every encode is three frames at 1280×720, below normal priority.
 */

const FIXTURES = path.join(process.cwd(), 'test', 'media-converter', 'fixtures', 'capabilities');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const LISTS: Record<string, string> = { '-encoders': fixture('encoders.txt'), '-muxers': fixture('muxers.txt'), '-filters': fixture('filters.txt') };
/** ffmpeg's exit codes on Windows: AVERROR(EINVAL) and AVERROR_EXTERNAL as unsigned. */
const EXIT_EINVAL = 4294967274, EXIT_EXTERNAL = 3752568763, EXIT_QSV = 2981409195;
const VERSION = 'n8.1.2-21-gce3c09c101-20260630';
const GPU = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2705, driverVersion: '32.0.15.8180', driverVendor: 'NVIDIA' }] };

const keyOf = (encoder: string, variant: string) => `${encoder}:${variant}`;
const ALL_KEYS = capabilityCandidates().map(entry => keyOf(entry.encoder, entry.variant));

// ── Harness ────────────────────────────────────────────────────────────────────────────────────

interface Answer {
  exitCode?: number;
  stderr?: string;
  /** What ffprobe reads back; the configuration's expectation when absent, no stream for null. */
  facts?: EncodedStreamFacts | null;
  /** Milliseconds the encode takes on the manual clock; one longer than the run's timeout times out. */
  takesMs?: number;
  /** The encode never ends by itself: it waits for the run's signal. */
  hangs?: boolean;
}
type Behaviour = (encoder: VideoEncoderId, variant: VariantKey) => Answer;

/** This machine (RTX 4070 Ti SUPER, no Intel or AMD graphics), with the stderr it printed. */
const THIS_MACHINE: Behaviour = (encoder, variant) => {
  if (encoder.endsWith('_qsv')) return { exitCode: EXIT_QSV, stderr: fixture('stderr-qsv-no-device.txt') };
  if (encoder.endsWith('_amf')) return { exitCode: EXIT_QSV, stderr: fixture('stderr-amf-runtime-missing.txt') };
  if (encoder === 'hevc_mf' && variant === '10bit') return { stderr: fixture('stderr-hevc-mf-p010le.txt'), facts: { codec: 'hevc', pixFmt: 'yuv420p', profile: 'Main' } };
  return {};
};

const result = (over: Partial<MediaRunResult>): MediaRunResult => ({
  status: 'closed', spawned: true, exitCode: 0, signalCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), aborted: false, timedOut: false,
  outputExceeded: false, closeConfirmed: Promise.resolve(), ...over,
});

/** The configuration a test encode is for, read from its arguments. */
function identify(args: readonly string[]): { encoder: VideoEncoderId; variant: VariantKey } {
  const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const encoder = value('-c:v:0') as VideoEncoderId;
  const tenBit = value('-pix_fmt:v:0') === 'p010le';
  const uhq = value('-tune:v:0') === 'uhq';
  const software = encoder === 'h264_mf' && !args.includes('-hw_encoding:v:0');
  return { encoder, variant: `${tenBit ? '10bit' : '8bit'}${uhq ? '_uhq' : software ? '_sw' : ''}` as VariantKey };
}

/** Each harness is a later start of the app: an hour after the previous one. */
let starts = 0;
function manualClock(start = Date.UTC(2026, 9, 28, 9) + 3_600_000 * starts++) {
  let wall = start, mono = 1_000;
  const waits: { ms: number; resolve: () => void }[] = [];
  const clock: CapabilityClock & { advance(ms: number): void; setWall(ms: number): void; waits: typeof waits } = {
    now: () => wall,
    monotonic: () => mono,
    delay: (ms, signal) => new Promise<void>(resolve => {
      const entry = { ms, resolve: () => { mono += ms; wall += ms; resolve(); } };
      waits.push(entry);
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
    advance(ms) { mono += ms; wall += ms; },
    setWall(ms) { wall = ms; },
    waits,
  };
  return clock;
}

interface Call { tool: 'ffmpeg' | 'ffprobe'; args: string[]; limits: MediaRunLimits }

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fk-media-caps-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function harness(behaviour: Behaviour = THIS_MACHINE, options: Partial<MediaCapabilitiesOptions> & { tools?: Partial<MediaTools>; lists?: Record<string, string> } = {}) {
  const clock = manualClock();
  const calls: Call[] = [];
  const logs: string[] = [];
  const tools: MediaTools = {
    ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: VERSION, generation: 'a'.repeat(64), environment: {}, workingDirectory: path.join(root, 'work'), ...options.tools,
  };
  const lists = options.lists ?? LISTS;
  let last: Answer = {};
  let lastConfiguration = { encoder: 'h264_nvenc' as VideoEncoderId, variant: '8bit' as VariantKey };
  const runtime: CapabilityRuntime & { acquired: number } = {
    acquired: 0,
    async acquire() { runtime.acquired++; return tools; },
    status: () => ({ state: 'ready', version: tools.version }),
    async run(tool, args, limits) {
      calls.push({ tool, args: [...args], limits });
      if (tool === 'ffmpeg' && lists[args.at(-1)!] !== undefined) return result({ stdout: Buffer.from(lists[args.at(-1)!]) });
      if (tool === 'ffmpeg') {
        lastConfiguration = identify(args);
        last = behaviour(lastConfiguration.encoder, lastConfiguration.variant);
        if (last.hangs) {
          return new Promise(resolve => limits.signal?.addEventListener('abort', () => resolve(result({ exitCode: null, aborted: true })), { once: true }));
        }
        const takes = last.takesMs ?? 300;
        if (takes > limits.timeoutMs) { clock.advance(limits.timeoutMs); return result({ exitCode: null, timedOut: true }); }
        clock.advance(takes);
        return result({ exitCode: last.exitCode ?? 0, stderr: Buffer.from(last.stderr ?? '') });
      }
      clock.advance(40);
      const facts = last.facts === undefined ? expectedStream(lastConfiguration.encoder, lastConfiguration.variant) : last.facts;
      const streams = facts ? [{ codec_name: facts.codec, profile: facts.profile, pix_fmt: facts.pixFmt }] : [];
      return result({ stdout: Buffer.from(JSON.stringify({ programs: [], stream_groups: [], streams })) });
    },
  };
  const caps = new MediaCapabilities({ runtime, root, gpuInfo: async () => GPU, isHardwareEncodeRunning: () => false, clock, log: message => { logs.push(message); }, ...options });
  const encodes = () => calls.filter(call => call.tool === 'ffmpeg' && lists[call.args.at(-1)!] === undefined);
  return { caps, runtime, calls, encodes, clock, logs, tools };
}

const outcomes = (caps: MediaCapabilities) => Object.fromEntries((caps.report()?.results ?? []).map(entry => [keyOf(entry.encoder, entry.variant), entry.outcome]));
const sources = (caps: MediaCapabilities) => Object.fromEntries((caps.report()?.results ?? []).map(entry => [keyOf(entry.encoder, entry.variant), entry.source]));
const capabilitiesFile = async () => JSON.parse(await readFile(path.join(root, 'capabilities.json'), 'utf8'));

async function ready(caps: MediaCapabilities) {
  const answer = await caps.planner();
  if (!answer.ok) throw new Error(`detection failed: ${answer.code}`);
  return answer.capabilities;
}

/** What this machine is expected to report (V-ENGINE-03-2). */
const THIS_MACHINE_OUTCOMES: Record<string, string> = {
  'h264_nvenc:8bit': 'available',
  'hevc_nvenc:10bit_uhq': 'available', 'hevc_nvenc:10bit': 'available', 'hevc_nvenc:8bit_uhq': 'available', 'hevc_nvenc:8bit': 'available',
  'av1_nvenc:10bit_uhq': 'available', 'av1_nvenc:10bit': 'available',
  'h264_qsv:8bit': 'no_device', 'hevc_qsv:10bit': 'no_device', 'hevc_qsv:8bit': 'no_device', 'av1_qsv:10bit': 'no_device',
  'h264_amf:8bit': 'runtime_missing', 'hevc_amf:10bit': 'runtime_missing', 'hevc_amf:8bit': 'runtime_missing', 'av1_amf:10bit': 'runtime_missing',
  'h264_mf:8bit': 'available', 'hevc_mf:8bit': 'available', 'hevc_mf:10bit': 'params_rejected', 'h264_mf:8bit_sw': 'available',
};

// ── Software capabilities ──────────────────────────────────────────────────────────────────────

describe('the software capabilities (-encoders, -muxers, -filters)', () => {
  it('reads the names of the bundled ffmpeg lists, never the legend above them', () => {
    const encoders = parseEncoderList(LISTS['-encoders']);
    for (const name of ['libsvtav1', 'libkvazaar', 'libopenh264', 'h264_nvenc', 'hevc_qsv', 'av1_amf', 'h264_mf', 'hevc_mf', 'aac', 'libopus', 'subrip', 'mov_text',
      'h264_d3d12va', 'hevc_vulkan', 'av1_mf', 'h264_vaapi']) expect(encoders.has(name), name).toBe(true);
    expect([...encoders].some(name => /^[=-]|^[A-Z]/.test(name))).toBe(false);
    expect(encoders.size).toBeGreaterThan(200);

    const muxers = parseMuxerList(LISTS['-muxers']);
    for (const name of ['matroska', 'webm', 'mp4', 'mov', 'ipod', 'mp3', 'opus', 'ogg', 'flac', 'wav', 'aiff']) expect(muxers.has(name), name).toBe(true);
    expect(muxers.has('Formats:')).toBe(false);
    expect(muxers.size).toBeGreaterThan(150);

    const filters = parseFilterList(LISTS['-filters']);
    for (const name of REQUIRED_SOFTWARE.filters) expect(filters.has(name), name).toBe(true);
    expect([...filters].some(name => name === '=' || name.includes('.'))).toBe(false);
    expect(filters.size).toBeGreaterThan(500);
  });

  it('finds nothing missing in the bundled runtime, and names what a broken one lacks', () => {
    const software = { encoders: parseEncoderList(LISTS['-encoders']), muxers: parseMuxerList(LISTS['-muxers']), filters: parseFilterList(LISTS['-filters']) };
    expect(missingSoftware(software)).toEqual([]);
    expect(REQUIRED_SOFTWARE.muxers).toEqual(expect.arrayContaining(['mp4', 'mov', 'matroska', 'webm', 'mp3', 'ipod', 'opus', 'ogg', 'flac', 'wav', 'aiff']));
    expect(REQUIRED_SOFTWARE.encoders).toContain('subrip');
    const broken = { ...software, filters: new Set([...software.filters].filter(name => name !== 'zscale')), muxers: new Set([...software.muxers].filter(name => name !== 'webm')) };
    expect(missingSoftware(broken)).toEqual(['muxer:webm', 'filter:zscale']);
  });

  it('refuses a runtime that lacks what the plans need, without a single test encode', async () => {
    const lists = { ...LISTS, '-filters': LISTS['-filters'].split('\n').filter(line => !/^\s*\S\S zscale /.test(line)).join('\n') };
    const h = harness(THIS_MACHINE, { lists });
    expect(await h.caps.planner()).toEqual({ ok: false, code: 'runtime_invalid' });
    expect(h.encodes()).toEqual([]);
    expect(h.logs.join('\n')).toContain('filter:zscale');
  });

  it('reports a listing that does not finish as unknown and one that fails as an invalid runtime', async () => {
    const slow = harness();
    const run = slow.runtime.run;
    slow.runtime.run = async (tool, args, limits) => args.at(-1) === '-muxers' ? result({ exitCode: null, timedOut: true }) : run(tool, args, limits);
    expect(await slow.caps.planner()).toEqual({ ok: false, code: 'unknown' });

    const failing = harness();
    const original = failing.runtime.run;
    failing.runtime.run = async (tool, args, limits) => args.at(-1) === '-encoders' ? result({ exitCode: 1 }) : original(tool, args, limits);
    expect(await failing.caps.planner()).toEqual({ ok: false, code: 'runtime_invalid' });
  });
});

// ── Classification ─────────────────────────────────────────────────────────────────────────────

describe('stderr classification', () => {
  it('names the category of every failure this machine printed', () => {
    const measured: Record<string, string> = {
      'stderr-qsv-no-device.txt': 'no_device',
      'stderr-amf-runtime-missing.txt': 'runtime_missing',
      'stderr-hevc-nvenc-uhq-bf3.txt': 'params_rejected',
      'stderr-hevc-mf-p010le.txt': 'params_rejected',
      'stderr-nvenc-hevc-below-minimum.txt': 'params_rejected',
      'stderr-nvenc-h264-below-minimum.txt': 'params_rejected',
      'stderr-nvenc-width-exceeds.txt': 'params_rejected',
      'stderr-d3d12va.txt': 'params_rejected',
      'stderr-vulkan.txt': 'unknown',
      'stderr-nvenc-bad-tune.txt': 'params_rejected',
      'stderr-unrecognized-option.txt': 'params_rejected',
      'stderr-mf-named-profile.txt': 'params_rejected',
    };
    for (const [name, code] of Object.entries(measured)) expect(classifyEncoderFailure(fixture(name)).code, name).toBe(code);
  });

  it('takes a size refusal for a parameter, before the "No capable devices found" NVENC prints with it (design §7b)', () => {
    const stderr = fixture('stderr-nvenc-width-exceeds.txt');
    expect(stderr).toContain('No capable devices found');
    expect(classifyEncoderFailure(stderr)).toEqual({ code: 'params_rejected', line: expect.stringContaining('Width 4112 exceeds 4096'), minimumDriver: null });
    expect(classifyEncoderFailure(fixture('stderr-nvenc-hevc-below-minimum.txt')).line).toContain('Frame dimensions are less than the minimum');
    expect(classifyEncoderFailure(fixture('stderr-nvenc-h264-below-minimum.txt')).line).toContain('Frame Dimension less than the minimum');
    // Without a size message the same line means no device.
    expect(classifyEncoderFailure('[h264_nvenc @ 0] [fatal] No capable devices found\n').code).toBe('no_device');
  });

  it('names an old driver with the version NVENC needs, the session limit before "No capable devices", and missing runtimes', () => {
    expect(classifyEncoderFailure(fixture('synthetic-nvenc-driver-too-old.txt'))).toMatchObject({ code: 'driver_too_old', minimumDriver: '570.0' });
    expect(classifyEncoderFailure(fixture('synthetic-nvenc-driver-too-old-unnamed.txt'))).toMatchObject({ code: 'driver_too_old', minimumDriver: CAPABILITY_POLICY.nvencMinimumDriver });
    expect(classifyEncoderFailure('[h264_nvenc] [error] The minimum required Nvidia driver for nvenc is 580.65 or newer\n').minimumDriver).toBe('580.65');
    expect(classifyEncoderFailure(fixture('synthetic-nvenc-session-limit.txt')).code).toBe('session_limit');
    expect(classifyEncoderFailure(fixture('synthetic-nvenc-client-key.txt')).code).toBe('session_limit');
    expect(classifyEncoderFailure(fixture('synthetic-nvenc-no-cuda.txt')).code).toBe('runtime_missing');
    expect(classifyEncoderFailure(fixture('synthetic-cuda-no-device.txt')).code).toBe('no_device');
    expect(classifyEncoderFailure(fixture('synthetic-mf-no-mft.txt')).code).toBe('runtime_missing');
    expect(classifyEncoderFailure('[hevc_nvenc] [error] something nobody has seen\n')).toEqual({ code: 'unknown', line: null, minimumDriver: null });
    expect(classifyEncoderFailure('')).toEqual({ code: 'unknown', line: null, minimumDriver: null });
  });

  it('never keeps a CUDA failure that passes as no_device, although NVENC prints "No capable devices found" after it', () => {
    // A game holding the card: the CUDA context runs out of memory, like a full session table.
    const outOfMemory = fixture('synthetic-cuda-out-of-memory.txt');
    expect(outOfMemory).toContain('No capable devices found');
    expect(classifyEncoderFailure(outOfMemory)).toMatchObject({ code: 'session_limit', line: expect.stringContaining('CUDA_ERROR_OUT_OF_MEMORY') });
    // Any other failed CUDA call is not known to last: unknown, with the line that says so.
    const other = '[h264_nvenc @ 0] [error] dl_fn->cuda_dl->cuCtxCreate(&ctx->cu_context_internal, 0, cu_device) failed -> CUDA_ERROR_UNKNOWN: unknown error\n'
      + '[h264_nvenc @ 0] [fatal] No capable devices found\n';
    expect(classifyEncoderFailure(other)).toEqual({ code: 'unknown', line: expect.stringContaining('CUDA_ERROR_UNKNOWN'), minimumDriver: null });
    // No CUDA device at all stays definitive, in either of NVENC's words.
    expect(classifyEncoderFailure(fixture('synthetic-cuda-no-device.txt')).code).toBe('no_device');
    expect(classifyEncoderFailure('[hevc_nvenc @ 0] [fatal] No CUDA capable devices found\n').code).toBe('no_device');
    // NVENC refusing a production option it does not support is a parameter, like an invalid one.
    expect(classifyEncoderFailure('[hevc_nvenc @ 0] [error] InitializeEncoder failed: unsupported param (12): \n').code).toBe('params_rejected');
  });

  it('treats a silent substitution as a failure even when ffmpeg exits 0', () => {
    for (const text of ["Incompatible pixel format 'p010le' for codec 'hevc_mf', auto-selecting format 'nv12'", 'Invalid option preset=x', 'Error parsing option lp']) {
      expect(SILENT_SUBSTITUTION.test(text), text).toBe(true);
      expect(classifyEncoderFailure(text).code, text).toBe('params_rejected');
    }
    expect(SILENT_SUBSTITUTION.test("[warning] Guessed Channel Layout: stereo")).toBe(false);
  });
});

// ── Candidates ─────────────────────────────────────────────────────────────────────────────────

describe('the candidates', () => {
  it('are every NVENC, QSV and AMF configuration of the planner, then Media Foundation, in the order of design §3', () => {
    expect(ALL_KEYS).toEqual([
      'h264_nvenc:8bit', 'hevc_nvenc:10bit_uhq', 'hevc_nvenc:10bit', 'hevc_nvenc:8bit_uhq', 'hevc_nvenc:8bit', 'av1_nvenc:10bit_uhq', 'av1_nvenc:10bit',
      'h264_qsv:8bit', 'hevc_qsv:10bit', 'hevc_qsv:8bit', 'av1_qsv:10bit', 'h264_amf:8bit', 'hevc_amf:10bit', 'hevc_amf:8bit', 'av1_amf:10bit',
      'h264_mf:8bit', 'hevc_mf:8bit', 'hevc_mf:10bit', 'h264_mf:8bit_sw',
    ]);
  });

  it('use exactly the production arguments; only the hevc_mf 10-bit check changes nv12 to p010le', () => {
    for (const entry of capabilityCandidates()) {
      if (entry.guard) continue;
      expect(entry.args, keyOf(entry.encoder, entry.variant)).toEqual(probeArgs(entry.encoder, entry.variant));
    }
    const guard = capabilityCandidates().filter(entry => entry.guard);
    expect(guard.map(entry => keyOf(entry.encoder, entry.variant))).toEqual(['hevc_mf:10bit']);
    const base = probeArgs('hevc_mf', '8bit');
    const changed = guard[0].args.flatMap((value, index) => value === base[index] ? [] : [[base[index], value]]);
    expect(changed).toEqual([['nv12', 'p010le'], [base[base.indexOf('-filter:v:0') + 1], base[base.indexOf('-filter:v:0') + 1].replace('format=nv12', 'format=p010le')]]);
  });

  it('never include *_d3d12va, *_vulkan, *_vaapi or av1_mf, although -encoders lists them (AC-ENGINE-03-4)', async () => {
    const listed = parseEncoderList(LISTS['-encoders']);
    const others = [...listed].filter(name => /_(?:d3d12va|vulkan|vaapi)$|^av1_mf$/.test(name));
    expect(others).toEqual(expect.arrayContaining(['h264_d3d12va', 'hevc_d3d12va', 'av1_d3d12va', 'h264_vulkan', 'hevc_vulkan', 'av1_vulkan', 'av1_mf']));
    for (const entry of capabilityCandidates()) {
      expect(entry.encoder).toMatch(/^(?:h264|hevc|av1)_(?:nvenc|qsv|amf|mf)$/);
      expect(VIDEO_ENCODERS).toContain(entry.encoder);
    }
    const h = harness();
    await ready(h.caps);
    expect(h.encodes().filter(call => call.args.some(arg => /d3d12va|vulkan|vaapi|av1_mf/.test(arg)))).toEqual([]);
  });

  it('encode three frames of the lavfi probe picture at level+warning into Matroska, and read them back with the demuxer pinned', () => {
    const args = probeEncodeArgs({ args: ['-c:v:0', 'h264_nvenc'] }, 'C:\\work\\probe.mkv');
    expect(args).toEqual(['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning', '-f', 'lavfi', '-i',
      `color=black:s=${PROBE_PICTURE.width}x${PROBE_PICTURE.height}:r=${PROBE_PICTURE.fps}`, '-frames:v', '3', '-c:v:0', 'h264_nvenc', '-f', 'matroska', '-y', 'file:C:\\work\\probe.mkv']);
    expect(PROBE_PICTURE).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(probeVerifyArgs('C:\\work\\probe.mkv')).toEqual(['-hide_banner', '-v', 'error', '-f', 'matroska', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,profile', '-of', 'json', 'file:C:\\work\\probe.mkv']);
  });

  it('expect what the decoder reports for each configuration', () => {
    expect(expectedStream('h264_nvenc', '8bit')).toEqual({ codec: 'h264', pixFmt: 'yuv420p', profile: 'High' });
    expect(expectedStream('h264_mf', '8bit_sw')).toEqual({ codec: 'h264', pixFmt: 'yuv420p', profile: 'High' });
    expect(expectedStream('hevc_nvenc', '10bit_uhq')).toEqual({ codec: 'hevc', pixFmt: 'yuv420p10le', profile: 'Main 10' });
    expect(expectedStream('hevc_qsv', '8bit')).toEqual({ codec: 'hevc', pixFmt: 'yuv420p', profile: 'Main' });
    expect(expectedStream('av1_amf', '10bit')).toEqual({ codec: 'av1', pixFmt: 'yuv420p10le', profile: 'Main' });
    expect(readStreamFacts('{"programs":[],"streams":[{"codec_name":"hevc","profile":"Main 10","pix_fmt":"yuv420p10le"}]}')).toEqual({ codec: 'hevc', pixFmt: 'yuv420p10le', profile: 'Main 10' });
    expect(readStreamFacts('{"streams":[]}')).toBeNull();
    expect(readStreamFacts('not json')).toBeNull();
  });
});

// ── Detection ──────────────────────────────────────────────────────────────────────────────────

describe('the detection', () => {
  it('tests every configuration once, serially, with its production arguments, and builds the planner table', async () => {
    const h = harness();
    const caps = await ready(h.caps);
    expect(outcomes(h.caps)).toEqual(THIS_MACHINE_OUTCOMES);
    expect(new Set(Object.values(sources(h.caps)))).toEqual(new Set(['measured']));

    // One encode per configuration, each followed by its ffprobe check when it finished; never two at once (the fake would interleave otherwise).
    const encodes = h.encodes();
    expect(encodes.map(call => keyOf(identify(call.args).encoder, identify(call.args).variant))).toEqual(ALL_KEYS);
    for (const [index, entry] of capabilityCandidates().entries()) {
      const output = encodes[index].args.at(-1)!.slice('file:'.length);
      expect(encodes[index].args).toEqual(probeEncodeArgs(entry, output));
      expect(path.dirname(output)).toMatch(/[\\/]work[\\/]capabilities-[0-9a-f]{8}$/);
      expect(encodes[index].limits.timeoutMs).toBeLessThanOrEqual(CAPABILITY_POLICY.probeTimeoutMs);
    }
    // Only an encode that finished cleanly is read back: not the refused ones, nor hevc_mf 10-bit with its auto-selected format.
    const checks = h.calls.filter(call => call.tool === 'ffprobe');
    expect(checks).toHaveLength(Object.values(THIS_MACHINE_OUTCOMES).filter(outcome => outcome === 'available').length);
    for (const check of checks) {
      const encode = h.calls[h.calls.indexOf(check) - 1];
      expect(encode.tool).toBe('ffmpeg');
      expect(check.args).toEqual(probeVerifyArgs(encode.args.at(-1)!.slice('file:'.length)));
    }
    // The scratch folder is gone.
    expect(await readdir(path.join(root, 'work'))).toEqual([]);

    expect(caps.nvencMin).toEqual(NVENC_MIN_FRAME);
    expect(caps.nvencMin).toEqual({ width: 129, height: 33 });
    expect(caps.degraded).toEqual([]);
    expect(caps.encoders.hevc_nvenc).toEqual({ variants: { '10bit_uhq': true, '10bit': true, '8bit_uhq': true, '8bit': true }, uhq: true });
    expect(caps.encoders.av1_nvenc).toEqual({ variants: { '10bit_uhq': true, '10bit': true }, uhq: true });
    expect(caps.encoders.h264_nvenc).toEqual({ variants: { '8bit': true } });
    expect(caps.encoders.hevc_qsv).toEqual({ variants: { '10bit': false, '8bit': false } });
    expect(caps.encoders.av1_amf).toEqual({ variants: { '10bit': false } });
    expect(caps.encoders.hevc_mf).toEqual({ variants: { '8bit': true, '10bit': false } });
    expect(caps.encoders.h264_mf).toEqual({ variants: { '8bit': true, '8bit_sw': true } });
    expect(caps.encoders.libsvtav1).toEqual({ variants: { '10bit': true } });
    expect(caps.encoders.libkvazaar).toEqual({ variants: { '8bit': true } });
    expect(caps.encoders.libopenh264).toEqual({ variants: { '8bit': true } });

    const status = engineStatusSchema.parse(h.caps.status());
    expect(status.capabilities).toEqual({
      state: 'ready',
      hardwareEncoders: ['av1_nvenc', 'hevc_nvenc', 'hevc_mf', 'h264_nvenc', 'h264_mf'],
      degraded: [],
      driverUpdates: [],
      resolvedEncoders: {
        av1: {
          gpuOff: { encoder: 'libsvtav1', variant: '10bit', hardware: false, weak: false, nameKey: 'media:encoders.libsvtav1' },
          gpuOn: { encoder: 'av1_nvenc', variant: '10bit_uhq', hardware: true, weak: false, nameKey: 'media:encoders.av1_nvenc' },
        },
        hevc: {
          gpuOff: { encoder: 'hevc_nvenc', variant: '10bit_uhq', hardware: true, weak: false, nameKey: 'media:encoders.hevc_nvenc' },
          gpuOn: { encoder: 'hevc_nvenc', variant: '10bit_uhq', hardware: true, weak: false, nameKey: 'media:encoders.hevc_nvenc' },
        },
        h264: {
          gpuOff: { encoder: 'h264_nvenc', variant: '8bit', hardware: true, weak: false, nameKey: 'media:encoders.h264_nvenc' },
          gpuOn: { encoder: 'h264_nvenc', variant: '8bit', hardware: true, weak: false, nameKey: 'media:encoders.h264_nvenc' },
        },
      },
      defaults: { compressCodec: 'hevc' },
    });
    expect(h.caps.defaults()).toEqual({ compressCodec: 'hevc' });
    expect(resolvedEncodersSchema.parse(h.caps.resolvedEncoders())).toEqual(status.capabilities.state === 'ready' && status.capabilities.resolvedEncoders);
  });

  it('gives the planner a table it plans with: uhq NVENC HEVC Main10 for a 1080p source', async () => {
    const h = harness();
    const caps = await ready(h.caps);
    const media = mediaInfoSchema.parse(sampleMedia());
    const outcome = buildPlan(media, defaultCompressSettings(h.caps.defaults().compressCodec), caps);
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.plan.summary.encoders).toContainEqual({ encoder: 'hevc_nvenc', variant: '10bit_uhq' });
    // With NVENC degraded the same table plans the next encoder of the chain.
    h.caps.markDegraded('hevc_nvenc');
    const fallback = buildPlan(media, defaultCompressSettings('hevc'), await ready(h.caps));
    expect(fallback.status === 'ready' && fallback.plan.summary.encoders).toContainEqual({ encoder: 'hevc_mf', variant: '8bit' });
  });

  it('fails a configuration whose stderr says auto-selecting format even at exit 0, and one whose output is not what was asked', async () => {
    const h = harness((encoder, variant) => {
      if (encoder === 'h264_mf' && variant === '8bit') return { facts: { codec: 'h264', pixFmt: 'yuv420p', profile: 'Constrained Baseline' } };
      if (encoder === 'hevc_nvenc' && variant === '10bit') return { facts: { codec: 'hevc', pixFmt: 'yuv420p', profile: 'Main' } };
      if (encoder === 'av1_nvenc' && variant === '10bit') return { facts: null };
      return THIS_MACHINE(encoder, variant);
    });
    await ready(h.caps);
    const results = Object.fromEntries(h.caps.report()!.results.map(entry => [keyOf(entry.encoder, entry.variant), entry]));
    expect(results['hevc_mf:10bit']).toMatchObject({ outcome: 'params_rejected', source: 'measured', detail: expect.stringContaining('auto-selecting format') });
    expect(results['h264_mf:8bit']).toMatchObject({ outcome: 'params_rejected', detail: 'wrote h264/yuv420p/Constrained Baseline, expected h264/yuv420p/High' });
    expect(results['hevc_nvenc:10bit']).toMatchObject({ outcome: 'params_rejected', detail: 'wrote hevc/yuv420p/Main, expected hevc/yuv420p10le/Main 10' });
    // An output ffprobe cannot read says nothing definite.
    expect(results['av1_nvenc:10bit']).toMatchObject({ outcome: 'unknown' });
    const file = await capabilitiesFile();
    expect(file.results['h264_mf:8bit'].outcome).toBe('params_rejected');
    expect(file.results['av1_nvenc:10bit']).toBeUndefined();
  });

  it('keeps only definitive verdicts: session_limit, unknown and timeouts are measured again at the next start', async () => {
    const flaky: Behaviour = (encoder, variant) => {
      if (encoder === 'hevc_nvenc' && variant === '8bit') return { exitCode: EXIT_EXTERNAL, stderr: fixture('synthetic-nvenc-session-limit.txt') };
      if (encoder === 'hevc_nvenc' && variant === '8bit_uhq') return { exitCode: EXIT_EXTERNAL, stderr: fixture('synthetic-cuda-out-of-memory.txt') };
      if (encoder === 'av1_nvenc' && variant === '10bit') return { takesMs: 20_000 };
      if (encoder === 'h264_qsv') return { exitCode: EXIT_EINVAL, stderr: 'something nobody has seen\n' };
      return THIS_MACHINE(encoder, variant);
    };
    const first = harness(flaky);
    const caps = await ready(first.caps);
    expect(outcomes(first.caps)).toMatchObject({ 'hevc_nvenc:8bit': 'session_limit', 'hevc_nvenc:8bit_uhq': 'session_limit', 'av1_nvenc:10bit': 'unknown', 'h264_qsv:8bit': 'unknown' });
    expect(caps.encoders.hevc_nvenc?.variants['8bit']).toBe(false);
    const transient = ['hevc_nvenc:8bit_uhq', 'hevc_nvenc:8bit', 'av1_nvenc:10bit', 'h264_qsv:8bit'];
    const file = await capabilitiesFile();
    expect(Object.keys(file.results).sort()).toEqual(ALL_KEYS.filter(key => !transient.includes(key)).sort());
    for (const entry of Object.values(file.results) as { outcome: string; args: string }[]) {
      expect(['available', 'driver_too_old', 'no_device', 'runtime_missing', 'params_rejected']).toContain(entry.outcome);
      expect(entry.args).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(file.key).toEqual({ ffmpeg: VERSION, generation: 'a'.repeat(64), gpus: [{ vendorId: 0x10de, deviceId: 0x2705, driverVersion: '32.0.15.8180' }] });

    // Next start, same runtime and card: only those four are tested again; the machine is fine now.
    const second = harness();
    await ready(second.caps);
    expect(second.encodes().map(call => keyOf(identify(call.args).encoder, identify(call.args).variant))).toEqual(transient);
    expect(outcomes(second.caps)).toEqual(THIS_MACHINE_OUTCOMES);
    expect(Object.keys((await capabilitiesFile()).results).sort()).toEqual([...ALL_KEYS].sort());
  });

  it('reuses kept verdicts while the key stays the same, and measures again when the runtime, card or driver changes', async () => {
    await ready(harness().caps);
    const written = await readFile(path.join(root, 'capabilities.json'), 'utf8');

    const same = harness();
    const table = await ready(same.caps);
    expect(same.encodes()).toEqual([]);
    expect(new Set(Object.values(sources(same.caps)))).toEqual(new Set(['cached']));
    expect(outcomes(same.caps)).toEqual(THIS_MACHINE_OUTCOMES);
    expect(table.encoders.hevc_nvenc?.uhq).toBe(true);
    expect(same.caps.report()?.persisted).toBe(false);
    expect(await readFile(path.join(root, 'capabilities.json'), 'utf8')).toBe(written);

    const newDriver = async () => ({ gpuDevice: [{ ...GPU.gpuDevice[0], driverVersion: '32.0.15.9100' }] });
    const otherCard = async () => ({ gpuDevice: [{ ...GPU.gpuDevice[0], driverVersion: '32.0.15.9100', deviceId: 0x2782 }] });
    const steps: [string, Parameters<typeof harness>[1]][] = [
      ['driver', { gpuInfo: newDriver }],
      ['card', { gpuInfo: otherCard }],
      ['ffmpeg version', { gpuInfo: otherCard, tools: { version: 'n8.2' } }],
      ['runtime generation', { gpuInfo: otherCard, tools: { version: 'n8.2', generation: 'b'.repeat(64) } }],
    ];
    for (const [change, options] of steps) {
      const changed = harness(THIS_MACHINE, options);
      await ready(changed.caps);
      expect(changed.encodes(), change).toHaveLength(ALL_KEYS.length);
    }
    // With all of that unchanged once more: nothing.
    const again = harness(THIS_MACHINE, steps.at(-1)![1]);
    await ready(again.caps);
    expect(again.encodes()).toEqual([]);
  });

  it('measures a configuration again when its production arguments changed since it was kept', async () => {
    await ready(harness().caps);
    const file = await capabilitiesFile();
    expect(file.results['hevc_nvenc:10bit_uhq'].args).toBe(argumentsDigest(probeArgs('hevc_nvenc', '10bit_uhq')));
    file.results['hevc_nvenc:10bit_uhq'].args = argumentsDigest(['-c:v:0', 'hevc_nvenc', '-bf:v:0', '3']);
    await writeFile(path.join(root, 'capabilities.json'), JSON.stringify(file));
    const next = harness();
    await ready(next.caps);
    expect(next.encodes().map(call => keyOf(identify(call.args).encoder, identify(call.args).variant))).toEqual(['hevc_nvenc:10bit_uhq']);
  });

  it('without driver versions in the key, keeps a verdict for a week', async () => {
    expect(keyHasDrivers({ ffmpeg: VERSION, generation: 'a', gpus: gpuKeyOf(GPU) })).toBe(true);
    for (const gpuInfo of [async () => null, async () => ({ gpuDevice: [{ vendorId: 0x10de, deviceId: 0x2705 }] }), async () => { throw new Error('no GPU process'); }]) {
      await rm(path.join(root, 'capabilities.json'), { force: true });
      const first = harness(THIS_MACHINE, { gpuInfo });
      await ready(first.caps);
      expect(first.encodes()).toHaveLength(ALL_KEYS.length);
      const measuredAt = first.clock.now();

      const sixDays = harness(THIS_MACHINE, { gpuInfo });
      sixDays.clock.setWall(measuredAt + 6 * 24 * 3600_000);
      await ready(sixDays.caps);
      expect(sixDays.encodes()).toEqual([]);

      const eightDays = harness(THIS_MACHINE, { gpuInfo });
      eightDays.clock.setWall(measuredAt + 8 * 24 * 3600_000);
      await ready(eightDays.caps);
      expect(eightDays.encodes()).toHaveLength(ALL_KEYS.length);
    }
  });

  it('reads the cards and drivers of Electron\'s basic GPU info', () => {
    expect(gpuKeyOf({ gpuDevice: [{ vendorId: 0x8086, deviceId: 0xa780, driverVersion: '31.0.101.5186', active: false }, GPU.gpuDevice[0], GPU.gpuDevice[0]] }))
      .toEqual([{ vendorId: 0x10de, deviceId: 0x2705, driverVersion: '32.0.15.8180' }, { vendorId: 0x8086, deviceId: 0xa780, driverVersion: '31.0.101.5186' }]);
    expect(gpuKeyOf({ gpuDevice: [{ vendorId: 4318, deviceId: 9989 }] })).toEqual([{ vendorId: 4318, deviceId: 9989, driverVersion: null }]);
    expect(gpuKeyOf({ gpuDevice: [] })).toBeNull();
    expect(gpuKeyOf({ gpuDevice: [{ vendorId: 'x' }] })).toBeNull();
    expect(gpuKeyOf(null)).toBeNull();
    expect(keyHasDrivers({ ffmpeg: VERSION, generation: 'a', gpus: [{ vendorId: 1, deviceId: 2, driverVersion: null }] })).toBe(false);
    expect(keyHasDrivers({ ffmpeg: VERSION, generation: 'a', gpus: null })).toBe(false);
  });

  it('stops testing after 30 s: the rest are unknown for this session and measured at the next start', async () => {
    const slow: Behaviour = (encoder, variant) => ({ ...THIS_MACHINE(encoder, variant), takesMs: 9_000 });
    const h = harness(slow);
    await ready(h.caps);
    const report = h.caps.report()!;
    const encodes = h.encodes();
    // Each takes 9 s and a 40 ms check. The third may take what is left of the 30 s (11.92 s) and finishes; the fourth gets 2.88 s and does not.
    expect(encodes.map(call => call.limits.timeoutMs)).toEqual([15_000, 15_000, 30_000 - 2 * 9_040, 30_000 - 3 * 9_040]);
    expect(report.results.slice(0, 3).map(entry => [entry.outcome, entry.source])).toEqual([['available', 'measured'], ['available', 'measured'], ['available', 'measured']]);
    expect(report.results[3]).toMatchObject({ outcome: 'unknown', source: 'measured', detail: `no answer within ${30_000 - 3 * 9_040} ms` });
    expect(report.results.slice(4).every(entry => entry.outcome === 'unknown' && entry.source === 'skipped')).toBe(true);
    expect(report.testMs).toBeLessThanOrEqual(CAPABILITY_POLICY.budgetMs);
    expect(Object.keys((await capabilitiesFile()).results)).toEqual(ALL_KEYS.slice(0, 3));
    // Unknown is not available: the planner passes over the configurations the budget did not settle.
    const caps = await ready(h.caps);
    expect(caps.encoders.hevc_nvenc?.variants).toEqual({ '10bit_uhq': true, '10bit': true, '8bit_uhq': false, '8bit': false });

    const next = harness();
    await ready(next.caps);
    expect(next.encodes()).toHaveLength(ALL_KEYS.length - 3);
  });

  it('gives one configuration 15 s, encode and check together', async () => {
    const h = harness((encoder, variant) => encoder === 'h264_nvenc' ? { takesMs: 16_000 } : encoder === 'hevc_nvenc' && variant === '10bit_uhq' ? { takesMs: 12_000 } : THIS_MACHINE(encoder, variant));
    await ready(h.caps);
    expect(outcomes(h.caps)['h264_nvenc:8bit']).toBe('unknown');
    expect(h.caps.report()!.results[0].detail).toBe('no answer within 15000 ms');
    // 12 s encode leaves 3 s for the check, not 5.
    const check = h.calls[h.calls.findIndex(call => call.tool === 'ffmpeg' && identify(call.args).variant === '10bit_uhq' && identify(call.args).encoder === 'hevc_nvenc') + 1];
    expect(check.tool).toBe('ffprobe');
    expect(check.limits.timeoutMs).toBe(3_000);
  });

  it('records an old NVIDIA driver with the version to install (AC-ENGINE-03-4), and keeps it', async () => {
    const old: Behaviour = (encoder, variant) => encoder.endsWith('_nvenc') ? { exitCode: EXIT_EXTERNAL, stderr: fixture('synthetic-nvenc-driver-too-old.txt') } : THIS_MACHINE(encoder, variant);
    const h = harness(old);
    await ready(h.caps);
    expect(Object.entries(outcomes(h.caps)).filter(([key]) => key.includes('_nvenc')).every(([, outcome]) => outcome === 'driver_too_old')).toBe(true);
    const status = engineStatusSchema.parse(h.caps.status()).capabilities;
    expect(status).toMatchObject({ state: 'ready', driverUpdates: [{ family: 'nvenc', minimumVersion: '570.0' }], hardwareEncoders: ['hevc_mf', 'h264_mf'] });
    expect((await capabilitiesFile()).results['h264_nvenc:8bit']).toMatchObject({ outcome: 'driver_too_old', minimumDriver: '570.0' });

    const kept = harness();
    await ready(kept.caps);
    expect(kept.encodes()).toEqual([]);
    expect(kept.caps.status().capabilities).toMatchObject({ driverUpdates: [{ family: 'nvenc', minimumVersion: '570.0' }] });
  });
});

// ── The engine's side ──────────────────────────────────────────────────────────────────────────

describe('status, redetection and degradation', () => {
  it('goes unverified → detecting → ready, telling every change; concurrent askers share one detection', async () => {
    const h = harness();
    const seen: EngineStatus['capabilities']['state'][] = [];
    h.caps.subscribe(() => seen.push(h.caps.status().capabilities.state));
    expect(h.caps.status()).toEqual({ runtime: { state: 'ready', version: VERSION }, capabilities: { state: 'unverified' } });
    const [a, b, c] = await Promise.all([h.caps.planner(), h.caps.planner(), h.caps.ensure()]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(seen).toEqual(['detecting', 'ready']);
    expect(h.calls.filter(call => call.args.at(-1) === '-encoders')).toHaveLength(1);
    // Asked again later: the same table, no new detection.
    await h.caps.planner();
    expect(h.calls.filter(call => call.args.at(-1) === '-encoders')).toHaveLength(1);
    // Each answer is a copy: changing it changes nothing.
    if (a.ok) expect(() => { (a.capabilities.degraded as VideoEncoderId[]).push('hevc_nvenc'); }).toThrow();
  });

  it('is detecting while a detection runs: planner() waits for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness(THIS_MACHINE, { gpuInfo: async () => { await gate; return GPU; } });
    const pending = h.caps.planner();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.caps.status().capabilities).toEqual({ state: 'detecting' });
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release();
    expect((await pending).ok).toBe(true);
  });

  it('answers the runtime\'s code when it cannot be used, does not retry by itself, and detects again on request', async () => {
    const h = harness();
    const acquire = h.runtime.acquire;
    let missing = true;
    h.runtime.acquire = async () => { if (missing) { h.runtime.acquired++; throw new MediaRuntimeError('runtime_missing', 'not staged'); } return acquire(); };
    expect(await h.caps.planner()).toEqual({ ok: false, code: 'runtime_missing' });
    expect(h.caps.status().capabilities).toEqual({ state: 'unavailable', code: 'runtime_missing' });
    expect(await h.caps.planner()).toEqual({ ok: false, code: 'runtime_missing' });
    expect(h.runtime.acquired).toBe(1);
    missing = false;
    expect(h.caps.redetect()).toEqual({ ok: true });
    expect((await h.caps.planner()).ok).toBe(true);
    expect(h.caps.status().capabilities.state).toBe('ready');
  });

  it('a runtime that cannot start in the middle of the tests makes the engine unavailable', async () => {
    const h = harness();
    const run = h.runtime.run;
    h.runtime.run = async (tool, args, limits) => {
      if (identify(args).encoder === 'hevc_nvenc') throw new MediaRuntimeError('runtime_spawn_failed', 'gone');
      return run(tool, args, limits);
    };
    expect(await h.caps.planner()).toEqual({ ok: false, code: 'runtime_spawn_failed' });
    expect(await readdir(path.join(root, 'work'))).toEqual([]);
  });

  it('refuses "detect again" while a hardware encode runs (AC-ENGINE-03-2), and otherwise measures everything anew', async () => {
    let hardware = false;
    await ready(harness().caps);
    const h = harness(THIS_MACHINE, { isHardwareEncodeRunning: () => hardware });
    await ready(h.caps);
    expect(h.encodes()).toEqual([]);
    hardware = true;
    expect(h.caps.redetect()).toEqual({ ok: false, code: 'busy' });
    expect(h.caps.status().capabilities.state).toBe('ready');
    await h.caps.planner();
    expect(h.encodes()).toEqual([]);
    hardware = false;
    expect(h.caps.redetect()).toEqual({ ok: true });
    expect(h.caps.status().capabilities).toEqual({ state: 'detecting' });
    await ready(h.caps);
    expect(h.encodes()).toHaveLength(ALL_KEYS.length);
    expect(h.caps.report()?.forced).toBe(true);
  });

  it('follows a detection that used kept verdicts with a full one when asked to detect again meanwhile', async () => {
    await ready(harness().caps);
    const h = harness();
    const first = h.caps.planner();
    expect(h.caps.redetect()).toEqual({ ok: true });
    expect(h.caps.redetect()).toEqual({ ok: true });
    expect((await first).ok).toBe(true);
    expect(h.encodes()).toHaveLength(ALL_KEYS.length);
    expect(h.calls.filter(call => call.args.at(-1) === '-encoders')).toHaveLength(2);
  });

  it('passes over a degraded encoder for the rest of the session, until "detect again"', async () => {
    const h = harness();
    await ready(h.caps);
    let told = 0;
    h.caps.subscribe(() => { told++; });
    h.caps.markDegraded('hevc_nvenc');
    h.caps.markDegraded('hevc_nvenc');
    expect(told).toBe(1);
    const caps = await ready(h.caps);
    expect(caps.degraded).toEqual(['hevc_nvenc']);
    const status = h.caps.status().capabilities;
    expect(status).toMatchObject({ hardwareEncoders: ['av1_nvenc', 'hevc_mf', 'h264_nvenc', 'h264_mf'], degraded: ['hevc_nvenc'], defaults: { compressCodec: 'hevc' } });
    expect(h.caps.resolvedEncoders().hevc.gpuOff).toEqual({ encoder: 'hevc_mf', variant: '8bit', hardware: true, weak: false, nameKey: 'media:encoders.hevc_mf' });
    h.caps.markDegraded('hevc_mf');
    expect(h.caps.defaults()).toEqual({ compressCodec: 'h264' });
    expect(h.caps.resolvedEncoders().hevc.gpuOff).toMatchObject({ encoder: 'libkvazaar', hardware: false, weak: true });
    h.caps.redetect();
    expect((await ready(h.caps)).degraded).toEqual([]);
    expect(h.caps.defaults()).toEqual({ compressCodec: 'hevc' });
  });

  it('resolves each codec along the planner\'s chains, the weak CPU encoders marked', () => {
    const none = resolveEncoders({ encoders: {}, degraded: [], nvencMin: NVENC_MIN_FRAME });
    expect(none).toEqual({
      av1: { gpuOff: expect.objectContaining({ encoder: 'libsvtav1', weak: false }), gpuOn: expect.objectContaining({ encoder: 'libsvtav1', hardware: false }) },
      hevc: { gpuOff: expect.objectContaining({ encoder: 'libkvazaar', weak: true }), gpuOn: expect.objectContaining({ encoder: 'libkvazaar' }) },
      h264: { gpuOff: expect.objectContaining({ encoder: 'libopenh264', weak: true, nameKey: 'media:encoders.libopenh264' }), gpuOn: expect.objectContaining({ encoder: 'libopenh264' }) },
    });
    const softwareMf = resolveEncoders({ encoders: { h264_mf: { variants: { '8bit': false, '8bit_sw': true } } }, degraded: [], nvencMin: NVENC_MIN_FRAME });
    expect(softwareMf.h264.gpuOff).toEqual({ encoder: 'h264_mf', variant: '8bit_sw', hardware: false, weak: true, nameKey: 'media:encoders.h264_mf_sw' });
    const nothing = resolveEncoders({ encoders: { libsvtav1: { variants: { '10bit': false } } }, degraded: [], nvencMin: NVENC_MIN_FRAME });
    expect(nothing.av1).toEqual({ gpuOff: null, gpuOn: null });
    expect(resolvedEncodersSchema.parse(nothing)).toEqual(nothing);
  });

  it('measures everything again when capabilities.json cannot be read, and replaces it', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'capabilities.json'), '{"version":1,"key":');
    const h = harness();
    await ready(h.caps);
    expect(h.encodes()).toHaveLength(ALL_KEYS.length);
    expect(h.logs.join('\n')).toContain('could not be read');
    expect((await capabilitiesFile()).version).toBe(1);
  });

  it('takes no kept driver version the engine status could not carry', async () => {
    await ready(harness((encoder, variant) => encoder === 'h264_nvenc' ? { exitCode: EXIT_EXTERNAL, stderr: fixture('synthetic-nvenc-driver-too-old.txt') } : THIS_MACHINE(encoder, variant)).caps);
    const file = await capabilitiesFile();
    file.results['h264_nvenc:8bit'].minimumDriver = 'update now';
    await writeFile(path.join(root, 'capabilities.json'), JSON.stringify(file));
    const next = harness();
    await ready(next.caps);
    expect(next.encodes()).toHaveLength(ALL_KEYS.length);
    expect(next.logs.join('\n')).toContain('could not be read');
    expect(engineStatusSchema.safeParse(next.caps.status()).success).toBe(true);
  });

  it('still detects when capabilities.json cannot be written', async () => {
    const h = harness(THIS_MACHINE, { writeFile: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
    expect((await h.caps.planner()).ok).toBe(true);
    expect(h.caps.report()?.persisted).toBe(false);
    expect(h.logs.join('\n')).toContain('could not be written');
  });

  it('dispose() ends the ffmpeg of a detection in progress; later asks answer busy', async () => {
    const h = harness(encoder => encoder === 'hevc_nvenc' ? { hangs: true } : {});
    const pending = h.caps.planner();
    while (!h.encodes().some(call => identify(call.args).encoder === 'hevc_nvenc')) await new Promise(resolve => setTimeout(resolve, 1));
    let told = 0;
    h.caps.subscribe(() => { told++; });
    await h.caps.dispose();
    // The detection it cut short ends without telling anyone: the queue may be gone.
    expect(told).toBe(0);
    h.caps.markDegraded('h264_nvenc');
    expect(told).toBe(0);
    expect(await pending).toEqual({ ok: false, code: 'busy' });
    expect(await h.caps.planner()).toEqual({ ok: false, code: 'busy' });
    expect(h.caps.redetect()).toEqual({ ok: false, code: 'busy' });
    expect(h.encodes().filter(call => identify(call.args).encoder === 'hevc_nvenc')).toHaveLength(1);
    expect(h.caps.report()!.results.filter(entry => entry.source === 'skipped').length).toBeGreaterThan(0);
    expect(await readdir(path.join(root, 'work'))).toEqual([]);
  });
});

describe('the test switch in the detection', () => {
  it('cpu_only: no hardware encoder, no test encode, no file', async () => {
    const h = harness(THIS_MACHINE, { override: { kind: 'cpu_only' } });
    const caps = await ready(h.caps);
    expect(h.calls).toEqual([]);
    expect(h.runtime.acquired).toBe(1);
    expect(await readdir(root)).toEqual([]);
    expect(h.caps.status().capabilities).toMatchObject({ state: 'ready', hardwareEncoders: [], defaults: { compressCodec: 'h264' } });
    expect(h.caps.resolvedEncoders().hevc.gpuOff).toMatchObject({ encoder: 'libkvazaar', weak: true });
    expect(caps.encoders.libsvtav1).toEqual({ variants: { '10bit': true } });
    expect(new Set(Object.values(sources(h.caps)))).toEqual(new Set(['override']));
  });

  it('nvenc: exactly the NVENC configurations', async () => {
    const h = harness(THIS_MACHINE, { override: { kind: 'nvenc' } });
    await ready(h.caps);
    expect(h.calls).toEqual([]);
    expect(h.caps.status().capabilities).toMatchObject({ hardwareEncoders: ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc'], defaults: { compressCodec: 'hevc' } });
    expect(h.caps.resolvedEncoders().av1.gpuOn).toMatchObject({ encoder: 'av1_nvenc', variant: '10bit_uhq' });
  });

  it('detecting_ms: detecting for that long, then cpu_only', async () => {
    const h = harness(THIS_MACHINE, { override: { kind: 'detecting', milliseconds: 4_000 } });
    const pending = h.caps.planner();
    while (!h.clock.waits.length) await new Promise(resolve => setTimeout(resolve, 1));
    expect(h.clock.waits[0].ms).toBe(4_000);
    expect(h.caps.status().capabilities).toEqual({ state: 'detecting' });
    h.clock.waits[0].resolve();
    expect((await pending).ok).toBe(true);
    expect(h.caps.status().capabilities).toMatchObject({ state: 'ready', hardwareEncoders: [] });
    expect(h.calls).toEqual([]);
  });
});

// ── The real runtime on this computer (V-ENGINE-03-2) ──────────────────────────────────────────

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
/** Set to `nvidia-no-igpu` on the development machine (RTX 4070 Ti SUPER, no Intel or AMD graphics) to check its expected verdicts as well. */
const EXPECT = process.env.FUSIONKIT_MEDIA_CAPS_EXPECT;

describe.skipIf(!available)('the real detection on this computer', () => {
  let realRoot: string;
  afterAll(async () => { if (realRoot) await rm(realRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it('tests every configuration within 30 s, keeps only definitive verdicts, and does not test again with the same key', async () => {
    realRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fk-media-caps-real-')));
    const runtime = new MediaRuntime({ environment, workingDirectory: path.join(realRoot, 'work') });
    const started = performance.now();
    const caps = new MediaCapabilities({ runtime, root: realRoot, gpuInfo: async () => GPU, isHardwareEncodeRunning: () => false });
    const answer = await caps.planner();
    const elapsedMs = Math.round(performance.now() - started);
    expect(answer.ok).toBe(true);
    const report = caps.report()!;
    const summary = report.results.map(entry => `${keyOf(entry.encoder, entry.variant).padEnd(22)} ${entry.outcome.padEnd(16)} ${String(entry.durationMs).padStart(5)} ms  ${entry.detail ?? ''}`);
    console.log(`capability detection: tests ${report.testMs} ms, with runtime verification ${elapsedMs} ms\n${summary.join('\n')}`);
    console.log(`engine status: ${JSON.stringify(caps.status())}`);
    expect(report.results.map(entry => keyOf(entry.encoder, entry.variant))).toEqual(ALL_KEYS);
    expect(report.results.every(entry => entry.source === 'measured')).toBe(true);
    expect(report.testMs).toBeLessThanOrEqual(CAPABILITY_POLICY.budgetMs);
    expect(engineStatusSchema.parse(caps.status()).capabilities.state).toBe('ready');
    // The test folder is gone. (The NVIDIA driver leaves its own cache in TEMP, which is the working directory; the startup cleanup empties it.)
    expect((await readdir(path.join(realRoot, 'work'))).filter(name => name.startsWith('capabilities-'))).toEqual([]);

    const kept = JSON.parse(await readFile(path.join(realRoot, 'capabilities.json'), 'utf8'));
    const definitive = report.results.filter(entry => ['available', 'driver_too_old', 'no_device', 'runtime_missing', 'params_rejected'].includes(entry.outcome));
    expect(Object.keys(kept.results).sort()).toEqual(definitive.map(entry => keyOf(entry.encoder, entry.variant)).sort());

    // A second start with the same runtime and card: the three listings run, and a test encode only for what was not definitive.
    const runs: string[] = [];
    const counting: CapabilityRuntime = { acquire: () => runtime.acquire(), status: () => runtime.status(),
      run: (tool, args, limits) => { runs.push(`${tool} ${args.at(-1)?.startsWith('file:') ? 'test' : args.at(-1)}`); return runtime.run(tool, args, limits); } };
    const second = new MediaCapabilities({ runtime: counting, root: realRoot, gpuInfo: async () => GPU, isHardwareEncodeRunning: () => false });
    expect((await second.planner()).ok).toBe(true);
    expect(runs.slice(0, 3)).toEqual(['ffmpeg -encoders', 'ffmpeg -muxers', 'ffmpeg -filters']);
    expect(runs.filter(run => run === 'ffmpeg test')).toHaveLength(report.results.length - definitive.length);
    const kept2 = Object.fromEntries(second.report()!.results.filter(entry => entry.source === 'cached').map(entry => [keyOf(entry.encoder, entry.variant), entry.outcome]));
    expect(kept2).toEqual(Object.fromEntries(definitive.map(entry => [keyOf(entry.encoder, entry.variant), entry.outcome])));

    if (EXPECT === 'nvidia-no-igpu') {
      expect(Object.fromEntries(report.results.map(entry => [keyOf(entry.encoder, entry.variant), entry.outcome]))).toEqual(THIS_MACHINE_OUTCOMES);
      expect(caps.status().capabilities).toMatchObject({ state: 'ready', hardwareEncoders: ['av1_nvenc', 'hevc_nvenc', 'hevc_mf', 'h264_nvenc', 'h264_mf'], defaults: { compressCodec: 'hevc' } });
      console.log(`checked against the expected verdicts of ${EXPECT}: ${Object.keys(THIS_MACHINE_OUTCOMES).length} configurations match`);
    }
  }, 120_000);
});

/** A plain 1080p SDR H.264 source with stereo AAC, as the probe would describe it. */
function sampleMedia() {
  return {
    kind: 'video',
    container: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', matroskaDocType: null, extension: 'mp4', identity: 'mp4' },
    sizeBytes: 50_000_000, durationUs: 60_000_000, durationSource: 'format', startTimeUs: 0, bitRate: 6_666_666, primaryVideoIndex: 0,
    video: [{
      index: 0, typeIndex: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', bitDepth: 8, chromaSubsampling: '420', width: 1920, height: 1080,
      sampleAspectRatio: '1:1', rFrameRate: '30/1', avgFrameRate: '30/1', fps: 30, isVfr: false, rotation: 0, colorPrimaries: 'bt709', colorTransfer: 'bt709',
      colorSpace: 'bt709', colorRange: 'tv', fieldOrder: 'progressive', bitRate: 6_500_000, durationUs: 60_000_000, language: null, title: null, default: true,
      hdr: { format: 'none', dolbyVision: null, masteringDisplay: null, contentLight: null },
    }],
    audio: [{
      index: 1, typeIndex: 0, codec: 'aac', profile: 'LC', channels: 2, channelLayout: 'stereo', sampleRate: 48_000, sampleFormat: 'fltp', bitsPerRawSample: null,
      bitRate: 160_000, bitRateSource: 'stream', durationUs: 60_000_000, language: 'eng', title: null, default: true, forced: false,
    }],
    subtitles: [], covers: [], attachments: 0, chapters: 0, dataStreams: 0,
  };
}
