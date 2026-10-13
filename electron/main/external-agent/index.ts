import path from "node:path";
import { app, BrowserWindow, ipcMain, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  EXTERNAL_AGENT_CHANNELS,
  type ExternalAgentStatus,
  type ExternalResult,
} from "../../../src/agent/external/contract";
import { EXTERNAL_TOOLS, isExternalToolName } from "../../../src/agent/external/catalog";
import { ExternalAgentSettingsStore } from "./settings-store";
import { EndpointFile } from "./endpoint-file";
import { installSkill, skillStatus } from "./skill";
import { ExternalAgentHttpHost } from "./http-host";
import { RendererBridge } from "./renderer-bridge";

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
  let state: Pick<ExternalAgentStatus, "state" | "error" | "port"> = { state: "stopped", port: 0 };
  const host = new ExternalAgentHttpHost({
    version,
    callTool: async (call, signal) => {
      // Read-only access refuses every change here, before the window is involved.
      if (store.settings.trust === "read_only" && isExternalToolName(call.tool) && EXTERNAL_TOOLS[call.tool].access !== "read") return { ok: false, error: "read_only" };
      return bridge.call(call, signal);
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
  ipc.handle(EXTERNAL_AGENT_CHANNELS.closeSession, (event, id: unknown) => reply(event, async () => {
    await host.closeSession(String(id)); return null;
  }));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.connectionInfo, event => reply(event, async () => {
    const packaged = app.isPackaged;
    const script = ["external-agent", "fusionkit-mcp-stdio.cjs"];
    return {
      exePath: process.execPath,
      scriptPath: packaged ? path.join(process.resourcesPath, ...script) : path.join(app.getAppPath(), "resources", ...script),
      endpointPath: endpoint.file,
      ...(packaged ? {} : { appPath: app.getAppPath() }),
      platform: process.platform,
    };
  }));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.skillStatus, event => reply(event, () => Promise.all([skillStatus("claude"), skillStatus("codex")])));
  ipc.handle(EXTERNAL_AGENT_CHANNELS.installSkill, (event, target: unknown) => reply(event, () => {
    if (target !== "claude" && target !== "codex") throw new Error("invalid_settings");
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

  const ready = store.load().then(() => apply(true));
  app.on("before-quit", () => { bridge.close(); endpoint.clearSync(); void host.stop(); });

  return { store, host, bridge, ready, status, apply, endpoint, stop: async () => { bridge.close(); await host.stop(); await endpoint.clear(); } };
}
