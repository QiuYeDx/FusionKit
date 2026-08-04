import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubtitleSliceType,
  TaskStatus,
} from "../../electron/main/translation/typing";

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
    await rm(outputDir, { recursive: true, force: true });
  });
});
