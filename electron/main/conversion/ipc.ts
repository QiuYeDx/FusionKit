import { ipcMain } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { convertSubtitle, ConvertParams } from "./converter";

async function ensureUniquePath(dir: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, parsed.base);
  let index = 1;
  while (true) {
    try {
      await fs.access(candidate);
      // exists → try next
      candidate = path.join(dir, `${parsed.name} (${index})${parsed.ext}`);
      index++;
    } catch {
      // not exist
      return candidate;
    }
  }
}

export function setupConversionIPC() {
  ipcMain.handle(
    "convert-subtitle",
    async (_event, payload: ConvertParams & { outputDir: string }) => {
      const { outputDir, ...rest } = payload;
      const { outputFileName, outputContent } = convertSubtitle(rest);

      // ensure outputDir exists
      await fs.mkdir(outputDir, { recursive: true });
      const targetPath = await ensureUniquePath(outputDir, outputFileName);
      await fs.writeFile(targetPath, outputContent, "utf-8");

      return {
        ok: true,
        outputFilePath: targetPath,
        finalFileName: path.parse(targetPath).base,
      };
    }
  );
} 