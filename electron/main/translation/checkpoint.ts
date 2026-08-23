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
  type TranslationCheckpointManifestV2,
  type CheckpointFragment,
  type SubtitleTranslatorTask,
  type SubtitleTranslationRecovery,
  SubtitleFileType,
  SubtitleSliceType,
} from "./typing";
import { normalizeSubtitleTranslationUsage } from "./usage";

const CURRENT_SCHEMA_VERSION = 2 as const;

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

export interface CheckpointArtifactPaths {
  readonly manifestPath: string;
  readonly completedPath: string;
  readonly remainingPath: string;
  readonly errorLogPath: string;
  readonly completionSummaryPath: string;
}

export function buildCheckpointPaths(
  outputDir: string,
  fileName: string,
  taskId?: string,
): CheckpointArtifactPaths {
  const base = getBaseName(fileName);
  const ext = getExt(fileName);
  const artifactBase = taskId
    ? `fusionkit-task-${hashContent(taskId).slice(0, 24)}`
    : base;
  return {
    manifestPath: path.join(outputDir, `${artifactBase}.fusionkit.resume.json`),
    completedPath: path.join(
      outputDir,
      `${artifactBase}.fusionkit.completed${ext}`,
    ),
    remainingPath: path.join(
      outputDir,
      `${artifactBase}.fusionkit.remaining${ext}`,
    ),
    errorLogPath: path.join(outputDir, `${artifactBase}.fusionkit.error.log`),
    completionSummaryPath: path.join(
      outputDir,
      `${artifactBase}.fusionkit.completed.json`,
    ),
  };
}

// ─── Atomic JSON write ──────────────────────────────────────────────────────

/**
 * 先写临时文件再 rename，保证 manifest 文件要么完整要么不存在，
 * 避免进程在写入中途退出导致 JSON 损坏。
 */
async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tmpPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(data, null, 2), "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
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
): TranslationCheckpointManifest {
  const now = new Date().toISOString();
  const usage = normalizeSubtitleTranslationUsage(task.actualUsage);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    taskId: task.taskId,
    status: "running",
    createdAt: now,
    updatedAt: now,

    fileName: task.fileName,
    sourceContentHash: hashContent(task.fileContent),
    sourceSize: Buffer.byteLength(task.fileContent, "utf-8"),

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
      thinkingEnabled:
        task.executionBinding.status === "ready" &&
        task.executionBinding.thinkingEnabled === true,
    },

    ...(usage ? { usage } : {}),

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
  return parseCheckpointManifest(JSON.parse(raw));
}

