/**
 * 字幕翻译模块 - 恢复发现
 *
 * 职责：
 *   1. 扫描用户授权目录内的 *.fusionkit.resume.json
 *   2. 安全解析 manifest，不向 renderer 返回字幕全文和译文全文
 *   3. 校验 manifest 基础结构和 fragment 自洽性
 *   4. 读取源文件元数据并判断源文件是否存在、是否与 sourceContentHash 一致
 *   5. 生成恢复候选摘要
 *   6. 在用户确认恢复时生成任务草稿
 */

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import {
  type TranslationCheckpointManifest,
  type TranslationRecoveryScanRequest,
  type TranslationRecoveryScanResult,
  type TranslationRecoveryCandidate,
  type TranslationRecoveryImportRequest,
  type RecoveredSubtitleTaskDraft,
  type TranslationRecoveryInputMode,
  SubtitleSliceType,
} from "./typing";
import { hashContent, getResolvedCount, getIncompleteIndexes } from "./checkpoint";

const MANIFEST_SUFFIX = ".fusionkit.resume.json";
const MAX_DEPTH_DEFAULT = 8;
const MAX_FILES_DEFAULT = 500;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".Trash",
  "$RECYCLE.BIN",
]);

// ─── Scan ────────────────────────────────────────────────────────────────────

