import { describe, it, expect } from "vitest";
import {
  type TranslatorQueueState,
  addTask,
  updateTaskCostEstimate,
  startTask,
  startTasks,
  startAllTasks,
  retryTask,
  updateTask,
  completeTaskProgress,
  resolveTask,
  failTask,
  cancelTask,
  deleteTask,
  clearTasks,
  removeAllResolvedTasks,
  addRecoveredTasks,
} from "./translatorQueueService";
import {
  SubtitleSliceType,
  SubtitleTranslatorTask,
  TaskStatus,
} from "@/type/subtitle";

const MAX = 5;

function emptyState(): TranslatorQueueState {
  return {
    notStartedTaskQueue: [],
    waitingTaskQueue: [],
    pendingTaskQueue: [],
    resolvedTaskQueue: [],
    failedTaskQueue: [],
  };
}

function makeTask(name: string, overrides?: Partial<SubtitleTranslatorTask>): SubtitleTranslatorTask {
  return {
    taskId: taskId(name),
    fileName: name,
    fileContent: "",
    sliceType: SubtitleSliceType.NORMAL,
    originFileURL: `/in/${name}`,
    targetFileURL: `/out/${name}`,
    status: TaskStatus.NOT_STARTED,
    executionBinding: {
      status: "ready",
      profileId: "profile-1",
      profileLabel: "Profile 1",
      apiKey: "key",
      apiModel: "model",
      endPoint: "http://localhost",
    },
    ...overrides,
  };
}

function taskId(name: string): string {
  return `subtitle-task-${name.replace(/[^a-zA-Z0-9._-]/gu, "-")}`;
}

function pendingTask(
  name: string,
  overrides?: Partial<SubtitleTranslatorTask>,
): SubtitleTranslatorTask {
  return makeTask(name, { status: TaskStatus.PENDING, ...overrides });
}

function waitingTask(name: string): SubtitleTranslatorTask {
  return makeTask(name, { status: TaskStatus.WAITING });
}

// ─── addTask ─────────────────────────────────────────────────────────────────

describe("addTask", () => {
  it("adds a new task to notStartedTaskQueue", () => {
    const result = addTask(emptyState(), makeTask("a.srt"));
    expect(result.isDuplicate).toBe(false);
    expect(result.state.notStartedTaskQueue).toHaveLength(1);
    expect(result.state.notStartedTaskQueue[0].fileName).toBe("a.srt");
    expect(result.effects).toHaveLength(0);
  });

  it("allows the same fileName when task IDs differ", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("a.srt")],
    };
    const result = addTask(
      state,
      makeTask("a.srt", { taskId: "subtitle-task-second-a" }),
    );
    expect(result.isDuplicate).toBe(false);
    expect(result.state.notStartedTaskQueue).toHaveLength(1);
  });

  it("rejects a duplicate taskId regardless of display name", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("a.srt")],
    };
    const result = addTask(
      state,
      makeTask("different.srt", { taskId: taskId("a.srt") }),
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.state).toBe(state);
  });
});

// ─── startTask ───────────────────────────────────────────────────────────────

describe("startTask", () => {
  it("moves task to pending and returns start effect when slots available", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      notStartedTaskQueue: [makeTask("a.srt")],
    };
    const result = startTask(state, taskId("a.srt"), MAX);
    expect(result.state.notStartedTaskQueue).toHaveLength(0);
    expect(result.state.pendingTaskQueue).toHaveLength(1);
    expect(result.state.pendingTaskQueue[0].status).toBe(TaskStatus.PENDING);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe("start");
  });

  it("moves task to waiting when pending is full", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      notStartedTaskQueue: [makeTask("f.srt")],
      pendingTaskQueue: Array.from({ length: MAX }, (_, i) =>
        pendingTask(`p${i}.srt`),
      ),
    };
    const result = startTask(state, taskId("f.srt"), MAX);
    expect(result.state.waitingTaskQueue).toHaveLength(1);
    expect(result.state.waitingTaskQueue[0].status).toBe(TaskStatus.WAITING);
    expect(result.effects).toHaveLength(0);
  });

  it("no-ops when fileName not found", () => {
    const state = emptyState();
    const result = startTask(state, taskId("nonexistent.srt"), MAX);
    expect(result.state).toBe(state);
    expect(result.startFailures).toEqual([
      { taskId: taskId("nonexistent.srt"), reason: "start_rejected" },
    ]);
  });

  it("keeps needs_configuration tasks out of start effects", () => {
    const blocked = makeTask("blocked.srt", {
      executionBinding: { status: "needs_configuration" },
    });
    const state = {
      ...emptyState(),
      notStartedTaskQueue: [blocked],
    };
    const result = startTask(state, blocked.taskId, MAX);
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
    expect(result.startFailures).toEqual([
      { taskId: blocked.taskId, reason: "configuration_required" },
    ]);
  });
});

