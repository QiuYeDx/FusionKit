import useAgentStore from "@/store/agent/useAgentStore";
import type { SessionExportData } from "./types";

const CURRENT_VERSION = 1;

export async function exportSession(): Promise<boolean> {
  const data = useAgentStore.getState().getSessionExportData();
  const json = JSON.stringify(data, null, 2);

  try {
    const result = await window.ipcRenderer.invoke("save-session-file", {
      defaultName: `agent-session-${formatDateForFilename(data.session.createdAt)}.json`,
      content: json,
    });
    return result?.success === true;
  } catch {
    return false;
  }
}

export async function importSession(): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await window.ipcRenderer.invoke("open-session-file");
    if (!result?.success) {
      return { success: false, error: result?.cancelled ? undefined : "Failed to open file" };
    }

    const data = JSON.parse(result.content) as SessionExportData;

    const validation = validateSessionData(data);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    useAgentStore.getState().restoreSession(data);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

function validateSessionData(data: unknown): { valid: boolean; error?: string } {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Invalid file format" };
  }

  const d = data as Record<string, unknown>;

  if (typeof d.version !== "number" || d.version > CURRENT_VERSION) {
    return { valid: false, error: `Unsupported version: ${d.version}` };
  }

  if (!d.session || typeof d.session !== "object") {
    return { valid: false, error: "Missing session data" };
  }

  const session = d.session as Record<string, unknown>;
  if (!Array.isArray(session.messages)) {
    return { valid: false, error: "Missing session messages" };
  }

  if (!d.tokenStats || typeof d.tokenStats !== "object") {
    return { valid: false, error: "Missing token stats" };
  }

  if (!Array.isArray(d.sessionLog)) {
    return { valid: false, error: "Missing session log" };
  }

  return { valid: true };
}

function formatDateForFilename(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
