import { validateToolArgs } from "./tool-registry";
import type {
  ScanSubtitleFilesArgs,
  QueueTranslateArgs,
  QueueConvertArgs,
  QueueExtractArgs,
} from "./tool-schemas";
import {
  TaskStatus,
  type SubtitleConverterTask,
  type SubtitleExtractorTask,
} from "@/type/subtitle";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useModelStore from "@/store/useModelStore";

// ---------------------------------------------------------------------------
// Tool Executor — 工具执行桥梁
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
}

export async function executeTool(
  toolName: string,
  rawArgs: unknown
): Promise<ToolExecutionResult> {
  try {
    switch (toolName) {
      case "scan_subtitle_files":
        return executeScan(
          validateToolArgs<ScanSubtitleFilesArgs>(toolName, rawArgs)
        );
      case "queue_subtitle_translate":
        return executeQueueTranslate(
          validateToolArgs<QueueTranslateArgs>(toolName, rawArgs)
        );
      case "queue_subtitle_convert":
        return executeQueueConvert(
          validateToolArgs<QueueConvertArgs>(toolName, rawArgs)
        );
      case "queue_subtitle_extract":
        return executeQueueExtract(
          validateToolArgs<QueueExtractArgs>(toolName, rawArgs)
        );
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// scan_subtitle_files
// ---------------------------------------------------------------------------

async function executeScan(
  args: ScanSubtitleFilesArgs
): Promise<ToolExecutionResult> {
  const allFiles: Array<{
    absolutePath: string;
    fileName: string;
    extension: string;
    size: number;
    sourceDirectory: string;
  }> = [];

  for (const dir of args.directories) {
    try {
      const result = await window.ipcRenderer.invoke("scan-directory", {
        directory: dir,
        extensions: args.extensions,
        recursive: args.recursive,
        maxFiles: 10000,
      });
      if (result?.files) {
        for (const f of result.files) {
          allFiles.push({
            absolutePath: f.absolutePath,
            fileName: f.fileName,
            extension: f.extension,
            size: f.size,
            sourceDirectory: f.sourceDirectory ?? dir,
          });
        }
      }
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to scan directory "${dir}": ${err?.message || err}`,
      };
    }
  }

  const deduped = deduplicateByPath(allFiles);

  return {
    success: true,
    data: {
      files: deduped,
      totalCount: deduped.length,
      scannedDirectories: args.directories,
    },
  };
}

// ---------------------------------------------------------------------------
// queue_subtitle_translate
// ---------------------------------------------------------------------------

async function executeQueueTranslate(
  args: QueueTranslateArgs
): Promise<ToolExecutionResult> {
  const store = useSubtitleTranslatorStore.getState();
  const modelStore = useModelStore.getState();

  let queued = 0;
  const errors: string[] = [];

  for (const filePath of args.filePaths) {
    const fileContent = await readFileContent(filePath);
    if (fileContent === null) {
      errors.push(`Cannot read: ${filePath}`);
      continue;
    }
    const fileName = extractFileName(filePath);
    const outputDir = resolveOutputDir(args.outputMode, args.outputDir, filePath);

    store.addTask({
      fileName,
      fileContent,
      sliceType: args.sliceType as any,
      originFileURL: filePath,
      targetFileURL: outputDir,
      status: TaskStatus.NOT_STARTED,
      progress: 0,
      apiKey: modelStore.apiKey,
      apiModel: modelStore.model,
      endPoint: modelStore.endPoint,
      conflictPolicy: "index",
    });
    queued++;
  }

  return {
    success: true,
    data: {
      queuedCount: queued,
      totalFiles: args.filePaths.length,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// queue_subtitle_convert
// ---------------------------------------------------------------------------

async function executeQueueConvert(
  args: QueueConvertArgs
): Promise<ToolExecutionResult> {
  const store = useSubtitleConverterStore.getState();

  let queued = 0;
  const errors: string[] = [];

  for (const filePath of args.filePaths) {
    const fileContent = await readFileContent(filePath);
    if (fileContent === null) {
      errors.push(`Cannot read: ${filePath}`);
      continue;
    }
    const fileName = extractFileName(filePath);
    const ext = extractExtension(filePath);
    const outputDir = resolveOutputDir(args.outputMode, args.outputDir, filePath);

    const task: SubtitleConverterTask = {
      fileName,
      fileContent,
      from: ext as any,
      to: args.to as any,
      originFileURL: filePath,
      targetFileURL: outputDir,
      status: TaskStatus.NOT_STARTED,
      progress: 0,
      conflictPolicy: "index",
    };
    store.addTask(task);
    queued++;
  }

  return {
    success: true,
    data: {
      queuedCount: queued,
      totalFiles: args.filePaths.length,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// queue_subtitle_extract
// ---------------------------------------------------------------------------

async function executeQueueExtract(
  args: QueueExtractArgs
): Promise<ToolExecutionResult> {
  const store = useSubtitleExtractorStore.getState();

  let queued = 0;
  const errors: string[] = [];

  for (const filePath of args.filePaths) {
    const fileContent = await readFileContent(filePath);
    if (fileContent === null) {
      errors.push(`Cannot read: ${filePath}`);
      continue;
    }
    const fileName = extractFileName(filePath);
    const ext = extractExtension(filePath);
    const outputDir = resolveOutputDir(args.outputMode, args.outputDir, filePath);

    const task: SubtitleExtractorTask = {
      fileName,
      fileContent,
      fileType: ext as any,
      originFileURL: filePath,
      targetFileURL: outputDir,
      keep: args.keep,
      status: TaskStatus.NOT_STARTED,
      progress: 0,
      conflictPolicy: "index",
    };
    store.addTask(task);
    queued++;
  }

  return {
    success: true,
    data: {
      queuedCount: queued,
      totalFiles: args.filePaths.length,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

async function readFileContent(absolutePath: string): Promise<string | null> {
  try {
    return await window.ipcRenderer.invoke("read-file-head", {
      filePath: absolutePath,
      lines: 999999,
    });
  } catch {
    return null;
  }
}

function extractFileName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() || filePath;
}

function extractExtension(filePath: string): string {
  const parts = filePath.split(".");
  return (parts.pop() || "").toUpperCase();
}

function resolveOutputDir(
  mode: string | undefined,
  customDir: string | undefined,
  filePath: string
): string {
  if (mode === "custom" && customDir) return customDir;
  return filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
}

function deduplicateByPath<T extends { absolutePath: string }>(
  files: T[]
): T[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    const key = f.absolutePath.replace(/\\/g, "/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
