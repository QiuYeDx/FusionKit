import {
  NATIVE_FILE_SELECTION_BRIDGE_VERSION,
  type NativeFileSelectionCapture,
  type NativeFileSelectionResult,
  type NativeFileSelectionSource,
  type ResolvedNativeInputFile,
} from '@/type/nativeFileSelectionIpc';

export const getFilePathFromFile = (file: File): string | undefined => {
  // Electron 24+: 使用 webUtils.getPathForFile() 获取文件路径
  // 在 contextIsolation: true 的情况下，File.path 不可用
  if (typeof window !== 'undefined' && window.electronUtils?.getPathForFile) {
    try {
      const path = window.electronUtils.getPathForFile(file);
      return path || undefined;
    } catch {
      // 如果 electronUtils 不可用，尝试 fallback
    }
  }
  // Fallback: 直接访问 file.path（仅在 contextIsolation: false 时有效）
  return (file as any)?.path as string | undefined;
};

export const getDirFromPath = (filePath: string): string => {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSep === -1) return "";
  if (lastSep === 0) return filePath.slice(0, 1);
  if (lastSep === 2 && filePath[1] === ":") return filePath.slice(0, 3);
  return filePath.slice(0, lastSep);
};

export const getSourceDirFromFile = (file: File): string | undefined => {
  const filePath = getFilePathFromFile(file);
  if (!filePath) return undefined;
  const dir = getDirFromPath(filePath);
  return dir || undefined;
};

export interface ResolvedSelectedNativeFile extends ResolvedNativeInputFile {
  readonly file: File;
}

export async function resolveSelectedNativeFiles(
  files: FileList | readonly File[],
  source: NativeFileSelectionSource,
): Promise<NativeFileSelectionResult<readonly ResolvedSelectedNativeFile[]>> {
  const selected = Array.from(files);
  if (selected.length === 0) {
    return invalidSelectionFailure('files');
  }
  const api = typeof window === 'undefined' ? undefined : window.electronUtils;
  if (
    !api ||
    api.bridgeVersion !== NATIVE_FILE_SELECTION_BRIDGE_VERSION ||
    typeof api.captureInputFile !== 'function' ||
    typeof api.resolveCapturedInputFiles !== 'function'
  ) {
    return bridgeUnavailableFailure();
  }

  let capture: NativeFileSelectionResult<NativeFileSelectionCapture> | undefined;
  for (const file of selected) {
    capture = api.captureInputFile(
      file,
      capture?.ok ? capture.data.captureRef : undefined,
      source,
    );
    if (!capture.ok) return capture;
  }
  if (!capture?.ok) return invalidSelectionFailure('files');

  const resolved = await api.resolveCapturedInputFiles(capture.data.captureRef);
  if (!resolved.ok) return resolved;
  if (resolved.data.length !== selected.length) {
    return invalidSelectionFailure('files');
  }
  return {
    ok: true,
    data: Object.freeze(resolved.data.map((file, index) => Object.freeze({
      ...file,
      file: selected[index]!,
    }))),
  };
}

function invalidSelectionFailure<T>(
  field?: string,
): NativeFileSelectionResult<T> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'The native file selection is invalid.',
      ...(field ? { field } : {}),
    },
  };
}

function bridgeUnavailableFailure<T>(): NativeFileSelectionResult<T> {
  return {
    ok: false,
    error: {
      code: 'bridge_unavailable',
      message: 'The native file selection bridge is unavailable or out of date.',
    },
  };
}
