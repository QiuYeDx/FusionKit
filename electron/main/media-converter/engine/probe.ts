import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import {
  MEDIA_DEMUXERS, mediaInfoSchema,
  type AudioStreamInfo, type ChromaSubsampling, type ContainerIdentity, type CoverStreamInfo, type FieldOrder, type HdrInfo, type MasteringDisplay,
  type MediaDemuxer, type MediaInfo, type ProbeFailureCode, type SubtitleKind, type SubtitleStreamInfo, type VideoStreamInfo,
} from '../../../../src/media-converter/contract';
import { localSubtitleFileIdentityFromBigIntStats, sameLocalSubtitleFilesystemObjectIdentity,
  type LocalSubtitleFilesystemObjectIdentity } from '../../subtitle-studio/transcription/native/filesystem-object-identity';
import { MediaRuntimeError, type MediaRunLimits, type MediaRunResult, type MediaTool, type MediaToolRunner } from './runtime';

/**
 * Media probe (design §2): reject playlists by extension and WeChat SILK by header, run ffprobe
 * restricted to real media demuxers and the file protocol, read HDR10 static metadata from the
 * first frame, check ASS/SSA styling, and normalize everything into a zod-checked `MediaInfo`.
 * At most four files are probed at once; results are cached by file identity.
 */

/** Every ffprobe and ffmpeg input of the converter is limited to these demuxers (`-format_whitelist`). */
export const ALLOWED_DEMUXERS: readonly MediaDemuxer[] = MEDIA_DEMUXERS;
/** Playlists and session descriptions, refused without starting ffprobe. */
export const REJECTED_EXTENSIONS: readonly string[] = ['.m3u8', '.m3u', '.mpd', '.ffconcat', '.sdp', '.txt'];

export const PROBE_POLICY = Object.freeze({
  timeoutMs: 30_000,
  stdoutMaxBytes: 4 * 1024 * 1024,
  stderrMaxBytes: 64 * 1024,
  frameTimeoutMs: 15_000,
  frameStdoutMaxBytes: 256 * 1024,
  /** ASS/SSA: events read per stream, streams read per file (the rest count as styled), time and output per stream. */
  assEvents: 200,
  assStreams: 8,
  assTimeoutMs: 15_000,
  assStdoutMaxBytes: 1024 * 1024,
  concurrency: 4,
  /** Bytes read before ffprobe runs: the SILK header and the Matroska EBML header. */
  headBytes: 4096,
  cacheEntries: 512,
  maxStreams: 512,
});

export type ProbeOutcome = { ok: true; info: MediaInfo } | { ok: false; code: ProbeFailureCode };

const TEXT_SUBTITLES = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const IMAGE_SUBTITLES = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const MAX_MICROSECONDS = 8_640_000_000_000;
/** The contract's bound on bits per second; a larger claimed rate is unknown, not a reason to refuse the file. */
const MAX_BIT_RATE = 1_000_000_000_000;
const fail = (code: ProbeFailureCode): ProbeOutcome => ({ ok: false, code });

// ── Arguments ──────────────────────────────────────────────────────────────────────────────────

const inputGuard = () => ['-format_whitelist', ALLOWED_DEMUXERS.join(','), '-protocol_whitelist', 'file'];
/** The `file:` prefix keeps any part of a name from being read as a protocol. */
const fileUrl = (filePath: string) => `file:${filePath}`;

/** The main probe. Tests pass `debug` to see in the log which files ffprobe opened. */
export function probeArgs(inputPath: string, logLevel: 'error' | 'debug' = 'error'): string[] {
  return ['-hide_banner', '-v', logLevel, ...inputGuard(), '-show_format', '-show_streams', '-show_chapters', '-show_error', '-of', 'json', fileUrl(inputPath)];
}

/** Side data of the first frame of one stream, with the demuxer pinned to the probed one. */
export function firstFrameArgs(inputPath: string, demuxer: MediaDemuxer, streamIndex: number, logLevel: 'error' | 'debug' = 'error'): string[] {
  return ['-hide_banner', '-v', logLevel, '-f', demuxer, ...inputGuard(), '-select_streams', String(streamIndex), '-read_intervals', '%+#1',
    '-show_frames', '-show_entries', 'frame=side_data_list', '-of', 'json', fileUrl(inputPath)];
}

/** The first ASS/SSA events of one stream, copied out as an .ass script on stdout. */
export function assEventArgs(inputPath: string, demuxer: MediaDemuxer, streamIndex: number): string[] {
  return ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-f', demuxer, ...inputGuard(), '-i', fileUrl(inputPath),
    '-map', `0:${streamIndex}`, '-c:s', 'copy', '-frames:s', String(PROBE_POLICY.assEvents), '-f', 'ass', 'pipe:1'];
}

// ── Pre-checks ─────────────────────────────────────────────────────────────────────────────────

export const hasRejectedExtension = (fileName: string) => REJECTED_EXTENSIONS.includes(path.extname(fileName).toLowerCase());

const SILK = Buffer.from('#!SILK_V3', 'latin1');
/** WeChat voice: `#!SILK_V3`, or the same after one 0x02 byte. */
export function isSilk(head: Uint8Array): boolean {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  return bytes.subarray(0, SILK.length).equals(SILK) || (bytes[0] === 0x02 && bytes.subarray(1, 1 + SILK.length).equals(SILK));
}

