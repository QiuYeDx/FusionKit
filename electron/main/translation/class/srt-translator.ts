// // // src/class/srt-translator.ts
// // import { promises as fs } from "fs";
// // import axios from "axios";
// // import path from "path";
// // import { encode } from "gpt-3-encoder";
// // import chalk from "chalk";

// // interface Config {
// //   apiKey: string;
// //   apiEndPoint: string;
// //   apiModel: string;
// //   apiCost: {
// //     input: number;
// //     output: number;
// //   };
// // }

// // export class SRTTranslator {
// //   private readonly ENDPOINT: string;
// //   private readonly API_MODEL: string;
// //   private readonly COST_PER_MIL_INPUT: number;
// //   private readonly COST_PER_MIL_OUTPUT: number;
// //   private readonly MAX_RETRIES = 3;

// //   private totalCost = 0;
// //   private previousTranslation = "";

// //   constructor(private config: Config) {
// //     this.ENDPOINT = config.apiEndPoint;
// //     this.API_MODEL = config.apiModel;
// //     this.COST_PER_MIL_INPUT = config.apiCost.input;
// //     this.COST_PER_MIL_OUTPUT = config.apiCost.output;
// //   }

// //   // 核心翻译方法
// //   public async translateFile(
// //     inputPath: string,
// //     mode: "normal" | "sensitive" = "normal"
// //   ) {
// //     const startTime = Date.now();
// //     const maxTokens = this.setMaxTokens(mode);

// //     try {
// //       let srtContent = await this.readSrtFile(inputPath);
// //       srtContent = this.removeMarkdownCodeBlocks(srtContent);
// //       const subtitleParts = this.splitSubtitles(srtContent, maxTokens);

// //       const translatedParts: string[] = [];

// //       for (let i = 0; i < subtitleParts.length; i++) {
// //         const part = subtitleParts[i];
// //         console.log(
// //           chalk.cyan("[ 翻译进度]"),
// //           `正在翻译部分 ${chalk.yellow(i + 1)}/${chalk.yellow(
// //             subtitleParts.length
// //           )} ，输入 Tokens: ${chalk.green(this.countTokens(part))}`
// //         );

// //         const result = await this.translateSubtitles(part, maxTokens);
// //         if (result) {
// //           translatedParts.push(result);
// //           this.updateContext(result);
// //         }
// //       }

// //       const finalTranslation = this.processFinalOutput(
// //         translatedParts.join("\n")
// //       );
// //       const outputPath = this.generateOutputPath(inputPath);
// //       await this.saveResult(finalTranslation, outputPath);

// //       console.log(
// //         chalk.green("[ 翻译完成]"),
// //         `结果已保存到 ${chalk.blue(outputPath)} ，用时: ${chalk.yellow(
// //           ((Date.now() - startTime) / 1000).toFixed(2)
// //         )} 秒`
// //       );
// //       console.log(chalk.green(` 总花费: $${this.totalCost.toFixed(4)}`));
// //     } catch (error) {
// //       console.error(chalk.red(" 翻译失败:"), error);
// //       throw error;
// //     }
// //   }

// //   private setMaxTokens(mode: string): number {
// //     return mode === "sensitive" ? 300 : 3000;
// //   }

// //   private async readSrtFile(filePath: string): Promise<string> {
// //     try {
// //       return await fs.readFile(filePath, "utf-8");
// //     } catch (error) {
// //       this.logError(" 读取 SRT 文件失败", error);
// //       throw error;
// //     }
// //   }

// //   private countTokens(text: string): number {
// //     return encode(text).length;
// //   }

// //   private async translateSubtitles(
// //     subtitles: string,
// //     maxTokens: number
// //   ): Promise<string> {
// //     for (let attempts = 0; attempts < this.MAX_RETRIES; attempts++) {
// //       try {
// //         const inputTokens = this.countTokens(subtitles);
// //         const response = await axios.post(
// //           this.ENDPOINT,
// //           {
// //             model: this.API_MODEL,
// //             messages: [
// //               {
// //                 role: "user",
// //                 content: this.buildPrompt(subtitles),
// //               },
// //             ],
// //             max_tokens: 3500,
// //           },
// //           {
// //             headers: {
// //               Authorization: `Bearer ${this.config.apiKey}`,
// //               "Content-Type": "application/json",
// //             },
// //           }
// //         );

// //         const output = this.removeMarkdownCodeBlocks(
// //           response.data.choices[0].message.content
// //         );
// //         this.calculateCost(inputTokens, this.countTokens(output));
// //         return output;
// //       } catch (error) {
// //         this.logRetry(attempts, error);
// //       }
// //     }
// //     return "";
// //   }

// //   private buildPrompt(subtitles: string): string {
// //     return `将以下字幕内容翻译为中日双语，每行日语后面紧跟着对应的中文，保持连贯性，格式如下:
// // 1
// // 00:00:53,620 --> 00:00:55,620
// // ゴーって言ってます
// // 说要开始了
// // 前面的翻译内容是:\n${this.previousTranslation}
// // 请处理以下内容:\n\n${subtitles}
// // 只回复有效的字幕文件内容，不要添加其他格式！`;
// //   }

