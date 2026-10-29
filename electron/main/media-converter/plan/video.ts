import type {
  CompressCodec, MaxShortSide, MediaInfo, PlanWarning, PlanWarningCode, Tier, VariantKey, VideoEncoderId, VideoStreamInfo,
} from '../../../../src/media-converter/contract';
import type { EncodeSpec, OptionPair, PlannerCapabilities } from './types';

/**
 * Video encoding (module-encode design §3, §4): the parameter tables, the three encoder chains
 * with their preconditions, the output size under the short-side limit, the encoder's pixel
 * format, and the picture's correctness (rotation, colour tags, range, HDR, Dolby Vision, VFR,
 * interlacing, chroma). Pure: the planner (`stream-plan.ts`) and the capability probe (`probeArgs`
 * in `args.ts`) build the encoder options from the same tables, so the probe tests exactly the
 * configuration production runs; only the source-dependent filters of §4 are the planner's own.
 */

// ── Parameter tables (design §3) ───────────────────────────────────────────────────────────────
// Initial values from public sources and measurements on the development machine; T-ENCODE-05
// calibrates them on real samples and writes the results back to design §3.

/**
 * Every encoder configuration as design §3 writes it. `{Q}` is the tier's quality value, `{G}` the
 * GOP in frames, `{P}` kvazaar's intra period and `{B}` openh264's bit rate in bit/s. A stream type
 * in a name (`-b:v`) is dropped when parsed: `toFfmpegArgs` adds the output stream to every name.
 * The `-pix_fmt` value is also the end of the stream's filter chain (design §4).
 */
const PARAMETER_TEXT = {
  libsvtav1: { '10bit': '-preset 6 -crf {Q} -pix_fmt yuv420p10le' },
  av1_nvenc: {
    // 10-bit input gives a 10-bit stream; `-highbitdepth` is for 8-bit input and is not used. No AQ.
    '10bit_uhq': '-preset p7 -tune uhq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -g {G} -pix_fmt p010le',
    '10bit': '-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -g {G} -pix_fmt p010le',
  },
  av1_qsv: { '10bit': '-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} -pix_fmt p010le' },
  av1_amf: { '10bit': '-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -align 1080p -g {G} -pix_fmt p010le' },
  hevc_nvenc: {
    // The driver refuses `-tune uhq` with `-bf 3` (it takes no -bf, 4 or 5), so uhq sets none.
    '10bit_uhq': '-preset p7 -tune uhq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -b_ref_mode middle -g {G} -profile:v main10 -pix_fmt p010le',
    '10bit': '-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} -profile:v main10 -pix_fmt p010le',
    '8bit_uhq': '-preset p7 -tune uhq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -b_ref_mode middle -g {G} -profile:v main -pix_fmt yuv420p',
    '8bit': '-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} -profile:v main -pix_fmt yuv420p',
  },
  hevc_qsv: {
    '10bit': '-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} -profile:v main10 -pix_fmt p010le',
    '8bit': '-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} -profile:v main -pix_fmt nv12',
  },
  hevc_amf: {
    '10bit': '-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} -profile:v main10 -pix_fmt p010le',
    '8bit': '-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} -profile:v main -pix_fmt nv12',
  },
  // Media Foundation hardware encoders take nv12 only; 10-bit is silently encoded as 8-bit.
  hevc_mf: { '8bit': '-hw_encoding 1 -rate_control quality -quality {Q} -g {G} -pix_fmt nv12' },
  // kvazaar takes its own options comma-separated, and frames whose sides are multiples of 8.
  libkvazaar: { '8bit': '-kvazaar-params preset=medium,qp={Q},period={P} -pix_fmt yuv420p' },
  h264_nvenc: { '8bit': '-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} -profile:v high -pix_fmt yuv420p' },
  h264_qsv: { '8bit': '-preset veryslow -global_quality {Q} -look_ahead 1 -look_ahead_depth 40 -g {G} -profile:v high -pix_fmt nv12' },
  h264_amf: { '8bit': '-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} -profile:v high -pix_fmt nv12' },
  h264_mf: {
    // Without a profile h264_mf writes Constrained Baseline; the named form `high` is refused.
    '8bit': '-hw_encoding 1 -rate_control quality -quality {Q} -profile:v 100 -g {G} -pix_fmt nv12',
    '8bit_sw': '-rate_control quality -quality {Q} -profile:v 100 -g {G} -pix_fmt nv12',
  },
  libopenh264: { '8bit': '-profile:v high -coder cabac -rc_mode bitrate -b:v {B} -g {G} -pix_fmt yuv420p' },
} as const satisfies Readonly<Record<VideoEncoderId, Partial<Record<VariantKey, string>>>>;

/** Quality first, balanced, size first. */
type PerTier = readonly [quality: number, balanced: number, size: number];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

