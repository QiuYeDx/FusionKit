import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubtitleSliceType,
  TaskStatus,
} from "../../electron/main/translation/typing";
import { buildCheckpointPaths } from "../../electron/main/translation/checkpoint";

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("../../electron/main/ai/model-runtime-client", () => ({
  sendModelRuntimeText: vi.fn(),
}));

describe("BaseTranslator empty result retry", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retries when a successful response parses to an empty result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendModelRuntimeText } = await import(
      "../../electron/main/ai/model-runtime-client"
    );
    const { BaseTranslator } = await import(
      "../../electron/main/translation/class/base-translator"
    );

    class TestTranslator extends BaseTranslator {
      constructor() {
        super();
        this.maxRetries = 2;
        this.retryDelay = 0;
      }

      protected splitContent(content: string): string[] {
        return [content];
      }

      protected formatPrompt(partialContent: string): string {
        return partialContent;
      }

      protected async parseResponse(responseData: any): Promise<string> {
        return responseData.content;
      }

      protected normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
      }
    }

    vi.mocked(sendModelRuntimeText)
      .mockResolvedValueOnce({
        content: "   ",
        apiFormat: "chat_completions",
      })
      .mockResolvedValueOnce({
        content: "[00:01.00]翻译结果",
        apiFormat: "chat_completions",
      });

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-lrc-"));
    const task = {
      taskId: "subtitle-task-base-test",
      fileName: "sample.lrc",
      fileContent: "[00:01.00]source",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/input/sample.lrc",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      executionBinding: {
        status: "ready" as const,
        profileId: "profile-test",
        profileLabel: "Test profile",
        apiKey: "test-key",
        apiModel: "test-model",
        endPoint: "https://example.test/chat/completions",
      },
      concurrentSlices: false,
    };

    try {
      await new TestTranslator().translate(task);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(sendModelRuntimeText).toHaveBeenCalledTimes(2);
    expect(sendModelRuntimeText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          apiFormat: "chat_completions",
          modelKey: "test-model",
        }),
      }),
    );
    await expect(
      readFile(path.join(outputDir, "sample.lrc"), "utf-8"),
    ).resolves.toBe("[00:01.00]翻译结果");
    const completionSummary = await readFile(
      buildCheckpointPaths(outputDir, task.fileName, task.taskId)
        .completionSummaryPath,
      "utf-8",
    );
    expect(JSON.parse(completionSummary)).toMatchObject({
      schemaVersion: 1,
      status: "completed",
      fileName: "sample.lrc",
      finalFileName: "sample.lrc",
    });
    expect(completionSummary).not.toContain("/input/sample.lrc");
    expect(completionSummary).not.toContain(outputDir);
    await rm(outputDir, { recursive: true, force: true });
  });

  it("retains a path-free v2 checkpoint and emits only its opaque ref on failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendModelRuntimeText } = await import(
      "../../electron/main/ai/model-runtime-client"
    );
    const { BaseTranslator } = await import(
      "../../electron/main/translation/class/base-translator"
    );
    class FailingTranslator extends BaseTranslator {
      constructor() {
        super();
        this.maxRetries = 1;
        this.retryDelay = 0;
      }
      protected splitContent(content: string): string[] { return [content]; }
      protected formatPrompt(content: string): string { return content; }
      protected async parseResponse(response: any): Promise<string> {
        return response.content;
      }
      protected normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
      }
    }
    vi.mocked(sendModelRuntimeText).mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-cp-"));
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const task = {
      taskId: "subtitle-task-checkpoint-event",
      fileName: "checkpoint.srt",
      fileContent: "1\n00:00:00,000 --> 00:00:01,000\nSource\n",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/private/source/checkpoint.srt",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      executionBinding: {
        status: "ready" as const,
        profileId: "profile-test",
        profileLabel: "Test profile",
        apiKey: "test-key",
        apiModel: "test-model",
        endPoint: "https://example.test/chat/completions",
      },
    };
    try {
      await expect(new FailingTranslator().translate(task, undefined, {
        revalidateTarget: async () => undefined,
        validateOutputPath: async () => undefined,
        authorizeCheckpoint: vi.fn()
          .mockResolvedValueOnce("checkpoint-ref-initial")
          .mockResolvedValueOnce("checkpoint-ref-latest"),
        releaseCheckpoint: vi.fn(),
        recordFinalOutput: async () => undefined,
        emit: (channel, payload) => emitted.push({ channel, payload }),
      })).rejects.toThrow("provider unavailable");
      const manifestPath = buildCheckpointPaths(
        outputDir,
        task.fileName,
        task.taskId,
      ).manifestPath;
      const serialized = await readFile(manifestPath, "utf-8");
      expect(JSON.parse(serialized)).toMatchObject({
        schemaVersion: 2,
        status: "failed",
      });
      expect(serialized).not.toContain("/private/source");
      expect(serialized).not.toContain(outputDir);
      const failure = emitted.find((event) => event.channel === "task-failed");
      expect(failure?.payload).toMatchObject({
        recovery: { checkpointRef: "checkpoint-ref-latest" },
      });
      expect(JSON.stringify(failure)).not.toContain(outputDir);
      expect(JSON.stringify(failure)).not.toContain("/private/source");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
