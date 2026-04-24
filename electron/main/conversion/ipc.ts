/**
 * 字幕转换 IPC 桥接层。
 *
 * 职责：注册 ipcMain handler，接收渲染进程的转换请求，
 * 调用 converter.ts 完成纯文本转换后，将结果写入磁盘。
 *
 * IPC 通道："convert-subtitle"
 *  - 渲染进程通过 window.ipcRenderer.invoke("convert-subtitle", payload) 调用
 *  - 成功返回 { ok, outputFilePath, finalFileName }
 */
import { ipcMain } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { convertSubtitle, ConvertParams } from "./converter";

/**
 * 输出文件冲突策略：
 *  - "overwrite"：直接覆盖同名文件
 *  - "index"：自动追加序号，如 name (1).srt、name (2).srt
 */
type OutputConflictPolicy = "overwrite" | "index";

/**
 * 根据冲突策略确定最终的输出文件路径。
 *
 * 当策略为 "index" 时，如果目标文件已存在，会递增序号直到找到不冲突的文件名。
 * 例如：output.srt → output (1).srt → output (2).srt → ...
 */
async function resolveOutputPath(
  dir: string,
  fileName: string,
  conflictPolicy: OutputConflictPolicy = "index"
): Promise<string> {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, parsed.base);
  if (conflictPolicy === "overwrite") return candidate;
  let index = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${parsed.name} (${index})${parsed.ext}`);
      index++;
    } catch {
      // fs.access 抛异常说明文件不存在，可以安全使用该路径
      return candidate;
    }
  }
}

/**
 * 注册 "convert-subtitle" IPC handler。
 * 应在 app.whenReady() 后调用一次。
 *
 * 处理流程：
 *  1. 从 payload 中分离出文件系统参数（outputDir、conflictPolicy）和转换参数
 *  2. 调用 convertSubtitle() 执行纯文本格式转换
 *  3. 确保输出目录存在
 *  4. 根据冲突策略确定最终文件路径
 *  5. 将转换结果写入磁盘（UTF-8）
 *  6. 返回成功信息及最终路径供渲染进程展示
 */
export function setupConversionIPC() {
  ipcMain.handle(
    "convert-subtitle",
    async (
      _event,
      payload: ConvertParams & {
        outputDir: string;
        conflictPolicy?: OutputConflictPolicy;
      }
    ) => {
      const { outputDir, conflictPolicy, ...rest } = payload;
      const { outputFileName, outputContent } = convertSubtitle(rest);

      await fs.mkdir(outputDir, { recursive: true });
      const targetPath = await resolveOutputPath(
        outputDir,
        outputFileName,
        conflictPolicy ?? "index"
      );
      await fs.writeFile(targetPath, outputContent, "utf-8");

      return {
        ok: true,
        outputFilePath: targetPath,
        finalFileName: path.parse(targetPath).base,
      };
    }
  );
}