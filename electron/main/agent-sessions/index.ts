import path from "node:path";
import { app, BrowserWindow, ipcMain, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { AGENT_SESSIONS_CHANNELS } from "../../../src/agent/session-store-contract";
import { AgentSessionRepository } from "./repository";

/** Only the application's own windows, from their main frame, may read or write saved conversations. */
function trusted(event: IpcMainInvokeEvent): boolean {
  return !!BrowserWindow.fromWebContents(event.sender) && event.senderFrame === event.sender.mainFrame;
}

const blocked = { ok: false, error: "agent_sessions_blocked" } as const;

export function setupAgentSessionsIPC(
  repository = new AgentSessionRepository(path.join(app.getPath("userData"), "agent-sessions")),
  ipc: Pick<IpcMain, "handle"> = ipcMain,
) {
  ipc.handle(AGENT_SESSIONS_CHANNELS.list, (event) => trusted(event) ? repository.list() : blocked);
  ipc.handle(AGENT_SESSIONS_CHANNELS.load, (event, id: unknown) => trusted(event) ? repository.load(String(id)) : blocked);
  ipc.handle(AGENT_SESSIONS_CHANNELS.save, (event, request: unknown) => trusted(event) ? repository.save(request) : blocked);
  ipc.handle(AGENT_SESSIONS_CHANNELS.remove, (event, id: unknown) => trusted(event) ? repository.remove(String(id)) : blocked);
  ipc.handle(AGENT_SESSIONS_CHANNELS.clear, (event) => trusted(event) ? repository.clear() : blocked);
  return repository;
}