export async function scanTranslationRecoveryArtifacts(
  request: TranslationRecoveryScanRequest,
): Promise<TranslationRecoveryScanResult> {
  const {
    roots,
    recursive = true,
    maxDepth = MAX_DEPTH_DEFAULT,
    maxFiles = MAX_FILES_DEFAULT,
    includeCompleted = false,
  } = request;

  const result: TranslationRecoveryScanResult = {
    candidates: [],
    scannedDirs: 0,
    scannedFiles: 0,
    skippedFiles: 0,
    truncated: false,
    errors: [],
  };

  for (const root of roots) {
    if (result.truncated) break;
    try {
      await scanDir(root, 0, maxDepth, recursive, includeCompleted, maxFiles, result);
    } catch (err) {
      result.errors.push({
        path: root,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function scanDir(
  dirPath: string,
  depth: number,
  maxDepth: number,
  recursive: boolean,
  includeCompleted: boolean,
  maxFiles: number,
  result: TranslationRecoveryScanResult,
): Promise<void> {
  if (result.candidates.length >= maxFiles) {
    result.truncated = true;
    return;
  }
  if (depth > maxDepth) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    result.errors.push({
      path: dirPath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  result.scannedDirs++;

  for (const entry of entries) {
    if (result.candidates.length >= maxFiles) {
      result.truncated = true;
      return;
    }

    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (!recursive) continue;
      const dirName = entry.name;
      if (dirName.startsWith(".") || SKIP_DIRS.has(dirName)) continue;
      await scanDir(
        path.join(dirPath, dirName),
        depth + 1,
        maxDepth,
        recursive,
        includeCompleted,
        maxFiles,
        result,
      );
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(MANIFEST_SUFFIX)) continue;

    result.scannedFiles++;
    const filePath = path.join(dirPath, entry.name);

    try {
      const candidate = await inspectManifestFile(filePath);
      if (!includeCompleted && candidate.recoverability === "completed") {
        result.skippedFiles++;
        continue;
      }
      result.candidates.push(candidate);
    } catch (err) {
      result.skippedFiles++;
      result.errors.push({
        path: filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── Inspect ─────────────────────────────────────────────────────────────────

export async function inspectTranslationRecoveryArtifact(
  checkpointPath: string,
): Promise<TranslationRecoveryCandidate> {
  return inspectManifestFile(checkpointPath);
}

async function inspectManifestFile(
  filePath: string,
): Promise<TranslationRecoveryCandidate> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return buildErrorCandidate(filePath, "too_large", `文件大小 ${Math.round(stat.size / 1024 / 1024)}MB 超过限制`);
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    return buildErrorCandidate(filePath, "corrupt_manifest", "无法读取文件");
  }

  let manifest: TranslationCheckpointManifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return buildErrorCandidate(filePath, "corrupt_manifest", "JSON 解析失败");
  }

  const structureResult = validateManifestStructure(manifest);
  if (!structureResult.valid) {
    return buildErrorCandidate(
      filePath,
      structureResult.recoverability as any,
      structureResult.reason!,
    );
  }

  const resolvedCount = getResolvedCount(manifest);
  const totalCount = manifest.fragments.length;
  const incompleteIndexes = getIncompleteIndexes(manifest);
  const failedIndexes = manifest.fragments
    .filter((f) => f.status === "failed")
    .map((f) => f.index);

  const sourceState = await checkSourceFileState(manifest);
  const recoverability = determineRecoverability(manifest, sourceState, incompleteIndexes);

  return {
    id: manifest.taskId || crypto.randomUUID(),
    checkpointPath: filePath,
    fileName: manifest.fileName,
    manifestStatus: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    outputDir: manifest.outputDir,
    completedOutputPath: manifest.completedOutputPath,
    remainingOutputPath: manifest.remainingOutputPath,
    errorLogPath: manifest.errorLogPath,
    finalOutputPath: manifest.finalOutputPath,
    options: {
      fileType: manifest.options.fileType as "LRC" | "SRT",
      sliceType: manifest.options.sliceType as "NORMAL" | "SENSITIVE" | "CUSTOM",
      customSliceLength: manifest.options.customSliceLength,
      sourceLang: manifest.options.sourceLang,
      targetLang: manifest.options.targetLang,
      translationOutputMode: manifest.options.translationOutputMode,
    },
    resolvedFragments: resolvedCount,
    totalFragments: totalCount,
    failedFragmentIndexes: failedIndexes.length > 0 ? failedIndexes : undefined,
    progress: totalCount > 0 ? Math.round((resolvedCount / totalCount) * 100) : 0,
    sourceFilePath: manifest.sourceFilePath,
    sourceState,
    recoverability,
    blockingReason: recoverability === "ready" || recoverability === "ready_from_manifest"
      ? undefined
      : getBlockingReason(recoverability),
  };
}

// ─── Create Draft ────────────────────────────────────────────────────────────

export async function createRecoveredSubtitleTaskDraft(
  request: TranslationRecoveryImportRequest,
): Promise<RecoveredSubtitleTaskDraft> {
  const { checkpointPath, recoveryInputMode } = request;

  const raw = await fs.readFile(checkpointPath, "utf-8");
  const manifest: TranslationCheckpointManifest = JSON.parse(raw);

  const structureResult = validateManifestStructure(manifest);
  if (!structureResult.valid) {
    throw new Error(`Manifest 校验失败: ${structureResult.reason}`);
  }

  let fileContent: string | undefined;

  if (recoveryInputMode === "source_file") {
    if (!manifest.sourceFilePath) {
      throw new Error("Manifest 中未记录源文件路径");
    }
    fileContent = await fs.readFile(manifest.sourceFilePath, "utf-8");
    const currentHash = hashContent(fileContent);
    if (currentHash !== manifest.sourceContentHash) {
      throw new Error("源文件内容已变化，与 manifest 不一致");
    }
  }

  const resolvedCount = getResolvedCount(manifest);
  const totalCount = manifest.fragments.length;
  const failedIndexes = manifest.fragments
    .filter((f) => f.status === "failed")
    .map((f) => f.index);

  return {
    fileName: manifest.fileName,
    fileContent,
    originFileURL: manifest.sourceFilePath || "",
    targetFileURL: manifest.outputDir,
    sliceType: manifest.options.sliceType as SubtitleSliceType,
    customSliceLength: manifest.options.customSliceLength,
    sourceLang: manifest.options.sourceLang as any,
    targetLang: manifest.options.targetLang as any,
    translationOutputMode: manifest.options.translationOutputMode,
    resolvedFragments: resolvedCount,
    totalFragments: totalCount,
    progress: totalCount > 0 ? Math.round((resolvedCount / totalCount) * 100) : 0,
    recoveryMode: "resume",
    checkpointPath,
    recoveryInputMode,
    recovery: {
      checkpointPath,
      completedOutputPath: manifest.completedOutputPath,
      remainingOutputPath: manifest.remainingOutputPath,
      errorLogPath: manifest.errorLogPath,
      resumable: true,
      failedFragmentIndexes: failedIndexes.length > 0 ? failedIndexes : undefined,
      resolvedFragments: resolvedCount,
      totalFragments: totalCount,
    },
  };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

type StructureValidation = {
  valid: boolean;
  reason?: string;
  recoverability?: string;
};

function validateManifestStructure(
  manifest: any,
): StructureValidation {
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, reason: "不是有效的 JSON 对象", recoverability: "corrupt_manifest" };
  }

  if (manifest.schemaVersion !== 1) {
    return { valid: false, reason: `不支持的 schema 版本: ${manifest.schemaVersion}`, recoverability: "unsupported_schema" };
  }

  if (!manifest.fileName || !manifest.outputDir || !manifest.options || !manifest.fragments) {
    return { valid: false, reason: "缺少必要字段 (fileName/outputDir/options/fragments)", recoverability: "invalid_manifest" };
  }

  if (!Array.isArray(manifest.fragments) || manifest.fragments.length === 0) {
    return { valid: false, reason: "fragments 为空或不是数组", recoverability: "invalid_manifest" };
  }

  const indexes = new Set<number>();
  for (const frag of manifest.fragments) {
    if (typeof frag.index !== "number" || indexes.has(frag.index)) {
      return { valid: false, reason: "fragment index 不连续或不唯一", recoverability: "invalid_manifest" };
    }
    indexes.add(frag.index);

    if (!frag.sourceContent || !frag.sourceHash) {
      return { valid: false, reason: `第 ${frag.index} 个 fragment 缺少 sourceContent 或 sourceHash`, recoverability: "invalid_manifest" };
    }

    const computedHash = hashContent(frag.sourceContent);
    if (computedHash !== frag.sourceHash) {
      return { valid: false, reason: `第 ${frag.index} 个 fragment sourceHash 校验失败`, recoverability: "invalid_manifest" };
    }

    if (frag.status === "resolved" && !frag.translatedContent) {
      return { valid: false, reason: `第 ${frag.index} 个 fragment 状态为 resolved 但无译文`, recoverability: "invalid_manifest" };
    }
  }

  return { valid: true };
}

async function checkSourceFileState(
  manifest: TranslationCheckpointManifest,
): Promise<TranslationRecoveryCandidate["sourceState"]> {
  if (!manifest.sourceFilePath) return "unknown";

  try {
    await fs.access(manifest.sourceFilePath);
  } catch {
    return "missing";
  }

  if (!manifest.sourceContentHash) return "not_checked";

  try {
    const content = await fs.readFile(manifest.sourceFilePath, "utf-8");
    const currentHash = hashContent(content);
    return currentHash === manifest.sourceContentHash ? "matched" : "changed";
  } catch {
    return "unknown";
  }
}

function determineRecoverability(
  manifest: TranslationCheckpointManifest,
  sourceState: TranslationRecoveryCandidate["sourceState"],
  incompleteIndexes: number[],
): TranslationRecoveryCandidate["recoverability"] {
  if (manifest.status === "completed") return "completed";
  if (incompleteIndexes.length === 0) return "no_pending_fragments";
  if (sourceState === "matched") return "ready";
  return "ready_from_manifest";
}

function getBlockingReason(recoverability: string): string {
  switch (recoverability) {
    case "completed": return "任务已完成";
    case "no_pending_fragments": return "没有未完成的分片";
    case "unsupported_schema": return "不支持的 schema 版本";
    case "corrupt_manifest": return "恢复清单损坏";
    case "invalid_manifest": return "恢复清单结构无效";
    case "too_large": return "文件过大，超过 50MB 限制";
    default: return "未知原因";
  }
}

function buildErrorCandidate(
  filePath: string,
  recoverability: TranslationRecoveryCandidate["recoverability"],
  reason: string,
): TranslationRecoveryCandidate {
  return {
    id: crypto.randomUUID(),
    checkpointPath: filePath,
    fileName: path.basename(filePath, MANIFEST_SUFFIX),
    manifestStatus: "failed",
    createdAt: "",
    updatedAt: "",
    outputDir: path.dirname(filePath),
    options: {
      fileType: "SRT",
      sliceType: "NORMAL",
      sourceLang: "",
      targetLang: "",
      translationOutputMode: "bilingual",
    },
    resolvedFragments: 0,
    totalFragments: 0,
    progress: 0,
    sourceState: "not_checked",
    recoverability,
    blockingReason: reason,
  };
}
