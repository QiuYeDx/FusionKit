import { describe, expect, it } from 'vitest';
import {
  defaultCompressSettings, mediaInfoSchema,
  type CompressCodec, type CompressSettings, type ConversionSettings, type MediaInfo, type Tier, type VariantKey, type VideoEncoderId, type VideoStreamInfo,
} from '../../../src/media-converter/contract';
import { buildPlan } from '../../../electron/main/media-converter/plan/stream-plan';
import { probeArgs, toFfmpegArgs, videoArgs, type FfmpegIo } from '../../../electron/main/media-converter/plan/args';
import {
  PROBE_PICTURE, VIDEO_CHAINS, VIDEO_TABLE, defaultCompressCodec, encoderVariants, gopFrames, hardwareFrameFits, kvazaarPeriod, openh264Fits, outputSize,
  parseParameters,
} from '../../../electron/main/media-converter/plan/video';
import type { ConversionPlan, KeptStreamDecision, PlanOutcome, PlannerCapabilities } from '../../../electron/main/media-converter/plan/types';

/**
 * The video encode of the planner (module-encode design §3, §4): the encoder chains and their
 * preconditions, the parameter tables, the output size under the short-side limit, the GOP, the
 * openh264 rate, the convert codec per container, the default compress codec and the probe
 * arguments. Pure: no process is started.
 */

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const SECONDS_US = 1_000_000;

function video(extra: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return {
    index: 0, typeIndex: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', bitDepth: 8, chromaSubsampling: '420', width: 1920, height: 1080,
    sampleAspectRatio: '1:1', rFrameRate: '30/1', avgFrameRate: '30/1', fps: 30, isVfr: false, rotation: 0, colorPrimaries: 'bt709',
    colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv', fieldOrder: 'progressive', bitRate: 6_000_000, durationUs: 60 * SECONDS_US,
    language: null, title: null, default: true, hdr: { format: 'none', dolbyVision: null, masteringDisplay: null, contentLight: null }, ...extra,
  };
}
const HDR10 = { format: 'hdr10', dolbyVision: null, masteringDisplay: null, contentLight: null } as const;

/** A schema-checked MKV with one video stream and nothing else. */
function media(stream: Partial<VideoStreamInfo> = {}, extra: Partial<MediaInfo> = {}): MediaInfo {
  return mediaInfoSchema.parse({
    kind: 'video',
    container: { demuxer: 'matroska', formatName: 'matroska,webm', majorBrand: null, matroskaDocType: 'matroska', extension: 'mkv', identity: 'matroska' },
    sizeBytes: 100_000_000, durationUs: 60 * SECONDS_US, durationSource: 'format', startTimeUs: 0, bitRate: 13_333_333, primaryVideoIndex: 0,
    video: [video(stream)], audio: [], subtitles: [], covers: [], attachments: 0, chapters: 0, dataStreams: 0, ...extra,
  });
}
const HD = media();

const NVENC_MIN = { width: 144, height: 120 };
const caps = (encoders: PlannerCapabilities['encoders'], degraded: VideoEncoderId[] = [], nvencMin = NVENC_MIN): PlannerCapabilities => ({ encoders, degraded, nvencMin });
const NVENC_ENCODERS: PlannerCapabilities['encoders'] = {
  av1_nvenc: { variants: { '10bit': true, '10bit_uhq': true }, uhq: true },
  hevc_nvenc: { variants: { '8bit': true, '10bit': true, '8bit_uhq': true, '10bit_uhq': true }, uhq: true },
  h264_nvenc: { variants: { '8bit': true } },
};
const MF_ENCODERS: PlannerCapabilities['encoders'] = { hevc_mf: { variants: { '8bit': true } }, h264_mf: { variants: { '8bit': true, '8bit_sw': true } } };
/** The capability combinations of AC-ENCODE-02-5. */
const CAPS = {
  ALL_NVENC: caps(NVENC_ENCODERS),
  CPU_ONLY: caps({}),
  QSV_ONLY: caps({ av1_qsv: { variants: { '10bit': true } }, hevc_qsv: { variants: { '8bit': true, '10bit': true } }, h264_qsv: { variants: { '8bit': true } } }),
  AMF_ONLY: caps({ av1_amf: { variants: { '10bit': true } }, hevc_amf: { variants: { '8bit': true, '10bit': true } }, h264_amf: { variants: { '8bit': true } } }),
  // NVENC failed before its first frame in this session: the Media Foundation encoders take over.
  NVENC_DEGRADED: caps({ ...NVENC_ENCODERS, ...MF_ENCODERS }, ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc']),
} as const;
const IO: FfmpegIo = { inputPath: 'C:\\media\\movie.mkv', demuxer: 'matroska', partialPath: 'D:\\out\\.fusionkit-media-0011aabb.partial' };
/**
 * Every video chain ends with the source's colour tags (T-ENCODE-03, design §4). The fixtures here are
 * tagged BT.709, and an untagged picture of 1280×720 (the probe's) is inferred BT.709 too (AC-ENCODE-03-2).
 */
const BT709 = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
/** The chain of a plain source that is neither scaled nor converted: the encoder's pixel format, then the tags. */
const chain = (pixFmt: string) => `format=${pixFmt},${BT709}`;
const TIERS: readonly Tier[] = ['quality', 'balanced', 'size'];

const compress = (extra: Partial<CompressSettings> = {}): ConversionSettings => ({ ...defaultCompressSettings('hevc'), container: 'mp4', ...extra });
const convert = (target: 'mp4' | 'mov' | 'mkv' | 'webm', preferRemux = true, tier: Tier = 'balanced'): ConversionSettings => ({ task: 'convert', target, preferRemux, tier });

function planOf(outcome: PlanOutcome): ConversionPlan {
  if (outcome.status !== 'ready' && outcome.status !== 'skipped') throw new Error(`no plan: ${outcome.status} ${outcome.reason}`);
  return outcome.plan;
}
/** The main video's decision. */
function videoDecision(value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities): KeptStreamDecision {
  const decision = planOf(buildPlan(value, settings, table)).outputs[0].streams.find(item => item.source.kind === 'video' && item.action !== 'drop');
  if (!decision || decision.action === 'drop') throw new Error('no video stream');
  return decision;
}
const encodeOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities) => {
  const decision = videoDecision(value, settings, table);
  if (decision.action !== 'encode') throw new Error('the video is copied');
  return decision.encode;
};
const chosen = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities) => {
  const encode = encodeOf(value, settings, table);
  return `${encode.encoder}/${encode.variant}`;
};
/** `-c:v:0 <encoder> -<option>:v:0 <value>... -filter:v:0 <chain>`. */
const argsOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities, io: FfmpegIo = IO) => videoArgs(videoDecision(value, settings, table), io);
const option = (args: string[], name: string) => { const at = args.indexOf(`-${name}:v:0`); return at === -1 ? undefined : args[at + 1]; };
const warningCodes = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities) => planOf(buildPlan(value, settings, table)).summary.warnings.map(item => item.code);

// ── Parameter tables ───────────────────────────────────────────────────────────────────────────

/**
 * Design §3 as written there, transcribed independently of the implementation: each row, its
 * `{Q}` per tier (quality / balanced / size) at 1080p, and `{G}`, `{P}`, `{B}`. HEVC 8-bit rows
 * are the Main10 rows with Main and the 8-bit pixel format of the §4 table.
 */
