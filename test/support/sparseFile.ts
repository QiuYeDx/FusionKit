import { execFileSync } from "node:child_process";
import type { FileHandle } from "node:fs/promises";

/**
 * Extends an open file to `size` bytes without allocating them. NTFS allocates the
 * whole length on truncate unless the file is first marked sparse, so multi-GB
 * fixtures fail with ENOSPC on Windows hosts with less free space than their size.
 */
export async function truncateSparse(
  handle: FileHandle,
  filePath: string,
  size: number,
): Promise<void> {
  if (process.platform === "win32") {
    try {
      execFileSync("fsutil", ["sparse", "setflag", filePath], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      });
    } catch {
      // Without the sparse flag the truncate below still works when space allows.
    }
  }
  await handle.truncate(size);
}
