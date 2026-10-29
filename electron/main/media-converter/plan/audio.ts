import type {
  AudioEncoderId, AudioFormat, AudioStreamInfo, ConversionSettings, OutputContainer, PlanWarning, Tier, VideoContainer,
} from '../../../../src/media-converter/contract';
import { canCopyAudio } from './matrix';
import type { EncodeSpec, OptionPair } from './types';

/**
 * Audio (module-encode design §5, R-ENCODE-04/05): the audio format tables, the bit rates of
 * audio inside a video, when a track is copied (same codec, the passthrough rules of "convert" and
 * "compress"), the channel layout and sample rate each encoder is given, the bit depth of the
 * lossless formats, what "extract audio" writes a track as, and the tags written over the copied
 * source tags. Pure: the planner (`stream-plan.ts`) asks it about one source track at a time.
 *
 * Measured with the bundled ffmpeg 8.1.2 while implementing T-ENCODE-04 (records/i1/T-ENCODE-04.md):
 * - libopus refuses every layout but the Vorbis one of its channel count (5.1(side) included) and
 *   more than 8 channels; it resamples to 48 kHz by itself.
 * - aac takes most layouts up to 8 channels, but writes 5.0(side), 5.1(side) and 7.1(wide) with
 *   channelConfiguration 0 and a PCE, which many players do not read; relabelled, the same samples
 *   get the standard configuration 5, 6 and 7. It refuses layouts with height channels (5.1.2...).
 * - alac, left to ffmpeg's own layout choice, silently changes the channel count (7.1 became 6.1,
 *   quad 5.0); flac takes any layout up to 8 channels. Relabelling a layout alac does not take
 *   (quad as 4.0) put the back pair on the centre and back-centre channels (batch B, measured):
 *   such layouts are remixed by position instead (`alacLayout`).
 * - flac and alac write at most 24 bits; given 32-bit or floating-point samples without a depth
 *   they log "encoding as 24 bits-per-sample", so the depth is always stated.
 * - Without the cleanup, `major_brand`, `minor_version` and `compatible_brands` of an MP4 source
 *   go into the ID3 frames, the FLAC comments and the Opus comments, and the MP4 track's
 *   `handler_name` into the Opus comments.
 * - matroska refuses Blu-ray, DVD and QuickTime float PCM, SMPTE 302M, QuickTime IMA ADPCM and
 *   Nellymoser as they are (found in the T-ENCODE-04 review): "convert" to MKV re-encodes them,
 *   extraction writes them as WAV.
 */

// ── Tables (design §5) ─────────────────────────────────────────────────────────────────────────
// Initial values from public sources (HandBrake, the Opus and LAME recommendations, ffmpeg wiki).

/**
 * The encoder options of each audio format as design §5 writes them. `{V}` is the LAME VBR
 * quality, `{B}` the bit rate, `{L}` the FLAC compression level. A stream type in a name (`-b:a`)
 * is dropped when parsed: `toFfmpegArgs` adds the output stream to every name. WAV and ALAC have
 * no options of their own; their sample format follows the source (`depthParameters`).
 */
const PARAMETER_TEXT = {
  mp3: '-q:a {V}',
  m4a: '-b:a {B}',
  opus: '-b:a {B} -vbr on -compression_level 10',
  flac: '-compression_level {L}',
} as const satisfies Readonly<Partial<Record<AudioFormat, string>>>;

/** High, standard, small (the audio names of the quality, balanced and size tiers). */
type PerTier = readonly [high: number, standard: number, small: number];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

