import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_DEMUXERS, MediaProber, PROBE_POLICY, assessAssEvents, containerIdentity, hasRejectedExtension, isSilk, needsFirstFrame, normalizeProbe,
  pixelFormatInfo, probeArgs, probeCacheKey, readMatroskaDocType, usableObjectIdentity, withFirstFrame, type ProbeFileState, type ProbedFile,
} from '../../electron/main/media-converter/engine/probe';
import { MediaRuntime, MediaRuntimeError, runtimeFailureCode, selectMediaTools, type MediaRunLimits, type MediaRunResult, type MediaTool,
  type MediaToolRunner } from '../../electron/main/media-converter/engine/runtime';
import { ENGINE_REASON_CODES, mediaInfoSchema, probeFailureCodeSchema, type MediaInfo } from '../../src/media-converter/contract';

const FIXTURES = path.join(process.cwd(), 'test', 'media-converter', 'fixtures', 'probe');
type Fixture = { file: ProbedFile; ffprobe: unknown; firstFrame?: unknown };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const script = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

/** A fixture as the prober would leave it: normalized, with the first frame read when the video is PQ/HLG. */
function info(name: string): MediaInfo {
  const { file, ffprobe, firstFrame } = fixture(name);
  const outcome = normalizeProbe(ffprobe, file);
  if (!outcome.ok) throw new Error(`${name}: ${outcome.code}`);
  expect(mediaInfoSchema.parse(outcome.info)).toEqual(outcome.info);
  return firstFrame && needsFirstFrame(outcome.info) ? withFirstFrame(outcome.info, firstFrame) : outcome.info;
}
const primary = (value: MediaInfo) => value.video.find(stream => stream.index === value.primaryVideoIndex)!;

describe('the runtime without a staged bundle', () => {
  it('refuses every platform but Windows without touching the runtime', async () => {
    let verified = 0;
    const runtime = new MediaRuntime({ environment: { mode: 'development', appRoot: process.cwd() }, workingDirectory: path.join(os.tmpdir(), 'unused'),
      platform: 'darwin', verifyRuntime: async () => { verified++; throw new Error('must not verify'); } });
    await expect(runtime.acquire()).rejects.toMatchObject({ code: 'platform_unsupported' });
    expect(runtime.status()).toEqual({ state: 'unavailable', code: 'platform_unsupported' });
    expect(await new MediaProber({ runtime }).probe(path.join(FIXTURES, 'portrait.json'))).toEqual({ ok: false, code: 'platform_unsupported' });
    expect(verified).toBe(0);
  });

  it('maps verification failures to runtime reason codes', () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    expect(runtimeFailureCode(coded('media_runtime_missing'))).toBe('runtime_missing');
    expect(runtimeFailureCode(coded('runtime_missing'))).toBe('runtime_missing');
    expect(runtimeFailureCode(coded('media_runtime_invalid'))).toBe('runtime_invalid');
    expect(runtimeFailureCode(coded('runtime_protocol_mismatch'))).toBe('runtime_invalid');
    expect(runtimeFailureCode(coded('unsupported_architecture'))).toBe('platform_unsupported');
    expect(runtimeFailureCode(new TypeError('anything else'))).toBe('runtime_invalid');
    expect(runtimeFailureCode(new MediaRuntimeError('runtime_version_mismatch', 'x'))).toBe('runtime_version_mismatch');
  });

  it('accepts only a branded runtime proof', () => {
    const forged = { scope: 'media', noPathFallback: true, ready: true, target: { platform: 'win32', arch: 'x64' }, artifactPaths: {} };
    expect(() => selectMediaTools(forged)).toThrow(expect.objectContaining({ code: 'runtime_invalid' }));
  });
});

describe('the reason codes', () => {
  it('form one closed list without duplicates, and every probe failure is one of them', () => {
    expect(new Set(ENGINE_REASON_CODES).size).toBe(ENGINE_REASON_CODES.length);
    for (const code of probeFailureCodeSchema.options) expect(ENGINE_REASON_CODES).toContain(code);
    expect(ENGINE_REASON_CODES.every(code => /^[a-z]+(?:_[a-z0-9]+)*$/.test(code))).toBe(true);
  });
});

