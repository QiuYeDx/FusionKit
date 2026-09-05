import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubtitleSliceType,
  TaskStatus,
} from "../../electron/main/translation/typing";
import {
  createChatCompletionBody,
  createResponsesBody,
  startFakeModelApiServer,
  type FakeModelApiServer,
} from "../ai/fakeModelApiServer";

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

describe("BaseTranslator runtime integration", () => {
  let server: FakeModelApiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it.each(["responses", "chat_completions"] as const)("reconstructs real SRT translator output through %s", async apiFormat => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startFakeModelApiServer();
    const content = JSON.stringify({cues: [{id: "cue-2", lines: ["再见"]}, {id: "cue-1", lines: ["你好"]}]});
    server.enqueueRoute(apiFormat, {
      body: apiFormat === "responses" ? createResponsesBody({outputText: content}) : createChatCompletionBody({content}),
    });
    const { SRTTranslator } = await import("../../electron/main/translation/class/srt-translator");
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-cue-runtime-"));
    try {
      const translator = new (class extends SRTTranslator {
        constructor() {
          super({apiKey: "test-key", endpoint: server!.baseUrl, apiModel: "test-model"});
          this.retryPolicy = {...this.retryPolicy, maxAttempts: 1};
        }
      })();
      await translator.translate({
        taskId: "subtitle-task-cue-runtime", fileName: "locked.srt",
        fileContent: "8\n00:00:01,250 --> 00:00:02,500\nHello\n\n9\n00:00:05,500 --> 00:00:06,000\nGoodbye",
        sliceType: SubtitleSliceType.NORMAL, originFileURL: "/input/locked.srt", targetFileURL: outputDir,
        status: TaskStatus.PENDING, sourceLang: "EN", targetLang: "ZH", translationOutputMode: "bilingual",
        executionBinding: {status: "ready", profileId: "profile-test", profileLabel: "Test", apiKey: "test-key", apiModel: "test-model", endPoint: server.baseUrl, apiFormat},
      });
      expect(server.requests).toHaveLength(1);
      expect(JSON.stringify(server.requests[0].body)).toContain("cue-1");
      expect(await readFile(path.join(outputDir, "locked.srt"), "utf8")).toBe("8\n00:00:01,250 --> 00:00:02,500\nHello\n你好\n\n9\n00:00:05,500 --> 00:00:06,000\nGoodbye\n再见");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      const relative = path.relative(os.tmpdir(), outputDir);
      if (!relative.startsWith("fusionkit-cue-runtime-") || relative.includes(path.sep)) throw Error("Unexpected cleanup path");
      await rm(outputDir, {recursive: true, force: true});
    }
  });

  it("translates an LRC-like fragment through the Responses runtime adapter", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startFakeModelApiServer();
    server.enqueueRoute("responses", {
      body: createResponsesBody({
        outputText: "[00:01.00]翻译结果",
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          total_tokens: 12,
        },
      }),
    });

    const { BaseTranslator } = await import(
      "../../electron/main/translation/class/base-translator"
    );

    class TestTranslator extends BaseTranslator {
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

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-lrc-"));
    const task = {
      taskId: "subtitle-task-runtime-test",
      fileName: "responses.lrc",
      fileContent: "[00:01.00]source",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/input/responses.lrc",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      executionBinding: {
        status: "ready" as const,
        profileId: "profile-test",
        profileLabel: "Test profile",
        apiKey: "test-key",
        apiModel: "test-model",
        endPoint: server.baseUrl,
        apiFormat: "responses" as const,
      },
      concurrentSlices: false,
    };

    try {
      await new TestTranslator().translate(task);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/responses",
      body: {
        model: "test-model",
        input: "[00:01.00]source",
        store: false,
      },
    });
    await expect(
      readFile(path.join(outputDir, "responses.lrc"), "utf-8"),
    ).resolves.toBe("[00:01.00]翻译结果");
    await rm(outputDir, { recursive: true, force: true });
  });

  it("defaults legacy DeepSeek subtitle tasks to thinking disabled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startFakeModelApiServer();
    server.enqueueRoute("chat_completions", {
      body: createChatCompletionBody({ content: "[00:01.00]翻译结果" }),
    });

    const { BaseTranslator } = await import(
      "../../electron/main/translation/class/base-translator"
    );

    class TestTranslator extends BaseTranslator {
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

    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "fusionkit-deepseek-"),
    );
    const task = {
      taskId: "subtitle-task-deepseek-default-off",
      fileName: "deepseek.lrc",
      fileContent: "[00:01.00]source",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/input/deepseek.lrc",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      executionBinding: {
        status: "ready" as const,
        profileId: "profile-deepseek",
        profileLabel: "DeepSeek",
        apiKey: "test-key",
        apiModel: "deepseek-v4-flash",
        endPoint: server.baseUrl,
        apiFormat: "chat_completions" as const,
        outputTokenParameter: "max_tokens" as const,
      },
      concurrentSlices: false,
    };

    try {
      await new TestTranslator().translate(task);
      expect(server.requests[0]).toMatchObject({
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: "deepseek-v4-flash",
          thinking: { type: "disabled" },
        },
      });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
