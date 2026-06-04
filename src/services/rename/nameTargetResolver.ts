import type {
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

function getIpcRenderer(): Window["ipcRenderer"] {
  if (typeof window === "undefined" || !window.ipcRenderer) {
    throw new Error("Electron IPC is not available in this environment.");
  }
  return window.ipcRenderer;
}