export function parseCheckpointManifest(
  value: unknown,
): TranslationCheckpointManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Checkpoint manifest is not an object.");
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version !== 1 && version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported checkpoint schema version: ${String(version)}`);
  }
  return value as TranslationCheckpointManifest;
}

export function toCurrentManifest(
  manifest: TranslationCheckpointManifest,
): TranslationCheckpointManifestV2 {
  const usage = normalizeSubtitleTranslationUsage(manifest.usage);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    taskId: manifest.taskId,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    fileName: manifest.fileName,
    sourceContentHash: manifest.sourceContentHash,
    ...(manifest.sourceSize === undefined
      ? {}
      : { sourceSize: manifest.sourceSize }),
    options: {
      fileType: manifest.options.fileType,
      sliceType: manifest.options.sliceType,
      ...(manifest.options.customSliceLength === undefined
        ? {}
        : { customSliceLength: manifest.options.customSliceLength }),
      sourceLang: manifest.options.sourceLang,
      targetLang: manifest.options.targetLang,
      translationOutputMode: manifest.options.translationOutputMode,
      thinkingEnabled: manifest.options.thinkingEnabled === true,
    },
    ...(usage ? { usage } : {}),
    fragments: manifest.fragments.map((fragment) => ({
      index: fragment.index,
      sourceHash: fragment.sourceHash,
      sourceContent: fragment.sourceContent,
      ...(fragment.translatedContent === undefined
        ? {}
        : { translatedContent: fragment.translatedContent }),
      status: fragment.status,
      attempts: fragment.attempts,
      ...(fragment.error === undefined ? {} : { error: fragment.error }),
      ...(fragment.startedAt === undefined
        ? {}
        : { startedAt: fragment.startedAt }),
      ...(fragment.completedAt === undefined
        ? {}
        : { completedAt: fragment.completedAt }),
      ...(fragment.model === undefined ? {} : { model: fragment.model }),
    })),
  };
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
    thinkingEnabled:
      task.executionBinding.status === "ready" &&
      task.executionBinding.thinkingEnabled === true,
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
  if ((opts.thinkingEnabled === true) !== taskLang.thinkingEnabled) {
    return { valid: false, reason: "Thinking 模式不一致" };
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

// ─── Self-contained validation ──────────────────────────────────────────────

/**
 * 校验 manifest 自身结构完整性，不依赖源文件。
 * 用于 manifest_fragments 恢复模式，直接使用 manifest 中的分片续跑。
 */
export function validateManifestSelfContained(
  manifest: TranslationCheckpointManifest,
): ValidationResult {
  if (!manifest.fileName || !manifest.options || !manifest.fragments) {
    return { valid: false, reason: "缺少必要字段" };
  }

  if (
    path.basename(manifest.fileName) !== manifest.fileName ||
    ![".lrc", ".srt"].includes(path.extname(manifest.fileName).toLowerCase())
  ) {
    return { valid: false, reason: "fileName 不是受支持的安全字幕文件名" };
  }

  if (!(["running", "failed", "cancelled", "completed"] as const)
    .includes(manifest.status)) {
    return { valid: false, reason: "status 无效" };
  }

  const options = manifest.options;
  if (
    !([SubtitleFileType.LRC, SubtitleFileType.SRT] as const)
      .includes(options.fileType) ||
    !([SubtitleSliceType.NORMAL, SubtitleSliceType.SENSITIVE,
      SubtitleSliceType.CUSTOM] as const).includes(options.sliceType) ||
    typeof options.sourceLang !== "string" ||
    options.sourceLang.length === 0 ||
    options.sourceLang.length > 16 ||
    typeof options.targetLang !== "string" ||
    options.targetLang.length === 0 ||
    options.targetLang.length > 16 ||
    !(["bilingual", "target_only"] as const)
      .includes(options.translationOutputMode) ||
    (options.thinkingEnabled !== undefined &&
      typeof options.thinkingEnabled !== "boolean") ||
    (options.sliceType === SubtitleSliceType.CUSTOM &&
      (!Number.isSafeInteger(options.customSliceLength) ||
        (options.customSliceLength ?? 0) <= 0))
  ) {
    return { valid: false, reason: "options 无效" };
  }

  if (
    manifest.usage !== undefined &&
    !normalizeSubtitleTranslationUsage(manifest.usage)
  ) {
    return { valid: false, reason: "usage 无效" };
  }

  if (!Array.isArray(manifest.fragments) || manifest.fragments.length === 0) {
    return { valid: false, reason: "fragments 为空" };
  }

  const indexes = new Set<number>();
  for (const frag of manifest.fragments) {
    if (
      !Number.isSafeInteger(frag.index) ||
      frag.index < 0 ||
      indexes.has(frag.index)
    ) {
      return { valid: false, reason: `fragment index 不连续或重复: ${frag.index}` };
    }
    indexes.add(frag.index);

    if (
      typeof frag.sourceContent !== "string" ||
      frag.sourceContent.length === 0 ||
      typeof frag.sourceHash !== "string"
    ) {
      return { valid: false, reason: `第 ${frag.index} 个 fragment 缺少 sourceContent 或 sourceHash` };
    }

    if (
      !(["pending", "running", "resolved", "failed"] as const)
        .includes(frag.status) ||
      !Number.isSafeInteger(frag.attempts) ||
      frag.attempts < 0
    ) {
      return { valid: false, reason: `第 ${frag.index} 个 fragment 状态无效` };
    }

    const computedHash = hashContent(frag.sourceContent);
    if (computedHash !== frag.sourceHash) {
      return { valid: false, reason: `第 ${frag.index} 个 fragment hash 校验失败` };
    }

    if (
      frag.status === "resolved" &&
      (typeof frag.translatedContent !== "string" ||
        frag.translatedContent.length === 0)
    ) {
      return { valid: false, reason: `第 ${frag.index} 个 fragment 标记为 resolved 但无译文` };
    }
  }

  const sortedIndexes = [...indexes].sort((left, right) => left - right);
  if (sortedIndexes.some((index, position) => index !== position)) {
    return { valid: false, reason: "fragment index 不连续" };
  }

  return { valid: true };
}

/**
 * 从 manifest 的 fragments 中提取原文分片，
 * 用于 manifest_fragments 模式下不依赖源文件的续跑。
 */
export function getManifestFragments(
  manifest: TranslationCheckpointManifest,
): string[] {
  return manifest.fragments
    .sort((a, b) => a.index - b.index)
    .map((f) => f.sourceContent);
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
  checkpointRef: string,
): SubtitleTranslationRecovery {
  const failedIndexes = manifest.fragments
    .filter((f) => f.status === "failed")
    .map((f) => f.index);

  return {
    checkpointRef,
    resumable: true,
    failedFragmentIndexes: failedIndexes.length > 0 ? failedIndexes : undefined,
    resolvedFragments: getResolvedCount(manifest),
    totalFragments: manifest.fragments.length,
  };
}