// //   private calculateCost(inputTokens: number, outputTokens: number): void {
// //     const inputCost = (inputTokens / 1_000_000) * this.COST_PER_MIL_INPUT;
// //     const outputCost = (outputTokens / 1_000_000) * this.COST_PER_MIL_OUTPUT;
// //     this.totalCost += inputCost + outputCost;
// //   }

// //   private splitSubtitles(content: string, maxTokens: number): string[] {
// //     const parts: string[] = [];
// //     let currentPart = "";

// //     for (const line of content.split("\n")) {
// //       if (this.countTokens(currentPart + line) > maxTokens) {
// //         parts.push(currentPart);
// //         currentPart = line;
// //       } else {
// //         currentPart += (currentPart ? "\n" : "") + line;
// //       }
// //     }
// //     if (currentPart) parts.push(currentPart);
// //     return parts;
// //   }

// //   private updateContext(translatedPart: string): void {
// //     this.previousTranslation = translatedPart.split("\n").slice(-4).join("\n");
// //   }

// //   private processFinalOutput(content: string): string {
// //     return this.fixSrtFormat(this.renumberSrt(content.trim()));
// //   }

// //   private renumberSrt(content: string): string {
// //     return content
// //       .split("\n")
// //       .reduce((acc, line) => {
// //         return line.match(/^\d+$/)
// //           ? acc + `${acc.split("\n").filter((l) => l).length / 3 + 1}\n`
// //           : acc + line + "\n";
// //       }, "")
// //       .trim();
// //   }

// //   private fixSrtFormat(content: string): string {
// //     return content
// //       .split("\n\n")
// //       .map((block, index) => {
// //         const lines = block.split("\n");
// //         return lines.length >= 3
// //           ? `${index + 1}\n${lines[1]}\n${lines.slice(2).join("\n")}`
// //           : block;
// //       })
// //       .join("\n\n")
// //       .trim();
// //   }

// //   private generateOutputPath(inputPath: string): string {
// //     return path.join(
// //       path.dirname(inputPath),
// //       `${path.basename(
// //         inputPath,
// //         path.extname(inputPath)
// //       )}_translated${path.extname(inputPath)}`
// //     );
// //   }

// //   private async saveResult(content: string, outputPath: string): Promise<void> {
// //     try {
// //       await fs.writeFile(outputPath, content);
// //     } catch (error) {
// //       this.logError(" 保存结果失败", error);
// //       throw error;
// //     }
// //   }

// //   private logError(message: string, error: any): void {
// //     console.error(
// //       chalk.red(message + ":"),
// //       error instanceof Error ? error.message : error
// //     );
// //   }

// //   private logRetry(attempt: number, error: any): void {
// //     console.warn(
// //       chalk.yellow(` 尝试 ${attempt + 1}/${this.MAX_RETRIES} 失败:`),
// //       error instanceof Error ? error.message : error
// //     );
// //   }

// //   private removeMarkdownCodeBlocks(content: string): string {
// //     return content.replace(/```[\s\S]*?```/g, "");
// //   }
// // }

// import { encode } from "gpt-3-encoder";
// import { SubtitleTranslatorTask } from "@/type/subtitle";
// import { BaseTranslator } from "./base-translator";

// export class SRTTranslator extends BaseTranslator {
//   private readonly costRates = {
//     input: 0.0015, // 示例输入token费用
//     output: 0.002, // 示例输出token费用
//   };
//   private totalCost = 0;

//   protected splitContent(content: string, maxTokens: number): string[] {
//     const fragments: string[] = [];
//     let currentFragment = "";

//     content.split("\n").forEach((line) => {
//       const potentialFragment = currentFragment
//         ? `${currentFragment}\n${line}`
//         : line;
//       if (this.countTokens(potentialFragment) > maxTokens) {
//         fragments.push(currentFragment);
//         currentFragment = line;
//       } else {
//         currentFragment = potentialFragment;
//       }
//     });

//     if (currentFragment) fragments.push(currentFragment);
//     return fragments;
//   }

//   protected formatPrompt(partialContent: string, context: string): string {
//     return `将以下字幕翻译为中日双语，保持严格SRT格式：
// 上下文内容：
// ${context}

// 需要翻译的内容：
// ${partialContent}

// 要求：
// 1. 保留原始时间轴和序号
// 2. 日文和中文逐行对应
// 3. 不要添加额外说明`;
//   }

//   // TODO
//   protected getApiEndpoint(): string {
//     return "https://api.example.com/v1/chat/completions";
//   }

//   protected createHeaders(apiKey: string): Record<string, string> {
//     return {
//       Authorization: `Bearer ${apiKey}`,
//       "Content-Type": "application/json",
//       "X-Request-Source": "srt-translator",
//     };
//   }

