import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_SLICE_LENGTH_MAP } from "../contants";
import { SubtitleSliceType, SubtitleTranslatorTask } from "../typing";
import { ipcMain } from "electron";

export abstract class BaseTranslator {
  protected abstract splitContent(content: string, maxTokens: number): string[];
  protected abstract formatPrompt(
    partialContent: string,
    context: string
  ): string;

  // 新增重试配置（子类可覆盖）
  protected maxRetries = 3;
  protected retryDelay = 1000;

  async translate(task: SubtitleTranslatorTask, signal?: AbortSignal) {
    const content = await this.readFile(task.originFileURL);
    const maxTokens = this.getMaxTokens(task.sliceType);
    const fragments = this.splitContent(content, maxTokens);

    for (const [index, fragment] of fragments.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const result = await this.translateFragment(
        fragment,
        index > 0 ? fragments[index - 1] : "",
        task.extraInfo?.apiKey
      );

      this.updateProgress(task, index + 1, fragments.length);
    }
  }

  private updateProgress(
    task: SubtitleTranslatorTask,
    current: number,
    total: number
  ) {
    // 发送进度到渲染进程
    ipcMain.emit("update-progress", {
      fileName: task.fileName,
      current,
      total,
      progress: (current / total) * 100,
    });
  }

  private async readFile(fileURL: string) {
    try {
      // 确保路径是绝对路径
      const absolutePath = path.resolve(fileURL);

      // 读取文件内容
      const fileContent = await fs.readFile(absolutePath, "utf-8");

      // 返回文件内容
      return fileContent;
    } catch (error) {
      console.error("读取文件时出错:", error);
      throw new Error("无法读取文件");
    }
  }

  private getMaxTokens(sliceType: SubtitleSliceType) {
    return DEFAULT_SLICE_LENGTH_MAP[sliceType];
  }

  private async translateFragment(
    content: string,
    context: string,
    apiKey: string,
    signal?: AbortSignal
  ) {
    const prompt = this.formatPrompt(content, context);
    const headers = this.createHeaders(apiKey);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        signal?.addEventListener("abort", () => controller.abort());

        const response = await fetch(this.getApiEndpoint(), {
          method: "POST",
          headers,
          body: this.buildRequestBody(prompt),
          signal: controller.signal,
        });

        if (response.status === 429) {
          await this.handleRateLimit(response);
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await this.parseResponse(await response.json());
      } catch (error) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (attempt === this.maxRetries) throw this.normalizeError(error);
        await new Promise((r) => setTimeout(r, this.retryDelay * attempt));
      }
    }
  }

  // 以下为需要子类实现的抽象方法
  protected abstract getApiEndpoint(): string;
  protected abstract createHeaders(apiKey: string): Record<string, string>;
  protected abstract buildRequestBody(prompt: string): BodyInit;
  protected abstract parseResponse(response: any): Promise<string>;
  protected abstract normalizeError(error: unknown): Error;

  // 通用的速率限制处理
  private async handleRateLimit(response: Response) {
    const retryAfter = response.headers.get("Retry-After") || "5";
    const delay = parseInt(retryAfter) * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }
}
