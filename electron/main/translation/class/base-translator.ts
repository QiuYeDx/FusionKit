import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_SLICE_LENGTH_MAP } from "../contants";
import { SubtitleSliceType, SubtitleTranslatorTask } from "../typing";
import { ipcMain, BrowserWindow } from "electron";
import axios from 'axios';

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
    try {
      console.log("开始处理文件:", task.fileName);
      const content = task.fileContent;
      console.log("文件内容长度:", content.length);
      
      const maxTokens = this.getMaxTokens(task.sliceType);
      console.log("使用的最大 token 数:", maxTokens);
      
      const fragments = this.splitContent(content, maxTokens);
      console.log("分片数量:", fragments.length);
      
      // 初始化进度
      this.updateProgress(task, 0, fragments.length);
      
      const translatedFragments: string[] = [];

      for (const [index, fragment] of fragments.entries()) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const result = await this.translateFragment(
          fragment,
          index > 0 ? fragments[index - 1] : "",
          task.apiKey,
          task.apiModel,
        );

        if (!result) {
          throw new Error("Translation result is undefined");
        }

        translatedFragments.push(result);
        console.log("result", result);

        // 更新当前分片进度
        this.updateProgress(task, index + 1, fragments.length);
      }

      // 将翻译后的内容写入目标文件
      const translatedContent = translatedFragments.join("\n");
      await this.writeFile(task.targetFileURL, translatedContent, task.fileName);

      // 通知任务完成
      this.updateProgress(task, fragments.length, fragments.length);

    } catch (error) {
      // 获取主窗口并发送消息
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {   
        mainWindow.webContents.send("task-failed", {
          fileName: task.fileName,
          error: error instanceof Error ? error.message : '未知错误',
          message: '请求接口失败' // 显示 toast 的信息
        });
      } else {
        console.error("未找到主窗口，无法发送进度更新");
      }

      console.error("翻译过程出错:", error);
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
        progress: task.progress
      });
      
      mainWindow.webContents.send("update-progress", {
        fileName: task.fileName,
        resolvedFragments: current,
        totalFragments: total,
        progress: task.progress
      });
    } else {
      console.error("未找到主窗口，无法发送进度更新");
    }
  }

  // private async readFile(fileURL: string) {
  //   try {
  //     // 确保路径是绝对路径
  //     const absolutePath = path.resolve(fileURL);

  //     // 读取文件内容
  //     const fileContent = await fs.readFile(absolutePath, "utf-8");

  //     // 返回文件内容
  //     return fileContent;
  //   } catch (error) {
  //     console.error("读取文件时出错:", error);
  //     throw new Error("无法读取文件");
  //   }
  // }

  // // 从 blobURL 中获取文件内容， 返回实际字符串
  // private async readFile(blobURL: string) {
  //   const response = await fetch(blobURL);
  //   const blob = await response.blob();
  //   // return new File([blob], "file.txt", { type: "text/plain" });
  //   return blob.toString();
  // }

  private async writeFile(fileURL: string, content: string, fileName: string) {
    try {
      const newFileURL = path.join(fileURL, fileName);
      // 确保路径是绝对路径
      const absolutePath = path.resolve(fileURL);
      
      // 确保目标目录存在
      const targetDir = path.dirname(absolutePath);
      await fs.mkdir(targetDir, { recursive: true });

      // 写入文件内容
      await fs.writeFile(newFileURL, content, 'utf-8');
      console.log("文件已成功写入:", fileName);
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
  ): Promise<string> {
    const prompt = this.formatPrompt(content, context);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.post(
          this.getApiEndpoint(),
          {
            model: apiModel,
            messages: [
              {
                role: "user",
                content: prompt
              }
            ],
            max_tokens: 3500,
            // temperature: 0.3
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (!response.data) {
          throw new Error('翻译返回结果为空');
        }

        console.log("翻译响应数据:", response.data);
        return this.parseResponse(response.data);

      } catch (error) {
        // if (signal?.aborted) {
        //   throw new DOMException("Aborted", "AbortError");
        // }
        
        console.error(`第 ${attempt} 次翻译尝试失败:`, error);
        
        if (attempt === this.maxRetries) {
          throw this.normalizeError(error);
        }
        
        // 重试延迟
        await new Promise(r => setTimeout(r, this.retryDelay * attempt));
      }
    }

    throw new Error('所有翻译尝试都失败了');
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
