/**
 * 字幕翻译模块 - 翻译器抽象基类
 *
 * 采用模板方法模式，定义翻译的完整流程，子类只需实现格式相关的差异部分：
 *
 *   translate()                  ← 入口（本类实现）
 *     ├─ splitContent()          ← 抽象：按格式拆分字幕为 fragment
 *     ├─ translateFragment()     ← 本类实现：单片翻译（含重试）
 *     │   ├─ formatPrompt()      ← 抽象：构建 LLM prompt
 *     │   ├─ getApiEndpoint()    ← 抽象：API 地址
 *     │   └─ parseResponse()     ← 抽象：解析 LLM 返回
 *     ├─ writeFile()             ← 本类实现：写入结果文件
 *     └─ updateProgress()        ← 本类实现：通过 IPC 推送进度
 *
 * 子类：LRCTranslator（.lrc 歌词）、SRTTranslator（.srt 字幕）
 */

import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_SLICE_LENGTH_MAP } from "../constants";
import {
  SubtitleFileType,
  SubtitleSliceType,
  SubtitleTranslatorTask,
} from "../typing";
import { ipcMain, BrowserWindow } from "electron";
import axios from "axios";
import { fixSrtSubtitles, removeThinkTags, hasThinkTags } from "../utils";
import { getAxiosProxyConfig } from "../../proxy";

type OutputConflictPolicy = "overwrite" | "index";
type TranslationFragmentMeta = {
  index: number;
  total: number;
};

export abstract class BaseTranslator {
  /** 子类实现：将字幕文本按 token 上限拆分为多个 fragment */
  protected abstract splitContent(content: string, maxTokens: number): string[];
  /** 子类实现：根据当前 fragment 和上文 context 构建发给 LLM 的 prompt */
  protected abstract formatPrompt(
    partialContent: string,
    context: string,
  ): string;

  protected maxRetries = 5;
  /** 基础重试延迟（实际延迟 = retryDelay × 已尝试次数，线性退避） */
  protected retryDelay = 1000;
  /** 并发模式下同时翻译的最大分片数 */
  protected maxSliceConcurrency = 5;

  protected sourceLang: string = "JA";
  protected targetLang: string = "ZH";
  protected bilingualOutput: boolean = true;