// ─── startAllTasks ───────────────────────────────────────────────────────────

describe("startAllTasks", () => {
  it("starts up to available slots and queues the rest as waiting", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => makeTask(`t${i}.srt`));
    const state: TranslatorQueueState = {
      ...emptyState(),
      notStartedTaskQueue: tasks,
    };

    const result = startAllTasks(state, MAX);
    expect(result.state.notStartedTaskQueue).toHaveLength(0);
    expect(result.state.pendingTaskQueue).toHaveLength(5);
    expect(result.state.waitingTaskQueue).toHaveLength(2);
    expect(result.effects).toHaveLength(5);
    result.effects.forEach((e) => expect(e.type).toBe("start"));
  });

  it("puts all into waiting when pending is already full", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      notStartedTaskQueue: [makeTask("extra.srt")],
      pendingTaskQueue: Array.from({ length: MAX }, (_, i) =>
        pendingTask(`p${i}.srt`),
      ),
    };
    const result = startAllTasks(state, MAX);
    expect(result.state.pendingTaskQueue).toHaveLength(MAX);
    expect(result.state.waitingTaskQueue).toHaveLength(1);
    expect(result.effects).toHaveLength(0);
  });

  it("starts ready tasks while leaving unconfigured tasks untouched", () => {
    const ready = makeTask("ready.srt");
    const blocked = makeTask("blocked.srt", {
      executionBinding: { status: "needs_configuration" },
    });
    const result = startAllTasks(
      { ...emptyState(), notStartedTaskQueue: [blocked, ready] },
      MAX,
    );
    expect(result.state.pendingTaskQueue.map((task) => task.taskId)).toEqual([
      ready.taskId,
    ]);
    expect(result.state.notStartedTaskQueue.map((task) => task.taskId)).toEqual([
      blocked.taskId,
    ]);
    expect(result.startFailures).toEqual([
      { taskId: blocked.taskId, reason: "configuration_required" },
    ]);
  });
});

describe("startTasks", () => {
  it("partitions only the requested IDs into started, waiting, and not-started", () => {
    const first = makeTask("first.srt");
    const second = makeTask("second.srt");
    const blocked = makeTask("blocked.srt", {
      executionBinding: { status: "needs_configuration" },
    });
    const unrelated = makeTask("unrelated.srt");
    const result = startTasks(
      {
        ...emptyState(),
        notStartedTaskQueue: [first, second, blocked, unrelated],
        pendingTaskQueue: Array.from({ length: MAX - 1 }, (_, index) =>
          pendingTask(`existing-${index}.srt`),
        ),
      },
      [first.taskId, second.taskId, blocked.taskId],
      MAX,
    );

    expect(result.receipt).toEqual({
      requestedTaskIds: [first.taskId, second.taskId, blocked.taskId],
      startedTaskIds: [first.taskId],
      waitingTaskIds: [second.taskId],
      notStartedTaskIds: [blocked.taskId],
      startFailures: [
        { taskId: blocked.taskId, reason: "configuration_required" },
      ],
    });
    expect(
      result.state.notStartedTaskQueue.some(
        (task) => task.taskId === unrelated.taskId,
      ),
    ).toBe(true);
  });
});

// ─── completeTaskProgress ────────────────────────────────────────────────────