const MAIN10 = '-profile:v main10 -pix_fmt p010le';
const DESIGN_ROWS: readonly [VideoEncoderId, VariantKey, string, readonly [number, number, number] | null][] = [
  ['libsvtav1', '10bit', '-preset 6 -crf {Q} -pix_fmt yuv420p10le', [28, 32, 38]],
  ['av1_nvenc', '10bit_uhq', '-preset p7 -tune uhq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -g {G} -pix_fmt p010le', [30, 34, 38]],
  ['av1_nvenc', '10bit', '-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -g {G} -pix_fmt p010le', [30, 34, 38]],
  ['av1_qsv', '10bit', '-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} -pix_fmt p010le', [26, 30, 34]],
  ['av1_amf', '10bit', '-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -align 1080p -g {G} -pix_fmt p010le', [22, 26, 30]],
  ['hevc_nvenc', '10bit_uhq', `-preset p7 -tune uhq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -b_ref_mode middle -g {G} ${MAIN10}`, [24, 27, 30]],
  ['hevc_nvenc', '10bit', `-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} ${MAIN10}`, [24, 27, 30]],
  ['hevc_nvenc', '8bit_uhq', '-preset p7 -tune uhq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -b_ref_mode middle -g {G} -profile:v main -pix_fmt yuv420p', [24, 27, 30]],
  ['hevc_nvenc', '8bit', '-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} -profile:v main -pix_fmt yuv420p', [24, 27, 30]],
  ['hevc_qsv', '10bit', `-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} ${MAIN10}`, [23, 26, 29]],
  ['hevc_qsv', '8bit', '-preset veryslow -global_quality {Q} -extbrc 1 -look_ahead_depth 40 -g {G} -profile:v main -pix_fmt nv12', [23, 26, 29]],
  ['hevc_amf', '10bit', `-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} ${MAIN10}`, [20, 23, 26]],
  ['hevc_amf', '8bit', '-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} -profile:v main -pix_fmt nv12', [20, 23, 26]],
  ['hevc_mf', '8bit', '-hw_encoding 1 -rate_control quality -quality {Q} -g {G} -pix_fmt nv12', [80, 70, 60]],
  ['libkvazaar', '8bit', '-kvazaar-params preset=medium,qp={Q},period={P} -pix_fmt yuv420p', [20, 23, 26]],
  ['h264_nvenc', '8bit', '-preset p7 -tune hq -rc vbr -cq {Q} -b:v 0 -rc-lookahead 32 -bf 3 -b_ref_mode middle -g {G} -profile:v high -pix_fmt yuv420p', [21, 24, 27]],
  ['h264_qsv', '8bit', '-preset veryslow -global_quality {Q} -look_ahead 1 -look_ahead_depth 40 -g {G} -profile:v high -pix_fmt nv12', [21, 24, 27]],
  ['h264_amf', '8bit', '-usage high_quality -quality quality -rc qvbr -qvbr_quality_level {Q} -preanalysis 1 -g {G} -profile:v high -pix_fmt nv12', [20, 23, 26]],
  ['h264_mf', '8bit', '-hw_encoding 1 -rate_control quality -quality {Q} -profile:v 100 -g {G} -pix_fmt nv12', [80, 70, 60]],
  ['h264_mf', '8bit_sw', '-rate_control quality -quality {Q} -profile:v 100 -g {G} -pix_fmt nv12', [80, 70, 60]],
  ['libopenh264', '8bit', '-profile:v high -coder cabac -rc_mode bitrate -b:v {B} -g {G} -pix_fmt yuv420p', null],
];
const CODEC_OF: Readonly<Record<string, CompressCodec>> = { av1: 'av1', hevc: 'hevc', h264: 'h264', libsvtav1: 'av1', libkvazaar: 'hevc', libopenh264: 'h264' };
const codecOf = (encoder: VideoEncoderId) => CODEC_OF[encoder] ?? CODEC_OF[encoder.split('_')[0]];
/** Capabilities in which only this configuration works (the CPU encoders are always there; their codecs have no hardware here). */
const only = (encoder: VideoEncoderId, variant: VariantKey) => encoder.startsWith('lib') ? caps({}) : caps({ [encoder]: { variants: { [variant]: true } } });
/** Design text → the arguments `toFfmpegArgs` writes for output video 0. */
const perStream = (text: string) => text.split(' ').map((token, i) => i % 2 === 0 ? `${token.replace(/:v$/, '')}:v:0` : token);

describe('the parameter tables (AC-ENCODE-02-5, design §3)', () => {
  it.each(DESIGN_ROWS)('%s %s matches the design row at every tier', (encoder, variant, text, quality) => {
    for (const [i, tier] of TIERS.entries()) {
      const settings = compress({ codec: codecOf(encoder), tier, useGpuForAv1: true });
      const args = argsOf(HD, settings, only(encoder, variant));
      // 1920×1080 at 30 fps: G = 150, kvazaar's period 144, openh264 B = min(bpp × 1920 × 1080 × 30, 0.7 × 6 Mbit/s).
      const bitRate = Math.round(Math.min([0.12, 0.09, 0.065][i] * 1920 * 1080 * 30, 0.7 * 6_000_000));
      const expected = text.replace('{Q}', String(quality?.[i])).replace('{G}', '150').replace('{P}', '144').replace('{B}', String(bitRate));
      const pixFmt = expected.match(/-pix_fmt (\S+)/)![1];
      expect(args).toEqual(['-c:v:0', encoder, ...perStream(expected), '-filter:v:0', chain(pixFmt)]);
    }
  });

  it('holds exactly the rows of the design, each with a pixel format and only the known placeholders', () => {
    const rows = Object.entries(VIDEO_TABLE.parameters).flatMap(([encoder, variants]) => Object.keys(variants).map(variant => `${encoder}/${variant}`));
    expect(rows.sort()).toEqual(DESIGN_ROWS.map(([encoder, variant]) => `${encoder}/${variant}`).sort());
    for (const [, variants] of Object.entries(VIDEO_TABLE.parameters)) {
      for (const text of Object.values(variants) as string[]) {
        expect(parseParameters(text).filter(([name]) => name === 'pix_fmt')).toHaveLength(1);
        expect(text.match(/\{\w+\}/g)?.every(token => ['{Q}', '{G}', '{P}', '{B}'].includes(token)) ?? true).toBe(true);
      }
    }
    expect(Object.isFrozen(VIDEO_TABLE.quality.hevc_nvenc)).toBe(true);
    expect(Object.isFrozen(VIDEO_TABLE.parameters.hevc_nvenc)).toBe(true);
  });

  it('never sets -bf on hevc_nvenc uhq, and sets -bf 3 on hq (the driver refuses uhq with -bf 3)', () => {
    for (const variant of ['10bit_uhq', '8bit_uhq'] as const) {
      const args = argsOf(HD, compress(), only('hevc_nvenc', variant));
      expect(option(args, 'tune')).toBe('uhq');
      expect(args.some(arg => arg.startsWith('-bf'))).toBe(false);
    }
    for (const variant of ['10bit', '8bit'] as const) {
      const args = argsOf(HD, compress(), only('hevc_nvenc', variant));
      expect([option(args, 'tune'), option(args, 'bf')]).toEqual(['hq', '3']);
    }
    for (const [encoder, variants] of Object.entries(VIDEO_TABLE.parameters)) {
      for (const [variant, text] of Object.entries(variants) as [string, string][]) if (variant.endsWith('_uhq')) expect(`${encoder} ${text}`).not.toMatch(/-bf /);
    }
  });

  it('feeds the Media Foundation encoders nv12, and asks h264_mf for High by number', () => {
    for (const [encoder, variant] of [['h264_mf', '8bit'], ['h264_mf', '8bit_sw'], ['hevc_mf', '8bit']] as const) {
      const args = argsOf(HD, compress({ codec: codecOf(encoder) }), only(encoder, variant));
      expect(option(args, 'pix_fmt')).toBe('nv12');
      expect(option(args, 'filter')).toBe(chain('nv12'));
      expect(option(args, 'profile')).toBe(encoder === 'h264_mf' ? '100' : undefined);
      expect(option(args, 'hw_encoding')).toBe(variant === '8bit_sw' ? undefined : '1');
    }
  });

  it('gives kvazaar its options as one comma-separated value', () => {
    const args = argsOf(HD, compress({ codec: 'hevc' }), CAPS.CPU_ONLY);
    expect(args).toEqual(['-c:v:0', 'libkvazaar', '-kvazaar-params:v:0', 'preset=medium,qp=23,period=144', '-pix_fmt:v:0', 'yuv420p', '-filter:v:0', chain('yuv420p')]);
    expect(option(args, 'kvazaar-params')).not.toContain(':');
  });

  it('parses only well-formed option text', () => {
    expect(parseParameters('-b:v 0 -profile:v main10 -crf {Q}')).toEqual([['b', '0'], ['profile', 'main10'], ['crf', '{Q}']]);
    expect(() => parseParameters('-preset')).toThrow(TypeError);
    expect(() => parseParameters('-preset -tune')).toThrow(TypeError);
    expect(() => parseParameters('preset p7')).toThrow(TypeError);
  });
});

