import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistedTextTranslationTask,
  createTextTranslationTask,
  type PersistedTextTranslationTask,
  type TextTranslationFileRef,
} from "@/type/textTranslation";
import { TextTranslationWorkspaceRepository } from "../../../electron/main/text-translation/persistence/workspace-repository";
import type { TextTranslationWorkspaceEvent } from "../../../electron/main/text-translation/persistence/event-log";

describe("text translation workspace repository", () => {
  let tempRoot: string;
  let repo: TextTranslationWorkspaceRepository;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-text-ws-"));
    repo = new TextTranslationWorkspaceRepository({ tasksRoot: tempRoot });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates only controlled task workspaces and rejects escaping ids", async () => {
    const paths = await repo.ensureWorkspace("task_001");

    expect(paths.root.startsWith(tempRoot)).toBe(true);
    expect(await readdir(paths.root)).toEqual(
      expect.arrayContaining(["units", "segments", "results", "memory", "locks"]),
    );

    expect(() => repo.getTaskWorkspacePath("../task_001")).toThrow();
    await expect(
      repo.writeSegmentSource("task_001", "../segment_001", "text"),
    ).rejects.toThrow();
  });

  it("writes task json, indexes, segment files, and memory snapshots", async () => {
    const task = createPersistedTask();
    const file = createFile();

    await repo.writeTask(task);
    await repo.writeFilesIndex(task.taskId, [file]);
    const fileSourcePath = await repo.writeFileSourceSnapshot(
      task.taskId,
      file.fileId,
      "# Hello",
    );
    await repo.writeUnits(task.taskId, file.fileId, [
      { unitId: "unit_001", sourceText: "Hello" },
    ]);
    await repo.writeSegmentsIndex(task.taskId, [
      { segmentId: "segment_001", unitIds: ["unit_001"] },
    ]);
    const sourcePath = await repo.writeSegmentSource(
      task.taskId,
      "segment_001",
      "Hello",
    );
    const sourcePayloadPath = await repo.writeSegmentSourcePayload(
      task.taskId,
      "segment_002",
      {
        schemaVersion: 1,
        kind: "markdown_target_only",
        segmentId: "segment_002",
      },
    );
    const resultPath = await repo.writeSegmentResult(
      task.taskId,
      "segment_001",
      "你好",
    );
    const resultPayloadPath = await repo.writeSegmentResultPayload(
      task.taskId,
      "segment_002",
      {
        schemaVersion: 1,
        kind: "markdown_target_only",
        segmentId: "segment_002",
        results: [{ unitId: "unit_001", translatedText: "你好" }],
      },
    );
    await repo.writeMemoryLatest(task.taskId, { version: 1 });
    const snapshotPath = await repo.writeMemorySnapshot(task.taskId, "00000010", {
      version: 10,
    });

    expect(await repo.readTask(task.taskId)).toMatchObject({
      taskId: task.taskId,
      schemaVersion: 1,
    });
    expect(await repo.readFilesIndex(task.taskId)).toEqual([file]);
    expect(await repo.readFileSourceSnapshot(task.taskId, file.fileId)).toBe(
      "# Hello",
    );
    expect(await repo.readUnits(task.taskId, file.fileId)).toEqual([
      { unitId: "unit_001", sourceText: "Hello" },
    ]);
    expect(await repo.readSegmentsIndex(task.taskId)).toEqual([
      { segmentId: "segment_001", unitIds: ["unit_001"] },
    ]);
    expect(await repo.readSegmentSource(task.taskId, "segment_001")).toBe(
      "Hello",
    );
    expect(
      await repo.readSegmentSourcePayload(task.taskId, "segment_002"),
    ).toMatchObject({
      kind: "markdown_target_only",
      segmentId: "segment_002",
    });
    expect(await repo.readSegmentResult(task.taskId, "segment_001")).toBe("你好");
    expect(
      await repo.readSegmentResultPayload(task.taskId, "segment_002"),
    ).toMatchObject({
      kind: "markdown_target_only",
      segmentId: "segment_002",
    });
    expect(await repo.readMemoryLatest(task.taskId)).toEqual({ version: 1 });
    expect(await readFile(sourcePath, "utf-8")).toBe("Hello");
    expect(await readFile(fileSourcePath, "utf-8")).toBe("# Hello");
    expect(await readFile(sourcePayloadPath, "utf-8")).toContain(
      '"markdown_target_only"',
    );
    expect(await readFile(resultPath, "utf-8")).toBe("你好");
    expect(await readFile(resultPayloadPath, "utf-8")).toContain(
      '"translatedText": "你好"',
    );
    expect(await readFile(snapshotPath, "utf-8")).toContain('"version": 10');

    const taskDirFiles = await readdir(repo.getTaskWorkspacePath(task.taskId));
    expect(taskDirFiles.some((fileName) => fileName.includes(".tmp-"))).toBe(
      false,
    );
  });

  it("appends safe events and replays minimal task state", async () => {
    const taskId = "task_001";
    const events: TextTranslationWorkspaceEvent[] = [
      {
        type: "segment_started",
        taskId,
        sequence: 1,
        occurredAt: "2026-06-23T00:00:00.000Z",
        segmentId: "segment_001",
      },
      {
        type: "segment_completed",
        taskId,
        sequence: 2,
        occurredAt: "2026-06-23T00:00:01.000Z",
        segmentId: "segment_001",
        resultPath: "/workspace/results/segment_001.txt",
      },
      {
        type: "segment_failed",
        taskId,
        sequence: 2,
        occurredAt: "2026-06-23T00:00:02.000Z",
        segmentId: "segment_001",
        errorCode: "duplicate_old_event",
      },
      {
        type: "task_completed",
        taskId,
        sequence: 3,
        occurredAt: "2026-06-23T00:00:03.000Z",
        outputPaths: ["/output/chapter.zh.txt"],
      },
    ];

    for (const event of events) {
      await repo.appendEvent(taskId, event);
    }

    expect(await repo.readEvents(taskId)).toHaveLength(4);

    const replayed = await repo.replayEvents(taskId);
    expect(replayed.lastSequence).toBe(3);
    expect(replayed.status).toBe("completed");
    expect(replayed.completedSegmentIds).toEqual(["segment_001"]);
    expect(replayed.failedSegmentIds).toEqual([]);
    expect(replayed.segmentResultPaths.segment_001).toBe(
      "/workspace/results/segment_001.txt",
    );
  });

  it("rejects sensitive event payload fields before writing logs", async () => {
    const unsafeEvent = {
      type: "warning",
      taskId: "task_001",
      sequence: 1,
      occurredAt: "2026-06-23T00:00:00.000Z",
      warningCode: "unsafe",
      message: "should not be written",
      apiKey: "sk-secret",
    } as unknown as TextTranslationWorkspaceEvent;

    await expect(repo.appendEvent("task_001", unsafeEvent)).rejects.toThrow(
      "forbidden field",
    );
    expect(await repo.readEvents("task_001")).toEqual([]);
  });

  it("deletes only the selected task workspace", async () => {
    await repo.ensureWorkspace("task_001");
    await repo.ensureWorkspace("task_002");

    await repo.deleteWorkspace("task_001");

    await expect(readdir(repo.getTaskWorkspacePath("task_001"))).rejects.toThrow();
    await expect(readdir(repo.getTaskWorkspacePath("task_002"))).resolves.toEqual(
      expect.arrayContaining(["units", "segments", "results", "memory", "locks"]),
    );
  });

  it("plans and deletes only completed workspaces after retention", async () => {
    await repo.writeTask(
      createPersistedTask({
        taskId: "task_completed_old",
        status: "completed",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    await repo.writeTask(
      createPersistedTask({
        taskId: "task_completed_recent",
        status: "completed",
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await repo.writeTask(
      createPersistedTask({
        taskId: "task_failed_old",
        status: "failed",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    const plan = await repo.planWorkspaceCleanup({
      now: new Date("2026-06-23T00:00:00.000Z"),
    });

    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_completed_old",
          action: "delete",
          reason: "completed_retention_expired",
        }),
        expect.objectContaining({
          taskId: "task_completed_recent",
          action: "retain",
          reason: "completed_retention_active",
        }),
        expect.objectContaining({
          taskId: "task_failed_old",
          action: "review",
          reason: "non_success_requires_review",
        }),
      ]),
    );

    const cleanup = await repo.cleanupWorkspaces({
      now: new Date("2026-06-23T00:00:00.000Z"),
    });

    expect(
      cleanup.find((item) => item.taskId === "task_completed_old"),
    ).toMatchObject({ deleted: true });
    await expect(
      readdir(repo.getTaskWorkspacePath("task_completed_old")),
    ).rejects.toThrow();
    await expect(
      readdir(repo.getTaskWorkspacePath("task_completed_recent")),
    ).resolves.toEqual(
      expect.arrayContaining(["units", "segments", "results", "memory", "locks"]),
    );
    await expect(
      readdir(repo.getTaskWorkspacePath("task_failed_old")),
    ).resolves.toEqual(
      expect.arrayContaining(["units", "segments", "results", "memory", "locks"]),
    );
  });

  it("retains unsupported or missing cleanup metadata for manual review", async () => {
    await repo.writeTask(
      {
        ...createPersistedTask({
          taskId: "task_future_schema",
          updatedAt: "2026-06-01T00:00:00.000Z",
        }),
        schemaVersion: 2,
      } as unknown as PersistedTextTranslationTask,
    );
    await repo.ensureWorkspace("task_missing_metadata");

    const plan = await repo.planWorkspaceCleanup({
      now: new Date("2026-06-23T00:00:00.000Z"),
    });

    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_future_schema",
          action: "review",
          reason: "unsupported_schema",
        }),
        expect.objectContaining({
          taskId: "task_missing_metadata",
          action: "review",
          reason: "missing_task_metadata",
        }),
      ]),
    );
  });
});

function createPersistedTask(
  overrides: Partial<PersistedTextTranslationTask> = {},
): PersistedTextTranslationTask {
  const task = createTextTranslationTask({
    taskId: overrides.taskId ?? "task_001",
    files: [createFile()],
    now: overrides.updatedAt ?? "2026-06-23T00:00:00.000Z",
  });

  return {
    ...createPersistedTextTranslationTask({
      task,
      sourceFingerprint: [
        {
          fileId: "file_001",
          sourcePath: "/books/chapter-01.txt",
          sizeBytes: 1024,
          modifiedAt: 1,
        },
      ],
      segmentCount: 1,
    }),
    ...overrides,
  };
}

function createFile(): TextTranslationFileRef {
  return {
    fileId: "file_001",
    sourcePath: "/books/chapter-01.txt",
    fileName: "chapter-01.txt",
    format: "txt",
    sizeBytes: 1024,
    modifiedAt: 1,
    order: 0,
  };
}
