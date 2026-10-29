import { describe, expect, it } from 'vitest';
import {
  PLAN_LOSS_CODES, defaultCompressSettings, mediaInfoSchema,
  type CompressSettings, type ConversionSettings, type HdrInfo, type MediaInfo, type PlanWarningCode, type VideoStreamInfo,
} from '../../../src/media-converter/contract';
import { buildPlan } from '../../../electron/main/media-converter/plan/stream-plan';
import { probeArgs, toFfmpegArgs, videoArgs, type FfmpegIo } from '../../../electron/main/media-converter/plan/args';
import {
  dynamicRangeOf, inferredSdrTag, isInterlaced, isUnsupportedDolbyVision, isVariableFrameRate, pictureHandling,
} from '../../../electron/main/media-converter/plan/video';
import type { ConversionPlan, KeptStreamDecision, PlanOutcome, PlannerCapabilities } from '../../../electron/main/media-converter/plan/types';

/**
 * V-ENCODE-03-1: the picture's correctness in the planner (module-encode design §4, R-ENCODE-03):
 * the filter order, colour tags written by `setparams` (copied, or inferred from the size), full
 * range brought to limited range with or without scaling, HDR10/HLG kept on 10-bit or tone mapped
 * (with the zscale inputs a source does not tag), Dolby Vision refused or stripped of its RPU,
 * variable rates passed through, interlaced sources deinterlaced, 4:2:2/4:4:4 brought to 4:2:0,
 * and the rotation left to ffmpeg. Pure: no process is started (V-ENCODE-03-2 encodes for real).
 */

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const SECONDS_US = 1_000_000;
const SDR: HdrInfo = { format: 'none', dolbyVision: null, masteringDisplay: null, contentLight: null };
const MASTERING = { primaries: { red: { x: 0.68, y: 0.32 }, green: { x: 0.265, y: 0.69 }, blue: { x: 0.15, y: 0.06 }, whitePoint: { x: 0.3127, y: 0.329 } }, luminance: { min: 0.0001, max: 1000 } };
const HDR10_INFO: HdrInfo = { format: 'hdr10', dolbyVision: null, masteringDisplay: MASTERING, contentLight: { maxCll: 1000, maxFall: 400 } };
const HLG_INFO: HdrInfo = { format: 'hlg', dolbyVision: null, masteringDisplay: null, contentLight: null };
/** A DOVI configuration record as the probe reports it (`compatible` as the probe computes it). */
const dolbyVision = (profile: number, compatibilityId: number): HdrInfo => ({
  format: 'dolby_vision', masteringDisplay: null, contentLight: null,
  dolbyVision: { profile, level: 6, compatibilityId, compatible: profile !== 5 && compatibilityId !== 0, rpuPresent: true, elPresent: profile === 7, blPresent: true },
});

/** 1080p H.264, tagged BT.709, limited range, progressive, constant 30 fps, 8-bit 4:2:0. */
function video(extra: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return {
    index: 0, typeIndex: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', bitDepth: 8, chromaSubsampling: '420', width: 1920, height: 1080,
    sampleAspectRatio: '1:1', rFrameRate: '30/1', avgFrameRate: '30/1', fps: 30, isVfr: false, rotation: 0, colorPrimaries: 'bt709',
    colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv', fieldOrder: 'progressive', bitRate: 6_000_000, durationUs: 60 * SECONDS_US,
    language: null, title: null, default: true, hdr: SDR, ...extra,
  };
}
const UNTAGGED = { colorPrimaries: null, colorTransfer: null, colorSpace: null, colorRange: null } as const;
const HDR10 = { codec: 'hevc', pixFmt: 'yuv420p10le', bitDepth: 10, colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc', hdr: HDR10_INFO } as const;
const HLG = { ...HDR10, colorTransfer: 'arib-std-b67', hdr: HLG_INFO } as const;

/** A schema-checked MKV with this video stream (and stereo AAC when asked). */
function media(stream: Partial<VideoStreamInfo> = {}, container: 'mkv' | 'mp4' = 'mkv'): MediaInfo {
  return mediaInfoSchema.parse({
    kind: 'video',
    container: container === 'mkv'
      ? { demuxer: 'matroska', formatName: 'matroska,webm', majorBrand: null, matroskaDocType: 'matroska', extension: 'mkv', identity: 'matroska' }
      : { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', matroskaDocType: null, extension: 'mp4', identity: 'mp4' },
    sizeBytes: 100_000_000, durationUs: 60 * SECONDS_US, durationSource: 'format', startTimeUs: 0, bitRate: 13_333_333, primaryVideoIndex: 0,
    video: [video(stream)], audio: [], subtitles: [], covers: [], attachments: 0, chapters: 0, dataStreams: 0,
  });
}

const caps = (encoders: PlannerCapabilities['encoders']): PlannerCapabilities => ({ encoders, degraded: [], nvencMin: { width: 144, height: 120 } });
const CPU_ONLY = caps({});
const ALL_NVENC = caps({
  av1_nvenc: { variants: { '10bit': true, '10bit_uhq': true }, uhq: true },
  hevc_nvenc: { variants: { '8bit': true, '10bit': true, '8bit_uhq': true, '10bit_uhq': true }, uhq: true },
  h264_nvenc: { variants: { '8bit': true } },
});
/** Only 8-bit HEVC in hardware (an NVIDIA card through Media Foundation): HDR cannot be kept. */
const MF_ONLY = caps({ hevc_mf: { variants: { '8bit': true } }, h264_mf: { variants: { '8bit': true } } });
const IO: FfmpegIo = { inputPath: 'C:\\media\\movie.mkv', demuxer: 'matroska', partialPath: 'D:\\out\\.fusionkit-media-0011aabb.partial' };

const compress = (extra: Partial<CompressSettings> = {}): ConversionSettings => ({ ...defaultCompressSettings('av1'), container: 'mkv', ...extra });
const AV1 = compress({ codec: 'av1' });
const HEVC = compress({ codec: 'hevc' });
const H264 = compress({ codec: 'h264' });

function planOf(outcome: PlanOutcome): ConversionPlan {
  if (outcome.status !== 'ready' && outcome.status !== 'skipped') throw new Error(`no plan: ${outcome.status} ${outcome.reason}`);
  return outcome.plan;
}
function videoDecision(value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities): KeptStreamDecision {
  const decision = planOf(buildPlan(value, settings, table)).outputs[0].streams.find(item => item.source.kind === 'video' && item.action !== 'drop');
  if (!decision || decision.action === 'drop') throw new Error('no video stream');
  return decision;
}
const argsOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities = CPU_ONLY) => videoArgs(videoDecision(value, settings, table), IO);
const option = (args: string[], name: string) => { const at = args.indexOf(`-${name}:v:0`); return at === -1 ? undefined : args[at + 1]; };
/** The `-filter:v:0` chain as its filters. */
const filtersOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities = CPU_ONLY) => (option(argsOf(value, settings, table), 'filter') ?? '').split(',');
const encoderOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities = CPU_ONLY) => {
  const decision = videoDecision(value, settings, table);
  return decision.action === 'encode' ? `${decision.encode.encoder}/${decision.encode.variant}` : 'copy';
};
const warningsOf = (value: MediaInfo, settings: ConversionSettings, table: PlannerCapabilities = CPU_ONLY) =>
  planOf(buildPlan(value, settings, table)).summary.warnings.map(item => item.code);
