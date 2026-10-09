import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { NativeInputSelection } from './drop-input-service';

/** The audio and video the transcription picker offers. */
export const TRANSCRIPTION_MEDIA_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mkv', 'mov', 'webm', 'avi'] as const;
const MEDIA = new Set<string>(TRANSCRIPTION_MEDIA_EXTENSIONS);
/** A directory walk stops here; the caller pages through what it found. */
export const TRANSCRIPTION_PATH_SCAN_LIMIT = 2000;
const MAX_DEPTH = 8;

const isMedia = (name: string) => MEDIA.has(path.extname(name).slice(1).toLowerCase());
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Media named by path, as the user typed it to the assistant: a file is taken as it is, a directory
 * gives its audio and video files (with its subdirectories when asked), in name order. Links are
 * never followed, and each path that cannot be used stays a row with its reason.
 */
export async function collectTranscriptionMediaPaths(inputs: readonly string[], options: { recursive?: boolean } = {}): Promise<NativeInputSelection[]> {
  const found: NativeInputSelection[] = [];
  const full = () => found.length >= TRANSCRIPTION_PATH_SCAN_LIMIT;
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      if (full()) return;
      if (entry.isFile() && isMedia(entry.name)) found.push({ fileName: entry.name, path: path.join(directory, entry.name) });
    }
    if (!options.recursive || depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (full()) return;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), depth + 1);
    }
  };
  for (const input of inputs) {
    if (full()) break;
    const fileName = path.basename(input).slice(0, 1000) || '—';
    if (!path.isAbsolute(input) || input.includes('\0')) { found.push({ fileName, error: 'access_denied' }); continue; }
    let stat;
    try { stat = await lstat(input); } catch { found.push({ fileName, error: 'document_unavailable' }); continue; }
    if (stat.isSymbolicLink()) found.push({ fileName, error: 'invalid_input' });
    else if (stat.isFile()) found.push(isMedia(input) ? { fileName, path: path.resolve(input) } : { fileName, error: 'unsupported_feature' });
    else if (stat.isDirectory()) await walk(path.resolve(input), 0);
    else found.push({ fileName, error: 'invalid_input' });
  }
  return found;
}
