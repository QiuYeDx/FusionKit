import { app } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type {
  PersistedTextTranslationTask,
  TextTranslationFileRef,
  TextTranslationTaskStatus,
} from "@/type/textTranslation";
import {
  assertTextTranslationEventLogPayloadSafe,
  replayTextTranslationEvents,
  type TextTranslationReplayedState,
  type TextTranslationWorkspaceEvent,
} from "./event-log";

export interface TextTranslationWorkspaceRepositoryOptions {
  tasksRoot?: string;
}

export interface TextTranslationWorkspacePaths {
  root: string;
  taskJson: string;
  filesNdjson: string;
  unitsDir: string;
  segmentsDir: string;
  segmentsIndex: string;
  segmentsSourceDir: string;
  resultsDir: string;
  memoryDir: string;
  memoryLatest: string;
  memorySnapshotsDir: string;
  eventsNdjson: string;
  metricsJson: string;
  locksDir: string;
}

export interface TextTranslationWorkspaceCleanupPolicy {
  now?: Date;
  successfulRetentionDays?: number;
  nonSuccessReviewAfterDays?: number;
  deleteEligible?: boolean;
}

export type TextTranslationWorkspaceCleanupAction =
  | "delete"
  | "retain"
  | "review";

export type TextTranslationWorkspaceCleanupReason =
  | "completed_retention_expired"
  | "completed_retention_active"
  | "non_success_requires_review"
  | "non_success_retained"
  | "unsupported_schema"
  | "missing_task_metadata"
  | "invalid_task_metadata";

export interface TextTranslationWorkspaceCleanupItem {
  taskId: string;
  workspacePath: string;
  action: TextTranslationWorkspaceCleanupAction;
  reason: TextTranslationWorkspaceCleanupReason;
  status?: TextTranslationTaskStatus;
  updatedAt?: string;
  ageDays?: number;
  deleted?: boolean;
}

export class TextTranslationWorkspaceRepository {
  readonly tasksRoot: string;

  constructor(options: TextTranslationWorkspaceRepositoryOptions = {}) {
    this.tasksRoot = path.resolve(
      options.tasksRoot ??
        path.join(app.getPath("userData"), "text-translation", "tasks"),
    );
  }

  getTaskWorkspacePath(taskId: string): string {
    assertSafeWorkspaceId(taskId, "taskId");
    return assertPathInside(path.join(this.tasksRoot, taskId), this.tasksRoot);
  }

  getPaths(taskId: string): TextTranslationWorkspacePaths {
    const root = this.getTaskWorkspacePath(taskId);
    return {
      root,
      taskJson: path.join(root, "task.json"),
      filesNdjson: path.join(root, "files.ndjson"),
      unitsDir: path.join(root, "units"),
      segmentsDir: path.join(root, "segments"),
      segmentsIndex: path.join(root, "segments", "index.ndjson"),
      segmentsSourceDir: path.join(root, "segments", "source"),
      resultsDir: path.join(root, "results"),
      memoryDir: path.join(root, "memory"),
      memoryLatest: path.join(root, "memory", "latest.json"),
      memorySnapshotsDir: path.join(root, "memory", "snapshots"),
      eventsNdjson: path.join(root, "events.ndjson"),
      metricsJson: path.join(root, "metrics.json"),
      locksDir: path.join(root, "locks"),
    };
  }

  async ensureWorkspace(taskId: string): Promise<TextTranslationWorkspacePaths> {
    const paths = this.getPaths(taskId);
    await Promise.all([
      fs.mkdir(paths.root, { recursive: true }),
      fs.mkdir(paths.unitsDir, { recursive: true }),
      fs.mkdir(paths.segmentsSourceDir, { recursive: true }),
      fs.mkdir(paths.resultsDir, { recursive: true }),
      fs.mkdir(paths.memorySnapshotsDir, { recursive: true }),
      fs.mkdir(paths.locksDir, { recursive: true }),
    ]);
    return paths;
  }

  async writeTask(task: PersistedTextTranslationTask): Promise<void> {
    const paths = await this.ensureWorkspace(task.taskId);
    await atomicWriteJson(paths.taskJson, task);
  }

  async readTask(taskId: string): Promise<PersistedTextTranslationTask | null> {
    const paths = this.getPaths(taskId);
    return readJsonFile<PersistedTextTranslationTask>(paths.taskJson);
  }

  async writeFilesIndex(
    taskId: string,
    files: TextTranslationFileRef[],
  ): Promise<void> {
    const paths = await this.ensureWorkspace(taskId);
    await atomicWriteNdjson(paths.filesNdjson, files);
  }

