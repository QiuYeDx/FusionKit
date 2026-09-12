import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { resolveLocalSubtitleInputPaths } from './transcription/native/windows-explorer-drop-resolver';
import type { ErrorCode } from '../../../src/subtitle-studio/domain';

export type NativeInputSelection = { fileName: string; path: string; error?: never } | { fileName: string; error: ErrorCode; path?: never };
export type SubtitleInputSelection = NativeInputSelection;

/** Keep file failures separate while resolving a Shell proxy batch as one authority. */
export async function resolveDroppedInputPaths(paths: readonly string[]): Promise<NativeInputSelection[]> {
  const selections: SubtitleInputSelection[] = await Promise.all(paths.map(async input => {
    const fileName = path.basename(input).slice(0, 1000) || '—';
    try {
      if (!path.isAbsolute(input) || input.includes('\0')) return { fileName, error: 'access_denied' as const };
      const stat = await lstat(input);
      if (!stat.isFile() || stat.isSymbolicLink()) return { fileName, error: 'invalid_input' as const };
      return { fileName, path: input };
    } catch { return { fileName, error: 'document_unavailable' as const }; }
  }));
  const valid = selections.filter((item): item is Extract<SubtitleInputSelection, { path: string }> => item.path !== undefined);
  if (!valid.length) return selections;
  try {
    const resolved = await resolveLocalSubtitleInputPaths(valid.map(item => item.path), 'drop');
    if (resolved.length !== valid.length) throw new Error('Invalid resolved file count.');
    let index = 0;
    return selections.map(item => item.path === undefined ? item : { path: resolved[index++], fileName: path.basename(resolved[index - 1]) });
  } catch {
    // A guessed %TEMP% path must never acquire source-output authority.
    return selections.map(item => item.path === undefined ? item : { fileName: item.fileName, error: 'access_denied' });
  }
}

export const resolveDroppedSubtitlePaths = resolveDroppedInputPaths;