/** The `setparams` filter's values, or null when there is none. */
const setparamsOf = (filters: string[]) => {
  const last = filters.at(-1) ?? '';
  return last.startsWith('setparams=') ? Object.fromEntries(last.slice('setparams='.length).split(':').map(pair => pair.split('=') as [string, string])) : null;
};
const formatOf = (filters: string[]) => filters.filter(filter => filter.startsWith('format=')).at(-1)?.slice('format='.length);

// ── Colour tags (AC-ENCODE-03-2) ───────────────────────────────────────────────────────────────

describe('colour tags written by setparams (AC-ENCODE-03-2)', () => {
  it('ends every chain with setparams copying the source tags, limited range', () => {
    for (const [settings, table] of [[AV1, CPU_ONLY], [HEVC, CPU_ONLY], [H264, CPU_ONLY], [HEVC, ALL_NVENC], [H264, ALL_NVENC], [H264, MF_ONLY]] as const) {
      const filters = filtersOf(media(), settings, table);
      expect(setparamsOf(filters), `${encoderOf(media(), settings, table)}`).toEqual({ color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709', range: 'tv' });
    }
    const pal = filtersOf(media({ width: 720, height: 576, colorPrimaries: 'bt470bg', colorTransfer: 'bt470bg', colorSpace: 'bt470bg' }), AV1);
    expect(setparamsOf(pal)).toEqual({ color_primaries: 'bt470bg', color_trc: 'bt470bg', colorspace: 'bt470bg', range: 'tv' });
    // Tags copied as they are, whatever the size says.
    const wide = filtersOf(media({ width: 640, height: 360, colorPrimaries: 'bt709', colorTransfer: 'iec61966-2-1', colorSpace: 'bt709' }), AV1);
    expect(setparamsOf(wide)).toEqual({ color_primaries: 'bt709', color_trc: 'iec61966-2-1', colorspace: 'bt709', range: 'tv' });
  });

  it('infers untagged sources from the shown size: BT.709 from 1280 wide or above 576 high, else BT.601 (smpte170m)', () => {
    const tagsFor = (width: number, height: number, rotation: VideoStreamInfo['rotation'] = 0) =>
      setparamsOf(filtersOf(media({ ...UNTAGGED, width, height, rotation }), AV1));
    const sd = { color_primaries: 'smpte170m', color_trc: 'smpte170m', colorspace: 'smpte170m', range: 'tv' };
    const hd = { color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709', range: 'tv' };
    // The cases of design §7b: a 1280×544 scope crop of 720p is HD; PAL 720×576 and its 1024×576 square-pixel form are SD; a 768×1280 portrait clip is HD.
    expect(tagsFor(1280, 544)).toEqual(hd);
    expect(tagsFor(720, 576)).toEqual(sd);
    expect(tagsFor(1024, 576)).toEqual(sd);
    expect(tagsFor(768, 1280)).toEqual(hd);
    // Each boundary: 1280 wide is HD at any height, 1278 is not; 578 high is HD at any width, 576 is not.
    expect([tagsFor(1280, 2), tagsFor(1278, 576), tagsFor(2, 578), tagsFor(1278, 574)]).toEqual([hd, sd, hd, sd]);
    expect([tagsFor(640, 360), tagsFor(720, 480), tagsFor(854, 480), tagsFor(1280, 718), tagsFor(1280, 720), tagsFor(1920, 1080), tagsFor(1920, 800)])
      .toEqual([sd, sd, sd, hd, hd, hd, hd]);
    // As shown, after the display matrix turns it: 1024×576 stored on its side shows 576×1024 (above 576 high), 1280×544 on its side shows 544×1280.
    expect([tagsFor(1024, 576, 90), tagsFor(576, 1024, 270), tagsFor(1280, 544, 90), tagsFor(1920, 1080, 90)]).toEqual([hd, sd, hd, hd]);
    expect([tagsFor(480, 640), tagsFor(640, 480, 270), tagsFor(480, 576), tagsFor(576, 480, 90)]).toEqual([hd, hd, sd, sd]);
    // Unknown size: BT.709.
    expect(setparamsOf(filtersOf(media({ ...UNTAGGED, width: 0, height: 0 }), AV1))).toEqual(hd);
    expect([inferredSdrTag({ width: 0, height: 0 }), inferredSdrTag({ width: 1280, height: 0 }), inferredSdrTag({ width: 720, height: 576 })]).toEqual(['bt709', 'bt709', 'smpte170m']);
  });

  it('infers each missing or unusable tag on its own, and never copies an RGB matrix onto Y\'CbCr', () => {
    expect(setparamsOf(filtersOf(media({ width: 640, height: 360, colorPrimaries: 'bt709', colorTransfer: null, colorSpace: 'bt470bg' }), AV1)))
      .toEqual({ color_primaries: 'bt709', color_trc: 'smpte170m', colorspace: 'bt470bg', range: 'tv' });
    // Values setparams or the encoders do not take count as untagged.
    expect(setparamsOf(filtersOf(media({ colorPrimaries: 'vgamut', colorTransfer: 'vlog', colorSpace: 'ipt-c2' }), AV1)))
      .toEqual({ color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709', range: 'tv' });
    expect(setparamsOf(filtersOf(media({ colorSpace: 'gbr' }), AV1))?.colorspace).toBe('bt709');
  });

  it('converts RGB with the matrix it writes, as swscale would otherwise take BT.601 for every size', () => {
    const rgb = { pixFmt: 'gbrp', chromaSubsampling: '444', colorSpace: 'gbr', colorPrimaries: null, colorTransfer: null } as const;
    expect(filtersOf(media({ ...rgb, colorRange: 'pc' }), AV1))
      .toEqual(['scale=in_range=pc:out_range=tv:out_color_matrix=bt709', 'format=yuv420p10le', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv']);
    expect(filtersOf(media({ ...rgb, pixFmt: 'rgb24', colorSpace: null, colorRange: null, width: 640, height: 360 }), H264))
      .toEqual(['scale=out_range=tv:out_color_matrix=smpte170m', 'format=yuv420p', 'setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m:range=tv']);
    expect(filtersOf(media({ ...rgb, pixFmt: 'bgr0', colorRange: 'pc' }), compress({ codec: 'av1', maxShortSide: 720 }))[0])
      .toBe('scale=w=1280:h=720:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv:out_color_matrix=bt709');
    expect(warningsOf(media({ ...rgb, colorRange: 'pc' }), AV1)).toContain('chroma_subsampled');
  });
});

// ── Range (AC-ENCODE-03-2) ─────────────────────────────────────────────────────────────────────

describe('full range brought to limited range (AC-ENCODE-03-2)', () => {
  it('converts a pc source with scale=in_range=pc:out_range=tv even when nothing is scaled', () => {
    expect(filtersOf(media({ colorRange: 'pc' }), AV1))
      .toEqual(['scale=in_range=pc:out_range=tv', 'format=yuv420p10le', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv']);
    expect(filtersOf(media({ colorRange: 'pc' }), H264, ALL_NVENC)).toEqual(['scale=in_range=pc:out_range=tv', 'format=yuv420p', expect.stringMatching(/^setparams=.*:range=tv$/)]);
    expect(filtersOf(media({ colorRange: 'pc' }), HEVC, MF_ONLY)).toEqual(['scale=in_range=pc:out_range=tv', 'format=nv12', expect.stringMatching(/^setparams=.*:range=tv$/)]);
  });

  it('a yuvj* source counts as full range whatever its range tag says', () => {
    const jpeg = (colorRange: VideoStreamInfo['colorRange']) =>
      media({ codec: 'mjpeg', pixFmt: 'yuvj422p', chromaSubsampling: '422', colorRange, colorSpace: 'bt470bg', colorPrimaries: null, colorTransfer: null, width: 1280, height: 720 });
    // The probe reports pc for an untagged one; a container may still tag it tv (swscale reads it as full range anyway).
    for (const colorRange of ['pc', 'tv', null] as const) {
      expect(filtersOf(jpeg(colorRange), AV1), String(colorRange))
        .toEqual(['scale=in_range=pc:out_range=tv', 'format=yuv420p10le', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt470bg:range=tv']);
      expect(pictureHandling(jpeg(colorRange).video[0], '10bit').fullRange).toBe(true);
    }
    expect(filtersOf(media({ pixFmt: 'yuvj420p', colorRange: 'tv', width: 640, height: 361 }), AV1)[0])
      .toBe('scale=w=640:h=360:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv');
    // Tone mapping reads such a source as full range too.
    expect(filtersOf(media({ ...HDR10, pixFmt: 'yuvj420p', colorRange: 'tv' }), H264)[0]).toBe('zscale=t=linear:npl=100:rin=pc');
  });

  it('merges the conversion into the scale that resizes or fixes an odd size', () => {
    expect(filtersOf(media({ colorRange: 'pc' }), compress({ codec: 'av1', maxShortSide: 720 }))[0])
      .toBe('scale=w=1280:h=720:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv');
    expect(filtersOf(media({ colorRange: 'pc', width: 641, height: 361 }), AV1)[0]).toBe('scale=w=640:h=360:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv');
    expect(filtersOf(media({ colorRange: 'pc', width: 0, height: 0 }), AV1)[0]).toBe('scale=in_range=pc:out_range=tv');
  });

  it('leaves limited and unknown range alone (no scale), and never writes another range than tv', () => {
    expect(filtersOf(media({ colorRange: 'tv' }), AV1)).toEqual(['format=yuv420p10le', expect.stringMatching(/^setparams=/)]);
    expect(filtersOf(media({ ...UNTAGGED }), AV1)).toEqual(['format=yuv420p10le', expect.stringMatching(/^setparams=.*:range=tv$/)]);
  });
});

// ── HDR (AC-ENCODE-03-3) ───────────────────────────────────────────────────────────────────────

const TONEMAP = [
  'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv',
  'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA', 'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
];
const BT709_TV = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';

describe('HDR10 and HLG (AC-ENCODE-03-3)', () => {
  it('keeps HDR10 on AV1 and on 10-bit HEVC: BT.2020 + PQ tags and a 10-bit pixel format into the encoder', () => {
    const keep = 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv';
    const hdr = media(HDR10);
    expect([encoderOf(hdr, AV1), filtersOf(hdr, AV1)]).toEqual(['libsvtav1/10bit', ['format=yuv420p10le', keep]]);
    expect([encoderOf(hdr, compress({ codec: 'av1', useGpuForAv1: true }), ALL_NVENC), filtersOf(hdr, compress({ codec: 'av1', useGpuForAv1: true }), ALL_NVENC)])
      .toEqual(['av1_nvenc/10bit_uhq', ['format=p010le', keep]]);
    expect([encoderOf(hdr, HEVC, ALL_NVENC), filtersOf(hdr, HEVC, ALL_NVENC)]).toEqual(['hevc_nvenc/10bit_uhq', ['format=p010le', keep]]);
    expect(option(argsOf(hdr, HEVC, ALL_NVENC), 'pix_fmt')).toBe('p010le');
    expect(option(argsOf(hdr, HEVC, ALL_NVENC), 'profile')).toBe('main10');
    for (const [settings, table] of [[AV1, CPU_ONLY], [HEVC, ALL_NVENC]] as const) expect(warningsOf(hdr, settings, table)).not.toContain('hdr_tonemapped');
  });

  it('keeps HLG with its own transfer', () => {
    expect(filtersOf(media(HLG), AV1)).toEqual(['format=yuv420p10le', 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv']);
    expect(filtersOf(media(HLG), HEVC, ALL_NVENC).at(-1)).toBe('setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv');
  });

  it('tone maps to SDR BT.709 with zscale for H.264 and for 8-bit-only HEVC, says hdr_tonemapped, and drops the HDR metadata', () => {
    for (const [settings, table, encoder, pixFmt] of [
      [H264, CPU_ONLY, 'libopenh264/8bit', 'yuv420p'], [H264, ALL_NVENC, 'h264_nvenc/8bit', 'yuv420p'],
      [HEVC, MF_ONLY, 'hevc_mf/8bit', 'nv12'], [HEVC, CPU_ONLY, 'libkvazaar/8bit', 'yuv420p'],
    ] as const) {
      const hdr = media(HDR10);
      expect(encoderOf(hdr, settings, table)).toBe(encoder);
      // Tagged source: the first zscale reads the tags from the frames. zscale writes planar Y'CbCr itself.
      const tail = pixFmt === 'yuv420p' ? [BT709_TV] : [`format=${pixFmt}`, BT709_TV];
      expect(filtersOf(hdr, settings, table), encoder).toEqual(['zscale=t=linear:npl=100', ...TONEMAP, 'format=yuv420p', ...tail]);
      expect(warningsOf(hdr, settings, table)).toContain('hdr_tonemapped');
      expect(PLAN_LOSS_CODES).toContain('hdr_tonemapped');
    }
    expect(filtersOf(media(HLG), H264)).toEqual(['zscale=t=linear:npl=100', ...TONEMAP, 'format=yuv420p', BT709_TV]);
  });

  it('pins zscale to Y\'CbCr before a scale, so swscale never converts the tone-mapped RGB', () => {
    expect(filtersOf(media(HDR10), compress({ codec: 'h264', maxShortSide: 720 })))
      .toEqual(['zscale=t=linear:npl=100', ...TONEMAP, 'format=yuv420p', 'scale=w=1280:h=720:flags=lanczos+accurate_rnd+full_chroma_int', 'format=yuv420p', BT709_TV]);
  });

  it('gives the first zscale every input tag the source lacks: tin, pin with p, min, rin', () => {
    const untaggedPq = media({ ...HDR10, ...UNTAGGED, hdr: dolbyVision(8, 1) });
    expect(filtersOf(untaggedPq, H264)[0]).toBe('zscale=t=linear:npl=100:tin=smpte2084:pin=bt2020:p=bt2020:min=bt2020nc:rin=tv');
    const untaggedHlg = media({ ...HDR10, ...UNTAGGED, hdr: dolbyVision(8, 4) });
    expect(filtersOf(untaggedHlg, H264)[0]).toBe('zscale=t=linear:npl=100:tin=arib-std-b67:pin=bt2020:p=bt2020:min=bt2020nc:rin=tv');
    // Only what is missing: a full-range HDR10 source without a matrix.
    expect(filtersOf(media({ ...HDR10, colorSpace: null, colorRange: 'pc' }), H264)[0]).toBe('zscale=t=linear:npl=100:min=bt2020nc:rin=pc');
    // A full-range HDR source: zscale converts the range, so no scale converts it again.
    expect(filtersOf(media({ ...HDR10, colorRange: 'pc' }), H264).filter(filter => filter.startsWith('scale='))).toEqual([]);
    // Kept HDR without tags: BT.2020 and the transfer of the kind are written.
    expect(filtersOf(untaggedPq, AV1)).toEqual(['format=yuv420p10le', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv']);
    // Kept HDR at full range: converted by scale as any other.
    expect(filtersOf(media({ ...HDR10, colorRange: 'pc' }), AV1)[0]).toBe('scale=in_range=pc:out_range=tv');
  });

  it('classifies the dynamic range by format, transfer and Dolby Vision base layer', () => {
    expect(dynamicRangeOf(video(HDR10))).toBe('pq');
    expect(dynamicRangeOf(video(HLG))).toBe('hlg');
    expect(dynamicRangeOf(video())).toBe('sdr');
    expect(dynamicRangeOf(video({ colorTransfer: 'smpte2084', hdr: SDR }))).toBe('pq');
    expect(dynamicRangeOf(video({ ...UNTAGGED, hdr: dolbyVision(8, 1) }))).toBe('pq');
    expect(dynamicRangeOf(video({ ...UNTAGGED, hdr: dolbyVision(7, 6) }))).toBe('pq');
    expect(dynamicRangeOf(video({ ...UNTAGGED, hdr: dolbyVision(8, 4) }))).toBe('hlg');
    expect(dynamicRangeOf(video({ ...UNTAGGED, hdr: dolbyVision(8, 2) }))).toBe('sdr');
    // A base layer that tags its own transfer is taken at its word.
    expect(dynamicRangeOf(video({ colorTransfer: 'bt709', hdr: dolbyVision(8, 1) }))).toBe('sdr');
    expect(dynamicRangeOf(video({ colorTransfer: 'arib-std-b67', hdr: dolbyVision(8, 4) }))).toBe('hlg');
  });
});

// ── Dolby Vision (AC-ENCODE-03-4) ──────────────────────────────────────────────────────────────

describe('Dolby Vision (AC-ENCODE-03-4)', () => {
  const p5 = media({ ...HDR10, colorPrimaries: null, colorTransfer: null, colorSpace: null, hdr: dolbyVision(5, 0) });

  it('refuses to re-encode profile 5 (transfer unknown) and any compatibility id 0, with no arguments and no alternatives', () => {
    for (const source of [p5, media({ ...HDR10, hdr: dolbyVision(10, 0) }), media({ ...HDR10, hdr: { ...dolbyVision(8, 1), dolbyVision: { ...dolbyVision(8, 1).dolbyVision!, compatible: false } } })]) {
      for (const [settings, table] of [[AV1, CPU_ONLY], [HEVC, ALL_NVENC], [H264, ALL_NVENC], [{ task: 'convert', target: 'webm', preferRemux: true, tier: 'balanced' }, CPU_ONLY]] as const) {
        expect(buildPlan(source, settings as ConversionSettings, table)).toEqual({ status: 'error', reason: 'dolby_vision_p5_unsupported', alternatives: [] });
      }
    }
    expect(isUnsupportedDolbyVision(video({ hdr: dolbyVision(5, 0) }))).toBe(true);
    expect(isUnsupportedDolbyVision(video({ hdr: dolbyVision(8, 1) }))).toBe(false);
    expect(isUnsupportedDolbyVision(video(HDR10))).toBe(false);
  });

  it('still copies profile 5 where the video can be kept as it is', () => {
    const plan = planOf(buildPlan(p5, { task: 'convert', target: 'mp4', preferRemux: true, tier: 'balanced' }, CPU_ONLY));
    expect(plan.outputs[0].streams[0]).toMatchObject({ action: 'copy' });
    expect(plan.summary.warnings.map(item => item.code)).not.toContain('dolby_vision_rpu_dropped');
  });

  it('encodes profile 8.1 from its HDR10 base layer, kept or tone mapped, dropping the RPU: -dolbyvision 0 for libsvtav1', () => {
    const p81 = media({ ...HDR10, hdr: { ...dolbyVision(8, 1), masteringDisplay: MASTERING } });
    const svt = argsOf(p81, AV1);
    expect(option(svt, 'dolbyvision')).toBe('0');
    expect(option(svt, 'filter')).toBe('format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv');
    expect(warningsOf(p81, AV1)).toEqual(expect.arrayContaining(['dolby_vision_rpu_dropped']));
    // Only libsvtav1 can write an RPU; the other encoders get no such option.
    const nvenc = argsOf(p81, HEVC, ALL_NVENC);
    expect([encoderOf(p81, HEVC, ALL_NVENC), option(nvenc, 'dolbyvision')]).toEqual(['hevc_nvenc/10bit_uhq', undefined]);
    expect(warningsOf(p81, HEVC, ALL_NVENC)).toContain('dolby_vision_rpu_dropped');
    expect(warningsOf(p81, H264)).toEqual(expect.arrayContaining(['hdr_tonemapped', 'dolby_vision_rpu_dropped']));
    expect(PLAN_LOSS_CODES).toContain('dolby_vision_rpu_dropped');
    // Not Dolby Vision: no -dolbyvision.
    expect(option(argsOf(media(HDR10), AV1), 'dolbyvision')).toBeUndefined();
  });

  it('profile 7 (HDR10 base, compatibility id 6) and 8.4 (HLG) keep their base layer; 8.2 is SDR', () => {
    const p7 = media({ ...HDR10, hdr: dolbyVision(7, 6) });
    expect(filtersOf(p7, AV1).at(-1)).toBe('setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv');
    expect(warningsOf(p7, AV1)).toContain('dolby_vision_rpu_dropped');
    const p84 = media({ ...HLG, hdr: dolbyVision(8, 4) });
    expect(filtersOf(p84, AV1).at(-1)).toBe('setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv');
    // 8.2: SDR BT.709 base layer, so no 10-bit preference and no tone mapping.
    const p82 = media({ codec: 'hevc', hdr: dolbyVision(8, 2) });
    expect(encoderOf(p82, HEVC, ALL_NVENC)).toBe('hevc_nvenc/10bit_uhq');
    expect(encoderOf(p82, HEVC, caps({ hevc_nvenc: { variants: { '8bit': true } }, hevc_qsv: { variants: { '10bit': true } } }))).toBe('hevc_nvenc/8bit');
    expect(encoderOf(media(HDR10), HEVC, caps({ hevc_nvenc: { variants: { '8bit': true } }, hevc_qsv: { variants: { '10bit': true } } }))).toBe('hevc_qsv/10bit');
    expect(filtersOf(p82, H264)).toEqual(['format=yuv420p', BT709_TV]);
    expect(warningsOf(p82, H264)).toEqual(['cpu_weak_encoder', 'dolby_vision_rpu_dropped']);
  });
});

// ── VFR and interlacing (AC-ENCODE-03-5) ───────────────────────────────────────────────────────

describe('variable frame rate and interlacing (AC-ENCODE-03-5)', () => {
  it('passes the timestamps of a variable-rate source through (-fps_mode passthrough), for every encoder', () => {
    const vfr = media({ rFrameRate: '30/1', avgFrameRate: '20/1', fps: 20, isVfr: true });
    for (const [settings, table] of [[AV1, CPU_ONLY], [HEVC, CPU_ONLY], [H264, CPU_ONLY], [HEVC, ALL_NVENC], [H264, MF_ONLY]] as const) {
      expect(option(argsOf(vfr, settings, table), 'fps_mode'), encoderOf(vfr, settings, table)).toBe('passthrough');
    }
    expect(option(argsOf(media(), AV1), 'fps_mode')).toBeUndefined();
    // The option sits with the stream's other options, before its filters, and survives low-usage mode.
    const args = videoArgs(videoDecision(vfr, AV1, CPU_ONLY), { ...IO, lowUsage: true });
    expect(args.indexOf('-fps_mode:v:0')).toBeLessThan(args.indexOf('-filter:v:0'));
    expect(option(args, 'svtav1-params')).toBe('lp=1');
  });

  it('does not take an interlaced source whose base rate is twice its average for variable rate (design §7a)', () => {
    const fieldRate = { fieldOrder: 'tt', rFrameRate: '50/1', avgFrameRate: '25/1', fps: 25, isVfr: true } as const;
    expect(isVariableFrameRate(video(fieldRate))).toBe(false);
    expect(option(argsOf(media(fieldRate), AV1), 'fps_mode')).toBeUndefined();
    expect(isVariableFrameRate(video({ ...fieldRate, rFrameRate: '60000/1001', avgFrameRate: '30000/1001' }))).toBe(false);
    // Within 0.5 % counts as twice; beyond it does not.
    expect(isVariableFrameRate(video({ ...fieldRate, rFrameRate: '5024/100' }))).toBe(false);
    expect(isVariableFrameRate(video({ ...fieldRate, rFrameRate: '5030/100' }))).toBe(true);
    // Progressive at twice the average is variable rate; so is interlaced at another ratio.
    expect(isVariableFrameRate(video({ ...fieldRate, fieldOrder: 'progressive' }))).toBe(true);
    expect(isVariableFrameRate(video({ ...fieldRate, rFrameRate: '30/1', avgFrameRate: '24/1', fps: 24 }))).toBe(true);
    expect(isVariableFrameRate(video({ ...fieldRate, isVfr: false }))).toBe(false);
  });

  it('deinterlaces a source flagged interlaced with bwdif, first in the chain', () => {
    for (const fieldOrder of ['tt', 'bb', 'tb', 'bt'] as const) {
      expect(filtersOf(media({ fieldOrder }), AV1)[0]).toBe('bwdif=mode=send_frame:parity=auto:deint=interlaced');
      expect(isInterlaced(video({ fieldOrder }))).toBe(true);
    }
    for (const fieldOrder of ['progressive', null] as const) {
      expect(filtersOf(media({ fieldOrder }), AV1).some(filter => filter.startsWith('bwdif'))).toBe(false);
      expect(isInterlaced(video({ fieldOrder }))).toBe(false);
    }
  });
});

// ── Chroma ─────────────────────────────────────────────────────────────────────────────────────

describe('chroma brought to 4:2:0 (R-ENCODE-03 boundaries)', () => {
  it('feeds 4:2:2 and 4:4:4 to the encoders as 4:2:0 and says chroma_subsampled', () => {
    const prores = media({ codec: 'prores', pixFmt: 'yuv422p10le', bitDepth: 10, chromaSubsampling: '422' });
    expect(formatOf(filtersOf(prores, AV1))).toBe('yuv420p10le');
    expect(formatOf(filtersOf(prores, H264, ALL_NVENC))).toBe('yuv420p');
    expect(warningsOf(prores, AV1)).toContain('chroma_subsampled');
    const full = media({ pixFmt: 'yuv444p', chromaSubsampling: '444' });
    expect(formatOf(filtersOf(full, HEVC, ALL_NVENC))).toBe('p010le');
    expect(warningsOf(full, HEVC, ALL_NVENC)).toContain('chroma_subsampled');
    expect(warningsOf(media({ pixFmt: 'yuv440p', chromaSubsampling: '440' }), AV1)).toContain('chroma_subsampled');
    expect(PLAN_LOSS_CODES).toContain('chroma_subsampled');
  });

  it('does not warn for 4:2:0, 4:1:1, grey or an unknown layout', () => {
    for (const chromaSubsampling of ['420', '411', '410', '400', null] as const) {
      expect(warningsOf(media({ chromaSubsampling }), AV1), String(chromaSubsampling)).not.toContain('chroma_subsampled');
    }
  });
});

// ── Rotation (AC-ENCODE-03-1) ──────────────────────────────────────────────────────────────────

describe('rotation (AC-ENCODE-03-1)', () => {
  const phone = media({ codec: 'hevc', width: 1920, height: 1080, rotation: 90 }, 'mp4');

  it('leaves the turn to ffmpeg\'s autorotate: no transpose, no rotation option, sizes of the shown picture', () => {
    const output = planOf(buildPlan(phone, compress({ codec: 'av1', maxShortSide: 720 }), CPU_ONLY)).outputs[0];
    const args = toFfmpegArgs(output, IO);
    expect(args.join(' ')).not.toMatch(/transpose|hflip|vflip|rotate|autorotate|display_rotation|noautorotate/);
    expect(option(args, 'filter')?.split(',')[0]).toBe('scale=w=720:h=1280:flags=lanczos+accurate_rnd+full_chroma_int');
    expect(output.streams[0]).toMatchObject({ action: 'encode', encode: { frame: { width: 720, height: 1280 } } });
  });

  it('copies the video, and with it the display matrix, when only the container changes', () => {
    const output = planOf(buildPlan(phone, { task: 'convert', target: 'mkv', preferRemux: true, tier: 'balanced' }, CPU_ONLY)).outputs[0];
    expect(output.streams[0]).toMatchObject({ action: 'copy' });
    expect(toFfmpegArgs(output, IO)).toEqual(expect.arrayContaining(['-c:v:0', 'copy']));
    expect(toFfmpegArgs(output, IO).some(arg => arg.startsWith('-filter'))).toBe(false);
  });
});

// ── Order, totality and the probe ──────────────────────────────────────────────────────────────

describe('the filter chain of design §4', () => {
  /** Everything at once: interlaced, full range, 4:2:2 10-bit, variable rate, HDR10, scaled to 720p. */
  const everything = media({ ...HDR10, pixFmt: 'yuv422p10le', chromaSubsampling: '422', colorRange: 'pc', fieldOrder: 'tt', rFrameRate: '30/1', avgFrameRate: '24/1', fps: 24, isVfr: true });

  it('matches the order snapshot: bwdif → tone map → scale → format → setparams', () => {
    const cases: [string, MediaInfo, ConversionSettings, PlannerCapabilities][] = [
      ['plain', media(), AV1, CPU_ONLY],
      ['untagged SD, pc, odd', media({ ...UNTAGGED, colorRange: 'pc', width: 721, height: 481 }), AV1, CPU_ONLY],
      ['interlaced untagged', media({ ...UNTAGGED, width: 720, height: 480, fieldOrder: 'bb' }), H264, ALL_NVENC],
      ['everything → AV1 720p', everything, compress({ codec: 'av1', maxShortSide: 720 }), CPU_ONLY],
      ['everything → HEVC 10-bit 720p', everything, compress({ codec: 'hevc', maxShortSide: 720 }), ALL_NVENC],
      ['everything → H.264 720p', everything, compress({ codec: 'h264', maxShortSide: 720 }), ALL_NVENC],
      ['everything → HEVC MF', everything, HEVC, MF_ONLY],
      ['DV 8.1 untagged → AV1', media({ ...HDR10, ...UNTAGGED, hdr: dolbyVision(8, 1) }), AV1, CPU_ONLY],
      ['DV 8.1 untagged → H.264', media({ ...HDR10, ...UNTAGGED, hdr: dolbyVision(8, 1) }), H264, CPU_ONLY],
      ['RGB → kvazaar', media({ pixFmt: 'gbrp', chromaSubsampling: '444', colorSpace: 'gbr', colorRange: 'pc', width: 854, height: 480 }), HEVC, CPU_ONLY],
    ];
    const lines = cases.map(([name, value, settings, table]) => {
      const args = argsOf(value, settings, table);
      const extra = ['dolbyvision', 'fps_mode'].filter(name => option(args, name) !== undefined).map(name => `-${name} ${option(args, name)}`);
      return `${name} | ${encoderOf(value, settings, table)} | ${option(args, 'filter')}${extra.length ? ` | ${extra.join(' ')}` : ''} | ${warningsOf(value, settings, table).join(',')}`;
    });
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "plain | libsvtav1/10bit | format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | 
      untagged SD, pc, odd | libsvtav1/10bit | scale=w=720:h=480:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv,format=yuv420p10le,setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m:range=tv | 
      interlaced untagged | h264_nvenc/8bit | bwdif=mode=send_frame:parity=auto:deint=interlaced,format=yuv420p,setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m:range=tv | 
      everything → AV1 720p | libsvtav1/10bit | bwdif=mode=send_frame:parity=auto:deint=interlaced,scale=w=1280:h=720:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv | -fps_mode passthrough | chroma_subsampled
      everything → HEVC 10-bit 720p | hevc_nvenc/10bit_uhq | bwdif=mode=send_frame:parity=auto:deint=interlaced,scale=w=1280:h=720:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv,format=p010le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv | -fps_mode passthrough | chroma_subsampled
      everything → H.264 720p | h264_nvenc/8bit | bwdif=mode=send_frame:parity=auto:deint=interlaced,zscale=t=linear:npl=100:rin=pc,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,format=yuv420p,scale=w=1280:h=720:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | -fps_mode passthrough | hdr_tonemapped,chroma_subsampled
      everything → HEVC MF | hevc_mf/8bit | bwdif=mode=send_frame:parity=auto:deint=interlaced,zscale=t=linear:npl=100:rin=pc,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,format=yuv420p,format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | -fps_mode passthrough | hdr_tonemapped,chroma_subsampled
      DV 8.1 untagged → AV1 | libsvtav1/10bit | format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv | -dolbyvision 0 | dolby_vision_rpu_dropped
      DV 8.1 untagged → H.264 | libopenh264/8bit | zscale=t=linear:npl=100:tin=smpte2084:pin=bt2020:p=bt2020:min=bt2020nc:rin=tv,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv | cpu_weak_encoder,hdr_tonemapped,dolby_vision_rpu_dropped
      RGB → kvazaar | libkvazaar/8bit | scale=w=848:h=480:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv:out_color_matrix=smpte170m,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=smpte170m:range=tv | cpu_weak_encoder,chroma_subsampled"
    `);
  });

  it('always ends with the encoder pixel format and setparams, keeps the order and converts any full range once', () => {
    const order = ['bwdif', 'zscale', 'scale', 'format', 'setparams'];
    const rank = (filter: string) => order.indexOf(/^[a-z]+/.exec(filter)![0]);
    const sources: Partial<VideoStreamInfo>[] = [
      {}, UNTAGGED, { colorRange: 'pc' }, { fieldOrder: 'tt' }, HDR10, HLG, { ...HDR10, colorRange: 'pc', fieldOrder: 'bb' },
      { pixFmt: 'gbrp', chromaSubsampling: '444', colorSpace: 'gbr', colorRange: 'pc' }, { width: 1279, height: 721, colorRange: 'pc' },
      { ...HDR10, ...UNTAGGED, hdr: dolbyVision(8, 1) }, { pixFmt: 'yuvj420p', colorRange: 'pc', rotation: 90 }, { pixFmt: 'yuvj420p', colorRange: 'tv' },
    ];
    const tables = [CPU_ONLY, ALL_NVENC, MF_ONLY];
    const settingsList = [AV1, HEVC, H264, compress({ codec: 'av1', useGpuForAv1: true }), compress({ codec: 'h264', maxShortSide: 480 }), compress({ codec: 'hevc', maxShortSide: 720 })];
    let checked = 0;
    for (const source of sources) for (const table of tables) for (const settings of settingsList) {
      const value = media(source);
      const decision = videoDecision(value, settings, table);
      if (decision.action !== 'encode') throw new Error('copied');
      const label = `${JSON.stringify(source)} ${encoderOf(value, settings, table)}`;
      expect(setparamsOf([...decision.encode.filters]), label).toMatchObject({ range: 'tv' });
      expect(decision.encode.filters.at(-2), label).toBe(`format=${option(argsOf(value, settings, table), 'pix_fmt')}`);
      // The tone-mapping block's own formats (gbrpf32le, then the planar Y'CbCr zscale writes) may come
      // before a scale; every other filter follows the order of design §4.
      const kept = decision.encode.filters.filter((filter, i, all) =>
        !filter.startsWith('sidedata') && !filter.startsWith('tonemap') && !(filter.startsWith('format=') && i < all.length - 2));
      const ranks = kept.map(rank);
      expect([...ranks].sort((a, b) => a - b), label).toEqual(ranks);
      expect(ranks.filter(item => item === -1), label).toEqual([]);
      // Full range by the source alone (AC-ENCODE-03-2: pc or yuvj*), converted exactly once.
      const fullRange = value.video[0].colorRange === 'pc' || (value.video[0].pixFmt ?? '').startsWith('yuvj');
      const converted = decision.encode.filters.filter(filter => filter.includes('in_range=pc') || filter.includes('rin=pc')).length;
      expect(converted, label).toBe(fullRange ? 1 : 0);
      expect(pictureHandling(value.video[0], decision.encode.variant!).fullRange, label).toBe(fullRange);
      checked++;
    }
    expect(checked).toBe(sources.length * tables.length * settingsList.length);
  });

  it('gives the capability probe the chain of a plain HD picture, as production does for one', () => {
    expect(probeArgs('libsvtav1', '10bit').slice(-2)).toEqual(['-filter:v:0', 'format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv']);
    expect(probeArgs('h264_mf', '8bit').slice(-2)).toEqual(['-filter:v:0', 'format=nv12,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv']);
    expect(probeArgs('libsvtav1', '10bit')).not.toContain('-fps_mode:v:0');
  });

  it('reports every correctness warning on the main video stream only, once', () => {
    const value = media({ ...HDR10, pixFmt: 'yuv422p10le', chromaSubsampling: '422', hdr: { ...dolbyVision(8, 1), masteringDisplay: MASTERING } });
    const warnings = planOf(buildPlan(value, H264, ALL_NVENC)).summary.warnings;
    const codes: PlanWarningCode[] = ['hdr_tonemapped', 'dolby_vision_rpu_dropped', 'chroma_subsampled'];
    for (const code of codes) expect(warnings.filter(item => item.code === code)).toEqual([{ code, streams: [0], count: 1 }]);
  });
});
