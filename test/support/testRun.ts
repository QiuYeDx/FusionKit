import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from './staleRuns';

/**
 * Creates the current test's run folder under its `test-results/<feature>` directory.
 * When the test passes, the folders inside the run (Electron profile, media, exports)
 * are removed and only files at its top level, such as screenshots and result.json,
 * are kept. A failed run is kept whole for inspection. Older runs are pruned by
 * {@link pruneStaleRuns} the next time the test starts.
 */
export async function createTestRun(artifacts: string, prefix = 'run-'): Promise<string> {
  await mkdir(artifacts, { recursive: true });
  await pruneStaleRuns(artifacts, prefix);
  const root = await mkdtemp(path.join(artifacts, prefix));
  onTestFinished(async result => {
    if (result.state !== 'pass' || keepAllTestRuns()) return;
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await removeTestRun(path.join(root, entry.name));
    }
  });
  return root;
}
