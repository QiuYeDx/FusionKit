import { app, BrowserWindow, shell, ipcMain, dialog, Notification, Menu } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { setupTranslationIPC } from "./translation/ipc";
import { update } from "./update";
import { setupPowerIPC } from "./power";
import { setupConversionIPC } from "./conversion/ipc";
import { setupExtractionIPC } from "./extraction/ipc";
import { setupProxyIPC } from "./proxy";
import { setupFsIPC } from "./fs/ipc";
import { setupRenameIPC } from "./rename/ipc";
import {
  emitTextTranslationEvent,
  setupTextTranslationIPC,
} from "./text-translation/ipc";
import { setupAudioIPC } from "./audio/ipc";
import { setupAudioRealtimeIPC } from "./audio/realtime-ipc";
import {
  LocalSubtitleIpcService,
  LocalSubtitleOverwriteRecoveryAdmissionCoordinator,
  setupLocalSubtitleIPC,
} from "./local-subtitle/ipc";
import {
  LocalSubtitleCapabilityLeaseCoordinator,
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
} from "./local-subtitle/authorizations";
import { LocalSubtitleArtifactRegistry } from "./local-subtitle/subtitle-artifact-registry";
import { LocalSubtitleExporter } from "./local-subtitle/subtitle-exporter";
import { LocalSubtitleJobIpcBridge } from "./local-subtitle/job-ipc";
import { LocalSubtitleJobManager } from "./local-subtitle/job-manager";
import { LocalSubtitleMainRuntime } from "./local-subtitle/main-runtime";
import { LocalSubtitleMediaNormalizer } from "./local-subtitle/media-normalizer";
import { LocalSubtitleModelManager } from "./local-subtitle/model-manager";
import { LocalSubtitleModelIpcBridge } from "./local-subtitle/model-ipc";
import { LocalSubtitleProductionExecutor } from "./local-subtitle/production-executor";
import { LocalSubtitleSessionIpcBridge } from "./local-subtitle/session-ipc";
import { LocalSubtitleSessionLifecycle } from "./local-subtitle/session-lifecycle";
import { LocalSubtitleSessionRegistry } from "./local-subtitle/session-registry";
import { LocalSubtitleServerSupervisor } from "./local-subtitle/server-supervisor";
import { LocalSubtitleServerAppLifecycle } from "./local-subtitle/server-app-lifecycle";
import { initializeLocalSubtitleOverwriteProductionRuntime } from "./local-subtitle/overwrite-production-runtime";
import { LocalSubtitleOverwriteRecoveryIpcBridge } from "./local-subtitle/overwrite-recovery-ipc";
import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcSuccess,
} from "@/type/localSubtitleIpc";
import { TextTranslationService } from "./text-translation/text-translation-service";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { TranslationService } from "./translation/translation-service";

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, "../..");

export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith("6.1")) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let localSubtitleServerLifecycle: LocalSubtitleServerAppLifecycle | undefined;
let translationService: TranslationService = new TranslationService();
let textTranslationService = new TextTranslationService({
  eventSink: (event) => {
    if (!win || win.webContents.isDestroyed()) return;
    emitTextTranslationEvent(win.webContents, event);
  },
});
const preload = path.join(__dirname, "../preload/index.mjs");
const indexHtml = path.join(RENDERER_DIST, "index.html");
const START_LOADING_PROGRESS_CHANNEL = "fusionkit-start-loading-progress";

async function createWindow() {
  win = new BrowserWindow({
    title: process.env.APP_NAME || "FusionKit",
    icon: path.join(process.env.VITE_PUBLIC, "FusionKit.ico"),
    width: 1080,
    height: 786,
    minWidth: 786,
    minHeight: 540,
    resizable: true,
    show: false,
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 15, y: 11.5 } } // macOS 左上角的红黄绿圆点
      : {}),
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // nodeIntegration: true,

      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      // contextIsolation: false,
    },
  });

  const startLoadingProgress = () => {
    if (!win || win.webContents.isDestroyed()) return;
    win.webContents.send(START_LOADING_PROGRESS_CHANNEL);
  };

  win.once("ready-to-show", () => {
    if (!win || win.isDestroyed()) return;

    win.show();
    startLoadingProgress();
  });

  win.webContents.on("dom-ready", () => {
    if (win?.isVisible()) {
      startLoadingProgress();
    }
  });

  if (VITE_DEV_SERVER_URL) {
    // #298
    win.loadURL(VITE_DEV_SERVER_URL);
    // Open devTool if the app is not packaged
    // win.webContents.openDevTools(); // 暂时注释
  } else {
    win.loadFile(indexHtml);

    // 生产环境：禁用刷新和开发者工具快捷键
    win.webContents.on("before-input-event", (event, input) => {
      const isCtrlOrCmd = input.control || input.meta;

      // 禁止刷新: F5, Ctrl/Cmd+R, Ctrl/Cmd+Shift+R
      if (input.key === "F5") {
        event.preventDefault();
        return;
      }
      if (isCtrlOrCmd && input.key.toLowerCase() === "r") {
        event.preventDefault();
        return;
      }

      // 禁止开发者工具: F12, Ctrl/Cmd+Shift+I
      if (input.key === "F12") {
        event.preventDefault();
        return;
      }
      if (isCtrlOrCmd && input.shift && input.key.toLowerCase() === "i") {
        event.preventDefault();
        return;
      }
    });

    // 设置空菜单，移除默认菜单中的刷新/开发者工具快捷键
    Menu.setApplicationMenu(Menu.buildFromTemplate([]));
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url);
    return { action: "deny" };
  });

  // Auto update
  if (win) {
    update(win, {
      prepareQuitAndInstall: () =>
        localSubtitleServerLifecycle?.prepareUpdateInstall() ??
        Promise.resolve(),
    });
  }
}

