import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Leftover runs younger than this may belong to a test another session is still running. */
const STALE_MS = 60 * 60 * 1000;

export const keepAllTestRuns = () => process.env.FUSIONKIT_KEEP_TEST_RUNS === '1';
export const removeTestRun = (target: string) => rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});

/**
 * Removes `prefix*` run folders in `parent` that are over an hour old, except the `keep`
 * newest of them, so runs under test-results never pile up across sessions.
 * Set FUSIONKIT_KEEP_TEST_RUNS=1 to keep every run.
 */
export async function pruneStaleRuns(parent: string, prefix: string, keep = 1) {
  if (keepAllTestRuns()) return;
  const runs: { target: string; time: number }[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const target = path.join(parent, entry.name);
    const info = await stat(target).catch(() => undefined);
    if (info) runs.push({ target, time: info.mtimeMs });
  }
  const now = Date.now();
  for (const run of runs.sort((a, b) => b.time - a.time).slice(keep)) if (now - run.time > STALE_MS) await removeTestRun(run.target);
}
