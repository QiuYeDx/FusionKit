/**
 * 字幕翻译模块 - Checkpoint 管理
 *
 * 职责：
 *   - 创建 / 加载 / 校验 manifest
 *   - 原子写 JSON（write → rename 避免半成品）
 *   - 根据 manifest 计算可恢复的分片列表
 *
 * manifest 不包含 apiKey 等敏感信息。
 */

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import {
  type TranslationCheckpointManifest,
  type CheckpointFragment,
  type SubtitleTranslatorTask,
  type SubtitleTranslationRecovery,
  SubtitleFileType,
  SubtitleSliceType,
} from "./typing";

const CURRENT_SCHEMA_VERSION = 1 as const;

// ─── Hash helpers ────────────────────────────────────────────────────────────

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function getBaseName(fileName: string): string {
  return path.parse(fileName).name;
}

function getExt(fileName: string): string {
  return path.parse(fileName).ext;
}

export function buildCheckpointPaths(
  outputDir: string,
  fileName: string,
): {
  manifestPath: string;
  completedPath: string;
  remainingPath: string;
  errorLogPath: string;
} {
  const base = getBaseName(fileName);
  const ext = getExt(fileName);
  return {
    manifestPath: path.join(outputDir, `${base}.fusionkit.resume.json`),
    completedPath: path.join(outputDir, `${base}.fusionkit.completed${ext}`),
    remainingPath: path.join(outputDir, `${base}.fusionkit.remaining${ext}`),
    errorLogPath: path.join(outputDir, `${base}.fusionkit.error.log`),
  };
}

// ─── Atomic JSON write ──────────────────────────────────────────────────────

/**
 * 先写临时文件再 rename，保证 manifest 文件要么完整要么不存在，
 * 避免进程在写入中途退出导致 JSON 损坏。
 */
async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ─── Create ─────────────────────────────────────────────────────────────────

function detectFileType(fileName: string): SubtitleFileType {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".lrc") return SubtitleFileType.LRC;
  return SubtitleFileType.SRT;
}

export function createManifest(
  task: SubtitleTranslatorTask,
  fragments: string[],
  outputDir: string,
): TranslationCheckpointManifest {
  const now = new Date().toISOString();
  const paths = buildCheckpointPaths(outputDir, task.fileName);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    taskId: `${task.fileName}-${Date.now()}`,
    status: "running",
    createdAt: now,
    updatedAt: now,

    fileName: task.fileName,
    sourceFilePath: task.originFileURL,
    sourceContentHash: hashContent(task.fileContent),
    sourceSize: Buffer.byteLength(task.fileContent, "utf-8"),

    outputDir,
    completedOutputPath: paths.completedPath,
    remainingOutputPath: paths.remainingPath,
    errorLogPath: paths.errorLogPath,

    options: {
      fileType: detectFileType(task.fileName),
      sliceType: task.sliceType,
      customSliceLength:
        task.sliceType === SubtitleSliceType.CUSTOM
          ? task.customSliceLength
          : undefined,
      sourceLang: task.sourceLang || "JA",
      targetLang: task.targetLang || "ZH",
      translationOutputMode: task.translationOutputMode || "bilingual",
    },

    fragments: fragments.map((src, i) => ({
      index: i,
      sourceHash: hashContent(src),
      sourceContent: src,
      status: "pending" as const,
      attempts: 0,
    })),
  };
}

// ─── Load & Validate ────────────────────────────────────────────────────────

