import { describe, expect, it } from "vitest";
import { TaskStatus, type SubtitleTranslatorTask } from "@/type/subtitle";
import { orderSubtitleTranslatorTasksForDisplay } from "./subtitleTranslatorTaskOrder";

function task(
  taskId: string,
  status: TaskStatus,
): SubtitleTranslatorTask {
  return { taskId, status } as SubtitleTranslatorTask;
}

describe("subtitle translator task display order", () => {
  it("places active tasks first, unstarted tasks in the middle, and completed tasks last", () => {
    const ordered = orderSubtitleTranslatorTasksForDisplay({
      pendingTaskQueue: [task("running-1", TaskStatus.PENDING)],
      waitingTaskQueue: [task("waiting-1", TaskStatus.WAITING)],
      notStartedTaskQueue: [task("new-1", TaskStatus.NOT_STARTED)],
      failedTaskQueue: [task("failed-1", TaskStatus.FAILED)],
      resolvedTaskQueue: [task("completed-1", TaskStatus.RESOLVED)],
    });

    expect(ordered.map((item) => item.taskId)).toEqual([
      "running-1",
      "waiting-1",
      "new-1",
      "failed-1",
      "completed-1",
    ]);
  });

  it("preserves FIFO order inside every status group", () => {
    const pending = [
      task("running-z", TaskStatus.PENDING),
      task("running-a", TaskStatus.PENDING),
    ];
    const waiting = [
      task("waiting-z", TaskStatus.WAITING),
      task("waiting-a", TaskStatus.WAITING),
    ];
    const notStarted = [
      task("new-z", TaskStatus.NOT_STARTED),
      task("new-a", TaskStatus.NOT_STARTED),
    ];
    const failed = [
      task("failed-z", TaskStatus.FAILED),
      task("failed-a", TaskStatus.FAILED),
    ];
    const resolved = [
      task("completed-z", TaskStatus.RESOLVED),
      task("completed-a", TaskStatus.RESOLVED),
    ];

    const ordered = orderSubtitleTranslatorTasksForDisplay({
      pendingTaskQueue: pending,
      waitingTaskQueue: waiting,
      notStartedTaskQueue: notStarted,
      failedTaskQueue: failed,
      resolvedTaskQueue: resolved,
    });

    expect(ordered.map((item) => item.taskId)).toEqual([
      "running-z",
      "running-a",
      "waiting-z",
      "waiting-a",
      "new-z",
      "new-a",
      "failed-z",
      "failed-a",
      "completed-z",
      "completed-a",
    ]);
    expect(pending.map((item) => item.taskId)).toEqual([
      "running-z",
      "running-a",
    ]);
  });
});