/** All the numbers of design §3 in one place, for T-ENCODE-05 to calibrate. */
export const VIDEO_TABLE = deepFreeze({
  parameters: PARAMETER_TEXT,
  /** SVT-AV1 CRF by tier and output short side: ≤480, ≤720, ≤1080, ≤1440, >1440. */
  svtCrf: { quality: [24, 26, 28, 29, 30], balanced: [28, 30, 32, 33, 34], size: [34, 36, 38, 39, 40] } satisfies Record<Tier, number[]>,
  svtShortSideSteps: [480, 720, 1080, 1440],
  /**
   * `{Q}` of the other encoders per tier. Hardware encoders take these at 1080p and move them two
   * steps towards better quality for an output short side ≤ 720 and two towards smaller output
   * above 1440; which way is better follows the row (CQ, ICQ, QVBR and QP fall, MF quality rises).
   * QSV and AMF are provisional until calibrated on such a device.
   */
  quality: {
    av1_nvenc: [30, 34, 38], av1_qsv: [26, 30, 34], av1_amf: [22, 26, 30],
    hevc_nvenc: [24, 27, 30], hevc_qsv: [23, 26, 29], hevc_amf: [20, 23, 26], hevc_mf: [80, 70, 60], libkvazaar: [20, 23, 26],
    h264_nvenc: [21, 24, 27], h264_qsv: [21, 24, 27], h264_amf: [20, 23, 26], h264_mf: [80, 70, 60],
  } satisfies Partial<Record<VideoEncoderId, PerTier>>,
  hardwareStep: 2,
  hardwareStepBelow: 720,
  hardwareStepAbove: 1440,
  /** openh264 has no constant quality: B = min(bpp × width × height × fps, 0.7 × source video bit rate). */
  openh264BitsPerPixel: [0.12, 0.09, 0.065] satisfies PerTier,
  openh264SourceRatio: 0.7,
  /** A floor for B, so a starved source rate never asks openh264 for next to nothing. */
  openh264MinBitRate: 32_000,
  /** Keyframes about every 5 s: `-g round(5 × fps)`; kvazaar's period is the nearest multiple of 16. SVT keeps its own default (~5 s). */
  gopSeconds: 5,
  kvazaarPeriodMultiple: 16,
  /**
   * The pictures the NVIDIA encoders open (AC-ENCODE-02-2, design §7b; measured with the bundled
   * ffmpeg on an RTX 4070 Ti SUPER, and NVENC's own minimums): H.264 145 to 4096 wide, at least 49
   * high; HEVC at least 129 wide and 33 high; AV1 at least 129 wide and 65 high; at most 4096 a
   * side for H.264 and 8192 for HEVC and AV1. Outside it `InitializeEncoder` fails. The encoded
   * sides are even, so in practice H.264 starts at 146×50, HEVC at 130×34 and AV1 at 130×66. The
   * Media Foundation hardware encoders of that card are NVENC behind another API and refuse the
   * same pictures. An encoder that fails to open is degraded for the rest of the session
   * (AC-ENGINE-03-3), so the chain passes it over for such a picture instead. This table alone
   * decides (design §7b): it replaces the old "144 wide, 120 high", so the engine's `caps.nvencMin`
   * (that old sample) does not narrow it.
   */
  hardwareFrame: {
    av1: { minWidth: 129, minHeight: 65, maxSide: 8192 },
    hevc: { minWidth: 129, minHeight: 33, maxSide: 8192 },
    h264: { minWidth: 145, minHeight: 49, maxSide: 4096 },
  } satisfies Record<CompressCodec, { minWidth: number; minHeight: number; maxSide: number }>,
  /** openh264 refuses a picture of more than 4096 × 2304 pixels (measured: `width * height <= 9437184`). */
  openh264MaxPixels: 9_437_184,
  /** Frames per second assumed for the GOP and the openh264 rate when the source does not say. */
  fallbackFps: 30,
  /** Low-usage mode (engine queue option, applied at run time by `videoArgs`). */
  svtLowUsage: '-svtav1-params lp=1',
});

const TIER_INDEX: Readonly<Record<Tier, 0 | 1 | 2>> = { quality: 0, balanced: 1, size: 2 };

/** `'-b:v 0 -profile:v main10'` → `[['b', '0'], ['profile', 'main10']]`. */
export function parseParameters(text: string): OptionPair[] {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length % 2 !== 0) throw new TypeError(`Unpaired encoder option in "${text}"`);
  const pairs: OptionPair[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const [name, value] = [tokens[i], tokens[i + 1]];
    if (!/^-[a-z][\w-]*(?::v)?$/.test(name) || (value.startsWith('-') && !/^-\d/.test(value))) throw new TypeError(`Malformed encoder option "${name} ${value}"`);
    pairs.push([name.slice(1).replace(/:v$/, ''), value]);
  }
  return pairs;
}

const PARSED: Readonly<Partial<Record<VideoEncoderId, Partial<Record<VariantKey, readonly OptionPair[]>>>>> = Object.freeze(Object.fromEntries(
  Object.entries(PARAMETER_TEXT).map(([encoder, variants]) => [encoder, Object.fromEntries(
    Object.entries(variants).map(([variant, text]) => [variant, Object.freeze(parseParameters(text))]))]),
));
export const SVT_LOW_USAGE_PARAMS: readonly OptionPair[] = Object.freeze(parseParameters(VIDEO_TABLE.svtLowUsage));

const VARIANT_PREFERENCE: readonly VariantKey[] = ['10bit_uhq', '10bit', '8bit_uhq', '8bit', '8bit_sw'];
/** The configurations of an encoder the tables hold, in the order the chains prefer them (the probe candidates of engine design §3). */
export function encoderVariants(encoder: VideoEncoderId): VariantKey[] {
  const present = PARSED[encoder] ?? {};
  return VARIANT_PREFERENCE.filter(variant => present[variant] !== undefined);
}
export const variantBitDepth = (variant: VariantKey): 8 | 10 => variant.startsWith('10bit') ? 10 : 8;

// ── Encoders and chains (design §3) ────────────────────────────────────────────────────────────

type Family = 'nvenc' | 'qsv' | 'amf' | 'mf' | 'cpu';
const familyOf = (encoder: VideoEncoderId): Family => encoder.endsWith('_nvenc') ? 'nvenc' : encoder.endsWith('_qsv') ? 'qsv'
  : encoder.endsWith('_amf') ? 'amf' : encoder.endsWith('_mf') ? 'mf' : 'cpu';
