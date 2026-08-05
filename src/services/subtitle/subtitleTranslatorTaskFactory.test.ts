import { describe, expect, it } from "vitest";
import { SubtitleSliceType, TaskStatus } from "@/type/subtitle";
import {
  createSubtitleTranslatorTask,
  createSubtitleTranslatorTaskId,
  hasReadySubtitleTaskExecution,
  isSubtitleTranslatorTaskId,
} from "./subtitleTranslatorTaskFactory";

describe("subtitle translator task factory", () => {
  it("creates a stable opaque task identity without using the file name", () => {
    const task = createSubtitleTranslatorTask(
      {
        fileName: "same-name.srt",
        fileContent: "content",
        sliceType: SubtitleSliceType.NORMAL,
        status: TaskStatus.NOT_STARTED,
        executionBinding: { status: "needs_configuration" },
      },
      () => "fixed-id",
    );
    expect(task.taskId).toBe("subtitle-task-fixed-id");
    expect(task.taskId).not.toContain(task.fileName);
    expect(isSubtitleTranslatorTaskId(task.taskId)).toBe(true);
    expect(hasReadySubtitleTaskExecution(task)).toBe(false);
  });

  it("rejects unsafe ID factory output", () => {
    expect(() => createSubtitleTranslatorTaskId(() => "../unsafe"))
      .toThrow("task ID source is invalid");
  });

  it("rejects a ready binding with incomplete runtime fields", () => {
    expect(() =>
      createSubtitleTranslatorTask(
        {
          fileName: "invalid.srt",
          fileContent: "content",
          sliceType: SubtitleSliceType.NORMAL,
          status: TaskStatus.NOT_STARTED,
          executionBinding: { status: "ready" } as never,
        },
        () => "invalid-binding",
      ),
    ).toThrow("execution binding is invalid");
  });
});
