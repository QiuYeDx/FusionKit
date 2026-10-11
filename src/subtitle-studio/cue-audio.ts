import { z } from 'zod';
import { idSchema, StudioError, type SubtitleDocument } from './domain';

/** Extensions offered when the user picks a media file, and matched next to an imported subtitle. */
export const CUE_MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', '3gp',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'ac3', 'eac3', 'dts', 'amr', 'aiff', 'aif', 'caf',
] as const;
const mediaExtensions = new Set<string>(CUE_MEDIA_EXTENSIONS);
export const CUE_AUDIO_LIMITS = {
  /** Longest stretch of one clip, before padding. */
  clipMs: 120_000,
  /** How long a cue with an unknown end plays when no later cue starts. */
  unknownEndMs: 5_000,
  /** Directory entries examined when looking for media next to a subtitle. */
  siblingEntries: 5_000,
  sampleRate: 48_000,
} as const;
export const CUE_AUDIO_PADDINGS = [0, 300, 1000] as const;
/** Playback speeds; slower audio is stretched by the main process and keeps its pitch. */
export const CUE_AUDIO_TEMPOS = [1, 0.75, 0.5] as const;
export type CueAudioTempo = typeof CUE_AUDIO_TEMPOS[number];
export type CueAudioPadding = typeof CUE_AUDIO_PADDINGS[number];
export const DEFAULT_CUE_AUDIO_PADDING: CueAudioPadding = 300;

export const cueAudioTargetSchema = z.union([
  z.object({ cueIds: z.union([z.tuple([idSchema]), z.tuple([idSchema, idSchema])]) }).strict(),
  z.object({ range: z.object({ startMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), endMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict()
    .refine(range => range.endMs > range.startMs) }).strict(),
]);
export type CueAudioTarget = z.infer<typeof cueAudioTargetSchema>;
export const cueAudioRequestSchemas = {
  getCueMedia: z.object({ documentId: idSchema }).strict(),
  chooseCueMedia: z.object({ documentId: idSchema }).strict(),
  clearCueMedia: z.object({ documentId: idSchema }).strict(),
  readCueAudio: z.object({ documentId: idSchema, target: cueAudioTargetSchema,
    padMs: z.union([z.literal(0), z.literal(300), z.literal(1000)]),
    tempo: z.union([z.literal(1), z.literal(0.75), z.literal(0.5)]).optional(),
    /** Playback and waveforms decode independently: a newer request only stops one of the same purpose. */
    purpose: z.enum(['play', 'waveform']).optional() }).strict(),
};

/** How the document found its media: chosen by the user, the transcribed file, or a same-named file beside the subtitle. */
export type CueMediaVia = 'linked' | 'transcription' | 'matched';
/** What the renderer may know about a document's media: never its path. */
export type CueMediaStatus = { status: 'ready' | 'unavailable'; via: CueMediaVia; name: string } | { status: 'missing' };
export type CueAudioUnavailable = 'no_media' | 'media_unavailable' | 'no_audio' | 'decode_failed' | 'runtime_unavailable' | 'cancelled';
export type CueAudioClip = {
  kind: 'clip'; bytes: Uint8Array; mimeType: 'audio/wav'; revision: number;
  /** The stretch asked for, and the decoded stretch around it including padding. */
  startMs: number; endMs: number; clipStartMs: number; clipEndMs: number;
  /** The stretch was longer than the clip limit and only its start was decoded. */
  truncated: boolean;
  /** The speed the audio was stretched to: it plays (clipEndMs - clipStartMs) / tempo long. */
  tempo: CueAudioTempo;
};
export type CueAudioResult = CueAudioClip | { kind: 'unavailable'; reason: CueAudioUnavailable };

export const isCueMediaFileName = (name: string) => mediaExtensions.has(extension(name));
function extension(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
const stem = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; };
const key = (value: string) => value.normalize('NFC').toLocaleLowerCase('en-US');
/**
 * A language or version tag such as `en`, `zh-CN`, `chs`, `forced` or `sdh`:
 * not part of the media's name. Episode marks such as `S01E01` are not tags.
 */
const TAG = /\.([a-z]{2,3}(?:-[a-z0-9]{2,4})?|forced|sdh|default|full|signs|songs)$/iu;

/**
 * Finds the one media file named like the subtitle: `Show.en.srt` matches
 * `Show.en.mkv`, else `Show.mkv` (up to two tags dropped). Two equally good
 * files match nothing, so the user picks one instead of hearing a guess.
 */
export function matchSiblingMedia(subtitleName: string, entries: readonly string[]): string | null {
  if (entries.length > CUE_AUDIO_LIMITS.siblingEntries) return null;
  const media = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isCueMediaFileName(entry)) continue;
    const name = key(stem(entry));
    media.set(name, [...(media.get(name) ?? []), entry]);
  }
  let candidate = stem(subtitleName);
  for (let dropped = 0; dropped <= 2; dropped++) {
    const found = media.get(key(candidate));
    if (found) return found.length === 1 ? found[0] : null;
    const tag = TAG.exec(candidate);
    if (!tag || tag.index === 0) return null;
    candidate = candidate.slice(0, tag.index);
  }
  return null;
}