/** The software encoders of the bundled runtime, which the capability probe does not test (engine design §3). */
const CPU_ENCODERS: ReadonlySet<VideoEncoderId> = new Set(['libsvtav1', 'libkvazaar', 'libopenh264']);
const isHardware = (encoder: VideoEncoderId, variant: VariantKey) => familyOf(encoder) !== 'cpu' && variant !== '8bit_sw';
/** Far weaker than x264/x265 would be: told before the start as `cpu_weak_encoder` (AC-ENCODE-02-2). */
export const isWeakCpuEncoder = (encoder: VideoEncoderId, variant: VariantKey) =>
  encoder === 'libkvazaar' || encoder === 'libopenh264' || (encoder === 'h264_mf' && variant === '8bit_sw');

interface ChainLink { encoder: VideoEncoderId; variants: readonly VariantKey[] }
const link = (encoder: VideoEncoderId, ...variants: VariantKey[]): ChainLink => Object.freeze({ encoder, variants: Object.freeze(variants) });

/**
 * The fallback chains in order. Within an encoder 10-bit comes first (Main10 when it passed the
 * probe), then the NVENC `uhq` tune before `hq`. AV1 with "use the graphics card" tries the
 * hardware encoders first and falls back to libsvtav1.
 */
export const VIDEO_CHAINS: Readonly<Record<CompressCodec | 'av1_gpu', readonly ChainLink[]>> = Object.freeze({
  av1: Object.freeze([link('libsvtav1', '10bit')]),
  av1_gpu: Object.freeze([link('av1_nvenc', '10bit_uhq', '10bit'), link('av1_qsv', '10bit'), link('av1_amf', '10bit'), link('libsvtav1', '10bit')]),
  hevc: Object.freeze([
    link('hevc_nvenc', '10bit_uhq', '10bit', '8bit_uhq', '8bit'), link('hevc_qsv', '10bit', '8bit'), link('hevc_amf', '10bit', '8bit'),
    link('hevc_mf', '8bit'), link('libkvazaar', '8bit'),
  ]),
  h264: Object.freeze([
    link('h264_nvenc', '8bit'), link('h264_qsv', '8bit'), link('h264_amf', '8bit'), link('h264_mf', '8bit'), link('h264_mf', '8bit_sw'), link('libopenh264', '8bit'),
  ]),
});

/**
 * Whether this configuration may be used: not degraded in this session, and measured to work.
 * The bundled CPU encoders are not probed, so they count as present unless the table says otherwise.
 */
export function isVariantAvailable(caps: PlannerCapabilities, encoder: VideoEncoderId, variant: VariantKey): boolean {
  if (caps.degraded.includes(encoder)) return false;
  const measured = caps.encoders[encoder]?.variants[variant];
  return CPU_ENCODERS.has(encoder) ? measured !== false : measured === true;
}

/**
 * The default output codec of "compress video" (AC-ENCODE-02-7, Q-01 option B): HEVC when any
 * HEVC hardware configuration of the chain works here (8- or 10-bit, not degraded in this
 * session), else H.264. Only configurations the chain can pick count, so the default never
 * promises a hardware encoder that would then fall through to libkvazaar. AV1 is only ever the
 * user's own choice.
 */
export function defaultCompressCodec(caps: PlannerCapabilities): CompressCodec {
  const hardware = VIDEO_CHAINS.hevc.some(({ encoder, variants }) => variants.some(variant => isHardware(encoder, variant) && isVariantAvailable(caps, encoder, variant)));
  return hardware ? 'hevc' : 'h264';
}

// ── Output size (design §4) ────────────────────────────────────────────────────────────────────

export interface FrameSize { width: number; height: number }

/** The picture as players show it, which is what the filters see (ffmpeg rotates while decoding): 90° and 270° swap the sides. */
export const shownSize = (video: Pick<VideoStreamInfo, 'width' | 'height' | 'rotation'>): FrameSize =>
  video.rotation === 90 || video.rotation === 270 ? { width: video.height, height: video.width } : { width: video.width, height: video.height };

/**
 * The encoded size (AC-ENCODE-02-3): the short side of the shown picture brought down to the
 * limit, the long side in proportion, never enlarged, each side a multiple of 2 (kvazaar: 8,
 * rounding down, so at most 7 pixels are lost). The pixel aspect ratio is not touched: `scale`
 * keeps the display aspect of an anamorphic source. Null when the size is unknown or too small.
 */
export function outputSize(shown: FrameSize, maxShortSide: MaxShortSide | null, multiple: 2 | 8): FrameSize | null {
  const { width, height } = shown;
  if (!(width > 0 && height > 0)) return null;
  const floorTo = (value: number) => Math.floor(value / multiple) * multiple;
  const short = Math.min(width, height), long = Math.max(width, height);
  let outShort = short, outLong = long;
  if (maxShortSide !== null && short > maxShortSide) {
    outShort = maxShortSide;
    const exact = long * maxShortSide / short;
    // The nearest multiple, but never past the source's own side.
    outLong = multiple === 2 ? Math.min(Math.round(exact / 2) * 2, floorTo(long)) : floorTo(exact);
  }
  const result = width <= height ? { width: floorTo(outShort), height: floorTo(outLong) } : { width: floorTo(outLong), height: floorTo(outShort) };
  return result.width >= multiple && result.height >= multiple ? result : null;
}

/**
 * The `scale` of design §4: to `size` when given, with `options` after it (the range conversion
 * of a full-range source, the matrix of an RGB source). Without a size it only converts.
 */
export function scaleFilter(size: FrameSize | null, options: readonly string[] = []): string {
  const resize = size ? [`w=${size.width}`, `h=${size.height}`, 'flags=lanczos+accurate_rnd+full_chroma_int'] : [];
  return `scale=${[...resize, ...options].join(':')}`;
}

// ── Chain choice (design §3) ───────────────────────────────────────────────────────────────────

/** What one video encode is asked to do: the codec, tier and size limit of the task. */
export interface VideoRequest {
  codec: CompressCodec;
  tier: Tier;
  maxShortSide: MaxShortSide | null;
  /** AV1 only: try the hardware AV1 encoders first ("use the graphics card"). */
  useGpuForAv1: boolean;
}

