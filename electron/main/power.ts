import { BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker } from "electron";

/**
 * 在主进程注册电源管理相关 IPC：
 * - power-blocker-start: 开启防睡眠，支持传 untilEpochMs 到期自动取消
 * - power-blocker-stop: 停止指定 blockerId
 * 同时监听系统唤醒并广播 'system-resumed' 到渲染进程
 */
export function setupPowerIPC(win: BrowserWindow | null) {
  const timers = new Map<number, NodeJS.Timeout>();

  ipcMain.handle(
    "power-blocker-start",
    async (
      _,
      args: { type?: "prevent-app-suspension" | "prevent-display-sleep"; untilEpochMs?: number }
    ) => {
      const type = args?.type || "prevent-app-suspension";
      const id = powerSaveBlocker.start(type);

      // 如果提供了到期时间，则到期后自动停止
      if (typeof args?.untilEpochMs === "number") {
        const delay = Math.max(0, Math.floor(args.untilEpochMs - Date.now()));
        const t = setTimeout(() => {
          try {
            if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
          } catch {}
          timers.delete(id);
        }, delay);
        timers.set(id, t);
      }

      return { id };
    }
  );

  ipcMain.handle("power-blocker-stop", async (_, id: number) => {
    try {
      if (timers.has(id)) {
        clearTimeout(timers.get(id)!);
        timers.delete(id);
      }
      if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      return { stopped: true };
    } catch (e) {
      return { stopped: false, error: (e as Error)?.message };
    }
  });

  // 系统从睡眠/休眠恢复
  powerMonitor.on("resume", () => {
    try {
      win?.webContents.send("system-resumed");
    } catch {}
  });

  // 屏幕解锁也可以视为恢复
  powerMonitor.on("unlock-screen", () => {
    try {
      win?.webContents.send("system-resumed");
    } catch {}
  });
} 