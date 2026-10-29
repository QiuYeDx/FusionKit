import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  AUDIO_ENCODERS, SUBTITLE_ENCODERS, VIDEO_ENCODERS, encoderNameKey, runtimeFailureCodeSchema,
  type CapabilityDefaults, type CapabilityFailureCode, type CapabilityStatus, type CompressCodec, type EngineReasonCode, type EngineStatus,
  type HardwareEncoderFamily, type ResolvedEncoder, type ResolvedEncoders, type RuntimeStatus, type VariantKey, type VideoEncoderId,
} from '../../../../src/media-converter/contract';
import { atomicWriteUtf8File } from '../../translation/atomic-file';
import { ffmpegEncoderName, probeArgs } from '../plan/args';
import { OUTPUT_CONTAINER_SPECS } from '../plan/matrix';
import type { PlannerCapabilities } from '../plan/types';
import { PROBE_PICTURE, VIDEO_CHAINS, defaultCompressCodec, encoderVariants, isVariantAvailable, isWeakCpuEncoder, variantBitDepth } from '../plan/video';
import type { CapabilitiesAnswer, QueueCapabilities } from '../queue/types';
import type { MediaCapsOverride } from '../test-hooks';
import { createLogRedactor } from './progress';
import { MediaRuntimeError, type MediaRunResult, type MediaTools, type MediaRuntime } from './runtime';

/**
 * What this computer can encode (design §3, R-ENGINE-03). The software part reads the encoders,
 * muxers and filters the bundled ffmpeg lists. The hardware part encodes three frames of a lavfi
 * picture with every configuration the planner can choose (encoder × bit depth × NVENC tune), with
 * exactly the production arguments (`probeArgs`), into a small MKV in the working directory, and
 * checks the codec, pixel format and profile ffprobe reads back: `-encoders` lists encoders the
 * driver cannot open, and a driver can refuse production options that a bare test would not use.
 * Tests run one at a time below normal priority (the runtime's), 15 s each, 30 s in all.
 * Only definitive verdicts are kept in `capabilities.json`, keyed by the runtime and the graphics
 * cards with their drivers; a session limit, a timeout or anything unexplained is tried again at
 * the next start. The result is the planner's `PlannerCapabilities` and the engine status.
 */

export const CAPABILITY_POLICY = Object.freeze({
  /** One configuration: its encode and the ffprobe check together (AC-ENGINE-03-1). */
  probeTimeoutMs: 15_000,
  /** All configurations together; those the budget does not reach are `unknown` for this session. */
  budgetMs: 30_000,
  /** The ffprobe check, within the configuration's 15 s. */
  verifyTimeoutMs: 5_000,
  /** `-encoders`, `-muxers`, `-filters`; not part of the budget. */
  listTimeoutMs: 15_000,
  listOutputBytes: 1024 * 1024,
  probeFrames: 3,
  stderrMaxBytes: 256 * 1024,
  /** A decisive stderr line kept for the report. */
  detailChars: 300,
  /** Without driver versions in the key, a kept verdict is measured again after a week (design §3). */
  unkeyedLifetimeMs: 7 * 24 * 60 * 60 * 1000,
  /** What NVENC of the bundled ffmpeg (SDK 13.0) needs on Windows, when ffmpeg does not print it (AC-ENGINE-03-4). */
  nvencMinimumDriver: '570.0',
  /** Getting the graphics card list may not take longer; the key then has no cards. */
  gpuInfoTimeoutMs: 5_000,
  fileName: 'capabilities.json',
});

/**
 * `PlannerCapabilities.nvencMin`: the smallest picture any NVIDIA encoder opens, HEVC's 129 × 33
 * (module-encode design §7b). The planner no longer reads it (2026-10-28): `VIDEO_TABLE.hardwareFrame`
 * holds the measured range per codec and alone decides. It stays for the table's shape and says
 * which minimum this table assumes.
 */
export const NVENC_MIN_FRAME = Object.freeze({ width: 129, height: 33 });

// ── Software capabilities ──────────────────────────────────────────────────────────────────────

/** The rows after the `---` line; the legend above it has the same shape. */
function listRows(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*-{3,}\s*$/.test(line));
  return start === -1 ? [] : lines.slice(start + 1);
}

/** `ffmpeg -encoders`: ` V....D hevc_nvenc  NVIDIA NVENC hevc encoder (codec hevc)`. */
export function parseEncoderList(text: string): Set<string> {
  const names = new Set<string>();
  for (const row of listRows(text)) {
    const match = /^\s*[VAS][.A-Z]{5}\s+([A-Za-z0-9_-]+)\s/.exec(row);
    if (match) names.add(match[1]);
  }
  return names;
}

/** `ffmpeg -muxers`: `  E  matroska        Matroska` (`D`, `E`, `d` flags in three columns). */
export function parseMuxerList(text: string): Set<string> {
  const names = new Set<string>();
  for (const row of listRows(text)) {
    const match = /^ [D ][E ][d ] ([A-Za-z0-9_,-]+)\s/.exec(row);
    if (match && row[2] === 'E') for (const name of match[1].split(',')) if (name) names.add(name);
  }
  return names;
}

/** `ffmpeg -filters`: ` .S zscale  V->V  Apply resizing…`, sources as `|->V`. */
export function parseFilterList(text: string): Set<string> {
  const names = new Set<string>();
  for (const row of listRows(text)) {
    const match = /^\s*[T.][S.]\s+([A-Za-z0-9_]+)\s+\S*->\S*\s/.exec(row);
    if (match) names.add(match[1]);
  }
  return names;
}

export interface SoftwareCapabilities {
  readonly encoders: ReadonlySet<string>;
  readonly muxers: ReadonlySet<string>;
  readonly filters: ReadonlySet<string>;
}