/** An EBML variable-size integer at `offset`: its byte length and value, with (`marker`) or without the length marker. */
function vint(bytes: Uint8Array, offset: number, marker: boolean): { length: number; value: number } | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || offset + length > bytes.length) return null;
  let value = marker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i];
    allOnes &&= bytes[offset + i] === 0xff;
  }
  return marker || !allOnes ? { length, value } : null;
}

/** The DocType of a Matroska EBML header (`matroska`, `webm`); ffprobe does not report it. */
export function readMatroskaDocType(head: Uint8Array): string | null {
  if (head.length < 5 || head[0] !== 0x1a || head[1] !== 0x45 || head[2] !== 0xdf || head[3] !== 0xa3) return null;
  const size = vint(head, 4, false);
  if (!size) return null;
  let offset = 4 + size.length;
  const end = Math.min(head.length, offset + size.value);
  while (offset < end) {
    const id = vint(head, offset, true);
    const length = id && vint(head, offset + id.length, false);
    if (!id || !length) return null;
    const start = offset + id.length + length.length;
    if (id.value === 0x4282) {
      if (length.value < 1 || length.value > 32 || start + length.value > head.length) return null;
      const value = Buffer.from(head.subarray(start, start + length.value)).toString('latin1').replace(/\0+$/, '');
      return /^[\x21-\x7e]{1,32}$/.test(value) ? value.toLowerCase() : null;
    }
    offset = start + length.value;
  }
  return null;
}

// ── Container identity ─────────────────────────────────────────────────────────────────────────

const MP4_BRANDS: Readonly<Record<string, ContainerIdentity>> = { qt: 'mov', isom: 'mp4', iso2: 'mp4', mp41: 'mp4', mp42: 'mp4', avc1: 'mp4', m4a: 'm4a', m4b: 'm4a' };
/** Demuxers that read several formats: the extension picks one, but only among that family's own extensions. */
const FAMILY_EXTENSIONS: Partial<Record<MediaDemuxer, Readonly<Record<string, ContainerIdentity>>>> = {
  mov: { mp4: 'mp4', m4v: 'mp4', mov: 'mov', qt: 'mov', m4a: 'm4a', m4b: 'm4a', '3gp': '3gp', '3g2': '3g2' },
  matroska: { mkv: 'matroska', mka: 'matroska', mks: 'matroska', mk3d: 'matroska', webm: 'webm' },
  ogg: { ogg: 'ogg', oga: 'ogg', ogv: 'ogg', opus: 'opus' },
};

/** `major_brand` for the MP4 family, DocType for Matroska, else the extension within the demuxer's family. */
export function containerIdentity(input: { demuxer: MediaDemuxer; majorBrand: string | null; matroskaDocType: string | null; extension: string }): ContainerIdentity {
  const brand = input.majorBrand?.trim().toLowerCase();
  if (input.demuxer === 'mov' && brand && MP4_BRANDS[brand]) return MP4_BRANDS[brand];
  if (input.demuxer === 'matroska' && (input.matroskaDocType === 'webm' || input.matroskaDocType === 'matroska')) return input.matroskaDocType;
  const family = FAMILY_EXTENSIONS[input.demuxer];
  if (family) return family[input.extension] ?? 'unknown';
  return input.demuxer as ContainerIdentity;
}

// ── Pixel formats ──────────────────────────────────────────────────────────────────────────────

const PLANAR_CHROMA: Readonly<Record<string, ChromaSubsampling>> = { 420: '420', 422: '422', 444: '444', 411: '411', 410: '410', 440: '440' };
/** P010-style semi-planar formats: the digit after `p` is the layout. */
const P_CHROMA: Readonly<Record<string, ChromaSubsampling>> = { 0: '420', 2: '422', 4: '444' };
const NV_CHROMA: Readonly<Record<string, ChromaSubsampling>> = { 12: '420', 21: '420', 16: '422', 20: '422', 24: '444', 42: '444' };