/** All the numbers of design §5 in one place. Bit rates are kbit/s. */
export const AUDIO_TABLE = deepFreeze({
  parameters: PARAMETER_TEXT,
  /** libmp3lame VBR quality V0 / V2 / V5; it does not depend on the channel count. */
  mp3Quality: [0, 2, 5] satisfies PerTier,
  /**
   * The nominal rate of those VBR qualities, kbit/s: LAME's documented averages for V0 / V2 / V5
   * (245 / 190 / 130). The same-codec rule (AC-ENCODE-04-5) compares it with the source's rate;
   * Opus VBR and AAC take their table rate as the nominal one.
   */
  mp3NominalBitRate: [245, 190, 130] satisfies PerTier,
  /**
   * The same-codec rule compares a nominal target rate with a measured source rate, which reads a
   * little above the rate the file was made at (measured with the bundled ffmpeg: its own AAC at
   * 256k reads 258 807 bit/s, CBR Opus at 128k in Ogg 130 535 bit/s in all). A source up to this many
   * times the target's nominal rate counts as not above it, so a file made at a tier, converted again
   * at that tier, stays copied (already the target) instead of being re-encoded at the same rate.
   */
  sameCodecMargin: 1.05,
  /** Audio formats: stereo, and mono (AC-ENCODE-04-1); more than two channels take the stereo rate per pair of channels. */
  m4a: { stereo: [256, 192, 128] satisfies PerTier, mono: [128, 96, 64] satisfies PerTier },
  opus: { stereo: [160, 128, 96] satisfies PerTier, mono: [96, 64, 48] satisfies PerTier },
  flacLevel: [5, 5, 8] satisfies PerTier,
  /**
   * Audio inside a video (AC-ENCODE-05-2): stereo and 5.1; mono takes half of stereo, other channel
   * counts the 5.1 rate per channel, never below stereo.
   */
  inVideo: {
    aac: { stereo: [192, 160, 128] satisfies PerTier, surround: [384, 320, 256] satisfies PerTier },
    libopus: { stereo: [128, 96, 80] satisfies PerTier, surround: [320, 256, 192] satisfies PerTier },
  },
  /** "Compress" copies a compatible track whose rate is at most this many times the tier's (AC-ENCODE-05-1). */
  compressCopyRatio: 1.25,
  /** The largest MPEG-1 Layer III frame: the most a LAME VBR stream reaches, for the output cap. */
  mp3MaxBitRate: 320_000,
  /** libopus encodes 48 kHz; AAC (and MP3, which cannot go higher) keep at most 48 kHz. */
  opusSampleRate: 48_000,
  maxSampleRate: 48_000,
  /** The resampler of a rate brought down to 48 kHz. */
  downsample: 'aresample=resampler=soxr:precision=28:osr=48000',
  /** Opus, AAC, FLAC and ALAC carry at most 8 channels; more are mixed down to 7.1. */
  maxChannels: 8,
});

const TIER_INDEX: Readonly<Record<Tier, 0 | 1 | 2>> = { quality: 0, balanced: 1, size: 2 };

/** `'-b:a {B} -vbr on'` → `[['b', '{B}'], ['vbr', 'on']]`. */
export function parseAudioParameters(text: string): OptionPair[] {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length % 2 !== 0) throw new TypeError(`Unpaired encoder option in "${text}"`);
  const pairs: OptionPair[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const [name, value] = [tokens[i], tokens[i + 1]];
    if (!/^-[a-z][\w-]*(?::a)?$/.test(name) || (value.startsWith('-') && !/^-\d/.test(value))) throw new TypeError(`Malformed encoder option "${name} ${value}"`);
    pairs.push([name.slice(1).replace(/:a$/, ''), value]);
  }
  return pairs;
}

const PARSED: Readonly<Record<keyof typeof PARAMETER_TEXT, readonly OptionPair[]>> = Object.freeze({
  mp3: Object.freeze(parseAudioParameters(PARAMETER_TEXT.mp3)), m4a: Object.freeze(parseAudioParameters(PARAMETER_TEXT.m4a)),
  opus: Object.freeze(parseAudioParameters(PARAMETER_TEXT.opus)), flac: Object.freeze(parseAudioParameters(PARAMETER_TEXT.flac)),
});

/** One format's options with its placeholders filled in. */
function formatParameters(format: keyof typeof PARAMETER_TEXT, values: Readonly<Record<string, string>>): OptionPair[] {
  return PARSED[format].map(([name, value]): OptionPair => [name, value.replace(/\{([A-Z])\}/g, (_match, key: string) => {
    const filled = values[key];
    if (filled === undefined) throw new TypeError(`${format}: no value for {${key}}`);
    return filled;
  })]);
}

const kbit = (value: number) => `${value}k`;

/** The bit rate of an audio format output, kbit/s: the mono value for one channel, the stereo one per pair of channels above two. */
export function formatBitRate(format: 'm4a' | 'opus', tier: Tier, channels: number | null): number {
  const rates = AUDIO_TABLE[format];
  if (channels === 1) return rates.mono[TIER_INDEX[tier]];
  const count = Math.min(channels ?? 2, AUDIO_TABLE.maxChannels);
  return count > 2 ? Math.round(rates.stereo[TIER_INDEX[tier]] * count / 2) : rates.stereo[TIER_INDEX[tier]];
}

/**
 * The nominal bit rate of a lossy audio format output, bit/s (AC-ENCODE-04-5): the table rate of
 * AAC and Opus for the channel count (Opus VBR aims at it), LAME's average for the MP3 tier.
 */