interface Chosen {
  encoder: VideoEncoderId;
  variant: VariantKey;
  /** The encoded size; null when the source does not say (then no scaling, and no encoder that needs the size). */
  size: FrameSize | null;
}

/**
 * Whether NVENC and the Media Foundation hardware encoders open a picture of this size for this
 * codec: exactly the measured range of AC-ENCODE-02-2 (`VIDEO_TABLE.hardwareFrame`).
 */
export function hardwareFrameFits(codec: CompressCodec, size: FrameSize): boolean {
  const range = VIDEO_TABLE.hardwareFrame[codec];
  return size.width >= range.minWidth && size.height >= range.minHeight && size.width <= range.maxSide && size.height <= range.maxSide;
}
/** Whether openh264 takes a picture of this size: at most 4096 × 2304 pixels in all (AC-ENCODE-02-2). */
export const openh264Fits = (size: FrameSize) => size.width * size.height <= VIDEO_TABLE.openh264MaxPixels;

/**
 * The size precondition of a configuration (AC-ENCODE-02-2, design §7b): NVENC and the Media
 * Foundation hardware encoders take the codec's measured range (`hardwareFrameFits`), NVENC nothing
 * when the size is unknown; kvazaar a size it rounds down to multiples of 8 (`outputSize`), so not
 * an unknown one; openh264 at most its measured area. The others take any size.
 */
function takesSize(encoder: VideoEncoderId, variant: VariantKey, codec: CompressCodec, size: FrameSize | null): boolean {
  if (encoder === 'libkvazaar') return size !== null;
  if (encoder === 'libopenh264') return size === null || openh264Fits(size);
  const family = familyOf(encoder);
  if (family !== 'nvenc' && !(family === 'mf' && isHardware(encoder, variant))) return true;
  if (size === null) return family !== 'nvenc';
  return hardwareFrameFits(codec, size);
}

/**
 * The first configuration of the chain that is available, not degraded and takes the encoded
 * size (`takesSize`). With `tenBit` only 10-bit configurations qualify (an HDR source kept as HDR).
 */
function firstUsable(chain: readonly ChainLink[], shown: FrameSize, request: VideoRequest, caps: PlannerCapabilities, tenBit: boolean): Chosen | null {
  for (const { encoder, variants } of chain) {
    for (const variant of variants) {
      if (tenBit && variantBitDepth(variant) !== 10) continue;
      if (!isVariantAvailable(caps, encoder, variant)) continue;
      const size = outputSize(shown, request.maxShortSide, encoder === 'libkvazaar' ? 8 : 2);
      if (!takesSize(encoder, variant, request.codec, size)) continue;
      return { encoder, variant, size };
    }
  }
  return null;
}

const chainOf = (codec: CompressCodec, useGpuForAv1: boolean) => codec === 'av1' && useGpuForAv1 ? VIDEO_CHAINS.av1_gpu : VIDEO_CHAINS[codec];

/**
 * An HDR source keeps its HDR only through a 10-bit encode (design §3, §4), so it first looks for a
 * 10-bit configuration along the whole chain; without one it takes the chain as usual and is tone
 * mapped (`pictureHandling`). Other sources, a Dolby Vision one with an SDR base layer included,
 * take the chain as usual.
 */
function choose(video: VideoStreamInfo, request: VideoRequest, caps: PlannerCapabilities): Chosen | null {
  const chain = chainOf(request.codec, request.useGpuForAv1);
  const shown = shownSize(video);
  return (dynamicRangeOf(video) !== 'sdr' ? firstUsable(chain, shown, request, caps, true) : null) ?? firstUsable(chain, shown, request, caps, false);
}

// ── Parameters ─────────────────────────────────────────────────────────────────────────────────

const shortSideOf = (size: FrameSize | null) => size ? Math.min(size.width, size.height) : null;

/** The tier's `{Q}` for this output: SVT by short side, hardware encoders moved two steps from their 1080p value. */
export function qualityValue(encoder: VideoEncoderId, variant: VariantKey, tier: Tier, shortSide: number | null): number {
  const side = shortSide ?? 1080;
  if (encoder === 'libsvtav1') {
    const bucket = VIDEO_TABLE.svtShortSideSteps.findIndex(limit => side <= limit);
    return VIDEO_TABLE.svtCrf[tier][bucket === -1 ? VIDEO_TABLE.svtShortSideSteps.length : bucket];
  }
  const values: PerTier | undefined = (VIDEO_TABLE.quality as Readonly<Partial<Record<VideoEncoderId, PerTier>>>)[encoder];
  if (!values) throw new TypeError(`${encoder} has no quality value`);
  const base = values[TIER_INDEX[tier]];
  if (!isHardware(encoder, variant) || shortSide === null) return base;
  // Which way is better follows the row: the quality-first value is the better one.
  const better = Math.sign(values[0] - values[2]) * VIDEO_TABLE.hardwareStep;
  if (side <= VIDEO_TABLE.hardwareStepBelow) return base + better;
  if (side > VIDEO_TABLE.hardwareStepAbove) return base - better;
  return base;
}

/** `-g`: keyframes about every 5 s. */
export const gopFrames = (fps: number) => Math.max(1, Math.round(VIDEO_TABLE.gopSeconds * fps));
/** kvazaar's intra period: the multiple of 16 nearest to 5 s. */
export const kvazaarPeriod = (fps: number) => Math.max(1, Math.round(VIDEO_TABLE.gopSeconds * fps / VIDEO_TABLE.kvazaarPeriodMultiple)) * VIDEO_TABLE.kvazaarPeriodMultiple;

