import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_SLICE_LENGTH_MAP } from "../contants";
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

export abstract class BaseTranslator {
  protected abstract splitContent(content: string, maxTokens: number): string[];
  protected abstract formatPrompt(
    partialContent: string,
    context: string
  ): string;

  // 新增重试配置（子类可覆盖）
  // TODO: 未来做成可配置的
  protected maxRetries = 5;
  protected retryDelay = 1000;

  async translate(task: SubtitleTranslatorTask, signal?: AbortSignal) {
    const errorLogs: string[] = [];
    const startTime = new Date().toISOString();

    try {
      console.log("[01] start process file:", task.fileName);
      errorLogs.push(`[${new Date().toISOString()}] 开始处理文件: ${task.fileName}`);
      
      const content = task.fileContent;
      console.log("[02] content length:", content.length);
      errorLogs.push(`[${new Date().toISOString()}] 文件内容长度: ${content.length}`);

      const maxTokens = this.getMaxTokens(task.sliceType);
      console.log("[03] max token num:", maxTokens);
      errorLogs.push(`[${new Date().toISOString()}] 最大Token数: ${maxTokens}`);

      const fragments = this.splitContent(content, maxTokens);
      console.log("[04] fragments num:", fragments.length);
      errorLogs.push(`[${new Date().toISOString()}] 分片数量: ${fragments.length}`);

      // 初始化进度
      this.updateProgress(task, 0, fragments.length);

      const translatedFragments: string[] = [];

      for (const [index, fragment] of fragments.entries()) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        try {
          errorLogs.push(`[${new Date().toISOString()}] 开始翻译第 ${index + 1}/${fragments.length} 个分片`);
          
          const result = await this.translateFragment(
            fragment,
            index > 0 ? fragments[index - 1] : "",
            task.apiKey,
            task.apiModel,
            errorLogs
          );

          if (!result) {
            throw new Error("Translation result is undefined");
          }

          translatedFragments.push(result);
          console.log("result", result);
          errorLogs.push(`[${new Date().toISOString()}] 第 ${index + 1} 个分片翻译完成`);

          // 更新当前分片进度
          this.updateProgress(task, index + 1, fragments.length);
        } catch (fragmentError) {
          errorLogs.push(`[${new Date().toISOString()}] 第 ${index + 1} 个分片翻译失败: ${fragmentError instanceof Error ? fragmentError.message : String(fragmentError)}`);
          throw fragmentError;
        }
      }

      // 将翻译后的内容写入目标文件
      const fileType = task.fileName.split(".").at(-1)?.toUpperCase();
      const translatedContent = translatedFragments.join("\n\n");
      
      errorLogs.push(`[${new Date().toISOString()}] 开始写入文件到: ${task.targetFileURL}`);
      const finalPath = await this.writeFile(
        task.targetFileURL,
        translatedContent,
        task.fileName,
        task.conflictPolicy
      );
      errorLogs.push(`[${new Date().toISOString()}] 文件写入完成: ${finalPath}`);

      // 通知任务完成（包含最终输出路径）
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send("task-resolved", {
          fileName: task.fileName,
          outputFilePath: finalPath,
          finalFileName: path.basename(finalPath),
        });
      }

      // 通知任务完成
      this.updateProgress(task, fragments.length, fragments.length);
      errorLogs.push(`[${new Date().toISOString()}] 任务完成`);
    } catch (error) {
      const errorDetails = error instanceof Error ? error.message : String(error);
      const stackTrace = error instanceof Error ? error.stack : "无堆栈信息";
      
      errorLogs.push(`[${new Date().toISOString()}] 任务失败: ${errorDetails}`);
      if (stackTrace) {
        errorLogs.push(`[${new Date().toISOString()}] 堆栈跟踪: ${stackTrace}`);
      }

      // 获取主窗口并发送消息
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send("task-failed", {
          fileName: task.fileName,
          error: errorDetails,
          message: "请求接口失败", // 显示 toast 的信息
          errorLogs: errorLogs,
          timestamp: startTime,
          stackTrace: stackTrace,
        });
      } else {
        console.error(
          "[base-translator] main window not fount, updateProgress failed"
        );
      }

      console.error("[base-translator] error in translating:", error);
      throw error;
    }
  }

  private updateProgress(
    task: SubtitleTranslatorTask,
    current: number,
    total: number
  ) {
    // 更新任务对象
    task.resolvedFragments = current;
    task.totalFragments = total;
    task.progress = Math.round((current / total) * 100);

    // 获取主窗口并发送消息
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

  private async writeFile(
    fileURL: string,
    content: string,
    fileName: string,
    conflictPolicy: OutputConflictPolicy = "index"
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
            // exists → try next index
            finalPath = path.join(
              absoluteOutputDir,
              `${parsed.name} (${index})${parsed.ext}`
            );
            index++;
          } catch {
            // not exist
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

  private async translateFragment(
    content: string,
    context: string,
    apiKey: string,
    apiModel: string,
    errorLogs: string[]
  ): Promise<string> {
    const prompt = this.formatPrompt(content, context);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        errorLogs.push(`[${new Date().toISOString()}] 尝试第 ${attempt}/${this.maxRetries} 次翻译请求`);
        
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
          }
        );

        if (!response.data) {
          throw new Error("翻译返回结果为空");
        }

        console.log("翻译响应数据:", response.data);
        errorLogs.push(`[${new Date().toISOString()}] 第 ${attempt} 次翻译请求成功`);
        
        // 清理响应数据中的 think 标签（适配深度思考类型模型）
        if (response.data.choices?.[0]?.message?.content) {
          const originalContent = response.data.choices[0].message.content;
          
          // 只有检测到think标签时才进行清理，提高性能
          if (hasThinkTags(originalContent)) {
            const cleanedContent = removeThinkTags(originalContent);
            errorLogs.push(`[${new Date().toISOString()}] 检测到think标签，已清理思考内容`);
            console.log("清理think标签前:", originalContent);
            console.log("清理think标签后:", cleanedContent);
            
            // 更新响应数据
            response.data.choices[0].message.content = cleanedContent;
          }
        }
        
        return this.parseResponse(response.data);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errorLogs.push(`[${new Date().toISOString()}] 第 ${attempt} 次翻译尝试失败: ${errorMessage}`);
        
        if (axios.isAxiosError(error)) {
          errorLogs.push(`[${new Date().toISOString()}] HTTP状态码: ${error.response?.status || 'N/A'}`);
          if (error.response?.data) {
            errorLogs.push(`[${new Date().toISOString()}] 响应数据: ${JSON.stringify(error.response.data)}`);
          }
        }

        console.error(`第 ${attempt} 次翻译尝试失败:`, error);

        if (attempt === this.maxRetries) {
          errorLogs.push(`[${new Date().toISOString()}] 已达到最大重试次数，翻译失败`);
          throw this.normalizeError(error);
        }

        // 重试延迟
        const delay = this.retryDelay * attempt;
        errorLogs.push(`[${new Date().toISOString()}] 等待 ${delay}ms 后重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error("所有翻译尝试都失败了");
  }

  // 以下为需要子类实现的抽象方法
  protected abstract getApiEndpoint(): string;
  protected abstract parseResponse(responseData: any): Promise<string>;
  protected abstract normalizeError(error: unknown): Error;

  // 通用的速率限制处理
  private async handleRateLimit(response: Response) {
    const retryAfter = response.headers.get("Retry-After") || "5";
    const delay = parseInt(retryAfter) * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }
}