describe('the parameter snapshot of every codec × tier × capability combination (AC-ENCODE-02-5)', () => {
  it('matches the snapshot', () => {
    const lines: string[] = [];
    for (const [name, table] of Object.entries(CAPS)) {
      for (const [label, extra] of [['av1', { codec: 'av1' }], ['av1 gpu', { codec: 'av1', useGpuForAv1: true }], ['hevc', { codec: 'hevc' }], ['h264', { codec: 'h264' }]] as const) {
        for (const tier of TIERS) {
          const settings = compress({ ...extra, tier });
          const warnings = planOf(buildPlan(HD, settings, table)).summary.warnings.map(item => item.to ? `${item.code}→${item.to}` : item.code);
          lines.push(`${name} | ${label} | ${tier} | ${argsOf(HD, settings, table).join(' ')}${warnings.length ? ` | ${warnings.join(' ')}` : ''}`);
        }
      }
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "ALL_NVENC | av1 | quality | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 28 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | av1 | balanced | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | av1 | size | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 38 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | av1 gpu | quality | -c:v:0 av1_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 30 -b:v:0 0 -rc-lookahead:v:0 32 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | av1 gpu | balanced | -c:v:0 av1_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 34 -b:v:0 0 -rc-lookahead:v:0 32 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | av1 gpu | size | -c:v:0 av1_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 38 -b:v:0 0 -rc-lookahead:v:0 32 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | hevc | quality | -c:v:0 hevc_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 24 -b:v:0 0 -rc-lookahead:v:0 32 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | hevc | balanced | -c:v:0 hevc_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 27 -b:v:0 0 -rc-lookahead:v:0 32 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | hevc | size | -c:v:0 hevc_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 30 -b:v:0 0 -rc-lookahead:v:0 32 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | h264 | quality | -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 21 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | h264 | balanced | -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 24 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      ALL_NVENC | h264 | size | -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 27 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      CPU_ONLY | av1 | quality | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 28 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      CPU_ONLY | av1 | balanced | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      CPU_ONLY | av1 | size | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 38 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      CPU_ONLY | av1 gpu | quality | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 28 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | encoder_fallback→libsvtav1
      CPU_ONLY | av1 gpu | balanced | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | encoder_fallback→libsvtav1
      CPU_ONLY | av1 gpu | size | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 38 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | encoder_fallback→libsvtav1
      CPU_ONLY | hevc | quality | -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=20,period=144 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | cpu_weak_encoder
      CPU_ONLY | hevc | balanced | -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=23,period=144 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | cpu_weak_encoder
      CPU_ONLY | hevc | size | -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=26,period=144 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | cpu_weak_encoder
      CPU_ONLY | h264 | quality | -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4200000 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | cpu_weak_encoder
      CPU_ONLY | h264 | balanced | -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4200000 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | cpu_weak_encoder
      CPU_ONLY | h264 | size | -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4043520 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | cpu_weak_encoder
      QSV_ONLY | av1 | quality | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 28 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | av1 | balanced | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | av1 | size | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 38 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | av1 gpu | quality | -c:v:0 av1_qsv -preset:v:0 veryslow -global_quality:v:0 26 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | av1 gpu | balanced | -c:v:0 av1_qsv -preset:v:0 veryslow -global_quality:v:0 30 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | av1 gpu | size | -c:v:0 av1_qsv -preset:v:0 veryslow -global_quality:v:0 34 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | hevc | quality | -c:v:0 hevc_qsv -preset:v:0 veryslow -global_quality:v:0 23 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | hevc | balanced | -c:v:0 hevc_qsv -preset:v:0 veryslow -global_quality:v:0 26 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | hevc | size | -c:v:0 hevc_qsv -preset:v:0 veryslow -global_quality:v:0 29 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | h264 | quality | -c:v:0 h264_qsv -preset:v:0 veryslow -global_quality:v:0 21 -look_ahead:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | h264 | balanced | -c:v:0 h264_qsv -preset:v:0 veryslow -global_quality:v:0 24 -look_ahead:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      QSV_ONLY | h264 | size | -c:v:0 h264_qsv -preset:v:0 veryslow -global_quality:v:0 27 -look_ahead:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | av1 | quality | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 28 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | av1 | balanced | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | av1 | size | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 38 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | av1 gpu | quality | -c:v:0 av1_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 22 -preanalysis:v:0 1 -align:v:0 1080p -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | av1 gpu | balanced | -c:v:0 av1_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 26 -preanalysis:v:0 1 -align:v:0 1080p -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | av1 gpu | size | -c:v:0 av1_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 30 -preanalysis:v:0 1 -align:v:0 1080p -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | hevc | quality | -c:v:0 hevc_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 20 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | hevc | balanced | -c:v:0 hevc_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 23 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | hevc | size | -c:v:0 hevc_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 26 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | h264 | quality | -c:v:0 h264_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 20 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | h264 | balanced | -c:v:0 h264_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 23 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      AMF_ONLY | h264 | size | -c:v:0 h264_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 26 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | av1 | quality | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 28 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | av1 | balanced | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | av1 | size | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 38 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | av1 gpu | quality | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 28 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | encoder_fallback→libsvtav1
      NVENC_DEGRADED | av1 gpu | balanced | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | encoder_fallback→libsvtav1
      NVENC_DEGRADED | av1 gpu | size | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 38 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | encoder_fallback→libsvtav1
      NVENC_DEGRADED | hevc | quality | -c:v:0 hevc_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 80 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | hevc | balanced | -c:v:0 hevc_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 70 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | hevc | size | -c:v:0 hevc_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 60 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | h264 | quality | -c:v:0 h264_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 80 -profile:v:0 100 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | h264 | balanced | -c:v:0 h264_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 70 -profile:v:0 100 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      NVENC_DEGRADED | h264 | size | -c:v:0 h264_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 60 -profile:v:0 100 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
    `);
  });
});

// ── Chains ─────────────────────────────────────────────────────────────────────────────────────

/** Every configuration of `table` working; then the chosen one is knocked out, again and again, until nothing is left. */
function chainOrder(codec: CompressCodec, useGpuForAv1: boolean, start: PlannerCapabilities['encoders'], value = HD) {
  const encoders = structuredClone(start) as Record<string, { variants: Record<string, boolean> }>;
  const order: string[] = [];
  for (let step = 0; step < 20; step++) {
    const outcome = buildPlan(value, compress({ codec, useGpuForAv1 }), caps(encoders));
    if (outcome.status === 'error') return { order, outcome };
    const pick = chosen(value, compress({ codec, useGpuForAv1 }), caps(encoders));
    order.push(pick);
    const [encoder, variant] = pick.split('/');
    encoders[encoder] = { variants: { ...encoders[encoder]?.variants, [variant]: false } };
  }
  throw new Error('the chain never ends');
}
const EVERY: PlannerCapabilities['encoders'] = {
  ...NVENC_ENCODERS, ...MF_ENCODERS,
  av1_qsv: { variants: { '10bit': true } }, hevc_qsv: { variants: { '8bit': true, '10bit': true } }, h264_qsv: { variants: { '8bit': true } },
  av1_amf: { variants: { '10bit': true } }, hevc_amf: { variants: { '8bit': true, '10bit': true } }, h264_amf: { variants: { '8bit': true } },
};

describe('the encoder chains (AC-ENCODE-02-1, AC-ENCODE-02-2)', () => {
  it('HEVC: nvenc → qsv → amf → mf (hardware) → libkvazaar, 10-bit before 8-bit, uhq before hq', () => {
    const { order, outcome } = chainOrder('hevc', false, EVERY);
    expect(order).toEqual([
      'hevc_nvenc/10bit_uhq', 'hevc_nvenc/10bit', 'hevc_nvenc/8bit_uhq', 'hevc_nvenc/8bit', 'hevc_qsv/10bit', 'hevc_qsv/8bit',
      'hevc_amf/10bit', 'hevc_amf/8bit', 'hevc_mf/8bit', 'libkvazaar/8bit',
    ]);
    expect(outcome).toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'h264'] });
    expect(VIDEO_CHAINS.hevc.map(item => item.encoder)).toEqual(['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'libkvazaar']);
  });

  it('H.264: nvenc → qsv → amf → mf (hardware) → mf (software) → libopenh264', () => {
    const { order, outcome } = chainOrder('h264', false, EVERY);
    expect(order).toEqual(['h264_nvenc/8bit', 'h264_qsv/8bit', 'h264_amf/8bit', 'h264_mf/8bit', 'h264_mf/8bit_sw', 'libopenh264/8bit']);
    expect(outcome).toMatchObject({ status: 'error', reason: 'no_encoder_available' });
  });

  it('AV1: libsvtav1 unless the graphics card is asked for; then av1_nvenc → av1_qsv → av1_amf → libsvtav1', () => {
    expect(chainOrder('av1', false, EVERY).order).toEqual(['libsvtav1/10bit']);
    expect(chainOrder('av1', true, EVERY).order).toEqual(['av1_nvenc/10bit_uhq', 'av1_nvenc/10bit', 'av1_qsv/10bit', 'av1_amf/10bit', 'libsvtav1/10bit']);
    // AV1 is 10-bit on every encoder.
    for (const { variants } of [...VIDEO_CHAINS.av1, ...VIDEO_CHAINS.av1_gpu]) expect(variants.every(variant => variant.startsWith('10bit'))).toBe(true);
  });

  it('passes over the encoders degraded in this session', () => {
    expect(chosen(HD, compress({ codec: 'hevc' }), caps(EVERY, ['hevc_nvenc']))).toBe('hevc_qsv/10bit');
    expect(chosen(HD, compress({ codec: 'h264' }), caps(EVERY, ['h264_nvenc', 'h264_qsv', 'h264_amf']))).toBe('h264_mf/8bit');
    // The degraded set names an encoder, so both modes of h264_mf go.
    expect(chosen(HD, compress({ codec: 'h264' }), caps(EVERY, ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']))).toBe('libopenh264/8bit');
    expect(chosen(HD, compress({ codec: 'av1', useGpuForAv1: true }), caps(EVERY, ['av1_nvenc']))).toBe('av1_qsv/10bit');
  });

  it('falls back to 8-bit HEVC (Main, yuv420p) when 10-bit did not pass', () => {
    const eightBit = caps({ hevc_nvenc: { variants: { '8bit': true, '8bit_uhq': true, '10bit': false, '10bit_uhq': false }, uhq: true } });
    const args = argsOf(HD, compress({ codec: 'hevc' }), eightBit);
    expect(args.slice(0, 2)).toEqual(['-c:v:0', 'hevc_nvenc']);
    expect([option(args, 'tune'), option(args, 'profile'), option(args, 'pix_fmt'), option(args, 'filter')]).toEqual(['uhq', 'main', 'yuv420p', chain('yuv420p')]);
    expect(chosen(HD, compress({ codec: 'hevc' }), caps({ hevc_qsv: { variants: { '8bit': true, '10bit': false } } }))).toBe('hevc_qsv/8bit');
    expect(option(argsOf(HD, compress({ codec: 'hevc' }), caps({ hevc_amf: { variants: { '8bit': true } } })), 'pix_fmt')).toBe('nv12');
  });

  it('keeps an HDR source on a 10-bit configuration further down the chain before an 8-bit one', () => {
    const mixed = caps({ hevc_nvenc: { variants: { '8bit': true } }, hevc_qsv: { variants: { '10bit': true } } });
    const hdr = media({ pixFmt: 'yuv420p10le', bitDepth: 10, colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc', hdr: HDR10 });
    expect(chosen(HD, compress({ codec: 'hevc' }), mixed)).toBe('hevc_nvenc/8bit');
    expect(chosen(hdr, compress({ codec: 'hevc' }), mixed)).toBe('hevc_qsv/10bit');
    // Nothing 10-bit: the chain as usual (T-ENCODE-03 tone maps).
    expect(chosen(hdr, compress({ codec: 'hevc' }), caps({ hevc_nvenc: { variants: { '8bit': true } } }))).toBe('hevc_nvenc/8bit');
    expect(chosen(hdr, compress({ codec: 'h264' }), CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    expect(chosen(hdr, compress({ codec: 'av1', useGpuForAv1: true }), CAPS.ALL_NVENC)).toBe('av1_nvenc/10bit_uhq');
  });

  it('skips NVENC for a picture under its minimum (108×192), taking the next encoder of the chain', () => {
    const tiny = media({ width: 108, height: 192 });
    const nvencAndMf = caps({ ...NVENC_ENCODERS, ...MF_ENCODERS });
    // The Media Foundation hardware encoders of an NVIDIA card are NVENC and refuse it too (measured).
    expect(chosen(tiny, compress({ codec: 'hevc' }), nvencAndMf)).toBe('libkvazaar/8bit');
    expect(chosen(tiny, compress({ codec: 'h264' }), nvencAndMf)).toBe('h264_mf/8bit_sw');
    expect(chosen(tiny, compress({ codec: 'hevc' }), CAPS.ALL_NVENC)).toBe('libkvazaar/8bit');
    expect(chosen(tiny, compress({ codec: 'h264' }), CAPS.ALL_NVENC)).toBe('libopenh264/8bit');
    expect(chosen(tiny, compress({ codec: 'av1', useGpuForAv1: true }), CAPS.ALL_NVENC)).toBe('libsvtav1/10bit');
    // The other hardware encoders are not measured and keep the chain's order.
    expect(chosen(tiny, compress({ codec: 'hevc' }), CAPS.QSV_ONLY)).toBe('hevc_qsv/10bit');
    // A rotated phone clip is judged as shown, after scaling: 1080×1920 stored on its side, limited to 480 → 480×854.
    expect(chosen(media({ width: 1920, height: 1080, rotation: 90 }), compress({ codec: 'h264', maxShortSide: 480 }), CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
  });

  it('keeps NVENC and the MF hardware encoders within the range each codec opens, which the old 144×120 of caps.nvencMin no longer narrows', () => {
    const at = (width: number, height: number, codec: CompressCodec, table: PlannerCapabilities, extra: Partial<CompressSettings> = {}) =>
      chosen(media({ width, height }), compress({ codec, ...extra }), table);
    // AC-ENCODE-02-2 replaced "NVENC ≥ 144 × 120" (design §7b): pictures under it but inside the codec's range go to NVENC.
    // caps.nvencMin still says 144×120 here (NVENC_MIN), as engine design §3 does.
    expect(CAPS.ALL_NVENC.nvencMin).toEqual({ width: 144, height: 120 });
    expect(at(144, 120, 'hevc', CAPS.ALL_NVENC)).toBe('hevc_nvenc/10bit_uhq');
    expect(at(142, 120, 'hevc', CAPS.ALL_NVENC)).toBe('hevc_nvenc/10bit_uhq');
    expect(at(144, 118, 'hevc', CAPS.ALL_NVENC)).toBe('hevc_nvenc/10bit_uhq');
    expect(at(130, 34, 'hevc', CAPS.ALL_NVENC)).toBe('hevc_nvenc/10bit_uhq');
    expect(at(146, 50, 'h264', CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    expect(at(1280, 100, 'h264', CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    expect(at(130, 66, 'av1', CAPS.ALL_NVENC, { useGpuForAv1: true })).toBe('av1_nvenc/10bit_uhq');
    // Measured: H.264 needs 145 wide (146 as an even side), so 144×120 is refused.
    expect(at(144, 120, 'h264', CAPS.ALL_NVENC)).toBe('libopenh264/8bit');
    expect(at(146, 120, 'h264', CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    // Whatever caps.nvencMin holds, the choices are those of the codec's range alone.
    const sizes = [[146, 50], [144, 50], [146, 48], [130, 34], [128, 34], [130, 32], [130, 66], [130, 64], [144, 120], [4096, 2304], [4098, 50]] as const;
    const choices = (nvencMin: { width: number; height: number }) => (['h264', 'hevc', 'av1'] as const).flatMap(codec =>
      sizes.map(([width, height]) => at(width, height, codec, caps({ ...NVENC_ENCODERS, ...MF_ENCODERS }, [], nvencMin), { useGpuForAv1: true })));
    expect(choices({ width: 2, height: 2 })).toEqual(choices(NVENC_MIN));
    expect(choices({ width: 4096, height: 4096 })).toEqual(choices(NVENC_MIN));
    // Below the range: HEVC under 129×33, H.264 under 49 high, AV1 under 65 high.
    const nvencAndMf = caps({ ...NVENC_ENCODERS, ...MF_ENCODERS });
    expect(at(128, 34, 'hevc', nvencAndMf)).toBe('libkvazaar/8bit');
    expect(at(130, 32, 'hevc', nvencAndMf)).toBe('libkvazaar/8bit');
    expect(at(146, 48, 'h264', nvencAndMf)).toBe('h264_mf/8bit_sw');
    expect(at(160, 64, 'av1', nvencAndMf, { useGpuForAv1: true })).toBe('libsvtav1/10bit');
    // The MF hardware encoders have the same range: with NVENC degraded they take what NVENC would.
    const mfOnly = caps({ ...NVENC_ENCODERS, ...MF_ENCODERS }, ['hevc_nvenc', 'h264_nvenc']);
    expect(at(140, 100, 'hevc', mfOnly)).toBe('hevc_mf/8bit');
    expect(at(128, 100, 'hevc', mfOnly)).toBe('libkvazaar/8bit');
    expect(at(146, 50, 'h264', only('h264_mf', '8bit'))).toBe('h264_mf/8bit');
    expect(at(144, 50, 'h264', caps(MF_ENCODERS))).toBe('h264_mf/8bit_sw');
    // An unknown size: NVENC is not given it; the MF hardware encoders are (design choice of T-ENCODE-02, unchanged).
    expect(chosen(media({ width: 0, height: 0 }), compress({ codec: 'h264' }), caps(MF_ENCODERS))).toBe('h264_mf/8bit');
  });

  it('keeps a large picture off the encoders that refuse it: H.264 hardware over 4096 a side, HEVC and AV1 over 8192, openh264 over 4096 × 2304', () => {
    const at = (width: number, height: number, codec: CompressCodec, table: PlannerCapabilities, extra: Partial<CompressSettings> = {}) =>
      chosen(media({ width, height }), compress({ codec, ...extra }), table);
    const every = caps(EVERY);
    // A 5.3K action camera clip: the H.264 hardware encoders refuse it, the software MFT takes it.
    expect(at(5312, 2988, 'h264', caps({ ...NVENC_ENCODERS, ...MF_ENCODERS }))).toBe('h264_mf/8bit_sw');
    expect(at(5312, 2988, 'h264', CAPS.ALL_NVENC, { maxShortSide: 2160 })).toBe('h264_nvenc/8bit');
    expect(at(4096, 2304, 'h264', CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    expect(at(2304, 4096, 'h264', CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    expect(at(2304, 4112, 'h264', caps({ ...NVENC_ENCODERS, ...MF_ENCODERS }))).toBe('h264_mf/8bit_sw');
    expect(at(5312, 2988, 'hevc', every)).toBe('hevc_nvenc/10bit_uhq');
    expect(at(8192, 4320, 'hevc', every)).toBe('hevc_nvenc/10bit_uhq');
    expect(at(8208, 4320, 'hevc', caps({ ...NVENC_ENCODERS, ...MF_ENCODERS }))).toBe('libkvazaar/8bit');
    expect(at(8208, 4320, 'av1', CAPS.ALL_NVENC, { useGpuForAv1: true })).toBe('libsvtav1/10bit');
    // Only openh264 left: up to 4096 × 2304 pixels; beyond, no H.264 encoder, and the codecs that would work.
    expect(at(4096, 2304, 'h264', CAPS.CPU_ONLY)).toBe('libopenh264/8bit');
    expect(buildPlan(media({ width: 5312, height: 2988 }), compress({ codec: 'h264' }), CAPS.CPU_ONLY))
      .toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'hevc'] });
    expect(at(5312, 2988, 'h264', CAPS.CPU_ONLY, { maxShortSide: 2160 })).toBe('libopenh264/8bit');
  });

  it('holds exactly the measured size ranges of AC-ENCODE-02-2, each boundary inside and one step outside', () => {
    // As the AC writes them: NVENC H.264 145–4096 wide, ≥ 49 high; HEVC ≥ 129 × ≥ 33; AV1 ≥ 129 × ≥ 65; H.264 ≤ 4096 and HEVC/AV1 ≤ 8192 a side.
    expect(VIDEO_TABLE.hardwareFrame).toEqual({
      h264: { minWidth: 145, minHeight: 49, maxSide: 4096 }, hevc: { minWidth: 129, minHeight: 33, maxSide: 8192 }, av1: { minWidth: 129, minHeight: 65, maxSide: 8192 },
    });
    const edges = [['h264', 145, 49, 4096], ['hevc', 129, 33, 8192], ['av1', 129, 65, 8192]] as const;
    for (const [codec, minWidth, minHeight, maxSide] of edges) {
      const fits = (width: number, height: number) => hardwareFrameFits(codec, { width, height });
      expect([fits(minWidth, minHeight), fits(maxSide, minHeight), fits(minWidth, maxSide), fits(maxSide, maxSide)], codec).toEqual([true, true, true, true]);
      expect([fits(minWidth - 1, minHeight), fits(minWidth, minHeight - 1), fits(maxSide + 1, minHeight), fits(minWidth, maxSide + 1)], codec).toEqual([false, false, false, false]);
      // Under the old "144 × 120" but inside the measured range: taken (it was refused before batch B's correction).
      expect([fits(143, 119), fits(144, 120)], codec).toEqual(codec === 'h264' ? [false, false] : [true, true]);
    }
    expect([hardwareFrameFits('h264', { width: 145, height: 119 }), hardwareFrameFits('h264', { width: 4096, height: 49 })]).toEqual([true, true]);
    // libopenh264: an area of at most 4096 × 2304 = 9 437 184 pixels, whatever the shape.
    expect(VIDEO_TABLE.openh264MaxPixels).toBe(4096 * 2304);
    for (const [width, height, fits] of [[4096, 2304, true], [2304, 4096, true], [3072, 3072, true], [4097, 2304, false], [4096, 2305, false], [3072, 3073, false]] as const) {
      expect(openh264Fits({ width, height }), `${width}×${height}`).toBe(fits);
    }

    // The same through the planner, whose sides are even (kvazaar's multiples of 8): the first even size
    // inside and the last one outside, with the capability table's own nvencMin (144×120), which does not narrow the range.
    const at = (width: number, height: number, codec: CompressCodec, table: PlannerCapabilities, extra: Partial<CompressSettings> = {}) =>
      chosen(media({ width, height }), compress({ codec, ...extra }), table);
    const nvencOnly = caps({ ...NVENC_ENCODERS });
    const gpu = { useGpuForAv1: true };
    expect([at(146, 50, 'h264', nvencOnly), at(4096, 50, 'h264', nvencOnly), at(146, 4096, 'h264', nvencOnly)]).toEqual(Array(3).fill('h264_nvenc/8bit'));
    expect([at(144, 50, 'h264', nvencOnly), at(146, 48, 'h264', nvencOnly), at(4098, 50, 'h264', nvencOnly), at(146, 4098, 'h264', nvencOnly)]).toEqual(Array(4).fill('libopenh264/8bit'));
    expect([at(130, 34, 'hevc', nvencOnly), at(8192, 34, 'hevc', nvencOnly), at(130, 8192, 'hevc', nvencOnly)]).toEqual(Array(3).fill('hevc_nvenc/10bit_uhq'));
    expect([at(128, 34, 'hevc', nvencOnly), at(130, 32, 'hevc', nvencOnly), at(8194, 34, 'hevc', nvencOnly), at(130, 8194, 'hevc', nvencOnly)]).toEqual(Array(4).fill('libkvazaar/8bit'));
    expect([at(130, 66, 'av1', nvencOnly, gpu), at(8192, 66, 'av1', nvencOnly, gpu), at(130, 8192, 'av1', nvencOnly, gpu)]).toEqual(Array(3).fill('av1_nvenc/10bit_uhq'));
    expect([at(128, 66, 'av1', nvencOnly, gpu), at(130, 64, 'av1', nvencOnly, gpu), at(8194, 66, 'av1', nvencOnly, gpu), at(130, 8194, 'av1', nvencOnly, gpu)]).toEqual(Array(4).fill('libsvtav1/10bit'));
    // The Media Foundation hardware encoders: the same range, without NVENC's floor.
    const mf = caps(MF_ENCODERS);
    expect([at(146, 50, 'h264', mf), at(4096, 2304, 'h264', mf)]).toEqual(['h264_mf/8bit', 'h264_mf/8bit']);
    expect([at(144, 50, 'h264', mf), at(146, 48, 'h264', mf), at(4098, 2304, 'h264', mf)]).toEqual(Array(3).fill('h264_mf/8bit_sw'));
    expect([at(130, 34, 'hevc', mf), at(8192, 4320, 'hevc', mf)]).toEqual(['hevc_mf/8bit', 'hevc_mf/8bit']);
    expect([at(128, 34, 'hevc', mf), at(130, 32, 'hevc', mf), at(8194, 4320, 'hevc', mf)]).toEqual(Array(3).fill('libkvazaar/8bit'));
    // openh264 alone: up to the area, then no H.264 encoder at all.
    expect(at(4096, 2304, 'h264', CAPS.CPU_ONLY)).toBe('libopenh264/8bit');
    expect(buildPlan(media({ width: 4098, height: 2304 }), compress({ codec: 'h264' }), CAPS.CPU_ONLY)).toMatchObject({ status: 'error', reason: 'no_encoder_available' });
    // kvazaar: sides rounded down to multiples of 8 (at most 7 pixels lost), so 15×15 encodes at 8×8 and 7×7 not at all.
    expect(encodeOf(media({ width: 15, height: 15 }), compress({ codec: 'hevc' }), CAPS.CPU_ONLY)).toMatchObject({ encoder: 'libkvazaar', frame: { width: 8, height: 8 } });
    expect(encodeOf(media({ width: 8, height: 8 }), compress({ codec: 'hevc' }), CAPS.CPU_ONLY)).toMatchObject({ encoder: 'libkvazaar', frame: { width: 8, height: 8 } });
    expect(buildPlan(media({ width: 7, height: 7 }), compress({ codec: 'hevc' }), CAPS.CPU_ONLY)).toMatchObject({ status: 'error', reason: 'no_encoder_available' });
  });

  it('says cpu_weak_encoder for libkvazaar, h264_mf in software and libopenh264 only', () => {
    expect(warningCodes(HD, compress({ codec: 'hevc' }), CAPS.CPU_ONLY)).toContain('cpu_weak_encoder');
    expect(warningCodes(HD, compress({ codec: 'h264' }), CAPS.CPU_ONLY)).toContain('cpu_weak_encoder');
    expect(warningCodes(HD, compress({ codec: 'h264' }), only('h264_mf', '8bit_sw'))).toContain('cpu_weak_encoder');
    for (const [codec, table] of [['h264', only('h264_mf', '8bit')], ['hevc', only('hevc_mf', '8bit')], ['av1', CAPS.CPU_ONLY], ['hevc', CAPS.ALL_NVENC], ['h264', CAPS.QSV_ONLY]] as const) {
      expect(warningCodes(HD, compress({ codec }), table)).not.toContain('cpu_weak_encoder');
    }
    expect(planOf(buildPlan(HD, compress({ codec: 'hevc' }), CAPS.CPU_ONLY)).summary.warnings).toContainEqual({ code: 'cpu_weak_encoder', streams: [0], count: 1 });
  });

  it('says encoder_fallback to libsvtav1 when the graphics card is asked for but no hardware AV1 encoder works', () => {
    expect(planOf(buildPlan(HD, compress({ codec: 'av1', useGpuForAv1: true }), CAPS.CPU_ONLY)).summary.warnings)
      .toEqual([{ code: 'encoder_fallback', streams: [0], count: 1, to: 'libsvtav1' }]);
    expect(warningCodes(HD, compress({ codec: 'av1', useGpuForAv1: false }), CAPS.CPU_ONLY)).toEqual([]);
    expect(warningCodes(HD, compress({ codec: 'av1', useGpuForAv1: true }), CAPS.ALL_NVENC)).toEqual([]);
  });

  it('answers no_encoder_available with the codecs that would work, and no arguments', () => {
    const noKvazaar = caps({ libkvazaar: { variants: { '8bit': false } } });
    expect(buildPlan(HD, compress({ codec: 'hevc' }), noKvazaar)).toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'h264'] });
    expect(buildPlan(HD, compress({ codec: 'hevc' }), caps({}, ['libkvazaar']))).toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'h264'] });
    const noCpu = caps({ libsvtav1: { variants: { '10bit': false } }, libkvazaar: { variants: { '8bit': false } }, libopenh264: { variants: { '8bit': false } } });
    expect(buildPlan(HD, compress({ codec: 'av1' }), noCpu)).toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: [] });
    expect(buildPlan(HD, compress({ codec: 'av1' }), { ...noCpu, encoders: { ...noCpu.encoders, ...NVENC_ENCODERS } }))
      .toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['hevc', 'h264'] });
    // The same for "convert": the H.264 chain of MP4 with nothing to run it.
    expect(buildPlan(media({ codec: 'mpeg4' }), convert('mp4'), caps({ libopenh264: { variants: { '8bit': false } } })))
      .toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'hevc'] });
    // A picture too small for kvazaar and NVENC: HEVC has no encoder, the others do.
    expect(buildPlan(media({ width: 6, height: 6 }), compress({ codec: 'hevc' }), CAPS.ALL_NVENC)).toEqual({ status: 'error', reason: 'no_encoder_available', alternatives: ['av1', 'h264'] });
  });
});

// ── Output size ────────────────────────────────────────────────────────────────────────────────

describe('the output size (AC-ENCODE-02-3, design §4)', () => {
  const sizeOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities = CAPS.CPU_ONLY) => {
    const frame = encodeOf(value, settings, table).frame;
    return frame ? `${frame.width}x${frame.height}` : null;
  };
  const scaleOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities = CAPS.CPU_ONLY) =>
    encodeOf(value, settings, table).filters.find(filter => filter.startsWith('scale='));

  it('limits the short side of the shown picture, keeps the aspect ratio and even sides', () => {
    expect(sizeOf(HD, compress({ codec: 'av1', maxShortSide: 720 }))).toBe('1280x720');
    expect(scaleOf(HD, compress({ codec: 'av1', maxShortSide: 720 }))).toBe('scale=w=1280:h=720:flags=lanczos+accurate_rnd+full_chroma_int');
    expect(sizeOf(media({ width: 3840, height: 2160 }), compress({ codec: 'av1', maxShortSide: 1080 }))).toBe('1920x1080');
    // Portrait: 1080×1920 under 720p is 720×1280, whether stored upright or on its side with a rotation.
    expect(sizeOf(media({ width: 1080, height: 1920 }), compress({ codec: 'av1', maxShortSide: 720 }))).toBe('720x1280');
    expect(sizeOf(media({ width: 1920, height: 1080, rotation: 90 }), compress({ codec: 'av1', maxShortSide: 720 }))).toBe('720x1280');
    expect(scaleOf(media({ width: 1920, height: 1080, rotation: 270 }), compress({ codec: 'hevc', maxShortSide: 720 }), CAPS.ALL_NVENC)).toBe('scale=w=720:h=1280:flags=lanczos+accurate_rnd+full_chroma_int');
    // 21:9 at 480: 1920 × 480 ÷ 804 = 1146.27 → 1146.
    expect(sizeOf(media({ width: 1920, height: 804 }), compress({ codec: 'av1', maxShortSide: 480 }))).toBe('1146x480');
  });

  it('never enlarges, and does not scale a picture already within the limit', () => {
    expect(sizeOf(HD, compress({ codec: 'av1', maxShortSide: 1440 }))).toBe('1920x1080');
    expect(scaleOf(HD, compress({ codec: 'av1', maxShortSide: 1440 }))).toBeUndefined();
    expect(scaleOf(HD, compress({ codec: 'av1', maxShortSide: 1080 }))).toBeUndefined();
    expect(sizeOf(media({ width: 1280, height: 720 }), compress({ codec: 'h264', maxShortSide: 2160 }), CAPS.ALL_NVENC)).toBe('1280x720');
    expect(sizeOf(media({ width: 640, height: 360 }), compress({ codec: 'hevc' }), CAPS.ALL_NVENC)).toBe('640x360');
    // A side just over the limit only ever goes down: 1921 × 1080 ÷ 1081 = 1919.2 → 1920.
    expect(sizeOf(media({ width: 1921, height: 1081 }), compress({ codec: 'av1', maxShortSide: 1080 }))).toBe('1920x1080');
    for (const [width, height] of [[1921, 1081], [1001, 721], [5000, 2161], [2161, 3841]]) {
      for (const limit of [480, 720, 1080, 1440, 2160] as const) {
        for (const multiple of [2, 8] as const) {
          const size = outputSize({ width, height }, limit, multiple)!;
          expect(size.width <= width && size.height <= height).toBe(true);
          expect(size.width % multiple === 0 && size.height % multiple === 0).toBe(true);
          expect(Math.min(size.width, size.height)).toBeLessThanOrEqual(limit);
        }
      }
    }
  });

  it('rounds an odd side down to even', () => {
    expect(sizeOf(media({ width: 853, height: 481 }), compress({ codec: 'av1' }))).toBe('852x480');
    expect(scaleOf(media({ width: 853, height: 481 }), compress({ codec: 'av1' }))).toBe('scale=w=852:h=480:flags=lanczos+accurate_rnd+full_chroma_int');
    expect(scaleOf(media({ width: 854, height: 480 }), compress({ codec: 'av1' }))).toBeUndefined();
  });

  it('gives kvazaar multiples of 8, rounding down (854×480 → 848×480, 1920×804 → 1920×800)', () => {
    expect(sizeOf(media({ width: 854, height: 480 }), compress({ codec: 'hevc' }))).toBe('848x480');
    expect(scaleOf(media({ width: 854, height: 480 }), compress({ codec: 'hevc' }))).toBe('scale=w=848:h=480:flags=lanczos+accurate_rnd+full_chroma_int');
    expect(sizeOf(media({ width: 1920, height: 804 }), compress({ codec: 'hevc' }))).toBe('1920x800');
    expect(sizeOf(media({ width: 1920, height: 804 }), compress({ codec: 'hevc', maxShortSide: 480 }))).toBe('1144x480');
    expect(sizeOf(media({ width: 1080, height: 1920 }), compress({ codec: 'hevc', maxShortSide: 720 }))).toBe('720x1280');
    // The other encoders keep the even size.
    expect(sizeOf(media({ width: 854, height: 480 }), compress({ codec: 'hevc' }), CAPS.ALL_NVENC)).toBe('854x480');
    expect(sizeOf(media({ width: 1920, height: 804 }), compress({ codec: 'h264' }))).toBe('1920x804');
  });

  it('leaves a picture of unknown size alone and keeps it off the encoders that need the size', () => {
    const unknown = media({ width: 0, height: 0 });
    expect(encodeOf(unknown, compress({ codec: 'av1', maxShortSide: 720 }), CAPS.CPU_ONLY)).toMatchObject({ frame: null, filters: ['format=yuv420p10le', BT709] });
    expect(chosen(unknown, compress({ codec: 'h264' }), CAPS.ALL_NVENC)).toBe('libopenh264/8bit');
    expect(buildPlan(unknown, compress({ codec: 'hevc' }), CAPS.ALL_NVENC)).toMatchObject({ status: 'error', reason: 'no_encoder_available' });
  });

  it('feeds the output size and frame rate to the output cap', () => {
    const encode = encodeOf(media({ width: 3840, height: 2160 }), compress({ codec: 'av1', maxShortSide: 1080 }), CAPS.CPU_ONLY);
    expect(encode.frame).toEqual({ width: 1920, height: 1080, fps: 30 });
    const off = planOf(buildPlan(media({ width: 3840, height: 2160 }, { sizeBytes: 1_000_000 }), compress({ codec: 'av1', maxShortSide: 1080, discardIfNotSmaller: false }), CAPS.CPU_ONLY));
    // design §7b: max(4 × the 1 MB source, 1 bit × the output pixel rate × 60 s) × 1.05 + 16 MiB.
    expect(off.outputs[0].capBytes).toBe(Math.ceil(1.0 * 1920 * 1080 * 30 * 60 / 8 * 1.05 + 16 * 1024 * 1024));
    // An unknown rate stays unknown for the cap, which then assumes its own generous 60 fps (the GOP takes 30).
    const unknownRate = media({ fps: null, rFrameRate: null, avgFrameRate: null }, { sizeBytes: 1_000_000 });
    expect(encodeOf(unknownRate, compress({ codec: 'av1' }), CAPS.CPU_ONLY).frame).toEqual({ width: 1920, height: 1080, fps: null });
    expect(planOf(buildPlan(unknownRate, compress({ codec: 'h264', discardIfNotSmaller: false }), CAPS.ALL_NVENC)).outputs[0].capBytes)
      .toBe(Math.ceil(1.0 * 1920 * 1080 * 60 * 60 / 8 * 1.05 + 16 * 1024 * 1024));
  });
});

// ── Values per output ──────────────────────────────────────────────────────────────────────────

describe('the values filled into the tables', () => {
  it('takes the SVT-AV1 CRF by tier and output short side, and sets no GOP for it', () => {
    const crf = (width: number, height: number, tier: Tier, maxShortSide: CompressSettings['maxShortSide'] = null) =>
      option(argsOf(media({ width, height }), compress({ codec: 'av1', tier, maxShortSide }), CAPS.CPU_ONLY), 'crf');
    const sizes = [[640, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]] as const;
    expect(TIERS.map(tier => sizes.map(([width, height]) => Number(crf(width, height, tier))))).toEqual([[24, 26, 28, 29, 30], [28, 30, 32, 33, 34], [34, 36, 38, 39, 40]]);
    expect(crf(856, 482, 'balanced')).toBe('30');
    // The output, not the source, picks the column.
    expect(crf(3840, 2160, 'balanced', 1080)).toBe('32');
    const args = argsOf(HD, compress({ codec: 'av1' }), CAPS.CPU_ONLY);
    expect(args.some(arg => arg.startsWith('-g:') || arg.startsWith('-keyint'))).toBe(false);
    expect([option(args, 'preset'), option(args, 'pix_fmt')]).toEqual(['6', 'yuv420p10le']);
  });

  it('moves hardware values two steps from 1080p by output short side, the better way for each row', () => {
    const quality = (encoder: VideoEncoderId, variant: VariantKey, width: number, height: number, name: string, tier: Tier = 'balanced') =>
      Number(option(argsOf(media({ width, height }), compress({ codec: codecOf(encoder), tier, useGpuForAv1: true }), only(encoder, variant)), name));
    const sides = [[854, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]] as const;
    expect(sides.map(([w, h]) => quality('hevc_nvenc', '10bit_uhq', w, h, 'cq'))).toEqual([25, 25, 27, 27, 29]);
    expect(sides.map(([w, h]) => quality('av1_qsv', '10bit', w, h, 'global_quality'))).toEqual([28, 28, 30, 30, 32]);
    expect(sides.map(([w, h]) => quality('h264_amf', '8bit', w, h, 'qvbr_quality_level'))).toEqual([21, 21, 23, 23, 25]);
    // Media Foundation's quality rises with quality.
    expect(sides.map(([w, h]) => quality('hevc_mf', '8bit', w, h, 'quality'))).toEqual([72, 72, 70, 70, 68]);
    expect(sides.map(([w, h]) => quality('h264_mf', '8bit', w, h, 'quality', 'quality'))).toEqual([82, 82, 80, 80, 78]);
    // Not hardware: the software MFT and kvazaar keep their values.
    expect(sides.map(([w, h]) => quality('h264_mf', '8bit_sw', w, h, 'quality'))).toEqual([70, 70, 70, 70, 70]);
    expect(sides.map(([w, h]) => option(argsOf(media({ width: w, height: h }), compress({ codec: 'hevc' }), CAPS.CPU_ONLY), 'kvazaar-params')?.match(/qp=(\d+)/)?.[1]))
      .toEqual(['23', '23', '23', '23', '23']);
  });

  it('sets the GOP to round(5 × fps), and kvazaar\'s period to the nearest multiple of 16', () => {
    expect([23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 1].map(gopFrames)).toEqual([120, 120, 125, 150, 150, 250, 300, 300, 5]);
    // 5 × 23.976 = 119.9 is nearer 112 than 128; 5 × 24 = 120 is halfway and goes up.
    expect([23.976, 24, 25, 29.97, 30, 60, 1].map(kvazaarPeriod)).toEqual([112, 128, 128, 144, 144, 304, 16]);
    const at = (fps: number | null) => media({ fps, rFrameRate: fps === null ? null : `${Math.round(fps * 1000)}/1000`, avgFrameRate: fps === null ? null : `${Math.round(fps * 1000)}/1000` });
    expect(option(argsOf(at(23.976), compress({ codec: 'h264' }), CAPS.ALL_NVENC), 'g')).toBe('120');
    expect(option(argsOf(at(60), compress({ codec: 'hevc' }), only('hevc_mf', '8bit')), 'g')).toBe('300');
    expect(option(argsOf(at(25), compress({ codec: 'hevc' }), CAPS.CPU_ONLY), 'kvazaar-params')).toBe('preset=medium,qp=23,period=128');
    expect(option(argsOf(at(50), compress({ codec: 'h264' }), CAPS.CPU_ONLY), 'g')).toBe('250');
    // Unknown frame rate: 30 assumed.
    const unknown = media({ fps: null, rFrameRate: null, avgFrameRate: null }, { primaryVideoIndex: 0 });
    expect(option(argsOf(unknown, compress({ codec: 'h264' }), CAPS.ALL_NVENC), 'g')).toBe(String(gopFrames(VIDEO_TABLE.fallbackFps)));
  });

  it('gives openh264 min(bpp × w × h × fps, 0.7 × the source video rate)', () => {
    const rate = (value: MediaInfo, tier: Tier, maxShortSide: CompressSettings['maxShortSide'] = null) =>
      Number(option(argsOf(value, compress({ codec: 'h264', tier, maxShortSide }), CAPS.CPU_ONLY), 'b'));
    // 6 Mbit/s source: 0.7 × 6M caps the upper tiers; 0.065 × 1920 × 1080 × 30 = 4 043 520 is below it.
    expect(TIERS.map(tier => rate(HD, tier))).toEqual([4_200_000, 4_200_000, 4_043_520]);
    // A richer source: the bits per pixel decide.
    const rich = media({ bitRate: 50_000_000 });
    expect(TIERS.map(tier => rate(rich, tier))).toEqual([7_464_960, 5_598_720, 4_043_520]);
    // Of the output size: 1280 × 720 × 30 × 0.09.
    expect(rate(rich, 'balanced', 720)).toBe(2_488_320);
    // No stream rate: the container rate less the audio that states one.
    const muxed = media({ bitRate: null }, {
      bitRate: 8_000_000, audio: [{ index: 1, typeIndex: 0, codec: 'aac', profile: null, channels: 2, channelLayout: 'stereo', sampleRate: 48_000, sampleFormat: 'fltp',
        bitsPerRawSample: null, bitRate: 2_000_000, bitRateSource: 'stream', durationUs: 60 * SECONDS_US, language: null, title: null, default: true, forced: false }],
    });
    expect(rate(muxed, 'balanced')).toBe(4_200_000);
    expect(rate(media({ bitRate: null }, { bitRate: null }), 'balanced')).toBe(5_598_720);
    // A starved source never asks for less than the floor.
    expect(rate(media({ bitRate: 20_000 }), 'size')).toBe(VIDEO_TABLE.openh264MinBitRate);
    expect(encodeOf(HD, compress({ codec: 'h264' }), CAPS.CPU_ONLY).maxBitRate).toBe(4_200_000);
    expect(encodeOf(HD, compress({ codec: 'h264' }), CAPS.ALL_NVENC).maxBitRate).toBeNull();
  });
});

// ── Convert ────────────────────────────────────────────────────────────────────────────────────

describe('the convert codec per target container (AC-ENCODE-01-7)', () => {
  const mpeg4 = media({ codec: 'mpeg4', profile: 'Simple Profile' });

  it('MP4 and MOV: the H.264 chain; WebM: libsvtav1 10-bit; MKV: copy, or the AV1 chain when re-encoding', () => {
    expect(chosen(mpeg4, convert('mp4'), CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    expect(chosen(mpeg4, convert('mov'), CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
    expect(chosen(mpeg4, convert('mp4'), CAPS.CPU_ONLY)).toBe('libopenh264/8bit');
    expect(chosen(mpeg4, convert('mp4'), CAPS.NVENC_DEGRADED)).toBe('h264_mf/8bit');
    // Convert has no "use the graphics card": AV1 is libsvtav1 even where NVENC AV1 works.
    expect(chosen(mpeg4, convert('webm'), CAPS.ALL_NVENC)).toBe('libsvtav1/10bit');
    expect(videoDecision(mpeg4, convert('mkv'), CAPS.ALL_NVENC).action).toBe('copy');
    expect(chosen(mpeg4, convert('mkv', false), CAPS.ALL_NVENC)).toBe('libsvtav1/10bit');
    // ProRes is copied into MOV, re-encoded for MP4.
    const prores = media({ codec: 'prores', profile: 'HQ', pixFmt: 'yuv422p10le', bitDepth: 10, chromaSubsampling: '422' });
    expect(videoDecision(prores, convert('mov'), CAPS.ALL_NVENC).action).toBe('copy');
    expect(chosen(prores, convert('mp4'), CAPS.ALL_NVENC)).toBe('h264_nvenc/8bit');
  });

  it('uses the compress tiers with the same values, and never scales', () => {
    for (const [i, tier] of TIERS.entries()) {
      expect(option(argsOf(mpeg4, convert('webm', true, tier), CAPS.CPU_ONLY), 'crf')).toBe(String(VIDEO_TABLE.svtCrf[tier][2]));
      expect(option(argsOf(mpeg4, convert('mp4', true, tier), CAPS.ALL_NVENC), 'cq')).toBe(String(VIDEO_TABLE.quality.h264_nvenc[i]));
      expect(argsOf(mpeg4, convert('mp4', true, tier), CAPS.ALL_NVENC)).toEqual(argsOf(mpeg4, compress({ codec: 'h264', tier }), CAPS.ALL_NVENC));
    }
    expect(encodeOf(media({ codec: 'mpeg4', width: 3840, height: 2160 }), convert('webm'), CAPS.CPU_ONLY).filters).toEqual(['format=yuv420p10le', BT709]);
  });

  it('says cpu_weak_encoder for a weak CPU encoder here too', () => {
    expect(warningCodes(mpeg4, convert('mp4'), CAPS.CPU_ONLY)).toContain('cpu_weak_encoder');
    expect(warningCodes(mpeg4, convert('mov'), only('h264_mf', '8bit_sw'))).toContain('cpu_weak_encoder');
    expect(warningCodes(mpeg4, convert('webm'), CAPS.CPU_ONLY)).not.toContain('cpu_weak_encoder');
  });

  it('matches the snapshot of every container', () => {
    const lines = (['mp4', 'mov', 'webm', 'mkv'] as const).flatMap(target => [true, false].flatMap(preferRemux => (['ALL_NVENC', 'CPU_ONLY'] as const).map(name => {
      const decision = videoDecision(mpeg4, convert(target, preferRemux), CAPS[name]);
      return `${target}${preferRemux ? '' : ' re-encode'} | ${name} | ${videoArgs(decision, IO).join(' ')}`;
    })));
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "mp4 | ALL_NVENC | -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 24 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mp4 | CPU_ONLY | -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4200000 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mp4 re-encode | ALL_NVENC | -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 24 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mp4 re-encode | CPU_ONLY | -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4200000 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mov | ALL_NVENC | -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 24 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mov | CPU_ONLY | -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4200000 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mov re-encode | ALL_NVENC | -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 24 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mov re-encode | CPU_ONLY | -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4200000 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      webm | ALL_NVENC | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      webm | CPU_ONLY | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      webm re-encode | ALL_NVENC | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      webm re-encode | CPU_ONLY | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mkv | ALL_NVENC | -c:v:0 copy
      mkv | CPU_ONLY | -c:v:0 copy
      mkv re-encode | ALL_NVENC | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      mkv re-encode | CPU_ONLY | -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
    `);
  });
});

