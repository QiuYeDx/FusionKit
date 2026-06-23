import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MB,
  appendNdjson,
  assessDiskSpace,
  assessSourceSize,
  atomicWriteJson,
  completeSegment,
  estimateWorkspaceDiskRequirement,
  getAvailableDiskBytes,
  isPathInside,
  selectCleanupCandidates,
} from "./workspaceStrategyProbe";

describe("PRE-004 workspace strategy probe", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-text-resource-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classifies text and markdown source-size guardrails", () => {
    expect(
      assessSourceSize({
        kind: "txt",
        fileBytes: 51 * MB,
        projectBytes: 51 * MB,
      }).warnings[0],
    ).toMatch(/^txt_single_file_soft_warning:/);

    expect(
      assessSourceSize({
        kind: "markdown",
        fileBytes: 6 * MB,
        projectBytes: 6 * MB,
      }).warnings[0],
    ).toMatch(/^markdown_single_file_soft_warning:/);

    expect(
      assessSourceSize({
        kind: "markdown",
        fileBytes: 11 * MB,
        projectBytes: 11 * MB,
      }).errors[0],
    ).toMatch(/^markdown_single_file_hard_limit:/);

    expect(
      assessSourceSize({
        kind: "txt",
        fileBytes: 1 * MB,
        projectBytes: 1025 * MB,
      }).errors[0],
    ).toMatch(/^project_total_hard_limit:/);
  });

  it("estimates disk space with separate minimum and recommendation thresholds", () => {
    const estimate = estimateWorkspaceDiskRequirement(50 * MB);

    expect(estimate.minimumRequiredBytes).toBeGreaterThan(100 * MB);
    expect(estimate.recommendedAvailableBytes).toBeGreaterThan(
      estimate.minimumRequiredBytes,
    );
    expect(assessDiskSpace(estimate, estimate.minimumRequiredBytes - 1)).toMatchObject(
      {
        ok: false,
        hardBlocked: true,
      },
    );
    expect(
      assessDiskSpace(estimate, estimate.recommendedAvailableBytes - 1),
    ).toMatchObject({
      ok: true,
      hardBlocked: false,
    });
  });

  it("reads available disk bytes through Node statfs", async () => {
    const availableBytes = await getAvailableDiskBytes(root);
    expect(availableBytes).toBeGreaterThan(0);
  });

  it("atomically writes small JSON state without leaving temp files", async () => {
    const taskPath = path.join(root, "task.json");

    await atomicWriteJson(taskPath, {
      schemaVersion: 1,
      taskId: "task_resource_probe",
      completedSegmentCount: 1,
    });

    await expect(readFile(taskPath, "utf-8")).resolves.toContain(
      "task_resource_probe",
    );
    await expect(readFile(`${taskPath}.tmp`, "utf-8")).rejects.toThrow();
  });

  it("completes one segment without rewriting task metadata or segment index", async () => {
    const workspace = path.join(root, "task-a");
    const taskPath = path.join(workspace, "task.json");
    const indexPath = path.join(workspace, "segments", "index.ndjson");

    await atomicWriteJson(taskPath, {
      schemaVersion: 1,
      taskId: "task-a",
      segmentCount: 10_000,
      completedSegmentCount: 0,
    });

    for (let index = 0; index < 10_000; index++) {
      await appendNdjson(indexPath, {
        segmentId: `seg-${String(index).padStart(5, "0")}`,
        sourcePath: `segments/source/${String(index).padStart(5, "0")}.txt`,
      });
    }

    const beforeTask = await stat(taskPath);
    const beforeIndex = await stat(indexPath);
    const completed = await completeSegment(
      workspace,
      "seg-00042",
      "translated text",
    );
    const afterTask = await stat(taskPath);
    const afterIndex = await stat(indexPath);
    const eventLog = await readFile(path.join(workspace, "events.ndjson"), "utf-8");

    expect(afterTask.mtimeMs).toBe(beforeTask.mtimeMs);
    expect(afterIndex.size).toBe(beforeIndex.size);
    expect(completed.eventBytes).toBeLessThan(512);
    await expect(readFile(completed.resultPath, "utf-8")).resolves.toBe(
      "translated text",
    );
    expect(eventLog).toContain("segment_completed");
  });

  it("selects cleanup candidates only inside the controlled workspace root", () => {
    const nowMs = Date.parse("2026-06-23T00:00:00.000Z");
    const insideCompleted = path.join(root, "tasks", "completed-old");
    const insideFailed = path.join(root, "tasks", "failed-old");
    const outside = path.join(root, "..", "outside");

    const candidates = selectCleanupCandidates(
      [
        {
          taskId: "completed-old",
          workspacePath: insideCompleted,
          status: "completed",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          taskId: "completed-new",
          workspacePath: path.join(root, "tasks", "completed-new"),
          status: "completed",
          updatedAt: "2026-06-22T00:00:00.000Z",
        },
        {
          taskId: "failed-old",
          workspacePath: insideFailed,
          status: "failed",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
        {
          taskId: "outside",
          workspacePath: outside,
          status: "completed",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      {
        workspaceRoot: path.join(root, "tasks"),
        nowMs,
      },
    );

    expect(candidates.map((task) => task.taskId)).toEqual(["completed-old"]);
    expect(isPathInside(path.join(root, "tasks"), outside)).toBe(false);

    const nonSuccessCandidates = selectCleanupCandidates(
      [
        {
          taskId: "failed-old",
          workspacePath: insideFailed,
          status: "failed",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ],
      {
        workspaceRoot: path.join(root, "tasks"),
        nowMs,
        autoCleanNonSuccess: true,
      },
    );

    expect(nonSuccessCandidates.map((task) => task.taskId)).toEqual([
      "failed-old",
    ]);
  });
});