  async readFilesIndex(taskId: string): Promise<TextTranslationFileRef[]> {
    return readNdjsonFile<TextTranslationFileRef>(
      this.getPaths(taskId).filesNdjson,
    );
  }

  async writeUnits<TUnit>(
    taskId: string,
    fileId: string,
    units: TUnit[],
  ): Promise<void> {
    assertSafeWorkspaceId(fileId, "fileId");
    const paths = await this.ensureWorkspace(taskId);
    await atomicWriteNdjson(path.join(paths.unitsDir, `${fileId}.ndjson`), units);
  }

  async readUnits<TUnit>(taskId: string, fileId: string): Promise<TUnit[]> {
    assertSafeWorkspaceId(fileId, "fileId");
    return readNdjsonFile<TUnit>(
      path.join(this.getPaths(taskId).unitsDir, `${fileId}.ndjson`),
    );
  }

  async writeSegmentsIndex<TSegment>(
    taskId: string,
    segments: TSegment[],
  ): Promise<void> {
    const paths = await this.ensureWorkspace(taskId);
    await atomicWriteNdjson(paths.segmentsIndex, segments);
  }

  async readSegmentsIndex<TSegment>(taskId: string): Promise<TSegment[]> {
    return readNdjsonFile<TSegment>(this.getPaths(taskId).segmentsIndex);
  }

  async writeSegmentSource(
    taskId: string,
    segmentId: string,
    sourceText: string,
  ): Promise<string> {
    assertSafeWorkspaceId(segmentId, "segmentId");
    const paths = await this.ensureWorkspace(taskId);
    const targetPath = path.join(paths.segmentsSourceDir, `${segmentId}.txt`);
    await atomicWriteFile(targetPath, sourceText, "utf-8");
    return targetPath;
  }

  async readSegmentSource(taskId: string, segmentId: string): Promise<string> {
    assertSafeWorkspaceId(segmentId, "segmentId");
    return fs.readFile(
      path.join(this.getPaths(taskId).segmentsSourceDir, `${segmentId}.txt`),
      "utf-8",
    );
  }

  async writeSegmentResult(
    taskId: string,
    segmentId: string,
    translatedText: string,
  ): Promise<string> {
    assertSafeWorkspaceId(segmentId, "segmentId");
    const paths = await this.ensureWorkspace(taskId);
    const targetPath = path.join(paths.resultsDir, `${segmentId}.txt`);
    await atomicWriteFile(targetPath, translatedText, "utf-8");
    return targetPath;
  }

  async readSegmentResult(taskId: string, segmentId: string): Promise<string> {
    assertSafeWorkspaceId(segmentId, "segmentId");
    return fs.readFile(
      path.join(this.getPaths(taskId).resultsDir, `${segmentId}.txt`),
      "utf-8",
    );
  }

  async writeMemoryLatest<TMemory>(
    taskId: string,
    memory: TMemory,
  ): Promise<void> {
    const paths = await this.ensureWorkspace(taskId);
    await atomicWriteJson(paths.memoryLatest, memory);
  }

  async readMemoryLatest<TMemory>(taskId: string): Promise<TMemory | null> {
    return readJsonFile<TMemory>(this.getPaths(taskId).memoryLatest);
  }

  async writeMemorySnapshot<TMemory>(
    taskId: string,
    snapshotId: string,
    memory: TMemory,
  ): Promise<string> {
    assertSafeWorkspaceId(snapshotId, "snapshotId");
    const paths = await this.ensureWorkspace(taskId);
    const targetPath = path.join(paths.memorySnapshotsDir, `${snapshotId}.json`);
    await atomicWriteJson(targetPath, memory);
    return targetPath;
  }

  async readMemorySnapshot<TMemory>(
    taskId: string,
    snapshotId: string,
  ): Promise<TMemory | null> {
    assertSafeWorkspaceId(snapshotId, "snapshotId");
    return readJsonFile<TMemory>(
      path.join(this.getPaths(taskId).memorySnapshotsDir, `${snapshotId}.json`),
    );
  }

  async appendEvent(
    taskId: string,
    event: TextTranslationWorkspaceEvent,
  ): Promise<void> {
    if (event.taskId !== taskId) {
      throw new Error("Event taskId must match the target workspace taskId.");
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new Error("Event sequence must be a non-negative integer.");
    }
    assertTextTranslationEventLogPayloadSafe(event);

    const paths = await this.ensureWorkspace(taskId);
    await appendNdjsonRecord(paths.eventsNdjson, event);
  }

