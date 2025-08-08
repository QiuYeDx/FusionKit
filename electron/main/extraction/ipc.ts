import { ipcMain } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { extractSubtitle, type ExtractParams } from "./extractor";

async function ensureUniquePath(dir: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, parsed.base);
  let index = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${parsed.name} (${index})${parsed.ext}`);
      index++;
    } catch {
      return candidate;
    }
  }
}

export function setupExtractionIPC() {
  ipcMain.handle(
    "extract-subtitle-language",
    async (_event, payload: ExtractParams & { outputDir: string }) => {
      const { outputDir, ...rest } = payload;
      const { outputFileName, outputContent } = extractSubtitle(rest);

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