/** The source's video bit rate: the stream's, else the container's less the audio that states one; null when unknown. */
function sourceVideoBitRate(video: VideoStreamInfo, media: MediaInfo): number | null {
  if (video.bitRate !== null && video.bitRate > 0) return video.bitRate;
  if (media.bitRate === null) return null;
  const rest = media.bitRate - media.audio.reduce((sum, stream) => sum + (stream.bitRate ?? 0), 0);
  return rest > 0 ? rest : null;
}

/** openh264's `{B}`: bits per pixel of the output, at most 70 % of the source video rate. */
export function openh264BitRate(tier: Tier, size: FrameSize | null, fps: number, sourceBitRate: number | null): number {
  const pixels = size ? size.width * size.height : 1920 * 1080;
  const target = VIDEO_TABLE.openh264BitsPerPixel[TIER_INDEX[tier]] * pixels * fps;
  const capped = sourceBitRate === null ? target : Math.min(target, VIDEO_TABLE.openh264SourceRatio * sourceBitRate);
  return Math.max(VIDEO_TABLE.openh264MinBitRate, Math.round(capped));
}

/** The values a configuration's placeholders take for one output. */
export interface EncodeValues { quality: number | null; gop: number; period: number; bitRate: number | null }

/** One configuration's options with its placeholders filled in. */
export function encoderParameters(encoder: VideoEncoderId, variant: VariantKey, values: EncodeValues): OptionPair[] {
  const template = PARSED[encoder]?.[variant];
  if (!template) throw new TypeError(`${encoder} has no ${variant} configuration`);
  const fill: Record<string, number | null> = { Q: values.quality, G: values.gop, P: values.period, B: values.bitRate };
  return template.map(([name, value]): OptionPair => [name, value.replace(/\{([A-Z])\}/g, (_match, key: string) => {
    const filled = fill[key];
    if (filled === null || filled === undefined) throw new TypeError(`${encoder} ${variant}: no value for {${key}}`);
    return String(filled);
  })]);
}

/** The pixel format a configuration encodes from: its `-pix_fmt` (design §4 table). */
export function encoderPixelFormat(encoder: VideoEncoderId, variant: VariantKey): string {
  const pixFmt = PARSED[encoder]?.[variant]?.find(([name]) => name === 'pix_fmt')?.[1];
  if (!pixFmt) throw new TypeError(`${encoder} ${variant} has no pixel format`);
  return pixFmt;
}

// ── Picture correctness (design §4, R-ENCODE-03) ───────────────────────────────────────────────
// Measured with the bundled ffmpeg 8.1.2 while implementing T-ENCODE-03 (records/i1/T-ENCODE-03.md):
// - The encoders take the colour tags from the frames, and libsvtav1 drops the `-color_*` output
//   options, so `setparams` writes them last; it relabels and does not convert.
// - An RGB source reaches Y'CbCr through swscale's BT.601 unless `scale` is given the matrix, so
//   an HD RGB picture tagged BT.709 would shift colour.
// - zscale finishes the tone mapping in RGB float; a `scale` right after it would convert that to
//   Y'CbCr with swscale instead (Y about 4 % darker), so zscale is pinned to planar Y'CbCr first.
// - zscale cannot tone map a picture without transfer, primaries or matrix ("no path between
//   colorspaces"); `pin` also needs `p`, because the output primaries default to the frame's.
// - The mastering display and content light metadata follow the frames into the output, also
//   into a tone-mapped SDR file, and `tonemap` reads its peak from them; they are removed after it.

/** How the picture's light is coded: SDR, or HDR with the PQ (HDR10) or HLG transfer. */
export type DynamicRange = 'sdr' | 'pq' | 'hlg';
const HDR_TRANSFER: Readonly<Record<Exclude<DynamicRange, 'sdr'>, string>> = { pq: 'smpte2084', hlg: 'arib-std-b67' };

/**
 * The dynamic range of the picture ffmpeg decodes: HDR10 and HLG as probed; for Dolby Vision the
 * base layer's, by its transfer, else by its compatibility id (1 HDR10, 6 the HDR10 base of a UHD
 * Blu-ray, 4 HLG; 2 is SDR).
 */
export function dynamicRangeOf(video: Pick<VideoStreamInfo, 'colorTransfer' | 'hdr'>): DynamicRange {
  if (video.hdr.format === 'hdr10' || video.colorTransfer === HDR_TRANSFER.pq) return 'pq';
  if (video.hdr.format === 'hlg' || video.colorTransfer === HDR_TRANSFER.hlg) return 'hlg';
  const dolbyVision = video.hdr.dolbyVision;
  if (video.colorTransfer !== null || dolbyVision === null) return 'sdr';
  return dolbyVision.compatibilityId === 4 ? 'hlg' : dolbyVision.compatibilityId === 1 || dolbyVision.compatibilityId === 6 ? 'pq' : 'sdr';
}

/**
 * Dolby Vision whose base layer does not show correctly by itself: profile 5 (IPTPQc2) or
 * compatibility id 0. A re-encode would keep only that layer with wrong colours, so it is refused
 * (AC-ENCODE-03-4); copying it as it is stays possible.
 */
export function isUnsupportedDolbyVision(video: Pick<VideoStreamInfo, 'hdr'>): boolean {
  const dolbyVision = video.hdr.dolbyVision;
  return dolbyVision !== null && (!dolbyVision.compatible || dolbyVision.profile === 5 || dolbyVision.compatibilityId === 0);
}

const INTERLACED_ORDERS: ReadonlySet<string> = new Set(['tt', 'bb', 'tb', 'bt']);
/** The probed field order says interlaced (I1 trusts the flag; detection with idet is I3). */
export const isInterlaced = (video: Pick<VideoStreamInfo, 'fieldOrder'>) => video.fieldOrder !== null && INTERLACED_ORDERS.has(video.fieldOrder);

/** `num/den` as a number; null when absent or zero. */
function frameRate(text: string | null): number | null {
  const match = text ? /^(\d+)\/(\d+)$/.exec(text) : null;
  return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}
