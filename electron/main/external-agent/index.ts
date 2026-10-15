import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { app, BrowserWindow, ipcMain, shell, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  EXTERNAL_AGENT_CHANNELS,
  type ExternalAgentStatus,
  type ExternalResult,
  type ExternalToolCall,
  type ExternalToolOutcome,
} from "../../../src/agent/external/contract";
import { EXTERNAL_TOOLS, isExternalToolName } from "../../../src/agent/external/catalog";
import { ExternalAgentSettingsStore } from "./settings-store";
import { EndpointFile } from "./endpoint-file";
import { installSkill, skillStatus } from "./skill";
import { clientConfigPath, clientConfigStatus, ConfigUnreadable, writeClientConfig } from "./client-config-writer";
import { codexTable, CURSOR_INSTALL_PREFIX, cursorInstallLink, isWritableClient, jsonServerEntry, WRITABLE_CLIENTS } from "../../../src/agent/external/client-configs";
import { ExternalAgentHttpHost } from "./http-host";
import { RendererBridge } from "./renderer-bridge";
import { ActivityLog } from "./activity-log";
import { activityListRequestSchema, activityUpdateSchema, type ActivityAccess, type ActivityNote, type ActivityRecord } from "../../../src/agent/external/activity";

/** Only the main window, from its main frame, may configure access or answer calls. */
function fromMainWindow(event: IpcMainInvokeEvent | IpcMainEvent, getWindow: () => BrowserWindow | null): boolean {
  const window = getWindow();
  return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame;
}

const blocked = { ok: false, error: "external_agent_blocked" } as const;

