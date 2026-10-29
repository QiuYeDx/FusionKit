import { describe, expect, it } from 'vitest';
import {
  ENGINE_REASON_CODES, PLAN_LOSS_CODES, PLAN_REASON_CODES, compressSettingsSchema, conversionSettingsSchema, defaultCompressSettings, defaultConversionSettings,
  mediaInfoSchema, planSummarySchema, planWarningCodeSchema,
  type AudioStreamInfo, type ConversionSettings, type CoverStreamInfo, type MediaInfo, type SubtitleStreamInfo, type VideoStreamInfo,
} from '../../../src/media-converter/contract';
import { buildPlan } from '../../../electron/main/media-converter/plan/stream-plan';
import { toFfmpegArgs, ffmpegSeconds, type FfmpegIo } from '../../../electron/main/media-converter/plan/args';
import { CAP_POLICY } from '../../../electron/main/media-converter/plan/caps';
import { TASK_MATRIX, autoCompressContainer, isSameContainer, mediaShape } from '../../../electron/main/media-converter/plan/matrix';
import type { ConversionPlan, PlanOutcome, PlannedOutput, PlannerCapabilities } from '../../../electron/main/media-converter/plan/types';

/**
 * The planner as pure functions (module-encode design §1, §2, §6, §7): stream decisions per
 * target container, explicit maps, metadata and dispositions, the container "auto" choice, the
 * task matrix, remux and `already_target`, output caps, and the complete ffmpeg arguments.
 */

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const MINUTE_US = 60_000_000;
const MIB16 = 16 * 1024 * 1024;

function video(index: number, typeIndex: number, extra: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return {
    index, typeIndex, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', bitDepth: 8, chromaSubsampling: '420', width: 1920, height: 1080,
    sampleAspectRatio: '1:1', rFrameRate: '24/1', avgFrameRate: '24/1', fps: 24, isVfr: false, rotation: 0, colorPrimaries: 'bt709',
    colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv', fieldOrder: 'progressive', bitRate: null, durationUs: MINUTE_US,
    language: null, title: null, default: true, hdr: { format: 'none', dolbyVision: null, masteringDisplay: null, contentLight: null }, ...extra,
  };
}
function audio(index: number, typeIndex: number, codec: string, extra: Partial<AudioStreamInfo> = {}): AudioStreamInfo {
  return {
    index, typeIndex, codec, profile: null, channels: 2, channelLayout: 'stereo', sampleRate: 48_000, sampleFormat: 'fltp', bitsPerRawSample: null,
    bitRate: null, bitRateSource: null, durationUs: MINUTE_US, language: null, title: null, default: false, forced: false, ...extra,
  };
}
const IMAGE_SUBTITLES = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
function subtitle(index: number, typeIndex: number, codec: string, extra: Partial<SubtitleStreamInfo> = {}): SubtitleStreamInfo {
  const kind = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(codec) ? 'text' : IMAGE_SUBTITLES.has(codec) ? 'image' : 'other';
  return {
    index, typeIndex, codec, kind, language: null, title: null, default: false, forced: false, hearingImpaired: false,
    styled: codec === 'ass' || codec === 'ssa' ? false : null, ...extra,
  };
}
const cover = (index: number, typeIndex: number, codec = 'mjpeg'): CoverStreamInfo => ({ index, typeIndex, codec, width: 600, height: 600 });

const CONTAINERS = {
  mkv: { demuxer: 'matroska', formatName: 'matroska,webm', majorBrand: null, matroskaDocType: 'matroska', extension: 'mkv', identity: 'matroska' },
  webm: { demuxer: 'matroska', formatName: 'matroska,webm', majorBrand: null, matroskaDocType: 'webm', extension: 'webm', identity: 'webm' },
  mp4: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', matroskaDocType: null, extension: 'mp4', identity: 'mp4' },
  m4v: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'M4V', matroskaDocType: null, extension: 'm4v', identity: 'mp4' },
  mov: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'qt', matroskaDocType: null, extension: 'mov', identity: 'mov' },
  avi: { demuxer: 'avi', formatName: 'avi', majorBrand: null, matroskaDocType: null, extension: 'avi', identity: 'avi' },
  ts: { demuxer: 'mpegts', formatName: 'mpegts', majorBrand: null, matroskaDocType: null, extension: 'mp4', identity: 'mpegts' },
  flac: { demuxer: 'flac', formatName: 'flac', majorBrand: null, matroskaDocType: null, extension: 'flac', identity: 'flac' },
  ogg: { demuxer: 'ogg', formatName: 'ogg', majorBrand: null, matroskaDocType: null, extension: 'ogg', identity: 'ogg' },
  mp3: { demuxer: 'mp3', formatName: 'mp3', majorBrand: null, matroskaDocType: null, extension: 'mp3', identity: 'mp3' },
  h264: { demuxer: 'h264', formatName: 'h264', majorBrand: null, matroskaDocType: null, extension: 'h264', identity: 'h264' },
  hevc: { demuxer: 'hevc', formatName: 'hevc', majorBrand: null, matroskaDocType: null, extension: 'hevc', identity: 'hevc' },
  m2v: { demuxer: 'mpegvideo', formatName: 'mpegvideo', majorBrand: null, matroskaDocType: null, extension: 'm2v', identity: 'mpegvideo' },
} as const;

type MediaParts = Partial<Omit<MediaInfo, 'container'>> & { container?: keyof typeof CONTAINERS };
/** A schema-checked `MediaInfo`; video files unless the parts say otherwise. */
function media(parts: MediaParts): MediaInfo {
  const { container = 'mkv', ...rest } = parts;
  const streams = { video: [], audio: [], subtitles: [], covers: [], ...rest };
  const primary = streams.video.find(stream => stream.avgFrameRate !== null);
  return mediaInfoSchema.parse({
    kind: primary ? 'video' : 'audio', container: CONTAINERS[container], sizeBytes: 1_000_000_000, durationUs: MINUTE_US, durationSource: 'format',
    startTimeUs: 0, bitRate: 133_333_333, primaryVideoIndex: primary?.index ?? null, attachments: 0, chapters: 0, dataStreams: 0, ...streams,
  });
}

/** A Blu-ray style MKV: two audio tracks, text, styled ASS and PGS subtitles, fonts, a cover, a data stream and chapters. */
const MULTI = media({
  video: [video(0, 0)],
  audio: [
    audio(1, 0, 'aac', { language: 'eng', title: 'Main', default: true }),
    audio(2, 1, 'ac3', { language: 'jpn', title: 'Commentary', channels: 6, channelLayout: '5.1(side)', bitRate: 448_000, bitRateSource: 'stream' }),
  ],
  subtitles: [
    subtitle(3, 0, 'subrip', { language: 'eng', title: 'Full' }),
    subtitle(4, 1, 'ass', { language: 'eng', title: 'Signs', forced: true, styled: true }),
    subtitle(5, 2, 'ass', { language: 'jpn', hearingImpaired: true }),
    subtitle(6, 3, 'hdmv_pgs_subtitle', { language: 'eng', title: 'PGS' }),
  ],
  covers: [cover(7, 1)],
  attachments: 2, dataStreams: 1, chapters: 3,
});
/** MKV with H.264 and AAC whose bit rates are unknown (no BPS tags). */
const PLAIN_MKV = media({ video: [video(0, 0)], audio: [audio(1, 0, 'aac', { default: true })] });
const PHONE_MOV = media({ container: 'mov', video: [video(0, 0, { codec: 'hevc', rotation: 90 })], audio: [audio(1, 0, 'aac', { default: true })], dataStreams: 3 });
const PLAIN_MP4 = media({ container: 'mp4', video: [video(0, 0)], audio: [audio(1, 0, 'aac', { default: true })] });
const SILENT_MP4 = media({ container: 'mp4', video: [video(0, 0)] });
const FLAC = media({ container: 'flac', audio: [audio(0, 0, 'flac', { sampleFormat: 's32', bitsPerRawSample: 24, default: true })] });
const FLAC_COVER = media({ container: 'flac', audio: [audio(0, 0, 'flac', { sampleFormat: 's16', default: true })], covers: [cover(1, 0, 'png')], chapters: 2 });

const CPU_ONLY: PlannerCapabilities = { encoders: {}, degraded: [], nvencMin: { width: 144, height: 120 } };
const ALL_NVENC: PlannerCapabilities = {
  encoders: {
    av1_nvenc: { variants: { '10bit': true, '10bit_uhq': true }, uhq: true },
    hevc_nvenc: { variants: { '8bit': true, '10bit': true, '8bit_uhq': true, '10bit_uhq': true }, uhq: true },
    h264_nvenc: { variants: { '8bit': true } },
  },
  degraded: [], nvencMin: { width: 144, height: 120 },
};
const IO: FfmpegIo = { inputPath: 'C:\\media\\movie.mkv', demuxer: 'matroska', partialPath: 'D:\\out\\.fusionkit-media-0011aabb.partial' };

const convert = (target: Extract<ConversionSettings, { task: 'convert' }>['target'], preferRemux = true): ConversionSettings => ({ task: 'convert', target, preferRemux, tier: 'balanced' });
const compress = (extra: Partial<Extract<ConversionSettings, { task: 'compress' }>> = {}): ConversionSettings => ({ ...defaultCompressSettings('h264'), ...extra });
const extract = (extra: Partial<Extract<ConversionSettings, { task: 'extract-audio' }>> = {}): ConversionSettings =>
  ({ task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: false, ...extra });

function planOf(outcome: PlanOutcome): ConversionPlan {
  if (outcome.status !== 'ready' && outcome.status !== 'skipped') throw new Error(`no plan: ${outcome.status} ${outcome.reason}`);
  return outcome.plan;
}
const ready = (value: MediaInfo, settings: ConversionSettings, caps = CPU_ONLY) => {
  const outcome = buildPlan(value, settings, caps);
  expect(outcome.status).toBe('ready');
  return planOf(outcome);
};
/** `kind#index:action(detail)` for every source stream, in output order. */
const decisions = (output: PlannedOutput) => output.streams.map(decision => `${decision.source.kind}#${decision.source.index}:${decision.action}` +
  (decision.action === 'encode' ? `(${decision.encode.encoder})` : decision.action === 'drop' ? `(${decision.reason})` : ''));
const warningsOf = (plan: ConversionPlan) => plan.summary.warnings.map(item => `${item.code}[${item.streams.join(',')}]x${item.count}`);
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

// ── Contract ───────────────────────────────────────────────────────────────────────────────────

describe('the plan reason codes and settings', () => {
  it('form one closed snake_case list with every code of design §1, none shared with the engine', () => {
    const designed = [
      'cpu_weak_encoder', 'hdr_tonemapped', 'dolby_vision_rpu_dropped', 'chroma_subsampled', 'cover_dropped', 'downmixed_to_stereo', 'subtitle_styling_lost',
      'subtitle_dropped', 'attachment_dropped', 'mp4_default_subtitle_forced', 'encoder_fallback', 'already_target', 'not_smaller', 'task_not_applicable',
      'no_audio_stream', 'no_video_stream', 'no_encoder_available', 'dolby_vision_p5_unsupported', 'lossy_to_lossless',
    ];
    for (const code of designed) expect(PLAN_REASON_CODES).toContain(code);
    expect(new Set(PLAN_REASON_CODES).size).toBe(PLAN_REASON_CODES.length);
    expect(PLAN_REASON_CODES.every(code => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(code))).toBe(true);
    expect(PLAN_REASON_CODES.filter(code => (ENGINE_REASON_CODES as readonly string[]).includes(code))).toEqual([]);
    // The two engine warnings are reused, not declared again.
    expect(planWarningCodeSchema.options).toEqual(expect.arrayContaining(['duration_unverified', 'output_name_collision']));
    expect(PLAN_REASON_CODES).not.toContain('duration_unverified');
    for (const code of PLAN_LOSS_CODES) expect(planWarningCodeSchema.options).toContain(code);
  });

  it('give the designed defaults, with the compress codec always given', () => {
    expect(defaultConversionSettings('compress', 'hevc')).toEqual({
      task: 'compress', tier: 'balanced', codec: 'hevc', container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: true,
    });
    expect(defaultConversionSettings('convert', 'h264')).toEqual({ task: 'convert', target: 'mp4', preferRemux: true, tier: 'balanced' });
    expect(defaultConversionSettings('extract-audio', 'h264')).toEqual({ task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: false });
    for (const task of ['compress', 'convert', 'extract-audio'] as const) expect(conversionSettingsSchema.parse(defaultConversionSettings(task, 'av1'))).toBeTruthy();
    const { codec: _codec, ...withoutCodec } = defaultCompressSettings('h264');
    expect(compressSettingsSchema.safeParse(withoutCodec).success).toBe(false);
    expect(conversionSettingsSchema.safeParse({ ...defaultCompressSettings('h264'), maxShortSide: 900 }).success).toBe(false);
    expect(conversionSettingsSchema.safeParse({ ...defaultCompressSettings('h264'), extra: true }).success).toBe(false);
    expect(conversionSettingsSchema.safeParse({ task: 'convert', target: 'avi', preferRemux: true, tier: 'balanced' }).success).toBe(false);
  });
});

