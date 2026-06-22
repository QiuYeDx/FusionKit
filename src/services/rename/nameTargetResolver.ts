import type {
  CheckRenameTargetPathsResult,
  NameTranslationOptions,
  ScanRenameTargetsResult,
} from "./nameTypes";

export async function scanNameTranslationTargets(
  options: NameTranslationOptions,
  maxTargets?: number
): Promise<ScanRenameTargetsResult> {
  const ipcRenderer = getIpcRenderer();
  return ipcRenderer.invoke("scan-rename-targets", { options, maxTargets });
}

export async function checkRenameTargetExists(filePath: string): Promise<boolean> {
  const ipcRenderer = getIpcRenderer();
  const result = await ipcRenderer.invoke("check-path-exists", filePath);
  return Boolean(result?.exists);
}

export async function checkRenameTargetsExist(
  paths: string[]
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const ipcRenderer = getIpcRenderer();
  const result = (await ipcRenderer.invoke("check-rename-target-paths", {
    paths,
  })) as CheckRenameTargetPathsResult;
  return new Set(result?.existingPaths ?? []);
}

function getIpcRenderer(): Window["ipcRenderer"] {
  if (typeof window === "undefined" || !window.ipcRenderer) {
    throw new Error("Electron IPC is not available in this environment.");
  }
  return window.ipcRenderer;
}