export function nominalFormatBitRate(format: 'mp3' | 'm4a' | 'opus', tier: Tier, channels: number | null): number {
  return 1000 * (format === 'mp3' ? AUDIO_TABLE.mp3NominalBitRate[TIER_INDEX[tier]] : formatBitRate(format, tier, channels));
}

/** The bit rate of audio re-encoded inside a video, kbit/s (design §5 "视频内音频"). */
export function inVideoBitRate(encoder: 'aac' | 'libopus', tier: Tier, channels: number | null): number {
  const { stereo, surround } = AUDIO_TABLE.inVideo[encoder];
  const index = TIER_INDEX[tier];
  if (channels === 1) return stereo[index] / 2;
  const count = Math.min(channels ?? 2, AUDIO_TABLE.maxChannels);
  return count > 2 ? Math.max(stereo[index], Math.round(surround[index] * count / 6)) : stereo[index];
}

// ── Source properties ──────────────────────────────────────────────────────────────────────────

/** PCM by ffmpeg's codec names: the `pcm_*` kinds and SMPTE 302M (AES3 PCM of broadcast MPEG-TS). */
const isPcm = (codec: string) => codec.startsWith('pcm_') || codec === 's302m';
/** Lossless codecs; any other codec counts as lossy (an unknown codec asks for the confirmation rather than skip it). */
const LOSSLESS_CODECS: ReadonlySet<string> = new Set(['flac', 'alac', 'truehd', 'mlp', 'wavpack', 'tta', 'ape', 'tak', 'shorten', 'wmalossless', 'ralf']);
/** PCM, a lossless codec, or the lossless DTS-HD Master Audio. */
export function isLosslessAudio(stream: Pick<AudioStreamInfo, 'codec' | 'profile'>): boolean {
  return isPcm(stream.codec) || LOSSLESS_CODECS.has(stream.codec) || (stream.codec === 'dts' && /HD MA/i.test(stream.profile ?? ''));
}

/**
 * The PCM kinds the Matroska muxer stores (A_PCM/INT/LIT, A_PCM/INT/BIG, A_PCM/FLOAT/IEEE, and
 * through a WAV codec tag A-law, mu-law and 64-bit integers). It refuses ("No wav codec tag found",
 * measured with the bundled ffmpeg 8.1.2 for every audio encoder it has) Blu-ray, DVD, big-endian
 * float, 8-bit signed, planar and unsigned PCM, SMPTE 302M, and the codecs below, QuickTime IMA
 * ADPCM and Flash Nellymoser among them. Blu-ray LPCM in M2TS, DVD LPCM in VOB and float PCM in
 * MOV are common sources, so neither MKV nor MKA gets these as they are.
 */
const MATROSKA_PCM: ReadonlySet<string> = new Set([
  'pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s64le', 'pcm_f32le', 'pcm_f64le', 'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_alaw', 'pcm_mulaw',
]);
const MATROSKA_REFUSED: ReadonlySet<string> = new Set([
  's302m', 'adpcm_ima_qt', 'nellymoser', 'adpcm_adx', 'adpcm_argo', 'adpcm_g726le', 'adpcm_ima_alp', 'adpcm_ima_amv', 'adpcm_ima_apm', 'adpcm_ima_ssi',
  'adpcm_ima_ws', 'aptx', 'aptx_hd', 'comfortnoise', 'roq_dpcm', 'sbc',
]);
/** Whether Matroska (MKV, MKA) takes this codec as it is; a codec ffmpeg can only decode, so not measured, counts as taken. */
export const matroskaTakesAudio = (codec: string) => codec.startsWith('pcm_') ? MATROSKA_PCM.has(codec) : !MATROSKA_REFUSED.has(codec);
/** Re-encoded by "compress" whatever its rate (R-ENCODE-05 边界): lossless tracks and DTS. */
const alwaysReencodedByCompress = (stream: AudioStreamInfo) => isLosslessAudio(stream) || stream.codec === 'dts';

const SAMPLE_FORMAT_BITS: Readonly<Record<string, number>> = { u8: 8, s16: 16, s32: 32, s64: 64 };
/** The source's sample depth: floating point, or integer bits; null when the probe says neither. */
export function sourceDepth(stream: Pick<AudioStreamInfo, 'codec' | 'sampleFormat' | 'bitsPerRawSample'>): 'float' | number | null {
  const format = (stream.sampleFormat ?? '').replace(/p$/, '');
  if (format === 'flt' || format === 'dbl' || /^pcm_f(?:16|24|32|64)/.test(stream.codec)) return 'float';
  return stream.bitsPerRawSample ?? SAMPLE_FORMAT_BITS[format] ?? null;
}