// ── Task matrix ────────────────────────────────────────────────────────────────────────────────

describe('the task × media matrix (AC-ENCODE-01-6)', () => {
  const shapes = { video: PLAIN_MP4, video_no_audio: SILENT_MP4, audio: FLAC, audio_with_cover: FLAC_COVER } as const;
  const tasks = { compress: compress(), convert_video: convert('mkv'), convert_audio: convert('mp3'), extract_audio: extract() } as const;
  const expected = {
    compress: { video: 'plan', video_no_audio: 'plan', audio: 'task_not_applicable', audio_with_cover: 'task_not_applicable' },
    convert_video: { video: 'plan', video_no_audio: 'plan', audio: 'no_video_stream', audio_with_cover: 'no_video_stream' },
    convert_audio: { video: 'plan', video_no_audio: 'no_audio_stream', audio: 'plan', audio_with_cover: 'plan' },
    extract_audio: { video: 'plan', video_no_audio: 'no_audio_stream', audio: 'task_not_applicable', audio_with_cover: 'task_not_applicable' },
  } as const;
  const cells = Object.entries(tasks).flatMap(([task, settings]) => Object.entries(shapes).map(([shape, value]) => [task, shape, settings, value] as const));

  it('has the designed 16 cells', () => {
    expect(TASK_MATRIX).toEqual(expected);
    expect(cells).toHaveLength(16);
    for (const [shape, value] of Object.entries(shapes)) expect(mediaShape(value)).toBe(shape);
  });

  it.each(cells)('%s on %s', (task, shape, settings, value) => {
    const outcome = buildPlan(value, settings, CPU_ONLY);
    const cell = expected[task as keyof typeof expected][shape as keyof typeof shapes];
    if (cell !== 'plan') {
      expect(outcome).toEqual({ status: 'not_applicable', reason: cell });
      return;
    }
    const plan = planOf(outcome);
    expect(plan.outputs).toHaveLength(1);
    expect(planSummarySchema.parse(plan.summary)).toEqual(plan.summary);
    const kept = plan.outputs[0].streams.filter(decision => decision.action !== 'drop');
    if (task === 'convert_audio' || task === 'extract_audio') {
      // One audio track and nothing else but cover art.
      expect(kept.filter(decision => decision.source.kind === 'audio')).toHaveLength(1);
      expect(kept.every(decision => decision.source.kind === 'audio' || decision.source.kind === 'cover')).toBe(true);
    } else {
      expect(kept[0].source).toMatchObject({ kind: 'video', index: value.primaryVideoIndex });
    }
  });

  it('converts the default audio track of a video to an audio format, not the first', () => {
    const value = media({ container: 'mp4', video: [video(0, 0)], audio: [audio(1, 0, 'aac'), audio(2, 1, 'aac', { default: true, language: 'jpn' })] });
    const plan = ready(value, convert('mp3'));
    expect(decisions(plan.outputs[0])).toEqual(['video#0:drop(not_selected)', 'audio#1:drop(not_selected)', 'audio#2:encode(libmp3lame)']);
    expect(plan.outputs[0].container).toMatchObject({ id: 'mp3', muxer: 'mp3', extension: 'mp3', baseName: { rule: 'converted' } });
    // Without a default track, the first.
    const firstOnly = ready(media({ container: 'mp4', video: [video(0, 0)], audio: [audio(1, 0, 'opus'), audio(2, 1, 'aac')] }), convert('opus'));
    expect(decisions(firstOnly.outputs[0])).toEqual(['video#0:drop(not_selected)', 'audio#1:copy', 'audio#2:drop(not_selected)']);
  });
});

// ── Mapping ────────────────────────────────────────────────────────────────────────────────────

/** Every fixture × every target the matrix allows. */
const FIXTURES = { MULTI, PLAIN_MKV, PHONE_MOV, PLAIN_MP4, SILENT_MP4, FLAC, FLAC_COVER } as const;
const SETTINGS: Record<string, ConversionSettings> = {
  'convert mp4': convert('mp4'), 'convert mov': convert('mov'), 'convert mkv': convert('mkv'), 'convert webm': convert('webm'),
  'convert mkv re-encode': convert('mkv', false), 'convert mp3': convert('mp3'), 'convert m4a': convert('m4a'), 'convert opus': convert('opus'),
  'convert flac': convert('flac'), 'convert wav': convert('wav'), 'convert alac': convert('alac'),
  'compress av1': compress({ codec: 'av1' }), 'compress hevc': compress({ codec: 'hevc' }), 'compress h264 mp4': compress({ container: 'mp4' }),
  'compress h264 mkv kept': compress({ container: 'mkv', discardIfNotSmaller: false }),
  'extract copy': extract(), 'extract all mp3': extract({ format: 'mp3', allTracks: true }),
};
const COMBINATIONS = Object.entries(FIXTURES).flatMap(([name, value]) => Object.entries(SETTINGS).map(([label, settings]) => ({ name, value, label, settings })));

