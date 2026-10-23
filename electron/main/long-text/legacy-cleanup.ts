import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/** The workspace folder of the removed text translator, and everything it ever created at its top level. */
const LEGACY_FOLDER = 'text-translation';
const TASKS = 'tasks';
const FINDER_METADATA = '.DS_Store';

/**
 * Deletes `<userData>/text-translation` (design §6.14) when it holds only what the old tool created: a
 * real `tasks` folder and maybe `.DS_Store`. A link or junction (both are symbolic links to `lstat`), a
 * file, or a folder with anything else is kept, since it is not the old tool's to delete. Files the old
 * tool exported elsewhere belong to the user and are never touched.
 */
export async function removeLegacyTextTranslationWorkspace(userData: string): Promise<'removed' | 'kept' | 'absent'> {
  const target = path.join(userData, LEGACY_FOLDER);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 'kept';
  const entries = await readdir(target, { withFileTypes: true });
  const ours = entries.every(entry => entry.name === FINDER_METADATA || (entry.name === TASKS && entry.isDirectory() && !entry.isSymbolicLink()));
  if (!ours) return 'kept';
  await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  return 'removed';
}