// ── Default codec ──────────────────────────────────────────────────────────────────────────────

describe('defaultCompressCodec (AC-ENCODE-02-7)', () => {
  it('is HEVC when any HEVC hardware encoder works, 8- or 10-bit', () => {
    expect(defaultCompressCodec(CAPS.ALL_NVENC)).toBe('hevc');
    expect(defaultCompressCodec(CAPS.QSV_ONLY)).toBe('hevc');
    expect(defaultCompressCodec(CAPS.AMF_ONLY)).toBe('hevc');
    expect(defaultCompressCodec(CAPS.NVENC_DEGRADED)).toBe('hevc');
    expect(defaultCompressCodec(caps({ hevc_mf: { variants: { '8bit': true } } }))).toBe('hevc');
    expect(defaultCompressCodec(caps({ hevc_nvenc: { variants: { '8bit': true, '10bit': false } } }))).toBe('hevc');
    expect(defaultCompressCodec(caps({ hevc_amf: { variants: { '10bit': true } } }))).toBe('hevc');
  });

  it('is H.264 with only CPU encoders, or no HEVC hardware encoder that works', () => {
    expect(defaultCompressCodec(CAPS.CPU_ONLY)).toBe('h264');
    expect(defaultCompressCodec(caps({ h264_nvenc: { variants: { '8bit': true } }, av1_nvenc: { variants: { '10bit': true } } }))).toBe('h264');
    expect(defaultCompressCodec(caps({ hevc_nvenc: { variants: { '8bit': false, '10bit': false, '8bit_uhq': false, '10bit_uhq': false } } }))).toBe('h264');
    expect(defaultCompressCodec(caps({ hevc_nvenc: { variants: { '10bit': true } } }, ['hevc_nvenc']))).toBe('h264');
    expect(defaultCompressCodec(caps({ libkvazaar: { variants: { '8bit': true } } }))).toBe('h264');
    expect(defaultCompressCodec(caps({ hevc_mf: { variants: { '8bit_sw': true } } }))).toBe('h264');
    // Only configurations the HEVC chain can pick count: these would fall through to libkvazaar.
    expect(defaultCompressCodec(caps({ hevc_mf: { variants: { '10bit': true } } }))).toBe('h264');
    expect(defaultCompressCodec(caps({ hevc_qsv: { variants: { '8bit_uhq': true } } }))).toBe('h264');
  });

  it('is pure: the same table gives the same answer and stays untouched', () => {
    const table = Object.freeze(structuredClone(CAPS.NVENC_DEGRADED));
    expect(defaultCompressCodec(table)).toBe(defaultCompressCodec(table));
  });
});

