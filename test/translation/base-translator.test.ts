import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubtitleSliceType,
  TaskStatus,
  type SubtitleTranslatorTask,
} from "../../electron/main/translation/typing";
import { buildCheckpointPaths } from "../../electron/main/translation/checkpoint";
import { ModelRuntimeClientError } from "../../electron/main/ai/model-runtime-errors";

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
        this.retryPolicy = {
          ...this.retryPolicy,
          maxAttempts: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        };
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
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 2,
        },
      })
      .mockResolvedValueOnce({
        content: "[00:01.00]翻译结果",
        apiFormat: "chat_completions",
        usage: {
          inputTokens: 20,
          outputTokens: 8,
          totalTokens: 28,
          reasoningTokens: 3,
        },
      });

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-lrc-"));
    const task: SubtitleTranslatorTask = {
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
        tokenPricing: {
          inputTokensPerMillion: 1,
          outputTokensPerMillion: 2,
        },
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
    expect(task.actualUsage).toMatchObject({
      inputTokens: 30,
      outputTokens: 13,
      totalTokens: 43,
      reasoningTokens: 3,
      cachedInputTokens: 2,
      requestCount: 2,
      reportedRequestCount: 2,
    });
    expect(task.actualUsage?.calculatedCost).toBeCloseTo(0.000056, 12);
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
    const parsedCompletionSummary = JSON.parse(completionSummary);
    expect(parsedCompletionSummary).toMatchObject({
      schemaVersion: 1,
      status: "completed",
      fileName: "sample.lrc",
      finalFileName: "sample.lrc",
      usage: {
        inputTokens: 30,
        outputTokens: 13,
        totalTokens: 43,
        requestCount: 2,
        reportedRequestCount: 2,
      },
    });
    expect(parsedCompletionSummary.usage.calculatedCost)
      .toBeCloseTo(0.000056, 12);
    expect(completionSummary).not.toContain("/input/sample.lrc");
    expect(completionSummary).not.toContain(outputDir);
    await rm(outputDir, { recursive: true, force: true });
  });

  it("recovers within the same task after a longer transient provider outage", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendModelRuntimeText } = await import(
      "../../electron/main/ai/model-runtime-client"
    );
    const { BaseTranslator } = await import(
      "../../electron/main/translation/class/base-translator"
    );

    class ResilientTranslator extends BaseTranslator {
      constructor() {
        super();
        this.retryPolicy = {
          ...this.retryPolicy,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        };
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

    const transientError = new ModelRuntimeClientError(
      "provider_retryable",
      "provider temporarily unavailable",
      true,
      { providerCode: "server_error" },
    );
    vi.mocked(sendModelRuntimeText)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        content: "[00:01.00]recovered translation",
        apiFormat: "chat_completions",
      });

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-retry-"));
    const task: SubtitleTranslatorTask = {
      taskId: "subtitle-task-long-transient-retry",
      fileName: "retry.lrc",
      fileContent: "[00:01.00]source",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/input/retry.lrc",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      executionBinding: {
        status: "ready",
        profileId: "profile-test",
        profileLabel: "Test profile",
        apiKey: "test-key",
        apiModel: "test-model",
        endPoint: "https://example.test/chat/completions",
      },
      concurrentSlices: false,
    };

    try {
      await new ResilientTranslator().translate(task);
      expect(sendModelRuntimeText).toHaveBeenCalledTimes(6);
      await expect(readFile(path.join(outputDir, "retry.lrc"), "utf-8"))
        .resolves.toBe("[00:01.00]recovered translation");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(outputDir, { recursive: true, force: true });
    }
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
        this.retryPolicy = {
          ...this.retryPolicy,
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        };
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
      new ModelRuntimeClientError(
        "length_truncated",
        "provider output truncated",
        false,
        {
          usage: {
            inputTokens: 12,
            outputTokens: 7,
            totalTokens: 19,
          },
        },
      ),
    );
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-cp-"));
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const task: SubtitleTranslatorTask = {
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
        tokenPricing: {
          inputTokensPerMillion: 1,
          outputTokensPerMillion: 2,
        },
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
      })).rejects.toThrow("provider output truncated");
      const manifestPath = buildCheckpointPaths(
        outputDir,
        task.fileName,
        task.taskId,
      ).manifestPath;
      const serialized = await readFile(manifestPath, "utf-8");
      const parsedManifest = JSON.parse(serialized);
      expect(parsedManifest).toMatchObject({
        schemaVersion: 2,
        status: "failed",
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          totalTokens: 19,
          requestCount: 1,
          reportedRequestCount: 1,
        },
      });
      expect(parsedManifest.usage.calculatedCost).toBeCloseTo(0.000026, 12);
      expect(serialized).not.toContain("/private/source");
      expect(serialized).not.toContain(outputDir);
      const failure = emitted.find((event) => event.channel === "task-failed");
      expect(failure?.payload).toMatchObject({
        recovery: { checkpointRef: "checkpoint-ref-latest" },
        actualUsage: {
          inputTokens: 12,
          outputTokens: 7,
          totalTokens: 19,
          requestCount: 1,
          reportedRequestCount: 1,
        },
      });
      expect(JSON.stringify(failure)).not.toContain(outputDir);
      expect(JSON.stringify(failure)).not.toContain("/private/source");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("waits for in-flight concurrent requests before reporting failed-task usage", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendModelRuntimeText } = await import(
      "../../electron/main/ai/model-runtime-client"
    );
    const { BaseTranslator } = await import(
      "../../electron/main/translation/class/base-translator"
    );
    class ConcurrentTranslator extends BaseTranslator {
      constructor() {
        super();
        this.retryPolicy = {
          ...this.retryPolicy,
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        };
        this.maxSliceConcurrency = 2;
      }
      protected splitContent(): string[] { return ["first", "second"]; }
      protected formatPrompt(content: string): string { return content; }
      protected async parseResponse(response: any): Promise<string> {
        return response.content;
      }
      protected normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
      }
    }

    vi.mocked(sendModelRuntimeText)
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new ModelRuntimeClientError(
          "length_truncated",
          "first fragment failed",
          false,
          {
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
            },
          },
        );
      })
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          content: "second translated",
          apiFormat: "chat_completions",
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            totalTokens: 30,
          },
        };
      });

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-concurrent-"));
    const emitted: Array<{ channel: string; payload: any }> = [];
    const task: SubtitleTranslatorTask = {
      taskId: "subtitle-task-concurrent-usage",
      fileName: "concurrent.srt",
      fileContent: "source",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/private/source/concurrent.srt",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      executionBinding: {
        status: "ready",
        profileId: "profile-test",
        profileLabel: "Test profile",
        apiKey: "test-key",
        apiModel: "test-model",
        endPoint: "https://example.test/chat/completions",
      },
      concurrentSlices: true,
    };

    try {
      await expect(new ConcurrentTranslator().translate(task, undefined, {
        revalidateTarget: async () => undefined,
        validateOutputPath: async () => undefined,
        authorizeCheckpoint: vi.fn()
          .mockResolvedValueOnce("checkpoint-ref-initial")
          .mockResolvedValueOnce("checkpoint-ref-latest"),
        releaseCheckpoint: vi.fn(),
        recordFinalOutput: async () => undefined,
        emit: (channel, payload) => emitted.push({ channel, payload }),
      })).rejects.toThrow("first fragment failed");

      expect(task.actualUsage).toMatchObject({
        inputTokens: 30,
        outputTokens: 15,
        totalTokens: 45,
        requestCount: 2,
        reportedRequestCount: 2,
      });
      expect(emitted.find((event) => event.channel === "task-failed")?.payload)
        .toMatchObject({ actualUsage: task.actualUsage });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