describe('normalizing ffprobe output', () => {
  it('turns a portrait phone video upright through its Display Matrix and ignores the metadata track', () => {
    const value = info('portrait.json');
    expect(value).toMatchObject({ kind: 'video', primaryVideoIndex: 0, sizeBytes: 48211337, durationUs: 12_010_000, durationSource: 'format', bitRate: 32114461,
      container: { demuxer: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'qt', matroskaDocType: null, extension: 'mov', identity: 'mov' },
      dataStreams: 1, attachments: 0, chapters: 0, covers: [] });
    expect(primary(value)).toMatchObject({ index: 0, typeIndex: 0, codec: 'hevc', width: 1920, height: 1080, rotation: 90, fps: 30, isVfr: false,
      bitDepth: 8, chromaSubsampling: '420', colorRange: 'tv', fieldOrder: 'progressive', language: null, title: null, default: true, hdr: { format: 'none' } });
    expect(value.audio).toEqual([expect.objectContaining({ index: 1, typeIndex: 0, codec: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 44100,
      bitRate: 173651, bitRateSource: 'stream', language: null })]);
  });

  it('ignores the legacy rotate tag (ffmpeg 8 does not turn by it), and reads an unknown aspect ratio and full range from yuvj', () => {
    // An MP4 with only the old QuickTime-era `rotate` tag: ffmpeg decodes it unturned, so the shown picture is 1280×720.
    const video = primary(info('portrait-legacy-tag.json'));
    expect(video).toMatchObject({ rotation: 0, width: 1280, height: 720, sampleAspectRatio: null, pixFmt: 'yuvj420p', colorRange: 'pc', bitDepth: 8, language: 'eng' });
    expect(info('portrait-legacy-tag.json').container.identity).toBe('mp4');
    // The same for Matroska's upper-case ROTATE tag, as `-metadata:s:v rotate=90` writes it (real ffprobe output, bundled n8.1.2).
    expect(primary(info('rotate-tag-mkv.json'))).toMatchObject({ rotation: 0, width: 320, height: 180, codec: 'h264' });
  });

  it('takes the rotation from the Display Matrix alone, whatever a rotate tag says', () => {
    const { file, ffprobe } = fixture('portrait.json');
    const withMatrix = (rotation: number | null, tags: Record<string, string>) => {
      const copy = structuredClone(ffprobe) as { streams: { side_data_list?: unknown[]; tags?: Record<string, string> }[] };
      copy.streams[0].tags = { ...copy.streams[0].tags, ...tags };
      copy.streams[0].side_data_list = rotation === null ? [] : [{ side_data_type: 'Display Matrix', rotation }];
      const outcome = normalizeProbe(copy, file);
      if (!outcome.ok) throw new Error(outcome.code);
      return primary(outcome.info).rotation;
    };
    // The matrix's counter-clockwise -90 is a clockwise 90; a tag that disagrees changes nothing.
    expect(withMatrix(-90, { rotate: '180' })).toBe(90);
    expect(withMatrix(90, { ROTATE: '90' })).toBe(270);
    expect(withMatrix(180, {})).toBe(180);
    expect(withMatrix(-180, { rotate: '0' })).toBe(180);
    // No matrix: no rotation, tag or not.
    for (const tags of [{ rotate: '90' }, { ROTATE: '270' }, { rotate: '-90' }, {}] as Record<string, string>[]) expect(withMatrix(null, tags)).toBe(0);
  });

  it('reads HDR10 static metadata from the first frame', () => {
    const value = info('hdr10.json');
    expect(needsFirstFrame(value)).toBe(true);
    expect(primary(value)).toMatchObject({ codec: 'hevc', profile: 'Main 10', bitDepth: 10, colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc',
      bitRate: 15832101, durationUs: 3_492_106_000, fps: 23.976024 });
    expect(primary(value).hdr).toEqual({ format: 'hdr10', dolbyVision: null,
      masteringDisplay: { primaries: { red: { x: 0.68, y: 0.32 }, green: { x: 0.265, y: 0.69 }, blue: { x: 0.15, y: 0.06 }, whitePoint: { x: 0.3127, y: 0.329 } },
        luminance: { min: 0.005, max: 1000 } },
      contentLight: { maxCll: 1000, maxFall: 400 } });
    // The audio bit rate is missing from the stream; Matroska's BPS tag stands in.
    expect(value.audio[0]).toMatchObject({ codec: 'eac3', channels: 6, channelLayout: '5.1(side)', bitRate: 640000, bitRateSource: 'tag', language: 'eng', title: 'Surround 5.1' });
    expect(value).toMatchObject({ chapters: 2, container: { identity: 'matroska', matroskaDocType: 'matroska' } });
  });

  it('recognizes HLG and keeps the static metadata empty when the frame has none', () => {
    const value = info('hlg.json');
    expect(needsFirstFrame(value)).toBe(true);
    expect(primary(value).hdr).toEqual({ format: 'hlg', dolbyVision: null, masteringDisplay: null, contentLight: null });
    expect(value.container.identity).toBe('mov');
  });

  it('recognizes Dolby Vision profile 5 from the stream side data although the transfer is unknown', () => {
    const value = info('dv5.json');
    const video = primary(value);
    expect(video.colorTransfer).toBeNull();
    expect(needsFirstFrame(value)).toBe(false);
    expect(video.hdr).toEqual({ format: 'dolby_vision', masteringDisplay: null, contentLight: null,
      dolbyVision: { profile: 5, level: 6, compatibilityId: 0, compatible: false, rpuPresent: true, elPresent: false, blPresent: true } });
    expect(value.container.identity).toBe('mp4');
  });

  it('marks Dolby Vision profile 8.1 compatible and prefers the stream metadata over the first frame', () => {
    const video = primary(info('dv8.json'));
    expect(video.hdr.format).toBe('dolby_vision');
    expect(video.hdr.dolbyVision).toMatchObject({ profile: 8, compatibilityId: 1, compatible: true });
    expect(video.hdr.contentLight).toEqual({ maxCll: 1103, maxFall: 192 });
    expect(video.hdr.masteringDisplay?.luminance).toEqual({ min: 0.0001, max: 4000 });
    expect(video.colorTransfer).toBe('smpte2084');
    expect(info('dv8.json').audio[0]).toMatchObject({ codec: 'truehd', channels: 8, bitsPerRawSample: 24, sampleFormat: 's32' });
  });

  it('flags variable frame rate and keeps a negative start time', () => {
    const value = info('vfr.json');
    expect(primary(value)).toMatchObject({ rFrameRate: '30/1', avgFrameRate: '29127/1000', fps: 29.127, isVfr: true, colorRange: 'pc' });
    expect(value.startTimeUs).toBe(-21_333);
    expect(value.audio[0]).toMatchObject({ channels: 1, channelLayout: 'mono' });
  });

  it('treats cover art as a cover, so audio with a cover is an audio file', () => {
    for (const [name, identity, codec] of [['cover-mp3.json', 'mp3', 'mjpeg'], ['cover-m4a.json', 'm4a', 'png']] as const) {
      const value = info(name);
      expect(value).toMatchObject({ kind: 'audio', primaryVideoIndex: null, video: [], container: { identity } });
      expect(value.covers).toEqual([{ index: 1, typeIndex: 0, codec, width: codec === 'png' ? 1000 : 600, height: codec === 'png' ? 1000 : 600 }]);
    }
    expect(info('cover-m4a.json').audio[0].language).toBe('jpn');
  });

  it('sorts subtitles into text, image and other, with their flags and per-type positions', () => {
    const value = info('pgs.json');
    expect(value.subtitles.map(({ index, typeIndex, codec, kind, forced, default: isDefault, hearingImpaired, styled }) =>
      ({ index, typeIndex, codec, kind, forced, isDefault, hearingImpaired, styled }))).toEqual([
      { index: 3, typeIndex: 0, codec: 'hdmv_pgs_subtitle', kind: 'image', forced: true, isDefault: false, hearingImpaired: false, styled: null },
      { index: 4, typeIndex: 1, codec: 'subrip', kind: 'text', forced: false, isDefault: true, hearingImpaired: true, styled: null },
      { index: 5, typeIndex: 2, codec: 'dvd_subtitle', kind: 'image', forced: false, isDefault: false, hearingImpaired: false, styled: null },
      { index: 6, typeIndex: 3, codec: 'eia_608', kind: 'other', forced: false, isDefault: false, hearingImpaired: false, styled: null },
    ]);
    expect(value.audio.map(stream => [stream.index, stream.typeIndex, stream.bitRate, stream.bitRateSource, stream.title])).toEqual([
      [1, 0, 3_500_000, 'tag', null], [2, 1, 192_000, 'stream', 'Commentary']]);
    expect(primary(value)).toMatchObject({ bitRate: 30_000_000, durationUs: 7_200_000_000 });
    expect(value).toMatchObject({ attachments: 1, chapters: 3 });
  });

  it('counts ASS streams as styled until their events are read', () => {
    const value = info('ass.json');
    expect(value.subtitles.map(stream => [stream.index, stream.codec, stream.kind, stream.styled, stream.language, stream.title])).toEqual([
      [2, 'ass', 'text', true, 'eng', 'Full Subtitles [Group]'], [3, 'ass', 'text', true, 'chi', '简体中文']]);
    expect(value.attachments).toBe(2);
    expect(value.audio[0]).toMatchObject({ codec: 'flac', bitRate: 918000, bitRateSource: 'tag', bitsPerRawSample: 16 });
  });

  it('tells WebM from Matroska by DocType', () => {
    expect(info('webm.json').container).toEqual({ demuxer: 'matroska', formatName: 'matroska,webm', majorBrand: null, matroskaDocType: 'webm', extension: 'webm', identity: 'webm' });
    const { ffprobe } = fixture('webm.json');
    const identity = (name: string, matroskaDocType: string | null) => {
      const outcome = normalizeProbe(ffprobe, { name, sizeBytes: 1, matroskaDocType });
      return outcome.ok ? outcome.info.container.identity : outcome.code;
    };
    expect(identity('renamed.mkv', 'webm')).toBe('webm');
    expect(identity('renamed.webm', 'matroska')).toBe('matroska');
    expect(identity('unread.webm', null)).toBe('webm');
    expect(identity('unread.mkv', null)).toBe('matroska');
  });

  it('keeps the start offset of an MPEG-TS and the field order of interlaced video', () => {
    const value = info('ts-offset.json');
    expect(value).toMatchObject({ startTimeUs: 1_400_000, durationUs: 10_010_000, durationSource: 'format', container: { demuxer: 'mpegts', identity: 'mpegts' } });
    expect(primary(value)).toMatchObject({ fieldOrder: 'tt', sampleAspectRatio: '4:3', fps: 29.97003 });
    expect(value.audio.map(stream => [stream.index, stream.typeIndex, stream.language])).toEqual([[1, 0, 'jpn'], [2, 1, 'eng']]);
  });

  it('leaves the duration unknown when nothing reports one, and falls back to the DURATION tag', () => {
    expect(info('no-duration.json')).toMatchObject({ kind: 'video', durationUs: null, durationSource: null, bitRate: null, container: { identity: 'h264' } });
    const tagged = info('tag-duration.json');
    expect(tagged).toMatchObject({ kind: 'audio', durationUs: 64_500_000, durationSource: 'tag', container: { identity: 'matroska' } });
    expect(tagged.audio[0]).toMatchObject({ bitRate: null, bitRateSource: null, durationUs: 64_500_000 });
  });

  it('refuses files without audio or a main video, and demuxers outside the allow list', () => {
    const outcome = (name: string) => { const value = fixture(name); return normalizeProbe(value.ffprobe, value.file); };
    expect(outcome('attachments-only.json')).toEqual({ ok: false, code: 'no_media_streams' });
    expect(outcome('playlist-format.json')).toEqual({ ok: false, code: 'container_not_allowed' });
  });

  it('refuses malformed output', () => {
    const file = { name: 'x.mp4', sizeBytes: 1, matroskaDocType: null };
    const { ffprobe } = fixture('vfr.json') as { ffprobe: { streams: Record<string, unknown>[]; format: unknown } };
    expect(normalizeProbe(null, file)).toEqual({ ok: false, code: 'probe_failed' });
    expect(normalizeProbe({ streams: [] }, file)).toEqual({ ok: false, code: 'probe_failed' });
    expect(normalizeProbe({ error: { code: -1094995529, string: 'Invalid data found when processing input' }, format: {} }, file)).toEqual({ ok: false, code: 'probe_failed' });
    expect(normalizeProbe({ ...ffprobe, streams: [ffprobe.streams[0], { ...ffprobe.streams[1], index: 0 }] }, file)).toEqual({ ok: false, code: 'probe_failed' });
    const many = Array.from({ length: PROBE_POLICY.maxStreams + 1 }, (_, index) => ({ ...ffprobe.streams[1], index }));
    expect(normalizeProbe({ ...ffprobe, streams: many }, file)).toEqual({ ok: false, code: 'probe_failed' });
  });

  it('treats an implausible bit rate as unknown instead of refusing the file', () => {
    const { ffprobe } = fixture('vfr.json') as { ffprobe: { streams: Record<string, unknown>[]; format: Record<string, unknown> } };
    // A damaged header claims one microsecond for 2 GB, and the streams claim 5 Tbit/s.
    const damaged = { ...ffprobe, format: { ...ffprobe.format, duration: '0.000001', bit_rate: undefined },
      streams: ffprobe.streams.map(stream => ({ ...stream, bit_rate: '5000000000000', tags: { BPS: '6000000000000' } })) };
    const outcome = normalizeProbe(damaged, { name: 'damaged.mp4', sizeBytes: 2_000_000_000, matroskaDocType: null });
    if (!outcome.ok) throw new Error(outcome.code);
    expect(outcome.info).toMatchObject({ durationUs: 1, bitRate: null });
    expect(outcome.info.video[0].bitRate).toBeNull();
    expect(outcome.info.audio[0]).toMatchObject({ bitRate: null, bitRateSource: null });
  });
});