app.whenReady().then(async () => {
  const localSubtitleManagedResourceRoot = path.join(
    app.getPath("userData"),
    "local-subtitle",
  );
  const localSubtitleResourceEnvironment = app.isPackaged
    ? ({ mode: "packaged", resourcesPath: process.resourcesPath } as const)
    : ({
        mode: "development",
        appRoot: process.env.APP_ROOT!,
      } as const);
  const localSubtitleInputAuthorizations =
    new LocalSubtitleInputAuthorizationRegistry();
  const localSubtitleOutputAuthorizations =
    new LocalSubtitleOutputDirectoryAuthorizationRegistry();
  const localSubtitleCapabilityLeases =
    new LocalSubtitleCapabilityLeaseCoordinator(
      localSubtitleInputAuthorizations,
      localSubtitleOutputAuthorizations,
    );
  const localSubtitleArtifacts = new LocalSubtitleArtifactRegistry({
    revealFile: (filePath) => shell.showItemInFolder(filePath),
  });
  const localSubtitleMediaNormalizer = new LocalSubtitleMediaNormalizer({
    environment: localSubtitleResourceEnvironment,
    managedResourceRoot: localSubtitleManagedResourceRoot,
    inputAuthorizations: localSubtitleInputAuthorizations,
  });
  const localSubtitleServerSupervisor = new LocalSubtitleServerSupervisor({
    managedResourceRoot: localSubtitleManagedResourceRoot,
  });
  const localSubtitleSessionRegistry = new LocalSubtitleSessionRegistry();
  let localSubtitleJobManager: LocalSubtitleJobManager | undefined;
  const localSubtitleModelManager = new LocalSubtitleModelManager({
    managedResourceRoot: localSubtitleManagedResourceRoot,
    runtimeEnvironment: localSubtitleResourceEnvironment,
    supervisor: localSubtitleServerSupervisor,
    sessionRegistry: localSubtitleSessionRegistry,
    isResourceBusy: (resourceId) =>
      Boolean(
        localSubtitleJobManager?.isManagedModelBusy(resourceId) ||
        localSubtitleServerSupervisor.snapshot.modelId === resourceId ||
        localSubtitleServerSupervisor.snapshot.vadModelId === resourceId,
      ),
  });
  await localSubtitleModelManager.initialize().catch(() => undefined);
  const localSubtitleOverwriteRuntime =
    await initializeLocalSubtitleOverwriteProductionRuntime({
      environment: localSubtitleResourceEnvironment,
      managedResourceRoot: localSubtitleManagedResourceRoot,
      artifacts: localSubtitleArtifacts,
    });
  const localSubtitleExporter = new LocalSubtitleExporter(
    localSubtitleArtifacts,
    localSubtitleOverwriteRuntime.status === "ready"
      ? {
          overwriteTransaction: localSubtitleOverwriteRuntime.transactions,
          overwriteRecoveryOwner: localSubtitleOverwriteRuntime.recoveryOwner,
        }
      : {},
  );
  const localSubtitleProductionExecutor = new LocalSubtitleProductionExecutor({
    media: localSubtitleMediaNormalizer,
    supervisor: localSubtitleServerSupervisor,
    inputs: localSubtitleInputAuthorizations,
    outputs: localSubtitleOutputAuthorizations,
    exporter: localSubtitleExporter,
    runtimeEnvironment: localSubtitleResourceEnvironment,
  });
  localSubtitleJobManager = new LocalSubtitleJobManager({
    registry: localSubtitleSessionRegistry,
    inputs: localSubtitleInputAuthorizations,
    outputs: localSubtitleOutputAuthorizations,
    leases: localSubtitleCapabilityLeases,
    runtimeVerifier: localSubtitleMediaNormalizer,
    modelResolver: localSubtitleModelManager,
    executor: localSubtitleProductionExecutor,
    artifacts: localSubtitleArtifacts,
  });
  const localSubtitleOverwriteRecoveryAdmissions =
    new LocalSubtitleOverwriteRecoveryAdmissionCoordinator(
      localSubtitleOverwriteRuntime.lifecycleTarget,
    );
  const localSubtitleSessionLifecycle = new LocalSubtitleSessionLifecycle(
    localSubtitleJobManager,
    localSubtitleModelManager,
    localSubtitleMediaNormalizer,
    localSubtitleServerSupervisor,
    localSubtitleSessionRegistry,
    localSubtitleOverwriteRecoveryAdmissions,
  );
  const localSubtitleMainRuntime = new LocalSubtitleMainRuntime(
    localSubtitleSessionLifecycle,
  );
  localSubtitleServerLifecycle = new LocalSubtitleServerAppLifecycle(
    localSubtitleMainRuntime,
  );
  localSubtitleServerLifecycle.install({
    onBeforeQuit: (listener) => app.on("before-quit", listener),
    quit: () => app.quit(),
  });

  // The sync preload handshake must exist before any renderer starts loading.
  const localSubtitleSessionIpcBridge = new LocalSubtitleSessionIpcBridge(
    localSubtitleSessionRegistry,
  );
  const localSubtitleJobIpcBridge = new LocalSubtitleJobIpcBridge(
    localSubtitleJobManager,
    localSubtitleSessionIpcBridge,
  );
  const localSubtitleModelIpcBridge = new LocalSubtitleModelIpcBridge(
    localSubtitleModelManager,
    localSubtitleSessionIpcBridge,
  );
  const localSubtitleOverwriteRecoveryIpcBridge =
    new LocalSubtitleOverwriteRecoveryIpcBridge(localSubtitleOverwriteRuntime);
  const localSubtitleIpcService = new LocalSubtitleIpcService({
    overwriteRecoveryAdmissions: localSubtitleOverwriteRecoveryAdmissions,
    capabilities: {
      inputs: localSubtitleInputAuthorizations,
      outputs: localSubtitleOutputAuthorizations,
      leases: localSubtitleCapabilityLeases,
      artifacts: localSubtitleArtifacts,
    },
    handlers: {
      public: {
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia]: async (
          request,
          context,
        ) => {
          const { fileToken } = request as { readonly fileToken: string };
          return localSubtitleIpcSuccess(
            await localSubtitleMediaNormalizer.probeDraft({
              owner: context.owner,
              fileToken,
              signal: context.signal,
            }),
          );
        },
        ...localSubtitleSessionIpcBridge.handlers.public,
        ...localSubtitleModelIpcBridge.handlers.public,
        ...localSubtitleJobIpcBridge.handlers.public,
        ...localSubtitleOverwriteRecoveryIpcBridge.handlers.public,
      },
      importModel: localSubtitleModelIpcBridge.handlers.importModel,
      overwriteRecovery:
        localSubtitleOverwriteRecoveryIpcBridge.handlers.overwriteRecovery,
      onOwnerReleased: (owner) => {
        localSubtitleSessionIpcBridge.releaseOwner(owner);
        localSubtitleMainRuntime.releaseOwner({
          webContentsId: owner.senderId,
          ownerSessionId: owner.ownerSessionId,
        });
      },
    },
  });
  localSubtitleSessionIpcBridge.attach(localSubtitleIpcService);
  setupLocalSubtitleIPC(localSubtitleIpcService);
  createWindow();
  setupTranslationIPC(translationService);
  setupPowerIPC(win);
  setupConversionIPC();
  setupExtractionIPC();
  setupProxyIPC();
  setupFsIPC();
  setupRenameIPC();
  setupTextTranslationIPC(textTranslationService);
  setupAudioIPC();
  setupAudioRealtimeIPC();

  app.on("activate", () => {
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length) {
      allWindows[0].focus();
    } else {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  win = null;
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// New window example arg: new windows url
ipcMain.handle("open-win", (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`);
  } else {
    childWindow.loadFile(indexHtml, { hash: arg });
  }
});

type WindowControlAction = "close" | "minimize" | "toggle-maximize";

ipcMain.handle("window-control", (event, action: WindowControlAction) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow) {
    return { success: false };
  }

  switch (action) {
    case "minimize":
      targetWindow.minimize();
      return { success: true };
    case "toggle-maximize":
      if (targetWindow.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow.maximize();
      }
      return { success: true, isMaximized: targetWindow.isMaximized() };
    case "close":
      targetWindow.close();
      return { success: true };
    default:
      return { success: false };
  }
});

ipcMain.on("show-notification", (_event, { title, body }: { title: string; body: string }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

ipcMain.handle("show-item-in-folder", (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle("select-output-directory", async (_event, options?: { title?: string; buttonLabel?: string }) => {
  return await dialog.showOpenDialog({
    title: options?.title ?? "选择输出目录",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: options?.buttonLabel ?? "选择此目录",
  });
});