/**
 * WAV keeps the source's depth (R-ENCODE-04 边界): floating point stays 32-bit float, integers up
 * to 16 and 24 bits stay so, more become 32-bit integers. An unknown depth takes 24 bits.
 */
export function pcmEncoder(stream: AudioStreamInfo): AudioEncoderId {
  const depth = sourceDepth(stream) ?? 24;
  if (depth === 'float') return 'pcm_f32le';
  return depth <= 16 ? 'pcm_s16le' : depth <= 24 ? 'pcm_s24le' : 'pcm_s32le';
}

/**
 * FLAC and ALAC keep up to 24 bits: 16-bit (and smaller) sources as 16 bits, everything else as
 * 24, the most either encoder writes without experimental options. The depth is stated, so neither
 * warns about choosing it.
 */
function depthParameters(encoder: 'flac' | 'alac', stream: AudioStreamInfo): OptionPair[] {
  const depth = sourceDepth(stream);
  const sixteen = typeof depth === 'number' && depth <= 16;
  const planar = encoder === 'alac' ? 'p' : '';
  return sixteen ? [['sample_fmt', `s16${planar}`]] : [['sample_fmt', `s32${planar}`], ['bits_per_raw_sample', '24']];
}

// ── Channel layouts and sample rates (AC-ENCODE-04-4) ──────────────────────────────────────────

/** The layout libopus takes for 1 to 8 channels (the Vorbis channel order of RFC 7845 §5.1.1.2). */
export const STANDARD_LAYOUTS: readonly string[] = Object.freeze(['mono', 'stereo', '3.0', 'quad', '5.0', '5.1', '6.1', '7.1']);
/**
 * Layouts that name the standard layout's channels differently (side, wide, downmix): relabelled
 * channel by channel with `channelmap`, the samples unchanged. 7.1(wide)'s front-of-centre pair
 * becomes the side pair, its nearest place in 7.1.
 */
export const LAYOUT_SYNONYMS: Readonly<Record<string, { layout: string; map: string }>> = deepFreeze({
  '5.0(side)': { layout: '5.0', map: 'FL-FL|FR-FR|FC-FC|SL-BL|SR-BR' },
  '5.1(side)': { layout: '5.1', map: 'FL-FL|FR-FR|FC-FC|LFE-LFE|SL-BL|SR-BR' },
  '7.1(wide)': { layout: '7.1', map: 'FL-FL|FR-FR|FC-FC|LFE-LFE|BL-BL|BR-BR|FLC-SL|FRC-SR' },
  downmix: { layout: 'stereo', map: 'DL-FL|DR-FR' },
});
/** The layouts the aac encoder writes (measured); others, such as those with height channels, it refuses. */
const AAC_LAYOUTS: ReadonlySet<string> = new Set([
  'mono', 'stereo', '2.1', '3.0', '3.0(back)', '4.0', 'quad', 'quad(side)', '3.1', '5.0', '5.0(side)', '4.1', '5.1', '5.1(side)', '6.0', '6.0(front)',
  'hexagonal', '6.1', '6.1(back)', '6.1(front)', '7.0', '7.0(front)', '7.1', '7.1(wide)', '7.1(wide-side)', 'octagonal',
]);
/** The one layout the alac encoder takes for 1 to 8 channels. */
const ALAC_LAYOUTS: readonly string[] = Object.freeze(['mono', 'stereo', '3.0', '4.0', '5.0', '5.1', '6.1(back)', '7.1(wide)']);
/** No channel positions: ffmpeg guesses its default layout for the count. */
const isUnspecified = (layout: string | null) => layout === null || layout === 'unknown' || /^\d+ channels$/.test(layout);

/**
 * The speaker positions of ffmpeg's named layouts (libavutil/channel_layout.c, as `ffmpeg -layouts`
 * of the bundled n8.1.2 decomposes them) up to 8 channels and the common larger ones, for placing a
 * layout in ALAC's (`alacLayout`). Back (BL/BR/BC), side (SL/SR), front-of-centre (FLC/FRC), top
 * (T…) and downmix (DL/DR) are ffmpeg's channel names. `5.1.2` and `5.1.4` are side layouts.
 */