  /**
   * 翻译主流程（模板方法）。
   *
   * 执行步骤：
   *   1. 初始化语言设置
   *   2. 将字幕内容拆分为多个 fragment（由子类 splitContent 实现）
   *   3. 根据 concurrentSlices 选择顺序或并发翻译
   *   4. 将所有翻译结果拼接并写入目标文件
   *   5. 通过 IPC 通知渲染进程翻译结果（成功/失败）
   */
  async translate(task: SubtitleTranslatorTask, signal?: AbortSignal) {
    this.sourceLang = task.sourceLang || "JA";
    this.targetLang = task.targetLang || "ZH";
    this.bilingualOutput = task.translationOutputMode !== "target_only";

    const errorLogs: string[] = [];
    const startTime = new Date().toISOString();

    try {
      console.log("[01] start process file:", task.fileName);
      errorLogs.push(
        `[${new Date().toISOString()}] 开始处理文件: ${task.fileName}`,
      );

      const content = task.fileContent;
      console.log("[02] content length:", content.length);
      errorLogs.push(
        `[${new Date().toISOString()}] 文件内容长度: ${content.length}`,
      );

      const maxTokens = this.getMaxTokens(task.sliceType);
      console.log("[03] max token num:", maxTokens);
      errorLogs.push(`[${new Date().toISOString()}] 最大Token数: ${maxTokens}`);

      const fragments = this.splitContent(content, maxTokens);
      console.log("[04] fragments num:", fragments.length);
      errorLogs.push(
        `[${new Date().toISOString()}] 分片数量: ${fragments.length}`,
      );

      this.updateProgress(task, 0, fragments.length);

      let translatedFragments: string[];

      if (task.concurrentSlices && fragments.length > 1) {
        errorLogs.push(
          `[${new Date().toISOString()}] 并发模式，最大并发数: ${this.maxSliceConcurrency}`,
        );
        translatedFragments = await this.translateFragmentsConcurrently(
          fragments,
          task,
          signal,
          errorLogs,
        );
      } else {
        translatedFragments = await this.translateFragmentsSequentially(
          fragments,
          task,
          signal,
          errorLogs,
        );
      }

      const fileType = task.fileName.split(".").at(-1)?.toUpperCase();
      const translatedContent = translatedFragments.join("\n\n");

      errorLogs.push(
        `[${new Date().toISOString()}] 开始写入文件到: ${task.targetFileURL}`,
      );
      const finalPath = await this.writeFile(
        task.targetFileURL,
        translatedContent,
        task.fileName,
        task.conflictPolicy,
      );
      errorLogs.push(
        `[${new Date().toISOString()}] 文件写入完成: ${finalPath}`,
      );

      // 通过 IPC 将最终输出路径发送给渲染进程，用于 UI 展示"打开文件"按钮
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send("task-resolved", {
          fileName: task.fileName,
          outputFilePath: finalPath,
          finalFileName: path.basename(finalPath),
        });
      }

      this.updateProgress(task, fragments.length, fragments.length);
      errorLogs.push(`[${new Date().toISOString()}] 任务完成`);
    } catch (error) {
      const errorDetails =
        error instanceof Error ? error.message : String(error);
      const stackTrace = error instanceof Error ? error.stack : "无堆栈信息";

      errorLogs.push(`[${new Date().toISOString()}] 任务失败: ${errorDetails}`);
      if (stackTrace) {
        errorLogs.push(`[${new Date().toISOString()}] 堆栈跟踪: ${stackTrace}`);
      }

      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send("task-failed", {
          fileName: task.fileName,
          error: errorDetails,
          message: "请求接口失败",
          errorLogs: errorLogs,
          timestamp: startTime,
          stackTrace: stackTrace,
        });
      } else {
        console.error(
          "[base-translator] main window not fount, updateProgress failed",
        );
      }

