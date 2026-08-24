import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ATOMIC_RENAME_ATTEMPTS = 9;
const ATOMIC_RENAME_RETRY_BASE_DELAY_MS = 50;
const ATOMIC_RENAME_RETRY_MAX_DELAY_MS = 1_000;

/**
 * Writes UTF-8 content through a same-directory temporary file and atomically
 * replaces the destination. Windows and SMB can briefly reject a rename after
 * a handle closes, so only known transient lock errors receive bounded retries.
 */
export async function atomicWriteUtf8File(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceWithBoundedRetry(temporaryPath, filePath, content);
  } finally {
    await handle?.close().catch(() => undefined);
    await removeTemporaryFileWithBoundedRetry(temporaryPath).catch(() => undefined);
  }
}

async function replaceWithBoundedRetry(
  temporaryPath: string,
  filePath: string,
  expectedContent: string,
): Promise<void> {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(temporaryPath, filePath);
      return;
    } catch (error) {
      // Some remote filesystems can report a transient failure even after the
      // rename committed. Treat it as success only when the source disappeared
      // and an exact destination read-back proves the intended bytes won.
      if (await exactCommitCanBeProved(
        temporaryPath,
        filePath,
        expectedContent,
      )) {
        return;
      }
      if (!isTransientFileLockError(error) || attempt === ATOMIC_RENAME_ATTEMPTS) {
        throw error;
      }
      await delay(retryDelayMs(attempt));
    }
  }
}

async function exactCommitCanBeProved(
  temporaryPath: string,
  filePath: string,
  expectedContent: string,
): Promise<boolean> {
  try {
    await fs.lstat(temporaryPath);
    return false;
  } catch (error) {
    if (!isMissingPathError(error)) return false;
  }

  try {
    return await fs.readFile(filePath, "utf8") === expectedContent;
  } catch {
    return false;
  }
}

async function removeTemporaryFileWithBoundedRetry(
  temporaryPath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.unlink(temporaryPath);
      return;
    } catch (error) {
      if (isMissingPathError(error)) return;
      if (!isTransientFileLockError(error) || attempt === ATOMIC_RENAME_ATTEMPTS) {
        throw error;
      }
      await delay(retryDelayMs(attempt));
    }
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(
    ATOMIC_RENAME_RETRY_MAX_DELAY_MS,
    ATOMIC_RENAME_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)),
  );
}

function isTransientFileLockError(error: unknown): boolean {
  return ["EBUSY", "EPERM", "EACCES"].includes(errorCode(error) ?? "");
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