//   protected buildRequestBody(prompt: string): BodyInit {
//     return JSON.stringify({
//       model: "gpt-4-turbo",
//       messages: [{ role: "user", content: prompt }],
//       temperature: 0.3,
//       max_tokens: 3500,
//     });
//   }

//   protected async parseResponse(response: any): Promise<string> {
//     const translated = response.choices[0].message.content;
//     this.totalCost += this.calculateCost(response.usage);
//     return this.postProcess(translated);
//   }

//   protected normalizeError(error: unknown): Error {
//     if (error instanceof Error) return error;
//     return new Error(`翻译错误: ${String(error)}`);
//   }

//   private countTokens(text: string): number {
//     return encode(text).length;
//   }

//   private calculateCost(usage: {
//     prompt_tokens: number;
//     completion_tokens: number;
//   }): number {
//     return (
//       (usage.prompt_tokens * this.costRates.input) / 1000 +
//       (usage.completion_tokens * this.costRates.output) / 1000
//     );
//   }

//   private postProcess(content: string): string {
//     return content
//       .replace(/```srt?/g, "")
//       .replace(/```/g, "")
//       .replace(/\n+/g, "\n")
//       .trim();
//   }

//   private updateProgress(
//     task: SubtitleTranslatorTask,
//     current: number,
//     total: number
//   ) {
//     const progress = Math.round((current / total) * 100);
//     task.progress = progress > 95 ? 95 : progress; // 保留最后5%用于后处理
//   }

//   // 覆盖父类方法添加后处理
//   async translate(task: SubtitleTranslatorTask, signal?: AbortSignal) {
//     await super.translate(task, signal);
//     task.progress = 100;
//     this.finalizeTranslation(task);
//   }

//   private finalizeTranslation(task: SubtitleTranslatorTask) {
//     // 实现最终文件保存逻辑
//     console.log(` 翻译完成，总费用：$${this.totalCost.toFixed(2)}`);
//   }
// }

import { encode } from "gpt-3-encoder";
import { SubtitleTranslatorTask } from "../typing";
import { BaseTranslator } from "./base-translator";

type TranslatorConfig = {
  apiKey: string;
  endpoint: string;
  apiModel?: string;
  costRates?: { input: number; output: number };
};

export class SRTTranslator extends BaseTranslator {
  private apiModel: string;
  private costPerInput: number;
  private costPerOutput: number;
  private totalCost = 0;

  constructor(private config: TranslatorConfig) {
    super();
    this.apiModel = config.apiModel || "gpt-3.5-turbo";
    this.costPerInput = config.costRates?.input ?? 0.0015;
    this.costPerOutput = config.costRates?.output ?? 0.002;
  }

  protected splitContent(content: string, maxTokens: number): string[] {
    const fragments: string[] = [];
    let currentFragment = "";

    content.split("\n").forEach((line) => {
      const potentialFragment = currentFragment
        ? `${currentFragment}\n${line}`
        : line;
      if (this.countTokens(potentialFragment) > maxTokens) {
        fragments.push(currentFragment);
        currentFragment = line;
      } else {
        currentFragment = potentialFragment;
      }
    });

    if (currentFragment) fragments.push(currentFragment);
    return fragments;
  }

  protected formatPrompt(partialContent: string, context: string): string {
    return `将以下字幕翻译为中日双语，保持严格SRT格式：
上下文内容：
${context}
 
需要翻译的内容：
${partialContent}
 
要求：
1. 保留原始时间轴和序号 
2. 日文和中文逐行对应 
3. 不要添加额外说明`;
  }

  protected getApiEndpoint(): string {
    return this.config.endpoint;
  }

  protected createHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      "X-Request-Source": "srt-translator",
    };
  }

  protected buildRequestBody(prompt: string): BodyInit {
    return JSON.stringify({
      model: this.apiModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 3500,
    });
  }

  protected async parseResponse(response: any): Promise<string> {
    const translated = response.choices[0].message.content;
    this.totalCost += this.calculateCost(response.usage);
    return this.postProcess(translated);
  }

  protected normalizeError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(`翻译错误: ${String(error)}`);
  }

  // 覆盖父类方法添加后处理
  async translate(task: SubtitleTranslatorTask, signal?: AbortSignal) {
    await super.translate(task, signal);
    task.progress = 100;
    this.finalizeTranslation(task);
  }

  private countTokens(text: string): number {
    return encode(text).length;
  }

  private calculateCost(usage: {
    prompt_tokens: number;
    completion_tokens: number;
  }): number {
    return (
      (usage.prompt_tokens * this.costPerInput) / 1000 +
      (usage.completion_tokens * this.costPerOutput) / 1000
    );
  }

  private postProcess(content: string): string {
    return content
      .replace(/```srt?/g, "")
      .replace(/```/g, "")
      .replace(/\n+/g, "\n")
      .trim();
  }

  private finalizeTranslation(task: SubtitleTranslatorTask) {
    console.log(` 翻译完成，总费用：$${this.totalCost.toFixed(2)}`);
    // 实际文件保存逻辑...
  }
}
