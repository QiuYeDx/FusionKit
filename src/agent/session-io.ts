import useAgentStore from "@/store/agent/useAgentStore";
import { MAX_SESSION_BYTES, parseSessionJson } from "./session-schema";

export interface SessionExportResult {
  success: boolean;
  cancelled?: boolean;
  errorCode?: "too_large" | "invalid" | "save_failed";
}

export async function exportSession(): Promise<SessionExportResult> {
  let json: string;
  let createdAt: number;
  try {
    const data = useAgentStore.getState().getSessionExportData();
    json = JSON.stringify(data, null, 2);
    if (json.length > MAX_SESSION_BYTES || new TextEncoder().encode(json).byteLength > MAX_SESSION_BYTES) {
      return { success: false, errorCode: "too_large" };
    }
    // Validate the exact bytes we save, without truncating history or restoring authority.
    createdAt = parseSessionJson(json).session.createdAt;
  } catch {
    return { success: false, errorCode: "invalid" };
  }

  try {
    const result = await window.ipcRenderer.invoke("save-session-file", {
      defaultName: `agent-session-${formatDateForFilename(createdAt)}.json`,
      content: json,
    });
    if (result?.success === true) return { success: true };
    // The existing main handler returns only { success: false } on dialog cancellation.
    if (result?.cancelled === true || (result?.success === false && !result.error && result.cancelled !== false)) {
      return { success: false, cancelled: true };
    }
    return { success: false, errorCode: "save_failed" };
  } catch {
    return { success: false, errorCode: "save_failed" };
  }
}

export async function importSession(): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await window.ipcRenderer.invoke("open-session-file");
    if (!result?.success) {
      return { success: false, error: result?.cancelled ? undefined : "Failed to open file" };
    }

    const data = parseSessionJson(result.content);
    useAgentStore.getState().restoreSession(data);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

function formatDateForFilename(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