/** Bit depth and chroma subsampling of an ffmpeg pixel format name; null when not in the table. */
export function pixelFormatInfo(pixFmt: string | null): { bitDepth: number; chroma: ChromaSubsampling } | null {
  if (!pixFmt) return null;
  const name = pixFmt.toLowerCase().replace(/(?:le|be)$/, '');
  const of = (bitDepth: number, chroma: ChromaSubsampling) => ({ bitDepth, chroma });
  let match = /^yuva?j?(\d{3})p(\d{1,2})?$/.exec(name);
  if (match && PLANAR_CHROMA[match[1]]) return of(Number(match[2] ?? 8), PLANAR_CHROMA[match[1]]);
  if ((match = /^p([024])(1[026])$/.exec(name))) return of(Number(match[2]), P_CHROMA[match[1]]);
  if ((match = /^nv(12|21|16|24|42|20)$/.exec(name))) return of(match[1] === '20' ? 10 : 8, NV_CHROMA[match[1]]);
  if ((match = /^y2(10|12|16)$/.exec(name))) return of(Number(match[1]), '422');
  if (/^(?:yuyv|uyvy|yvyu)422$/.test(name)) return of(8, '422');
  if (name === 'uyyvyy411') return of(8, '411');
  if (/^(?:xv30|v30x)$/.test(name)) return of(10, '444');
  if (name === 'xv36') return of(12, '444');
  if (/^(?:vuya|vuyx|ayuv|uyva)$/.test(name)) return of(8, '444');
  if (name === 'ayuv64' || name === 'xv48') return of(16, '444');
  if ((match = /^gray(\d{1,2})?(f32)?$/.exec(name))) return of(match[2] ? 32 : Number(match[1] ?? 8), '400');
  if ((match = /^ya(8|16)$/.exec(name))) return of(Number(match[1]), '400');
  if (name === 'monow' || name === 'monob') return of(1, '400');
  if ((match = /^gbra?p(\d{1,2})?(?:f(16|32))?$/.exec(name))) return of(Number(match[2] ?? match[1] ?? 8), '444');
  if (/^(?:rgb24|bgr24|rgba|bgra|argb|abgr|0rgb|rgb0|0bgr|bgr0|pal8|rgb8|bgr8|rgb4|bgr4|rgb4_byte|bgr4_byte|rgb565|bgr565|rgb555|bgr555|rgb444|bgr444)$/.test(name)) return of(8, '444');
  if (/^(?:rgb48|bgr48|rgba64|bgra64)$/.test(name)) return of(16, '444');
  if (/^x2(?:rgb|bgr)10$/.test(name)) return of(10, '444');
  if ((match = /^rgba?f(16|32)$/.exec(name))) return of(Number(match[1]), '444');
  return null;
}

// ── ASS/SSA styling ────────────────────────────────────────────────────────────────────────────

const POSITIONING = /\\(?:pos|move)\s*\(|\\an?\d/i;
const fields = (value: string, count: number) => {
  const parts = value.split(',');
  return count > 0 && parts.length > count ? [...parts.slice(0, count - 1), parts.slice(count - 1).join(',')] : parts;
};
const assTime = (value: string | undefined) => {
  const match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value?.trim() ?? '');
  if (!match) return null;
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number((match[4] ?? '0').padEnd(3, '0'));
};

/**
 * Whether the first `limit` events of an .ass/.ssa script need the ASS renderer: positioning tags
 * (`\pos`, `\move`, `\an`, legacy `\a`), more than one style or a style not at the bottom centre,
 * or events shown at the same time. `parsed` is false when no event list could be read.
 */
export function assessAssEvents(script: string, limit: number = PROBE_POLICY.assEvents): { parsed: boolean; events: number; styled: boolean } {
  let section = '';
  let styleFormat: string[] | null = null;
  let eventFormat: string[] | null = null;
  const alignment = new Map<string, number | null>();
  const styles = new Set<string>();
  const spans: { start: number; end: number }[] = [];
  let positioned = false;
  const styleName = (value: string | undefined) => (value ?? '').trim().replace(/^\*/, '').toLowerCase();
  for (const raw of script.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) { section = line.toLowerCase(); continue; }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1);
    if (section === '[v4+ styles]' || section === '[v4 styles]') {
      if (key === 'format') styleFormat = value.split(',').map(name => name.trim().toLowerCase());
      else if (key === 'style' && styleFormat) {
        const columns = fields(value, styleFormat.length);
        const at = styleFormat.indexOf('alignment');
        const align = at >= 0 && /^\s*\d+\s*$/.test(columns[at] ?? '') ? Number(columns[at]) : null;
        alignment.set(styleName(columns[styleFormat.indexOf('name')]), align);
      }
    } else if (section === '[events]') {
      if (key === 'format') eventFormat = value.split(',').map(name => name.trim().toLowerCase());
      else if (key === 'dialogue' && eventFormat) {
        if (spans.length >= limit) break;
        const columns = fields(value, eventFormat.length);
        const start = assTime(columns[eventFormat.indexOf('start')]);
        const end = assTime(columns[eventFormat.indexOf('end')]);
        if (start === null || end === null) return { parsed: false, events: spans.length, styled: true };
        if (POSITIONING.test(columns[eventFormat.indexOf('text')] ?? '')) positioned = true;
        styles.add(styleName(columns[eventFormat.indexOf('style')]));
        spans.push({ start, end });
      }
    }
  }
  if (!eventFormat) return { parsed: false, events: 0, styled: true };
  const placed = [...styles].some(name => { const align = alignment.get(name); return align !== undefined && align !== null && align !== 2; });
  let overlapping = false;
  let reach = -Infinity;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.end <= span.start) continue;
    if (span.start < reach) { overlapping = true; break; }
    reach = Math.max(reach, span.end);
  }
  return { parsed: true, events: spans.length, styled: positioned || styles.size > 1 || placed || overlapping };
}

