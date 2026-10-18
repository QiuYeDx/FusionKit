import { app, BrowserWindow, ipcMain, shell, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { SYSTEM_SETUP_CHANNELS, VC_REDIST_DOWNLOAD_URL, type GpuInfo, type VcRuntimeRepairResult, type VcRuntimeStatus } from "@/system-setup/contract";
import { detectGpu } from "./gpu";
import { MINIMUM_VC_RUNTIME_VERSION, VcRuntime } from "./vc-runtime";

export { detectGpu } from "./gpu";
export { VcRuntime } from "./vc-runtime";

/**
 * UI tests only (NODE_ENV=test in an unpackaged run): the VC++ runtime state to report ("ok", the
 * default, "missing" or "outdated"), so banners and the repair can be exercised without touching
 * the computer; the forced repair waits briefly and FUSIONKIT_TEST_VC_REPAIR picks its outcome
 * (default "installed"). "real" reads this computer's registry and never repairs.
 */
export const TEST_VC_RUNTIME_ENV = "FUSIONKIT_TEST_VC_RUNTIME";
export const TEST_VC_REPAIR_ENV = "FUSIONKIT_TEST_VC_REPAIR";
/** UI tests only (NODE_ENV=test): "none", "nvidia" or "nvidia_old_driver". */
export const TEST_GPU_ENV = "FUSIONKIT_TEST_GPU";

export interface SystemSetupService {
  vcRuntimeStatus(): Promise<VcRuntimeStatus>;
  repairVcRuntime(): Promise<VcRuntimeRepairResult>;
  detectGpu(refresh?: boolean): Promise<GpuInfo>;
}

export interface SetupSystemSetupOptions {
  /** The application's resources directory, where the Windows build ships vc-redist. */
  readonly resourcesPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** An installed build never honours the test switches, whatever its environment says (default app.isPackaged). */
  readonly packaged?: boolean;
  readonly ipc?: Pick<IpcMain, "handle">;
  readonly service?: SystemSetupService;
}

const TEST_VC_STATES = new Set(["ok", "missing", "outdated"]);
const TEST_REPAIR_OUTCOMES = new Set(["installed", "cancelled", "failed", "restart_required"]);

/**
 * The service under NODE_ENV=test, only when running unpackaged (a test build). A test run never
 * starts an installer or opens a page, and its windows look the same on every computer: the
 * runtime is "ok" and the graphics card "unknown" unless a test forces them. Only "real" reads
 * this computer's runtime; a repair then does nothing.
 */
export function createTestSystemSetup(env: NodeJS.ProcessEnv, options: { packaged?: boolean } = {}): SystemSetupService | undefined {
  if (env.NODE_ENV !== "test" || options.packaged) return undefined;
  const forced = env[TEST_VC_RUNTIME_ENV], gpu = env[TEST_GPU_ENV];
  let state: VcRuntimeStatus["status"] | undefined = forced === "real" ? undefined
    : forced && TEST_VC_STATES.has(forced) ? forced as VcRuntimeStatus["status"] : "ok";
  const real = new VcRuntime({ downloadUrl: VC_REDIST_DOWNLOAD_URL, openExternal: async () => undefined, runInstaller: async () => -1 });
  const status = (): VcRuntimeStatus => ({ status: state!, requiredVersion: MINIMUM_VC_RUNTIME_VERSION, bundled: true,
    ...(state === "outdated" ? { installedVersion: "14.29.30133" } : state === "ok" ? { installedVersion: "14.51.36247" } : {}) });
  const repair = env[TEST_VC_REPAIR_ENV] && TEST_REPAIR_OUTCOMES.has(env[TEST_VC_REPAIR_ENV]!) ? env[TEST_VC_REPAIR_ENV] as VcRuntimeRepairResult["outcome"] : "installed";
  return {
    vcRuntimeStatus: () => state ? Promise.resolve(status()) : real.status(),
    async repairVcRuntime() {
      if (!state) return { outcome: "failed", status: await real.status() };
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (repair === "installed" || repair === "restart_required") state = "ok";
      return { outcome: repair, exitCode: repair === "installed" ? 0 : repair === "restart_required" ? 3010 : repair === "cancelled" ? 1602 : 1603, status: status() };
    },
    async detectGpu() {
      if (gpu === "none") return { status: "detected", hasNvidia: false, driverOk: false, source: "windows" };
      if (gpu === "nvidia") return { status: "detected", hasNvidia: true, gpuName: "NVIDIA GeForce RTX 4060", driverVersion: "560.94", driverOk: true, source: "nvidia-smi" };
      if (gpu === "nvidia_old_driver") return { status: "detected", hasNvidia: true, gpuName: "NVIDIA GeForce GTX 1660", driverVersion: "531.79", driverOk: false, source: "nvidia-smi" };
      return { status: "unknown", hasNvidia: false, driverOk: false };
    },
  };
}

export function createSystemSetup(options: { resourcesPath?: string; env?: NodeJS.ProcessEnv } = {}): SystemSetupService {
  const runtime = new VcRuntime({ resourcesPath: options.resourcesPath, downloadUrl: VC_REDIST_DOWNLOAD_URL, openExternal: (url) => shell.openExternal(url) });
  let gpu: Promise<GpuInfo> | undefined;
  return {
    vcRuntimeStatus: () => runtime.status(),
    repairVcRuntime: () => runtime.repair(),
    detectGpu(refresh = false) {
      // The card does not change while the app runs; a refresh is for "check again".
      if (!gpu || refresh) gpu = detectGpu({ env: options.env }).catch(() => ({ status: "unknown", hasNvidia: false, driverOk: false }) as GpuInfo);
      return gpu;
    },
  };
}

export function setupSystemSetupIPC(options: SetupSystemSetupOptions = {}): SystemSetupService {
  const ipc = options.ipc ?? ipcMain;
  const env = options.env ?? process.env;
  const service = options.service ?? createTestSystemSetup(env, { packaged: options.packaged ?? app.isPackaged })
    ?? createSystemSetup({ resourcesPath: options.resourcesPath, env });
  ipc.handle(SYSTEM_SETUP_CHANNELS.vcRuntimeStatus, (event) => {
    assertTrusted(event);
    return service.vcRuntimeStatus();
  });
  ipc.handle(SYSTEM_SETUP_CHANNELS.repairVcRuntime, (event) => {
    assertTrusted(event);
    return service.repairVcRuntime();
  });
  ipc.handle(SYSTEM_SETUP_CHANNELS.gpu, (event, input: unknown) => {
    assertTrusted(event);
    const refresh = !!input && typeof input === "object" && (input as { refresh?: unknown }).refresh === true;
    return service.detectGpu(refresh);
  });
  return service;
}

/** Only the application's own windows, from their main frame, may start an installer. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("System setup is only available to the application window.");
  }
}