export type CueAudioRange = { startMs: number; endMs: number; truncated: boolean };
/**
 * The stretch a request plays, from the document as it is now. A cue without
 * an end plays until the next later cue starts, or for five seconds.
 */
export function resolveCueAudioRange(doc: SubtitleDocument, target: CueAudioTarget): CueAudioRange {
  const durationMs = doc.origin.format === 'media' ? doc.origin.durationMs : undefined;
  let startMs: number, endMs: number;
  if ('range' in target) ({ startMs, endMs } = target.range);
  else {
    const cues: readonly SubtitleDocument['cues'][number][] = doc.cues;
    const indexes = target.cueIds.map(id => cues.findIndex(cue => cue.id === id));
    if (indexes.some(index => index < 0)) throw new StudioError('invalid_input');
    const first = Math.min(...indexes), last = Math.max(...indexes);
    startMs = cues[first].timing.startMs;
    endMs = cues[last].timing.endMs ?? (() => {
      const from = cues[last].timing.startMs;
      const next = cues.slice(last + 1).find(cue => cue.timing.startMs > from);
      return next ? next.timing.startMs : from + CUE_AUDIO_LIMITS.unknownEndMs;
    })();
    // Several cues play as one stretch, even when a middle cue ends later than the last.
    for (let index = first; index < last; index++) endMs = Math.max(endMs, cues[index].timing.endMs ?? endMs);
  }
  startMs = Math.max(0, startMs);
  if (durationMs !== undefined) endMs = Math.min(endMs, durationMs);
  if (!(endMs > startMs)) throw new StudioError('invalid_input');
  const truncated = endMs - startMs > CUE_AUDIO_LIMITS.clipMs;
  return { startMs, endMs: truncated ? startMs + CUE_AUDIO_LIMITS.clipMs : endMs, truncated };
}

/** The decoded stretch: the range with padding on both sides, never before the start of the media. */
export function paddedCueAudioRange(range: CueAudioRange, padMs: CueAudioPadding) {
  return { clipStartMs: Math.max(0, range.startMs - padMs), clipEndMs: range.endMs + padMs };
}

/** A canonical 44-byte header for 16-bit PCM. */
export function pcm16WavHeader(dataBytes: number, sampleRate: number, channels: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); header.setUint32(4, 36 + dataBytes, true); text(8, 'WAVE');
  text(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, channels, true);
  header.setUint32(24, sampleRate, true); header.setUint32(28, sampleRate * channels * 2, true); header.setUint16(32, channels * 2, true); header.setUint16(34, 16, true);
  text(36, 'data'); header.setUint32(40, dataBytes, true);
  return new Uint8Array(header.buffer);
}