/** The CPU video encoders the chains end with. Missing ones are left out of the table; nothing else depends on them. */
const CPU_VIDEO_ENCODERS = ['libsvtav1', 'libkvazaar', 'libopenh264'] as const satisfies readonly VideoEncoderId[];

/**
 * What every plan may need from the runtime, besides the video encoders: the audio and subtitle
 * encoders, the muxer of every output type, the filters of module-encode §4/§5 and the probe's own
 * `color` source. The pinned runtime has them all; one missing means it is not that runtime.
 */
export const REQUIRED_SOFTWARE = Object.freeze({
  encoders: Object.freeze([...AUDIO_ENCODERS, ...SUBTITLE_ENCODERS.map(ffmpegEncoderName)]),
  muxers: Object.freeze([...new Set(Object.values(OUTPUT_CONTAINER_SPECS).map(spec => spec.muxer))]),
  filters: Object.freeze(['scale', 'format', 'setparams', 'zscale', 'tonemap', 'bwdif', 'sidedata', 'aresample', 'aformat', 'channelmap', 'color']),
});

/** What the runtime lacks of `REQUIRED_SOFTWARE`, as `encoder:aac`, `muxer:webm`, `filter:zscale`. */
export function missingSoftware(software: SoftwareCapabilities): string[] {
  return [
    ...REQUIRED_SOFTWARE.encoders.filter(name => !software.encoders.has(name)).map(name => `encoder:${name}`),
    ...REQUIRED_SOFTWARE.muxers.filter(name => !software.muxers.has(name)).map(name => `muxer:${name}`),
    ...REQUIRED_SOFTWARE.filters.filter(name => !software.filters.has(name)).map(name => `filter:${name}`),
  ];
}

// ── Candidates ─────────────────────────────────────────────────────────────────────────────────

const familyOf = (encoder: VideoEncoderId): HardwareEncoderFamily | null => {
  const match = /_(nvenc|qsv|amf|mf)$/.exec(encoder);
  return match ? match[1] as HardwareEncoderFamily : null;
};
/** A graphics card or media engine encodes: any NVENC, QSV, AMF or MF configuration but h264_mf's software mode. */
export const isHardwareConfiguration = (encoder: VideoEncoderId, variant: VariantKey) => familyOf(encoder) !== null && variant !== '8bit_sw';

export interface CapabilityCandidate {
  readonly encoder: VideoEncoderId;
  readonly variant: VariantKey;
  readonly hardware: boolean;
  /** Everything between the lavfi input and the output: `probeArgs`, the production video arguments. */
  readonly args: readonly string[];
  /**
   * Not a configuration the planner uses: Media Foundation's hardware HEVC asked for 10-bit (p010le).
   * Design §4 says it is refused (encoded as 8-bit nv12); the planner has no such row, so the check
   * only records that, and a change of driver or runtime that would make the row worth adding.
   */
  readonly guard: boolean;
}

/** The order of design §3: NVENC (H.264, HEVC, AV1), then QSV and AMF the same way, then Media Foundation. */
const HARDWARE_ORDER = [
  'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'av1_qsv', 'h264_amf', 'hevc_amf', 'av1_amf',
] as const satisfies readonly VideoEncoderId[];

const candidate = (encoder: VideoEncoderId, variant: VariantKey): CapabilityCandidate =>
  Object.freeze({ encoder, variant, hardware: isHardwareConfiguration(encoder, variant), args: Object.freeze(probeArgs(encoder, variant)), guard: false });

/** hevc_mf's production arguments with the 10-bit format of the other hardware rows (design §4): `-pix_fmt p010le`, `format=p010le`. */
function mfTenBitGuard(): CapabilityCandidate {
  const base = probeArgs('hevc_mf', '8bit');
  let replaced = 0;
  const args = base.map((value, index) => {
    if (base[index - 1] === '-pix_fmt:v:0' && value === 'nv12') { replaced++; return 'p010le'; }
    if (base[index - 1] === '-filter:v:0' && /(?:^|,)format=nv12(?:,|$)/.test(value)) { replaced++; return value.replace(/(^|,)format=nv12(?=,|$)/, '$1format=p010le'); }
    return value;
  });
  if (replaced !== 2) throw new TypeError('The hevc_mf parameters no longer end in nv12.');
  return Object.freeze({ encoder: 'hevc_mf', variant: '10bit', hardware: true, args: Object.freeze(args), guard: true });
}

/**
 * Every configuration tested, in order: each NVENC, QSV and AMF configuration the planner can
 * choose, then h264_mf and hevc_mf in hardware mode, the hevc_mf 10-bit check, and h264_mf in
 * software mode. The list is fixed: whatever else `-encoders` shows (`*_d3d12va`, `*_vulkan`,
 * `*_vaapi`, `av1_mf`) is never a candidate (AC-ENGINE-03-4), and the CPU encoders are not tested.
 */
export function capabilityCandidates(): CapabilityCandidate[] {
  const list: CapabilityCandidate[] = [];
  for (const encoder of HARDWARE_ORDER) for (const variant of encoderVariants(encoder)) list.push(candidate(encoder, variant));
  for (const encoder of ['h264_mf', 'hevc_mf'] as const) {
    for (const variant of encoderVariants(encoder)) if (variant !== '8bit_sw') list.push(candidate(encoder, variant));
  }
  list.push(mfTenBitGuard());
  for (const variant of encoderVariants('h264_mf')) if (variant === '8bit_sw') list.push(candidate('h264_mf', variant));
  return list;
}

export const candidateKey = (encoder: VideoEncoderId, variant: VariantKey) => `${encoder}:${variant}`;
/** Which arguments a kept verdict was measured with: an update that changes the tables measures again. */
export const argumentsDigest = (args: readonly string[]) => createHash('sha256').update(JSON.stringify(args)).digest('hex');