describe("completeTaskProgress", () => {
  it("updates progress for incomplete task", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [
        pendingTask("a.srt", {
          costEstimate: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            estimatedCost: 0.001,
            fragmentCount: 8,
          },
        }),
      ],
    };
    const result = completeTaskProgress(
      state,
      {
        taskId: taskId("a.srt"),
        fileName: "a.srt",
        resolvedFragments: 3,
        totalFragments: 5,
        progress: 60,
      },
      MAX,
    );
    expect(result.state.pendingTaskQueue[0].progress).toBe(60);
    expect(result.state.pendingTaskQueue[0].resolvedFragments).toBe(3);
    expect(result.state.pendingTaskQueue[0].costEstimate?.fragmentCount).toBe(5);
    expect(result.effects).toHaveLength(0);
  });

  it("isolates late progress events between tasks with the same display name", () => {
    const first = pendingTask("same.srt", {
      taskId: "subtitle-task-same-first",
      progress: 10,
    });
    const second = pendingTask("same.srt", {
      taskId: "subtitle-task-same-second",
      progress: 20,
    });
    const result = completeTaskProgress(
      { ...emptyState(), pendingTaskQueue: [first, second] },
      {
        taskId: first.taskId,
        fileName: "same.srt",
        resolvedFragments: 2,
        totalFragments: 10,
        progress: 20,
      },
      MAX,
    );

    expect(result.state.pendingTaskQueue).toEqual([
      expect.objectContaining({ taskId: first.taskId, progress: 20 }),
      second,
    ]);
  });

  it("moves task to resolved and promotes waiting on completion", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("a.srt")],
      waitingTaskQueue: [waitingTask("b.srt")],
    };
    const result = completeTaskProgress(
      state,
      {
        taskId: taskId("a.srt"),
        fileName: "a.srt",
        resolvedFragments: 5,
        totalFragments: 5,
        progress: 100,
      },
      MAX,
    );
    expect(result.state.pendingTaskQueue).toHaveLength(1);
    expect(result.state.pendingTaskQueue[0].fileName).toBe("b.srt");
    expect(result.state.resolvedTaskQueue).toHaveLength(1);
    expect(result.state.resolvedTaskQueue[0].fileName).toBe("a.srt");
    expect(result.state.waitingTaskQueue).toHaveLength(0);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe("start");
  });
});

// ─── resolveTask ─────────────────────────────────────────────────────────────

describe("resolveTask", () => {
  it("patches outputFilePath when task is already in resolved (progress arrived first)", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      resolvedTaskQueue: [
        makeTask("a.srt", { status: TaskStatus.RESOLVED, progress: 100 }),
      ],
    };
    const result = resolveTask(
      state,
      taskId("a.srt"),
      "/out/a_translated.srt",
      MAX,
    );
    expect(result.state.resolvedTaskQueue[0].extraInfo?.outputFilePath).toBe(
      "/out/a_translated.srt",
    );
    expect(result.effects).toHaveLength(0);
  });

  it("moves from pending to resolved with outputFilePath", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("a.srt")],
    };
    const result = resolveTask(
      state,
      taskId("a.srt"),
      "/out/a_translated.srt",
      MAX,
    );
    expect(result.state.pendingTaskQueue).toHaveLength(0);
    expect(result.state.resolvedTaskQueue).toHaveLength(1);
    expect(result.state.resolvedTaskQueue[0].extraInfo?.outputFilePath).toBe(
      "/out/a_translated.srt",
    );
  });
});

// ─── failTask ────────────────────────────────────────────────────────────────

describe("failTask", () => {
  it("promotes waiting task after failure even when pending was at max capacity", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: Array.from({ length: MAX }, (_, i) =>
        pendingTask(`p${i}.srt`),
      ),
      waitingTaskQueue: [waitingTask("w0.srt")],
    };

    const result = failTask(
      state,
      {
        taskId: taskId("p0.srt"),
        fileName: "p0.srt",
        error: "ERR",
        message: "fail",
      },
      MAX,
    );

    expect(result.state.failedTaskQueue).toHaveLength(1);
    expect(result.state.failedTaskQueue[0].fileName).toBe("p0.srt");
    expect(result.state.pendingTaskQueue).toHaveLength(MAX);
    expect(
      result.state.pendingTaskQueue.some((t) => t.fileName === "w0.srt"),
    ).toBe(true);
    expect(result.state.waitingTaskQueue).toHaveLength(0);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0].type).toBe("start");
  });

  it("does not promote when no waiting tasks", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("p0.srt")],
    };
    const result = failTask(
      state,
      {
        taskId: taskId("p0.srt"),
        fileName: "p0.srt",
        error: "ERR",
        message: "fail",
      },
      MAX,
    );
    expect(result.state.pendingTaskQueue).toHaveLength(0);
    expect(result.state.failedTaskQueue).toHaveLength(1);
    expect(result.effects).toHaveLength(0);
  });
});

