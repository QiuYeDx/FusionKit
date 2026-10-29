import { describe, expect, it } from 'vitest';
import {
  AUDIO_FORMATS, PLAN_LOSS_CODES, defaultCompressSettings, mediaInfoSchema, planSummarySchema,
  type AudioFormat, type AudioStreamInfo, type ConversionSettings, type CoverStreamInfo, type MediaInfo, type Tier, type VideoStreamInfo,
} from '../../../src/media-converter/contract';
import { buildPlan } from '../../../electron/main/media-converter/plan/stream-plan';
import { toFfmpegArgs, type FfmpegIo } from '../../../electron/main/media-converter/plan/args';
import {
  AUDIO_TABLE, LAYOUT_SYNONYMS, STANDARD_LAYOUTS, alacChannels, alacLayout, formatBitRate, inVideoBitRate, isLosslessAudio, layoutFilters, matroskaTakesAudio,
  nominalFormatBitRate, parseAudioParameters, pcmEncoder, sampleRateFilters, sourceDepth,
} from '../../../electron/main/media-converter/plan/audio';
import { OUTPUT_CONTAINER_SPECS } from '../../../electron/main/media-converter/plan/matrix';
import type { ConversionPlan, PlanOutcome, PlannedOutput, PlannerCapabilities } from '../../../electron/main/media-converter/plan/types';

/**
 * V-ENCODE-04-1: audio as pure functions (module-encode design §5, R-ENCODE-04/05): the audio
 * format tables at every tier (mono included), the extraction types (big-endian PCM, Blu-ray PCM),
 * "all tracks" and its languages, the layouts each encoder is given (Opus 2.1, 5.0(side),
 * 5.1(side), 7.1(wide), 10 channels), MP3 downmixing, sample rates, one filter chain per track,
 * the lossy-to-lossless confirmation, the same-codec copy, the passthrough of audio inside a video
 * for "convert" and "compress" (the rate read from the stream, else the BPS tag) and the bit rates
 * of its re-encode, bit depths, covers, chapters and tags. Everything goes through `buildPlan` and
 * `toFfmpegArgs` as the engine calls them; the tables are also checked against design §5.
 */

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const MINUTE_US = 60_000_000;
const MIB16 = 16 * 1024 * 1024;
const SOXR = 'aresample=resampler=soxr:precision=28:osr=48000';

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
const surround = (layout: string, channels: number) => ({ channels, channelLayout: layout });
const cover = (index: number, typeIndex: number, codec = 'png'): CoverStreamInfo => ({ index, typeIndex, codec, width: 500, height: 500 });

const CONTAINERS = {
  mkv: { demuxer: 'matroska', formatName: 'matroska,webm', majorBrand: null, matroskaDocType: 'matroska', extension: 'mkv', identity: 'matroska' },
  mp4: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', matroskaDocType: null, extension: 'mp4', identity: 'mp4' },
  mov: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'qt', matroskaDocType: null, extension: 'mov', identity: 'mov' },
  m4a: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'M4A', matroskaDocType: null, extension: 'm4a', identity: 'm4a' },
  flac: { demuxer: 'flac', formatName: 'flac', majorBrand: null, matroskaDocType: null, extension: 'flac', identity: 'flac' },
  mp3: { demuxer: 'mp3', formatName: 'mp3', majorBrand: null, matroskaDocType: null, extension: 'mp3', identity: 'mp3' },
  ogg: { demuxer: 'ogg', formatName: 'ogg', majorBrand: null, matroskaDocType: null, extension: 'ogg', identity: 'ogg' },
  opus: { demuxer: 'ogg', formatName: 'ogg', majorBrand: null, matroskaDocType: null, extension: 'opus', identity: 'opus' },
  wav: { demuxer: 'wav', formatName: 'wav', majorBrand: null, matroskaDocType: null, extension: 'wav', identity: 'wav' },
  aiff: { demuxer: 'aiff', formatName: 'aiff', majorBrand: null, matroskaDocType: null, extension: 'aiff', identity: 'aiff' },
} as const;

type MediaParts = Partial<Omit<MediaInfo, 'container'>> & { container?: keyof typeof CONTAINERS };
/** A schema-checked `MediaInfo`: a video file when it has a video stream, else an audio file. */
function media(parts: MediaParts): MediaInfo {
  const { container = 'mkv', ...rest } = parts;
  const streams = { video: [], audio: [], subtitles: [], covers: [], ...rest };
  const primary = streams.video.find(stream => stream.avgFrameRate !== null);
  return mediaInfoSchema.parse({
    kind: primary ? 'video' : 'audio', container: CONTAINERS[container], sizeBytes: 1_000_000_000, durationUs: MINUTE_US, durationSource: 'format',
    startTimeUs: 0, bitRate: 133_333_333, primaryVideoIndex: primary?.index ?? null, attachments: 0, chapters: 0, dataStreams: 0, ...streams,
  });
}
/** An audio file of one track. */
const track = (container: keyof typeof CONTAINERS, codec: string, extra: Partial<AudioStreamInfo> = {}, parts: MediaParts = {}) =>
  media({ container, audio: [audio(0, 0, codec, { default: true, ...extra })], ...parts });
/** A Matroska video with these audio tracks after its video stream. */
const film = (...tracks: [codec: string, extra?: Partial<AudioStreamInfo>][]) =>
  media({ video: [video(0, 0)], audio: tracks.map(([codec, extra], i) => audio(i + 1, i, codec, extra)) });

const CAPS: PlannerCapabilities = { encoders: {}, degraded: [], nvencMin: { width: 144, height: 120 } };
const IO: FfmpegIo = { inputPath: 'C:\\media\\input', demuxer: 'matroska', partialPath: 'D:\\out\\.fusionkit-media-00000001.partial' };

const convert = (target: Extract<ConversionSettings, { task: 'convert' }>['target'], tier: Tier = 'balanced'): ConversionSettings =>
  ({ task: 'convert', target, preferRemux: true, tier });
const compress = (container: 'mp4' | 'mkv', tier: Tier = 'balanced'): ConversionSettings => ({ ...defaultCompressSettings('h264'), container, tier });
const extract = (format: 'copy' | AudioFormat = 'copy', allTracks = false, tier: Tier = 'balanced'): ConversionSettings =>
  ({ task: 'extract-audio', format, tier, allTracks });

function planOf(outcome: PlanOutcome): ConversionPlan {
  if (outcome.status !== 'ready' && outcome.status !== 'skipped') throw new Error(`no plan: ${outcome.status} ${outcome.reason}`);
  expect(planSummarySchema.parse(outcome.plan.summary)).toEqual(outcome.plan.summary);
  return outcome.plan;
}
const plan = (value: MediaInfo, settings: ConversionSettings) => planOf(buildPlan(value, settings, CAPS));
const argsOf = (output: PlannedOutput) => toFfmpegArgs(output, IO);
/** The codec options of output audio track `n`, in order: `-c:a:n`, its encoder options and its `-filter:a:n`. */
function trackArgs(output: PlannedOutput, n = 0): string {
  const args = argsOf(output);
  const own: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (/^-(?!disposition|metadata)[\w]+:a:\d+$/.test(args[i]) && args[i].endsWith(`:a:${n}`)) own.push(args[i], args[i + 1]);
  }
  return own.join(' ');
}
const decisionOf = (output: PlannedOutput, index: number) => output.streams.find(decision => decision.source.index === index)!;
const actionOf = (output: PlannedOutput, index: number) => {
  const decision = decisionOf(output, index);
  return decision.action === 'encode' ? `encode(${decision.encode.encoder})` : decision.action;
};
const warningsOf = (value: ConversionPlan) => value.summary.warnings.map(item => `${item.code}[${item.streams.join(',')}]`);
const valueAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

// ── Tables ─────────────────────────────────────────────────────────────────────────────────────

