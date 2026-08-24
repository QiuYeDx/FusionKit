/**
 * 字幕翻译模块 - 恢复产物管理
 *
 * 负责生成和写入面向用户的恢复文件：
 *   - completed（已完成译文）
 *   - remaining（未完成原文）
 *   - error.log（失败日志快照）
 *
 * 这些文件仅供用户查看或人工利用，机器恢复依赖 checkpoint manifest。
 */

import { promises as fs } from "fs";
import path from "path";
import type { TranslationCheckpointManifest } from "./typing";
import type { CheckpointArtifactPaths } from "./checkpoint";
import { atomicWriteUtf8File } from "./atomic-file";

const CLEANUP_ATTEMPTS = 7;
const CLEANUP_RETRY_BASE_DELAY_MS = 50;
const CLEANUP_RETRY_MAX_DELAY_MS = 400;
const artifactFlushQueues = new Map<string, Promise<void>>();

export interface RecoveryArtifactWriteFailure {
  readonly artifact: "remaining" | "error_log" | "completed";
  readonly reason: string;
}

export interface RecoveryArtifactCleanupFailure {
  readonly artifact:
    | "remaining"
    | "error_log"
    | "completed"
    | "manifest"
    | "completion_summary";
  readonly reason: string;
}

// ─── Content builders ───────────────────────────────────────────────────────

export function buildCompletedContent(
  manifest: TranslationCheckpointManifest,
): string {
  return manifest.fragments
    .filter((f) => f.status === "resolved" && f.translatedContent)
    .sort((a, b) => a.index - b.index)
    .map((f) => f.translatedContent!)
    .join("\n\n");
}

export function buildRemainingContent(
  manifest: TranslationCheckpointManifest,
): string {
  return manifest.fragments
    .filter((f) => f.status !== "resolved" || !f.translatedContent)
    .sort((a, b) => a.index - b.index)
    .map((f) => f.sourceContent)
    .join("\n\n");
}

export function buildFinalContent(
  manifest: TranslationCheckpointManifest,
  separator: string = "\n\n",
): string {
  return manifest.fragments
    .sort((a, b) => a.index - b.index)
    .map((f) => f.translatedContent!)
    .join(separator);
}

// ─── File writers ───────────────────────────────────────────────────────────

export async function writeCompletedFile(
  manifest: TranslationCheckpointManifest,
  paths: CheckpointArtifactPaths,
): Promise<void> {
  const content = buildCompletedContent(manifest);
  if (!content) return;
  await atomicWriteUtf8File(paths.completedPath, content);
}

export async function writeRemainingFile(
  manifest: TranslationCheckpointManifest,
  paths: CheckpointArtifactPaths,
): Promise<void> {
  const content = buildRemainingContent(manifest);
  if (!content) {
    await deleteIfExists(paths.remainingPath);
    return;
  }
  await atomicWriteUtf8File(paths.remainingPath, content);
}

export async function writeErrorLog(
  paths: CheckpointArtifactPaths,
  errorLogs: string[],
): Promise<void> {
  if (errorLogs.length === 0) return;
  await atomicWriteUtf8File(paths.errorLogPath, errorLogs.join("\n"));
}

/**
 * 一次性刷新所有恢复产物（completed + remaining + error.log）。
 * 在分片成功或任务失败时调用。
 */