// ─── cancelTask ──────────────────────────────────────────────────────────────

describe("cancelTask", () => {
  it("sends cancel effect and moves task to failed", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("a.srt")],
    };
    const result = cancelTask(state, taskId("a.srt"), "Canceled", MAX);
    expect(result.state.pendingTaskQueue).toHaveLength(0);
    expect(result.state.failedTaskQueue).toHaveLength(1);
    expect(result.state.failedTaskQueue[0].extraInfo?.error).toBe("CANCELED");
    expect(result.effects[0]).toEqual({
      type: "cancel",
      taskId: taskId("a.srt"),
    });
  });

  it("promotes waiting task after cancel", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("a.srt")],
      waitingTaskQueue: [waitingTask("b.srt")],
    };
    const result = cancelTask(state, taskId("a.srt"), "Canceled", MAX);
    expect(result.state.pendingTaskQueue).toHaveLength(1);
    expect(result.state.pendingTaskQueue[0].fileName).toBe("b.srt");
    expect(result.effects).toHaveLength(2);
  });

  it("cancels waiting task without sending IPC cancel effect", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      waitingTaskQueue: [waitingTask("a.srt")],
    };
    const result = cancelTask(state, taskId("a.srt"), "Canceled", MAX);
    expect(result.state.waitingTaskQueue).toHaveLength(0);
    expect(result.state.failedTaskQueue).toHaveLength(1);
    expect(result.state.failedTaskQueue[0].status).toBe(TaskStatus.FAILED);
    expect(result.state.failedTaskQueue[0].extraInfo?.error).toBe("CANCELED");
    expect(result.effects).toHaveLength(0);
  });
});

// ─── clearTasks ──────────────────────────────────────────────────────────────

describe("clearTasks", () => {
  it("returns cancel effect for each pending task and clears all queues", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      pendingTaskQueue: [pendingTask("a.srt"), pendingTask("b.srt")],
      waitingTaskQueue: [waitingTask("c.srt")],
      notStartedTaskQueue: [makeTask("d.srt")],
    };
    const result = clearTasks(state);
    expect(result.state.notStartedTaskQueue).toHaveLength(0);
    expect(result.state.waitingTaskQueue).toHaveLength(0);
    expect(result.state.pendingTaskQueue).toHaveLength(0);
    expect(result.effects).toHaveLength(2);
    expect(result.effects.map((e) => e.type)).toEqual(["cancel", "cancel"]);
  });
});

// ─── retryTask ───────────────────────────────────────────────────────────────

describe("retryTask", () => {
  it("moves task from failed to notStarted and preserves progress for resume", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      failedTaskQueue: [makeTask("a.srt", { status: TaskStatus.FAILED, progress: 50 })],
    };
    const result = retryTask(state, taskId("a.srt"));
    expect(result.state.failedTaskQueue).toHaveLength(0);
    expect(result.state.notStartedTaskQueue).toHaveLength(1);
    expect(result.state.notStartedTaskQueue[0].status).toBe(TaskStatus.NOT_STARTED);
    expect(result.state.notStartedTaskQueue[0].progress).toBe(50);
    expect(result.state.notStartedTaskQueue[0].recoveryMode).toBe("resume");
  });

  it("resets progress when retry mode is restart", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      failedTaskQueue: [
        makeTask("a.srt", {
          status: TaskStatus.FAILED,
          progress: 50,
          resolvedFragments: 1,
          totalFragments: 2,
          recovery: {
            checkpointPath: "/tmp/a.resume.json",
            completedOutputPath: "/tmp/a.completed.srt",
            remainingOutputPath: "/tmp/a.remaining.srt",
            failedFragmentIndexes: [],
          },
        }),
      ],
    };
    const result = retryTask(state, taskId("a.srt"), "restart");

    expect(result.state.failedTaskQueue).toHaveLength(0);
    expect(result.state.notStartedTaskQueue).toHaveLength(1);
    expect(result.state.notStartedTaskQueue[0].status).toBe(TaskStatus.NOT_STARTED);
    expect(result.state.notStartedTaskQueue[0].progress).toBe(0);
    expect(result.state.notStartedTaskQueue[0].resolvedFragments).toBe(0);
    expect(result.state.notStartedTaskQueue[0].totalFragments).toBeUndefined();
    expect(result.state.notStartedTaskQueue[0].recovery).toBeUndefined();
    expect(result.state.notStartedTaskQueue[0].recoveryMode).toBe("restart");
  });
});

