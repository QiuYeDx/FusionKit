import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/** A path the user typed to the assistant, resolved to one file or the reason it cannot be used. */
export type TypedPathEntry =
  | { fileName: string; path: string; error?: never }
  | { fileName: string; error: 'access_denied' | 'document_unavailable' | 'unsupported_feature' | 'invalid_input'; path?: never };

const MAX_DEPTH = 8;
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Files named by path, as the user typed them to the assistant: a file is taken as it is when its
 * extension is accepted, a directory gives its accepted files (and its subdirectories' when asked) in
 * name order. Links are never followed, and a path that cannot be used stays an entry with its reason.
 * Main reads only names here; what a tool does with the files keeps its own checks.
 */
export async function collectTypedPaths(inputs: readonly string[], options: { extensions: readonly string[]; recursive?: boolean; limit: number }): Promise<TypedPathEntry[]> {
  const accepted = new Set(options.extensions.map(extension => extension.toLowerCase()));
  const matches = (name: string) => accepted.has(path.extname(name).slice(1).toLowerCase());
  const found: TypedPathEntry[] = [];
  const full = () => found.length >= options.limit;
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      if (full()) return;
      if (entry.isFile() && matches(entry.name)) found.push({ fileName: entry.name, path: path.join(directory, entry.name) });
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
    else if (stat.isFile()) found.push(matches(input) ? { fileName, path: path.resolve(input) } : { fileName, error: 'unsupported_feature' });
    else if (stat.isDirectory()) await walk(path.resolve(input), 0);
    else found.push({ fileName, error: 'invalid_input' });
  }
  return found;
}
