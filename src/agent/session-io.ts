import useAgentStore from "@/store/agent/useAgentStore";
import { parseSessionJson } from "./session-schema";

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
