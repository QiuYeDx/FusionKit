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
import { randomUUID } from "node:crypto";
import type { TranslationCheckpointManifest } from "./typing";
import type { CheckpointArtifactPaths } from "./checkpoint";

const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 25;

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

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeCompletedFile(
  manifest: TranslationCheckpointManifest,
  paths: CheckpointArtifactPaths,
): Promise<void> {
  const content = buildCompletedContent(manifest);
  if (!content) return;
  await atomicWriteFile(paths.completedPath, content);
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
  await atomicWriteFile(paths.remainingPath, content);
}

export async function writeErrorLog(
  paths: CheckpointArtifactPaths,
  errorLogs: string[],
): Promise<void> {
  if (errorLogs.length === 0) return;
  await atomicWriteFile(paths.errorLogPath, errorLogs.join("\n"));
}

/**
 * 一次性刷新所有恢复产物（completed + remaining + error.log）。
 * 在分片成功或任务失败时调用。
 */
export async function flushRecoveryArtifacts(
  manifest: TranslationCheckpointManifest,
  paths: CheckpointArtifactPaths,
  errorLogs?: string[],
): Promise<void> {
  await Promise.all([
    writeCompletedFile(manifest, paths),
    writeRemainingFile(manifest, paths),
    ...(errorLogs ? [writeErrorLog(paths, errorLogs)] : []),
  ]);
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
  keepCompleted = false,
): Promise<readonly RecoveryArtifactCleanupFailure[]> {
  const artifacts: Array<{
    artifact: RecoveryArtifactCleanupFailure["artifact"];
    filePath: string;
  }> = [
    { artifact: "remaining", filePath: paths.remainingPath },
    { artifact: "error_log", filePath: paths.errorLogPath },
    ...(keepCompleted
      ? []
      : [{ artifact: "completed" as const, filePath: paths.completedPath }]),
    { artifact: "manifest", filePath: paths.manifestPath },
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

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await ensureDir(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await deleteIfExists(temporaryPath).catch(() => undefined);
  }
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
        setTimeout(resolve, CLEANUP_RETRY_DELAY_MS * attempt);
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
