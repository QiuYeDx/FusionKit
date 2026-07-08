import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubtitleSliceType,
  TaskStatus,
} from "../../electron/main/translation/typing";
import {
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
        this.maxRetries = 1;
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

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-lrc-"));
    const task = {
      fileName: "responses.lrc",
      fileContent: "[00:01.00]source",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/input/responses.lrc",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      apiKey: "test-key",
      apiModel: "test-model",
      endPoint: server.baseUrl,
      apiFormat: "responses" as const,
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
});
