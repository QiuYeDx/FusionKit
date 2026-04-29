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
): string {
  return manifest.fragments
    .sort((a, b) => a.index - b.index)
    .map((f) => f.translatedContent!)
    .join("\n\n");
}

// ─── File writers ───────────────────────────────────────────────────────────

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeCompletedFile(
  manifest: TranslationCheckpointManifest,
): Promise<void> {
  const content = buildCompletedContent(manifest);
  if (!content) return;
  await ensureDir(manifest.completedOutputPath);
  await fs.writeFile(manifest.completedOutputPath, content, "utf-8");
}

export async function writeRemainingFile(
  manifest: TranslationCheckpointManifest,
): Promise<void> {
  const content = buildRemainingContent(manifest);
  if (!content) {
    await safeDelete(manifest.remainingOutputPath);
    return;
  }
  await ensureDir(manifest.remainingOutputPath);
  await fs.writeFile(manifest.remainingOutputPath, content, "utf-8");
}

export async function writeErrorLog(
  manifest: TranslationCheckpointManifest,
  errorLogs: string[],
): Promise<void> {
  if (errorLogs.length === 0) return;
  const logPath = manifest.errorLogPath;
  if (!logPath) return;
  await ensureDir(logPath);
  await fs.writeFile(logPath, errorLogs.join("\n"), "utf-8");
}

/**
 * 一次性刷新所有恢复产物（completed + remaining + error.log）。
 * 在分片成功或任务失败时调用。
 */
export async function flushRecoveryArtifacts(
  manifest: TranslationCheckpointManifest,
  errorLogs?: string[],
): Promise<void> {
  await Promise.all([
    writeCompletedFile(manifest),
    writeRemainingFile(manifest),
    ...(errorLogs ? [writeErrorLog(manifest, errorLogs)] : []),
  ]);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

async function safeDelete(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // file doesn't exist — ok
  }
}

/**
 * 任务成功完成后清理临时恢复产物。
 * remaining 文件一定删除，manifest 和 completed 可选保留。
 */
export async function cleanupOnSuccess(
  manifest: TranslationCheckpointManifest,
  manifestPath: string,
  keepCompleted = false,
): Promise<void> {
  await safeDelete(manifest.remainingOutputPath);
  if (manifest.errorLogPath) await safeDelete(manifest.errorLogPath);
  if (!keepCompleted) await safeDelete(manifest.completedOutputPath);
  await safeDelete(manifestPath);
}