/** Two rates are the same within 0.5 %, as the probe compares them for `isVfr`. */
const RATE_TOLERANCE = 0.005;

/**
 * A variable frame rate, whose timestamps the output keeps (`-fps_mode passthrough`,
 * AC-ENCODE-03-5): the probe's `isVfr`, except an interlaced source whose base rate is about twice
 * its average (design §7a). That base rate is the field rate of a constant-rate source.
 */
export function isVariableFrameRate(video: Pick<VideoStreamInfo, 'isVfr' | 'fieldOrder' | 'rFrameRate' | 'avgFrameRate'>): boolean {
  if (!video.isVfr) return false;
  const base = frameRate(video.rFrameRate), average = frameRate(video.avgFrameRate);
  return !(isInterlaced(video) && base !== null && average !== null && Math.abs(base - 2 * average) / base <= RATE_TOLERANCE);
}

/** RGB and palette pixel formats: they reach Y'CbCr through a matrix the source does not name. */
const RGB_PIXEL_FORMAT = /^(?:gbr|rgb|bgr|argb|abgr|0rgb|0bgr|x2rgb|x2bgr|pal8)/;
const isRgb = (video: Pick<VideoStreamInfo, 'colorSpace' | 'pixFmt'>) => video.colorSpace === 'gbr' || (video.pixFmt !== null && RGB_PIXEL_FORMAT.test(video.pixFmt));
/**
 * Full range (AC-ENCODE-03-2): tagged `pc`, or a `yuvj*` format, which swscale reads as full range
 * whatever the container says; a `yuvj420p` MJPEG tagged `tv` and left unconverted measured YMAX 1023.
 */
const isFullRange = (video: Pick<VideoStreamInfo, 'colorRange' | 'pixFmt'>) => video.colorRange === 'pc' || (video.pixFmt?.startsWith('yuvj') ?? false);

/** Chroma layouts with more chroma than 4:2:0, which lose detail in it (`chroma_subsampled`); RGB is probed as 4:4:4. */
const RICHER_CHROMA: ReadonlySet<string> = new Set(['422', '444', '440']);

/**
 * The tag values `setparams` takes and the encoders can write (H.273 codes). Anything else (RGB's
 * `gbr`, the ffmpeg-only `vgamut`/`vlog`, newer matrices the encoders do not know) counts as
 * untagged and is inferred.
 */
const TAG_VALUES = {
  primaries: new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'film', 'bt2020', 'smpte428', 'smpte431', 'smpte432', 'jedec-p22', 'ebu3213']),
  transfer: new Set([
    'bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'linear', 'log100', 'log316', 'iec61966-2-4', 'bt1361e', 'iec61966-2-1',
    'bt2020-10', 'bt2020-12', 'smpte2084', 'smpte428', 'arib-std-b67',
  ]),
  matrix: new Set(['bt709', 'fcc', 'bt470bg', 'smpte170m', 'smpte240m', 'ycgco', 'bt2020nc', 'bt2020c', 'smpte2085', 'chroma-derived-nc', 'chroma-derived-c', 'ictcp']),
} as const satisfies Record<string, ReadonlySet<string>>;
const tagOf = (value: string | null, kind: keyof typeof TAG_VALUES) => value !== null && TAG_VALUES[kind].has(value) ? value : null;

/**
 * An untagged SDR picture (AC-ENCODE-03-2, design §7b): BT.709 when the shown picture is at least
 * 1280 wide or more than 576 high, else BT.601 (`smpte170m`); BT.709 when its size is unknown. This
 * is the guess of mpv and most players: a 1280×544 scope crop of 720p is HD, 720×576 and 1024×576
 * (PAL, anamorphic or not) are SD, a 768×1280 portrait clip is HD.
 */
const HD_MIN_WIDTH = 1280;
const SD_MAX_HEIGHT = 576;
export function inferredSdrTag(shown: FrameSize): string {
  if (!(shown.width > 0 && shown.height > 0)) return 'bt709';
  return shown.width >= HD_MIN_WIDTH || shown.height > SD_MAX_HEIGHT ? 'bt709' : 'smpte170m';
}

/** What `setparams` writes: colour primaries, transfer and matrix; the range is always limited (`tv`). */
export interface ColorTags { primaries: string; transfer: string; matrix: string }

/** What design §4 does to one source's picture before the chosen configuration encodes it. */
export interface PictureHandling {
  /** `bwdif` on the frames flagged interlaced. */
  deinterlace: boolean;
  /** The source's dynamic range, and whether its HDR is kept (10-bit configuration) or tone mapped to SDR BT.709. */
  dynamicRange: DynamicRange;
  hdr: 'none' | 'keep' | 'tonemap';
  /** Tone mapping only: what the first zscale is told because the source does not tag it (`tin`, `pin` with `p`, `min`, `rin`). */
  tonemapInput: readonly string[];
  /** Full range (`pc`, or a `yuvj*` format): `scale` brings it to limited range, scaled or not. */
  fullRange: boolean;
  /** An RGB source: the matrix `scale` converts it with, the one `setparams` writes. */
  rgbMatrix: string | null;
  tags: ColorTags;
  /** 4:2:2, 4:4:4 (RGB too) or 4:4:0 brought to 4:2:0. */
  chromaSubsampled: boolean;
  /** `-fps_mode passthrough`: the source's own timestamps. */
  passthrough: boolean;
  /** Dolby Vision profile 7/8 encoded from its base layer: the RPU is not carried (libsvtav1 `-dolbyvision 0`). */
  dropDolbyVision: boolean;
}