export function setupExternalAgent(options: {
  getWindow: () => BrowserWindow | null;
  version?: string;
  directory?: string;
  ipc?: Pick<IpcMain, "handle" | "on">;
}) {
  const ipc = options.ipc ?? ipcMain;
  const directory = options.directory ?? path.join(app.getPath("userData"), "external-agent");
  const store = new ExternalAgentSettingsStore(directory);
  const endpoint = new EndpointFile(directory);
  const version = options.version ?? app.getVersion();
  const target = () => {
    const window = options.getWindow();
    return window && !window.isDestroyed() ? window.webContents : null;
  };
  const bridge = new RendererBridge({ getTarget: target });
  const activity = new ActivityLog(directory, {
    onEvent: event => { const contents = target(); if (contents && !contents.isDestroyed()) contents.send(EXTERNAL_AGENT_CHANNELS.activity, event); },
  });
  const accessOf = (tool: string): ActivityAccess => isExternalToolName(tool) ? EXTERNAL_TOOLS[tool].access : "read";
  // Every call leaves a record; the session, client and tool are the main process's own.
  const remember = (call: Omit<ExternalToolCall, "callId">, startedAt: number, outcome: ExternalToolOutcome, note?: ActivityNote, refused = false) => {
    const { approval, confirmationId, reason, ...rest } = note ?? {};
    const pending = !outcome.ok && outcome.error === "confirmation_pending";
    const status: ActivityRecord["status"] = outcome.ok ? "ok" : pending ? "pending"
      : outcome.error === "declined_by_user" ? "declined" : outcome.error === "confirmation_expired" ? "expired" : outcome.error === "cancelled" ? "cancelled" : "failed";
    const detailReason = !outcome.ok && typeof outcome.detail?.reason === "string" ? outcome.detail.reason : undefined;
    const kept = { ...rest, ...((reason ?? detailReason) ? { reason: (reason ?? detailReason)!.slice(0, 300) } : {}) };
    const destructive = accessOf(call.tool) === "destructive" || rest.summary?.warning === "overwrite";
    activity.record({
      id: randomUUID(), sessionId: call.sessionId, client: { name: call.client.name.slice(0, 100), version: call.client.version.slice(0, 50) },
      tool: call.tool.slice(0, 100), access: destructive ? "destructive" : accessOf(call.tool), startedAt, endedAt: Date.now(), status,
      ...(!outcome.ok && !pending ? { error: outcome.error } : {}),
      ...(refused ? { approval: "read_only" as const } : approval ? { approval } : {}),
      ...(pending && confirmationId ? { confirmationId } : {}),
      ...(Object.keys(kept).length ? { note: kept } : {}),
    });
  };
  let state: Pick<ExternalAgentStatus, "state" | "error" | "port"> = { state: "stopped", port: 0 };
  const host = new ExternalAgentHttpHost({
    version,
    callTool: async (call, signal) => {
      const startedAt = Date.now();
      // Read-only access refuses every change here, before the window is involved.
      if (store.settings.trust === "read_only" && isExternalToolName(call.tool) && EXTERNAL_TOOLS[call.tool].access !== "read") {
        const outcome: ExternalToolOutcome = { ok: false, error: "read_only" };
        remember(call, startedAt, outcome, undefined, true);
        return outcome;
      }
      const answer = await bridge.call(call, signal);
      remember(call, startedAt, answer.outcome, answer.activity);
      return answer.outcome;
    },
    onSessionsChanged: () => publish(),
  });

  const status = (): ExternalAgentStatus => {
    const settings = store.settings;
    const port = state.state === "running" ? state.port : settings.port;
    return {
      enabled: settings.enabled, state: state.state, port, trust: settings.trust,
      ...(state.state === "running" ? { url: `http://127.0.0.1:${port}/mcp` } : {}),
      ...(state.error ? { error: state.error } : {}),
      sessions: host.sessionSummaries(),
    };
  };
  function publish() {
    activity.syncSessions(host.sessionSummaries());
    const contents = target();
    if (contents && !contents.isDestroyed()) contents.send(EXTERNAL_AGENT_CHANNELS.status, status());
  }

  // Starts, restarts or stops listening to match the settings; serialized so changes never interleave.
  let applying: Promise<void> = Promise.resolve();
  let applied = { enabled: false, port: 0, token: "" };
  const apply = (force = false) => {
    applying = applying.then(async () => {
      const settings = store.settings;
      const wanted = { enabled: settings.enabled, port: settings.port, token: settings.token };
      if (!force && wanted.enabled === applied.enabled && wanted.port === applied.port && wanted.token === applied.token && (state.state === "running") === wanted.enabled) return;
      if (!wanted.enabled) {
        await host.stop();
        state = { state: "stopped", port: 0 };
      } else {
        const started = await host.start(wanted.port, wanted.token);
        state = started.ok ? { state: "running", port: started.port } : { state: "error", port: wanted.port, error: started.error };
      }
      applied = wanted;
      // The stdio bridge finds the endpoint through this file; it exists only while listening.
      if (state.state === "running") await endpoint.publish({ url: `http://127.0.0.1:${state.port}/mcp`, token: wanted.token, appVersion: version });
      else await endpoint.clear();
      publish();
    }).catch(() => undefined);
    return applying;
  };

  const reply = async <T>(event: IpcMainInvokeEvent, run: () => Promise<T>): Promise<ExternalResult<T> | typeof blocked> => {
    if (!fromMainWindow(event, options.getWindow)) return blocked;
    try { return { ok: true, value: await run() }; }
    catch (error) { return { ok: false, error: error instanceof Error && error.message === "invalid_settings" ? "invalid_settings" : "write_failed" }; }
  };
  ipc.handle(EXTERNAL_AGENT_CHANNELS.getSettings, event => reply(event, async () => store.settings));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.updateSettings, (event, update: unknown) => reply(event, async () => {
    const settings = await store.update(update); await apply();
    // The trust level changes nothing in the endpoint, but the window enforces it too.
    publish();
    return settings;
  }));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.regenerateToken, event => reply(event, async () => {
    const settings = await store.regenerateToken(); await apply(); return settings;
  }));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.getStatus, event => reply(event, async () => status()));
  const liveIds = () => new Set(host.sessionSummaries().map(session => session.id));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.activityList, (event, request: unknown) => reply(event, async () => {
    const parsed = activityListRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error("invalid_settings");
    return activity.list(parsed.data);
  }));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.activitySessions, event => reply(event, async () => activity.sessionSummaries(liveIds())));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.activityClear, event => reply(event, async () => { await activity.clear(liveIds()); return null; }));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.activityUndone, (event, id: unknown) => reply(event, async () => typeof id === "string" ? activity.markUndone(id) : null));
  ipc.on(EXTERNAL_AGENT_CHANNELS.reportActivity, (event, update: unknown) => {
    if (!fromMainWindow(event, options.getWindow)) return;
    const parsed = activityUpdateSchema.safeParse(update);
    if (parsed.success) activity.settle(parsed.data);
  });
  ipc.handle(EXTERNAL_AGENT_CHANNELS.closeSession, (event, id: unknown) => reply(event, async () => {
    await host.closeSession(String(id)); return null;
  }));
  const connectionInfo = () => {
    const packaged = app.isPackaged;
    const script = ["external-agent", "fusionkit-mcp-stdio.cjs"];
    return {
      exePath: process.execPath,
      scriptPath: packaged ? path.join(process.resourcesPath, ...script) : path.join(app.getAppPath(), "resources", ...script),
      endpointPath: endpoint.file,
      ...(packaged ? {} : { appPath: app.getAppPath() }),
      platform: process.platform,
    };
  };
  ipc.handle(EXTERNAL_AGENT_CHANNELS.connectionInfo, event => reply(event, async () => connectionInfo()));
  // Writing FusionKit's entry into a desktop client's own file, only when the user asks.
  ipc.handle(EXTERNAL_AGENT_CHANNELS.writeClientConfig, async (event, request: unknown) => {
    if (!fromMainWindow(event, options.getWindow)) return blocked;
    const { client, transport } = (request ?? {}) as { client?: unknown; transport?: unknown };
    if (typeof client !== "string" || !isWritableClient(client as never) || (transport !== "http" && transport !== "stdio")) return { ok: false, error: "invalid_settings" };
    const settings = store.settings;
    if (!settings.enabled || !settings.token) return { ok: false, error: "not_enabled" };
    const port = state.state === "running" ? state.port : settings.port;
    const input = { url: `http://127.0.0.1:${port}/mcp`, token: settings.token, info: connectionInfo() };
    const target = client as (typeof WRITABLE_CLIENTS)[number];
    try {
      const value = await writeClientConfig(target, target === "codex" ? { toml: codexTable(transport, input) }
        : { json: jsonServerEntry(target === "claude-desktop" ? "stdio" : transport, input) });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof ConfigUnreadable ? "config_unreadable" : "write_failed" };
    }
  });
  ipc.handle(EXTERNAL_AGENT_CHANNELS.openClientInstall, async (event, request: unknown) => {
    if (!fromMainWindow(event, options.getWindow)) return blocked;
    const { client, transport } = (request ?? {}) as { client?: unknown; transport?: unknown };
    if (client !== "cursor" || (transport !== "http" && transport !== "stdio")) return { ok: false, error: "invalid_settings" };
    const settings = store.settings;
    if (!settings.enabled || !settings.token) return { ok: false, error: "not_enabled" };
    const port = state.state === "running" ? state.port : settings.port;
    const link = cursorInstallLink(transport, { url: `http://127.0.0.1:${port}/mcp`, token: settings.token, info: connectionInfo() });
    // Only Cursor's install link leaves through here, never an arbitrary address.
    if (!link.startsWith(CURSOR_INSTALL_PREFIX)) return { ok: false, error: "invalid_settings" };
    try { await shell.openExternal(link); return { ok: true, value: null }; }
    catch { return { ok: false, error: "open_failed" }; }
  });
  ipc.handle(EXTERNAL_AGENT_CHANNELS.clientConfigStatus, event => reply(event, () => Promise.all(WRITABLE_CLIENTS.map(client => clientConfigStatus(client)))));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.revealClientConfig, (event, client: unknown) => reply(event, async () => {
    if (typeof client !== "string" || !isWritableClient(client as never)) throw new Error("invalid_settings");
    const file = clientConfigPath(client as (typeof WRITABLE_CLIENTS)[number]);
    if (existsSync(file)) shell.showItemInFolder(file);
    else if (existsSync(path.dirname(file))) await shell.openPath(path.dirname(file));
    else throw new Error("not_found");
    return null;
  }));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.skillStatus, event => reply(event, () => Promise.all([skillStatus("claude"), skillStatus("agents")])));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.installSkill, (event, target: unknown) => reply(event, () => {
    if (target !== "claude" && target !== "agents") throw new Error("invalid_settings");
    return installSkill(target);
  }));
  ipc.on(EXTERNAL_AGENT_CHANNELS.ready, event => {
    if (!fromMainWindow(event, options.getWindow)) return;
    bridge.markReady(event.sender.id);
    publish();
  });
  ipc.on(EXTERNAL_AGENT_CHANNELS.requestAttention, event => {
    if (!fromMainWindow(event, options.getWindow)) return;
    const window = options.getWindow();
    // A taskbar flash, never focus: the user may be busy in another program.
    if (window && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true);
  });
  ipc.handle(EXTERNAL_AGENT_CHANNELS.respond, (event, response: unknown) => {
    if (!fromMainWindow(event, options.getWindow)) return false;
    return bridge.respond(event.sender.id, response);
  });

  // A navigation, crash or close of the window ends its tool host and the calls it held.
  const watched = new WeakSet<WebContents>();
  const watch = () => {
    const contents = target();
    if (!contents || watched.has(contents)) return;
    watched.add(contents);
    const id = contents.id;
    contents.on("did-start-navigation", (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) bridge.invalidate(id);
    });
    contents.on("render-process-gone", () => bridge.invalidate(id));
    contents.once("destroyed", () => bridge.invalidate(id));
  };
  app.on("browser-window-created", () => setImmediate(watch));
  watch();

  const ready = Promise.all([store.load(), activity.load()]).then(() => apply(true));
  app.on("before-quit", () => { bridge.close(); endpoint.clearSync(); void host.stop(); });

  return { store, host, bridge, activity, ready, status, apply, endpoint, stop: async () => { bridge.close(); await host.stop(); await endpoint.clear(); } };
}