// ── Probe arguments and run-time options ───────────────────────────────────────────────────────

describe('probeArgs (engine design §3)', () => {
  const configurations = Object.entries(VIDEO_TABLE.parameters).flatMap(([encoder, variants]) => Object.keys(variants).map(variant => [encoder as VideoEncoderId, variant as VariantKey] as const));
  const probeSource = media({ width: PROBE_PICTURE.width, height: PROBE_PICTURE.height, fps: PROBE_PICTURE.fps, rFrameRate: '30/1', avgFrameRate: '30/1', bitRate: null }, { bitRate: null });

  it('is exactly what toFfmpegArgs writes for that configuration on the probe picture, at the balanced tier', () => {
    expect(configurations).toHaveLength(DESIGN_ROWS.length);
    for (const [encoder, variant] of configurations) {
      const settings = compress({ codec: codecOf(encoder), tier: 'balanced', useGpuForAv1: true });
      const output = planOf(buildPlan(probeSource, settings, only(encoder, variant))).outputs[0];
      const args = toFfmpegArgs(output, IO);
      const start = args.indexOf('-c:v:0');
      expect(args.slice(start, start + probeArgs(encoder, variant).length)).toEqual(probeArgs(encoder, variant));
      expect(probeArgs(encoder, variant).slice(0, 2)).toEqual(['-c:v:0', encoder]);
    }
    expect(encoderVariants('hevc_nvenc')).toEqual(['10bit_uhq', '10bit', '8bit_uhq', '8bit']);
    expect(encoderVariants('h264_mf')).toEqual(['8bit', '8bit_sw']);
  });

  it('refuses a configuration the tables do not have', () => {
    expect(() => probeArgs('libkvazaar', '10bit')).toThrow(TypeError);
    expect(() => probeArgs('h264_nvenc', '8bit_uhq')).toThrow(TypeError);
    expect(() => probeArgs('hevc_mf', '10bit')).toThrow(TypeError);
  });

  it('matches the snapshot', () => {
    expect(configurations.map(([encoder, variant]) => `${encoder}/${variant}: ${probeArgs(encoder, variant).join(' ')}`).join('\n')).toMatchInlineSnapshot(`
      "libsvtav1/10bit: -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 30 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      av1_nvenc/10bit_uhq: -c:v:0 av1_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 32 -b:v:0 0 -rc-lookahead:v:0 32 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      av1_nvenc/10bit: -c:v:0 av1_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 32 -b:v:0 0 -rc-lookahead:v:0 32 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      av1_qsv/10bit: -c:v:0 av1_qsv -preset:v:0 veryslow -global_quality:v:0 28 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      av1_amf/10bit: -c:v:0 av1_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 24 -preanalysis:v:0 1 -align:v:0 1080p -g:v:0 150 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_nvenc/10bit_uhq: -c:v:0 hevc_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 25 -b:v:0 0 -rc-lookahead:v:0 32 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_nvenc/10bit: -c:v:0 hevc_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 25 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_nvenc/8bit_uhq: -c:v:0 hevc_nvenc -preset:v:0 p7 -tune:v:0 uhq -rc:v:0 vbr -cq:v:0 25 -b:v:0 0 -rc-lookahead:v:0 32 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 main -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_nvenc/8bit: -c:v:0 hevc_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 25 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 main -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_qsv/10bit: -c:v:0 hevc_qsv -preset:v:0 veryslow -global_quality:v:0 24 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_qsv/8bit: -c:v:0 hevc_qsv -preset:v:0 veryslow -global_quality:v:0 24 -extbrc:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 main -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_amf/10bit: -c:v:0 hevc_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 21 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 main10 -pix_fmt:v:0 p010le -filter:v:0 format=p010le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_amf/8bit: -c:v:0 hevc_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 21 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 main -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      hevc_mf/8bit: -c:v:0 hevc_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 72 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      libkvazaar/8bit: -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=23,period=144 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      h264_nvenc/8bit: -c:v:0 h264_nvenc -preset:v:0 p7 -tune:v:0 hq -rc:v:0 vbr -cq:v:0 22 -b:v:0 0 -rc-lookahead:v:0 32 -bf:v:0 3 -b_ref_mode:v:0 middle -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      h264_qsv/8bit: -c:v:0 h264_qsv -preset:v:0 veryslow -global_quality:v:0 22 -look_ahead:v:0 1 -look_ahead_depth:v:0 40 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      h264_amf/8bit: -c:v:0 h264_amf -usage:v:0 high_quality -quality:v:0 quality -rc:v:0 qvbr -qvbr_quality_level:v:0 21 -preanalysis:v:0 1 -g:v:0 150 -profile:v:0 high -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      h264_mf/8bit: -c:v:0 h264_mf -hw_encoding:v:0 1 -rate_control:v:0 quality -quality:v:0 72 -profile:v:0 100 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      h264_mf/8bit_sw: -c:v:0 h264_mf -rate_control:v:0 quality -quality:v:0 70 -profile:v:0 100 -g:v:0 150 -pix_fmt:v:0 nv12 -filter:v:0 format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv
      libopenh264/8bit: -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 2488320 -g:v:0 150 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
    `);
  });
});