/**
 * Decides design §4 for one source and the configuration chosen for it (AC-ENCODE-03-2 to 03-5):
 * - colour tags copied from the source, an untagged one inferred from the size (HDR kept: BT.2020
 *   with its transfer; tone mapped: BT.709);
 * - HDR10/HLG kept on a 10-bit configuration, otherwise tone mapped;
 * - full range converted, interlaced deinterlaced, variable rates passed through;
 * - the Dolby Vision RPU dropped.
 * The source must not be an unsupported Dolby Vision one (`isUnsupportedDolbyVision`).
 */
export function pictureHandling(video: VideoStreamInfo, variant: VariantKey): PictureHandling {
  const dynamicRange = dynamicRangeOf(video);
  const hdr = dynamicRange === 'sdr' ? 'none' : variantBitDepth(variant) === 10 ? 'keep' : 'tonemap';
  const rgb = isRgb(video);
  const source = { primaries: tagOf(video.colorPrimaries, 'primaries'), transfer: tagOf(video.colorTransfer, 'transfer'), matrix: rgb ? null : tagOf(video.colorSpace, 'matrix') };
  let tags: ColorTags;
  if (dynamicRange === 'sdr') {
    const inferred = inferredSdrTag(shownSize(video));
    tags = { primaries: source.primaries ?? inferred, transfer: source.transfer ?? inferred, matrix: source.matrix ?? inferred };
  } else if (hdr === 'keep') {
    tags = { primaries: source.primaries ?? 'bt2020', transfer: HDR_TRANSFER[dynamicRange], matrix: source.matrix ?? 'bt2020nc' };
  } else {
    tags = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' };
  }
  const fullRange = isFullRange(video);
  const tonemapInput: string[] = [];
  if (hdr === 'tonemap' && dynamicRange !== 'sdr') {
    if (source.transfer === null) tonemapInput.push(`tin=${HDR_TRANSFER[dynamicRange]}`);
    if (source.primaries === null) tonemapInput.push('pin=bt2020', 'p=bt2020');
    // An RGB picture is read as RGB (its frames say `gbr`); a matrix would make zscale read it as Y'CbCr.
    if (source.matrix === null && !rgb) tonemapInput.push('min=bt2020nc');
    // The range is stated unless the frames say limited and are: full range (a `yuvj*` format whatever its tag), or unknown read as limited.
    if (fullRange) tonemapInput.push('rin=pc');
    else if (video.colorRange !== 'tv') tonemapInput.push('rin=tv');
  }
  return {
    deinterlace: isInterlaced(video),
    dynamicRange, hdr, tonemapInput,
    fullRange,
    rgbMatrix: rgb && hdr !== 'tonemap' ? tags.matrix : null,
    tags,
    chromaSubsampled: video.chromaSubsampling !== null && RICHER_CHROMA.has(video.chromaSubsampling),
    passthrough: isVariableFrameRate(video),
    dropDolbyVision: video.hdr.dolbyVision !== null,
  };
}

const DEINTERLACE = 'bwdif=mode=send_frame:parity=auto:deint=interlaced';
/** After the first zscale: the tone mapping of design §4, then the HDR metadata that described the source removed. */
const TONEMAP_TAIL: readonly string[] = [
  'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv',
  'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA', 'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
];
/** The planar Y'CbCr format of a bit depth, which zscale writes directly (it writes no nv12/p010). */
const planarFormat = (pixFmt: string) => /10/.test(pixFmt) ? 'yuv420p10le' : 'yuv420p';
const setparams = (tags: ColorTags) => `setparams=color_primaries=${tags.primaries}:color_trc=${tags.transfer}:colorspace=${tags.matrix}:range=tv`;

/**
 * The filter chain in the order of design §4: deinterlace → tone map → scale (resize, odd-size fix,
 * full range or RGB) → the encoder's pixel format → `setparams`. Rotation is ffmpeg's autorotate,
 * before all of them; the sizes already are the shown picture's.
 */
export function pictureFilters(picture: PictureHandling, shown: FrameSize, size: FrameSize | null, pixFmt: string): string[] {
  const filters: string[] = [];
  if (picture.deinterlace) filters.push(DEINTERLACE);
  if (picture.hdr === 'tonemap') {
    filters.push(`zscale=${['t=linear', 'npl=100', ...picture.tonemapInput].join(':')}`, ...TONEMAP_TAIL, `format=${planarFormat(pixFmt)}`);
  }
  const resized = size !== null && (size.width !== shown.width || size.height !== shown.height);
  // A tone-mapped picture already is limited-range BT.709 Y'CbCr.
  const conversion = picture.hdr === 'tonemap' ? [] : [
    ...(picture.fullRange ? ['in_range=pc', 'out_range=tv'] : picture.rgbMatrix ? ['out_range=tv'] : []),
    ...(picture.rgbMatrix ? [`out_color_matrix=${picture.rgbMatrix}`] : []),
  ];
  if (resized || conversion.length) filters.push(scaleFilter(resized ? size : null, conversion));
  if (filters.at(-1) !== `format=${pixFmt}`) filters.push(`format=${pixFmt}`);
  filters.push(setparams(picture.tags));
  return filters;
}

/**
 * The encode of one configuration for a picture of `size` at `fps` frames per second: the filled
 * table options, the filters and what the output cap needs. `probeArgs` uses it with the probe
 * picture and no `picture` (scaling when the size changes, then the pixel format); the planner with
 * the source and its `pictureHandling`, which adds the filters of design §4 and the options
 * `-dolbyvision 0` (libsvtav1 from Dolby Vision) and `-fps_mode passthrough` (variable rate).
 * An unknown rate takes 30 fps for the GOP and the openh264 rate, and stays unknown for the output
 * cap, which assumes a generous rate of its own.
 */
