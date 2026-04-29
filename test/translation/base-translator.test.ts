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

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    isAxiosError: vi.fn(() => false),
  },
}));

describe("BaseTranslator empty result retry", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retries when a successful response parses to an empty result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const axios = (await import("axios")).default as unknown as {
      post: ReturnType<typeof vi.fn>;
    };
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

      protected getApiEndpoint(): string {
        return "https://example.test/chat/completions";
      }

      protected async parseResponse(responseData: any): Promise<string> {
        return responseData.choices?.[0]?.message?.content;
      }

      protected normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
      }
    }

    axios.post
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: "   " } }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: "[00:01.00]翻译结果" } }],
        },
      });

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "fusionkit-lrc-"));
    const task = {
      fileName: "sample.lrc",
      fileContent: "[00:01.00]source",
      sliceType: SubtitleSliceType.NORMAL,
      originFileURL: "/input/sample.lrc",
      targetFileURL: outputDir,
      status: TaskStatus.PENDING,
      apiKey: "test-key",
      apiModel: "test-model",
      endPoint: "https://example.test/chat/completions",
      concurrentSlices: false,
    };

    try {
      await new TestTranslator().translate(task);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(axios.post).toHaveBeenCalledTimes(2);
    await expect(
      readFile(path.join(outputDir, "sample.lrc"), "utf-8"),
    ).resolves.toBe("[00:01.00]翻译结果");
    await rm(outputDir, { recursive: true, force: true });
  });
});