// ── Normalization ──────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
const records = (value: unknown): Json[] => Array.isArray(value) ? value.map(record).filter((item): item is Json => item !== null) : [];
function text(value: unknown, max = 64): string | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}
/** Free text such as a title, cut to `max` UTF-16 units without splitting a character. */
function label(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null;
  let result = '';
  for (const char of value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result || null;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}
function decimal(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
/** `n/d` as a number. */
function ratio(value: unknown): number | null {
  const match = typeof value === 'string' ? /^\s*(-?\d+)\/(\d+)\s*$/.exec(value) : null;
  if (!match) return decimal(value);
  return Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}
/** Positive seconds as microseconds; zero, negative and absurd values are unknown. */
function microseconds(value: unknown): number | null {
  const seconds = decimal(value);
  return seconds !== null && seconds > 0 && seconds * 1e6 <= MAX_MICROSECONDS ? Math.round(seconds * 1e6) : null;
}
/** A Matroska `DURATION` tag, `HH:MM:SS.nnnnnnnnn`. */
function tagMicroseconds(value: unknown): number | null {
  const match = typeof value === 'string' ? /^\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(value) : null;
  return match ? microseconds((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) : null;
}
/** Tags are matched without regard to case; Matroska writes `BPS`, `DURATION` and their `-eng` forms. */
function tag(tags: Json | null, ...names: string[]): unknown {
  if (!tags) return undefined;
  for (const name of names) {
    const key = Object.keys(tags).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    if (key !== undefined) return tags[key];
  }
  return undefined;
}
function language(value: unknown): string | null {
  const code = text(value, 32)?.toLowerCase();
  return code && code !== 'und' && /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(code) ? code : null;
}
function rationalText(value: unknown): string | null {
  const match = typeof value === 'string' ? /^\s*(\d{1,10})\/(\d{1,10})\s*$/.exec(value) : null;
  return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? `${Number(match[1])}/${Number(match[2])}` : null;
}
const sideData = (stream: Json, type: string) => records(stream.side_data_list).find(entry => entry.side_data_type === type) ?? null;
const flag = (stream: Json, name: string) => record(stream.disposition)?.[name] === 1;

function masteringDisplay(entry: Json | null): MasteringDisplay | null {
  if (!entry) return null;
  const round = (value: number, digits: number) => Number(value.toFixed(digits));
  const point = (x: unknown, y: unknown) => {
    const px = ratio(x), py = ratio(y);
    return px !== null && py !== null && px >= 0 && px <= 1 && py >= 0 && py <= 1 ? { x: round(px, 5), y: round(py, 5) } : null;
  };
  const red = point(entry.red_x, entry.red_y), green = point(entry.green_x, entry.green_y), blue = point(entry.blue_x, entry.blue_y);
  const whitePoint = point(entry.white_point_x, entry.white_point_y);
  const min = ratio(entry.min_luminance), max = ratio(entry.max_luminance);
  const primaries = red && green && blue && whitePoint ? { red, green, blue, whitePoint } : null;
  const luminance = min !== null && max !== null && min >= 0 && max >= 0 && max <= 100_000 && min <= max ? { min: round(min, 4), max: round(max, 4) } : null;
  return primaries || luminance ? { primaries, luminance } : null;
}
function contentLight(entry: Json | null): HdrInfo['contentLight'] {
  const maxCll = integer(entry?.max_content, 0, 65_535), maxFall = integer(entry?.max_average, 0, 65_535);
  return maxCll !== null && maxFall !== null ? { maxCll, maxFall } : null;
}

/** Dolby Vision from the stream's DOVI configuration record, whatever the transfer; else HDR10/HLG by transfer. */
function hdrOf(stream: Json, transfer: string | null): HdrInfo {
  const dovi = sideData(stream, 'DOVI configuration record');
  let dolbyVision: HdrInfo['dolbyVision'] = null;
  if (dovi) {
    const profile = integer(dovi.dv_profile, 0, 31) ?? 0;
    const compatibilityId = integer(dovi.dv_bl_signal_compatibility_id, 0, 15) ?? 0;
    dolbyVision = { profile, level: integer(dovi.dv_level, 0, 63), compatibilityId, compatible: profile !== 5 && compatibilityId !== 0,
      rpuPresent: dovi.rpu_present_flag === 1, elPresent: dovi.el_present_flag === 1, blPresent: dovi.bl_present_flag === 1 };
  }
  const format = dolbyVision ? 'dolby_vision' : transfer === 'smpte2084' ? 'hdr10' : transfer === 'arib-std-b67' ? 'hlg' : 'none';
  return { format, dolbyVision, masteringDisplay: masteringDisplay(sideData(stream, 'Mastering display metadata')),
    contentLight: contentLight(sideData(stream, 'Content light level metadata')) };
}

/**
 * Clockwise degrees, from the Display Matrix only (its `rotation` is counter-clockwise). A legacy
 * `rotate`/`ROTATE` tag is ignored: ffmpeg 8's autorotate does not apply it (measured with the
 * bundled n8.1.2: a Matroska file tagged ROTATE=90 decodes unturned), so reading it would make the
 * planner swap the sides of a picture ffmpeg never turns and distort it (engine design §2).
 */
function rotationOf(stream: Json): VideoStreamInfo['rotation'] {
  const counterClockwise = decimal(sideData(stream, 'Display Matrix')?.rotation);
  if (counterClockwise === null) return 0;
  return ((Math.round(-counterClockwise / 90) * 90) % 360 + 360) % 360 as VideoStreamInfo['rotation'];
}

const unspecified = (value: string | null) => value === null || ['unknown', 'unspecified', 'reserved'].includes(value.toLowerCase()) ? null : value;
const FIELD_ORDER_VALUES = new Set<string>(['progressive', 'tt', 'bb', 'tb', 'bt']);

function videoStream(stream: Json, index: number, typeIndex: number): VideoStreamInfo {
  const tags = record(stream.tags);
  const pixFmt = text(stream.pix_fmt);
  const format = pixelFormatInfo(pixFmt);
  const rFrameRate = rationalText(stream.r_frame_rate), avgFrameRate = rationalText(stream.avg_frame_rate);
  const base = ratio(rFrameRate), average = ratio(avgFrameRate);
  const fps = average ?? base;
  const range = text(stream.color_range);
  const transfer = unspecified(text(stream.color_transfer));
  const fieldOrder = text(stream.field_order);
  const sar = text(stream.sample_aspect_ratio);
  return {
    index, typeIndex,
    codec: text(stream.codec_name) ?? 'unknown',
    profile: unspecified(text(stream.profile)),
    pixFmt,
    bitDepth: format?.bitDepth ?? integer(stream.bits_per_raw_sample, 1, 32),
    chromaSubsampling: format?.chroma ?? null,
    width: integer(stream.width, 0, 65_536) ?? 0,
    height: integer(stream.height, 0, 65_536) ?? 0,
    sampleAspectRatio: sar && /^[1-9]\d{0,9}:[1-9]\d{0,9}$/.test(sar) ? sar : null,
    rFrameRate, avgFrameRate,
    fps: fps !== null && fps > 0 && fps <= 10_000 ? Number(fps.toFixed(6)) : null,
    isVfr: base !== null && average !== null && base > 0 && Math.abs(base - average) / base > 0.005,
    rotation: rotationOf(stream),
    colorPrimaries: unspecified(text(stream.color_primaries)),
    colorTransfer: transfer,
    colorSpace: unspecified(text(stream.color_space)),
    colorRange: range === 'tv' || range === 'pc' ? range : pixFmt?.startsWith('yuvj') ? 'pc' : null,
    fieldOrder: fieldOrder && FIELD_ORDER_VALUES.has(fieldOrder) ? fieldOrder as FieldOrder : null,
    bitRate: integer(stream.bit_rate, 1, MAX_BIT_RATE) ?? integer(tag(tags, 'BPS', 'BPS-eng'), 1, MAX_BIT_RATE),
    durationUs: microseconds(stream.duration) ?? tagMicroseconds(tag(tags, 'DURATION', 'DURATION-eng')),
    language: language(tag(tags, 'language')),
    title: label(tag(tags, 'title')),
    default: flag(stream, 'default'),
    hdr: hdrOf(stream, transfer),
  };
}

function audioStream(stream: Json, index: number, typeIndex: number): AudioStreamInfo {
  const tags = record(stream.tags);
  const streamRate = integer(stream.bit_rate, 1, MAX_BIT_RATE);
  const taggedRate = streamRate === null ? integer(tag(tags, 'BPS', 'BPS-eng'), 1, MAX_BIT_RATE) : null;
  return {
    index, typeIndex,
    codec: text(stream.codec_name) ?? 'unknown',
    profile: unspecified(text(stream.profile)),
    channels: integer(stream.channels, 0, 1024),
    channelLayout: text(stream.channel_layout),
    sampleRate: integer(stream.sample_rate, 0, 10_000_000),
    sampleFormat: text(stream.sample_fmt),
    bitsPerRawSample: integer(stream.bits_per_raw_sample, 1, 64),
    bitRate: streamRate ?? taggedRate,
    bitRateSource: streamRate !== null ? 'stream' : taggedRate !== null ? 'tag' : null,
    durationUs: microseconds(stream.duration) ?? tagMicroseconds(tag(tags, 'DURATION', 'DURATION-eng')),
    language: language(tag(tags, 'language')),
    title: label(tag(tags, 'title')),
    default: flag(stream, 'default'),
    forced: flag(stream, 'forced'),
  };
}

function subtitleStream(stream: Json, index: number, typeIndex: number): SubtitleStreamInfo {
  const tags = record(stream.tags);
  const codec = text(stream.codec_name) ?? 'unknown';
  const kind: SubtitleKind = TEXT_SUBTITLES.has(codec) ? 'text' : IMAGE_SUBTITLES.has(codec) ? 'image' : 'other';
  return {
    index, typeIndex, codec, kind,
    language: language(tag(tags, 'language')),
    title: label(tag(tags, 'title')),
    default: flag(stream, 'default'),
    forced: flag(stream, 'forced'),
    hearingImpaired: flag(stream, 'hearing_impaired'),
    // Unknown until the events are read, and styled when they cannot be (design §2).
    styled: codec === 'ass' || codec === 'ssa' ? true : null,
  };
}

export interface ProbedFile {
  /** The file name; only its extension is used. */
  name: string;
  sizeBytes: number;
  /** From the EBML header ({@link readMatroskaDocType}); null for other files. */
  matroskaDocType: string | null;
}

/** Turns ffprobe's `-show_format -show_streams -show_chapters` JSON into `MediaInfo`, or the reason it cannot be used. */
export function normalizeProbe(raw: unknown, file: ProbedFile): ProbeOutcome {
  const root = record(raw);
  const format = record(root?.format);
  if (!root || !format || record(root.error)) return fail('probe_failed');
  const formatName = text(format.format_name, 128);
  const demuxer = formatName?.split(',').find((name): name is MediaDemuxer => (ALLOWED_DEMUXERS as readonly string[]).includes(name));
  if (!formatName || !demuxer) return fail('container_not_allowed');
  if (Array.isArray(root.streams) && root.streams.length > PROBE_POLICY.maxStreams) return fail('probe_failed');
  const streams = records(root.streams);
  const indices = streams.map(stream => integer(stream.index, 0, 65_535));
  if (indices.some(index => index === null) || new Set(indices).size !== indices.length) return fail('probe_failed');

  const video: VideoStreamInfo[] = [], audio: AudioStreamInfo[] = [], subtitles: SubtitleStreamInfo[] = [], covers: CoverStreamInfo[] = [];
  const typeCounts = new Map<string, number>();
  const rawByIndex = new Map<number, Json>();
  let attachments = 0, dataStreams = 0, primaryVideoIndex: number | null = null;
  for (const stream of [...streams].sort((a, b) => Number(a.index) - Number(b.index))) {
    const index = Number(stream.index);
    const type = text(stream.codec_type) ?? 'unknown';
    const typeIndex = typeCounts.get(type) ?? 0;
    typeCounts.set(type, typeIndex + 1);
    rawByIndex.set(index, stream);
    if (type === 'video' && flag(stream, 'attached_pic')) {
      covers.push({ index, typeIndex, codec: text(stream.codec_name) ?? 'unknown', width: integer(stream.width, 0, 65_536) ?? 0, height: integer(stream.height, 0, 65_536) ?? 0 });
    } else if (type === 'video') {
      const info = videoStream(stream, index, typeIndex);
      video.push(info);
      // ffmpeg's `V` skips cover art and thumbnails; a 0/0 average rate is a still picture, not the main video.
      if (primaryVideoIndex === null && info.avgFrameRate !== null && !flag(stream, 'timed_thumbnails')) primaryVideoIndex = index;
    } else if (type === 'audio') audio.push(audioStream(stream, index, typeIndex));
    else if (type === 'subtitle') subtitles.push(subtitleStream(stream, index, typeIndex));
    else if (type === 'attachment') attachments++;
    else dataStreams++;
  }
  const kind = primaryVideoIndex !== null ? 'video' : audio.length ? 'audio' : null;
  if (!kind) return fail('no_media_streams');

  // Duration: the container, else a stream (main video, then audio, then other video), else a DURATION tag.
  const ordered = [primaryVideoIndex, ...audio.map(stream => stream.index), ...video.map(stream => stream.index)]
    .filter((index): index is number => index !== null).map(index => rawByIndex.get(index)!);
  let durationUs = microseconds(format.duration);
  let durationSource: MediaInfo['durationSource'] = durationUs !== null ? 'format' : null;
  for (const stream of ordered) {
    if (durationUs !== null) break;
    if ((durationUs = microseconds(stream.duration)) !== null) durationSource = 'stream';
  }
  for (const stream of ordered) {
    if (durationUs !== null) break;
    if ((durationUs = tagMicroseconds(tag(record(stream.tags), 'DURATION', 'DURATION-eng'))) !== null) durationSource = 'tag';
  }
  const start = decimal(format.start_time);
  const extension = path.extname(file.name).slice(1).toLowerCase();
  const majorBrand = text(tag(record(format.tags), 'major_brand'), 8);
  // A damaged header can claim a duration of microseconds; the derived rate is then unknown.
  const derivedRate = durationUs ? Math.round(file.sizeBytes * 8 / (durationUs / 1e6)) : null;
  const info = {
    kind,
    container: { demuxer, formatName, majorBrand, matroskaDocType: demuxer === 'matroska' ? file.matroskaDocType : null,
      extension: extension.length <= 32 ? extension : '', identity: containerIdentity({ demuxer, majorBrand, matroskaDocType: file.matroskaDocType, extension }) },
    sizeBytes: file.sizeBytes,
    durationUs, durationSource,
    startTimeUs: start !== null && Math.abs(start) * 1e6 <= MAX_MICROSECONDS ? Math.round(start * 1e6) : null,
    bitRate: integer(format.bit_rate, 1, MAX_BIT_RATE) ?? (derivedRate !== null && derivedRate >= 1 && derivedRate <= MAX_BIT_RATE ? derivedRate : null),
    primaryVideoIndex,
    video, audio, subtitles, covers,
    attachments,
    chapters: Array.isArray(root.chapters) ? root.chapters.length : 0,
    dataStreams,
  };
  const parsed = mediaInfoSchema.safeParse(info);
  return parsed.success ? { ok: true, info: parsed.data } : fail('probe_failed');
}

/** The primary video is PQ or HLG, so its first frame is read for HDR10 static metadata. */
export function needsFirstFrame(info: MediaInfo): boolean {
  const primary = info.video.find(stream => stream.index === info.primaryVideoIndex);
  return !!primary?.colorTransfer && HDR_TRANSFERS.has(primary.colorTransfer);
}

/** Adds the mastering display and content light of the first frame where the stream side data had none. */
export function withFirstFrame(info: MediaInfo, raw: unknown): MediaInfo {
  const frame = records(record(raw)?.frames)[0];
  if (!frame || info.primaryVideoIndex === null) return info;
  const mastering = masteringDisplay(sideData(frame, 'Mastering display metadata'));
  const light = contentLight(sideData(frame, 'Content light level metadata'));
  return { ...info, video: info.video.map(stream => stream.index !== info.primaryVideoIndex ? stream
    : { ...stream, hdr: { ...stream.hdr, masteringDisplay: stream.hdr.masteringDisplay ?? mastering, contentLight: stream.hdr.contentLight ?? light } }) };
}

export function withSubtitleStyling(info: MediaInfo, index: number, styled: boolean): MediaInfo {
  return { ...info, subtitles: info.subtitles.map(stream => stream.index === index ? { ...stream, styled } : stream) };
}

// ── File identity ──────────────────────────────────────────────────────────────────────────────

export type ProbeFileState = { objectIdentity: LocalSubtitleFilesystemObjectIdentity | null; size: number; mtimeMs: number };

/** A Windows FileId of all zeros (common on FAT/exFAT) or a POSIX inode 0 identifies nothing. */
export function usableObjectIdentity(identity: LocalSubtitleFilesystemObjectIdentity | null): identity is LocalSubtitleFilesystemObjectIdentity {
  if (!identity) return false;
  return 'fileIdHex' in identity ? !/^0+$/.test(identity.fileIdHex) : identity.ino !== 0;
}

/**
 * The probe cache key: volume and file ID with size and modification time; without a usable file
 * ID, the normalized path (case-folded on Windows) with size and modification time.
 */
export function probeCacheKey(filePath: string, state: ProbeFileState, platform: NodeJS.Platform | string = process.platform): string {
  const tail = `${state.size}:${state.mtimeMs}`;
  const identity = state.objectIdentity;
  if (usableObjectIdentity(identity)) return 'fileIdHex' in identity ? `id:${identity.volumeSerialHex}:${identity.fileIdHex}:${tail}` : `id:${identity.dev}:${identity.ino}:${tail}`;
  const resolved = platform === 'win32' ? path.win32.resolve(filePath).toLowerCase() : path.posix.resolve(filePath);
  return `path:${resolved}:${tail}`;
}

async function fileState(filePath: string): Promise<ProbeFileState | ProbeFailureCode> {
  let stats: BigIntStats;
  try { stats = await lstat(filePath, { bigint: true }); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'file_unavailable' : 'probe_failed'; }
  if (stats.isSymbolicLink() || !stats.isFile()) return 'not_a_regular_file';
  try {
    const identity = localSubtitleFileIdentityFromBigIntStats(stats);
    return { objectIdentity: identity.objectIdentity, size: identity.size, mtimeMs: identity.mtimeMs };
  } catch {
    const size = Number(stats.size);
    return Number.isSafeInteger(size) ? { objectIdentity: null, size, mtimeMs: Number(stats.mtimeNs) / 1e6 } : 'probe_failed';
  }
}
const sameState = (a: ProbeFileState, b: ProbeFileState) => a.size === b.size && a.mtimeMs === b.mtimeMs &&
  (a.objectIdentity === null || b.objectIdentity === null ? a.objectIdentity === b.objectIdentity : sameLocalSubtitleFilesystemObjectIdentity(a.objectIdentity, b.objectIdentity));

async function readHead(filePath: string): Promise<Buffer | null> {
  try {
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(PROBE_POLICY.headBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  } catch { return null; }
}

// ── Prober ─────────────────────────────────────────────────────────────────────────────────────

/** Runs at most `size` tasks at once, the rest in the order they arrived. */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(size: number) { this.#free = size; }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>(resolve => this.#waiting.push(resolve));
    try { return await task(); }
    finally {
      const next = this.#waiting.shift();
      if (next) next(); else this.#free++;
    }
  }
}

/** Only answers that depend on the file alone are cached; failures to run may succeed next time. */
const CACHEABLE = new Set<ProbeFailureCode>(['container_not_allowed', 'wechat_silk_unsupported', 'no_media_streams']);
const CHANGED = Symbol('changed');
const completed = (result: MediaRunResult) => result.status === 'closed' && result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputExceeded;
const NOT_ALLOWED = /Format not on whitelist|Not detecting m3u8\/hls/i;

export interface MediaProberOptions {
  runtime: MediaToolRunner;
  /** Tests lower it; the design fixes it at 4. */
  concurrency?: number;
}

/**
 * Probes files with the bundled ffprobe, at most four at a time. Each call settles on its own, as
 * soon as its file is done. Results are cached by file identity; a file that changes is probed again.
 */
export class MediaProber {
  readonly #runtime: MediaToolRunner;
  readonly #slots: Slots;
  readonly #cache = new Map<string, ProbeOutcome>();
  readonly #inFlight = new Map<string, Promise<ProbeOutcome | typeof CHANGED>>();
  readonly #stop = new AbortController();

  constructor(options: MediaProberOptions) {
    this.#runtime = options.runtime;
    this.#slots = new Slots(options.concurrency ?? PROBE_POLICY.concurrency);
  }

  /** Stops every probe in progress; later calls fail with `probe_failed`. */
  dispose() {
    this.#stop.abort();
    this.#cache.clear();
  }

  /**
   * `filePath` must be fully qualified: ffprobe runs in the working directory, where a relative
   * name (or a Windows `\dir` without its drive) can mean another file than the one checked here.
   */
  async probe(filePath: string): Promise<ProbeOutcome> {
    if (!path.isAbsolute(filePath) || path.resolve(filePath) !== path.normalize(filePath)) return fail('file_unavailable');
    if (hasRejectedExtension(filePath)) return fail('container_not_allowed');
    // A file written to while it is probed gets one more try.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#stop.signal.aborted) return fail('probe_failed');
      const state = await fileState(filePath);
      if (typeof state === 'string') return fail(state);
      const key = probeCacheKey(filePath, state);
      const cached = this.#cache.get(key);
      if (cached) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        return cached;
      }
      let pending = this.#inFlight.get(key);
      if (!pending) {
        pending = this.#slots.run(() => this.#probeOnce(filePath, state)).finally(() => this.#inFlight.delete(key));
        this.#inFlight.set(key, pending);
      }
      const outcome = await pending;
      if (outcome === CHANGED) continue;
      if ((outcome.ok || CACHEABLE.has(outcome.code)) && !this.#stop.signal.aborted) {
        this.#cache.set(key, outcome);
        if (this.#cache.size > PROBE_POLICY.cacheEntries) this.#cache.delete(this.#cache.keys().next().value!);
      }
      return outcome;
    }
    return fail('probe_failed');
  }

  async #run(tool: MediaTool, args: string[], limits: Omit<MediaRunLimits, 'signal'>): Promise<MediaRunResult | ProbeFailureCode> {
    try { return await this.#runtime.run(tool, args, { ...limits, signal: this.#stop.signal }); }
    catch (error) { return error instanceof MediaRuntimeError ? error.code : 'probe_failed'; }
  }

  async #probeOnce(filePath: string, before: ProbeFileState): Promise<ProbeOutcome | typeof CHANGED> {
    if (this.#stop.signal.aborted) return fail('probe_failed');
    const head = await readHead(filePath);
    if (!head) return fail('file_unavailable');
    if (isSilk(head)) return fail('wechat_silk_unsupported');
    const main = await this.#run('ffprobe', probeArgs(filePath),
      { timeoutMs: PROBE_POLICY.timeoutMs, stdoutMaxBytes: PROBE_POLICY.stdoutMaxBytes, stderrMaxBytes: PROBE_POLICY.stderrMaxBytes });
    if (typeof main === 'string') return fail(main);
    if (NOT_ALLOWED.test(main.stderr.toString('utf8'))) return fail('container_not_allowed');
    if (!completed(main)) return fail('probe_failed');
    let raw: unknown;
    try { raw = JSON.parse(main.stdout.toString('utf8')); } catch { return fail('probe_failed'); }
    const normalized = normalizeProbe(raw, { name: path.basename(filePath), sizeBytes: before.size, matroskaDocType: readMatroskaDocType(head) });
    if (!normalized.ok) return normalized;
    let info = normalized.info;

    if (needsFirstFrame(info) && info.primaryVideoIndex !== null) {
      const frame = await this.#run('ffprobe', firstFrameArgs(filePath, info.container.demuxer, info.primaryVideoIndex),
        { timeoutMs: PROBE_POLICY.frameTimeoutMs, stdoutMaxBytes: PROBE_POLICY.frameStdoutMaxBytes, stderrMaxBytes: PROBE_POLICY.stderrMaxBytes });
      if (typeof frame === 'string' && frame !== 'probe_failed') return fail(frame);
      if (typeof frame !== 'string' && completed(frame)) {
        try { info = withFirstFrame(info, JSON.parse(frame.stdout.toString('utf8'))); } catch { /* No static metadata then. */ }
      }
    }

    const scripts = info.subtitles.filter(stream => stream.codec === 'ass' || stream.codec === 'ssa').slice(0, PROBE_POLICY.assStreams);
    for (const stream of scripts) {
      const events = await this.#run('ffmpeg', assEventArgs(filePath, info.container.demuxer, stream.index),
        { timeoutMs: PROBE_POLICY.assTimeoutMs, stdoutMaxBytes: PROBE_POLICY.assStdoutMaxBytes, stderrMaxBytes: PROBE_POLICY.stderrMaxBytes });
      if (typeof events === 'string' && events !== 'probe_failed') return fail(events);
      if (typeof events === 'string') continue;
      // A partial read decides only when it already holds enough events or shows styling.
      const assessed = assessAssEvents(events.stdout.toString('utf8'));
      const styled = !assessed.parsed || assessed.styled || (!completed(events) && assessed.events < PROBE_POLICY.assEvents);
      info = withSubtitleStyling(info, stream.index, styled);
    }

    const after = await fileState(filePath);
    if (typeof after === 'string') return fail(after);
    if (!sameState(before, after)) return CHANGED;
    const checked = mediaInfoSchema.safeParse(info);
    return checked.success ? { ok: true, info: checked.data } : fail('probe_failed');
  }
}