export function videoEncodeSpec(encoder: VideoEncoderId, variant: VariantKey, tier: Tier, shown: FrameSize, size: FrameSize | null, fps: number | null,
  sourceBitRate: number | null, picture: PictureHandling | null = null): EncodeSpec {
  const rate = fps ?? VIDEO_TABLE.fallbackFps;
  const bitRate = encoder === 'libopenh264' ? openh264BitRate(tier, size, rate, sourceBitRate) : null;
  const quality = encoder === 'libopenh264' ? null : qualityValue(encoder, variant, tier, shortSideOf(size));
  const params = encoderParameters(encoder, variant, { quality, gop: gopFrames(rate), period: kvazaarPeriod(rate), bitRate });
  const pixFmt = encoderPixelFormat(encoder, variant);
  let filters: string[];
  if (picture) {
    filters = pictureFilters(picture, shown, size, pixFmt);
    if (picture.dropDolbyVision && encoder === 'libsvtav1') params.push(['dolbyvision', '0']);
    if (picture.passthrough) params.push(['fps_mode', 'passthrough']);
  } else {
    const scaled = size !== null && (size.width !== shown.width || size.height !== shown.height);
    filters = [...(scaled ? [scaleFilter(size)] : []), `format=${pixFmt}`];
  }
  return { encoder, variant, params, filters, maxBitRate: bitRate, frame: size ? { ...size, fps } : null };
}

// ── Plan ───────────────────────────────────────────────────────────────────────────────────────

export type VideoPlan =
  | { ok: true; encode: EncodeSpec; warnings: PlanWarning[] }
  | { ok: false; reason: 'no_encoder_available' | 'dolby_vision_p5_unsupported'; alternatives: CompressCodec[] };

const CODECS: readonly CompressCodec[] = ['av1', 'hevc', 'h264'];

/**
 * The main video's encode for a codec, tier and size limit (AC-ENCODE-02-1 to 02-3, 01-7): the
 * first usable encoder of the chain with its table parameters, with `cpu_weak_encoder` for the
 * weak CPU encoders and `encoder_fallback` (to libsvtav1) when no hardware AV1 encoder was usable;
 * and the picture's correctness of design §4 (AC-ENCODE-03-1 to 03-5) with `hdr_tonemapped`,
 * `dolby_vision_rpu_dropped` and `chroma_subsampled` where they apply.
 * Errors, without arguments: `dolby_vision_p5_unsupported` for Dolby Vision without a compatible
 * base layer (nothing else would work: no alternatives); `no_encoder_available` and the codecs that
 * would work instead.
 */
export function planVideoEncode(video: VideoStreamInfo, media: MediaInfo, request: VideoRequest, caps: PlannerCapabilities): VideoPlan {
  if (isUnsupportedDolbyVision(video)) return { ok: false, reason: 'dolby_vision_p5_unsupported', alternatives: [] };
  const pick = choose(video, request, caps);
  if (!pick) {
    const alternatives = CODECS.filter(codec => codec !== request.codec && choose(video, { ...request, codec }, caps) !== null);
    return { ok: false, reason: 'no_encoder_available', alternatives };
  }
  const picture = pictureHandling(video, pick.variant);
  const encode = videoEncodeSpec(pick.encoder, pick.variant, request.tier, shownSize(video), pick.size, video.fps, sourceVideoBitRate(video, media), picture);
  const warnings: PlanWarning[] = [];
  const add = (code: PlanWarningCode) => warnings.push({ code, streams: [video.index], count: 1 });
  if (isWeakCpuEncoder(pick.encoder, pick.variant)) add('cpu_weak_encoder');
  if (request.codec === 'av1' && request.useGpuForAv1 && familyOf(pick.encoder) === 'cpu') {
    warnings.push({ code: 'encoder_fallback', streams: [video.index], count: 1, to: pick.encoder });
  }
  if (picture.hdr === 'tonemap') add('hdr_tonemapped');
  if (picture.dropDolbyVision) add('dolby_vision_rpu_dropped');
  if (picture.chromaSubsampled) add('chroma_subsampled');
  return { ok: true, encode, warnings };
}

/** The picture the capability probe encodes (engine design §3: `color=black:s=1280x720:r=30`, 3 frames). */
export const PROBE_PICTURE = Object.freeze({ width: 1280, height: 720, fps: 30 });

/** The probe picture as the planner would read it: progressive, constant rate, limited range, untagged SDR 4:2:0 (lavfi `color`). */
const PROBE_VIDEO = deepFreeze<VideoStreamInfo>({
  index: 0, typeIndex: 0, codec: 'rawvideo', profile: null, pixFmt: 'yuv420p', bitDepth: 8, chromaSubsampling: '420',
  width: PROBE_PICTURE.width, height: PROBE_PICTURE.height, sampleAspectRatio: '1:1', rFrameRate: `${PROBE_PICTURE.fps}/1`, avgFrameRate: `${PROBE_PICTURE.fps}/1`,
  fps: PROBE_PICTURE.fps, isVfr: false, rotation: 0, colorPrimaries: null, colorTransfer: null, colorSpace: null, colorRange: 'tv', fieldOrder: 'progressive',
  bitRate: null, durationUs: null, language: null, title: null, default: true, hdr: { format: 'none', dolbyVision: null, masteringDisplay: null, contentLight: null },
});

/**
 * The production encode of one configuration for the probe picture, at the balanced tier: the
 * table options and the filters of design §4 the planner gives such a picture (its pixel format,
 * then `setparams` with BT.709 inferred for 720p), so the probe runs what a plain HD source runs.
 */
export function probeEncodeSpec(encoder: VideoEncoderId, variant: VariantKey): EncodeSpec {
  const size = { width: PROBE_PICTURE.width, height: PROBE_PICTURE.height };
  return videoEncodeSpec(encoder, variant, 'balanced', size, outputSize(size, null, encoder === 'libkvazaar' ? 8 : 2), PROBE_PICTURE.fps, null,
    pictureHandling(PROBE_VIDEO, variant));
}