describe('the audio tables (design §5)', () => {
  it('hold the values of design §5 and AC-ENCODE-04-1', () => {
    expect(AUDIO_TABLE.parameters).toEqual({
      mp3: '-q:a {V}', m4a: '-b:a {B}', opus: '-b:a {B} -vbr on -compression_level 10', flac: '-compression_level {L}',
    });
    expect(AUDIO_TABLE.mp3Quality).toEqual([0, 2, 5]);
    expect(AUDIO_TABLE.m4a).toEqual({ stereo: [256, 192, 128], mono: [128, 96, 64] });
    expect(AUDIO_TABLE.opus).toEqual({ stereo: [160, 128, 96], mono: [96, 64, 48] });
    expect(AUDIO_TABLE.flacLevel).toEqual([5, 5, 8]);
    expect(AUDIO_TABLE.inVideo).toEqual({
      aac: { stereo: [192, 160, 128], surround: [384, 320, 256] }, libopus: { stereo: [128, 96, 80], surround: [320, 256, 192] },
    });
    expect(AUDIO_TABLE.compressCopyRatio).toBe(1.25);
    expect(AUDIO_TABLE.downsample).toBe(SOXR);
    expect(Object.isFrozen(AUDIO_TABLE.inVideo.aac.stereo)).toBe(true);
    // The containers of design §5: muxer, extension, ID3v2.3 without ID3v1, RF64 past 4 GiB.
    const spec = (id: keyof typeof OUTPUT_CONTAINER_SPECS) => [OUTPUT_CONTAINER_SPECS[id].muxer, OUTPUT_CONTAINER_SPECS[id].extension, OUTPUT_CONTAINER_SPECS[id].options];
    expect(spec('mp3')).toEqual(['mp3', 'mp3', [['id3v2_version', '3'], ['write_id3v1', '0']]]);
    expect(spec('m4a')).toEqual(['ipod', 'm4a', []]);
    expect(spec('opus')).toEqual(['opus', 'opus', []]);
    expect(spec('flac')).toEqual(['flac', 'flac', []]);
    expect(spec('wav')).toEqual(['wav', 'wav', [['rf64', 'auto']]]);
  });

  it('parse their option text strictly', () => {
    expect(parseAudioParameters('-b:a {B} -vbr on -compression_level 10')).toEqual([['b', '{B}'], ['vbr', 'on'], ['compression_level', '10']]);
    expect(() => parseAudioParameters('-b:a')).toThrow(/Unpaired/);
    expect(() => parseAudioParameters('-b:v 1M')).toThrow(/Malformed/);
    expect(() => parseAudioParameters('-vbr -on')).toThrow(/Malformed/);
  });

  it('give every format its arguments at each tier, from stereo and from mono (AC-ENCODE-04-1)', () => {
    // 24-bit big-endian PCM at 48 kHz: no format holds it as it is, so every one encodes.
    const lines: string[] = [];
    for (const layout of ['stereo', 'mono'] as const) {
      const source = track('aiff', 'pcm_s24be', { channels: layout === 'mono' ? 1 : 2, channelLayout: layout, sampleFormat: 's32', bitsPerRawSample: 24 });
      for (const format of AUDIO_FORMATS) {
        for (const tier of ['quality', 'balanced', 'size'] as const) {
          const output = plan(source, convert(format, tier)).outputs[0];
          lines.push(`${format} ${tier} ${layout}: ${output.container.muxer} .${output.container.extension} | ${trackArgs(output)}`);
        }
      }
    }
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "mp3 quality stereo: mp3 .mp3 | -c:a:0 libmp3lame -q:a:0 0
      mp3 balanced stereo: mp3 .mp3 | -c:a:0 libmp3lame -q:a:0 2
      mp3 size stereo: mp3 .mp3 | -c:a:0 libmp3lame -q:a:0 5
      m4a quality stereo: ipod .m4a | -c:a:0 aac -b:a:0 256k
      m4a balanced stereo: ipod .m4a | -c:a:0 aac -b:a:0 192k
      m4a size stereo: ipod .m4a | -c:a:0 aac -b:a:0 128k
      opus quality stereo: opus .opus | -c:a:0 libopus -b:a:0 160k -vbr:a:0 on -compression_level:a:0 10
      opus balanced stereo: opus .opus | -c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10
      opus size stereo: opus .opus | -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10
      flac quality stereo: flac .flac | -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24
      flac balanced stereo: flac .flac | -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24
      flac size stereo: flac .flac | -c:a:0 flac -compression_level:a:0 8 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24
      wav quality stereo: wav .wav | -c:a:0 pcm_s24le
      wav balanced stereo: wav .wav | -c:a:0 pcm_s24le
      wav size stereo: wav .wav | -c:a:0 pcm_s24le
      alac quality stereo: ipod .m4a | -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24
      alac balanced stereo: ipod .m4a | -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24
      alac size stereo: ipod .m4a | -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24
      mp3 quality mono: mp3 .mp3 | -c:a:0 libmp3lame -q:a:0 0
      mp3 balanced mono: mp3 .mp3 | -c:a:0 libmp3lame -q:a:0 2
      mp3 size mono: mp3 .mp3 | -c:a:0 libmp3lame -q:a:0 5
      m4a quality mono: ipod .m4a | -c:a:0 aac -b:a:0 128k
      m4a balanced mono: ipod .m4a | -c:a:0 aac -b:a:0 96k
      m4a size mono: ipod .m4a | -c:a:0 aac -b:a:0 64k
      opus quality mono: opus .opus | -c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10
      opus balanced mono: opus .opus | -c:a:0 libopus -b:a:0 64k -vbr:a:0 on -compression_level:a:0 10
      opus size mono: opus .opus | -c:a:0 libopus -b:a:0 48k -vbr:a:0 on -compression_level:a:0 10
      flac quality mono: flac .flac | -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24
      flac balanced mono: flac .flac | -c:a:0 flac -compression_level:a:0 5 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24
      flac size mono: flac .flac | -c:a:0 flac -compression_level:a:0 8 -sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24
      wav quality mono: wav .wav | -c:a:0 pcm_s24le
      wav balanced mono: wav .wav | -c:a:0 pcm_s24le
      wav size mono: wav .wav | -c:a:0 pcm_s24le
      alac quality mono: ipod .m4a | -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24
      alac balanced mono: ipod .m4a | -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24
      alac size mono: ipod .m4a | -c:a:0 alac -sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24"
    `);
  });

  it('scale the format rates per pair of channels above two, and halve nothing for MP3 (VBR quality)', () => {
    expect(formatBitRate('m4a', 'quality', 6)).toBe(768);
    expect(formatBitRate('opus', 'balanced', 6)).toBe(384);
    expect(formatBitRate('opus', 'size', 3)).toBe(144);
    expect(formatBitRate('opus', 'size', 1)).toBe(48);
    expect(formatBitRate('m4a', 'balanced', null)).toBe(192);
    // More than 8 channels are mixed down to 7.1 first.
    expect(formatBitRate('opus', 'quality', 10)).toBe(640);
    const sixChannels = track('wav', 'pcm_s16le', { ...surround('5.1', 6), sampleFormat: 's16', bitsPerRawSample: 16 });
    expect(trackArgs(plan(sixChannels, convert('m4a', 'quality')).outputs[0])).toBe('-c:a:0 aac -b:a:0 768k');
    expect(trackArgs(plan(sixChannels, convert('mp3', 'quality')).outputs[0])).toBe('-c:a:0 libmp3lame -q:a:0 0 -ac:a:0 2');
  });
});

// ── Extraction ─────────────────────────────────────────────────────────────────────────────────

describe('extracting audio as it is (AC-ENCODE-04-2)', () => {
  const s32 = (bits: number) => ({ sampleFormat: 's32', bitsPerRawSample: bits });
  it.each([
    ['aac', {}, 'm4a', 'copy'], ['alac', s32(24), 'm4a', 'copy'], ['mp3', {}, 'mp3', 'copy'], ['opus', {}, 'opus', 'copy'], ['vorbis', {}, 'ogg', 'copy'],
    ['flac', s32(24), 'flac', 'copy'],
    ['pcm_u8', { sampleFormat: 'u8' }, 'wav', 'copy'], ['pcm_s16le', { sampleFormat: 's16' }, 'wav', 'copy'], ['pcm_s24le', s32(24), 'wav', 'copy'],
    ['pcm_s32le', s32(32), 'wav', 'copy'], ['pcm_f32le', { sampleFormat: 'flt' }, 'wav', 'copy'], ['pcm_f64le', { sampleFormat: 'dbl' }, 'wav', 'copy'],
    ['pcm_alaw', { sampleFormat: 's16' }, 'wav', 'copy'], ['pcm_mulaw', { sampleFormat: 's16' }, 'wav', 'copy'],
    ['pcm_s16be', { sampleFormat: 's16' }, 'aiff', 'copy'], ['pcm_s24be', s32(24), 'aiff', 'copy'], ['pcm_s32be', s32(32), 'aiff', 'copy'],
    ['pcm_f32be', { sampleFormat: 'flt' }, 'aiff', 'copy'], ['pcm_f64be', { sampleFormat: 'dbl' }, 'aiff', 'copy'],
    ['pcm_bluray', s32(24), 'wav', 'encode(pcm_s24le)'], ['pcm_bluray', { sampleFormat: 's16', bitsPerRawSample: 16 }, 'wav', 'encode(pcm_s16le)'],
    ['pcm_dvd', s32(20), 'wav', 'encode(pcm_s24le)'], ['pcm_s16be_planar', { sampleFormat: 's16p' }, 'wav', 'encode(pcm_s16le)'],
    ['pcm_s8', { sampleFormat: 'u8' }, 'wav', 'encode(pcm_s16le)'], ['s302m', s32(24), 'wav', 'encode(pcm_s24le)'],
    // Matroska refuses QuickTime IMA ADPCM and Nellymoser: decoded into WAV rather than fail in .mka.
    ['adpcm_ima_qt', { sampleFormat: 's16p' }, 'wav', 'encode(pcm_s16le)'], ['nellymoser', {}, 'wav', 'encode(pcm_f32le)'], ['mp2', {}, 'mka', 'copy'],
    ['amr_nb', { sampleFormat: 'flt', channels: 1, channelLayout: 'mono' }, 'mka', 'copy'],
    ['ac3', {}, 'mka', 'copy'], ['eac3', {}, 'mka', 'copy'], ['dts', { profile: 'DTS-HD MA' }, 'mka', 'copy'], ['truehd', s32(24), 'mka', 'copy'],
  ] as const)('%s → .%s', (codec, extra, container, action) => {
    const value = film([codec, { default: true, ...extra }]);
    const result = plan(value, extract());
    const output = result.outputs[0];
    expect(output.container).toMatchObject({ id: container, extension: container });
    expect(actionOf(output, 1)).toBe(action);
    expect(trackArgs(output)).toBe(action === 'copy' ? '-c:a:0 copy' : `-c:a:0 ${action.slice(7, -1)}`);
    // Lossless either way: nothing to confirm; Blu-ray and DVD PCM show as an encode in the summary.
    expect(result.summary.confirmations).toEqual([]);
    expect(result.summary.outputs[0].streams.find(item => item.index === 1)).toMatchObject({ action: action === 'copy' ? 'copy' : 'encode' });
    expect(result.isRemuxOnly).toBe(action === 'copy');
  });

  it('takes the default track, else the first, and every track as its own numbered output with "all tracks"', () => {
    const value = media({
      video: [video(0, 0)],
      audio: [
        audio(1, 0, 'aac', { language: 'eng' }), audio(2, 1, 'ac3', { language: 'en-us', ...surround('5.1(side)', 6), default: true }),
        audio(3, 2, 'flac', { language: 'jpn', sampleFormat: 's16' }), audio(4, 3, 'opus', { language: 'EN' }), audio(5, 4, 'mp3', { language: 'chi' }),
      ],
    });
    const single = plan(value, extract());
    expect(single.outputs).toHaveLength(1);
    expect(single.outputs[0].container).toMatchObject({ id: 'mka', baseName: { rule: 'source' } });
    expect(plan(film(['opus'], ['aac']), extract()).outputs[0].container.id).toBe('opus');

    const all = plan(value, extract('copy', true));
    expect(all.outputs.map(output => [output.container.id, output.container.baseName])).toEqual([
      ['m4a', { rule: 'track', number: 1, language: 'eng' }], ['mka', { rule: 'track', number: 2, language: null }],
      ['flac', { rule: 'track', number: 3, language: 'jpn' }], ['opus', { rule: 'track', number: 4, language: null }],
      ['mp3', { rule: 'track', number: 5, language: 'chi' }],
    ]);
    expect(all.summary.outputs.map(output => output.track?.language ?? null)).toEqual(['eng', null, 'jpn', null, 'chi']);
    // Each output maps its own track and nothing else.
    for (const [i, output] of all.outputs.entries()) {
      const args = argsOf(output);
      expect(args.flatMap((arg, at) => arg === '-map' ? [args[at + 1]] : [])).toEqual([`0:${i + 1}`]);
    }

    // Another format: every track encoded on its own, the 5.1 one mixed down and said so for it only.
    const mp3 = plan(value, extract('mp3', true));
    expect(mp3.outputs.map(output => [output.container.id, actionOf(output, output.container.baseName.rule === 'track' ? output.container.baseName.number : 0)]))
      .toEqual([['mp3', 'encode(libmp3lame)'], ['mp3', 'encode(libmp3lame)'], ['mp3', 'encode(libmp3lame)'], ['mp3', 'encode(libmp3lame)'], ['mp3', 'copy']]);
    expect(trackArgs(mp3.outputs[1])).toBe('-c:a:0 libmp3lame -q:a:0 2 -ac:a:0 2');
    expect(trackArgs(mp3.outputs[0])).toBe('-c:a:0 libmp3lame -q:a:0 2');
    expect(warningsOf(mp3)).toEqual(['downmixed_to_stereo[2]']);
    // Any of the six formats can be chosen instead of "as it is".
    for (const format of AUDIO_FORMATS) expect(plan(value, extract(format)).outputs[0].container.extension).toBe(format === 'alac' ? 'm4a' : format);
  });
});

// ── Layouts and sample rates ───────────────────────────────────────────────────────────────────

describe('channel layouts (AC-ENCODE-04-4)', () => {
  const relabel = (layout: string) => `channelmap=map=${LAYOUT_SYNONYMS[layout].map}:channel_layout=${LAYOUT_SYNONYMS[layout].layout}`;

  it('has the standard layout of design §5 for 1 to 8 channels, and synonyms of the same channel count', () => {
    expect(STANDARD_LAYOUTS).toEqual(['mono', 'stereo', '3.0', 'quad', '5.0', '5.1', '6.1', '7.1']);
    for (const [name, synonym] of Object.entries(LAYOUT_SYNONYMS)) {
      const pairs = synonym.map.split('|');
      expect(STANDARD_LAYOUTS.indexOf(synonym.layout) + 1, name).toBe(pairs.length);
      // Every channel goes somewhere, and no two to the same place.
      expect(new Set(pairs.map(pair => pair.split('-')[1])).size, name).toBe(pairs.length);
    }
  });

  it.each([
    ['mono', 1, []], ['stereo', 2, []],
    ['2.1', 3, ['aformat=channel_layouts=3.0']], ['3.0', 3, []], ['3.0(back)', 3, ['aformat=channel_layouts=3.0']],
    ['4.0', 4, ['aformat=channel_layouts=quad']], ['quad', 4, []], ['quad(side)', 4, ['aformat=channel_layouts=quad']],
    ['5.0(side)', 5, [relabel('5.0(side)')]], ['5.0', 5, []], ['4.1', 5, ['aformat=channel_layouts=5.0']],
    ['5.1(side)', 6, [relabel('5.1(side)')]], ['5.1', 6, []], ['hexagonal', 6, ['aformat=channel_layouts=5.1']],
    ['6.1(back)', 7, ['aformat=channel_layouts=6.1']], ['6.1(front)', 7, ['aformat=channel_layouts=6.1']], ['6.1', 7, []],
    ['7.1(wide)', 8, [relabel('7.1(wide)')]], ['7.1(wide-side)', 8, ['aformat=channel_layouts=7.1']], ['7.1', 8, []], ['5.1.2', 8, ['aformat=channel_layouts=7.1']],
    ['5.1.4', 10, ['aformat=channel_layouts=7.1']], ['hexadecagonal', 16, ['aformat=channel_layouts=7.1']],
    ['unknown', 6, ['channelmap=channel_layout=5.1']], [null, 3, ['channelmap=channel_layout=3.0']], ['8 channels', 8, ['channelmap=channel_layout=7.1']],
    ['downmix', 2, [relabel('downmix')]],
  ] as const)('libopus from %s (%i channels)', (layout, channels, filters) => {
    expect(layoutFilters('libopus', { channelLayout: layout, channels })).toEqual(filters);
  });

  it('gives Opus the standard layout through the planner, with the track rate per channel pair', () => {
    const toOpus = (layout: string, channels: number) => trackArgs(plan(track('flac', 'flac', { ...surround(layout, channels), sampleFormat: 's16' }), convert('opus')).outputs[0]);
    expect(toOpus('2.1', 3)).toBe('-c:a:0 libopus -b:a:0 192k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 aformat=channel_layouts=3.0');
    expect(toOpus('5.0(side)', 5)).toBe(`-c:a:0 libopus -b:a:0 320k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 ${relabel('5.0(side)')}`);
    expect(toOpus('5.1(side)', 6)).toBe(`-c:a:0 libopus -b:a:0 384k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 ${relabel('5.1(side)')}`);
    expect(toOpus('7.1(wide)', 8)).toBe(`-c:a:0 libopus -b:a:0 512k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 ${relabel('7.1(wide)')}`);
    expect(toOpus('5.1.4', 10)).toBe('-c:a:0 libopus -b:a:0 512k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 aformat=channel_layouts=7.1');
    expect(toOpus('5.1', 6)).toBe('-c:a:0 libopus -b:a:0 384k -vbr:a:0 on -compression_level:a:0 10');
  });

  it('leaves AAC its layout, but relabels the side and wide synonyms (no PCE) and remixes what aac refuses', () => {
    const aac = (channelLayout: string | null, channels: number) => layoutFilters('aac', { channelLayout, channels });
    expect(aac('5.1(side)', 6)).toEqual([relabel('5.1(side)')]);
    expect(aac('5.0(side)', 5)).toEqual([relabel('5.0(side)')]);
    expect(aac('7.1(wide)', 8)).toEqual([relabel('7.1(wide)')]);
    for (const [layout, channels] of [['5.1', 6], ['2.1', 3], ['quad(side)', 4], ['4.0', 4], ['6.1(back)', 7], ['7.1', 8], ['octagonal', 8], ['unknown', 6], [null, 2]] as const) {
      expect(aac(layout, channels), `${layout}`).toEqual([]);
    }
    expect(aac('5.1.2', 8)).toEqual(['aformat=channel_layouts=7.1']);
    expect(aac('3.1.2', 6)).toEqual(['aformat=channel_layouts=5.1']);
    expect(aac('5.1.4', 10)).toEqual(['aformat=channel_layouts=7.1']);
  });

  it('gives ALAC the nearest ALAC layout: remixed by position, relabelled only when the layout is merely renamed (design §7b)', () => {
    const alac = (channelLayout: string | null, channels: number | null) => layoutFilters('alac', { channelLayout, channels });
    const remixTo = (layout: string) => [`aformat=channel_layouts=${layout}`];
    // ALAC's own layouts need nothing.
    for (const [layout, channels] of [['mono', 1], ['stereo', 2], ['3.0', 3], ['4.0', 4], ['5.0', 5], ['5.1', 6], ['6.1(back)', 7], ['7.1(wide)', 8]] as const) {
      expect(alac(layout, channels), layout).toEqual([]);
    }
    // A mere renaming of an ALAC layout (side for back, downmix for stereo): relabelled channel by channel.
    expect(alac('5.1(side)', 6)).toEqual([relabel('5.1(side)')]);
    expect(alac('5.0(side)', 5)).toEqual([relabel('5.0(side)')]);
    expect(alac('downmix', 2)).toEqual([relabel('downmix')]);
    // Otherwise remixed into the smallest ALAC layout with a place for every channel, side channels taking
    // the free back places: nothing mixed, nothing lost (quad keeps its back pair, 2.1 its LFE).
    for (const [layout, channels, target] of [
      ['quad', 4, '5.0'], ['quad(side)', 4, '5.0'], ['2.1', 3, '5.1'], ['3.0(back)', 3, '4.0'], ['3.1', 4, '5.1'], ['4.1', 5, '6.1(back)'],
      ['6.0', 6, '6.1(back)'], ['hexagonal', 6, '6.1(back)'], ['6.1', 7, '6.1(back)'], ['6.0(front)', 6, '7.1(wide)'], ['6.1(front)', 7, '7.1(wide)'],
      ['7.0(front)', 7, '7.1(wide)'], ['7.1(wide-side)', 8, '7.1(wide)'], ['4 channels (FL+FR+LFE+BC)', 4, '6.1(back)'], ['FL+FR+BC', 3, '4.0'],
    ] as const) {
      expect(alac(layout, channels), layout).toEqual(remixTo(target));
    }
    // No ALAC layout has room for all: the one of the same channel count (at most 8), mixed by position.
    for (const [layout, channels, target] of [
      ['7.1', 8, '7.1(wide)'], ['7.0', 7, '6.1(back)'], ['octagonal', 8, '7.1(wide)'], ['3.1.2', 6, '5.1'], ['5.1.2', 8, '7.1(wide)'], ['5.1.2(back)', 8, '7.1(wide)'],
      ['5.1.4', 10, '7.1(wide)'], ['hexadecagonal', 16, '7.1(wide)'], ['12 channels', 12, '7.1(wide)'],
    ] as const) {
      expect(alac(layout, channels), layout).toEqual(remixTo(target));
    }
    // No positions to keep: named as ALAC's own layout of the count.
    expect(alac('unknown', 7)).toEqual(['channelmap=channel_layout=6.1(back)']);
    expect(alac(null, 4)).toEqual(['channelmap=channel_layout=4.0']);
    expect(alac('6 channels', 6)).toEqual(['channelmap=channel_layout=5.1']);
    expect(alac(null, null)).toEqual([]);
    // Never a bare relabel of a layout with positions (that put quad's back pair on FC and BC).
    for (const [layout, channels] of [['quad', 4], ['2.1', 3], ['7.1', 8], ['3.0(back)', 3], ['quad(side)', 4], ['6.1', 7], ['7.0', 7]] as const) {
      expect(alac(layout, channels).join(), layout).not.toMatch(/channelmap=channel_layout/);
    }
    // The output's channel count, for the cap: more than the source's where the nearest layout has empty places.
    const counts = ([['quad', 4], ['2.1', 3], ['5.1(side)', 6], ['7.1', 8], ['5.1.4', 10], [null, 2], [null, null]] as const)
      .map(([channelLayout, channels]) => alacChannels({ channelLayout, channels }));
    expect(counts).toEqual([5, 6, 6, 8, 8, 2, null]);
    expect(alacLayout({ channelLayout: 'quad', channels: 4 })).toEqual({ layout: '5.0', filters: ['aformat=channel_layouts=5.0'] });
  });

  it('mixes FLAC, AAC and Opus down to 7.1 above 8 channels, and leaves MP3, PCM and unknown counts alone', () => {
    expect(layoutFilters('flac', { channelLayout: '5.1.4', channels: 10 })).toEqual(['aformat=channel_layouts=7.1']);
    for (const layout of ['5.1(side)', '2.1', '7.1(wide)', 'unknown']) expect(layoutFilters('flac', { channelLayout: layout, channels: 6 })).toEqual([]);
    // MP3 is mixed down by `-ac 2`, PCM takes anything, an unknown channel count is left to the encoder.
    for (const encoder of ['libmp3lame', 'pcm_s24le', 'pcm_f32le'] as const) expect(layoutFilters(encoder, { channelLayout: '5.1.4', channels: 10 })).toEqual([]);
    for (const encoder of ['libopus', 'aac', 'alac', 'flac'] as const) expect(layoutFilters(encoder, { channelLayout: null, channels: null })).toEqual([]);
  });

  it('mixes MP3 down to stereo above two channels and says so; mono and stereo stay', () => {
    const toMp3 = (extra: Partial<AudioStreamInfo>) => plan(track('flac', 'flac', { sampleFormat: 's16', ...extra }), convert('mp3'));
    const six = toMp3(surround('5.1(side)', 6));
    expect(trackArgs(six.outputs[0])).toBe('-c:a:0 libmp3lame -q:a:0 2 -ac:a:0 2');
    expect(six.summary.warnings).toEqual([{ code: 'downmixed_to_stereo', streams: [0], count: 1 }]);
    expect(PLAN_LOSS_CODES).toContain('downmixed_to_stereo');
    for (const extra of [surround('stereo', 2), surround('mono', 1)]) {
      const kept = toMp3(extra);
      expect(trackArgs(kept.outputs[0])).toBe('-c:a:0 libmp3lame -q:a:0 2');
      expect(kept.summary.warnings).toEqual([]);
    }
    // An unknown channel count is mixed down to be safe, without a claim that anything was lost.
    const unknown = toMp3({ channels: null, channelLayout: null });
    expect(trackArgs(unknown.outputs[0])).toBe('-c:a:0 libmp3lame -q:a:0 2 -ac:a:0 2');
    expect(unknown.summary.warnings).toEqual([]);
  });
});

describe('sample rates (AC-ENCODE-04-4)', () => {
  it('writes Opus at 48 kHz, brings AAC and MP3 above 48 kHz down with soxr, and keeps the rest', () => {
    expect(sampleRateFilters('libopus', { sampleRate: 44_100 })).toEqual(['aresample=48000']);
    expect(sampleRateFilters('libopus', { sampleRate: 96_000 })).toEqual(['aresample=48000']);
    expect(sampleRateFilters('libopus', { sampleRate: 48_000 })).toEqual([]);
    expect(sampleRateFilters('libopus', { sampleRate: null })).toEqual(['aresample=48000']);
    for (const rate of [64_000, 88_200, 96_000, 192_000]) {
      expect(sampleRateFilters('aac', { sampleRate: rate })).toEqual([SOXR]);
      expect(sampleRateFilters('libmp3lame', { sampleRate: rate })).toEqual([SOXR]);
    }
    for (const rate of [8_000, 22_050, 44_100, 48_000, null]) expect(sampleRateFilters('aac', { sampleRate: rate })).toEqual([]);
    for (const encoder of ['flac', 'alac', 'pcm_s24le'] as const) expect(sampleRateFilters(encoder, { sampleRate: 192_000 })).toEqual([]);
  });

  it('puts the layout first, then the sample rate, in the track\'s own -filter:a:<n>', () => {
    const hiRes = track('flac', 'flac', { ...surround('5.1(side)', 6), sampleRate: 96_000, sampleFormat: 's32', bitsPerRawSample: 24 });
    expect(trackArgs(plan(hiRes, convert('m4a')).outputs[0])).toBe(`-c:a:0 aac -b:a:0 576k -filter:a:0 channelmap=map=${LAYOUT_SYNONYMS['5.1(side)'].map}:channel_layout=5.1,${SOXR}`);
    expect(trackArgs(plan(hiRes, convert('opus')).outputs[0])).toBe(`-c:a:0 libopus -b:a:0 384k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 channelmap=map=${LAYOUT_SYNONYMS['5.1(side)'].map}:channel_layout=5.1,aresample=48000`);
    expect(trackArgs(plan(hiRes, convert('mp3')).outputs[0])).toBe(`-c:a:0 libmp3lame -q:a:0 2 -ac:a:0 2 -filter:a:0 ${SOXR}`);
    expect(trackArgs(plan(hiRes, convert('wav')).outputs[0])).toBe('-c:a:0 pcm_s24le');
    expect(trackArgs(plan(track('wav', 'pcm_s16le', { sampleRate: 44_100, sampleFormat: 's16' }), convert('opus')).outputs[0]))
      .toBe('-c:a:0 libopus -b:a:0 128k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 aresample=48000');
  });

  it('gives every track of a video its own filter chain, never -af (two tracks)', () => {
    const value = film(['pcm_s24le', { ...surround('5.1(side)', 6), sampleRate: 44_100, sampleFormat: 's32', bitsPerRawSample: 24, default: true }],
      ['flac', { sampleRate: 96_000, sampleFormat: 's16' }]);
    const cases: [ConversionSettings, string, string][] = [
      [compress('mkv'), `channelmap=map=${LAYOUT_SYNONYMS['5.1(side)'].map}:channel_layout=5.1,aresample=48000`, 'aresample=48000'],
      [compress('mp4'), `channelmap=map=${LAYOUT_SYNONYMS['5.1(side)'].map}:channel_layout=5.1`, SOXR],
      [convert('webm'), `channelmap=map=${LAYOUT_SYNONYMS['5.1(side)'].map}:channel_layout=5.1,aresample=48000`, 'aresample=48000'],
    ];
    for (const [settings, first, second] of cases) {
      const output = plan(value, settings).outputs[0];
      const args = argsOf(output);
      expect(valueAfter(args, '-filter:a:0')).toBe(first);
      expect(valueAfter(args, '-filter:a:1')).toBe(second);
      expect(args.filter(arg => arg.startsWith('-filter:a'))).toEqual(['-filter:a:0', '-filter:a:1']);
      expect(args).not.toContain('-af');
      expect(args.some(arg => arg === '-filter:a' || arg === '-filter_complex')).toBe(false);
      // The channel counts are kept: no -ac in a video output.
      expect(args.some(arg => arg.startsWith('-ac'))).toBe(false);
    }
  });
});

// ── Copy, confirmation, passthrough ────────────────────────────────────────────────────────────

describe('lossy to lossless and the same codec (AC-ENCODE-04-5)', () => {
  it('asks to confirm a lossy track written as FLAC, WAV or ALAC, and nothing else', () => {
    const mp3 = track('mp3', 'mp3', { bitRate: 192_000, bitRateSource: 'stream' });
    for (const format of ['flac', 'wav', 'alac'] as const) {
      expect(plan(mp3, convert(format)).summary.confirmations, format).toEqual(['lossy_to_lossless']);
      expect(plan(film(['aac']), extract(format)).summary.confirmations, `extract ${format}`).toEqual(['lossy_to_lossless']);
    }
    for (const format of ['mp3', 'm4a', 'opus'] as const) expect(plan(mp3, convert(format)).summary.confirmations).toEqual([]);
    const flac = track('flac', 'flac', { sampleFormat: 's16' });
    for (const format of AUDIO_FORMATS) expect(plan(flac, convert(format)).summary.confirmations).toEqual([]);
    // DTS-HD Master Audio is lossless; the DTS core and AC-3 are not.
    expect(plan(film(['dts', { profile: 'DTS-HD MA', default: true }]), extract('flac')).summary.confirmations).toEqual([]);
    expect(plan(film(['dts', { profile: 'DTS', default: true }]), extract('flac')).summary.confirmations).toEqual(['lossy_to_lossless']);
    // Once for the item, though two tracks need it.
    expect(plan(film(['aac'], ['ac3'], ['flac']), extract('wav', true)).summary.confirmations).toEqual(['lossy_to_lossless']);
    // Video outputs never write audio losslessly.
    expect(plan(film(['aac']), convert('mkv')).summary.confirmations).toEqual([]);
    expect(plan(film(['flac']), compress('mkv')).summary.confirmations).toEqual([]);
    expect([isLosslessAudio({ codec: 'pcm_s24be', profile: null }), isLosslessAudio({ codec: 'truehd', profile: null }), isLosslessAudio({ codec: 'opus', profile: null })])
      .toEqual([true, true, false]);
  });

  it('re-encodes the same codec to shrink it when the target rate is lower than the source\'s (a 320k MP3 to standard MP3)', () => {
    const mp3At = (bitRate: number) => track('mp3', 'mp3', { bitRate, bitRateSource: 'stream' });
    // The nominal rates compared: LAME's averages for V0 / V2 / V5, the table rates of AAC and Opus (per channel count).
    expect((['quality', 'balanced', 'size'] as const).map(tier => nominalFormatBitRate('mp3', tier, 2))).toEqual([245_000, 190_000, 130_000]);
    expect([nominalFormatBitRate('m4a', 'quality', 2), nominalFormatBitRate('opus', 'balanced', 2), nominalFormatBitRate('opus', 'balanced', 6), nominalFormatBitRate('m4a', 'size', 1)])
      .toEqual([256_000, 128_000, 384_000, 64_000]);
    const shrunk = buildPlan(mp3At(320_000), convert('mp3', 'balanced'), CAPS);
    expect(shrunk.status).toBe('ready');
    expect(trackArgs(planOf(shrunk).outputs[0])).toBe('-c:a:0 libmp3lame -q:a:0 2');
    expect([planOf(shrunk).isRemuxOnly, planOf(shrunk).summary.confirmations]).toEqual([false, []]);
    // Every tier is below 320 kbit/s; just above a tier's nominal rate and its 5 % measuring margin re-encodes too.
    for (const tier of ['quality', 'balanced', 'size'] as const) expect(actionOf(plan(mp3At(320_000), convert('mp3', tier)).outputs[0], 0), tier).toBe('encode(libmp3lame)');
    expect(AUDIO_TABLE.sameCodecMargin).toBe(1.05);
    expect(actionOf(plan(mp3At(199_600), convert('mp3', 'balanced')).outputs[0], 0)).toBe('encode(libmp3lame)');
    expect(actionOf(plan(mp3At(257_500), convert('mp3', 'quality')).outputs[0], 0)).toBe('encode(libmp3lame)');
    // AAC and Opus the same way, the rate read from the stream or from the BPS tag.
    expect(trackArgs(plan(track('m4a', 'aac', { bitRate: 256_000, bitRateSource: 'stream' }), convert('m4a', 'size')).outputs[0])).toBe('-c:a:0 aac -b:a:0 128k');
    expect(actionOf(plan(track('opus', 'opus', { bitRate: 160_000, bitRateSource: 'tag' }), convert('opus', 'balanced')).outputs[0], 0)).toBe('encode(libopus)');
    // A video's track: extracting a 320 kbit/s Opus as standard Opus shrinks it too.
    expect(actionOf(plan(film(['opus', { default: true, bitRate: 320_000, bitRateSource: 'tag' }]), extract('opus')).outputs[0], 1)).toBe('encode(libopus)');
  });

  it('copies the same codec when the target rate is not lower, and skips it when the container is the same too', () => {
    const mp3At = (bitRate: number) => track('mp3', 'mp3', { bitRate, bitRateSource: 'stream' });
    // Target V0 (about 245 kbit/s) above a 96 kbit/s source: re-encoding could only add size. Equal counts as not lower.
    expect(buildPlan(mp3At(96_000), convert('mp3', 'quality'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(buildPlan(mp3At(190_000), convert('mp3', 'balanced'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(planOf(buildPlan(mp3At(96_000), convert('mp3', 'quality'), CAPS)).outputs[0].streams.map(decision => decision.action)).toEqual(['copy']);
    // A 128 kbit/s AAC to "high" M4A (256 kbit/s): copied and already the target; to "small" (128 kbit/s) as well.
    expect(buildPlan(track('m4a', 'aac', { bitRate: 128_000, bitRateSource: 'stream' }), convert('m4a', 'quality'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(buildPlan(track('m4a', 'aac', { bitRate: 128_000, bitRateSource: 'stream' }), convert('m4a', 'size'), CAPS).status).toBe('skipped');
    // A 5.1 Opus at 300 kbit/s against the 5.1 standard rate of 384 kbit/s.
    expect(buildPlan(track('opus', 'opus', { ...surround('5.1', 6), bitRate: 300_000, bitRateSource: 'stream' }), convert('opus'), CAPS).status).toBe('skipped');
    // A measured rate reads a little above the rate the file was made at (the bundled ffmpeg's own AAC at 128k reads
    // 128 048 bit/s, at 256k 258 807): within 5 % of the nominal rate it is the same tier's output, copied and already
    // the target, not re-encoded at the same rate. Just past the margin it is re-encoded.
    const aacAt = (bitRate: number) => track('m4a', 'aac', { bitRate, bitRateSource: 'stream' });
    expect(buildPlan(aacAt(128_048), convert('m4a', 'size'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(buildPlan(aacAt(258_807), convert('m4a', 'quality'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(buildPlan(aacAt(134_300), convert('m4a', 'size'), CAPS).status).toBe('skipped');
    expect(actionOf(plan(aacAt(134_500), convert('m4a', 'size')).outputs[0], 0)).toBe('encode(aac)');
    expect(buildPlan(mp3At(199_400), convert('mp3', 'balanced'), CAPS).status).toBe('skipped');
    expect(buildPlan(mp3At(257_000), convert('mp3', 'quality'), CAPS).status).toBe('skipped');
    // Only the container changes: a remux, which is not skipped.
    const aacFilm = film(['aac', { bitRate: 128_000, bitRateSource: 'stream', default: true }]);
    const toM4a = buildPlan(aacFilm, convert('m4a', 'size'), CAPS);
    expect(toM4a.status).toBe('ready');
    expect(planOf(toM4a).isRemuxOnly).toBe(true);
    // Lossless codecs are copied whatever the tier: re-encoding gives the same samples.
    expect(buildPlan(track('m4a', 'alac', { sampleFormat: 's32p', bitsPerRawSample: 24 }), convert('alac'), CAPS).status).toBe('skipped');
    expect(buildPlan(track('flac', 'flac', { sampleFormat: 's16' }), convert('flac', 'size'), CAPS).status).toBe('skipped');
    expect(buildPlan(track('wav', 'pcm_s16le', { sampleFormat: 's16' }), convert('wav'), CAPS).status).toBe('skipped');
    // Another codec is encoded: big-endian PCM into WAV, AAC into Opus.
    expect(actionOf(plan(track('aiff', 'pcm_s16be', { sampleFormat: 's16' }), convert('wav')).outputs[0], 0)).toBe('encode(pcm_s16le)');
    expect(actionOf(plan(track('m4a', 'aac', { bitRate: 128_000, bitRateSource: 'stream' }), convert('opus')).outputs[0], 0)).toBe('encode(libopus)');
  });

  it('takes the container\'s total rate when neither the stream nor a tag states one, for an audio file of that one track only', () => {
    // Opus in Ogg states no stream rate: the file's total rate stands for it.
    const ogg = (bitRate: number | null, parts: MediaParts = {}) => media({ container: 'ogg', audio: [audio(0, 0, 'opus', { default: true })], bitRate, ...parts });
    expect(actionOf(plan(ogg(200_000), convert('opus')).outputs[0], 0)).toBe('encode(libopus)');
    expect(plan(ogg(96_000), convert('opus')).isRemuxOnly).toBe(true);
    // The total holds the Ogg pages too: CBR Opus made at 128k reads 130 535 bit/s (real ffprobe), within the margin.
    expect(plan(ogg(130_535), convert('opus')).isRemuxOnly).toBe(true);
    expect(actionOf(plan(ogg(134_500), convert('opus')).outputs[0], 0)).toBe('encode(libopus)');
    const opusFile = (bitRate: number | null) => media({ container: 'opus', audio: [audio(0, 0, 'opus', { default: true })], bitRate });
    expect(buildPlan(opusFile(96_000), convert('opus'), CAPS)).toMatchObject({ status: 'skipped', reason: 'already_target' });
    expect(actionOf(plan(opusFile(200_000), convert('opus')).outputs[0], 0)).toBe('encode(libopus)');
    // A stated rate wins over the total.
    expect(plan(ogg(200_000, { audio: [audio(0, 0, 'opus', { default: true, bitRate: 96_000, bitRateSource: 'tag' })] }), convert('opus')).isRemuxOnly).toBe(true);
    // When the file holds more than the track (cover art, another track, a video) the total counts the rest too: unknown, so copied.
    expect(actionOf(plan(ogg(200_000, { covers: [cover(1, 0)] }), convert('opus')).outputs[0], 0)).toBe('copy');
    expect(actionOf(plan(ogg(200_000, { audio: [audio(0, 0, 'opus', { default: true }), audio(1, 1, 'opus')] }), convert('opus')).outputs[0], 0)).toBe('copy');
    expect(actionOf(plan(film(['opus', { default: true }]), extract('opus')).outputs[0], 1)).toBe('copy');
    // Unknown everywhere: copied.
    expect(buildPlan(opusFile(null), convert('opus'), CAPS).status).toBe('skipped');
  });
});

describe('audio inside a video (AC-ENCODE-05-1, AC-ENCODE-05-2)', () => {
  const rate = (bitRate: number | null, source: 'stream' | 'tag' = 'stream') => ({ bitRate, bitRateSource: bitRate === null ? null : source });
  const inVideo = (settings: ConversionSettings, codec: string, extra: Partial<AudioStreamInfo> = {}) => plan(film([codec, { default: true, ...extra }]), settings).outputs[0];

  it('"convert" copies every codec the container takes, whatever its rate', () => {
    expect(actionOf(inVideo(convert('mp4'), 'aac'), 1)).toBe('copy');
    expect(plan(film(['aac', { default: true }]), convert('mp4')).isRemuxOnly).toBe(true);
    for (const codec of ['aac', 'mp3', 'ac3', 'eac3', 'alac']) {
      expect(actionOf(inVideo(convert('mp4'), codec, rate(1_500_000)), 1), codec).toBe('copy');
      expect(actionOf(inVideo(convert('mov'), codec, rate(1_500_000)), 1), codec).toBe('copy');
    }
    for (const codec of ['flac', 'opus', 'vorbis', 'dts', 'truehd', 'pcm_s24le']) expect(actionOf(inVideo(convert('mp4'), codec), 1), codec).toBe('encode(aac)');
    for (const codec of ['flac', 'dts', 'truehd', 'pcm_s24le', 'aac', 'wmav2']) expect(actionOf(inVideo(convert('mkv'), codec, rate(4_000_000)), 1), codec).toBe('copy');
    for (const codec of ['opus', 'vorbis']) expect(actionOf(inVideo(convert('webm'), codec, rate(500_000)), 1), codec).toBe('copy');
    for (const codec of ['aac', 'mp3', 'flac']) expect(actionOf(inVideo(convert('webm'), codec), 1), codec).toBe('encode(libopus)');
  });

  it('"convert" re-encodes into MKV the PCM and ADPCM kinds the Matroska muxer refuses as they are', () => {
    // Blu-ray LPCM (M2TS), DVD LPCM (VOB), QuickTime float and 8-bit PCM (MOV), SMPTE 302M (broadcast TS).
    for (const codec of ['pcm_bluray', 'pcm_dvd', 'pcm_f32be', 'pcm_f64be', 'pcm_s8', 'pcm_s16le_planar', 'pcm_u16le', 's302m', 'adpcm_ima_qt', 'nellymoser']) {
      expect(matroskaTakesAudio(codec), codec).toBe(false);
      expect(actionOf(inVideo(convert('mkv'), codec, rate(1_536_000)), 1), codec).toBe('encode(libopus)');
      expect(plan(film([codec, { default: true }]), convert('mkv')).isRemuxOnly, codec).toBe(false);
    }
    for (const codec of [
      'pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s64le', 'pcm_f32le', 'pcm_f64le', 'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_alaw', 'pcm_mulaw', 'mp2',
      'adpcm_ms', 'adpcm_swf', 'amr_nb', 'wmav2',
    ]) {
      expect(matroskaTakesAudio(codec), codec).toBe(true);
      expect(actionOf(inVideo(convert('mkv'), codec, rate(1_536_000)), 1), codec).toBe('copy');
    }
    // SMPTE 302M is PCM: lossless, so "compress" always re-encodes it and FLAC asks nothing.
    expect(isLosslessAudio({ codec: 's302m', profile: null })).toBe(true);
    expect(plan(film(['s302m', { default: true, sampleFormat: 's32', bitsPerRawSample: 24 }]), extract('flac')).summary.confirmations).toEqual([]);
    // MOV keeps its little-endian PCM; MP4 re-encodes PCM to AAC as before.
    expect(actionOf(inVideo(convert('mov'), 'pcm_s24le'), 1)).toBe('copy');
    expect(actionOf(inVideo(convert('mp4'), 'pcm_bluray'), 1)).toBe('encode(aac)');
  });

  it('"compress" copies a compatible track only up to 1.25 × the tier rate, read from the stream, else the BPS tag', () => {
    // MP4, balanced: AAC stereo 160 kbit/s, so up to 200 kbit/s.
    expect(actionOf(inVideo(compress('mp4'), 'aac', rate(200_000)), 1)).toBe('copy');
    expect(actionOf(inVideo(compress('mp4'), 'aac', rate(200_001)), 1)).toBe('encode(aac)');
    expect(actionOf(inVideo(compress('mp4'), 'aac', rate(190_000, 'tag')), 1)).toBe('copy');
    expect(actionOf(inVideo(compress('mp4'), 'aac', rate(260_000, 'tag')), 1)).toBe('encode(aac)');
    expect(actionOf(inVideo(compress('mp4'), 'aac', rate(null)), 1)).toBe('encode(aac)');
    expect(actionOf(inVideo(compress('mp4'), 'mp3', rate(128_000)), 1)).toBe('copy');
    // 5.1: 320 kbit/s, so up to 400; quality tier 384, so up to 480.
    expect(actionOf(inVideo(compress('mp4'), 'ac3', { ...surround('5.1(side)', 6), ...rate(384_000) }), 1)).toBe('copy');
    expect(actionOf(inVideo(compress('mp4'), 'ac3', { ...surround('5.1(side)', 6), ...rate(448_000) }), 1)).toBe('encode(aac)');
    expect(actionOf(inVideo(compress('mp4', 'quality'), 'ac3', { ...surround('5.1(side)', 6), ...rate(448_000) }), 1)).toBe('copy');
    expect(actionOf(inVideo(compress('mp4'), 'eac3', { ...surround('5.1(side)', 6), ...rate(640_000) }), 1)).toBe('encode(aac)');
    // A codec MP4 does not take is re-encoded whatever its rate.
    expect(actionOf(inVideo(compress('mp4'), 'opus', rate(64_000)), 1)).toBe('encode(aac)');
    // MKV, balanced: Opus stereo 96 kbit/s (up to 120), 5.1 256 kbit/s (up to 320).
    expect(actionOf(inVideo(compress('mkv'), 'opus', rate(96_000)), 1)).toBe('copy');
    expect(actionOf(inVideo(compress('mkv'), 'vorbis', rate(120_000)), 1)).toBe('copy');
    expect(actionOf(inVideo(compress('mkv'), 'vorbis', rate(128_000)), 1)).toBe('encode(libopus)');
    expect(actionOf(inVideo(compress('mkv'), 'ac3', { ...surround('5.1(side)', 6), ...rate(320_000) }), 1)).toBe('copy');
    expect(actionOf(inVideo(compress('mkv'), 'aac', { ...surround('5.1', 6), ...rate(320_000, 'tag') }), 1)).toBe('copy');
  });

  it('"compress" always re-encodes lossless tracks and DTS, however low their rate', () => {
    for (const [codec, extra] of [
      ['flac', {}], ['pcm_s16le', { channels: 1, channelLayout: 'mono' }], ['truehd', {}], ['dts', {}], ['dts', { profile: 'DTS-HD MA' }], ['alac', {}],
    ] as const) {
      // 32 kbit/s is below every tier's limit.
      expect(actionOf(inVideo(compress('mkv'), codec, { ...extra, ...rate(32_000) }), 1), codec).toBe('encode(libopus)');
    }
    expect(actionOf(inVideo(compress('mp4'), 'alac', rate(32_000)), 1)).toBe('encode(aac)');
    // The same tracks are copied by "convert" into MKV.
    expect(actionOf(inVideo(convert('mkv'), 'dts', rate(32_000)), 1)).toBe('copy');
  });

  it('re-encodes at the "audio inside a video" rates, keeping the channel count (more than 8 become 7.1)', () => {
    const table = (encoder: 'aac' | 'libopus') => [1, 2, 6].map(channels => (['quality', 'balanced', 'size'] as const).map(tier => inVideoBitRate(encoder, tier, channels)));
    expect(table('aac')).toEqual([[96, 80, 64], [192, 160, 128], [384, 320, 256]]);
    expect(table('libopus')).toEqual([[64, 48, 40], [128, 96, 80], [320, 256, 192]]);
    // Other channel counts: the 5.1 rate per channel, never below stereo; unknown counts as stereo.
    expect([3, 4, 5, 7, 8, 10, null].map(channels => inVideoBitRate('aac', 'quality', channels))).toEqual([192, 256, 320, 448, 512, 512, 192]);
    expect([3, 8].map(channels => inVideoBitRate('libopus', 'size', channels))).toEqual([96, 256]);

    const pcm = (layout: string, channels: number) => ({ ...surround(layout, channels), sampleFormat: 's16', bitsPerRawSample: 16 });
    expect(trackArgs(inVideo(compress('mp4', 'quality'), 'flac', pcm('5.1', 6)))).toBe('-c:a:0 aac -b:a:0 384k');
    expect(trackArgs(inVideo(compress('mp4', 'size'), 'flac', pcm('mono', 1)))).toBe('-c:a:0 aac -b:a:0 64k');
    expect(trackArgs(inVideo(compress('mkv', 'size'), 'flac', pcm('5.1', 6)))).toBe('-c:a:0 libopus -b:a:0 192k -vbr:a:0 on -compression_level:a:0 10');
    expect(trackArgs(inVideo(compress('mkv', 'balanced'), 'flac', pcm('stereo', 2)))).toBe('-c:a:0 libopus -b:a:0 96k -vbr:a:0 on -compression_level:a:0 10');
    expect(trackArgs(inVideo(compress('mkv'), 'pcm_s16le', pcm('5.1.4', 10))))
      .toBe('-c:a:0 libopus -b:a:0 341k -vbr:a:0 on -compression_level:a:0 10 -filter:a:0 aformat=channel_layouts=7.1');
    expect(trackArgs(inVideo(compress('mp4'), 'pcm_s16le', pcm('5.1.4', 10)))).toBe('-c:a:0 aac -b:a:0 427k -filter:a:0 aformat=channel_layouts=7.1');
    expect(trackArgs(inVideo(convert('mp4', 'quality'), 'truehd', { ...pcm('7.1', 8), sampleFormat: 's32', bitsPerRawSample: 24 }))).toBe('-c:a:0 aac -b:a:0 512k');
    // Higher sample rates follow AC-ENCODE-04-4 here too.
    expect(trackArgs(inVideo(convert('mp4'), 'flac', { ...pcm('stereo', 2), sampleRate: 96_000 }))).toBe(`-c:a:0 aac -b:a:0 160k -filter:a:0 ${SOXR}`);
  });
});

// ── Bit depth ──────────────────────────────────────────────────────────────────────────────────

describe('bit depth (design §5, R-ENCODE-04 边界)', () => {
  it.each([
    ['pcm_s16le', 's16', 16, 16, 'pcm_s16le', '-sample_fmt:a:0 s16', '-sample_fmt:a:0 s16p'],
    ['flac', 's32', 24, 24, 'pcm_s24le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
    ['pcm_s32le', 's32', 32, 32, 'pcm_s32le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
    ['pcm_dvd', 's32', 20, 20, 'pcm_s24le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
    ['pcm_u8', 'u8', null, 8, 'pcm_s16le', '-sample_fmt:a:0 s16', '-sample_fmt:a:0 s16p'],
    ['pcm_f32le', 'flt', null, 'float', 'pcm_f32le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
    ['pcm_f64be', 'dbl', null, 'float', 'pcm_f32le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
    ['mp3', 'fltp', null, 'float', 'pcm_f32le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
    ['wavpack', 's64p', null, 64, 'pcm_s32le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
    ['tta', null, null, null, 'pcm_s24le', '-sample_fmt:a:0 s32 -bits_per_raw_sample:a:0 24', '-sample_fmt:a:0 s32p -bits_per_raw_sample:a:0 24'],
  ] as const)('%s (%s, %s bits) keeps its depth in WAV, FLAC and ALAC', (codec, sampleFormat, bitsPerRawSample, depth, wav, flac, alac) => {
    const stream = audio(0, 0, codec, { sampleFormat, bitsPerRawSample, default: true });
    expect(sourceDepth(stream)).toBe(depth);
    expect(pcmEncoder(stream)).toBe(wav);
    const value = media({ container: 'mkv', audio: [stream] });
    const args = (format: AudioFormat) => trackArgs(plan(value, convert(format)).outputs[0]);
    // A WAV source or a FLAC one in its own format is copied as it is (the same codec).
    const wavCopy = ['pcm_s16le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le'].includes(codec);
    expect(args('wav')).toBe(wavCopy ? '-c:a:0 copy' : `-c:a:0 ${wav}`);
    expect(args('flac')).toBe(codec === 'flac' ? '-c:a:0 copy' : `-c:a:0 flac -compression_level:a:0 5 ${flac}`);
    expect(args('alac')).toBe(`-c:a:0 alac ${alac}`);
  });
});

// ── Covers, chapters, tags ─────────────────────────────────────────────────────────────────────

describe('covers, chapters and tags (AC-ENCODE-04-3)', () => {
  // An MP3 with cover art and two chapters, so FLAC, Opus and the rest all encode it.
  const tagged = track('mp3', 'mp3', { bitRate: 320_000, bitRateSource: 'stream' }, { covers: [cover(1, 0, 'mjpeg')], chapters: 2 });

  it('puts cover art into MP3, M4A and FLAC as an attached picture, and drops it from Opus and the rest with cover_dropped', () => {
    for (const format of ['m4a', 'flac', 'alac'] as const) {
      const output = plan(tagged, convert(format)).outputs[0];
      const args = argsOf(output);
      expect(actionOf(output, 1), format).toBe('copy');
      expect(args.join(' '), format).toContain('-map 0:0 -map 0:1');
      expect(valueAfter(args, '-c:v:0')).toBe('copy');
      expect(valueAfter(args, '-disposition:v:0')).toBe('attached_pic');
      expect(warningsOf(plan(tagged, convert(format)))).not.toContain('cover_dropped[1]');
    }
    const toMp3 = plan(track('flac', 'flac', { sampleFormat: 's16' }, { covers: [cover(1, 0)] }), convert('mp3'));
    expect(valueAfter(argsOf(toMp3.outputs[0]), '-disposition:v:0')).toBe('attached_pic');
    for (const format of ['opus', 'wav'] as const) {
      const result = plan(tagged, convert(format));
      expect(actionOf(result.outputs[0], 1)).toBe('drop');
      expect(warningsOf(result)).toContain('cover_dropped[1]');
      expect(argsOf(result.outputs[0])).not.toContain('-c:v:0');
    }
  });

  it('keeps chapters in MP3, M4A and Opus, and tells before the start that FLAC, WAV and Ogg Vorbis lose them', () => {
    const chapters = (value: MediaInfo, settings: ConversionSettings) => {
      const result = plan(value, settings);
      return [valueAfter(argsOf(result.outputs[0]), '-map_chapters'), result.summary.warnings.find(item => item.code === 'chapters_dropped')?.count ?? 0];
    };
    const flac = track('flac', 'flac', { sampleFormat: 's16' }, { chapters: 2 });
    expect(chapters(flac, convert('mp3'))).toEqual(['0', 0]);
    expect(chapters(flac, convert('m4a'))).toEqual(['0', 0]);
    expect(chapters(flac, convert('opus'))).toEqual(['0', 0]);
    expect(chapters(tagged, convert('flac'))).toEqual(['-1', 2]);
    expect(chapters(tagged, convert('wav'))).toEqual(['-1', 2]);
    const vorbis = media({ video: [video(0, 0)], audio: [audio(1, 0, 'vorbis', { default: true })], chapters: 3 });
    expect(plan(vorbis, extract()).outputs[0].container.id).toBe('ogg');
    expect(chapters(vorbis, extract())).toEqual(['-1', 3]);
    expect(PLAN_LOSS_CODES).toContain('chapters_dropped');
  });

  it('removes the source container\'s brand tags from MP3, FLAC, Opus and Ogg, and sets no encoder tag anywhere', () => {
    const brand = ['-metadata', 'major_brand=', '-metadata', 'minor_version=', '-metadata', 'compatible_brands='];
    const m4a = track('m4a', 'aac', { title: 'Main' }, { covers: [cover(1, 0)] });
    const withBrand = (output: PlannedOutput) => argsOf(output).join(' ').includes(brand.join(' '));
    for (const format of ['mp3', 'flac', 'opus'] as const) expect(withBrand(plan(m4a, convert(format)).outputs[0]), format).toBe(true);
    expect(withBrand(plan(film(['vorbis', { default: true }]), extract()).outputs[0])).toBe(true);
    expect(withBrand(plan(film(['mp3', { default: true }]), extract()).outputs[0])).toBe(true);
    // M4A writes its own brand; WAV, AIFF and Matroska have no free-form tags of that kind; video outputs keep theirs.
    for (const output of [
      plan(film(['aac', { default: true }]), extract('m4a')).outputs[0], plan(m4a, convert('wav')).outputs[0], plan(film(['pcm_s24be', { default: true }]), extract()).outputs[0],
      plan(film(['ac3', { default: true }]), extract()).outputs[0], plan(m4a, convert('alac')).outputs[0],
    ]) expect(withBrand(output), output.container.id).toBe(false);
    // Opus and Ogg take the track's own tags as comments: the MP4 track's handler and vendor go.
    const opusArgs = argsOf(plan(m4a, convert('opus')).outputs[0]);
    expect(opusArgs.join(' ')).toContain('-metadata:s:a:0 handler_name= -metadata:s:a:0 vendor_id=');
    expect(argsOf(plan(m4a, convert('mp3')).outputs[0]).some(arg => arg.startsWith('-metadata:s:a:'))).toBe(false);
    // M4A keeps the track title in handler_name (AC-ENCODE-01-4).
    expect(valueAfter(argsOf(plan(film(['flac', { title: 'Main', default: true, sampleFormat: 's16' }]), extract('m4a')).outputs[0]), '-metadata:s:a:0')).toBe('handler_name=Main');
    // Never an `encoder` tag of our own, in any output.
    for (const value of [m4a, tagged, film(['aac', { default: true }], ['ac3'])]) {
      for (const settings of [...AUDIO_FORMATS.map(format => convert(format)), extract(), extract('mp3', true), convert('mkv'), compress('mp4')]) {
        const outcome = buildPlan(value, settings, CAPS);
        if (outcome.status !== 'ready' && outcome.status !== 'skipped') continue;
        for (const output of outcome.plan.outputs) expect(argsOf(output).some(arg => /^encoder=/i.test(arg))).toBe(false);
      }
    }
  });
});

// ── Output caps ────────────────────────────────────────────────────────────────────────────────

describe('the output caps of audio encodes (design §7)', () => {
  it('bound lossy formats by their table rate, MP3 by its largest frame', () => {
    const six = track('wav', 'pcm_s16le', { ...surround('5.1', 6), sampleFormat: 's16' }, { sizeBytes: 50_000_000 });
    expect(plan(six, convert('m4a', 'quality')).outputs[0].capBytes).toBe(Math.ceil(768_000 * 60 / 8 * 1.2 + MIB16));
    expect(plan(six, convert('opus', 'size')).outputs[0].capBytes).toBe(Math.ceil(288_000 * 60 / 8 * 1.2 + MIB16));
    expect(plan(six, convert('mp3', 'size')).outputs[0].capBytes).toBe(Math.ceil(320_000 * 60 / 8 * 1.2 + MIB16));
    const mono = track('wav', 'pcm_s16le', { ...surround('mono', 1), sampleFormat: 's16' });
    expect(plan(mono, convert('opus', 'size')).outputs[0].capBytes).toBe(Math.ceil(48_000 * 60 / 8 * 1.2 + MIB16));
    // In a video, the re-encoded track counts at its rate.
    const kept = { ...defaultCompressSettings('h264'), container: 'mp4', discardIfNotSmaller: false } as const;
    const value = media({ video: [video(0, 0)], audio: [audio(1, 0, 'flac', { sampleFormat: 's16', default: true })], sizeBytes: 1_000_000 });
    expect(plan(value, kept).outputs[0].capBytes).toBe(Math.ceil((1.0 * 1920 * 1080 * 24 + 160_000) * 60 / 8 * 1.05 + MIB16));
  });
});
