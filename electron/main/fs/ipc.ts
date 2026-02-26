import { ipcMain } from "electron";
import path from "path";
import { promises as fs } from "fs";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface ScanDirectoryParams {
  directory: string;
  extensions: string[];
  recursive: boolean;
  maxDepth?: number;
  maxFiles?: number;
}

interface FileMetadata {
  absolutePath: string;
  fileName: string;
  extension: string;
  size: number;
  modifiedAt: number;
  sourceDirectory: string;
}

interface ScanDirectoryResult {
  files: FileMetadata[];
  scannedDirs: number;
  truncated: boolean;
}

interface ReadFileHeadParams {
  filePath: string;
  lines: number;
}

// ---------------------------------------------------------------------------
// 内部扫描逻辑
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILES = 10000;
const DEFAULT_MAX_DEPTH = 20;

async function scanDirectoryRecursive(
  dir: string,
  extensions: Set<string>,
  recursive: boolean,
  maxDepth: number,
  maxFiles: number,
  depth: number,
  result: FileMetadata[],
  scannedDirs: { count: number }
): Promise<boolean> {
  if (depth > maxDepth) return false;
  if (result.length >= maxFiles) return true;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  scannedDirs.count++;

  for (const entry of entries) {
    if (result.length >= maxFiles) return true;

    const fullPath = path.join(dir, entry.name);

    if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toUpperCase();
      if (extensions.size === 0 || extensions.has(ext)) {
        try {
          const stat = await fs.stat(fullPath);
          result.push({
            absolutePath: fullPath,
            fileName: entry.name,
            extension: ext,
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            sourceDirectory: dir,
          });
        } catch {
          // skip files we can't stat
        }
      }
    } else if (entry.isDirectory() && recursive) {
      if (entry.name.startsWith(".")) continue;

      const truncated = await scanDirectoryRecursive(
        fullPath,
        extensions,
        recursive,
        maxDepth,
        maxFiles,
        depth + 1,
        result,
        scannedDirs
      );
      if (truncated) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------

export function setupFsIPC() {
  /**
   * scan-directory: 递归扫描目录，返回匹配扩展名的文件元数据列表
   */
  ipcMain.handle(
    "scan-directory",
    async (_event, params: ScanDirectoryParams): Promise<ScanDirectoryResult> => {
      const {
        directory,
        extensions,
        recursive,
        maxDepth = DEFAULT_MAX_DEPTH,
        maxFiles = DEFAULT_MAX_FILES,
      } = params;

      const extSet = new Set(extensions.map((e) => e.toUpperCase()));
      const files: FileMetadata[] = [];
      const scannedDirs = { count: 0 };

      const truncated = await scanDirectoryRecursive(
        directory,
        extSet,
        recursive,
        maxDepth,
        maxFiles,
        0,
        files,
        scannedDirs
      );

      return {
        files,
        scannedDirs: scannedDirs.count,
        truncated,
      };
    }
  );

  /**
   * read-file-head: 读取文件前 N 行（用于内容抽样判定）
   */
  ipcMain.handle(
    "read-file-head",
    async (_event, params: ReadFileHeadParams): Promise<string> => {
      const { filePath, lines } = params;
      const content = await fs.readFile(filePath, "utf-8");
      return content.split("\n").slice(0, lines).join("\n");
    }
  );

  /**
   * get-file-metadata: 获取单个文件的元数据
   */
  ipcMain.handle(
    "get-file-metadata",
    async (_event, filePath: string): Promise<FileMetadata | null> => {
      try {
        const stat = await fs.stat(filePath);
        return {
          absolutePath: filePath,
          fileName: path.basename(filePath),
          extension: path.extname(filePath).slice(1).toUpperCase(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          sourceDirectory: path.dirname(filePath),
        };
      } catch {
        return null;
      }
    }
  );

  /**
   * check-path-exists: 检查路径是否存在及其类型
   */
  ipcMain.handle(
    "check-path-exists",
    async (
      _event,
      targetPath: string
    ): Promise<{ exists: boolean; isDirectory: boolean; isFile: boolean }> => {
      try {
        const stat = await fs.stat(targetPath);
        return {
          exists: true,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
        };
      } catch {
        return { exists: false, isDirectory: false, isFile: false };
      }
    }
  );
}
