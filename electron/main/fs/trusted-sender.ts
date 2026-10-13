import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMainInvokeEvent } from "electron";

type SenderEvent = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;

export interface TrustedSenderOptions {
  devServerUrl?: string;
  appRoot?: string;
}

/** True only for the app's own top-level page: the dev server origin, or dist/index.html. */
export function isTrustedAppSender(
  event: SenderEvent,
  options: TrustedSenderOptions = {},
): boolean {
  if (event.sender.isDestroyed()) return false;
  if (event.senderFrame?.parent) return false;

  const sourceUrl = event.senderFrame?.url || event.sender.getURL();
  if (!sourceUrl) return false;

  const devServerUrl = options.devServerUrl ?? process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    try {
      return new URL(sourceUrl).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }

  const appRoot = options.appRoot ?? process.env.APP_ROOT;
  if (!appRoot) return false;
  try {
    const source = new URL(sourceUrl);
    if (source.protocol !== "file:") return false;
    const expectedPath = path.resolve(appRoot, "dist", "index.html");
    const sourcePath = path.resolve(fileURLToPath(source));
    return normalizePathForComparison(sourcePath) ===
      normalizePathForComparison(expectedPath);
  } catch {
    return false;
  }
}

function normalizePathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
