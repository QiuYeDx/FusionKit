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
let translationService: TranslationService = new TranslationService();
const preload = path.join(__dirname, "../preload/index.mjs");
const indexHtml = path.join(RENDERER_DIST, "index.html");

async function createWindow() {
  win = new BrowserWindow({
    title: process.env.APP_NAME || "FusionKit",
    icon: path.join(process.env.VITE_PUBLIC, "FusionKit.ico"),
    width: 1080,
    height: 786,
    minWidth: 720,
    minHeight: 540,
    resizable: true,
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
    update(win);
  }
}

app.whenReady().then(() => {
  createWindow();
  setupTranslationIPC(translationService);
  setupPowerIPC(win);
  setupConversionIPC();
  setupExtractionIPC();
  setupProxyIPC();
  setupFsIPC();
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

app.on("activate", () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});

// New window example arg: new windows url
ipcMain.handle("open-win", (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
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
