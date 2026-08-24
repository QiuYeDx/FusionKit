import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskEventEnvelope,
  type LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import {
  createLocalSubtitleSessionReducerState,
  mergeLocalSubtitleSessionSnapshot,
  reduceLocalSubtitleSessionEvent,
} from "./localSubtitleSessionReducer";

const NOW = "2026-07-21T00:00:00.000Z";

describe("local subtitle session reducer", () => {
  it("replaces full task summaries and derives the batch aggregate", () => {
    const initial = fromSnapshot(snapshot(1, [batch(task())]));
    const updated = task({
      status: "transcribing",
      progress: {
        stage: "transcribing",
        stageProgress: 40,
        overallProgress: 48,
      },
      updatedAt: "2026-07-21T00:00:01.000Z",
    });

    const result = reduceLocalSubtitleSessionEvent(initial, {
      kind: "task",
      envelope: taskUpdatedEvent(2, updated),
    });

    expect(result).toMatchObject({ applied: true, needsSnapshot: false });
    expect(result.state.revision).toBe(2);
    expect(result.state.batches[0]).toMatchObject({
      status: "running",
      updatedAt: updated.updatedAt,
      tasks: [updated],
    });
  });

  it("consumes a sequential stale generation without mutating the task", () => {
    const currentTask = task({ generation: 3, status: "transcribing" });
    const initial = fromSnapshot(snapshot(4, [batch(currentTask)]));
    const stale = task({ generation: 2, status: "completed" });

    const sequential = reduceLocalSubtitleSessionEvent(initial, {
      kind: "task",
      envelope: taskUpdatedEvent(5, stale),
    });
    expect(sequential).toMatchObject({
      applied: false,
      needsSnapshot: false,
      reason: "stale_generation",
      state: { revision: 5 },
    });
    expect(sequential.state.batches[0]!.tasks[0]).toBe(currentTask);

    const gap = reduceLocalSubtitleSessionEvent(sequential.state, {
      kind: "task",
      envelope: taskUpdatedEvent(8, stale),
    });
    expect(gap).toMatchObject({
      applied: false,
      needsSnapshot: true,
      reason: "revision_gap",
      state: { revision: 5 },
    });
  });

  it("keeps task tombstones until a higher generation snapshot arrives", () => {
    const initial = fromSnapshot(snapshot(1, [batch(task({ generation: 3 }))]));
    const removed = reduceLocalSubtitleSessionEvent(initial, {
      kind: "task",
      envelope: {
        batchId: "batch-1",
        taskId: "task-1",
        generation: 3,
        revision: 2,
        event: { type: "task-removed", removedAt: NOW },
      },
    });
    expect(removed.state.batches).toEqual([]);

    const late = reduceLocalSubtitleSessionEvent(removed.state, {
      kind: "task",
      envelope: taskUpdatedEvent(3, task({ generation: 3 })),
    });
    expect(late).toMatchObject({
      applied: false,
      reason: "task_tombstone",
      state: { revision: 3, batches: [] },
    });

    const nextGeneration = mergeLocalSubtitleSessionSnapshot(
      late.state,
      snapshot(4, [batch(task({ generation: 4 }))]),
    );
    expect(nextGeneration.accepted).toBe(true);
    if (nextGeneration.accepted) {
      expect(nextGeneration.state.batches[0]!.tasks[0]!.generation).toBe(4);
    }
  });

  it("tombstones an unknown task generation when the next snapshot omits it", () => {
    const unknown = reduceLocalSubtitleSessionEvent(
      createLocalSubtitleSessionReducerState(),
      {
        kind: "task",
        envelope: taskUpdatedEvent(1, task()),
      },
    );
    expect(unknown).toMatchObject({
      needsSnapshot: true,
      reason: "unknown_batch",
      state: { revision: 1 },
    });

    const merged = mergeLocalSubtitleSessionSnapshot(
      unknown.state,
      snapshot(2, [batch(task({ taskId: "other-task" }))]),
    );
    expect(merged.accepted).toBe(true);
    if (!merged.accepted) return;

    const late = reduceLocalSubtitleSessionEvent(merged.state, {
      kind: "task",
      envelope: taskUpdatedEvent(3, task()),
    });
    expect(late).toMatchObject({
      applied: false,
      reason: "task_tombstone",
      state: { revision: 3 },
    });
    expect(late.state.batches[0]!.tasks.map((entry) => entry.taskId)).toEqual([
      "other-task",
    ]);
  });

  it("uses one revision cursor for resource and task channels", () => {
    const initial = createLocalSubtitleSessionReducerState();
    const resource = resourceJob();
    const added = reduceLocalSubtitleSessionEvent(initial, {
      kind: "resource",
      envelope: {
        revision: 1,
        event: { type: "resource-job-updated", job: resource },
      },
    });
    const taskGap = reduceLocalSubtitleSessionEvent(added.state, {
      kind: "task",
      envelope: taskUpdatedEvent(3, task()),
    });

    expect(added.state.resourceJobs).toEqual([resource]);
    expect(taskGap).toMatchObject({
      applied: false,
      needsSnapshot: true,
      reason: "unknown_batch",
      state: { revision: 3 },
    });
  });

  it("does not resurrect removed resource job ids", () => {
    const initial = fromSnapshot(snapshot(1, [], [resourceJob()]));
    const removed = reduceLocalSubtitleSessionEvent(initial, {
      kind: "resource",
      envelope: {
        revision: 2,
        event: {
          type: "resource-job-removed",
          jobId: "job-1",
          removedAt: NOW,
        },
      },
    });
    const late = reduceLocalSubtitleSessionEvent(removed.state, {
      kind: "resource",
      envelope: {
        revision: 3,
        event: { type: "resource-job-updated", job: resourceJob() },
      },
    });

    expect(late).toMatchObject({
      applied: false,
      reason: "resource_tombstone",
      state: { revision: 3, resourceJobs: [] },
    });
  });

  it("keeps local completion independent from post-action updates", () => {
    const completed = completedTask();
    const initial = fromSnapshot(snapshot(10, [batch(completed)]));
    const postActionUpdated = {
      ...completed,
      postAction: {
        mode: "enqueue_and_start_translation" as const,
        preferredFormat: "SRT" as const,
        importStatus: "queued" as const,
        startStatus: "failed" as const,
        importReceiptId: "receipt-1",
        translationTaskId: "translation-task-1",
        startFailureReason: "start_rejected" as const,
      },
      updatedAt: "2026-07-21T00:00:02.000Z",
    };

    const result = reduceLocalSubtitleSessionEvent(initial, {
      kind: "task",
      envelope: taskUpdatedEvent(11, postActionUpdated),
    });

    expect(result.state.batches[0]!.tasks[0]).toMatchObject({
      status: "completed",
      completion: { outcome: "full" },
      postAction: {
        importStatus: "queued",
        startStatus: "failed",
        translationTaskId: "translation-task-1",
      },
    });
  });

  it("rejects snapshots that regress a task generation or revive a job", () => {
    const initial = fromSnapshot(
      snapshot(1, [batch(task({ generation: 2 }))], [resourceJob()]),
    );
    const absent = mergeLocalSubtitleSessionSnapshot(initial, snapshot(2));
    expect(absent.accepted).toBe(true);
    if (!absent.accepted) return;

    expect(
      mergeLocalSubtitleSessionSnapshot(
        absent.state,
        snapshot(3, [batch(task({ generation: 2 }))]),
      ),
    ).toMatchObject({ accepted: false, reason: "generation_regression" });
    expect(
      mergeLocalSubtitleSessionSnapshot(
        absent.state,
        snapshot(3, [], [resourceJob()]),
      ),
    ).toMatchObject({ accepted: false, reason: "resource_resurrection" });
  });
});