// ─── deleteTask ──────────────────────────────────────────────────────────────

describe("deleteTask", () => {
  it("removes task from whichever queue it is in", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      resolvedTaskQueue: [
        makeTask("a.srt", { status: TaskStatus.RESOLVED }),
        makeTask("b.srt", { status: TaskStatus.RESOLVED }),
      ],
    };
    const result = deleteTask(state, taskId("a.srt"));
    expect(result.state.resolvedTaskQueue).toHaveLength(1);
    expect(result.state.resolvedTaskQueue[0].fileName).toBe("b.srt");
  });
});

// ─── removeAllResolvedTasks ──────────────────────────────────────────────────

describe("removeAllResolvedTasks", () => {
  it("clears resolved queue only", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      resolvedTaskQueue: [makeTask("a.srt", { status: TaskStatus.RESOLVED })],
      pendingTaskQueue: [pendingTask("b.srt")],
    };
    const result = removeAllResolvedTasks(state);
    expect(result.state.resolvedTaskQueue).toHaveLength(0);
    expect(result.state.pendingTaskQueue).toHaveLength(1);
  });
});

// ─── updateTaskCostEstimate ──────────────────────────────────────────────────

describe("updateTaskCostEstimate", () => {
  it("patches costEstimate on matching task across queues", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      notStartedTaskQueue: [makeTask("a.srt")],
    };
    const estimate = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCost: 0.01,
      fragmentCount: 3,
    };
    const result = updateTaskCostEstimate(state, taskId("a.srt"), estimate);
    expect(result.state.notStartedTaskQueue[0].costEstimate).toEqual(estimate);
  });
});

// ─── updateTask ──────────────────────────────────────────────────────────────

describe("updateTask", () => {
  it("patches notStarted and failed queues only", () => {
    const state: TranslatorQueueState = {
      ...emptyState(),
      notStartedTaskQueue: [makeTask("a.srt")],
    };
    const result = updateTask(state, taskId("a.srt"), {
      executionBinding: {
        status: "ready",
        profileId: "profile-1",
        profileLabel: "Profile 1",
        apiKey: "key",
        apiModel: "new-model",
        endPoint: "http://localhost",
      },
    });
    expect(result.state.notStartedTaskQueue[0].executionBinding).toMatchObject({
      status: "ready",
      apiModel: "new-model",
    });
  });

  it("keeps task identity immutable even for an untyped runtime patch", () => {
    const original = makeTask("a.srt");
    const result = updateTask(
      { ...emptyState(), notStartedTaskQueue: [original] },
      original.taskId,
      { taskId: "subtitle-task-rebound" } as Partial<SubtitleTranslatorTask>,
    );

    expect(result.state.notStartedTaskQueue[0].taskId).toBe(original.taskId);
  });
});

describe("addRecoveredTasks", () => {
  it("returns the exact IDs added by the batch", () => {
    const existing = makeTask("existing.srt");
    const added = makeTask("added.srt");
    const result = addRecoveredTasks(
      { ...emptyState(), pendingTaskQueue: [pendingTask("running.srt")] },
      [existing, added, existing],
    );

    expect(result.addedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.addedTaskIds).toEqual([existing.taskId, added.taskId]);
  });
});