/** The test encode: three frames of `PROBE_PICTURE`, every warning shown (`level+warning`), the output pinned to Matroska. */
export function probeEncodeArgs(entry: Pick<CapabilityCandidate, 'args'>, outputPath: string): string[] {
  const { width, height, fps } = PROBE_PICTURE;
  return ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning', '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:r=${fps}`,
    '-frames:v', String(CAPABILITY_POLICY.probeFrames), ...entry.args, '-f', 'matroska', '-y', `file:${outputPath}`];
}

/** What ffprobe reads back from the test output, its demuxer pinned. */
export function probeVerifyArgs(outputPath: string): string[] {
  return ['-hide_banner', '-v', 'error', '-f', 'matroska', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt,profile', '-of', 'json', `file:${outputPath}`];
}

// ── Verdicts ───────────────────────────────────────────────────────────────────────────────────

/** ffmpeg did something other than asked, yet may exit 0: the configuration fails (AC-ENGINE-03-1). */
export const SILENT_SUBSTITUTION = /auto-selecting format|Invalid option|Error parsing option/i;

/**
 * The stderr signs of design §3, checked in this order. NVENC prints "No capable devices found"
 * after every device it could not use, whatever the reason, so what names the reason comes first:
 * a full session table, a picture outside its range (module-encode §7b; `params_rejected`, as is
 * every refused option), and a CUDA call that failed. CUDA running out of memory (a game holding
 * the card) passes like a full session table, and any other CUDA failure but "no device" is not
 * known to last: neither may be kept as `no_device`, which capabilities.json would keep until the
 * driver changes.
 */
const FAILURE_SIGNS: readonly (readonly [CapabilityFailureCode, RegExp])[] = [
  ['driver_too_old', /Driver does not support the required nvenc API version|minimum required Nvidia driver/i],
  ['session_limit', /OpenEncodeSessionEx failed: (?:out of memory|incompatible client key)|CUDA_ERROR_OUT_OF_MEMORY/i],
  ['params_rejected', /\bexceeds\b|less than the minimum|\bFrame dimensions?\b/i],
  ['unknown', /failed -> CUDA_ERROR_(?!NO_DEVICE\b|OUT_OF_MEMORY\b)\w+/],
  ['no_device', /No (?:NVENC |CUDA )?capable devices? found|MFX session|CUDA_ERROR_NO_DEVICE/i],
  ['runtime_missing', /amfrt64\.dll|could not find any MFT|Cannot load (?:nvcuda\.dll|nvEncodeAPI)/i],
  ['params_rejected', new RegExp([
    'InitializeEncoder failed: (?:invalid|unsupported) param', 'auto-selecting format', 'Invalid option', 'Error parsing option', 'Unrecognized option',
    'Error setting option', 'Unable to parse "?\\w+"? option value', 'Error applying encoder options',
  ].join('|'), 'i')],
];

/** A driver version as NVENC names it and the engine status carries it (`driverUpdates[].minimumVersion`). */
const DRIVER_VERSION = /^\d{1,5}(?:\.\d{1,5}){0,3}$/;

export interface FailureVerdict {
  readonly code: CapabilityFailureCode;
  /** The stderr line that decided it; null when no line names a reason (`unknown`). */
  readonly line: string | null;
  /** `driver_too_old` from NVENC: the version ffmpeg names, else 570.0. */
  readonly minimumDriver: string | null;
}

/** The failure category a failed test's stderr names; `unknown` when it names none. */
export function classifyEncoderFailure(stderr: string): FailureVerdict {
  const lines = stderr.split(/\r?\n/);
  for (const [code, sign] of FAILURE_SIGNS) {
    const line = lines.find(text => sign.test(text));
    if (line === undefined) continue;
    const minimumDriver = code === 'driver_too_old'
      ? /minimum required Nvidia driver for nvenc is (\d{1,5}(?:\.\d{1,5}){0,3}) or newer/i.exec(stderr)?.[1] ?? CAPABILITY_POLICY.nvencMinimumDriver
      : null;
    return { code, line, minimumDriver };
  }
  return { code: 'unknown', line: null, minimumDriver: null };
}

/** What ffprobe reads from a test output. */
export interface EncodedStreamFacts {
  readonly codec: string | null;
  readonly pixFmt: string | null;
  readonly profile: string | null;
}

/**
 * What the decoder must report for a configuration: its codec; `yuv420p` for 8-bit (nv12 input
 * decodes as yuv420p) and `yuv420p10le` for 10-bit (p010le); H.264 High (`-profile:v high`, MF's
 * `100`), HEVC Main or Main 10, AV1 Main.
 */
export function expectedStream(encoder: VideoEncoderId, variant: VariantKey): EncodedStreamFacts {
  const codec = encoder.startsWith('h264') ? 'h264' : encoder.startsWith('hevc') ? 'hevc' : 'av1';
  const tenBit = variantBitDepth(variant) === 10;
  const profile = codec === 'h264' ? 'High' : codec === 'hevc' ? (tenBit ? 'Main 10' : 'Main') : 'Main';
  return { codec, pixFmt: tenBit ? 'yuv420p10le' : 'yuv420p', profile };
}

/** ffprobe's `-show_entries stream=codec_name,pix_fmt,profile -of json`; null when it holds no video stream. */
export function readStreamFacts(json: string): EncodedStreamFacts | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  const stream = (raw as { streams?: unknown } | null)?.streams;
  const first = Array.isArray(stream) ? stream[0] as Record<string, unknown> | undefined : undefined;
  if (!first || typeof first !== 'object') return null;
  const text = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
  return { codec: text(first.codec_name), pixFmt: text(first.pix_fmt), profile: text(first.profile) };
}

export const streamMatches = (expected: EncodedStreamFacts, actual: EncodedStreamFacts) =>
  expected.codec === actual.codec && expected.pixFmt === actual.pixFmt && expected.profile === actual.profile;

// ── Results ────────────────────────────────────────────────────────────────────────────────────

export type ConfigurationOutcome = 'available' | CapabilityFailureCode;
/** The verdicts kept across restarts (AC-ENGINE-03-2). */
export const DEFINITIVE_OUTCOMES: ReadonlySet<ConfigurationOutcome> = new Set(['available', 'driver_too_old', 'no_device', 'runtime_missing', 'params_rejected']);

export interface CapabilityProbeResult {
  readonly encoder: VideoEncoderId;
  readonly variant: VariantKey;
  readonly hardware: boolean;
  readonly guard: boolean;
  readonly outcome: ConfigurationOutcome;
  /**
   * `measured` now; `cached` from capabilities.json; `not_listed`: the runtime has no such encoder;
   * `skipped`: the budget ran out (or the detection stopped) before it; `override`: a test switch.
   */
  readonly source: 'measured' | 'cached' | 'not_listed' | 'skipped' | 'override';
  /** Encode and check, for a measured one. */
  readonly durationMs: number | null;
  /** Why it failed: the redacted stderr line, the facts ffprobe read, or the timeout. */
  readonly detail: string | null;
  readonly minimumDriver: string | null;
}

export interface GpuKey {
  readonly vendorId: number;
  readonly deviceId: number;
  readonly driverVersion: string | null;
}

/** What a kept verdict is valid for: the runtime and the graphics cards with their drivers (design §3). */
export interface CapabilityCacheKey {
  readonly ffmpeg: string;
  /** sha256 of the runtime manifest the executables were verified against. */
  readonly generation: string;
  /** Null when the cards could not be read. */
  readonly gpus: readonly GpuKey[] | null;
}

/** Whether the key holds every card's driver; without it a kept verdict lasts a week. */
export const keyHasDrivers = (key: CapabilityCacheKey) => key.gpus !== null && key.gpus.length > 0 && key.gpus.every(gpu => gpu.driverVersion !== null);

/**
 * The cards of Electron's `app.getGPUInfo('basic')` (`gpuDevice[]`: `vendorId`, `deviceId`, and on
 * Windows `driverVersion`), sorted, without duplicates; null when it lists none.
 */
export function gpuKeyOf(info: unknown): GpuKey[] | null {
  const devices = (info as { gpuDevice?: unknown } | null)?.gpuDevice;
  if (!Array.isArray(devices)) return null;
  const seen = new Map<string, GpuKey>();
  for (const device of devices.slice(0, 16)) {
    if (!device || typeof device !== 'object') continue;
    const { vendorId, deviceId, driverVersion } = device as Record<string, unknown>;
    if (!Number.isSafeInteger(vendorId) || !Number.isSafeInteger(deviceId)) continue;
    const driver = typeof driverVersion === 'string' && /^[\w.+-]{1,64}$/.test(driverVersion.trim()) ? driverVersion.trim() : null;
    const gpu = { vendorId: vendorId as number, deviceId: deviceId as number, driverVersion: driver };
    seen.set(JSON.stringify(gpu), gpu);
  }
  const gpus = [...seen.values()].sort((a, b) => a.vendorId - b.vendorId || a.deviceId - b.deviceId || String(a.driverVersion).localeCompare(String(b.driverVersion)));
  return gpus.length ? gpus : null;
}

/** Electron's card list, imported on first use so that this module loads without Electron. Needs the app to be ready. */
export async function electronGpuInfo(): Promise<unknown> {
  const { app } = await import('electron');
  return app.getGPUInfo('basic');
}

// ── capabilities.json ──────────────────────────────────────────────────────────────────────────

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const gpuKeySchema = z.strictObject({
  vendorId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deviceId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  driverVersion: z.string().min(1).max(64).nullable(),
});
const cacheKeySchema = z.strictObject({ ffmpeg: z.string().min(1).max(128), generation: z.string().min(1).max(128), gpus: z.array(gpuKeySchema).max(16).nullable() });
const cacheEntrySchema = z.strictObject({
  args: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum(['available', 'driver_too_old', 'no_device', 'runtime_missing', 'params_rejected']),
  measuredAt: timestamp,
  // The status repeats it to the renderer, whose schema takes nothing else.
  minimumDriver: z.string().regex(DRIVER_VERSION).nullable(),
});
type CacheEntry = z.infer<typeof cacheEntrySchema>;
const cacheFileSchema = z.strictObject({
  version: z.literal(1),
  key: cacheKeySchema,
  results: z.record(z.string().regex(/^[a-z0-9_]{1,32}:[a-z0-9_]{1,16}$/), cacheEntrySchema),
});
type CacheFile = z.infer<typeof cacheFileSchema>;

const keyText = (key: CapabilityCacheKey) => JSON.stringify([key.ffmpeg, key.generation, key.gpus?.map(gpu => [gpu.vendorId, gpu.deviceId, gpu.driverVersion]) ?? null]);
const sameKey = (a: CapabilityCacheKey, b: CapabilityCacheKey) => keyText(a) === keyText(b);

// ── Tables ─────────────────────────────────────────────────────────────────────────────────────

/** The measured table, before this session's degradations; the planner gets it with them (`PlannerCapabilities`). */
function measuredTable(results: readonly CapabilityProbeResult[], softwareEncoders: ReadonlySet<string> | null): PlannerCapabilities['encoders'] {
  const encoders: PlannerCapabilities['encoders'] = {};
  for (const encoder of CPU_VIDEO_ENCODERS) {
    const present = softwareEncoders === null || softwareEncoders.has(encoder);
    encoders[encoder] = { variants: Object.fromEntries(encoderVariants(encoder).map(variant => [variant, present])) };
  }
  for (const result of results) {
    const entry = encoders[result.encoder] ??= { variants: {} };
    entry.variants[result.variant] = result.outcome === 'available';
    if (result.encoder.endsWith('_nvenc') && result.variant.endsWith('_uhq')) entry.uhq = entry.uhq === true || result.outcome === 'available';
  }
  return encoders;
}

const freezeCaps = (caps: PlannerCapabilities): PlannerCapabilities => Object.freeze({
  encoders: Object.freeze(Object.fromEntries(Object.entries(caps.encoders).map(([encoder, entry]) =>
    [encoder, Object.freeze({ ...entry!, variants: Object.freeze({ ...entry!.variants }) })]))),
  degraded: Object.freeze([...caps.degraded]) as VideoEncoderId[],
  nvencMin: Object.freeze({ ...caps.nvencMin }),
});

/** For a picture every encoder takes, the first configuration of the planner's chain that works and is not degraded. */
function resolve(caps: PlannerCapabilities, codec: CompressCodec, useGpu: boolean): ResolvedEncoder | null {
  const chain = codec === 'av1' && useGpu ? VIDEO_CHAINS.av1_gpu : VIDEO_CHAINS[codec];
  for (const { encoder, variants } of chain) {
    for (const variant of variants) {
      if (!isVariantAvailable(caps, encoder, variant)) continue;
      return { encoder, variant, hardware: isHardwareConfiguration(encoder, variant), weak: isWeakCpuEncoder(encoder, variant), nameKey: encoderNameKey(encoder, variant) };
    }
  }
  return null;
}

/** `resolvedEncoders` of the snapshot (engine design §8): per codec, with "use the graphics card" off and on. */
export function resolveEncoders(caps: PlannerCapabilities): ResolvedEncoders {
  const pair = (codec: CompressCodec) => ({ gpuOff: resolve(caps, codec, false), gpuOn: resolve(caps, codec, true) });
  return { av1: pair('av1'), hevc: pair('hevc'), h264: pair('h264') };
}

/** The table the test switches give: nothing works but the CPU, or exactly NVENC. */
function overrideResults(kind: 'cpu_only' | 'nvenc'): CapabilityProbeResult[] {
  return capabilityCandidates().map(entry => ({
    encoder: entry.encoder, variant: entry.variant, hardware: entry.hardware, guard: entry.guard,
    outcome: kind === 'nvenc' && familyOf(entry.encoder) === 'nvenc' ? 'available' : 'no_device',
    source: 'override', durationMs: null, detail: null, minimumDriver: null,
  }));
}

// ── Detection ──────────────────────────────────────────────────────────────────────────────────

export interface CapabilityReport {
  readonly forced: boolean;
  /** Milliseconds since the epoch. */
  readonly startedAt: number;
  /** From the first test to the last; the 30 s budget measures the same span. */
  readonly testMs: number;
  readonly key: CapabilityCacheKey | null;
  readonly results: readonly CapabilityProbeResult[];
  /** capabilities.json was written (it changed). */
  readonly persisted: boolean;
}

export interface CapabilityClock {
  /** Milliseconds since the epoch: when a verdict was measured. */
  now(): number;
  /** A clock that never goes back: timeouts and the budget. */
  monotonic(): number;
  /** Resolves after `milliseconds`, or as soon as `signal` aborts (the `detecting_ms` test switch). */
  delay(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const systemClock: CapabilityClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  delay: (milliseconds, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  }),
};
const defaultLog = (message: string, error?: unknown) => console.warn(`[media-converter] ${message}`, error ?? '');

/** What detection needs from `MediaRuntime`. */
export type CapabilityRuntime = Pick<MediaRuntime, 'acquire' | 'run' | 'status'>;

export interface MediaCapabilitiesOptions {
  runtime: CapabilityRuntime;
  /** `userData/media-converter`: holds `capabilities.json`. */
  root: string;
  /** Electron's `app.getGPUInfo('basic')` by default; tests answer for it. */
  gpuInfo?: () => Promise<unknown>;
  /**
   * `MediaQueue.isHardwareEncodeRunning`: "detect again" is refused meanwhile (AC-ENGINE-03-2).
   * Required, so that no composition can leave the rule out by omission.
   */
  isHardwareEncodeRunning: () => boolean;
  /** `FUSIONKIT_TEST_MEDIA_CAPS`, as `resolveMediaTestHooks` passed it (never in an installed build). */
  override?: MediaCapsOverride | null;
  clock?: CapabilityClock;
  /** `atomicWriteUtf8File`; tests inject failures. */
  writeFile?: (file: string, content: string) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

type Measured = { readonly results: readonly CapabilityProbeResult[]; readonly softwareEncoders: ReadonlySet<string> | null };
type Detected = { ok: true; measured: Measured } | { ok: false; code: EngineReasonCode };

const completed = (result: MediaRunResult) => result.status === 'closed' && result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputExceeded;

/**
 * The capability table and the engine status of the media converter (`QueueCapabilities`).
 * Nothing runs at construction: the first `ensure()` or `planner()` detects (the first visit to
 * the tool page or the first file). While it runs the status is `detecting` and `planner()` waits.
 * A failed detection (the runtime cannot be used) is not kept: `redetect()` tries again.
 */
export class MediaCapabilities implements QueueCapabilities {
  readonly #runtime: CapabilityRuntime;
  readonly #file: string;
  readonly #gpuInfo: () => Promise<unknown>;
  readonly #hardwareBusy: () => boolean;
  readonly #override: MediaCapsOverride | null;
  readonly #clock: CapabilityClock;
  readonly #write: (file: string, content: string) => Promise<void>;
  readonly #log: (message: string, error?: unknown) => void;
  readonly #listeners = new Set<() => void>();
  readonly #degraded = new Set<VideoEncoderId>();
  readonly #stop = new AbortController();
  #state: 'unverified' | 'detecting' | 'ready' | 'unavailable' = 'unverified';
  #code: EngineReasonCode = 'unknown';
  #measured: Measured | null = null;
  #report: CapabilityReport | null = null;
  #running: Promise<void> | null = null;
  #runningForced = false;
  #forceNext = false;

  constructor(options: MediaCapabilitiesOptions) {
    if (!path.isAbsolute(options.root)) throw new TypeError('The media converter folder must be a full path.');
    this.#runtime = options.runtime;
    this.#file = path.join(options.root, CAPABILITY_POLICY.fileName);
    this.#gpuInfo = options.gpuInfo ?? electronGpuInfo;
    this.#hardwareBusy = options.isHardwareEncodeRunning;
    this.#override = options.override ?? null;
    this.#clock = options.clock ?? systemClock;
    this.#write = options.writeFile ?? atomicWriteUtf8File;
    this.#log = options.log ?? defaultLog;
  }

  // ── QueueCapabilities ──

  /** The table to plan with. Detects on first need and waits for a detection in progress; a failed detection answers its code. */
  async planner(): Promise<CapabilitiesAnswer> {
    if (this.#stop.signal.aborted) return { ok: false, code: 'busy' };
    if (this.#state === 'unverified') this.#start(false);
    while (this.#running) await this.#running;
    // A detection cut short by `dispose` holds no answer worth planning with.
    if (this.#stop.signal.aborted) return { ok: false, code: 'busy' };
    return this.#state === 'ready' ? { ok: true, capabilities: this.#plannerCaps() } : { ok: false, code: this.#code };
  }

  status(): EngineStatus {
    return { runtime: this.#runtimeStatus(), capabilities: this.#capabilityStatus() };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  // ── Engine ──

  /** Starts the first detection if none ran yet (the tool page opened); resolves with `planner()`'s answer. */
  ensure(): Promise<CapabilitiesAnswer> {
    return this.planner();
  }

  /**
   * "Detect again": measures every configuration anew, whatever capabilities.json keeps, and clears
   * this session's degradations. Refused (`busy`) while a hardware encode runs, which the tests
   * would compete with. Joins a detection in progress, or follows it when that one used kept verdicts.
   */
  redetect(): { ok: true } | { ok: false; code: 'busy' } {
    if (this.#stop.signal.aborted || this.#hardwareBusy()) return { ok: false, code: 'busy' };
    this.#start(true);
    return { ok: true };
  }

  /**
   * An encoder failed before its first frame (AC-ENGINE-03-3): the planner passes it over for the
   * rest of the session; the executor then plans the item again with the next one.
   */
  markDegraded(encoder: VideoEncoderId): void {
    if (this.#degraded.has(encoder)) return;
    this.#degraded.add(encoder);
    this.#emit();
  }

  /** What the chains resolve to now; before a detection, the CPU encoders. */
  resolvedEncoders(): ResolvedEncoders {
    return resolveEncoders(this.#plannerCaps());
  }

  defaults(): CapabilityDefaults {
    return { compressCodec: defaultCompressCodec(this.#plannerCaps()) };
  }

  /** The latest detection, every configuration with its verdict and where it came from. */
  report(): CapabilityReport | null {
    return this.#report;
  }

  /** Stops a detection in progress (its ffmpeg is ended) and waits for it; later calls answer `busy` and no listener is called again. */
  async dispose(): Promise<void> {
    this.#stop.abort();
    while (this.#running) await this.#running;
  }

  // ── Detection ──

  #start(force: boolean) {
    if (this.#stop.signal.aborted) return;
    if (this.#running) {
      if (force && !this.#runningForced) this.#forceNext = true;
      return;
    }
    this.#running = this.#loop(force).finally(() => { this.#running = null; });
  }

  async #loop(force: boolean) {
    let forced = force;
    for (;;) {
      this.#forceNext = false;
      this.#runningForced = forced;
      if (forced) this.#degraded.clear();
      await this.#detectOnce(forced);
      if (!this.#forceNext || this.#stop.signal.aborted) return;
      forced = true;
    }
  }

  async #detectOnce(force: boolean) {
    this.#state = 'detecting';
    this.#emit();
    let detected: Detected;
    try { detected = this.#override ? await this.#fromOverride(this.#override) : await this.#measure(force); }
    catch (error) {
      if (!(error instanceof MediaRuntimeError)) this.#log('The encoder capabilities could not be detected.', error);
      detected = { ok: false, code: error instanceof MediaRuntimeError ? error.code : 'unknown' };
    }
    if (detected.ok) {
      this.#measured = detected.measured;
      this.#state = 'ready';
    } else {
      this.#state = 'unavailable';
      this.#code = detected.code;
    }
    this.#emit();
  }

  async #fromOverride(override: MediaCapsOverride): Promise<Detected> {
    if (override.kind === 'unavailable') return { ok: false, code: override.code };
    const startedAt = this.#clock.now();
    await this.#runtime.acquire();
    if (override.kind === 'detecting') await this.#clock.delay(override.milliseconds, this.#stop.signal);
    const results = overrideResults(override.kind === 'nvenc' ? 'nvenc' : 'cpu_only');
    this.#report = { forced: false, startedAt, testMs: 0, key: null, results, persisted: false };
    return { ok: true, measured: { results, softwareEncoders: null } };
  }

  async #measure(force: boolean): Promise<Detected> {
    const startedAt = this.#clock.now();
    const tools = await this.#runtime.acquire();
    const software = await this.#listSoftware();
    if (!software.ok) return software;
    const missing = missingSoftware(software.value);
    if (missing.length) {
      this.#log(`The bundled ffmpeg lacks ${missing.join(', ')}.`);
      return { ok: false, code: 'runtime_invalid' };
    }
    const key: CapabilityCacheKey = { ffmpeg: tools.version, generation: tools.generation, gpus: gpuKeyOf(await this.#readGpuInfo()) };
    const kept = force ? {} : await this.#readCache(key);
    const work = path.join(tools.workingDirectory, `capabilities-${randomBytes(4).toString('hex')}`);
    let results: CapabilityProbeResult[];
    const testsStarted = this.#clock.monotonic();
    try {
      await mkdir(work, { recursive: true });
      results = await this.#test(software.value.encoders, kept, work, tools);
    } finally {
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => this.#log('The capability test folder could not be removed.', error));
    }
    const testMs = Math.round(this.#clock.monotonic() - testsStarted);
    const persisted = await this.#persist(key, results, kept);
    this.#report = { forced: force, startedAt, testMs, key, results, persisted };
    return { ok: true, measured: { results, softwareEncoders: software.value.encoders } };
  }

  /** `-encoders`, `-muxers`, `-filters` of the bundled ffmpeg. */
  async #listSoftware(): Promise<{ ok: true; value: SoftwareCapabilities } | { ok: false; code: EngineReasonCode }> {
    const lists: string[] = [];
    for (const flag of ['-encoders', '-muxers', '-filters']) {
      const result = await this.#runtime.run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', flag], {
        timeoutMs: CAPABILITY_POLICY.listTimeoutMs, stdoutMaxBytes: CAPABILITY_POLICY.listOutputBytes, stderrMaxBytes: 64 * 1024, signal: this.#stop.signal,
      });
      // A run cut short says nothing about the runtime: unknown, tried again with "detect again".
      if (result.aborted || result.timedOut) return { ok: false, code: 'unknown' };
      if (!completed(result)) return { ok: false, code: 'runtime_invalid' };
      lists.push(result.stdout.toString('utf8'));
    }
    return { ok: true, value: { encoders: parseEncoderList(lists[0]), muxers: parseMuxerList(lists[1]), filters: parseFilterList(lists[2]) } };
  }

  async #readGpuInfo(): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#gpuInfo(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), CAPABILITY_POLICY.gpuInfoTimeoutMs); }),
      ]);
    } catch (error) {
      this.#log('The graphics cards could not be read; kept verdicts last a week.', error);
      return null;
    } finally { clearTimeout(timer); }
  }

  /** The file as it is; null when there is none or it cannot be read. */
  async #readText(): Promise<string | null> {
    try { return await readFile(this.#file, 'utf8'); } catch { return null; }
  }

  /**
   * The kept verdicts valid for this key: none for another runtime, card or driver, and none older
   * than a week when the key has no drivers. A file that does not parse counts as empty.
   */
  async #readCache(key: CapabilityCacheKey): Promise<Record<string, CacheEntry>> {
    const text = await this.#readText();
    if (text === null) return {};
    let file: CacheFile;
    try { file = cacheFileSchema.parse(JSON.parse(text)); }
    catch (error) {
      this.#log('capabilities.json could not be read; every encoder is measured again.', error);
      return {};
    }
    if (!sameKey(file.key, key)) return {};
    if (keyHasDrivers(key)) return file.results;
    // A verdict from the future (the clock was set back) has no known age either.
    const now = this.#clock.now();
    return Object.fromEntries(Object.entries(file.results).filter(([, entry]) => entry.measuredAt <= now && now - entry.measuredAt <= CAPABILITY_POLICY.unkeyedLifetimeMs));
  }

  /**
   * Keeps the definitive verdicts of this detection (AC-ENGINE-03-2), the reused ones with their
   * first measurement time; `session_limit`, `unknown` and whatever the budget did not reach are left
   * out, so the next start measures them. Written only when it changed; a failed write only means
   * measuring again next time.
   */
  async #persist(key: CapabilityCacheKey, results: readonly CapabilityProbeResult[], kept: Record<string, CacheEntry>): Promise<boolean> {
    const now = this.#clock.now();
    const digests = new Map(capabilityCandidates().map(entry => [candidateKey(entry.encoder, entry.variant), argumentsDigest(entry.args)]));
    const entries: Record<string, CacheEntry> = {};
    for (const result of results) {
      const id = candidateKey(result.encoder, result.variant);
      const digest = digests.get(id);
      if (result.source === 'cached' && kept[id]) entries[id] = kept[id];
      else if (result.source === 'measured' && digest && DEFINITIVE_OUTCOMES.has(result.outcome)) {
        entries[id] = { args: digest, outcome: result.outcome as CacheEntry['outcome'], measuredAt: now, minimumDriver: result.minimumDriver };
      }
    }
    const file: CacheFile = { version: 1, key: { ...key, gpus: key.gpus && [...key.gpus] }, results: entries };
    const content = `${JSON.stringify(file, null, 2)}\n`;
    if ((await this.#readText()) === content) return false;
    try {
      await this.#write(this.#file, content);
      return true;
    } catch (error) {
      this.#log('capabilities.json could not be written.', error);
      return false;
    }
  }

  /** Every candidate in order: kept verdicts are reused, the rest measured while the budget lasts. */
  async #test(listed: ReadonlySet<string>, kept: Record<string, CacheEntry>, work: string, tools: MediaTools): Promise<CapabilityProbeResult[]> {
    const deadline = this.#clock.monotonic() + CAPABILITY_POLICY.budgetMs;
    const redact = createLogRedactor({ work: [work, tools.workingDirectory] });
    const results: CapabilityProbeResult[] = [];
    for (const entry of capabilityCandidates()) {
      const base = { encoder: entry.encoder, variant: entry.variant, hardware: entry.hardware, guard: entry.guard, durationMs: null, minimumDriver: null };
      if (!listed.has(entry.encoder)) {
        results.push({ ...base, outcome: 'runtime_missing', source: 'not_listed', detail: `${entry.encoder} is not in -encoders` });
        continue;
      }
      const cached = kept[candidateKey(entry.encoder, entry.variant)];
      if (cached && cached.args === argumentsDigest(entry.args)) {
        results.push({ ...base, outcome: cached.outcome, source: 'cached', detail: null, minimumDriver: cached.minimumDriver });
        continue;
      }
      const remaining = deadline - this.#clock.monotonic();
      if (remaining <= 0 || this.#stop.signal.aborted) {
        results.push({ ...base, outcome: 'unknown', source: 'skipped', detail: this.#stop.signal.aborted ? 'stopped' : 'the 30 s budget ran out' });
        continue;
      }
      results.push(await this.#probe(entry, work, Math.min(CAPABILITY_POLICY.probeTimeoutMs, remaining), redact));
    }
    return results;
  }

  /** One configuration: encode three frames, then read the output back. */
  async #probe(entry: CapabilityCandidate, work: string, limitMs: number, redact: (text: string) => string): Promise<CapabilityProbeResult> {
    const begin = this.#clock.monotonic();
    const elapsed = () => Math.round(this.#clock.monotonic() - begin);
    const verdict = (outcome: ConfigurationOutcome, detail: string | null, minimumDriver: string | null = null): CapabilityProbeResult => ({
      encoder: entry.encoder, variant: entry.variant, hardware: entry.hardware, guard: entry.guard, outcome, source: 'measured', durationMs: elapsed(),
      detail: detail === null ? null : redact(detail).trim().slice(0, CAPABILITY_POLICY.detailChars), minimumDriver,
    });
    const output = path.join(work, `probe-${entry.encoder}-${entry.variant}.mkv`);
    const encoded = await this.#runtime.run('ffmpeg', probeEncodeArgs(entry, output), {
      timeoutMs: limitMs, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: CAPABILITY_POLICY.stderrMaxBytes, signal: this.#stop.signal,
    });
    if (encoded.aborted) return verdict('unknown', 'stopped');
    if (encoded.timedOut) return verdict('unknown', `no answer within ${Math.round(limitMs)} ms`);
    const stderr = encoded.stderr.toString('utf8');
    if (!completed(encoded) || SILENT_SUBSTITUTION.test(stderr)) {
      const failure = classifyEncoderFailure(stderr);
      return verdict(failure.code, failure.line ?? `exit ${encoded.exitCode ?? encoded.status}`, failure.minimumDriver);
    }
    const left = Math.min(CAPABILITY_POLICY.verifyTimeoutMs, limitMs - elapsed());
    if (left <= 0) return verdict('unknown', 'no time left to read the output back');
    const checked = await this.#runtime.run('ffprobe', probeVerifyArgs(output), { timeoutMs: left, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 64 * 1024, signal: this.#stop.signal });
    if (checked.aborted) return verdict('unknown', 'stopped');
    const facts = completed(checked) ? readStreamFacts(checked.stdout.toString('utf8')) : null;
    if (!facts) return verdict('unknown', 'ffprobe could not read the output');
    const expected = expectedStream(entry.encoder, entry.variant);
    if (!streamMatches(expected, facts)) {
      const show = (value: EncodedStreamFacts) => `${value.codec}/${value.pixFmt}/${value.profile}`;
      return verdict('params_rejected', `wrote ${show(facts)}, expected ${show(expected)}`);
    }
    return verdict('available', null);
  }

  // ── Status ──

  /** The measured table with this session's degradations; CPU encoders only before a detection. */
  #plannerCaps(): PlannerCapabilities {
    const encoders = this.#measured ? measuredTable(this.#measured.results, this.#measured.softwareEncoders) : measuredTable([], null);
    return freezeCaps({ encoders, degraded: [...this.#degraded], nvencMin: NVENC_MIN_FRAME });
  }

  #runtimeStatus(): RuntimeStatus {
    const override = this.#override;
    if (override?.kind === 'unavailable') {
      const code = runtimeFailureCodeSchema.safeParse(override.code);
      if (code.success) return { state: 'unavailable', code: code.data };
    }
    return this.#runtime.status();
  }

  #capabilityStatus(): CapabilityStatus {
    if (this.#state === 'unverified' || this.#state === 'detecting') return { state: this.#state };
    if (this.#state === 'unavailable') return { state: 'unavailable', code: this.#code };
    const caps = this.#plannerCaps();
    const results = this.#measured?.results ?? [];
    const hardwareEncoders = VIDEO_ENCODERS.filter(encoder => !this.#degraded.has(encoder)
      && results.some(result => result.encoder === encoder && result.hardware && !result.guard && result.outcome === 'available'));
    const driverUpdates = new Map<HardwareEncoderFamily, string | null>();
    for (const result of results) {
      const family = familyOf(result.encoder);
      if (result.outcome !== 'driver_too_old' || family === null) continue;
      driverUpdates.set(family, driverUpdates.get(family) ?? result.minimumDriver);
    }
    return {
      state: 'ready',
      hardwareEncoders,
      degraded: VIDEO_ENCODERS.filter(encoder => this.#degraded.has(encoder)),
      driverUpdates: [...driverUpdates].map(([family, minimumVersion]) => ({ family, minimumVersion })),
      resolvedEncoders: resolveEncoders(caps),
      defaults: { compressCodec: defaultCompressCodec(caps) },
    };
  }

  #emit() {
    // After `dispose` the queue and the window it tells may be gone already.
    if (this.#stop.signal.aborted) return;
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch (error) { this.#log('An engine status listener failed.', error); }
    }
  }
}
