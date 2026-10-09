import type { SUBTITLE_TEXT_FORMATS } from './domain';

type SubtitleTextFormat = typeof SUBTITLE_TEXT_FORMATS[number];

/** Extensions of audio-only media; lyrics-style LRC suits them, timed SRT suits video. */
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma']);

export function isAudioMediaName(displayName: string): boolean {
  const match = /\.([A-Za-z0-9]+)$/.exec(displayName.trim());
  return !!match && AUDIO_EXTENSIONS.has(match[1].toLowerCase());
}

/**
 * The format a subtitle is exported in when nobody chose one: a subtitle file keeps its own format,
 * a transcript of audio becomes LRC and a transcript of video (or of anything unknown) becomes SRT.
 */
export function defaultExportFormat(origin: { format: string; displayName: string }): SubtitleTextFormat {
  if (origin.format !== 'media') return origin.format as SubtitleTextFormat;
  return isAudioMediaName(origin.displayName) ? 'lrc' : 'srt';
}

/** A batch shares one format: LRC only when every transcript in it came from audio. */
export function defaultBatchExportFormat(origins: readonly { format: string; displayName: string }[]): SubtitleTextFormat {
  const formats = new Set(origins.map(defaultExportFormat));
  return formats.size === 1 ? [...formats][0] : 'srt';
}