const LAYOUT_POSITIONS: Readonly<Record<string, readonly string[]>> = deepFreeze({
  mono: ['FC'], stereo: ['FL', 'FR'], '2.1': ['FL', 'FR', 'LFE'], '3.0': ['FL', 'FR', 'FC'], '3.0(back)': ['FL', 'FR', 'BC'], '4.0': ['FL', 'FR', 'FC', 'BC'],
  quad: ['FL', 'FR', 'BL', 'BR'], 'quad(side)': ['FL', 'FR', 'SL', 'SR'], '3.1': ['FL', 'FR', 'FC', 'LFE'], '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'],
  '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'], '4.1': ['FL', 'FR', 'FC', 'LFE', 'BC'], '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'], '6.0': ['FL', 'FR', 'FC', 'BC', 'SL', 'SR'], '6.0(front)': ['FL', 'FR', 'FLC', 'FRC', 'SL', 'SR'],
  '3.1.2': ['FL', 'FR', 'FC', 'LFE', 'TFL', 'TFR'], hexagonal: ['FL', 'FR', 'FC', 'BL', 'BR', 'BC'], '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  '6.1(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BC'], '6.1(front)': ['FL', 'FR', 'LFE', 'FLC', 'FRC', 'SL', 'SR'], '7.0': ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR'],
  '7.0(front)': ['FL', 'FR', 'FC', 'FLC', 'FRC', 'SL', 'SR'], '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'], '7.1(wide-side)': ['FL', 'FR', 'FC', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  '5.1.2': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR'], '5.1.2(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR'],
  octagonal: ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR'],
  cube: ['FL', 'FR', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'], '5.1.4': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '7.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR'], '7.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  downmix: ['DL', 'DR'],
});
/** A layout's positions: a named one from the table, or ffmpeg's description of another (`4 channels (FL+FR+LFE+BC)`, `FL+FR+LFE`); null when unknown. */
function positionsOf(layout: string | null): readonly string[] | null {
  if (layout === null) return null;
  if (LAYOUT_POSITIONS[layout]) return LAYOUT_POSITIONS[layout];
  const listed = /^(?:\d+ channels \()?([A-Z][A-Z0-9]*(?:\+[A-Z][A-Z0-9]*)+)\)?$/.exec(layout);
  return listed ? listed[1].split('+') : null;
}
/**
 * Where swresample puts a channel ALAC has no place for, without mixing: a side channel on the back
 * of its side when the source has no back channel there, a downmix channel on the front. Any other
 * missing position is mixed into its neighbours.
 */
function alacPlacement(positions: readonly string[]): Set<string> {
  const has = new Set(positions);
  const moved: Readonly<Record<string, string>> = { SL: 'BL', SR: 'BR', DL: 'FL', DR: 'FR' };
  return new Set(positions.map(position => moved[position] && !has.has(moved[position]) ? moved[position] : position));
}

const relabel = (layout: string, map?: string) => `channelmap=${map ? `map=${map}:` : ''}channel_layout=${layout}`;
const remix = (layout: string) => `aformat=channel_layouts=${layout}`;

/**
 * The layout an ALAC output gets, and the filter that gives it (AC-ENCODE-04-4, design §7b): ALAC
 * takes one layout per channel count. A layout it does not take is remixed (`aformat`, swresample
 * places every channel by its position) into the nearest ALAC layout: the smallest one that has a
 * place for every source channel, side channels taking the back places they leave free, so nothing
 * is mixed or lost (quad → 5.0 with an empty centre, 2.1 → 5.1 keeping the LFE). When no ALAC layout
 * has room for all (7.1 with both side and back pairs, height channels, more than 8), the one of the
 * same channel count (at most 8), into which swresample mixes the rest by position: sides into the
 * backs, top-front channels into the fronts. swresample has no place for the
 * top-back channels (TBL/TBR of 5.1.4, 7.1.4) and drops them (measured), as it does for every
 * encoder's mix down to 7.1. Relabelling
 * (`channelmap`) is only for a mere renaming: the side and downmix synonyms of an ALAC layout, and
 * layouts without positions. Relabelling anything else put rear channels on the centre (measured).
 * `layout` is null when the channel count is unknown (the encoder decides).
 */
export function alacLayout(stream: Pick<AudioStreamInfo, 'channels' | 'channelLayout'>): { layout: string | null; filters: string[] } {
  const channels = stream.channels ?? 0;
  const layout = stream.channelLayout;
  if (channels < 1) return { layout: null, filters: [] };
  if (channels <= AUDIO_TABLE.maxChannels && layout === ALAC_LAYOUTS[channels - 1]) return { layout, filters: [] };
  const sameCount = ALAC_LAYOUTS[Math.min(channels, AUDIO_TABLE.maxChannels) - 1];
  if (channels === 1) return { layout: sameCount, filters: [relabel(sameCount)] };
  const synonym = layout === null ? undefined : LAYOUT_SYNONYMS[layout];
  if (synonym && synonym.layout === sameCount) return { layout: sameCount, filters: [relabel(sameCount, synonym.map)] };
  const positions = positionsOf(layout);
  if (positions === null || positions.length !== channels) {
    // No positions to keep: name the channels as ALAC's own layout of the count.
    if (isUnspecified(layout) && channels <= AUDIO_TABLE.maxChannels) return { layout: sameCount, filters: [relabel(sameCount)] };
    return { layout: sameCount, filters: [remix(sameCount)] };
  }
  const placed = alacPlacement(positions);
  const nearest = ALAC_LAYOUTS.find(name => [...placed].every(position => LAYOUT_POSITIONS[name].includes(position))) ?? sameCount;
  return { layout: nearest, filters: [remix(nearest)] };
}
/** The channel count of an ALAC output (more than the source's when the nearest layout has empty places); null when unknown. */
export function alacChannels(stream: Pick<AudioStreamInfo, 'channels' | 'channelLayout'>): number | null {
  const { layout } = alacLayout(stream);
  return layout === null ? null : ALAC_LAYOUTS.indexOf(layout) + 1;
}

/**
 * The filters that give an encoder a layout it takes (AC-ENCODE-04-4, design §5):
 * - libopus: its standard layout; side, wide and downmix synonyms and unspecified layouts are
 *   relabelled, any other layout (2.1, 4.0, quad(side), 6.1(back)...) is remixed to the standard
 *   layout of its channel count, more than 8 channels mixed down to 7.1.
 * - aac: the layout as it is, except the synonyms, relabelled so the stream gets a standard channel
 *   configuration instead of a PCE; layouts it refuses are remixed, more than 8 channels mixed down to 7.1.
 * - flac: more than 8 channels mixed down to 7.1.
 * - alac: the nearest ALAC layout (`alacLayout`): remixed by position, relabelled only when it is a
 *   mere renaming.
 * - libmp3lame and PCM: none (MP3 is mixed down by `-ac 2`).
 * An unknown channel count gets nothing: the encoder decides.
 */
export function layoutFilters(encoder: AudioEncoderId, stream: Pick<AudioStreamInfo, 'channels' | 'channelLayout'>): string[] {
  const channels = stream.channels ?? 0;
  const layout = stream.channelLayout;
  if (channels < 1 || encoder === 'libmp3lame' || encoder.startsWith('pcm_')) return [];
  if (encoder === 'alac') return alacLayout(stream).filters;
  if (channels > AUDIO_TABLE.maxChannels) return [remix('7.1')];
  if (encoder === 'flac') return [];
  const standard = STANDARD_LAYOUTS[channels - 1];
  if (layout === standard) return [];
  const synonym = layout === null ? undefined : LAYOUT_SYNONYMS[layout];
  if (synonym && synonym.layout === standard) return [relabel(standard, synonym.map)];
  if (encoder === 'aac') return isUnspecified(layout) || AAC_LAYOUTS.has(layout!) ? [] : [remix(standard)];
  return isUnspecified(layout) ? [relabel(standard)] : [remix(standard)];
}

/** Opus at 48 kHz; AAC and MP3 above 48 kHz brought down with soxr; the rest keep the source rate. */
export function sampleRateFilters(encoder: AudioEncoderId, stream: Pick<AudioStreamInfo, 'sampleRate'>): string[] {
  const rate = stream.sampleRate || null;
  if (encoder === 'libopus') return rate === AUDIO_TABLE.opusSampleRate ? [] : [`aresample=${AUDIO_TABLE.opusSampleRate}`];
  if ((encoder === 'aac' || encoder === 'libmp3lame') && rate !== null && rate > AUDIO_TABLE.maxSampleRate) return [AUDIO_TABLE.downsample];
  return [];
}

/** More than two channels, or an unknown count, into MP3 (mono or stereo only). */
const mp3NeedsDownmix = (stream: AudioStreamInfo) => stream.channels === null || stream.channels === 0 || stream.channels > 2;

/** An audio encode: its options, then the layout and sample rate filters of this track. */
function audioEncode(encoder: AudioEncoderId, stream: AudioStreamInfo, params: OptionPair[], maxBitRate: number | null): EncodeSpec {
  return { encoder, variant: null, params, filters: [...layoutFilters(encoder, stream), ...sampleRateFilters(encoder, stream)], maxBitRate, frame: null };
}

const lossyEncode = (encoder: 'aac' | 'libopus', stream: AudioStreamInfo, rate: number): EncodeSpec =>
  audioEncode(encoder, stream, formatParameters(encoder === 'aac' ? 'm4a' : 'opus', { B: kbit(rate) }), rate * 1000);

// ── Plans ──────────────────────────────────────────────────────────────────────────────────────

/** What happens to one source track in one output. */
export interface AudioPlan {
  choice: { action: 'copy' } | { action: 'encode'; encode: EncodeSpec };
  warnings: PlanWarning[];
  /** A lossy track written losslessly: the user confirms first (AC-ENCODE-04-5). */
  lossyToLossless: boolean;
}

const copied = (): AudioPlan => ({ choice: { action: 'copy' }, warnings: [], lossyToLossless: false });
const encoded = (encode: EncodeSpec, warnings: PlanWarning[] = [], lossyToLossless = false): AudioPlan => ({ choice: { action: 'encode', encode }, warnings, lossyToLossless });

/** PCM a WAV file takes as it is: little-endian or companded (AC-ENCODE-04-2). */
const WAV_PCM: ReadonlySet<string> = new Set(['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le', 'pcm_alaw', 'pcm_mulaw']);
/** Big-endian PCM, which AIFF takes as it is. */
const AIFF_PCM: ReadonlySet<string> = new Set(['pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_f32be', 'pcm_f64be']);
/** The codec each audio format holds (WAV: `WAV_PCM`). */
const FORMAT_CODEC: Readonly<Record<Exclude<AudioFormat, 'wav'>, string>> = { mp3: 'mp3', m4a: 'aac', opus: 'opus', flac: 'flac', alac: 'alac' };
const LOSSLESS_FORMATS: ReadonlySet<AudioFormat> = new Set(['flac', 'wav', 'alac']);

/** The encode of an audio format output (AC-ENCODE-04-1, 04-4): the table options, the bit depth, the layout and the sample rate. */
export function formatEncode(format: AudioFormat, stream: AudioStreamInfo, tier: Tier): EncodeSpec {
  const index = TIER_INDEX[tier];
  switch (format) {
    case 'mp3': {
      const params = formatParameters('mp3', { V: String(AUDIO_TABLE.mp3Quality[index]) });
      if (mp3NeedsDownmix(stream)) params.push(['ac', '2']);
      return audioEncode('libmp3lame', stream, params, AUDIO_TABLE.mp3MaxBitRate);
    }
    case 'm4a': return lossyEncode('aac', stream, formatBitRate('m4a', tier, stream.channels));
    case 'opus': return lossyEncode('libopus', stream, formatBitRate('opus', tier, stream.channels));
    case 'flac': return audioEncode('flac', stream, [...formatParameters('flac', { L: String(AUDIO_TABLE.flacLevel[index]) }), ...depthParameters('flac', stream)], null);
    case 'alac': return audioEncode('alac', stream, depthParameters('alac', stream), null);
    case 'wav': return audioEncode(pcmEncoder(stream), stream, [], null);
  }
}

/**
 * Whether a track already in the target's codec is copied rather than re-encoded (AC-ENCODE-04-5,
 * design §7b): a lossless one always (re-encoding gives the same samples); a lossy one when the
 * target's nominal rate (`nominalFormatBitRate`) is at least the source's, since re-encoding to a
 * higher rate only makes it larger, but not when the target is lower: then it is re-encoded to
 * shrink it (a 320k MP3 to "standard" MP3). The source's rate is the stream's, else its `BPS` tag
 * (the probe's `bitRate`), else `containerBitRate`, and it is measured, so up to
 * `AUDIO_TABLE.sameCodecMargin` above the nominal rate still counts as not lower (the same tier's
 * own output). An unknown rate is copied, as re-encoding blindly could only lose quality and might
 * grow the file.
 */
function copiesSameCodec(format: AudioFormat, stream: AudioStreamInfo, tier: Tier, containerBitRate: number | null): boolean {
  if (format !== 'mp3' && format !== 'm4a' && format !== 'opus') return true;
  const source = stream.bitRate ?? containerBitRate;
  return source === null || nominalFormatBitRate(format, tier, stream.channels) * AUDIO_TABLE.sameCodecMargin >= source;
}

/**
 * A track written as an audio format (convert to an audio format, or extract to one).
 *
 * The same codec is copied by the rule of `copiesSameCodec` (AC-ENCODE-04-5); the planner answers
 * `already_target` when it is copied into the same container. `containerBitRate` is the file's
 * total rate when the track is all the file holds (an audio file of one track without cover art),
 * else null: it stands for the track's rate when neither the stream nor a tag states one. A lossy
 * track written losslessly needs the user's confirmation; MP3 mixes more than two channels down
 * (`downmixed_to_stereo`).
 */
export function planAudioFormat(format: AudioFormat, stream: AudioStreamInfo, tier: Tier, containerBitRate: number | null): AudioPlan {
  const same = format === 'wav' ? WAV_PCM.has(stream.codec) : stream.codec === FORMAT_CODEC[format];
  if (same && copiesSameCodec(format, stream, tier, containerBitRate)) return copied();
  const warnings: PlanWarning[] = format === 'mp3' && (stream.channels ?? 0) > 2 ? [{ code: 'downmixed_to_stereo', streams: [stream.index], count: 1 }] : [];
  return encoded(formatEncode(format, stream, tier), warnings, LOSSLESS_FORMATS.has(format) && !isLosslessAudio(stream));
}

/**
 * "Extract audio" as it is (AC-ENCODE-04-2): copied into the file type its codec belongs in;
 * big-endian PCM into AIFF; other PCM (Blu-ray, DVD, planar, SMPTE 302M...) losslessly into
 * little-endian PCM WAV of its depth, which the summary shows as an encode; anything else (AC-3,
 * E-AC-3, DTS, TrueHD...) into Matroska audio, except what Matroska refuses (QuickTime IMA
 * ADPCM, Nellymoser...), which is decoded into WAV the same way rather than fail.
 */
export function planExtractCopy(stream: AudioStreamInfo): { container: OutputContainer; plan: AudioPlan } {
  switch (stream.codec) {
    case 'aac': case 'alac': return { container: 'm4a', plan: copied() };
    case 'mp3': return { container: 'mp3', plan: copied() };
    case 'opus': return { container: 'opus', plan: copied() };
    case 'vorbis': return { container: 'ogg', plan: copied() };
    case 'flac': return { container: 'flac', plan: copied() };
  }
  if (WAV_PCM.has(stream.codec)) return { container: 'wav', plan: copied() };
  if (AIFF_PCM.has(stream.codec)) return { container: 'aiff', plan: copied() };
  if (isPcm(stream.codec) || !matroskaTakesAudio(stream.codec)) return { container: 'wav', plan: encoded(formatEncode('wav', stream, 'balanced')) };
  return { container: 'mka', plan: copied() };
}

/**
 * A track inside a video output (AC-ENCODE-05-1, 05-2). It is copied when the container takes its
 * codec (MKV every codec its muxer stores: not Blu-ray or DVD LPCM, see `matroskaTakesAudio`): by
 * "convert" whatever its rate; by "compress" only when its rate (the stream's, else the `BPS` tag;
 * unknown never qualifies) is at most 1.25 times the tier's, and never for lossless tracks or DTS.
 * Otherwise it is re-encoded, to AAC in MP4/MOV and Opus in MKV/WebM, at the tier's rate for its
 * channel count, which it keeps (more than 8 become 7.1).
 */
export function planVideoAudio(container: VideoContainer, stream: AudioStreamInfo, settings: ConversionSettings): AudioPlan {
  const encoder = container === 'mp4' || container === 'mov' ? 'aac' : 'libopus';
  const rate = inVideoBitRate(encoder, settings.tier, stream.channels);
  if (canCopyAudio(container, stream.codec) && (container !== 'mkv' || matroskaTakesAudio(stream.codec))) {
    if (settings.task !== 'compress') return copied();
    const withinTier = stream.bitRate !== null && stream.bitRate <= rate * 1000 * AUDIO_TABLE.compressCopyRatio;
    if (withinTier && !alwaysReencodedByCompress(stream)) return copied();
  }
  return encoded(lossyEncode(encoder, stream, rate));
}

// ── Tags (AC-ENCODE-04-3) ──────────────────────────────────────────────────────────────────────

/**
 * Outputs whose tags are free-form (ID3 frames, Vorbis comments): the source container's brand
 * tags are removed from what `-map_metadata 0` copies (an empty value removes a tag). M4A writes
 * its own brand; the `encoder` tag is the muxer's own and left as it is.
 */
const TAGGED: ReadonlySet<OutputContainer> = new Set(['mp3', 'flac', 'opus', 'ogg']);
const BRAND_TAGS: readonly OptionPair[] = Object.freeze([['major_brand', ''], ['minor_version', ''], ['compatible_brands', '']]);
/** Ogg writes the track's own tags as comments too: the MP4 track's handler and vendor are removed. */
const OGG_TRACK_TAGS: readonly OptionPair[] = Object.freeze([['handler_name', ''], ['vendor_id', '']]);

/** `-metadata name=` written over the copied global tags. */
export const outputTagCleanup = (container: OutputContainer): readonly OptionPair[] => TAGGED.has(container) ? BRAND_TAGS : [];
/** `-metadata:s:a:<n> name=` written over an audio track's copied tags. */
export const trackTagCleanup = (container: OutputContainer): readonly OptionPair[] => container === 'opus' || container === 'ogg' ? OGG_TRACK_TAGS : [];
