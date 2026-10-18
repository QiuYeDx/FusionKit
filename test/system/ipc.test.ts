import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ windows: new Set<unknown>(), opened: [] as string[] }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: async (url: string) => { electron.opened.push(url); } },
  BrowserWindow: { fromWebContents: (contents: unknown) => (electron.windows.has(contents) ? {} : null) },
}));

import { SYSTEM_SETUP_CHANNELS } from "../../src/system-setup/contract";
import { createTestSystemSetup, setupSystemSetupIPC, type SystemSetupService } from "../../electron/main/system";
import { assertLegacySystemSetupChannelAllowed, createSystemSetupApi } from "../../electron/preload/system-setup-api";

function setup(options: { env?: NodeJS.ProcessEnv; service?: SystemSetupService } = {}) {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  setupSystemSetupIPC({ ...options, ipc: { handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) => { handlers.set(channel, handler); }) } as never });
  const contents = { mainFrame: {} };
  electron.windows.add(contents);
  return { handlers, trusted: { sender: contents, senderFrame: contents.mainFrame } };
}

describe("system setup IPC", () => {
  it("serves the application window and refuses other senders", async () => {
    const service: SystemSetupService = {
      vcRuntimeStatus: vi.fn(async () => ({ status: "missing" as const, requiredVersion: "14.52.36500", bundled: true })),
      repairVcRuntime: vi.fn(async () => ({ outcome: "installed" as const, exitCode: 0, status: { status: "ok" as const, bundled: true } })),
      detectGpu: vi.fn(async () => ({ status: "detected" as const, hasNvidia: false, driverOk: false })),
    };
    const { handlers, trusted } = setup({ service });
    expect([...handlers.keys()].sort()).toEqual(Object.values(SYSTEM_SETUP_CHANNELS).sort());
    expect(await handlers.get(SYSTEM_SETUP_CHANNELS.vcRuntimeStatus)!(trusted)).toMatchObject({ status: "missing" });
    expect(await handlers.get(SYSTEM_SETUP_CHANNELS.repairVcRuntime)!(trusted)).toMatchObject({ outcome: "installed" });
    await handlers.get(SYSTEM_SETUP_CHANNELS.gpu)!(trusted, { refresh: true });
    await handlers.get(SYSTEM_SETUP_CHANNELS.gpu)!(trusted, { refresh: "yes" });
    expect(service.detectGpu).toHaveBeenNthCalledWith(1, true);
    expect(service.detectGpu).toHaveBeenNthCalledWith(2, false);
    const stranger = { sender: { mainFrame: {} }, senderFrame: {} };
    for (const channel of Object.values(SYSTEM_SETUP_CHANNELS)) expect(() => handlers.get(channel)!(stranger, {})).toThrow("only available");
    expect(() => handlers.get(SYSTEM_SETUP_CHANNELS.repairVcRuntime)!({ sender: trusted.sender, senderFrame: {} })).toThrow("only available");
    expect(service.repairVcRuntime).toHaveBeenCalledTimes(1);
  });

  it("lets only UI tests force the runtime and graphics card, and never starts an installer for them", async () => {
    expect(createTestSystemSetup({ NODE_ENV: "production", FUSIONKIT_TEST_VC_RUNTIME: "missing" })).toBeUndefined();
    expect(createTestSystemSetup({})).toBeUndefined();
    // An installed build ignores the switches even when the computer has NODE_ENV=test set.
    expect(createTestSystemSetup({ NODE_ENV: "test", FUSIONKIT_TEST_VC_RUNTIME: "missing" }, { packaged: true })).toBeUndefined();
    const realService: SystemSetupService = { vcRuntimeStatus: vi.fn(), repairVcRuntime: vi.fn(), detectGpu: vi.fn() };
    expect(setupSystemSetupIPC({ env: { NODE_ENV: "test" }, packaged: true, service: realService, ipc: { handle: vi.fn() } as never })).toBe(realService);
    // Unforced test runs look the same on every computer: the runtime is fine and the card unknown.
    for (const value of [undefined, "broken"]) {
      const plain = createTestSystemSetup({ NODE_ENV: "test", ...(value ? { FUSIONKIT_TEST_VC_RUNTIME: value } : {}) })!;
      expect(await plain.vcRuntimeStatus()).toEqual({ status: "ok", installedVersion: "14.51.36247", requiredVersion: "14.51.36247", bundled: true });
      expect(await plain.detectGpu()).toEqual({ status: "unknown", hasNvidia: false, driverOk: false });
    }
    // "real" reads this computer's runtime but never repairs it.
    const real = createTestSystemSetup({ NODE_ENV: "test", FUSIONKIT_TEST_VC_RUNTIME: "real" })!;
    expect(["ok", "missing", "outdated", "unknown", "not_applicable"]).toContain((await real.vcRuntimeStatus()).status);
    expect(await real.repairVcRuntime()).toMatchObject({ outcome: "failed" });
    const forced = createTestSystemSetup({ NODE_ENV: "test", FUSIONKIT_TEST_VC_RUNTIME: "missing", FUSIONKIT_TEST_GPU: "nvidia_old_driver" })!;
    expect(await forced.vcRuntimeStatus()).toEqual({ status: "missing", requiredVersion: "14.51.36247", bundled: true });
    expect(await forced.detectGpu()).toMatchObject({ hasNvidia: true, driverVersion: "531.79", driverOk: false });
    expect(await forced.repairVcRuntime()).toMatchObject({ outcome: "installed", status: { status: "ok" } });
    expect(await forced.vcRuntimeStatus()).toMatchObject({ status: "ok" });
    const declined = createTestSystemSetup({ NODE_ENV: "test", FUSIONKIT_TEST_VC_RUNTIME: "outdated", FUSIONKIT_TEST_VC_REPAIR: "cancelled" })!;
    expect(await declined.repairVcRuntime()).toMatchObject({ outcome: "cancelled", exitCode: 1602, status: { status: "outdated", installedVersion: "14.29.30133" } });
    expect(await createTestSystemSetup({ NODE_ENV: "test", FUSIONKIT_TEST_GPU: "none" })!.detectGpu()).toMatchObject({ hasNvidia: false });
    expect(electron.opened).toEqual([]);
  });

  it("exposes fixed methods in the preload and keeps the raw channels away from the legacy bridge", async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => "answer");
    const api = createSystemSetupApi({ invoke });
    await api.getVcRuntimeStatus();
    await api.repairVcRuntime();
    await api.detectGpu();
    await api.detectGpu({ refresh: true });
    expect(invoke.mock.calls).toEqual([[SYSTEM_SETUP_CHANNELS.vcRuntimeStatus], [SYSTEM_SETUP_CHANNELS.repairVcRuntime],
      [SYSTEM_SETUP_CHANNELS.gpu, { refresh: false }], [SYSTEM_SETUP_CHANNELS.gpu, { refresh: true }]]);
    expect(Object.isFrozen(api)).toBe(true);
    for (const channel of Object.values(SYSTEM_SETUP_CHANNELS)) expect(() => assertLegacySystemSetupChannelAllowed(channel)).toThrow("restricted");
    expect(() => assertLegacySystemSetupChannelAllowed("other:channel")).not.toThrow();
  });
});
