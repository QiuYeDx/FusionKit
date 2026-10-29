import {
  AUDIO_FORMATS, VIDEO_CONTAINERS,
  type AudioFormat, type CompressCodec, type ContainerIdentity, type ConversionSettings, type EncoderId, type MediaInfo, type OutputContainer,
  type PlanNotApplicableCode, type SubtitleEncoderId, type SubtitleStreamInfo, type VideoContainer,
} from '../../../../src/media-converter/contract';
import type { OptionPair } from './types';

/**
 * Container × codec compatibility, the task × media matrix, the output containers and the
 * container identity comparison (module-encode design §2). Plain data and pure lookups.
 */

// ── Output containers ──────────────────────────────────────────────────────────────────────────

export interface OutputContainerSpec {
  id: OutputContainer;
  muxer: string;
  extension: string;
  /** The identity the probe gives a file written like this (`MediaInfo.container.identity`). */
  identity: ContainerIdentity;
  faststart: boolean;
  /** Whether chapters survive in it (AC-ENCODE-04-3: not in FLAC, WAV or Ogg Vorbis). */
  chapters: boolean;
  /** Whether it holds attachments such as fonts: only Matroska. */
  attachments: boolean;
  /** Muxer options written for every output of this type. */
  options: readonly OptionPair[];
}

const spec = (id: OutputContainer, muxer: string, identity: ContainerIdentity, extra: Partial<OutputContainerSpec> = {}): OutputContainerSpec =>
  Object.freeze({ id, muxer, extension: id, identity, faststart: false, chapters: true, attachments: false, options: [], ...extra });

export const OUTPUT_CONTAINER_SPECS: Readonly<Record<OutputContainer, OutputContainerSpec>> = Object.freeze({
  mp4: spec('mp4', 'mp4', 'mp4', { faststart: true }),
  mov: spec('mov', 'mov', 'mov', { faststart: true }),
  mkv: spec('mkv', 'matroska', 'matroska', { attachments: true }),
  webm: spec('webm', 'webm', 'webm'),
  // ID3v2.3 is what most players and Windows Explorer read; no ID3v1 tail (design §5).
  mp3: spec('mp3', 'mp3', 'mp3', { options: [['id3v2_version', '3'], ['write_id3v1', '0']] }),
  m4a: spec('m4a', 'ipod', 'm4a', { faststart: true }),
  opus: spec('opus', 'opus', 'opus'),
  ogg: spec('ogg', 'ogg', 'ogg', { chapters: false }),
  flac: spec('flac', 'flac', 'flac', { chapters: false }),
  // RF64 once the file passes 4 GiB.
  wav: spec('wav', 'wav', 'wav', { chapters: false, options: [['rf64', 'auto']] }),
  aiff: spec('aiff', 'aiff', 'aiff', { chapters: false }),
  mka: spec('mka', 'matroska', 'matroska'),
});

/** The containers whose muxer is the MOV one: titles go in `handler_name`, and the first track of a type is always enabled. */
export const isMovFamily = (container: OutputContainer) => container === 'mp4' || container === 'mov' || container === 'm4a';

export const isVideoContainer = (target: string): target is VideoContainer => (VIDEO_CONTAINERS as readonly string[]).includes(target);
export const isAudioFormat = (target: string): target is AudioFormat => (AUDIO_FORMATS as readonly string[]).includes(target);

/** Where an audio format is written; AAC and ALAC both go in .m4a. */
export const AUDIO_FORMAT_CONTAINERS: Readonly<Record<AudioFormat, OutputContainer>> = Object.freeze({
  mp3: 'mp3', m4a: 'm4a', opus: 'opus', flac: 'flac', wav: 'wav', alac: 'm4a',
});

// ── Compatibility ──────────────────────────────────────────────────────────────────────────────

const ALL = 'all' as const;
const set = (...codecs: string[]): ReadonlySet<string> => new Set(codecs);