describe('explicit mapping (AC-ENCODE-01-2)', () => {
  it('maps every kept stream by its absolute index and never by default, `-map 0` or a type selector', () => {
    let checked = 0;
    for (const { value, settings } of COMBINATIONS) {
      const outcome = buildPlan(value, settings, CPU_ONLY);
      if (outcome.status === 'not_applicable' || outcome.status === 'error') continue;
      for (const output of outcome.plan.outputs) {
        const args = toFfmpegArgs(output, IO);
        const maps = args.flatMap((arg, i) => arg === '-map' ? [args[i + 1]] : []);
        const kept = output.streams.filter(decision => decision.action !== 'drop');
        expect(maps.filter(map => map !== '0:t?')).toEqual(kept.map(decision => `0:${decision.source.index}`));
        expect(maps.every(map => /^0:\d+$/.test(map) || map === '0:t?')).toBe(true);
        expect(maps).not.toContain('0');
        // Cover art is never the main video, and the main video is the probed one.
        expect(kept.filter(decision => decision.source.kind === 'video').map(decision => decision.source.index))
          .toEqual(value.kind === 'video' && kept.some(decision => decision.source.kind === 'video') ? [value.primaryVideoIndex] : []);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('never maps data streams or the source attachments outside MKV', () => {
    const toMp4 = toFfmpegArgs(ready(MULTI, convert('mp4')).outputs[0], IO);
    expect(toMp4.filter(arg => arg === '-map')).toHaveLength(6);
    expect(toMp4).not.toContain('0:t?');
    const toMkv = planOf(buildPlan(MULTI, convert('mkv'), CPU_ONLY)).outputs[0];
    expect(toMkv.dataStreams).toBe(1);
    const mkvArgs = toFfmpegArgs(toMkv, IO);
    expect(mkvArgs.filter(arg => arg === '-map')).toHaveLength(8);
    expect(mkvArgs).toContain('0:t?');
  });

  it('takes the probed main video even when a still picture comes first', () => {
    const value = media({ video: [video(0, 0, { codec: 'png', avgFrameRate: null, rFrameRate: null, fps: null, default: false }), video(1, 1)], audio: [audio(2, 0, 'aac')] });
    expect(value.primaryVideoIndex).toBe(1);
    const plan = ready(value, convert('mp4'));
    expect(decisions(plan.outputs[0])).toEqual(['video#0:drop(not_selected)', 'video#1:copy', 'audio#2:copy']);
    const args = toFfmpegArgs(plan.outputs[0], IO);
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4)).toEqual(['-map', '0:1', '-map', '0:2']);
    expect(args).toContain('-c:v:0');
  });
});

// ── Containers ─────────────────────────────────────────────────────────────────────────────────

describe('streams per target container (AC-ENCODE-01-3)', () => {
  it('MP4: text to mov_text, styled ASS warned, PGS, fonts and cover dropped and listed, with the complete arguments', () => {
    const plan = ready(MULTI, convert('mp4'));
    const output = plan.outputs[0];
    expect(decisions(output)).toEqual([
      'video#0:copy', 'audio#1:copy', 'audio#2:copy',
      'subtitle#3:encode(mov_text)', 'subtitle#4:encode(mov_text)', 'subtitle#5:encode(mov_text)', 'subtitle#6:drop(subtitle_dropped)',
      'cover#7:drop(cover_dropped)',
    ]);
    expect(warningsOf(plan)).toEqual(['subtitle_styling_lost[4]x1', 'subtitle_dropped[6]x1', 'cover_dropped[7]x1', 'attachment_dropped[]x2', 'mp4_default_subtitle_forced[3]x1']);
    expect(plan.isRemuxOnly).toBe(true);
    expect(toFfmpegArgs(output, IO)).toEqual([
      '-f', 'matroska', '-protocol_whitelist', 'file', '-i', 'file:C:\\media\\movie.mkv',
      '-map', '0:0', '-map', '0:1', '-map', '0:2', '-map', '0:3', '-map', '0:4', '-map', '0:5',
      '-map_metadata', '0', '-map_chapters', '0',
      '-c:v:0', 'copy', '-c:a:0', 'copy', '-c:a:1', 'copy', '-c:s:0', 'mov_text', '-c:s:1', 'mov_text', '-c:s:2', 'mov_text',
      '-disposition:a:0', '+default-forced', '-metadata:s:a:0', 'handler_name=Main',
      '-disposition:a:1', '-default-forced', '-metadata:s:a:1', 'handler_name=Commentary',
      '-disposition:s:0', '-default-forced-hearing_impaired', '-metadata:s:s:0', 'handler_name=Full',
      '-disposition:s:1', '-default+forced-hearing_impaired', '-metadata:s:s:1', 'handler_name=Signs',
      '-disposition:s:2', '-default-forced+hearing_impaired',
      '-max_muxing_queue_size', '4096', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
      '-fs', String(1_000_000_000 * 1.05 + MIB16), '-t', '70.000000',
      '-f', 'mp4', '-y', 'file:D:\\out\\.fusionkit-media-0011aabb.partial',
    ]);
  });

  it('MOV: like MP4, but 24-bit PCM and ProRes are copied where MP4 re-encodes them', () => {
    const studio = media({ container: 'mkv', video: [video(0, 0, { codec: 'prores', profile: 'HQ', pixFmt: 'yuv422p10le' })], audio: [audio(1, 0, 'pcm_s24le', { default: true })] });
    expect(decisions(ready(studio, convert('mov')).outputs[0])).toEqual(['video#0:copy', 'audio#1:copy']);
    expect(decisions(ready(studio, convert('mp4')).outputs[0])).toEqual(['video#0:encode(libopenh264)', 'audio#1:encode(aac)']);
    const fromMulti = ready(MULTI, convert('mov'));
    expect(decisions(fromMulti.outputs[0])).toEqual(decisions(ready(MULTI, convert('mp4')).outputs[0]));
    expect(fromMulti.outputs[0].container).toMatchObject({ id: 'mov', muxer: 'mov', extension: 'mov', faststart: true });
    expect(valueAfter(toFfmpegArgs(fromMulti.outputs[0], IO), '-movflags')).toBe('+faststart');
  });

  it('MKV: keeps every subtitle and the fonts, drops the cover, writes no handler names', () => {
    const outcome = buildPlan(MULTI, convert('mkv'), CPU_ONLY);
    // Every stream is copied into the same container: nothing to do unless the user insists.
    expect(outcome.status).toBe('skipped');
    const output = planOf(outcome).outputs[0];
    expect(decisions(output)).toEqual([
      'video#0:copy', 'audio#1:copy', 'audio#2:copy', 'subtitle#3:copy', 'subtitle#4:copy', 'subtitle#5:copy', 'subtitle#6:copy', 'cover#7:drop(cover_dropped)',
    ]);
    const args = toFfmpegArgs(output, IO);
    expect(args.join(' ')).toContain('-map 0:6 -map 0:t? -map_metadata 0 -map_chapters 0');
    expect(args.join(' ')).toContain('-c:s:3 copy -c:t copy');
    expect(args.some(arg => arg.startsWith('-metadata:s:'))).toBe(false);
    expect(args).not.toContain('-movflags');
    expect(args.slice(-4)).toEqual(['-f', 'matroska', '-y', 'file:D:\\out\\.fusionkit-media-0011aabb.partial']);
    expect(warningsOf(planOf(outcome))).toEqual(['cover_dropped[7]x1']);
  });

  it('MKV: mov_text and EIA-608 become SRT, text without a decoder or a CodecID is dropped', () => {
    const value = media({ container: 'mp4', video: [video(0, 0)], audio: [audio(1, 0, 'aac')],
      subtitles: [subtitle(2, 0, 'mov_text', { language: 'eng', default: true }), subtitle(3, 1, 'eia_608'), subtitle(4, 2, 'dvb_teletext'), subtitle(5, 3, 'xsub')] });
    const plan = ready(value, convert('mkv'));
    expect(decisions(plan.outputs[0])).toEqual([
      'video#0:copy', 'audio#1:copy', 'subtitle#2:encode(srt)', 'subtitle#3:encode(srt)', 'subtitle#4:drop(subtitle_dropped)', 'subtitle#5:drop(subtitle_dropped)',
    ]);
    expect(warningsOf(plan)).toEqual(['subtitle_dropped[4,5]x2']);
    expect(plan.isRemuxOnly).toBe(true);
    // ffmpeg is given the SubRip encoder by its own name; `srt` is a deprecated alias (design §7a).
    const args = toFfmpegArgs(plan.outputs[0], IO);
    expect([valueAfter(args, '-c:s:0'), valueAfter(args, '-c:s:1')]).toEqual(['subrip', 'subrip']);
    expect(args).not.toContain('srt');
    // EIA-608 can be decoded, so MP4 takes it as mov_text.
    expect(decisions(ready(value, convert('mp4')).outputs[0]).slice(2, 4)).toEqual(['subtitle#2:copy', 'subtitle#3:encode(mov_text)']);
  });

  it('WebM: only VP8/VP9/AV1, Opus/Vorbis and WebVTT; everything else is converted or dropped', () => {
    const plan = ready(MULTI, convert('webm'));
    expect(decisions(plan.outputs[0])).toEqual([
      'video#0:encode(libsvtav1)', 'audio#1:encode(libopus)', 'audio#2:encode(libopus)',
      'subtitle#3:encode(webvtt)', 'subtitle#4:encode(webvtt)', 'subtitle#5:encode(webvtt)', 'subtitle#6:drop(subtitle_dropped)', 'cover#7:drop(cover_dropped)',
    ]);
    expect(warningsOf(plan)).toEqual(['subtitle_styling_lost[4]x1', 'subtitle_dropped[6]x1', 'cover_dropped[7]x1', 'attachment_dropped[]x2']);
    const vp9 = media({ container: 'mkv', video: [video(0, 0, { codec: 'vp9' })], audio: [audio(1, 0, 'vorbis')], subtitles: [subtitle(2, 0, 'webvtt')] });
    expect(decisions(ready(vp9, convert('webm')).outputs[0])).toEqual(['video#0:copy', 'audio#1:copy', 'subtitle#2:copy']);
    expect(decisions(ready(vp9, convert('mp4')).outputs[0])).toEqual(['video#0:encode(libopenh264)', 'audio#1:encode(aac)', 'subtitle#2:encode(mov_text)']);
  });

  it('tags HEVC as hvc1 in MP4 and MOV, copied or encoded, and nowhere else', () => {
    const tagOf = (plan: ConversionPlan) => valueAfter(toFfmpegArgs(plan.outputs[0], IO), '-tag:v:0');
    expect(tagOf(ready(PHONE_MOV, convert('mp4')))).toBe('hvc1');
    expect(tagOf(ready(PHONE_MOV, compress({ codec: 'hevc' })))).toBe('hvc1');
    expect(toFfmpegArgs(ready(PHONE_MOV, convert('mkv')).outputs[0], IO)).not.toContain('-tag:v:0');
    expect(toFfmpegArgs(ready(PLAIN_MKV, compress({ codec: 'av1' })).outputs[0], IO)).not.toContain('-tag:v:0');
    expect(toFfmpegArgs(ready(PLAIN_MKV, convert('mp4')).outputs[0], IO)).not.toContain('-tag:v:0');
  });

  it('picks the convert re-encode codec by target: H.264 for MP4/MOV, AV1 for WebM and for MKV when remux is off', () => {
    const avi = media({ container: 'avi', video: [video(0, 0, { codec: 'mpeg4' })], audio: [audio(1, 0, 'mp3')] });
    expect(decisions(ready(avi, convert('mp4')).outputs[0])).toEqual(['video#0:encode(libopenh264)', 'audio#1:copy']);
    expect(decisions(ready(avi, convert('mov')).outputs[0])).toEqual(['video#0:encode(libopenh264)', 'audio#1:copy']);
    expect(decisions(ready(avi, convert('webm')).outputs[0])).toEqual(['video#0:encode(libsvtav1)', 'audio#1:encode(libopus)']);
    expect(decisions(ready(avi, convert('mkv')).outputs[0])).toEqual(['video#0:copy', 'audio#1:copy']);
    expect(decisions(ready(avi, convert('mkv', false)).outputs[0])).toEqual(['video#0:encode(libsvtav1)', 'audio#1:copy']);
  });
});

// ── Metadata ───────────────────────────────────────────────────────────────────────────────────

describe('metadata, chapters and dispositions (AC-ENCODE-01-4)', () => {
  it('maps global metadata and chapters, and writes every audio and subtitle disposition so ffmpeg adds no default of its own', () => {
    // Relative to the source flags: default and forced (and hearing impaired) as probed, every other source flag kept.
    for (const target of ['mp4', 'mov', 'mkv', 'webm'] as const) {
      const args = toFfmpegArgs(planOf(buildPlan(MULTI, convert(target), CPU_ONLY)).outputs[0], IO);
      expect(valueAfter(args, '-map_metadata')).toBe('0');
      expect(valueAfter(args, '-map_chapters')).toBe('0');
      expect(valueAfter(args, '-disposition:a:0')).toBe('+default-forced');
      expect(valueAfter(args, '-disposition:a:1')).toBe('-default-forced');
      expect(valueAfter(args, '-disposition:s:0')).toBe('-default-forced-hearing_impaired');
      expect(valueAfter(args, '-disposition:s:1')).toBe('-default+forced-hearing_impaired');
      expect(valueAfter(args, '-disposition:s:2')).toBe('-default-forced+hearing_impaired');
      expect(args).not.toContain('-disposition:v:0');
    }
    const flagged = media({ video: [video(0, 0)], subtitles: [subtitle(1, 0, 'subrip', { default: true, forced: true, hearingImpaired: true })] });
    expect(valueAfter(toFfmpegArgs(ready(flagged, convert('mp4')).outputs[0], IO), '-disposition:s:0')).toBe('+default+forced+hearing_impaired');
  });

  it('carries titles in handler_name for MP4 and MOV only, video titles included', () => {
    const titled = media({ video: [video(0, 0, { title: 'Feature' })], audio: [audio(1, 0, 'aac', { title: 'Stereo = mix' })] });
    const mp4 = toFfmpegArgs(ready(titled, convert('mp4')).outputs[0], IO);
    expect(valueAfter(mp4, '-metadata:s:v:0')).toBe('handler_name=Feature');
    expect(valueAfter(mp4, '-metadata:s:a:0')).toBe('handler_name=Stereo = mix');
    expect(toFfmpegArgs(planOf(buildPlan(titled, convert('webm'), CPU_ONLY)).outputs[0], IO).some(arg => arg.startsWith('-metadata:s:'))).toBe(false);
  });

  it('notes in MP4 and MOV that the first subtitle becomes the default when none is', () => {
    const forcedCode = (value: MediaInfo, settings: ConversionSettings) => planOf(buildPlan(value, settings, CPU_ONLY)).summary.warnings.find(item => item.code === 'mp4_default_subtitle_forced');
    expect(forcedCode(MULTI, convert('mp4'))).toEqual({ code: 'mp4_default_subtitle_forced', streams: [3], count: 1 });
    expect(forcedCode(MULTI, convert('mov'))).toBeDefined();
    expect(forcedCode(MULTI, convert('mkv'))).toBeUndefined();
    expect(forcedCode(MULTI, convert('webm'))).toBeUndefined();
    const withDefault = media({ video: [video(0, 0)], subtitles: [subtitle(1, 0, 'subrip'), subtitle(2, 1, 'subrip', { default: true })] });
    expect(forcedCode(withDefault, convert('mp4'))).toBeUndefined();
    // Only image subtitles: nothing is kept, so nothing is forced.
    expect(forcedCode(media({ video: [video(0, 0)], subtitles: [subtitle(1, 0, 'hdmv_pgs_subtitle')] }), convert('mp4'))).toBeUndefined();
  });

  it('notes in MP4 and MOV that the first audio track of a video becomes the default when none is', () => {
    const audioCode = (value: MediaInfo, settings: ConversionSettings) => planOf(buildPlan(value, settings, CPU_ONLY)).summary.warnings.find(item => item.code === 'mp4_default_audio_forced');
    // An MPEG-TS has no default flags at all.
    const ts = media({ container: 'ts', video: [video(0, 0)], audio: [audio(1, 0, 'aac'), audio(2, 1, 'ac3', { bitRate: 448_000 })] });
    expect(audioCode(ts, convert('mp4'))).toEqual({ code: 'mp4_default_audio_forced', streams: [1], count: 1 });
    expect(audioCode(ts, convert('mov'))).toBeDefined();
    expect(audioCode(ts, compress({ container: 'mp4' }))).toBeDefined();
    expect(audioCode(ts, convert('mkv'))).toBeUndefined();
    expect(audioCode(MULTI, convert('mp4'))).toBeUndefined();
    // A single extracted track is no choice among tracks.
    expect(audioCode(ts, extract())).toBeUndefined();
    expect(audioCode(ts, convert('m4a'))).toBeUndefined();
    expect(PLAN_LOSS_CODES).not.toContain('mp4_default_audio_forced');
  });

  it('writes dispositions relative to the source flags, so commentary, visual impaired and similar flags stay', () => {
    const args = toFfmpegArgs(ready(MULTI, convert('mkv', false)).outputs[0], IO);
    const dispositions = args.flatMap((arg, i) => arg.startsWith('-disposition:') ? [args[i + 1]] : []);
    expect(dispositions).toHaveLength(6);
    // Every value only sets or clears the flags the probe reports; no absolute value that would clear the rest.
    for (const value of dispositions) expect(value).toMatch(/^(?:[+-](?:default|forced|hearing_impaired))+$/);
  });

  it('drops chapters only where the target cannot hold them, and says so', () => {
    expect(warningsOf(ready(FLAC_COVER, convert('mp3')))).toEqual([]);
    const toWav = ready(FLAC_COVER, convert('wav'));
    expect(warningsOf(toWav)).toEqual(['cover_dropped[1]x1', 'chapters_dropped[]x2']);
    expect(valueAfter(toFfmpegArgs(toWav.outputs[0], IO), '-map_chapters')).toBe('-1');
    expect(valueAfter(toFfmpegArgs(ready(FLAC_COVER, convert('mp3')).outputs[0], IO), '-map_chapters')).toBe('0');
  });
});

// ── Summary ────────────────────────────────────────────────────────────────────────────────────

describe('the plan summary (AC-ENCODE-01-5)', () => {
  it('lists the encoders, each stream, the losses with their reasons, the remux flag and the warnings', () => {
    const plan = ready(MULTI, compress({ codec: 'av1', container: 'mp4' }));
    const summary = planSummarySchema.parse(plan.summary);
    expect(summary).toMatchObject({ task: 'compress', remuxOnly: false, confirmations: [] });
    // The AAC track's rate is unknown and the AC-3 one is above 1.25 × the tier's: compress re-encodes both (AC-ENCODE-05-1).
    expect(summary.encoders).toEqual([{ encoder: 'libsvtav1', variant: '10bit' }, { encoder: 'aac', variant: null }, { encoder: 'mov_text', variant: null }]);
    const streams = summary.outputs[0].streams;
    expect(streams.map(item => [item.index, item.action, item.encoder ?? item.reason])).toEqual([
      [0, 'encode', 'libsvtav1'], [1, 'encode', 'aac'], [2, 'encode', 'aac'], [3, 'encode', 'mov_text'], [4, 'encode', 'mov_text'], [5, 'encode', 'mov_text'],
      [6, 'drop', 'subtitle_dropped'], [7, 'drop', 'cover_dropped'],
    ]);
    expect(streams[6]).toEqual({ kind: 'subtitle', index: 6, typeIndex: 3, codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'PGS',
      action: 'drop', encoder: null, variant: null, reason: 'subtitle_dropped' });
    expect(summary.outputs[0]).toMatchObject({ container: 'mp4', extension: 'mp4', track: null, attachments: { count: 2, kept: false },
      chapters: { count: 3, kept: true }, dataStreamsDropped: 1 });
    const losses = summary.warnings.filter(item => PLAN_LOSS_CODES.includes(item.code)).map(item => item.code);
    expect(losses).toEqual(['subtitle_styling_lost', 'subtitle_dropped', 'cover_dropped', 'attachment_dropped']);
    expect(ready(PLAIN_MKV, convert('mp4')).summary).toMatchObject({ remuxOnly: true, encoders: [], warnings: [] });
  });
});

// ── Container "auto" ───────────────────────────────────────────────────────────────────────────

describe('the compress container "auto" (AC-ENCODE-01-8)', () => {
  const base = { video: [video(0, 0)], audio: [audio(1, 0, 'aac')] };
  it.each([
    ['styled ASS', media({ ...base, subtitles: [subtitle(2, 0, 'ass', { styled: true })] }), 'mkv'],
    ['styled SSA', media({ ...base, subtitles: [subtitle(2, 0, 'ssa', { styled: true })] }), 'mkv'],
    ['PGS', media({ ...base, subtitles: [subtitle(2, 0, 'hdmv_pgs_subtitle')] }), 'mkv'],
    ['VobSub', media({ ...base, subtitles: [subtitle(2, 0, 'dvd_subtitle')] }), 'mkv'],
    ['fonts', media({ ...base, attachments: 1 }), 'mkv'],
    ['plain ASS', media({ ...base, subtitles: [subtitle(2, 0, 'ass', { styled: false })] }), 'mp4'],
    ['SRT', media({ ...base, subtitles: [subtitle(2, 0, 'subrip')] }), 'mp4'],
    ['EIA-608', media({ ...base, subtitles: [subtitle(2, 0, 'eia_608')] }), 'mp4'],
    ['nothing', media(base), 'mp4'],
  ] as const)('%s → %s', (_name, value, container) => {
    expect(autoCompressContainer(value)).toBe(container);
    const output = ready(value, compress()).outputs[0];
    expect(output.container.id).toBe(container);
    expect(output.container.baseName).toEqual({ rule: 'compressed' });
  });

  it('follows an explicit choice, with the losses it brings', () => {
    const styled = media({ ...base, subtitles: [subtitle(2, 0, 'ass', { styled: true })] });
    const plan = ready(styled, compress({ container: 'mp4' }));
    expect(plan.outputs[0].container.id).toBe('mp4');
    expect(warningsOf(plan)).toContain('subtitle_styling_lost[2]x1');
    expect(ready(PLAIN_MKV, compress({ container: 'mkv' })).outputs[0].container.id).toBe('mkv');
  });
});

// ── Remux and already_target ───────────────────────────────────────────────────────────────────

describe('remux and already_target (AC-ENCODE-06-2)', () => {
  it('remuxes an MKV with H.264 and AAC of unknown bit rate into MP4', () => {
    const plan = ready(PLAIN_MKV, convert('mp4'));
    expect(plan.isRemuxOnly).toBe(true);
    expect(decisions(plan.outputs[0])).toEqual(['video#0:copy', 'audio#1:copy']);
    const args = toFfmpegArgs(plan.outputs[0], IO);
    expect(valueAfter(args, '-avoid_negative_ts')).toBe('make_zero');
    expect(args).not.toContain('-fflags');
  });

  it('remuxes MOV into MP4 instead of skipping it', () => {
    const plan = ready(PHONE_MOV, convert('mp4'));
    expect(plan.isRemuxOnly).toBe(true);
    expect(plan.outputs[0].dataStreams).toBe(3);
  });

  it('does not skip MKV to WebM, nor an .m4v to .mp4, nor an MPEG-TS named .mp4', () => {
    expect(buildPlan(PLAIN_MKV, convert('webm'), CPU_ONLY).status).toBe('ready');
    expect(buildPlan(media({ container: 'm4v', video: [video(0, 0)], audio: [audio(1, 0, 'aac')] }), convert('mp4'), CPU_ONLY).status).toBe('ready');
    const ts = media({ container: 'ts', video: [video(0, 0)], audio: [audio(1, 0, 'aac')] });
    expect(isSameContainer(ts.container, 'mp4')).toBe(false);
    expect(buildPlan(ts, convert('mp4'), CPU_ONLY).status).toBe('ready');
  });

  it('skips an MP4 to MP4 whose every stream is copied, and keeps the plan for "convert anyway"', () => {
    const outcome = buildPlan(PLAIN_MP4, convert('mp4'), CPU_ONLY);
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(planOf(outcome).isRemuxOnly).toBe(true);
    expect(toFfmpegArgs(planOf(outcome).outputs[0], IO)).toContain('-avoid_negative_ts');
    // Re-encoding asked for: not the same file any more.
    expect(buildPlan(PLAIN_MP4, convert('mp4', false), CPU_ONLY).status).toBe('ready');
    // Compression always encodes.
    expect(buildPlan(PLAIN_MP4, compress({ container: 'mp4' }), CPU_ONLY).status).toBe('ready');
  });

  it('skips audio already in the target codec and type at no lower a rate, and remuxes when only the type differs', () => {
    expect(buildPlan(FLAC, convert('flac'), CPU_ONLY).status).toBe('skipped');
    // A 128 kbit/s MP3 (its total rate: an MP3 of one track) against standard MP3, nominally 190 kbit/s: copied, already the target.
    expect(buildPlan(media({ container: 'mp3', audio: [audio(0, 0, 'mp3')], bitRate: 128_000 }), convert('mp3'), CPU_ONLY)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    const opusInOgg = media({ container: 'ogg', audio: [audio(0, 0, 'opus')], bitRate: 96_000 });
    expect(ready(opusInOgg, convert('opus')).isRemuxOnly).toBe(true);
    expect(ready(FLAC, convert('mp3')).isRemuxOnly).toBe(false);
  });

  it('re-encodes the same codec when the target rate is lower (AC-ENCODE-04-5): not already_target, no remux', () => {
    // A 320 kbit/s MP3 to standard MP3 shrinks it.
    const loud = media({ container: 'mp3', audio: [audio(0, 0, 'mp3', { bitRate: 320_000, bitRateSource: 'stream' })], sizeBytes: 2_400_000, bitRate: 320_000 });
    const plan = ready(loud, convert('mp3'));
    expect(decisions(plan.outputs[0])).toEqual(['audio#0:encode(libmp3lame)']);
    expect(plan.isRemuxOnly).toBe(false);
    expect(plan.outputs[0].capBytes).toBe(Math.ceil(320_000 * 60 / 8 * 1.2 + MIB16));
    // The rate unknown on the stream: the total rate of a file of that one track decides (here 200 kbit/s Opus against 128).
    expect(decisions(ready(media({ container: 'ogg', audio: [audio(0, 0, 'opus')], bitRate: 200_000 }), convert('opus')).outputs[0])).toEqual(['audio#0:encode(libopus)']);
    // The default fixture's 133 Mbit/s total is a video's; inside a video the total never stands for a track.
    expect(decisions(ready(PLAIN_MKV, extract({ format: 'm4a' })).outputs[0])).toEqual(['video#0:drop(not_selected)', 'audio#1:copy']);
  });

  it('generates timestamps for an AVI remux, before the input', () => {
    const avi = media({ container: 'avi', video: [video(0, 0)], audio: [audio(1, 0, 'mp3')] });
    const args = toFfmpegArgs(ready(avi, convert('mkv')).outputs[0], { ...IO, demuxer: 'avi' });
    expect(args.slice(0, 4)).toEqual(['-fflags', '+genpts', '-f', 'avi']);
    expect(toFfmpegArgs(ready(avi, convert('mkv', false)).outputs[0], { ...IO, demuxer: 'avi' })).not.toContain('-fflags');
  });

  it('re-encodes raw H.264 and HEVC streams, which a copy cannot time; raw MPEG-1/2 video remuxes with +genpts (design §7b)', () => {
    // As the probe reads a raw stream: no duration, the demuxer's 25 fps against the VUI's rate (so "VFR").
    const untimed = { durationUs: null, rFrameRate: '60/1', avgFrameRate: '25/1', fps: 25, isVfr: true, bitRate: null };
    const rawOf = (container: 'h264' | 'hevc' | 'm2v', codec: string) => media({
      container, video: [video(0, 0, { codec, ...untimed })], durationUs: null, durationSource: null, startTimeUs: null, bitRate: null, sizeBytes: 5_000_000,
    });
    for (const [container, codec] of [['h264', 'h264'], ['hevc', 'hevc']] as const) {
      const source = rawOf(container, codec);
      for (const [target, encoder] of [['mp4', 'libopenh264'], ['mov', 'libopenh264'], ['mkv', 'libsvtav1'], ['webm', 'libsvtav1']] as const) {
        for (const preferRemux of [true, false]) {
          const plan = ready(source, convert(target, preferRemux));
          expect(decisions(plan.outputs[0]), `${container} → ${target}`).toEqual([`video#0:encode(${encoder})`]);
          expect(plan).toMatchObject({ isRemuxOnly: false, summary: { remuxOnly: false } });
          expect(plan.outputs[0]).toMatchObject({ remux: false, generatePts: false, expectedDurationUs: null, durationLimitUs: null });
          const args = toFfmpegArgs(plan.outputs[0], { ...IO, demuxer: container });
          expect(args).not.toContain('-fflags');
          expect(args.slice(0, 2)).toEqual(['-f', container]);
          expect(valueAfter(args, '-c:v:0')).toBe(encoder);
        }
      }
      // A graphics card takes the re-encode as it would any other.
      expect(decisions(ready(source, convert('mp4'), ALL_NVENC).outputs[0])).toEqual(['video#0:encode(h264_nvenc)']);
      expect(decisions(ready(source, compress({ codec: 'hevc' })).outputs[0])).toEqual(['video#0:encode(libkvazaar)']);
      expect(ready(source, compress({ codec: 'hevc' })).summary.warnings.map(item => item.code)).toContain('duration_unverified');
    }
    // The rule is the demuxer's, not the codec's: H.264 and HEVC in a container still remux.
    expect(decisions(ready(PLAIN_MKV, convert('mp4')).outputs[0])).toEqual(['video#0:copy', 'audio#1:copy']);
    expect(ready(PHONE_MOV, convert('mkv')).outputs[0]).toMatchObject({ remux: true, generatePts: false });

    // Raw MPEG-2: its parser times the frames, +genpts the B-frames; MP4 does not take MPEG-2, so that is an encode.
    const mpeg2 = rawOf('m2v', 'mpeg2video');
    const remuxed = ready(mpeg2, convert('mkv'));
    expect(decisions(remuxed.outputs[0])).toEqual(['video#0:copy']);
    expect(remuxed.outputs[0]).toMatchObject({ remux: true, generatePts: true });
    expect(toFfmpegArgs(remuxed.outputs[0], { ...IO, demuxer: 'mpegvideo' }).slice(0, 4)).toEqual(['-fflags', '+genpts', '-f', 'mpegvideo']);
    expect(decisions(ready(mpeg2, convert('mp4')).outputs[0])).toEqual(['video#0:encode(libopenh264)']);
  });
});

// ── Caps ───────────────────────────────────────────────────────────────────────────────────────

describe('output caps (AC-ENCODE-06-1, design §7)', () => {
  it('caps a compress below 98 % of the source while "discard if not smaller" is on', () => {
    const output = ready(PLAIN_MKV, compress()).outputs[0];
    expect(output).toMatchObject({ capBytes: 980_000_000, capSemantics: 'not_smaller' });
    expect(valueAfter(toFfmpegArgs(output, IO), '-fs')).toBe('980000000');
    const odd = media({ video: [video(0, 0)], sizeBytes: 1_234_567 });
    expect(ready(odd, compress()).outputs[0].capBytes).toBe(Math.floor(1_234_567 * 0.98));
  });

  it('caps a compress with the protection off by max(4 × the source, 1 bit a pixel × pixel rate × duration) × 1.05 + 16 MiB (design §7b)', () => {
    const off = compress({ discardIfNotSmaller: false });
    expect([CAP_POLICY.videoBitsPerPixel, CAP_POLICY.videoSourceFactor, CAP_POLICY.videoMargin]).toEqual([1, 4, 1.05]);
    // 1 GB source: 4 GB is above 1.0 bit × 1920 × 1080 × 24 fps (+ the AAC of unknown rate re-encoded at the balanced 160 kbit/s) × 60 s ≈ 374 MB.
    const pixels = (1.0 * 1920 * 1080 * 24 + 160_000) * 60 / 8;
    expect(pixels).toBeLessThan(4_000_000_000);
    expect(ready(PLAIN_MKV, off).outputs[0]).toMatchObject({ capBytes: Math.ceil(4_000_000_000 * 1.05 + MIB16), capSemantics: 'output_cap_exceeded' });
    // A small, heavily compressed source: the pixel bound wins (the copied 128 kbit/s AAC rides on it).
    const small = media({ video: [video(0, 0)], audio: [audio(1, 0, 'aac', { bitRate: 128_000 })], sizeBytes: 1_000_000, bitRate: 133_333 });
    expect(ready(small, off).outputs[0].capBytes).toBe(Math.ceil((1.0 * 1920 * 1080 * 24 + 128_000) * 60 / 8 * 1.05 + MIB16));
    // Where the two meet: just below a quarter of the pixel bound the pixels decide, just above it the source does.
    const bound = (1.0 * 1920 * 1080 * 24 + 128_000) * 60 / 8;
    const sized = (sizeBytes: number) => ready(media({ video: [video(0, 0)], audio: [audio(1, 0, 'aac', { bitRate: 128_000 })], sizeBytes }), off).outputs[0].capBytes;
    expect(sized(Math.floor(bound / 4) - 1_000)).toBe(Math.ceil(bound * 1.05 + MIB16));
    expect(sized(Math.ceil(bound / 4) + 1_000)).toBe(Math.ceil((Math.ceil(bound / 4) + 1_000) * 4 * 1.05 + MIB16));
    // MF at the quality tier reaches about 1.6 bits a pixel on detailed pictures (batch B, measured), far past the old 0.15-bit
    // bound; the new pixel bound alone is more than six times that, and four times the source covers the rest.
    expect(sized(1_000_000)).toBeGreaterThan(0.15 * 1920 * 1080 * 24 * 60 / 8 * 1.05 * 6);
  });

  it('caps a remux at 105 % of the source plus 16 MiB', () => {
    expect(ready(PLAIN_MKV, convert('mp4')).outputs[0]).toMatchObject({ capBytes: 1_050_000_000 + MIB16, capSemantics: 'output_cap_exceeded' });
    expect(ready(PHONE_MOV, convert('mkv')).outputs[0].capBytes).toBe(1_050_000_000 + MIB16);
  });

  it('caps a copied audio track without its video by 32-bit PCM of its rate and channels, never above the remux bound', () => {
    // Stereo 48 kHz AAC out of a 1 GB film, 60 s: 48000 × 2 × 4 bytes × 60 s × 1.2, not the film's size.
    const pcm = 48_000 * 2 * 4 * 60 * 1.2;
    expect(ready(PLAIN_MKV, extract()).outputs[0]).toMatchObject({ capBytes: Math.ceil(pcm + MIB16), capSemantics: 'output_cap_exceeded' });
    expect(ready(PLAIN_MKV, convert('m4a')).outputs[0].capBytes).toBe(Math.ceil(pcm + MIB16));
    // A two-hour 5.1 AC-3 track out of a 40 GB film; the stated 448 kbit/s is not trusted, so PCM bounds it.
    const film = media({ video: [video(0, 0)], audio: [audio(1, 0, 'ac3', { channels: 6, channelLayout: '5.1(side)', bitRate: 448_000, bitRateSource: 'stream', default: true })],
      sizeBytes: 40_000_000_000, durationUs: 7_200_000_000, bitRate: 44_444_444 });
    expect(ready(film, extract()).outputs[0].capBytes).toBe(Math.ceil(48_000 * 6 * 4 * 7_200 * 1.2 + MIB16));
    // 64-bit samples get 8 bytes; a small source is never exceeded by more than the remux bound.
    const doubles = media({ container: 'mkv', video: [video(0, 0)], audio: [audio(1, 0, 'pcm_f64le', { sampleFormat: 'dbl', bitsPerRawSample: null })], sizeBytes: 5_000_000_000 });
    expect(ready(doubles, extract()).outputs[0].capBytes).toBe(Math.ceil(48_000 * 2 * 8 * 60 * 1.2 + MIB16));
    const tiny = media({ video: [video(0, 0)], audio: [audio(1, 0, 'aac', { default: true })], sizeBytes: 2_000_000 });
    expect(ready(tiny, extract()).outputs[0].capBytes).toBe(2_100_000 + MIB16);
    // Unknown duration: the remux bound.
    const raw = media({ video: [video(0, 0, { durationUs: null })], audio: [audio(1, 0, 'aac', { durationUs: null })], durationUs: null, durationSource: null });
    expect(ready(raw, extract()).outputs[0].capBytes).toBe(1_050_000_000 + MIB16);
  });

  it('adds copied cover art at 8 bytes a pixel, so a large scan in a FLAC does not trip the cap of its MP3', () => {
    const scan = media({ container: 'flac', audio: [audio(0, 0, 'flac', { sampleFormat: 's16', default: true })], covers: [{ index: 1, typeIndex: 0, codec: 'png', width: 3000, height: 3000 }],
      sizeBytes: 200_000_000 });
    const output = ready(scan, convert('mp3')).outputs[0];
    expect(decisions(output)).toEqual(['audio#0:encode(libmp3lame)', 'cover#1:copy']);
    expect(output.capBytes).toBe(Math.ceil(320_000 * 60 / 8 * 1.2 + 3000 * 3000 * 8 + MIB16));
    // Dropped cover art adds nothing; a cover of unknown size counts as the whole source.
    expect(ready(scan, convert('opus')).outputs[0].capBytes).toBe(Math.ceil(128_000 * 60 / 8 * 1.2 + MIB16));
    const unsized = media({ container: 'flac', audio: [audio(0, 0, 'flac', { sampleFormat: 's16' })], covers: [{ index: 1, typeIndex: 0, codec: 'png', width: 0, height: 0 }], sizeBytes: 60_000_000 });
    expect(ready(unsized, convert('mp3')).outputs[0].capBytes).toBe(Math.ceil(320_000 * 60 / 8 * 1.2 + 63_000_000 + MIB16));
  });

  it('caps a copied video with re-encoded audio by the source size plus the audio bound', () => {
    const flacInMkv = media({ video: [video(0, 0)], audio: [audio(1, 0, 'flac', { default: true })] });
    const output = ready(flacInMkv, convert('mp4')).outputs[0];
    expect(decisions(output)).toEqual(['video#0:copy', 'audio#1:encode(aac)']);
    expect(output.remux).toBe(false);
    // AAC at the balanced 160 kbit/s of stereo in a video.
    expect(output.capBytes).toBe(Math.ceil(160_000 * 60 / 8 * 1.2 + 1_000_000_000 * 1.05 + MIB16));
  });

  it('caps audio by its format: PCM exactly, FLAC and ALAC below it, lossy by the rate bound', () => {
    const hiRes = media({ container: 'flac', audio: [audio(0, 0, 'flac', { sampleRate: 96_000, channels: 2, sampleFormat: 's32', bitsPerRawSample: 24 })], sizeBytes: 50_000_000 });
    const pcm = 96_000 * 2 * 3 * 60;
    expect(ready(hiRes, convert('wav')).outputs[0].capBytes).toBe(Math.ceil(pcm * 1.01 + MIB16));
    expect(ready(hiRes, convert('alac')).outputs[0].capBytes).toBe(Math.ceil(pcm * 1.01 * 0.9 + MIB16));
    const mp3 = media({ container: 'mp3', audio: [audio(0, 0, 'mp3', { sampleFormat: 'fltp' })], sizeBytes: 2_000_000 });
    expect(ready(mp3, convert('flac')).outputs[0].capBytes).toBe(Math.ceil(48_000 * 2 * 4 * 60 * 1.01 * 0.85 + MIB16));
    expect(ready(hiRes, convert('mp3')).outputs[0].capBytes).toBe(Math.ceil(320_000 * 60 / 8 * 1.2 + MIB16));
    // ALAC counts the channels it writes: quad goes into 5.0 (an empty centre), 2.1 into 5.1.
    const quad = media({ container: 'flac', audio: [audio(0, 0, 'flac', { channels: 4, channelLayout: 'quad', sampleFormat: 's16', default: true })], sizeBytes: 20_000_000 });
    expect(ready(quad, convert('alac')).outputs[0].capBytes).toBe(Math.ceil(48_000 * 5 * 2 * 60 * 1.01 * 0.9 + MIB16));
    const twoOne = media({ container: 'flac', audio: [audio(0, 0, 'flac', { channels: 3, channelLayout: '2.1', sampleFormat: 's16', default: true })], sizeBytes: 20_000_000 });
    expect(ready(twoOne, convert('alac')).outputs[0].capBytes).toBe(Math.ceil(48_000 * 6 * 2 * 60 * 1.01 * 0.9 + MIB16));
  });

  it('without a duration: four times the source, no -t, and duration_unverified', () => {
    const raw = media({ container: 'avi', video: [video(0, 0, { durationUs: null })], audio: [audio(1, 0, 'mp3', { durationUs: null })], durationUs: null, durationSource: null });
    const plan = ready(raw, convert('webm'));
    expect(plan.outputs[0]).toMatchObject({ capBytes: 4_000_000_000 + MIB16, expectedDurationUs: null, durationLimitUs: null });
    expect(toFfmpegArgs(plan.outputs[0], IO)).not.toContain('-t');
    expect(warningsOf(plan)).toContain('duration_unverified[]x0');
  });

  it('limits the duration to max(105 %, +10 s) of the probed duration', () => {
    expect(ready(PLAIN_MKV, convert('mp4')).outputs[0].durationLimitUs).toBe(70_000_000);
    const long = media({ video: [video(0, 0, { durationUs: 1_000_000_000 })], durationUs: 1_000_000_000 });
    expect(ready(long, convert('mp4')).outputs[0].durationLimitUs).toBe(1_050_000_000);
    expect(ffmpegSeconds(1_050_000_001)).toBe('1050.000001');
    expect(ffmpegSeconds(12_500_000)).toBe('12.500000');
    expect(CAP_POLICY.notSmallerRatio).toBe(0.98);
  });

  it('expects the main stream to reach its own duration: the video, or the extracted track', () => {
    const value = media({ video: [video(0, 0, { durationUs: 59_000_000 })], audio: [audio(1, 0, 'aac', { durationUs: 58_000_000 })] });
    expect(ready(value, convert('mp4')).outputs[0]).toMatchObject({ expectedDurationUs: 59_000_000, expectedFrom: 'stream' });
    expect(ready(value, extract()).outputs[0]).toMatchObject({ expectedDurationUs: 58_000_000, expectedFrom: 'stream' });
  });

  it('says where the expected duration came from: the container when the main stream has none', () => {
    const noStreamDuration = media({ video: [video(0, 0, { durationUs: null })], audio: [audio(1, 0, 'aac', { durationUs: null })] });
    for (const settings of [convert('mp4'), compress({ codec: 'av1' }), extract()]) {
      expect(ready(noStreamDuration, settings).outputs[0]).toMatchObject({ expectedDurationUs: MINUTE_US, expectedFrom: 'container' });
    }
    const unknown = media({ video: [video(0, 0, { durationUs: null })], durationUs: null, durationSource: null });
    expect(ready(unknown, convert('mkv', false)).outputs[0]).toMatchObject({ expectedDurationUs: null, expectedFrom: 'container' });
    expect(ready(PLAIN_MKV, compress()).outputs[0].expectedFrom).toBe('stream');
  });
});

// ── Extraction ─────────────────────────────────────────────────────────────────────────────────

describe('audio outputs', () => {
  it('makes one output per track for "all tracks", named by number and a valid language', () => {
    const value = media({ video: [video(0, 0)], audio: [audio(1, 0, 'aac', { language: 'eng' }), audio(2, 1, 'ac3', { language: 'en-us', default: true }), audio(3, 2, 'flac')] });
    const plan = ready(value, extract({ allTracks: true }));
    expect(plan.outputs.map(output => [output.container.id, output.container.baseName])).toEqual([
      ['m4a', { rule: 'track', number: 1, language: 'eng' }], ['mka', { rule: 'track', number: 2, language: null }], ['flac', { rule: 'track', number: 3, language: null }],
    ]);
    expect(plan.summary.outputs.map(output => output.track)).toEqual([{ number: 1, language: 'eng' }, { number: 2, language: null }, { number: 3, language: null }]);
    expect(decisions(plan.outputs[1])).toEqual(['video#0:drop(not_selected)', 'audio#1:drop(not_selected)', 'audio#2:copy', 'audio#3:drop(not_selected)']);
    // Without "all tracks": the default track only, named after the source.
    const single = ready(value, extract());
    expect(single.outputs).toHaveLength(1);
    expect(single.outputs[0].container).toMatchObject({ id: 'mka', baseName: { rule: 'source' } });
  });

  it('puts cover art in MP3, M4A and FLAC as an attached picture, and nowhere else', () => {
    const toMp3 = ready(FLAC_COVER, convert('mp3')).outputs[0];
    expect(decisions(toMp3)).toEqual(['audio#0:encode(libmp3lame)', 'cover#1:copy']);
    const args = toFfmpegArgs(toMp3, { ...IO, demuxer: 'flac' });
    expect(args.join(' ')).toContain('-map 0:0 -map 0:1');
    expect(args.join(' ')).toContain('-c:a:0 libmp3lame -q:a:0 2 -c:v:0 copy');
    expect(valueAfter(args, '-disposition:v:0')).toBe('attached_pic');
    expect(args.join(' ')).toContain('-id3v2_version 3 -write_id3v1 0');
    expect(decisions(ready(FLAC_COVER, convert('opus')).outputs[0])).toEqual(['audio#0:encode(libopus)', 'cover#1:drop(cover_dropped)']);
    expect(valueAfter(toFfmpegArgs(ready(FLAC_COVER, convert('wav')).outputs[0], IO), '-rf64')).toBe('auto');
  });
});

// ── Determinism and snapshots ──────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

describe('the same inputs always give the same plan (AC-ENCODE-01-1)', () => {
  it('gives equal plans and arguments for every fixture, setting and capability table, without touching its inputs', () => {
    const tiers = ['quality', 'balanced', 'size'] as const;
    for (const { value, settings } of COMBINATIONS) {
      for (const caps of [CPU_ONLY, ALL_NVENC]) {
        for (const tier of tiers) {
          const frozen = deepFreeze(structuredClone({ value, settings: { ...settings, tier }, caps }));
          const first = buildPlan(frozen.value, frozen.settings, frozen.caps);
          const second = buildPlan(frozen.value, frozen.settings, frozen.caps);
          expect(second).toEqual(first);
          expect(JSON.stringify(second)).toBe(JSON.stringify(first));
          if (first.status === 'ready' || first.status === 'skipped') {
            for (const output of first.plan.outputs) expect(toFfmpegArgs(output, IO)).toEqual(toFfmpegArgs(output, IO));
            expect(planSummarySchema.safeParse(first.plan.summary).success).toBe(true);
          }
        }
      }
    }
  });

  it('matches the snapshot of every fixture × setting combination', () => {
    const lines = COMBINATIONS.map(({ name, value, label, settings }) => {
      const outcome = buildPlan(value, settings, CPU_ONLY);
      if (outcome.status === 'not_applicable' || outcome.status === 'error') return `${name} | ${label} | ${outcome.status}:${outcome.reason}`;
      const outputs = outcome.plan.outputs.map(output => `${output.container.id}{${decisions(output).filter(item => !item.endsWith('(not_selected)')).join(' ')}}`
        + ` cap=${output.capBytes}/${output.capSemantics}`).join(' + ');
      const confirm = outcome.plan.summary.confirmations.map(code => ` confirm:${code}`).join('');
      return `${name} | ${label} | ${outcome.status}${outcome.plan.isRemuxOnly ? ' remux' : ''}${confirm} | ${outputs} | ${warningsOf(outcome.plan).join(' ')}`;
    });
    // The complete arguments of every output, without the input and output paths, which never change.
    const argumentLines = COMBINATIONS.flatMap(({ name, value, label, settings }) => {
      const outcome = buildPlan(value, settings, CPU_ONLY);
      if (outcome.status === 'not_applicable' || outcome.status === 'error') return [];
      return outcome.plan.outputs.map(output => {
        const args = toFfmpegArgs(output, IO);
        const input = args.indexOf('-i') + 2;
        expect(args.slice(input - 6, input)).toEqual(['-f', IO.demuxer, '-protocol_whitelist', 'file', '-i', `file:${IO.inputPath}`]);
        expect(args.slice(-4)).toEqual(['-f', output.container.muxer, '-y', `file:${IO.partialPath}`]);
        return `${name} | ${label} | ${[...args.slice(0, input - 6), '…', ...args.slice(input, -4)].join(' ')} -f ${output.container.muxer}`;
      });
    });
    expect(argumentLines.join('\n')).toMatchInlineSnapshot(`
      "MULTI | convert mp4 | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -c:a:1 copy -c:s:0 mov_text -c:s:1 mov_text -c:s:2 mov_text -disposition:a:0 +default-forced -metadata:s:a:0 handler_name=Main -disposition:a:1 -default-forced -metadata:s:a:1 handler_name=Commentary -disposition:s:0 -default-forced-hearing_impaired -metadata:s:s:0 handler_name=Full -disposition:s:1 -default+forced-hearing_impaired -metadata:s:s:1 handler_name=Signs -disposition:s:2 -default-forced+hearing_impaired -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mp4
      MULTI | convert mov | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -c:a:1 copy -c:s:0 mov_text -c:s:1 mov_text -c:s:2 mov_text -disposition:a:0 +default-forced -metadata:s:a:0 handler_name=Main -disposition:a:1 -default-forced -metadata:s:a:1 handler_name=Commentary -disposition:s:0 -default-forced-hearing_impaired -metadata:s:s:0 handler_name=Full -disposition:s:1 -default+forced-hearing_impaired -metadata:s:s:1 handler_name=Signs -disposition:s:2 -default-forced+hearing_impaired -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mov
      MULTI | convert mkv | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map 0:6 -map 0:t? -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -c:a:1 copy -c:s:0 copy -c:s:1 copy -c:s:2 copy -c:s:3 copy -c:t copy -disposition:a:0 +default-forced -disposition:a:1 -default-forced -disposition:s:0 -default-forced-hearing_impaired -disposition:s:1 -default+forced-hearing_impaired -disposition:s:2 -default-forced+hearing_impaired -disposition:s:3 -default-forced-hearing_impaired -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -fs 1066777216 -t 70.000000 -f matroska
      MULTI | convert webm | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -c:a:1 libopus -b:a:1 256k -vbr:a:1 on -compression_level:a:1 10 -filter:a:1 channelmap=map=FL-FL|FR-FR|FC-FC|LFE-LFE|SL-BL|SR-BR:channel_layout=5.1 -c:s:0 webvtt -c:s:1 webvtt -c:s:2 webvtt -disposition:a:0 +default-forced -disposition:a:1 -default-forced -disposition:s:0 -default-forced-hearing_impaired -disposition:s:1 -default+forced-hearing_impaired -disposition:s:2 -default-forced+hearing_impaired -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f webm
      MULTI | convert mkv re-encode | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map 0:6 -map 0:t? -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 copy -c:a:1 copy -c:s:0 copy -c:s:1 copy -c:s:2 copy -c:s:3 copy -c:t copy -disposition:a:0 +default-forced -disposition:a:1 -default-forced -disposition:s:0 -default-forced-hearing_impaired -disposition:s:1 -default+forced-hearing_impaired -disposition:s:2 -default-forced+hearing_impaired -disposition:s:3 -default-forced-hearing_impaired -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      MULTI | convert mp3 | … -map 0:1 -map 0:7 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -c:v:0 copy -disposition:v:0 attached_pic -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 22537216 -t 70.000000 -f mp3
      MULTI | convert m4a | … -map 0:1 -map 0:7 -map_metadata 0 -map_chapters 0 -c:a:0 copy -c:v:0 copy -metadata:s:a:0 handler_name=Main -disposition:v:0 attached_pic -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 47305216 -t 70.000000 -f ipod
      MULTI | convert opus | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10 -metadata:s:a:0 handler_name= -metadata:s:a:0 vendor_id= -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 17929216 -t 70.000000 -f opus
      MULTI | convert flac | … -map 0:1 -map 0:7 -map_metadata 0 -map_chapters -1 -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24 -c:v:0 copy -disposition:v:0 attached_pic -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 39437056 -t 70.000000 -f flac
      MULTI | convert wav | … -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 pcm_f32le -max_muxing_queue_size 4096 -rf64 auto -fs 40047616 -t 70.000000 -f wav
      MULTI | convert alac | … -map 0:1 -map 0:7 -map_metadata 0 -map_chapters 0 -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24 -c:v:0 copy -metadata:s:a:0 handler_name=Main -disposition:v:0 attached_pic -max_muxing_queue_size 4096 -movflags +faststart -fs 40600576 -t 70.000000 -f ipod
      MULTI | compress av1 | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map 0:6 -map 0:t? -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -c:a:1 libopus -b:a:1 256k -vbr:a:1 on -compression_level:a:1 10 -filter:a:1 channelmap=map=FL-FL|FR-FR|FC-FC|LFE-LFE|SL-BL|SR-BR:channel_layout=5.1 -c:s:0 copy -c:s:1 copy -c:s:2 copy -c:s:3 copy -c:t copy -disposition:a:0 +default-forced -disposition:a:1 -default-forced -disposition:s:0 -default-forced-hearing_impaired -disposition:s:1 -default+forced-hearing_impaired -disposition:s:2 -default-forced+hearing_impaired -disposition:s:3 -default-forced-hearing_impaired -max_muxing_queue_size 4096 -fs 980000000 -t 70.000000 -f matroska
      MULTI | compress hevc | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map 0:6 -map 0:t? -map_metadata 0 -map_chapters 0 -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=23,period=128 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -c:a:1 libopus -b:a:1 256k -vbr:a:1 on -compression_level:a:1 10 -filter:a:1 channelmap=map=FL-FL|FR-FR|FC-FC|LFE-LFE|SL-BL|SR-BR:channel_layout=5.1 -c:s:0 copy -c:s:1 copy -c:s:2 copy -c:s:3 copy -c:t copy -disposition:a:0 +default-forced -disposition:a:1 -default-forced -disposition:s:0 -default-forced-hearing_impaired -disposition:s:1 -default+forced-hearing_impaired -disposition:s:2 -default-forced+hearing_impaired -disposition:s:3 -default-forced-hearing_impaired -max_muxing_queue_size 4096 -fs 980000000 -t 70.000000 -f matroska
      MULTI | compress h264 mp4 | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -c:a:1 aac -b:a:1 320k -filter:a:1 channelmap=map=FL-FL|FR-FR|FC-FC|LFE-LFE|SL-BL|SR-BR:channel_layout=5.1 -c:s:0 mov_text -c:s:1 mov_text -c:s:2 mov_text -disposition:a:0 +default-forced -metadata:s:a:0 handler_name=Main -disposition:a:1 -default-forced -metadata:s:a:1 handler_name=Commentary -disposition:s:0 -default-forced-hearing_impaired -metadata:s:s:0 handler_name=Full -disposition:s:1 -default+forced-hearing_impaired -metadata:s:s:1 handler_name=Signs -disposition:s:2 -default-forced+hearing_impaired -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      MULTI | compress h264 mkv kept | … -map 0:0 -map 0:1 -map 0:2 -map 0:3 -map 0:4 -map 0:5 -map 0:6 -map 0:t? -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -c:a:1 libopus -b:a:1 256k -vbr:a:1 on -compression_level:a:1 10 -filter:a:1 channelmap=map=FL-FL|FR-FR|FC-FC|LFE-LFE|SL-BL|SR-BR:channel_layout=5.1 -c:s:0 copy -c:s:1 copy -c:s:2 copy -c:s:3 copy -c:t copy -disposition:a:0 +default-forced -disposition:a:1 -default-forced -disposition:s:0 -default-forced-hearing_impaired -disposition:s:1 -default+forced-hearing_impaired -disposition:s:2 -default-forced+hearing_impaired -disposition:s:3 -default-forced-hearing_impaired -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      MULTI | extract copy | … -map 0:1 -map 0:7 -map_metadata 0 -map_chapters 0 -c:a:0 copy -c:v:0 copy -metadata:s:a:0 handler_name=Main -disposition:v:0 attached_pic -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 47305216 -t 70.000000 -f ipod
      MULTI | extract all mp3 | … -map 0:1 -map 0:7 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -c:v:0 copy -disposition:v:0 attached_pic -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 22537216 -t 70.000000 -f mp3
      MULTI | extract all mp3 | … -map 0:2 -map 0:7 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -ac:a:0 2 -c:v:0 copy -disposition:v:0 attached_pic -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 22537216 -t 70.000000 -f mp3
      PLAIN_MKV | convert mp4 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mp4
      PLAIN_MKV | convert mov | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mov
      PLAIN_MKV | convert mkv | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -fs 1066777216 -t 70.000000 -f matroska
      PLAIN_MKV | convert webm | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f webm
      PLAIN_MKV | convert mkv re-encode | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      PLAIN_MKV | convert mp3 | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 19657216 -t 70.000000 -f mp3
      PLAIN_MKV | convert m4a | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 44425216 -t 70.000000 -f ipod
      PLAIN_MKV | convert opus | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10 -metadata:s:a:0 handler_name= -metadata:s:a:0 vendor_id= -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 17929216 -t 70.000000 -f opus
      PLAIN_MKV | convert flac | … -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 36557056 -t 70.000000 -f flac
      PLAIN_MKV | convert wav | … -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 pcm_f32le -max_muxing_queue_size 4096 -rf64 auto -fs 40047616 -t 70.000000 -f wav
      PLAIN_MKV | convert alac | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24 -max_muxing_queue_size 4096 -movflags +faststart -fs 37720576 -t 70.000000 -f ipod
      PLAIN_MKV | compress av1 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PLAIN_MKV | compress hevc | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=23,period=128 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -tag:v:0 hvc1 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PLAIN_MKV | compress h264 mp4 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PLAIN_MKV | compress h264 mkv kept | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      PLAIN_MKV | extract copy | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 44425216 -t 70.000000 -f ipod
      PLAIN_MKV | extract all mp3 | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 19657216 -t 70.000000 -f mp3
      PHONE_MOV | convert mp4 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -tag:v:0 hvc1 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mp4
      PHONE_MOV | convert mov | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -tag:v:0 hvc1 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mov
      PHONE_MOV | convert mkv | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -fs 1066777216 -t 70.000000 -f matroska
      PHONE_MOV | convert webm | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f webm
      PHONE_MOV | convert mkv re-encode | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      PHONE_MOV | convert mp3 | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 19657216 -t 70.000000 -f mp3
      PHONE_MOV | convert m4a | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 44425216 -t 70.000000 -f ipod
      PHONE_MOV | convert opus | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10 -metadata:s:a:0 handler_name= -metadata:s:a:0 vendor_id= -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 17929216 -t 70.000000 -f opus
      PHONE_MOV | convert flac | … -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 36557056 -t 70.000000 -f flac
      PHONE_MOV | convert wav | … -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 pcm_f32le -max_muxing_queue_size 4096 -rf64 auto -fs 40047616 -t 70.000000 -f wav
      PHONE_MOV | convert alac | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24 -max_muxing_queue_size 4096 -movflags +faststart -fs 37720576 -t 70.000000 -f ipod
      PHONE_MOV | compress av1 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PHONE_MOV | compress hevc | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=23,period=128 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -tag:v:0 hvc1 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PHONE_MOV | compress h264 mp4 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PHONE_MOV | compress h264 mkv kept | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      PHONE_MOV | extract copy | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 44425216 -t 70.000000 -f ipod
      PHONE_MOV | extract all mp3 | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 19657216 -t 70.000000 -f mp3
      PLAIN_MP4 | convert mp4 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mp4
      PLAIN_MP4 | convert mov | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mov
      PLAIN_MP4 | convert mkv | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 copy -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -fs 1066777216 -t 70.000000 -f matroska
      PLAIN_MP4 | convert webm | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f webm
      PLAIN_MP4 | convert mkv re-encode | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 copy -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      PLAIN_MP4 | convert mp3 | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 19657216 -t 70.000000 -f mp3
      PLAIN_MP4 | convert m4a | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 44425216 -t 70.000000 -f ipod
      PLAIN_MP4 | convert opus | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10 -metadata:s:a:0 handler_name= -metadata:s:a:0 vendor_id= -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 17929216 -t 70.000000 -f opus
      PLAIN_MP4 | convert flac | … -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 36557056 -t 70.000000 -f flac
      PLAIN_MP4 | convert wav | … -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 pcm_f32le -max_muxing_queue_size 4096 -rf64 auto -fs 40047616 -t 70.000000 -f wav
      PLAIN_MP4 | convert alac | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24 -max_muxing_queue_size 4096 -movflags +faststart -fs 37720576 -t 70.000000 -f ipod
      PLAIN_MP4 | compress av1 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PLAIN_MP4 | compress hevc | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=23,period=128 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -tag:v:0 hvc1 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PLAIN_MP4 | compress h264 mp4 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 aac -b:a:0 160k -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      PLAIN_MP4 | compress h264 mkv kept | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10 -disposition:a:0 +default-forced -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      PLAIN_MP4 | extract copy | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 44425216 -t 70.000000 -f ipod
      PLAIN_MP4 | extract all mp3 | … -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 19657216 -t 70.000000 -f mp3
      SILENT_MP4 | convert mp4 | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mp4
      SILENT_MP4 | convert mov | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -movflags +faststart -fs 1066777216 -t 70.000000 -f mov
      SILENT_MP4 | convert mkv | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 copy -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -fs 1066777216 -t 70.000000 -f matroska
      SILENT_MP4 | convert webm | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f webm
      SILENT_MP4 | convert mkv re-encode | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      SILENT_MP4 | compress av1 | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 libsvtav1 -preset:v:0 6 -crf:v:0 32 -pix_fmt:v:0 yuv420p10le -filter:v:0 format=yuv420p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      SILENT_MP4 | compress hevc | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 libkvazaar -kvazaar-params:v:0 preset=medium,qp=23,period=128 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -tag:v:0 hvc1 -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      SILENT_MP4 | compress h264 mp4 | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -max_muxing_queue_size 4096 -movflags +faststart -fs 980000000 -t 70.000000 -f mp4
      SILENT_MP4 | compress h264 mkv kept | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:v:0 libopenh264 -profile:v:0 high -coder:v:0 cabac -rc_mode:v:0 bitrate -b:v:0 4478976 -g:v:0 120 -pix_fmt:v:0 yuv420p -filter:v:0 format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv -max_muxing_queue_size 4096 -fs 4216777216 -t 70.000000 -f matroska
      FLAC | convert mp3 | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 19657216 -t 70.000000 -f mp3
      FLAC | convert m4a | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:a:0 aac -b:a:0 192k -max_muxing_queue_size 4096 -movflags +faststart -fs 18505216 -t 70.000000 -f ipod
      FLAC | convert opus | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10 -metadata:s:a:0 handler_name= -metadata:s:a:0 vendor_id= -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 17929216 -t 70.000000 -f opus
      FLAC | convert flac | … -map 0:0 -map_metadata 0 -map_chapters -1 -c:a:0 copy -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -fs 44425216 -t 70.000000 -f flac
      FLAC | convert wav | … -map 0:0 -map_metadata 0 -map_chapters -1 -c:a:0 pcm_s24le -max_muxing_queue_size 4096 -rf64 auto -fs 34230016 -t 70.000000 -f wav
      FLAC | convert alac | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24 -max_muxing_queue_size 4096 -movflags +faststart -fs 32484736 -t 70.000000 -f ipod
      FLAC_COVER | convert mp3 | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 libmp3lame -q:a:0 2 -c:v:0 copy -disposition:v:0 attached_pic -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -id3v2_version 3 -write_id3v1 0 -fs 22537216 -t 70.000000 -f mp3
      FLAC_COVER | convert m4a | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 aac -b:a:0 192k -c:v:0 copy -disposition:v:0 attached_pic -max_muxing_queue_size 4096 -movflags +faststart -fs 21385216 -t 70.000000 -f ipod
      FLAC_COVER | convert opus | … -map 0:0 -map_metadata 0 -map_chapters 0 -c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10 -metadata:s:a:0 handler_name= -metadata:s:a:0 vendor_id= -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -fs 17929216 -t 70.000000 -f opus
      FLAC_COVER | convert flac | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters -1 -c:a:0 copy -c:v:0 copy -disposition:v:0 attached_pic -metadata major_brand= -metadata minor_version= -metadata compatible_brands= -max_muxing_queue_size 4096 -avoid_negative_ts make_zero -fs 47305216 -t 70.000000 -f flac
      FLAC_COVER | convert wav | … -map 0:0 -map_metadata 0 -map_chapters -1 -c:a:0 pcm_s16le -max_muxing_queue_size 4096 -rf64 auto -fs 28412416 -t 70.000000 -f wav
      FLAC_COVER | convert alac | … -map 0:0 -map 0:1 -map_metadata 0 -map_chapters 0 -c:a:0 alac -sample_fmt:a:0 s16p -c:v:0 copy -disposition:v:0 attached_pic -max_muxing_queue_size 4096 -movflags +faststart -fs 30128896 -t 70.000000 -f ipod"
    `);
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "MULTI | convert mp4 | ready remux | mp4{video#0:copy audio#1:copy audio#2:copy subtitle#3:encode(mov_text) subtitle#4:encode(mov_text) subtitle#5:encode(mov_text) subtitle#6:drop(subtitle_dropped) cover#7:drop(cover_dropped)} cap=1066777216/output_cap_exceeded | subtitle_styling_lost[4]x1 subtitle_dropped[6]x1 cover_dropped[7]x1 attachment_dropped[]x2 mp4_default_subtitle_forced[3]x1
      MULTI | convert mov | ready remux | mov{video#0:copy audio#1:copy audio#2:copy subtitle#3:encode(mov_text) subtitle#4:encode(mov_text) subtitle#5:encode(mov_text) subtitle#6:drop(subtitle_dropped) cover#7:drop(cover_dropped)} cap=1066777216/output_cap_exceeded | subtitle_styling_lost[4]x1 subtitle_dropped[6]x1 cover_dropped[7]x1 attachment_dropped[]x2 mp4_default_subtitle_forced[3]x1
      MULTI | convert mkv | skipped remux | mkv{video#0:copy audio#1:copy audio#2:copy subtitle#3:copy subtitle#4:copy subtitle#5:copy subtitle#6:copy cover#7:drop(cover_dropped)} cap=1066777216/output_cap_exceeded | cover_dropped[7]x1
      MULTI | convert webm | ready | webm{video#0:encode(libsvtav1) audio#1:encode(libopus) audio#2:encode(libopus) subtitle#3:encode(webvtt) subtitle#4:encode(webvtt) subtitle#5:encode(webvtt) subtitle#6:drop(subtitle_dropped) cover#7:drop(cover_dropped)} cap=4216777216/output_cap_exceeded | subtitle_styling_lost[4]x1 subtitle_dropped[6]x1 cover_dropped[7]x1 attachment_dropped[]x2
      MULTI | convert mkv re-encode | ready | mkv{video#0:encode(libsvtav1) audio#1:copy audio#2:copy subtitle#3:copy subtitle#4:copy subtitle#5:copy subtitle#6:copy cover#7:drop(cover_dropped)} cap=4216777216/output_cap_exceeded | cover_dropped[7]x1
      MULTI | convert mp3 | ready | mp3{audio#1:encode(libmp3lame) cover#7:copy} cap=22537216/output_cap_exceeded | 
      MULTI | convert m4a | ready remux | m4a{audio#1:copy cover#7:copy} cap=47305216/output_cap_exceeded | 
      MULTI | convert opus | ready | opus{audio#1:encode(libopus) cover#7:drop(cover_dropped)} cap=17929216/output_cap_exceeded | cover_dropped[7]x1
      MULTI | convert flac | ready confirm:lossy_to_lossless | flac{audio#1:encode(flac) cover#7:copy} cap=39437056/output_cap_exceeded | chapters_dropped[]x3
      MULTI | convert wav | ready confirm:lossy_to_lossless | wav{audio#1:encode(pcm_f32le) cover#7:drop(cover_dropped)} cap=40047616/output_cap_exceeded | cover_dropped[7]x1 chapters_dropped[]x3
      MULTI | convert alac | ready confirm:lossy_to_lossless | m4a{audio#1:encode(alac) cover#7:copy} cap=40600576/output_cap_exceeded | 
      MULTI | compress av1 | ready | mkv{video#0:encode(libsvtav1) audio#1:encode(libopus) audio#2:encode(libopus) subtitle#3:copy subtitle#4:copy subtitle#5:copy subtitle#6:copy cover#7:drop(cover_dropped)} cap=980000000/not_smaller | cover_dropped[7]x1
      MULTI | compress hevc | ready | mkv{video#0:encode(libkvazaar) audio#1:encode(libopus) audio#2:encode(libopus) subtitle#3:copy subtitle#4:copy subtitle#5:copy subtitle#6:copy cover#7:drop(cover_dropped)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1 cover_dropped[7]x1
      MULTI | compress h264 mp4 | ready | mp4{video#0:encode(libopenh264) audio#1:encode(aac) audio#2:encode(aac) subtitle#3:encode(mov_text) subtitle#4:encode(mov_text) subtitle#5:encode(mov_text) subtitle#6:drop(subtitle_dropped) cover#7:drop(cover_dropped)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1 subtitle_styling_lost[4]x1 subtitle_dropped[6]x1 cover_dropped[7]x1 attachment_dropped[]x2 mp4_default_subtitle_forced[3]x1
      MULTI | compress h264 mkv kept | ready | mkv{video#0:encode(libopenh264) audio#1:encode(libopus) audio#2:encode(libopus) subtitle#3:copy subtitle#4:copy subtitle#5:copy subtitle#6:copy cover#7:drop(cover_dropped)} cap=4216777216/output_cap_exceeded | cpu_weak_encoder[0]x1 cover_dropped[7]x1
      MULTI | extract copy | ready remux | m4a{audio#1:copy cover#7:copy} cap=47305216/output_cap_exceeded | 
      MULTI | extract all mp3 | ready | mp3{audio#1:encode(libmp3lame) cover#7:copy} cap=22537216/output_cap_exceeded + mp3{audio#2:encode(libmp3lame) cover#7:copy} cap=22537216/output_cap_exceeded | downmixed_to_stereo[2]x1
      PLAIN_MKV | convert mp4 | ready remux | mp4{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PLAIN_MKV | convert mov | ready remux | mov{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PLAIN_MKV | convert mkv | skipped remux | mkv{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PLAIN_MKV | convert webm | ready | webm{video#0:encode(libsvtav1) audio#1:encode(libopus)} cap=4216777216/output_cap_exceeded | 
      PLAIN_MKV | convert mkv re-encode | ready | mkv{video#0:encode(libsvtav1) audio#1:copy} cap=4216777216/output_cap_exceeded | 
      PLAIN_MKV | convert mp3 | ready | mp3{audio#1:encode(libmp3lame)} cap=19657216/output_cap_exceeded | 
      PLAIN_MKV | convert m4a | ready remux | m4a{audio#1:copy} cap=44425216/output_cap_exceeded | 
      PLAIN_MKV | convert opus | ready | opus{audio#1:encode(libopus)} cap=17929216/output_cap_exceeded | 
      PLAIN_MKV | convert flac | ready confirm:lossy_to_lossless | flac{audio#1:encode(flac)} cap=36557056/output_cap_exceeded | 
      PLAIN_MKV | convert wav | ready confirm:lossy_to_lossless | wav{audio#1:encode(pcm_f32le)} cap=40047616/output_cap_exceeded | 
      PLAIN_MKV | convert alac | ready confirm:lossy_to_lossless | m4a{audio#1:encode(alac)} cap=37720576/output_cap_exceeded | 
      PLAIN_MKV | compress av1 | ready | mp4{video#0:encode(libsvtav1) audio#1:encode(aac)} cap=980000000/not_smaller | 
      PLAIN_MKV | compress hevc | ready | mp4{video#0:encode(libkvazaar) audio#1:encode(aac)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      PLAIN_MKV | compress h264 mp4 | ready | mp4{video#0:encode(libopenh264) audio#1:encode(aac)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      PLAIN_MKV | compress h264 mkv kept | ready | mkv{video#0:encode(libopenh264) audio#1:encode(libopus)} cap=4216777216/output_cap_exceeded | cpu_weak_encoder[0]x1
      PLAIN_MKV | extract copy | ready remux | m4a{audio#1:copy} cap=44425216/output_cap_exceeded | 
      PLAIN_MKV | extract all mp3 | ready | mp3{audio#1:encode(libmp3lame)} cap=19657216/output_cap_exceeded | 
      PHONE_MOV | convert mp4 | ready remux | mp4{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PHONE_MOV | convert mov | skipped remux | mov{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PHONE_MOV | convert mkv | ready remux | mkv{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PHONE_MOV | convert webm | ready | webm{video#0:encode(libsvtav1) audio#1:encode(libopus)} cap=4216777216/output_cap_exceeded | 
      PHONE_MOV | convert mkv re-encode | ready | mkv{video#0:encode(libsvtav1) audio#1:copy} cap=4216777216/output_cap_exceeded | 
      PHONE_MOV | convert mp3 | ready | mp3{audio#1:encode(libmp3lame)} cap=19657216/output_cap_exceeded | 
      PHONE_MOV | convert m4a | ready remux | m4a{audio#1:copy} cap=44425216/output_cap_exceeded | 
      PHONE_MOV | convert opus | ready | opus{audio#1:encode(libopus)} cap=17929216/output_cap_exceeded | 
      PHONE_MOV | convert flac | ready confirm:lossy_to_lossless | flac{audio#1:encode(flac)} cap=36557056/output_cap_exceeded | 
      PHONE_MOV | convert wav | ready confirm:lossy_to_lossless | wav{audio#1:encode(pcm_f32le)} cap=40047616/output_cap_exceeded | 
      PHONE_MOV | convert alac | ready confirm:lossy_to_lossless | m4a{audio#1:encode(alac)} cap=37720576/output_cap_exceeded | 
      PHONE_MOV | compress av1 | ready | mp4{video#0:encode(libsvtav1) audio#1:encode(aac)} cap=980000000/not_smaller | 
      PHONE_MOV | compress hevc | ready | mp4{video#0:encode(libkvazaar) audio#1:encode(aac)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      PHONE_MOV | compress h264 mp4 | ready | mp4{video#0:encode(libopenh264) audio#1:encode(aac)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      PHONE_MOV | compress h264 mkv kept | ready | mkv{video#0:encode(libopenh264) audio#1:encode(libopus)} cap=4216777216/output_cap_exceeded | cpu_weak_encoder[0]x1
      PHONE_MOV | extract copy | ready remux | m4a{audio#1:copy} cap=44425216/output_cap_exceeded | 
      PHONE_MOV | extract all mp3 | ready | mp3{audio#1:encode(libmp3lame)} cap=19657216/output_cap_exceeded | 
      PLAIN_MP4 | convert mp4 | skipped remux | mp4{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PLAIN_MP4 | convert mov | ready remux | mov{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PLAIN_MP4 | convert mkv | ready remux | mkv{video#0:copy audio#1:copy} cap=1066777216/output_cap_exceeded | 
      PLAIN_MP4 | convert webm | ready | webm{video#0:encode(libsvtav1) audio#1:encode(libopus)} cap=4216777216/output_cap_exceeded | 
      PLAIN_MP4 | convert mkv re-encode | ready | mkv{video#0:encode(libsvtav1) audio#1:copy} cap=4216777216/output_cap_exceeded | 
      PLAIN_MP4 | convert mp3 | ready | mp3{audio#1:encode(libmp3lame)} cap=19657216/output_cap_exceeded | 
      PLAIN_MP4 | convert m4a | ready remux | m4a{audio#1:copy} cap=44425216/output_cap_exceeded | 
      PLAIN_MP4 | convert opus | ready | opus{audio#1:encode(libopus)} cap=17929216/output_cap_exceeded | 
      PLAIN_MP4 | convert flac | ready confirm:lossy_to_lossless | flac{audio#1:encode(flac)} cap=36557056/output_cap_exceeded | 
      PLAIN_MP4 | convert wav | ready confirm:lossy_to_lossless | wav{audio#1:encode(pcm_f32le)} cap=40047616/output_cap_exceeded | 
      PLAIN_MP4 | convert alac | ready confirm:lossy_to_lossless | m4a{audio#1:encode(alac)} cap=37720576/output_cap_exceeded | 
      PLAIN_MP4 | compress av1 | ready | mp4{video#0:encode(libsvtav1) audio#1:encode(aac)} cap=980000000/not_smaller | 
      PLAIN_MP4 | compress hevc | ready | mp4{video#0:encode(libkvazaar) audio#1:encode(aac)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      PLAIN_MP4 | compress h264 mp4 | ready | mp4{video#0:encode(libopenh264) audio#1:encode(aac)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      PLAIN_MP4 | compress h264 mkv kept | ready | mkv{video#0:encode(libopenh264) audio#1:encode(libopus)} cap=4216777216/output_cap_exceeded | cpu_weak_encoder[0]x1
      PLAIN_MP4 | extract copy | ready remux | m4a{audio#1:copy} cap=44425216/output_cap_exceeded | 
      PLAIN_MP4 | extract all mp3 | ready | mp3{audio#1:encode(libmp3lame)} cap=19657216/output_cap_exceeded | 
      SILENT_MP4 | convert mp4 | skipped remux | mp4{video#0:copy} cap=1066777216/output_cap_exceeded | 
      SILENT_MP4 | convert mov | ready remux | mov{video#0:copy} cap=1066777216/output_cap_exceeded | 
      SILENT_MP4 | convert mkv | ready remux | mkv{video#0:copy} cap=1066777216/output_cap_exceeded | 
      SILENT_MP4 | convert webm | ready | webm{video#0:encode(libsvtav1)} cap=4216777216/output_cap_exceeded | 
      SILENT_MP4 | convert mkv re-encode | ready | mkv{video#0:encode(libsvtav1)} cap=4216777216/output_cap_exceeded | 
      SILENT_MP4 | convert mp3 | not_applicable:no_audio_stream
      SILENT_MP4 | convert m4a | not_applicable:no_audio_stream
      SILENT_MP4 | convert opus | not_applicable:no_audio_stream
      SILENT_MP4 | convert flac | not_applicable:no_audio_stream
      SILENT_MP4 | convert wav | not_applicable:no_audio_stream
      SILENT_MP4 | convert alac | not_applicable:no_audio_stream
      SILENT_MP4 | compress av1 | ready | mp4{video#0:encode(libsvtav1)} cap=980000000/not_smaller | 
      SILENT_MP4 | compress hevc | ready | mp4{video#0:encode(libkvazaar)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      SILENT_MP4 | compress h264 mp4 | ready | mp4{video#0:encode(libopenh264)} cap=980000000/not_smaller | cpu_weak_encoder[0]x1
      SILENT_MP4 | compress h264 mkv kept | ready | mkv{video#0:encode(libopenh264)} cap=4216777216/output_cap_exceeded | cpu_weak_encoder[0]x1
      SILENT_MP4 | extract copy | not_applicable:no_audio_stream
      SILENT_MP4 | extract all mp3 | not_applicable:no_audio_stream
      FLAC | convert mp4 | not_applicable:no_video_stream
      FLAC | convert mov | not_applicable:no_video_stream
      FLAC | convert mkv | not_applicable:no_video_stream
      FLAC | convert webm | not_applicable:no_video_stream
      FLAC | convert mkv re-encode | not_applicable:no_video_stream
      FLAC | convert mp3 | ready | mp3{audio#0:encode(libmp3lame)} cap=19657216/output_cap_exceeded | 
      FLAC | convert m4a | ready | m4a{audio#0:encode(aac)} cap=18505216/output_cap_exceeded | 
      FLAC | convert opus | ready | opus{audio#0:encode(libopus)} cap=17929216/output_cap_exceeded | 
      FLAC | convert flac | skipped remux | flac{audio#0:copy} cap=44425216/output_cap_exceeded | 
      FLAC | convert wav | ready | wav{audio#0:encode(pcm_s24le)} cap=34230016/output_cap_exceeded | 
      FLAC | convert alac | ready | m4a{audio#0:encode(alac)} cap=32484736/output_cap_exceeded | 
      FLAC | compress av1 | not_applicable:task_not_applicable
      FLAC | compress hevc | not_applicable:task_not_applicable
      FLAC | compress h264 mp4 | not_applicable:task_not_applicable
      FLAC | compress h264 mkv kept | not_applicable:task_not_applicable
      FLAC | extract copy | not_applicable:task_not_applicable
      FLAC | extract all mp3 | not_applicable:task_not_applicable
      FLAC_COVER | convert mp4 | not_applicable:no_video_stream
      FLAC_COVER | convert mov | not_applicable:no_video_stream
      FLAC_COVER | convert mkv | not_applicable:no_video_stream
      FLAC_COVER | convert webm | not_applicable:no_video_stream
      FLAC_COVER | convert mkv re-encode | not_applicable:no_video_stream
      FLAC_COVER | convert mp3 | ready | mp3{audio#0:encode(libmp3lame) cover#1:copy} cap=22537216/output_cap_exceeded | 
      FLAC_COVER | convert m4a | ready | m4a{audio#0:encode(aac) cover#1:copy} cap=21385216/output_cap_exceeded | 
      FLAC_COVER | convert opus | ready | opus{audio#0:encode(libopus) cover#1:drop(cover_dropped)} cap=17929216/output_cap_exceeded | cover_dropped[1]x1
      FLAC_COVER | convert flac | skipped remux | flac{audio#0:copy cover#1:copy} cap=47305216/output_cap_exceeded | chapters_dropped[]x2
      FLAC_COVER | convert wav | ready | wav{audio#0:encode(pcm_s16le) cover#1:drop(cover_dropped)} cap=28412416/output_cap_exceeded | cover_dropped[1]x1 chapters_dropped[]x2
      FLAC_COVER | convert alac | ready | m4a{audio#0:encode(alac) cover#1:copy} cap=30128896/output_cap_exceeded | 
      FLAC_COVER | compress av1 | not_applicable:task_not_applicable
      FLAC_COVER | compress hevc | not_applicable:task_not_applicable
      FLAC_COVER | compress h264 mp4 | not_applicable:task_not_applicable
      FLAC_COVER | compress h264 mkv kept | not_applicable:task_not_applicable
      FLAC_COVER | extract copy | not_applicable:task_not_applicable
      FLAC_COVER | extract all mp3 | not_applicable:task_not_applicable"
    `);
  });
});