      console.error("[base-translator] error in translating:", error);
      throw error;
    }
  }

  /**
   * 顺序翻译：逐片调用 LLM，前一片的原文作为 context 传入下一片的 prompt，
   * 保证翻译连贯性。适合对上下文敏感的内容。
   */
  private async translateFragmentsSequentially(
    fragments: string[],
    task: SubtitleTranslatorTask,
    signal: AbortSignal | undefined,
    errorLogs: string[],
  ): Promise<string[]> {
    const results: string[] = [];

    for (const [index, fragment] of fragments.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      try {
        errorLogs.push(
          `[${new Date().toISOString()}] 开始翻译第 ${index + 1}/${fragments.length} 个分片`,
        );

        const result = await this.translateFragment(
          fragment,
          index > 0 ? fragments[index - 1] : "",
          task.apiKey,
          task.apiModel,
          errorLogs,
          { index: index + 1, total: fragments.length },
        );

        results.push(result);
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${index + 1} 个分片翻译完成`,
        );
        this.updateProgress(task, index + 1, fragments.length);
      } catch (fragmentError) {
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${index + 1} 个分片翻译失败: ${fragmentError instanceof Error ? fragmentError.message : String(fragmentError)}`,
        );
        throw fragmentError;
      }
    }

    return results;
  }

  /**
   * 并发翻译：启动 N 个 worker 竞争消费 fragment 队列。
   *
   * 实现要点：
   *   - 用 nextIndex 做无锁队列指针（JS 单线程安全）
   *   - results 按原始下标写入，保证最终顺序正确
   *   - 任一 worker 失败后设置 failed 标志，其余 worker 尽快退出
   */
  private async translateFragmentsConcurrently(
    fragments: string[],
    task: SubtitleTranslatorTask,
    signal: AbortSignal | undefined,
    errorLogs: string[],
  ): Promise<string[]> {
    const results: (string | null)[] = new Array(fragments.length).fill(null);
    let completedCount = 0;
    let nextIndex = 0;
    let failed = false;

    const worker = async (): Promise<void> => {
      while (!failed) {
        const index = nextIndex++;
        if (index >= fragments.length) break;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const fragment = fragments[index];
        const context = index > 0 ? fragments[index - 1] : "";

        try {
          errorLogs.push(
            `[${new Date().toISOString()}] [并发] 开始翻译第 ${index + 1}/${fragments.length} 个分片`,
          );

          const result = await this.translateFragment(
            fragment,
            context,
            task.apiKey,
            task.apiModel,
            errorLogs,
            { index: index + 1, total: fragments.length },
          );

          results[index] = result;
          completedCount++;
          errorLogs.push(
            `[${new Date().toISOString()}] [并发] 第 ${index + 1} 个分片翻译完成 (${completedCount}/${fragments.length})`,
          );
          this.updateProgress(task, completedCount, fragments.length);
        } catch (err) {
          failed = true;
          errorLogs.push(
            `[${new Date().toISOString()}] [并发] 第 ${index + 1} 个分片翻译失败: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      }
    };

    const workerCount = Math.min(this.maxSliceConcurrency, fragments.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results.filter((r): r is string => r !== null);
  }

  /** 更新任务进度并通过 IPC "update-progress" 事件推送给渲染进程 */
  private updateProgress(
    task: SubtitleTranslatorTask,
    current: number,
    total: number,
  ) {
    task.resolvedFragments = current;
    task.totalFragments = total;
    task.progress = Math.round((current / total) * 100);

    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      console.log("发送进度更新:", {
        fileName: task.fileName,
        resolvedFragments: current,
        totalFragments: total,
        progress: task.progress,
      });

      mainWindow.webContents.send("update-progress", {
        fileName: task.fileName,
        resolvedFragments: current,
        totalFragments: total,
        progress: task.progress,
      });
    } else {
      console.error("未找到主窗口，无法发送进度更新");
    }
  }

  /**
   * 将翻译结果写入目标文件。
   * 当 conflictPolicy 为 "index" 时，若文件已存在则自动追加序号：
   *   output.srt → output (1).srt → output (2).srt → ...
   */
  private async writeFile(
    fileURL: string,
    content: string,
    fileName: string,
    conflictPolicy: OutputConflictPolicy = "index",
  ) {
    try {
      const absoluteOutputDir = path.resolve(fileURL);
      await fs.mkdir(absoluteOutputDir, { recursive: true });

      const parsed = path.parse(fileName);
      let finalPath = path.join(absoluteOutputDir, parsed.base);
      if (conflictPolicy !== "overwrite") {
        let index = 1;
        while (true) {
          try {
            await fs.access(finalPath);
            finalPath = path.join(
              absoluteOutputDir,
              `${parsed.name} (${index})${parsed.ext}`,
            );
            index++;
          } catch {
            break;
          }
        }
      }

      await fs.writeFile(finalPath, content, "utf-8");
      console.log("文件已成功写入:", path.basename(finalPath));
      return finalPath;
    } catch (error) {
      console.error("写入文件时出错:", error);
      throw new Error("无法写入文件");
    }
  }

  private getMaxTokens(sliceType: SubtitleSliceType) {
    return DEFAULT_SLICE_LENGTH_MAP[sliceType];
  }

  private logEmptyTranslationResult(
    responseData: any,
    parsedResult: unknown,
    errorLogs: string[],
    fragmentMeta?: TranslationFragmentMeta,
  ) {
    const rawContent = responseData?.choices?.[0]?.message?.content;
    const rawLength = typeof rawContent === "string" ? rawContent.length : 0;
    const parsedLength =
      typeof parsedResult === "string" ? parsedResult.length : 0;
    const hasMessageContent = typeof rawContent === "string";
    const fragmentLabel = fragmentMeta
      ? `第 ${fragmentMeta.index}/${fragmentMeta.total} 个分片`
      : "未知分片";

    errorLogs.push(
      `[${new Date().toISOString()}] 翻译结果为空 (${fragmentLabel})，原始内容长度: ${rawLength}，清洗后长度: ${parsedLength}，choices[0].message.content存在: ${hasMessageContent ? "是" : "否"}`,
    );

    const preview = this.createLogPreview(rawContent);
    if (preview) {
      errorLogs.push(
        `[${new Date().toISOString()}] 原始返回预览: ${preview}`,
      );
    }
  }

  private createLogPreview(value: unknown, maxLength = 500): string {
    if (typeof value !== "string") return "";

    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) return "";

    return compact.length > maxLength
      ? `${compact.slice(0, maxLength)}...`
      : compact;
  }

  /**
   * 翻译单个 fragment：构建 prompt → 调用 LLM API → 解析返回。
   * 内置线性退避重试机制（最多 maxRetries 次），每次失败后延迟递增。
   *
   * 特殊处理：部分深度思考模型（如 DeepSeek R1）会在返回中包含 <think> 标签，
   * 这里会在解析前自动清理这些标签。
   */
  private async translateFragment(
    content: string,
    context: string,
    apiKey: string,
    apiModel: string,
    errorLogs: string[],
    fragmentMeta?: TranslationFragmentMeta,
  ): Promise<string> {
    const prompt = this.formatPrompt(content, context);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        errorLogs.push(
          `[${new Date().toISOString()}] 尝试第 ${attempt}/${this.maxRetries} 次翻译请求`,
        );

        const response = await axios.post(
          this.getApiEndpoint(),
          {
            model: apiModel,
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
            max_tokens: 3500,
            stream: false,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            ...getAxiosProxyConfig(),
          },
        );

        if (!response.data) {
          throw new Error("翻译返回结果为空");
        }

        console.log("翻译响应数据:", response.data);
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${attempt} 次翻译请求成功`,
        );

        // 适配深度思考模型：清理 <think>...</think> 标签避免污染翻译结果
        if (response.data.choices?.[0]?.message?.content) {
          const originalContent = response.data.choices[0].message.content;

          if (hasThinkTags(originalContent)) {
            const cleanedContent = removeThinkTags(originalContent);
            errorLogs.push(
              `[${new Date().toISOString()}] 检测到think标签，已清理思考内容`,
            );
            console.log("清理think标签前:", originalContent);
            console.log("清理think标签后:", cleanedContent);

            response.data.choices[0].message.content = cleanedContent;
          }
        }

        const parsedResult = await this.parseResponse(response.data);
        if (
          typeof parsedResult !== "string" ||
          parsedResult.trim().length === 0
        ) {
          this.logEmptyTranslationResult(
            response.data,
            parsedResult,
            errorLogs,
            fragmentMeta,
          );
          throw new Error("Translation result is empty after parsing");
        }

        return parsedResult;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errorLogs.push(
          `[${new Date().toISOString()}] 第 ${attempt} 次翻译尝试失败: ${errorMessage}`,
        );

        if (axios.isAxiosError(error)) {
          errorLogs.push(
            `[${new Date().toISOString()}] HTTP状态码: ${error.response?.status || "N/A"}`,
          );
          if (error.response?.data) {
            errorLogs.push(
              `[${new Date().toISOString()}] 响应数据: ${JSON.stringify(error.response.data)}`,
            );
          }
        }

        console.error(`第 ${attempt} 次翻译尝试失败:`, error);

        if (attempt === this.maxRetries) {
          errorLogs.push(
            `[${new Date().toISOString()}] 已达到最大重试次数，翻译失败`,
          );
          throw this.normalizeError(error);
        }

        const delay = this.retryDelay * attempt;
        errorLogs.push(`[${new Date().toISOString()}] 等待 ${delay}ms 后重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error("所有翻译尝试都失败了");
  }

  /** 子类实现：返回 LLM Chat Completions API 的端点 URL */
  protected abstract getApiEndpoint(): string;
  /** 子类实现：从 LLM 响应中提取并清洗翻译文本 */
  protected abstract parseResponse(responseData: any): Promise<string>;
  /** 子类实现：将未知错误标准化为 Error 对象 */
  protected abstract normalizeError(error: unknown): Error;

  /** 处理 429 速率限制：读取 Retry-After 头并等待对应时间（预留扩展，当前未被调用） */
  private async handleRateLimit(response: Response) {
    const retryAfter = response.headers.get("Retry-After") || "5";
    const delay = parseInt(retryAfter) * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }
}