function fromSnapshot(snapshotValue: LocalSubtitleSessionSnapshot) {
  const result = mergeLocalSubtitleSessionSnapshot(
    createLocalSubtitleSessionReducerState(),
    snapshotValue,
  );
  if (!result.accepted) throw new Error(result.reason);
  return result.state;
}

function snapshot(
  revision: number,
  batches: readonly LocalSubtitleBatchSummary[] = [],
  resourceJobs: readonly LocalSubtitleResourceJobSummary[] = [],
): LocalSubtitleSessionSnapshot {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    revision,
    batches,
    resourceJobs,
  };
}

function batch(taskValue: LocalSubtitleTaskSummary): LocalSubtitleBatchSummary {
  return {
    batchId: taskValue.batchId,
    status: taskValue.status === "queued" ? "queued" : "running",
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "auto",
      resolvedBackend: "cpu",
      language: "auto",
      taskMode: "transcribe",
      vadEnabled: true,
      outputFormats: ["SRT"],
      outputMode: "source",
      conflictPolicy: "index",
      postActionMode: "export_only",
    },
    tasks: [taskValue],
    createdAt: NOW,
    updatedAt: taskValue.updatedAt,
  };
}

function task(
  overrides: Partial<LocalSubtitleTaskSummary> = {},
): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key",
    generation: 1,
    displayName: "sample.wav",
    status: "queued",
    progress: { stage: "queued", stageProgress: 0, overallProgress: 0 },
    model: {
      engine: "whisper_cpp",
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
    },
    resolvedBackend: "cpu",
    requestedFormats: ["SRT"],
    artifactResults: [],
    postAction: {
      mode: "export_only",
      importStatus: "not_requested",
      startStatus: "not_requested",
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function completedTask(): LocalSubtitleTaskSummary {
  const artifact = {
    format: "SRT" as const,
    status: "committed" as const,
    artifact: {
      artifactRef: "artifact-1",
      format: "SRT" as const,
      displayName: "sample.srt",
      expiresAt: Date.parse(NOW) + 60_000,
    },
  };
  return task({
    status: "completed",
    progress: { stage: "exporting", stageProgress: 100, overallProgress: 100 },
    artifactResults: [artifact],
    completion: { outcome: "full", artifacts: [artifact], warnings: [] },
  });
}

function taskUpdatedEvent(
  revision: number,
  taskValue: LocalSubtitleTaskSummary,
): LocalSubtitleTaskEventEnvelope {
  return {
    batchId: taskValue.batchId,
    taskId: taskValue.taskId,
    generation: taskValue.generation,
    revision,
    event: { type: "task-updated", task: taskValue },
  };
}

function resourceJob(): LocalSubtitleResourceJobSummary {
  return {
    jobId: "job-1",
    resourceId: "model-1",
    resourceType: "model",
    status: "queued",
    progress: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