describe('run-time options', () => {
  it('adds lp=1 to SVT-AV1 in low-usage mode only, before the filters', () => {
    const svt = videoDecision(HD, compress({ codec: 'av1' }), CAPS.CPU_ONLY);
    expect(videoArgs(svt, { ...IO, lowUsage: true })).toEqual([
      '-c:v:0', 'libsvtav1', '-preset:v:0', '6', '-crf:v:0', '32', '-pix_fmt:v:0', 'yuv420p10le', '-svtav1-params:v:0', 'lp=1', '-filter:v:0', chain('yuv420p10le'),
    ]);
    expect(videoArgs(svt, IO)).not.toContain('-svtav1-params:v:0');
    expect(videoArgs(svt, { ...IO, lowUsage: false })).not.toContain('-svtav1-params:v:0');
    expect(videoArgs(videoDecision(HD, compress({ codec: 'hevc' }), CAPS.ALL_NVENC), { ...IO, lowUsage: true }).join(' ')).not.toContain('svtav1');
    const output = planOf(buildPlan(HD, compress({ codec: 'av1' }), CAPS.CPU_ONLY)).outputs[0];
    expect(toFfmpegArgs(output, { ...IO, lowUsage: true }).filter(arg => arg === 'lp=1')).toHaveLength(1);
  });

  it('writes hvc1 and faststart for HEVC in MP4', () => {
    const args = toFfmpegArgs(planOf(buildPlan(HD, compress({ codec: 'hevc', container: 'mp4' }), CAPS.ALL_NVENC)).outputs[0], IO);
    expect(args[args.indexOf('-tag:v:0') + 1]).toBe('hvc1');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
  });

  it('names the plan encoder and its configuration in the summary', () => {
    expect(planOf(buildPlan(HD, compress({ codec: 'hevc' }), CAPS.ALL_NVENC)).summary.encoders).toEqual([{ encoder: 'hevc_nvenc', variant: '10bit_uhq' }]);
    expect(planOf(buildPlan(HD, compress({ codec: 'h264' }), only('h264_mf', '8bit_sw'))).summary.encoders).toEqual([{ encoder: 'h264_mf', variant: '8bit_sw' }]);
  });
});
