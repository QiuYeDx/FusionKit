import { promises as fs } from "node:fs";
import path from "node:path";

export const MB = 1024 * 1024;

export const TEXT_SINGLE_FILE_SOFT_WARNING_BYTES = 50 * MB;
export const TEXT_SINGLE_FILE_HARD_LIMIT_BYTES = 200 * MB;
export const MARKDOWN_SINGLE_FILE_SOFT_WARNING_BYTES = 5 * MB;
export const MARKDOWN_SINGLE_FILE_HARD_LIMIT_BYTES = 10 * MB;
export const PROJECT_TOTAL_SOFT_WARNING_BYTES = 200 * MB;
export const PROJECT_TOTAL_HARD_LIMIT_BYTES = 1024 * MB;

export const SUCCESS_WORKSPACE_RETENTION_DAYS = 7;
export const NON_SUCCESS_REVIEW_AFTER_DAYS = 30;

export interface SourceSizeAssessmentInput {
  fileBytes: number;
  projectBytes: number;
  kind: "txt" | "markdown";
}

export interface SourceSizeAssessment {
  warnings: string[];
  errors: string[];
}

export interface WorkspaceDiskEstimate {
  sourceBytes: number;
  minimumRequiredBytes: number;
  recommendedAvailableBytes: number;
}

export interface DiskSpaceAssessment {
  ok: boolean;
  hardBlocked: boolean;
  warnings: string[];
}

export interface TaskCleanupCandidate {
  taskId: string;
  workspacePath: string;
  status: "completed" | "failed" | "cancelled" | "partially_completed";
  updatedAt: string;
}

export interface CleanupSelectionOptions {
  workspaceRoot: string;
  nowMs: number;
  autoCleanNonSuccess?: boolean;
}

export function assessSourceSize(
  input: SourceSizeAssessmentInput,
): SourceSizeAssessment {
  const warnings: string[] = [];
  const errors: string[] = [];

  const softLimit =
    input.kind === "markdown"
      ? MARKDOWN_SINGLE_FILE_SOFT_WARNING_BYTES
      : TEXT_SINGLE_FILE_SOFT_WARNING_BYTES;
  const hardLimit =
    input.kind === "markdown"
      ? MARKDOWN_SINGLE_FILE_HARD_LIMIT_BYTES
      : TEXT_SINGLE_FILE_HARD_LIMIT_BYTES;

  if (input.fileBytes > hardLimit) {
    errors.push(
      `${input.kind}_single_file_hard_limit:${input.fileBytes}:${hardLimit}`,
    );
  } else if (input.fileBytes > softLimit) {
    warnings.push(
      `${input.kind}_single_file_soft_warning:${input.fileBytes}:${softLimit}`,
    );
  }

  if (input.projectBytes > PROJECT_TOTAL_HARD_LIMIT_BYTES) {
    errors.push(
      `project_total_hard_limit:${input.projectBytes}:${PROJECT_TOTAL_HARD_LIMIT_BYTES}`,
    );
  } else if (input.projectBytes > PROJECT_TOTAL_SOFT_WARNING_BYTES) {
    warnings.push(
      `project_total_soft_warning:${input.projectBytes}:${PROJECT_TOTAL_SOFT_WARNING_BYTES}`,
    );
  }

  return { warnings, errors };
}

export function estimateWorkspaceDiskRequirement(
  sourceBytes: number,
): WorkspaceDiskEstimate {
  return {
    sourceBytes,
    minimumRequiredBytes: Math.ceil(sourceBytes * 2 + 64 * MB),
    recommendedAvailableBytes: Math.ceil(sourceBytes * 3.5 + 128 * MB),
  };
}

export function assessDiskSpace(
  estimate: WorkspaceDiskEstimate,
  availableBytes: number,
): DiskSpaceAssessment {
  if (availableBytes < estimate.minimumRequiredBytes) {
    return {
      ok: false,
      hardBlocked: true,
      warnings: [
        `disk_available_below_minimum:${availableBytes}:${estimate.minimumRequiredBytes}`,
      ],
    };
  }

  if (availableBytes < estimate.recommendedAvailableBytes) {
    return {
      ok: true,
      hardBlocked: false,
      warnings: [
        `disk_available_below_recommended:${availableBytes}:${estimate.recommendedAvailableBytes}`,
      ],
    };
  }

  return { ok: true, hardBlocked: false, warnings: [] };
}

export async function getAvailableDiskBytes(directoryPath: string): Promise<number> {
  const stats = await fs.statfs(directoryPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function atomicWriteJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tmpPath, filePath);
  await fsyncDirectoryBestEffort(path.dirname(filePath));
}

export async function appendNdjson(
  filePath: string,
  record: unknown,
): Promise<number> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(filePath, line, "utf-8");
  return Buffer.byteLength(line, "utf-8");
}

export async function writeSegmentResult(
  workspacePath: string,
  segmentId: string,
  translatedText: string,
): Promise<string> {
  const resultPath = path.join(workspacePath, "results", `${segmentId}.txt`);
  await atomicWriteText(resultPath, translatedText);
  return resultPath;
}

export async function completeSegment(
  workspacePath: string,
  segmentId: string,
  translatedText: string,
): Promise<{
  resultPath: string;
  eventBytes: number;
}> {
  const resultPath = await writeSegmentResult(
    workspacePath,
    segmentId,
    translatedText,
  );
  const eventBytes = await appendNdjson(path.join(workspacePath, "events.ndjson"), {
    type: "segment_completed",
    segmentId,
    resultPath,
    at: new Date(0).toISOString(),
  });

  return { resultPath, eventBytes };
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function selectCleanupCandidates(
  tasks: TaskCleanupCandidate[],
  options: CleanupSelectionOptions,
): TaskCleanupCandidate[] {
  const successCutoffMs =
    options.nowMs - SUCCESS_WORKSPACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const nonSuccessCutoffMs =
    options.nowMs - NON_SUCCESS_REVIEW_AFTER_DAYS * 24 * 60 * 60 * 1000;

  return tasks.filter((task) => {
    if (!isPathInside(options.workspaceRoot, task.workspacePath)) return false;

    const updatedAtMs = Date.parse(task.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return false;

    if (task.status === "completed") {
      return updatedAtMs <= successCutoffMs;
    }

    if (!options.autoCleanNonSuccess) return false;
    return updatedAtMs <= nonSuccessCutoffMs;
  });
}

async function atomicWriteText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(text, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
  await fsyncDirectoryBestEffort(path.dirname(filePath));
}

async function fsyncDirectoryBestEffort(directoryPath: string): Promise<void> {
  try {
    const handle = await fs.open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  }
}