/**
 * Video codecs each target takes as they are. MP4 deliberately does not copy MPEG-4 Part 2,
 * MPEG-2, VC-1, WMV or VP9: they become H.264. ProRes is copied only into MOV.
 */
export const VIDEO_COPY: Readonly<Record<VideoContainer, ReadonlySet<string> | typeof ALL>> = Object.freeze({
  mp4: set('h264', 'hevc', 'av1'),
  mov: set('h264', 'hevc', 'prores'),
  mkv: ALL,
  webm: set('vp8', 'vp9', 'av1'),
});

/** Audio codecs each target takes as they are (AC-ENCODE-05-1; MOV also keeps 16/24-bit PCM, design §2). */
export const AUDIO_COPY: Readonly<Record<VideoContainer, ReadonlySet<string> | typeof ALL>> = Object.freeze({
  mp4: set('aac', 'mp3', 'ac3', 'eac3', 'alac'),
  mov: set('aac', 'mp3', 'ac3', 'eac3', 'alac', 'pcm_s16le', 'pcm_s24le'),
  mkv: ALL,
  webm: set('opus', 'vorbis'),
});

const takes = (allowed: ReadonlySet<string> | typeof ALL, codec: string) => allowed === ALL || allowed.has(codec);
export const canCopyVideo = (container: VideoContainer, codec: string) => takes(VIDEO_COPY[container], codec);
export const canCopyAudio = (container: VideoContainer, codec: string) => takes(AUDIO_COPY[container], codec);

/** Subtitle codecs that have a Matroska CodecID and are copied into MKV as they are. */
export const MATROSKA_SUBTITLES: ReadonlySet<string> = set(
  'subrip', 'text', 'ass', 'ssa', 'webvtt', 'dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'hdmv_text_subtitle',
);
/** Subtitles ffmpeg can decode to text, so they can change format: the probe's text kinds and EIA-608 captions. */
export const canConvertSubtitle = (stream: SubtitleStreamInfo) => stream.kind === 'text' || stream.codec === 'eia_608';
/** ASS/SSA that needs the ASS renderer: positioning, several or non-bottom styles, or overlapping events (the probe decides). */
export const isStyledAss = (stream: SubtitleStreamInfo) => (stream.codec === 'ass' || stream.codec === 'ssa') && stream.styled === true;

export type SubtitleHandling =
  | { action: 'copy' }
  | { action: 'encode'; encoder: SubtitleEncoderId; stylingLost: boolean }
  | { action: 'drop' };

/**
 * AC-ENCODE-01-3. MP4/MOV: text becomes mov_text, styled ASS/SSA loses its styling, the rest is
 * dropped. WebM: text becomes WebVTT, the rest is dropped. MKV: everything with a Matroska CodecID
 * is copied; mov_text, EIA-608 and other decodable text become SRT; what cannot be decoded is dropped.
 */
export function subtitleHandling(container: VideoContainer, stream: SubtitleStreamInfo): SubtitleHandling {
  if (container === 'mkv') {
    if (MATROSKA_SUBTITLES.has(stream.codec)) return { action: 'copy' };
    return canConvertSubtitle(stream) ? { action: 'encode', encoder: 'srt', stylingLost: false } : { action: 'drop' };
  }
  const native = container === 'webm' ? 'webvtt' : 'mov_text';
  if (stream.codec === native) return { action: 'copy' };
  return canConvertSubtitle(stream) ? { action: 'encode', encoder: native, stylingLost: isStyledAss(stream) } : { action: 'drop' };
}

/** AC-ENCODE-01-8: MKV when the source has styled ASS/SSA, image subtitles or attachments; MP4 otherwise. */
export function autoCompressContainer(media: MediaInfo): 'mp4' | 'mkv' {
  const needsMatroska = media.attachments > 0 || media.subtitles.some(stream => stream.kind === 'image' || isStyledAss(stream));
  return needsMatroska ? 'mkv' : 'mp4';
}

