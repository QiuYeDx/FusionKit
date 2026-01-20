import { ipcMain } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { extractSubtitle, type ExtractParams } from "./extractor";

type OutputConflictPolicy = "overwrite" | "index";

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
      return candidate;
    }
  }
}

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
      const { outputFileName, outputContent } = extractSubtitle(rest);

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