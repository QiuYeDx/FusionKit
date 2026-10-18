import os from "node:os";
import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ windows: new Set<unknown>() }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: (contents: unknown) => (electron.windows.has(contents) ? {} : null) },
}));

import { MODEL_SETUP_CHANNELS } from "../../src/model-setup/contract";
import {
  readFreeDiskSpace,
  resolveModelSetupLaunchConfig,
  setupModelSetupIPC,
} from "../../electron/main/model-setup";
import { assertLegacyModelSetupChannelAllowed, createModelSetupApi } from "../../electron/preload/model-setup-api";

function setup(env: NodeJS.ProcessEnv = {}) {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  setupModelSetupIPC({
    resourceDirectory: () => os.tmpdir(),
    env,
    ipc: { handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => { handlers.set(channel, handler); }) } as never,
  });
  const contents = { mainFrame: {} };
  electron.windows.add(contents);
  return { handlers, trusted: { sender: contents, senderFrame: contents.mainFrame } };
}

describe("model setup IPC", () => {
  it("keeps the welcome wizard closed in UI tests unless a test asks for it", () => {
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "production" })).toEqual({ onboarding: "auto" });
    expect(resolveModelSetupLaunchConfig({})).toEqual({ onboarding: "auto" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "test" })).toEqual({ onboarding: "off" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "test", FUSIONKIT_TEST_ONBOARDING: "1" })).toEqual({ onboarding: "forced" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "test", FUSIONKIT_TEST_ONBOARDING: "true" })).toEqual({ onboarding: "off" });
    // Launches from the test runner against a dev server run with NODE_ENV=development.
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "development", FUSIONKIT_TEST_WINDOW: "quiet" })).toEqual({ onboarding: "off" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "development", FUSIONKIT_TEST_ONBOARDING: "0" })).toEqual({ onboarding: "off" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "development" })).toEqual({ onboarding: "auto" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "development", FUSIONKIT_TEST_WINDOW: "quiet", FUSIONKIT_TEST_ONBOARDING: "1" })).toEqual({ onboarding: "forced" });
  });

  it("lets only a test point the wizard's DeepSeek preset at a loopback server", () => {
    const forced = { FUSIONKIT_TEST_ONBOARDING: "1", FUSIONKIT_TEST_DEEPSEEK_BASE_URL: "http://127.0.0.1:4321/v1/" };
    expect(resolveModelSetupLaunchConfig({ ...forced, NODE_ENV: "test" })).toEqual({ onboarding: "forced", deepseekBaseUrl: "http://127.0.0.1:4321/v1" });
    // Outside tests, or to another host, the official address stays.
    expect(resolveModelSetupLaunchConfig({ ...forced, NODE_ENV: "production" })).toEqual({ onboarding: "forced" });
    expect(resolveModelSetupLaunchConfig({ ...forced, NODE_ENV: "test", FUSIONKIT_TEST_DEEPSEEK_BASE_URL: "http://evil.example/v1" })).toEqual({ onboarding: "forced" });
    expect(resolveModelSetupLaunchConfig({ ...forced, NODE_ENV: "test", FUSIONKIT_TEST_DEEPSEEK_BASE_URL: "https://127.0.0.1/v1" })).toEqual({ onboarding: "forced" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "test", FUSIONKIT_TEST_DEEPSEEK_BASE_URL: "http://127.0.0.1:4321/v1" })).toEqual({ onboarding: "off" });
    // An installed build never takes the test address, whatever its environment says.
    expect(resolveModelSetupLaunchConfig({ ...forced, NODE_ENV: "test" }, { packaged: true })).toEqual({ onboarding: "forced" });
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "test" }, { packaged: true })).toEqual({ onboarding: "auto" });
    // Quiet automated launches of an installed build (the packaged smoke test) still keep the wizard closed.
    expect(resolveModelSetupLaunchConfig({ NODE_ENV: "test", FUSIONKIT_TEST_WINDOW: "quiet" }, { packaged: true })).toEqual({ onboarding: "off" });
  });

  it("serves an installed build's launch config without the test switches", async () => {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    setupModelSetupIPC({
      resourceDirectory: () => os.tmpdir(),
      env: { NODE_ENV: "test", FUSIONKIT_TEST_ONBOARDING: "1", FUSIONKIT_TEST_DEEPSEEK_BASE_URL: "http://127.0.0.1:4321/v1" },
      packaged: true,
      ipc: { handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => { handlers.set(channel, handler); }) } as never,
    });
    const contents = { mainFrame: {} };
    electron.windows.add(contents);
    expect(await handlers.get(MODEL_SETUP_CHANNELS.launchConfig)!({ sender: contents, senderFrame: contents.mainFrame })).toEqual({ onboarding: "forced" });
  });

  it("serves the application window and refuses other senders", async () => {
    const { handlers, trusted } = setup({ NODE_ENV: "test" });
    expect([...handlers.keys()].sort()).toEqual(Object.values(MODEL_SETUP_CHANNELS).sort());
    expect(await handlers.get(MODEL_SETUP_CHANNELS.launchConfig)!(trusted)).toEqual({ onboarding: "off" });
    const free = await handlers.get(MODEL_SETUP_CHANNELS.freeDiskSpace)!(trusted);
    expect(typeof free).toBe("number");
    expect(await handlers.get(MODEL_SETUP_CHANNELS.testConnection)!(trusted, { baseUrl: "https://api.deepseek.com/v1", apiFormat: "chat_completions", modelKey: "deepseek-v4-flash", apiKey: "" }))
      .toMatchObject({ ok: false, category: "auth" });
    const stranger = { sender: { mainFrame: {} }, senderFrame: {} };
    for (const channel of Object.values(MODEL_SETUP_CHANNELS)) {
      expect(() => handlers.get(channel)!(stranger, {})).toThrow("only available");
    }
    const subframe = { sender: trusted.sender, senderFrame: {} };
    expect(() => handlers.get(MODEL_SETUP_CHANNELS.testConnection)!(subframe, {})).toThrow("only available");
  });

  it("reads free space and gives up quietly where it cannot", async () => {
    expect(await readFreeDiskSpace(os.tmpdir())).toBeGreaterThan(0);
    expect(await readFreeDiskSpace("Z:\\definitely\\missing\\fusionkit")).toBeNull();
  });

  it("exposes fixed methods in the preload and keeps the raw channels away from the legacy bridge", async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => "answer");
    const api = createModelSetupApi({ invoke });
    await api.testConnection({ baseUrl: "b", apiFormat: "chat_completions", modelKey: "m", apiKey: "k" });
    await api.getLaunchConfig();
    await api.getFreeDiskSpace();
    expect(invoke.mock.calls).toEqual([
      [MODEL_SETUP_CHANNELS.testConnection, { baseUrl: "b", apiFormat: "chat_completions", modelKey: "m", apiKey: "k" }],
      [MODEL_SETUP_CHANNELS.launchConfig],
      [MODEL_SETUP_CHANNELS.freeDiskSpace],
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(() => assertLegacyModelSetupChannelAllowed(MODEL_SETUP_CHANNELS.testConnection)).toThrow("restricted");
    expect(() => assertLegacyModelSetupChannelAllowed("show-item-in-folder")).not.toThrow();
  });
});