export async function flushRecoveryArtifacts(
  manifest: TranslationCheckpointManifest,
  paths: CheckpointArtifactPaths,
  errorLogs?: string[],
): Promise<readonly RecoveryArtifactWriteFailure[]> {
  // Snapshot before entering the queue. Concurrent translation workers mutate
  // the shared manifest while earlier publications are still settling.
  const snapshot = Object.freeze({
    completedContent: buildCompletedContent(manifest),
    remainingContent: buildRemainingContent(manifest),
    errorLogContent: errorLogs?.length ? errorLogs.join("\n") : undefined,
  });
  const queueKey = normalizeQueueKey(paths.manifestPath);

  return enqueueArtifactFlush(queueKey, async () => {
    const operations: Array<{
      artifact: RecoveryArtifactWriteFailure["artifact"];
      run(): Promise<string | undefined>;
    }> = [];

    if (snapshot.completedContent) {
      operations.push({
        artifact: "completed",
        run: () => captureWriteFailure(
          paths.completedPath,
          snapshot.completedContent,
        ),
      });
    }
    operations.push({
      artifact: "remaining",
      run: snapshot.remainingContent
        ? () => captureWriteFailure(paths.remainingPath, snapshot.remainingContent)
        : () => deleteWithBoundedRetry(paths.remainingPath),
    });
    if (snapshot.errorLogContent) {
      operations.push({
        artifact: "error_log",
        run: () => captureWriteFailure(
          paths.errorLogPath,
          snapshot.errorLogContent!,
        ),
      });
    }

    const results = await Promise.all(operations.map(async ({ artifact, run }) => {
      const reason = await run();
      return reason ? Object.freeze({ artifact, reason }) : undefined;
    }));
    return Object.freeze(results.filter(
      (result): result is RecoveryArtifactWriteFailure => result !== undefined,
    ));
  });
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

async function deleteIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

/**
 * 任务成功完成后清理临时恢复产物。
 * 对每项产物独立执行有界清理；失败作为摘要返回，不能影响已提交的最终译文。
 */
export async function cleanupOnSuccess(
  paths: CheckpointArtifactPaths,
): Promise<readonly RecoveryArtifactCleanupFailure[]> {
  const artifacts: Array<{
    artifact: RecoveryArtifactCleanupFailure["artifact"];
    filePath: string;
  }> = [
    { artifact: "remaining", filePath: paths.remainingPath },
    { artifact: "error_log", filePath: paths.errorLogPath },
    { artifact: "completed", filePath: paths.completedPath },
    { artifact: "manifest", filePath: paths.manifestPath },
    {
      artifact: "completion_summary",
      filePath: paths.completionSummaryPath,
    },
  ];
  const results = await Promise.all(artifacts.map(async ({ artifact, filePath }) => {
    const failure = await deleteWithBoundedRetry(filePath);
    return failure ? Object.freeze({ artifact, reason: failure }) : undefined;
  }));
  return Object.freeze(results.filter(
    (result): result is RecoveryArtifactCleanupFailure => result !== undefined,
  ));
}

export async function cleanupOnTaskDeletion(
  paths: CheckpointArtifactPaths,
): Promise<readonly RecoveryArtifactCleanupFailure[]> {
  const artifacts: Array<{
    artifact: RecoveryArtifactCleanupFailure["artifact"];
    filePath: string;
  }> = [
    { artifact: "remaining", filePath: paths.remainingPath },
    { artifact: "error_log", filePath: paths.errorLogPath },
    { artifact: "completed", filePath: paths.completedPath },
    { artifact: "manifest", filePath: paths.manifestPath },
    {
      artifact: "completion_summary",
      filePath: paths.completionSummaryPath,
    },
  ];
  const results = await Promise.all(artifacts.map(async ({ artifact, filePath }) => {
    const failure = await deleteWithBoundedRetry(filePath);
    return failure ? Object.freeze({ artifact, reason: failure }) : undefined;
  }));
  return Object.freeze(results.filter(
    (result): result is RecoveryArtifactCleanupFailure => result !== undefined,
  ));
}

async function captureWriteFailure(
  filePath: string,
  content: string,
): Promise<string | undefined> {
  try {
    await atomicWriteUtf8File(filePath, content);
    return undefined;
  } catch (error) {
    return errorReason(error);
  }
}

function enqueueArtifactFlush<T>(
  queueKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = artifactFlushQueues.get(queueKey) ?? Promise.resolve();
  const job = previous.catch(() => undefined).then(operation);
  const tail = job.then(() => undefined, () => undefined);
  artifactFlushQueues.set(queueKey, tail);
  return job.finally(() => {
    if (artifactFlushQueues.get(queueKey) === tail) {
      artifactFlushQueues.delete(queueKey);
    }
  });
}

function normalizeQueueKey(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function deleteWithBoundedRetry(filePath: string): Promise<string | undefined> {
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return undefined;
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      if (!isTransientCleanupError(error) || attempt === CLEANUP_ATTEMPTS) {
        return errorReason(error);
      }
      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          Math.min(
            CLEANUP_RETRY_MAX_DELAY_MS,
            CLEANUP_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)),
          ),
        );
      });
    }
  }
  return "cleanup_failed";
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isTransientCleanupError(error: unknown): boolean {
  return ["EBUSY", "EPERM", "EACCES"].includes(errorCode(error) ?? "");
}

function errorReason(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