export async function loadManifest(
  manifestPath: string,
): Promise<TranslationCheckpointManifest> {
  const raw = await fs.readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as TranslationCheckpointManifest;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * 校验 checkpoint 是否可用于当前任务。
 * 校验清单见设计文档"恢复校验"章节。
 */
export function validateManifest(
  manifest: TranslationCheckpointManifest,
  task: SubtitleTranslatorTask,
  currentFragments: string[],
): ValidationResult {
  if (manifest.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return { valid: false, reason: `不支持的 schema 版本: ${manifest.schemaVersion}` };
  }

  const currentHash = hashContent(task.fileContent);
  if (manifest.sourceContentHash !== currentHash) {
    return { valid: false, reason: "源文件内容已变化" };
  }

  if (manifest.fragments.length !== currentFragments.length) {
    return {
      valid: false,
      reason: `分片数量不一致: manifest=${manifest.fragments.length}, current=${currentFragments.length}`,
    };
  }

  for (let i = 0; i < currentFragments.length; i++) {
    const expected = hashContent(currentFragments[i]);
    if (manifest.fragments[i].sourceHash !== expected) {
      return { valid: false, reason: `第 ${i + 1} 个分片内容不一致` };
    }
  }

  const opts = manifest.options;
  const taskLang = {
    sourceLang: task.sourceLang || "JA",
    targetLang: task.targetLang || "ZH",
    translationOutputMode: task.translationOutputMode || "bilingual",
    sliceType: task.sliceType,
    customSliceLength: task.customSliceLength,
  };

  if (opts.sourceLang !== taskLang.sourceLang) {
    return { valid: false, reason: "源语言不一致" };
  }
  if (opts.targetLang !== taskLang.targetLang) {
    return { valid: false, reason: "目标语言不一致" };
  }
  if (opts.translationOutputMode !== taskLang.translationOutputMode) {
    return { valid: false, reason: "输出模式不一致" };
  }
  if (opts.sliceType !== taskLang.sliceType) {
    return { valid: false, reason: "分片策略不一致" };
  }
  if (
    opts.sliceType === SubtitleSliceType.CUSTOM &&
    opts.customSliceLength !== taskLang.customSliceLength
  ) {
    return { valid: false, reason: "自定义分片长度不一致" };
  }

  return { valid: true };
}

// ─── Persist ────────────────────────────────────────────────────────────────

/**
 * CheckpointWriter 串行化所有 manifest 写入操作，
 * 保证并发分片完成时不会产生竞态。
 */
export class CheckpointWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private manifestPath: string) {}

  write(manifest: TranslationCheckpointManifest): Promise<void> {
    const job = this.queue.then(() =>
      atomicWriteJSON(this.manifestPath, manifest),
    );
    this.queue = job.catch(() => {});
    return job;
  }
}

export async function saveManifest(
  manifestPath: string,
  manifest: TranslationCheckpointManifest,
): Promise<void> {
  await atomicWriteJSON(manifestPath, manifest);
}

// ─── Fragment helpers ───────────────────────────────────────────────────────

export function getIncompleteIndexes(
  manifest: TranslationCheckpointManifest,
): number[] {
  return manifest.fragments
    .filter(
      (f) =>
        f.status !== "resolved" ||
        !f.translatedContent,
    )
    .map((f) => f.index);
}

export function getResolvedCount(
  manifest: TranslationCheckpointManifest,
): number {
  return manifest.fragments.filter(
    (f) => f.status === "resolved" && f.translatedContent,
  ).length;
}

export function allFragmentsResolved(
  manifest: TranslationCheckpointManifest,
): boolean {
  return manifest.fragments.every(
    (f) => f.status === "resolved" && f.translatedContent,
  );
}

export function markFragmentRunning(
  fragment: CheckpointFragment,
  model?: string,
): void {
  fragment.status = "running";
  fragment.startedAt = new Date().toISOString();
  fragment.attempts += 1;
  if (model) fragment.model = model;
}

export function markFragmentResolved(
  fragment: CheckpointFragment,
  translatedContent: string,
): void {
  fragment.status = "resolved";
  fragment.translatedContent = translatedContent;
  fragment.completedAt = new Date().toISOString();
  fragment.error = undefined;
}

export function markFragmentFailed(
  fragment: CheckpointFragment,
  error: string,
): void {
  fragment.status = "failed";
  fragment.error = error;
  fragment.completedAt = new Date().toISOString();
}

// ─── Recovery summary ───────────────────────────────────────────────────────

export function buildRecoverySummary(
  manifest: TranslationCheckpointManifest,
  manifestPath: string,
): SubtitleTranslationRecovery {
  const failedIndexes = manifest.fragments
    .filter((f) => f.status === "failed")
    .map((f) => f.index);

  return {
    checkpointPath: manifestPath,
    completedOutputPath: manifest.completedOutputPath,
    remainingOutputPath: manifest.remainingOutputPath,
    errorLogPath: manifest.errorLogPath,
    resumable: true,
    failedFragmentIndexes: failedIndexes.length > 0 ? failedIndexes : undefined,
    resolvedFragments: getResolvedCount(manifest),
    totalFragments: manifest.fragments.length,
  };
}
