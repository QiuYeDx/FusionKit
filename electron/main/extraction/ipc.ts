/**
 * 字幕语言提取 — IPC 通道注册
 *
 * 将 extractSubtitle 能力通过 Electron IPC 暴露给渲染进程。
 * 渲染进程调用 ipcRenderer.invoke("extract-subtitle-language", payload) 即可触发提取。
 */
import { ipcMain } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { extractSubtitle, type ExtractParams } from "./extractor";

/** 输出文件重名策略：overwrite 直接覆盖，index 自动追加序号 */
type OutputConflictPolicy = "overwrite" | "index";

/**
 * 确定最终输出路径，处理文件名冲突。
 *
 * - overwrite：直接返回目标路径（覆盖同名文件）
 * - index（默认）：若目标已存在，则尝试 "name (1).ext"、"name (2).ext" … 直到找到可用路径
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
      // fs.access 抛出异常说明文件不存在，可以使用该路径
      return candidate;
    }
  }
}

/**
 * 注册 "extract-subtitle-language" IPC handler。
 *
 * 渲染进程 payload 格式：ExtractParams & { outputDir, conflictPolicy? }
 * 返回值：{ ok, outputFilePath, finalFileName }
 */
export function setupExtractionIPC() {
  ipcMain.handle(
    "extract-subtitle-language",
    async (
      _event,
      payload: ExtractParams & {
        outputDir: string;
        conflictPolicy?: OutputConflictPolicy;
      }
    ) => {
      const { outputDir, conflictPolicy, ...rest } = payload;

      // 执行语言提取
      const { outputFileName, outputContent } = extractSubtitle(rest);

      // 确保输出目录存在
      await fs.mkdir(outputDir, { recursive: true });

      // 解决文件名冲突并写入
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
