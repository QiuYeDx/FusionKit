import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubtitleSliceType,
  TaskStatus,
  type SubtitleTranslatorTask,
} from "../../electron/main/translation/typing";

const translateMock = vi.hoisted(() => vi.fn());

vi.mock("../../electron/main/translation/class/lrc-translator", () => ({
  LRCTranslator: class {
    translate = translateMock;
  },
}));

vi.mock("../../electron/main/translation/class/srt-translator", () => ({
  SRTTranslator: class {
    translate = translateMock;
  },
}));

function task(taskId: string, fileName = "same.srt"): SubtitleTranslatorTask {
  return {
    taskId,
    fileName,
    fileContent: "1\n00:00:00,000 --> 00:00:01,000\nsource",
    sliceType: SubtitleSliceType.NORMAL,
    originFileURL: `/input/${fileName}`,
    targetFileURL: "/output",
    status: TaskStatus.PENDING,
    executionBinding: {
      status: "ready",
      profileId: "profile-1",
      profileLabel: "Profile 1",
      apiKey: "test-key",
      apiModel: "test-model",
      endPoint: "https://example.test/v1",
    },
  };
}

describe("TranslationService task identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    translateMock.mockReset();
  });

  it("cancels only the requested task when display names match", async () => {
    const pending = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void }
    >();
    translateMock.mockImplementation(
      (currentTask: SubtitleTranslatorTask, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          pending.set(currentTask.taskId, { resolve, reject });
          signal?.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        }),
    );
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { TranslationService } = await import(
      "../../electron/main/translation/translation-service"
    );
    const service = new TranslationService();
    const first = service.processTask(task("subtitle-task-first"));
    const second = service.processTask(task("subtitle-task-second"));

    service.cancelTask("subtitle-task-first");
    await expect(first).resolves.toEqual({ status: "cancelled" });
    pending.get("subtitle-task-second")?.resolve();
    await expect(second).resolves.toEqual({ status: "completed" });
  });

  it("rejects duplicate active identity without replacing its controller", async () => {
    let finish: (() => void) | undefined;
    translateMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { TranslationService } = await import(
      "../../electron/main/translation/translation-service"
    );
    const service = new TranslationService();
    const active = service.processTask(task("subtitle-task-duplicate"));

    await expect(
      service.processTask(task("subtitle-task-duplicate", "other.srt")),
    ).resolves.toEqual({ status: "failed", error: "task_already_active" });
    expect(translateMock).toHaveBeenCalledTimes(1);
    finish?.();
    await expect(active).resolves.toEqual({ status: "completed" });
  });

  it("rejects malformed identity and incomplete ready binding before execution", async () => {
    const { TranslationService } = await import(
      "../../electron/main/translation/translation-service"
    );
    const service = new TranslationService();
    await expect(service.processTask(task("unsafe"))).resolves.toEqual({
      status: "failed",
      error: "invalid_task_identity",
    });
    await expect(service.processTask({
      ...task("subtitle-task-invalid-binding"),
      executionBinding: { status: "ready" } as never,
    })).resolves.toEqual({
      status: "failed",
      error: "configuration_required",
    });
    expect(translateMock).not.toHaveBeenCalled();
  });
});