describe('container identity', () => {
  it.each([
    ['mov', 'qt  ', null, 'mov', 'mov'], ['mov', 'isom', null, 'mov', 'mp4'], ['mov', 'iso2', null, 'mp4', 'mp4'], ['mov', 'mp41', null, 'mp4', 'mp4'],
    ['mov', 'mp42', null, 'm4v', 'mp4'], ['mov', 'avc1', null, 'mp4', 'mp4'], ['mov', 'M4A ', null, 'mp4', 'm4a'], ['mov', 'M4B ', null, 'm4b', 'm4a'],
    ['mov', 'iso5', null, 'mp4', 'mp4'], ['mov', 'iso5', null, 'mov', 'mov'], ['mov', '3gp4', null, '3gp', '3gp'], ['mov', null, null, 'bin', 'unknown'],
    ['matroska', null, 'webm', 'mkv', 'webm'], ['matroska', null, 'matroska', 'webm', 'matroska'], ['matroska', null, null, 'mka', 'matroska'],
    ['matroska', null, null, 'mp4', 'unknown'], ['ogg', null, null, 'opus', 'opus'], ['ogg', null, null, 'ogg', 'ogg'],
    // A transport stream named .mp4 is still a transport stream.
    ['mpegts', null, null, 'mp4', 'mpegts'], ['mp3', null, null, 'mp3', 'mp3'], ['wav', null, null, 'wav', 'wav'],
  ] as const)('%s with brand %j, DocType %j and extension %s is %s', (demuxer, majorBrand, matroskaDocType, extension, expected) => {
    expect(containerIdentity({ demuxer, majorBrand, matroskaDocType, extension })).toBe(expected);
  });
});