/** The codec "convert" re-encodes video to (AC-ENCODE-01-7): the H.264 chain for MP4/MOV, AV1 for WebM and MKV. */
export const CONVERT_VIDEO_CODEC: Readonly<Record<VideoContainer, CompressCodec>> = Object.freeze({ mp4: 'h264', mov: 'h264', webm: 'av1', mkv: 'av1' });

/** The codec each encoder writes, as ffprobe names it. */
export const ENCODER_CODEC: Readonly<Record<EncoderId, string>> = Object.freeze({
  libsvtav1: 'av1', av1_nvenc: 'av1', av1_qsv: 'av1', av1_amf: 'av1',
  hevc_nvenc: 'hevc', hevc_qsv: 'hevc', hevc_amf: 'hevc', hevc_mf: 'hevc', libkvazaar: 'hevc',
  h264_nvenc: 'h264', h264_qsv: 'h264', h264_amf: 'h264', h264_mf: 'h264', libopenh264: 'h264',
  aac: 'aac', libopus: 'opus', libmp3lame: 'mp3', flac: 'flac', alac: 'alac',
  pcm_s16le: 'pcm_s16le', pcm_s24le: 'pcm_s24le', pcm_s32le: 'pcm_s32le', pcm_f32le: 'pcm_f32le',
  mov_text: 'mov_text', srt: 'subrip', webvtt: 'webvtt',
});

// ── Task × media matrix ────────────────────────────────────────────────────────────────────────

export const MEDIA_SHAPES = ['video', 'video_no_audio', 'audio', 'audio_with_cover'] as const;
export type MediaShape = (typeof MEDIA_SHAPES)[number];
export const TASK_KINDS = ['compress', 'convert_video', 'convert_audio', 'extract_audio'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** AC-ENCODE-01-6: `plan` makes a plan; anything else is why the task does not apply. */
export const TASK_MATRIX: Readonly<Record<TaskKind, Readonly<Record<MediaShape, 'plan' | PlanNotApplicableCode>>>> = Object.freeze({
  compress: { video: 'plan', video_no_audio: 'plan', audio: 'task_not_applicable', audio_with_cover: 'task_not_applicable' },
  convert_video: { video: 'plan', video_no_audio: 'plan', audio: 'no_video_stream', audio_with_cover: 'no_video_stream' },
  // Converting a video to an audio format takes its default audio track.
  convert_audio: { video: 'plan', video_no_audio: 'no_audio_stream', audio: 'plan', audio_with_cover: 'plan' },
  extract_audio: { video: 'plan', video_no_audio: 'no_audio_stream', audio: 'task_not_applicable', audio_with_cover: 'task_not_applicable' },
});

/** Cover art never counts as video: a file with only audio and a cover is `audio_with_cover`. */
export function mediaShape(media: MediaInfo): MediaShape {
  if (media.kind === 'video' && media.primaryVideoIndex !== null) return media.audio.length ? 'video' : 'video_no_audio';
  return media.covers.length ? 'audio_with_cover' : 'audio';
}

export function taskKind(settings: ConversionSettings): TaskKind {
  if (settings.task === 'compress') return 'compress';
  if (settings.task === 'extract-audio') return 'extract_audio';
  return isVideoContainer(settings.target) ? 'convert_video' : 'convert_audio';
}

export const taskApplicability = (settings: ConversionSettings, media: MediaInfo) => TASK_MATRIX[taskKind(settings)][mediaShape(media)];

// ── Container identity ─────────────────────────────────────────────────────────────────────────

/**
 * The source is already written as the target (AC-ENCODE-06-2): the probe's identity (format,
 * MP4 brand, Matroska DocType, extension) is the target's, and so is the extension. An .m4v or
 * .m4b file therefore still becomes .mp4 or .m4a; an unknown identity never matches.
 */
export function isSameContainer(source: MediaInfo['container'], target: OutputContainer): boolean {
  const wanted = OUTPUT_CONTAINER_SPECS[target];
  return source.identity !== 'unknown' && source.identity === wanted.identity && source.extension === wanted.extension;
}