  async readEvents(taskId: string): Promise<TextTranslationWorkspaceEvent[]> {
    return readNdjsonFile<TextTranslationWorkspaceEvent>(
      this.getPaths(taskId).eventsNdjson,
    );
  }

  async replayEvents(taskId: string): Promise<TextTranslationReplayedState> {
    return replayTextTranslationEvents(await this.readEvents(taskId));
  }

  async listTaskIds(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.tasksRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((taskId) => {
        try {
          assertSafeWorkspaceId(taskId, "taskId");
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  }

  async deleteWorkspace(taskId: string): Promise<void> {
    const workspacePath = this.getTaskWorkspacePath(taskId);
    assertPathInside(workspacePath, this.tasksRoot);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  async planWorkspaceCleanup(
    policy: TextTranslationWorkspaceCleanupPolicy = {},
  ): Promise<TextTranslationWorkspaceCleanupItem[]> {
    const now = policy.now ?? new Date();
    const successfulRetentionDays =
      policy.successfulRetentionDays ?? 7;
    const nonSuccessReviewAfterDays =
      policy.nonSuccessReviewAfterDays ?? 30;
    const items: TextTranslationWorkspaceCleanupItem[] = [];

    for (const taskId of await this.listTaskIds()) {
      const workspacePath = this.getTaskWorkspacePath(taskId);
      const task = await this.readTask(taskId);
      if (!task) {
        items.push({
          taskId,
          workspacePath,
          action: "review",
          reason: "missing_task_metadata",
        });
        continue;
      }
      if (task.schemaVersion !== 1) {
        items.push({
          taskId,
          workspacePath,
          action: "review",
          reason: "unsupported_schema",
          updatedAt: task.updatedAt,
        });
        continue;
      }

      const ageDays = calculateAgeDays(task.updatedAt, now);
      if (ageDays === undefined) {
        items.push({
          taskId,
          workspacePath,
          action: "review",
          reason: "invalid_task_metadata",
          status: task.status,
          updatedAt: task.updatedAt,
        });
        continue;
      }

      if (task.status === "completed") {
        items.push({
          taskId,
          workspacePath,
          action:
            ageDays >= successfulRetentionDays ? "delete" : "retain",
          reason:
            ageDays >= successfulRetentionDays
              ? "completed_retention_expired"
              : "completed_retention_active",
          status: task.status,
          updatedAt: task.updatedAt,
          ageDays,
        });
        continue;
      }

      items.push({
        taskId,
        workspacePath,
        action:
          ageDays >= nonSuccessReviewAfterDays ? "review" : "retain",
        reason:
          ageDays >= nonSuccessReviewAfterDays
            ? "non_success_requires_review"
            : "non_success_retained",
        status: task.status,
        updatedAt: task.updatedAt,
        ageDays,
      });
    }

    return items;
  }

  async cleanupWorkspaces(
    policy: TextTranslationWorkspaceCleanupPolicy = {},
  ): Promise<TextTranslationWorkspaceCleanupItem[]> {
    const items = await this.planWorkspaceCleanup(policy);
    if (policy.deleteEligible === false) return items;

    for (const item of items) {
      if (item.action !== "delete") continue;
      await this.deleteWorkspace(item.taskId);
      item.deleted = true;
    }

    return items;
  }
}

export function assertSafeWorkspaceId(value: string, field: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error(
      `${field} must contain only letters, numbers, underscores, or hyphens.`,
    );
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function atomicWriteNdjson<T>(
  filePath: string,
  records: T[],
): Promise<void> {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await atomicWriteFile(filePath, content ? `${content}\n` : "", "utf-8");
}

async function appendNdjsonRecord<T>(
  filePath: string,
  record: T,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readNdjsonFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function atomicWriteFile(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "w");
    await handle.writeFile(content, encoding);
    await handle.sync();
  } finally {
    await handle?.close();
  }

  await fs.rename(tmpPath, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Some platforms or filesystems do not support fsync on directories.
  } finally {
    await handle?.close();
  }
}

function assertPathInside(candidatePath: string, rootPath: string): string {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(rootPath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved path escapes the text translation workspace root.");
  }
  return resolvedCandidate;
}

function calculateAgeDays(updatedAt: string, now: Date): number | undefined {
  const updatedAtMs = Date.parse(updatedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return undefined;
  return Math.max(0, Math.floor((nowMs - updatedAtMs) / 86_400_000));
}
