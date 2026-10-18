import { statfs } from "node:fs/promises";
import { app, BrowserWindow, ipcMain, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { MODEL_SETUP_CHANNELS, type ModelSetupLaunchConfig } from "@/model-setup/contract";
import { testModelConnection } from "./connection-test";

export { testModelConnection } from "./connection-test";

/** Set to 1 by a UI test that exercises the welcome wizard; every other test launch keeps it closed. */
export const TEST_ONBOARDING_ENV = "FUSIONKIT_TEST_ONBOARDING";
/** Every automated UI launch has this (vitest.config.ts sets it), dev-renderer tests with NODE_ENV=development included. */
export const TEST_WINDOW_ENV = "FUSIONKIT_TEST_WINDOW";
/** UI tests only (NODE_ENV=test in an unpackaged run): a loopback DeepSeek-compatible server the wizard uses instead of the official address. */
export const TEST_DEEPSEEK_BASE_URL_ENV = "FUSIONKIT_TEST_DEEPSEEK_BASE_URL";

export interface SetupModelSetupOptions {
  /** Where local resources are kept; its drive's free space is shown in the wizard. */
  readonly resourceDirectory: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly ipc?: Pick<IpcMain, "handle">;
  /** An installed build never honours the test-only switches, whatever its environment says (default app.isPackaged). */
  readonly packaged?: boolean;
}

export function setupModelSetupIPC(options: SetupModelSetupOptions): void {
  const ipc = options.ipc ?? ipcMain;
  const env = options.env ?? process.env;
  ipc.handle(MODEL_SETUP_CHANNELS.testConnection, (event, input: unknown) => {
    assertTrusted(event);
    return testModelConnection(input);
  });
  ipc.handle(MODEL_SETUP_CHANNELS.launchConfig, (event) => {
    assertTrusted(event);
    return resolveModelSetupLaunchConfig(env, { packaged: options.packaged ?? app.isPackaged });
  });
  ipc.handle(MODEL_SETUP_CHANNELS.freeDiskSpace, (event) => {
    assertTrusted(event);
    return readFreeDiskSpace(options.resourceDirectory());
  });
}

/**
 * The wizard opens by itself for users who have nothing set up. Automated UI tests start with an
 * empty profile too, so under NODE_ENV=test, or in any launch from the test runner (also those
 * against a dev server), it stays closed unless a test asks for it. An installed build is never a
 * test build: NODE_ENV=test does not count there, so the wizard's key can never be sent to a
 * test server's address.
 */
export function resolveModelSetupLaunchConfig(env: NodeJS.ProcessEnv, options: { readonly packaged?: boolean } = {}): ModelSetupLaunchConfig {
  const test = env.NODE_ENV === "test" && !options.packaged;
  const automated = test || !!env[TEST_WINDOW_ENV] || env[TEST_ONBOARDING_ENV] === "0";
  if (env[TEST_ONBOARDING_ENV] !== "1") return { onboarding: automated ? "off" : "auto" };
  const deepseekBaseUrl = test ? loopbackHttpUrl(env[TEST_DEEPSEEK_BASE_URL_ENV]) : undefined;
  return { onboarding: "forced", ...(deepseekBaseUrl ? { deepseekBaseUrl } : {}) };
}

function loopbackHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host === "::1") ? url.href.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

export async function readFreeDiskSpace(directory: string): Promise<number | null> {
  try {
    const stats = await statfs(directory);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isSafeInteger(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/** Only the application's own windows, from their main frame, may send a key to be tested. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Model setup is only available to the application window.");
  }
}
