import { afterEach, describe, expect, it, vi } from "vitest";
import { SubtitleSliceType, TaskStatus, type SubtitleTranslatorTask } from "@/type/subtitle";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("translator execution service", () => {
  it("sends generated tasks through the path-free reference envelope", async () => {
    const invoke = vi.fn(async (_channel: string, _request: unknown) => ({
      status: "completed",
    }));
    vi.stubGlobal("window", {
      ipcRenderer: { invoke, send: vi.fn() },
      subtitleTranslationApi: { releaseGeneratedTask: vi.fn() },
    });
    const { startSubtitleTranslation } = await import(
      "./translatorExecutionService"
    );
    const task = generatedTask();

    await startSubtitleTranslation(task);
    expect(invoke).toHaveBeenCalledOnce();
    const request = invoke.mock.calls[0][1] as {
      task: Record<string, unknown>;
      reference: unknown;
    };
    expect(invoke.mock.calls[0][0]).toBe("translate-subtitle");
    expect(request.reference).toBe(task.taskReference);
    expect(request.task).not.toHaveProperty("originFileURL");
    expect(request.task).not.toHaveProperty("targetFileURL");
    expect(request.task).not.toHaveProperty("checkpointPath");
    expect(request.task).not.toHaveProperty("taskReference");
  });

  it("sends newly selected files without renderer path fields", async () => {
    const invoke = vi.fn(async (_channel: string, _request: unknown) => ({
      status: "completed",
    }));
    vi.stubGlobal("window", {
      ipcRenderer: { invoke, send: vi.fn() },
      subtitleTranslationApi: { releaseGeneratedTask: vi.fn() },
    });
    const { startSubtitleTranslation } = await import(
      "./translatorExecutionService"
    );
    const task: SubtitleTranslatorTask = {
      ...generatedTask(),
      taskId: "subtitle-task-authorized-execution",
      fileName: "selected.srt",
      taskReference: {
        kind: "authorized_task_v1",
        source: {
          kind: "authorized_file",
          token: "subtitle-translation-source-one",
          displayName: "selected.srt",
        },
        target: {
          kind: "authorized_directory",
          token: "subtitle-translation-target-two",
          displayLabel: "Source directory",
        },
      },
    };

    await startSubtitleTranslation(task);
    const request = invoke.mock.calls[0][1] as {
      task: Record<string, unknown>;
      reference: unknown;
    };
    expect(request.reference).toBe(task.taskReference);
    expect(request.task).not.toHaveProperty("originFileURL");
    expect(request.task).not.toHaveProperty("targetFileURL");
    expect(request.task).not.toHaveProperty("checkpointPath");
  });
});

function generatedTask(): SubtitleTranslatorTask {
  return {
    taskId: "subtitle-task-generated-execution",
    fileName: "generated.srt",
    fileContent: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    sliceType: SubtitleSliceType.NORMAL,
    originFileURL: "/must/not/cross",
    targetFileURL: "/must/not/cross",
    checkpointPath: "/must/not/cross",
    status: TaskStatus.NOT_STARTED,
    executionBinding: { status: "needs_configuration" },
    taskReference: {
      kind: "generated_task_v1",
      source: { kind: "generated_content", displayName: "generated.srt" },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-one",
        displayLabel: "Source directory",
      },
    },
  };
}