describe('checks before ffprobe runs', () => {
  it('refuses playlist and session extensions, whatever their case', () => {
    for (const name of ['a.m3u8', 'B.M3U', 'c.mpd', 'd.ffconcat', 'e.sdp', 'f.txt', 'C:\\x\\LIST.M3U8']) expect(hasRejectedExtension(name)).toBe(true);
    for (const name of ['a.mp4', 'b.mkv', 'c.m3u8.mp4', 'txt', 'd.mts']) expect(hasRejectedExtension(name)).toBe(false);
  });

  it('recognizes WeChat SILK with and without the leading byte', () => {
    expect(isSilk(Buffer.from('#!SILK_V3\x0c\x00'))).toBe(true);
    expect(isSilk(Buffer.from('\x02#!SILK_V3\x0c', 'latin1'))).toBe(true);
    expect(isSilk(Buffer.from('#!AMR\n'))).toBe(false);
    expect(isSilk(Buffer.from('#!SILK'))).toBe(false);
    expect(isSilk(new Uint8Array())).toBe(false);
  });

  it('reads the DocType of an EBML header', () => {
    // The first bytes of a WebM written by the bundled ffmpeg.
    const webm = Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701', 'hex');
    expect(readMatroskaDocType(webm)).toBe('webm');
    const matroska = Buffer.concat([Buffer.from('1a45dfa3a3', 'hex'), Buffer.from('4286810142f7810142f2810442f3810842828' + '8', 'hex'),
      Buffer.from('matroska', 'latin1'), Buffer.from('4287810442858102', 'hex')]);
    expect(readMatroskaDocType(matroska)).toBe('matroska');
    expect(readMatroskaDocType(webm.subarray(0, 26))).toBeNull();
    expect(readMatroskaDocType(Buffer.from('000000206674797069736f6d', 'hex'))).toBeNull();
    expect(readMatroskaDocType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toBeNull();
  });
});

describe('pixel formats', () => {
  it.each([
    ['yuv420p', 8, '420'], ['yuvj420p', 8, '420'], ['yuv420p10le', 10, '420'], ['yuv422p10le', 10, '422'], ['yuv444p12le', 12, '444'], ['yuva420p', 8, '420'],
    ['yuv411p', 8, '411'], ['yuv440p', 8, '440'], ['nv12', 8, '420'], ['nv16', 8, '422'], ['nv20le', 10, '422'], ['nv24', 8, '444'], ['p010le', 10, '420'],
    ['p016le', 16, '420'], ['p210le', 10, '422'], ['p410le', 10, '444'], ['y210le', 10, '422'], ['yuyv422', 8, '422'], ['uyvy422', 8, '422'],
    ['gray', 8, '400'], ['gray10le', 10, '400'], ['grayf32le', 32, '400'], ['gbrp', 8, '444'], ['gbrp10le', 10, '444'], ['gbrpf32le', 32, '444'],
    ['rgb24', 8, '444'], ['rgb48le', 16, '444'], ['x2rgb10le', 10, '444'], ['xv30le', 10, '444'], ['pal8', 8, '444'],
  ] as const)('%s is %i-bit %s', (pixFmt, bitDepth, chroma) => {
    expect(pixelFormatInfo(pixFmt)).toEqual({ bitDepth, chroma });
  });
  it('knows nothing of unlisted formats, so the raw sample depth decides', () => {
    expect(pixelFormatInfo('bayer_rggb8')).toBeNull();
    expect(pixelFormatInfo(null)).toBeNull();
  });
});

describe('ASS/SSA styling', () => {
  it.each([
    ['ass-plain.ass', { parsed: true, events: 3, styled: false }],
    ['ass-positioned.ass', { parsed: true, events: 2, styled: true }],
    ['ass-overlap.ass', { parsed: true, events: 3, styled: true }],
    ['ass-two-styles.ass', { parsed: true, events: 2, styled: true }],
    ['ass-top-style.ass', { parsed: true, events: 1, styled: true }],
    ['ssa-legacy.ssa', { parsed: true, events: 2, styled: true }],
    ['ass-unreadable.ass', { parsed: false, events: 0, styled: true }],
  ])('%s', (name, expected) => {
    expect(assessAssEvents(script(name))).toEqual(expected);
  });

  it('looks at the first 200 events only', () => {
    const plain = script('ass-plain.ass').split('[Events]')[0];
    const line = (i: number, text: string) => `Dialogue: 0,0:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.00,` +
      `0:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.50,Default,,0,0,0,,${text}`;
    const events = Array.from({ length: 250 }, (_, i) => line(i, i === 220 ? '{\\an8}Late sign' : `Line ${i}`));
    const text = `${plain}[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
    expect(assessAssEvents(text)).toEqual({ parsed: true, events: 200, styled: false });
    expect(assessAssEvents(text, 250)).toEqual({ parsed: true, events: 250, styled: true });
  });

  it('a dialogue line without a valid time counts as unreadable', () => {
    expect(assessAssEvents(script('ass-plain.ass').replace('0:00:03.00,0:00:05.50', 'soon,later'))).toMatchObject({ parsed: false, styled: true });
  });
});

describe('probe cache identity', () => {
  const identities = fixture('fileid-zero.json') as unknown as Record<string, { path: string; state: ProbeFileState }>;
  const key = (name: string, platform = 'win32') => probeCacheKey(identities[name].path, identities[name].state, platform);

  it('uses volume and file ID when they identify the file', () => {
    expect(usableObjectIdentity(identities.ntfs.state.objectIdentity)).toBe(true);
    expect(key('ntfs')).toBe('id:b04f12aa:0000000000000000000b00000003c1d2:1048576:1792000000000.5');
    // A hard link is the same file under another name.
    expect(key('ntfsHardLink')).toBe(key('ntfs'));
  });

  it('falls back to the normalized path when the FileId is all zeros or unavailable', () => {
    expect(usableObjectIdentity(identities.exfatA.state.objectIdentity)).toBe(false);
    expect(key('exfatA')).toBe('path:e:\\videos\\clip.mp4:1048576:1792000000000.5');
    // Two different files on exFAT with the same size and time do not share a result.
    expect(key('exfatB')).not.toBe(key('exfatA'));
    // Windows paths are compared without regard to case.
    expect(key('exfatACase')).toBe(key('exfatA'));
    expect(key('unavailable')).toMatch(/^path:\\\\server\\share\\clip\.mp4:/);
  });

  it('changes with the size or the modification time', () => {
    const { path: filePath, state } = identities.ntfs;
    expect(probeCacheKey(filePath, { ...state, size: state.size + 1 }, 'win32')).not.toBe(key('ntfs'));
    expect(probeCacheKey(filePath, { ...state, mtimeMs: state.mtimeMs + 1 }, 'win32')).not.toBe(key('ntfs'));
    const exfat = identities.exfatA;
    expect(probeCacheKey(exfat.path, { ...exfat.state, mtimeMs: 1 }, 'win32')).not.toBe(key('exfatA'));
  });
});

// ── The prober, with a scripted runner instead of ffprobe ───────────────────────────────────────

const ok = (stdout: string | Buffer, stderr = ''): MediaRunResult => Object.freeze({ status: 'closed', spawned: true, exitCode: 0, signalCode: null,
  stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), aborted: false, timedOut: false, outputExceeded: false, closeConfirmed: Promise.resolve() });
const failed = (stderr: string, overrides: Partial<MediaRunResult> = {}): MediaRunResult => ({ ...ok('', stderr), exitCode: 1, ...overrides });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Call = { tool: MediaTool; args: readonly string[]; limits: MediaRunLimits };
/** Answers by file name: the main probe, the first frame, and the ASS events of each stream. */
class ScriptedRunner implements MediaToolRunner {
  calls: Call[] = [];
  live = 0;
  peak = 0;
  constructor(private readonly answer: (call: Call, file: string) => MediaRunResult | Promise<MediaRunResult>) {}
  async run(tool: MediaTool, args: readonly string[], limits: MediaRunLimits) {
    const call = { tool, args, limits };
    this.calls.push(call);
    this.peak = Math.max(this.peak, ++this.live);
    try { return await this.answer(call, path.basename(args.find(arg => arg.startsWith('file:'))!.slice(5))); }
    finally { this.live--; }
  }
  main() { return this.calls.filter(call => call.args.includes('-show_streams')); }
}

describe('probing files', () => {
  let root: string;
  const file = async (name: string, content: string | Buffer = 'media bytes') => {
    const target = path.join(root, name);
    await writeFile(target, content);
    return target;
  };
  const json = (name: string) => JSON.stringify(fixture(name).ffprobe);
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'media-converter-probe-'))); });
  afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  it('refuses playlists by extension without reading them or starting ffprobe', async () => {
    const runner = new ScriptedRunner(() => { throw new Error('ffprobe must not run'); });
    const prober = new MediaProber({ runtime: runner });
    for (const name of ['list.m3u8', 'LIST.M3U', 'manifest.mpd', 'join.ffconcat', 'stream.sdp', 'files.txt']) {
      expect(await prober.probe(await file(name, '#EXTM3U\n'))).toEqual({ ok: false, code: 'container_not_allowed' });
    }
    expect(await prober.probe(path.join(root, 'absent.m3u8'))).toEqual({ ok: false, code: 'container_not_allowed' });
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses WeChat SILK by its header without starting ffprobe', async () => {
    const runner = new ScriptedRunner(() => { throw new Error('ffprobe must not run'); });
    const prober = new MediaProber({ runtime: runner });
    expect(await prober.probe(await file('voice.amr', Buffer.from('#!SILK_V3\x0c\x00\x45', 'latin1')))).toEqual({ ok: false, code: 'wechat_silk_unsupported' });
    expect(await prober.probe(await file('voice.slk', Buffer.from('\x02#!SILK_V3\x0c\x00', 'latin1')))).toEqual({ ok: false, code: 'wechat_silk_unsupported' });
    expect(runner.calls).toHaveLength(0);
  });

  it('restricts every ffprobe input to the media demuxers and the file protocol', async () => {
    const target = await file('clip.mp4');
    const runner = new ScriptedRunner(() => ok(json('vfr.json')));
    const outcome = await new MediaProber({ runtime: runner }).probe(target);
    expect(outcome.ok).toBe(true);
    const [call] = runner.calls;
    expect(call.tool).toBe('ffprobe');
    expect(call.args).toEqual(probeArgs(target));
    expect(call.args.slice(call.args.indexOf('-format_whitelist'), call.args.indexOf('-format_whitelist') + 4))
      .toEqual(['-format_whitelist', ALLOWED_DEMUXERS.join(','), '-protocol_whitelist', 'file']);
    expect(call.args).toEqual(expect.arrayContaining(['-show_format', '-show_streams', '-show_chapters', '-of', 'json']));
    expect(call.args.at(-1)).toBe(`file:${target}`);
    expect(call.limits).toMatchObject({ timeoutMs: 30_000, stdoutMaxBytes: 4 * 1024 * 1024 });
    for (const excluded of ['hls', 'dash', 'concat', 'sdp', 'tee', 'image2', 'lavfi', 'webm_dash_manifest']) expect(ALLOWED_DEMUXERS).not.toContain(excluded);
    expect(ALLOWED_DEMUXERS.some(name => name.endsWith('_pipe'))).toBe(false);
  });

  it('reads the first frame of PQ video with the probed demuxer pinned, and skips it for SDR', async () => {
    const hdr = fixture('hdr10.json');
    const runner = new ScriptedRunner((call, name) => call.args.includes('-show_frames') ? ok(JSON.stringify(hdr.firstFrame))
      : ok(name === 'hdr.mkv' ? json('hdr10.json') : json('portrait.json')));
    const prober = new MediaProber({ runtime: runner });
    const outcome = await prober.probe(await file('hdr.mkv'));
    if (!outcome.ok) throw new Error(outcome.code);
    expect(primary(outcome.info).hdr.masteringDisplay?.luminance).toEqual({ min: 0.005, max: 1000 });
    expect(primary(outcome.info).hdr.contentLight).toEqual({ maxCll: 1000, maxFall: 400 });
    const frame = runner.calls[1];
    expect(frame.tool).toBe('ffprobe');
    const input = frame.args.length - 1;
    expect(frame.args.slice(frame.args.indexOf('-f'), frame.args.indexOf('-f') + 2)).toEqual(['-f', 'matroska']);
    expect(frame.args.indexOf('-f')).toBeLessThan(input);
    expect(frame.args).toEqual(expect.arrayContaining(['-format_whitelist', ALLOWED_DEMUXERS.join(','), '-protocol_whitelist', 'file',
      '-select_streams', '0', '-read_intervals', '%+#1', '-show_frames']));
    runner.calls = [];
    expect((await prober.probe(await file('sdr.mov'))).ok).toBe(true);
    expect(runner.calls.map(call => call.args.includes('-show_frames'))).toEqual([false]);
  });

  it('reads the events of each ASS stream to decide whether it is styled', async () => {
    const scripts: Record<string, MediaRunResult> = { '0:2': ok(script('ass-positioned.ass')), '0:3': ok(script('ass-plain.ass')) };
    const runner = new ScriptedRunner(call => call.tool === 'ffmpeg' ? scripts[call.args[call.args.indexOf('-map') + 1]] : ok(json('ass.json')));
    const outcome = await new MediaProber({ runtime: runner }).probe(await file('episode.mkv'));
    if (!outcome.ok) throw new Error(outcome.code);
    expect(outcome.info.subtitles.map(stream => [stream.index, stream.styled])).toEqual([[2, true], [3, false]]);
    const extract = runner.calls.find(call => call.tool === 'ffmpeg')!;
    const at = (flag: string) => extract.args.indexOf(flag);
    expect(extract.args.slice(at('-f'), at('-f') + 2)).toEqual(['-f', 'matroska']);
    expect(at('-f')).toBeLessThan(at('-i'));
    expect(at('-format_whitelist')).toBeLessThan(at('-i'));
    expect(extract.args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-c:s', 'copy', '-frames:s', '200', 'pipe:1']));
    expect(extract.args.slice(-3)).toEqual(['-f', 'ass', 'pipe:1']);
  });

  it('counts an ASS stream as styled when its events cannot be read in full', async () => {
    const answers: Record<string, MediaRunResult> = {
      '0:2': failed('Error opening input'),
      '0:3': { ...ok(script('ass-plain.ass')), status: 'closed', exitCode: null, timedOut: true },
    };
    const runner = new ScriptedRunner(call => call.tool === 'ffmpeg' ? answers[call.args[call.args.indexOf('-map') + 1]] : ok(json('ass.json')));
    const outcome = await new MediaProber({ runtime: runner }).probe(await file('broken-subs.mkv'));
    if (!outcome.ok) throw new Error(outcome.code);
    expect(outcome.info.subtitles.map(stream => stream.styled)).toEqual([true, true]);
  });

  it('maps ffprobe refusals and failures to reason codes', async () => {
    const cases: [string, MediaRunResult | Error, string][] = [
      ['concat.mp4', failed("[concat @ 000001] Format not on whitelist 'mov,matroska'\nfile:x: Invalid argument\n"), 'container_not_allowed'],
      ['hls.mp4', failed('Not detecting m3u8/hls with non standard extension and non standard mime type\n'), 'container_not_allowed'],
      ['garbage.mp4', failed('file:x: Invalid data found when processing input\n'), 'probe_failed'],
      ['slow.mp4', { ...ok(''), exitCode: null, timedOut: true }, 'probe_failed'],
      ['huge.mp4', { ...ok('{"streams":['), outputExceeded: true }, 'probe_failed'],
      ['notjson.mp4', ok('{"streams":'), 'probe_failed'],
      ['nostreams.mkv', ok(json('attachments-only.json')), 'no_media_streams'],
      ['runtime.mp4', new MediaRuntimeError('runtime_spawn_failed', 'x'), 'runtime_spawn_failed'],
      ['damaged.mp4', new MediaRuntimeError('runtime_invalid', 'x'), 'runtime_invalid'],
    ];
    for (const [name, answer, code] of cases) {
      const runner = new ScriptedRunner(() => { if (answer instanceof Error) throw answer; return answer; });
      expect(await new MediaProber({ runtime: runner }).probe(await file(name)), name).toEqual({ ok: false, code });
    }
  });

  it('reports a missing file and anything that is not a regular file', async () => {
    const runner = new ScriptedRunner(() => ok(json('vfr.json')));
    const prober = new MediaProber({ runtime: runner });
    expect(await prober.probe(path.join(root, 'gone.mp4'))).toEqual({ ok: false, code: 'file_unavailable' });
    await mkdir(path.join(root, 'folder.mp4'), { recursive: true });
    expect(await prober.probe(path.join(root, 'folder.mp4'))).toEqual({ ok: false, code: 'not_a_regular_file' });
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a path that is not fully qualified, since ffprobe would resolve it in its own working directory', async () => {
    const runner = new ScriptedRunner(() => ok(json('vfr.json')));
    const prober = new MediaProber({ runtime: runner });
    // An existing file, named relative to this process; ffprobe would look for it elsewhere.
    const relative = path.relative(process.cwd(), await file('relative.mp4'));
    const unqualified = [...(path.isAbsolute(relative) ? [] : [relative]), 'clip.mp4',
      ...(process.platform === 'win32' ? ['\\Videos\\clip.mp4', 'C:clip.mp4'] : [])];
    for (const name of unqualified) expect(await prober.probe(name), name).toEqual({ ok: false, code: 'file_unavailable' });
    expect(runner.calls).toHaveLength(0);
  });

  it('caches results by identity, probes again after a change, and never caches a failure to run', async () => {
    let answer: MediaRunResult = ok(json('vfr.json'));
    const runner = new ScriptedRunner(() => answer);
    const prober = new MediaProber({ runtime: runner });
    const target = await file('cached.mp4');
    const first = await prober.probe(target);
    expect(await prober.probe(target)).toBe(first);
    expect(runner.main()).toHaveLength(1);
    await utimes(target, new Date(), new Date(Date.now() + 5000));
    expect((await prober.probe(target)).ok).toBe(true);
    expect(runner.main()).toHaveLength(2);

    const flaky = await file('flaky.mp4');
    answer = { ...ok(''), exitCode: null, timedOut: true };
    expect(await prober.probe(flaky)).toEqual({ ok: false, code: 'probe_failed' });
    answer = ok(json('vfr.json'));
    expect((await prober.probe(flaky)).ok).toBe(true);

    const empty = await file('empty.mkv');
    answer = ok(json('attachments-only.json'));
    expect(await prober.probe(empty)).toEqual({ ok: false, code: 'no_media_streams' });
    const before = runner.main().length;
    expect(await prober.probe(empty)).toEqual({ ok: false, code: 'no_media_streams' });
    expect(runner.main()).toHaveLength(before);
  });

  it('shares one probe between simultaneous requests for the same file', async () => {
    const runner = new ScriptedRunner(async () => { await delay(30); return ok(json('vfr.json')); });
    const prober = new MediaProber({ runtime: runner });
    const target = await file('shared.mp4');
    const [a, b] = await Promise.all([prober.probe(target), prober.probe(target)]);
    expect(a).toBe(b);
    expect(runner.main()).toHaveLength(1);
  });

  it('probes a file again when it changed while it was read, and gives up when it keeps changing', async () => {
    const growing = await file('growing.mp4');
    let writes = 1;
    const runner = new ScriptedRunner(async (_, name) => {
      if (name === 'growing.mp4' && writes-- > 0) await appendFile(growing, 'more');
      if (name === 'downloading.mp4') await appendFile(path.join(root, name), 'more');
      return ok(json('vfr.json'));
    });
    const prober = new MediaProber({ runtime: runner });
    const outcome = await prober.probe(growing);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.info.sizeBytes).toBe('media bytes'.length + 4);
    expect(runner.main()).toHaveLength(2);
    expect(await prober.probe(await file('downloading.mp4'))).toEqual({ ok: false, code: 'probe_failed' });
  });

  it('runs at most four probes at once and settles each file as soon as it is done', async () => {
    // The slow files take long enough that a busy machine (other test files running ffmpeg, a virus scanner
    // opening the new files) cannot delay a fast one past them: at 60 ms this was flaky under load.
    const runner = new ScriptedRunner(async (_, name) => { await delay(name.endsWith('0.mp4') ? 400 : 15); return ok(json('vfr.json')); });
    const prober = new MediaProber({ runtime: runner });
    const targets = await Promise.all(Array.from({ length: 24 }, (_, i) => file(`many-${i}.mp4`)));
    const settled: string[] = [];
    const outcomes = await Promise.all(targets.map(target => prober.probe(target).then(outcome => { settled.push(path.basename(target)); return outcome; })));
    expect(outcomes.every(outcome => outcome.ok)).toBe(true);
    expect(runner.peak).toBe(4);
    // Slow files do not hold back the others: results arrive in completion order, not request order.
    expect(settled).not.toEqual(targets.map(target => path.basename(target)));
    expect(settled.indexOf('many-0.mp4')).toBeGreaterThan(settled.indexOf('many-1.mp4'));
  });

  it('stops probing once disposed', async () => {
    const runner = new ScriptedRunner(async (call) => {
      await new Promise(resolve => call.limits.signal?.addEventListener('abort', resolve, { once: true }));
      return { ...ok(''), exitCode: null, aborted: true };
    });
    const prober = new MediaProber({ runtime: runner });
    const pending = prober.probe(await file('long.mp4'));
    await delay(20);
    prober.dispose();
    expect(await pending).toEqual({ ok: false, code: 'probe_failed' });
    expect(await prober.probe(await file('later.mp4'))).toEqual({ ok: false, code: 'probe_failed' });
  });
});
