import { collectTypedPaths } from '../fs/typed-paths';
import type { NativeInputSelection } from './drop-input-service';

/** The audio and video the transcription picker offers. */
export const TRANSCRIPTION_MEDIA_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mkv', 'mov', 'webm', 'avi'] as const;
/** A directory walk stops here; the caller pages through what it found. */
export const TRANSCRIPTION_PATH_SCAN_LIMIT = 2000;

/** Media under paths the user typed: files as they are, folders' audio and video in name order. */
export function collectTranscriptionMediaPaths(inputs: readonly string[], options: { recursive?: boolean } = {}): Promise<NativeInputSelection[]> {
  return collectTypedPaths(inputs, { extensions: TRANSCRIPTION_MEDIA_EXTENSIONS, recursive: options.recursive, limit: TRANSCRIPTION_PATH_SCAN_LIMIT });
}
