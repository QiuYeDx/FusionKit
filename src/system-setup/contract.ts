/**
 * What local transcription needs from this computer, read by the main process: Microsoft's VC++
 * runtime on Windows (with a one-click repair), and whether an NVIDIA graphics card can use the
 * CUDA acceleration pack.
 */
export const SYSTEM_SETUP_CHANNEL_PREFIX = "system-setup:";
export const SYSTEM_SETUP_CHANNELS = {
  vcRuntimeStatus: "system-setup:vc-runtime-status",
  repairVcRuntime: "system-setup:vc-runtime-repair",
  gpu: "system-setup:gpu",
} as const;

/** Microsoft's permanent link to the current x64 VC++ redistributable, for builds that do not ship it. */
export const VC_REDIST_DOWNLOAD_URL = "https://aka.ms/vc14/vc_redist.x64.exe";
/** NVIDIA's driver search page (mainland China site, reachable without a proxy). */
export const NVIDIA_DRIVER_URL = "https://www.nvidia.cn/drivers/lookup/";
const NVIDIA_DRIVER_URLS: Readonly<Record<string, string>> = {
  "zh-Hant": "https://www.nvidia.com/zh-tw/drivers/",
  en: "https://www.nvidia.com/en-us/drivers/",
  ja: "https://www.nvidia.com/ja-jp/drivers/",
};
/** The driver page in the interface language; Simplified Chinese (and anything unknown) keeps the mainland China site. */
export function nvidiaDriverUrl(language: string | undefined): string {
  return (language && NVIDIA_DRIVER_URLS[language]) || NVIDIA_DRIVER_URL;
}
/** The CUDA 12.4 pack needs at least this Windows driver. */
export const NVIDIA_MINIMUM_DRIVER = "551.61";

/**
 * "ok" the runtime is installed and not older than the oldest one the transcription programs can
 * use (requiredVersion), "missing" not installed, "outdated" older, "not_applicable" not Windows;
 * "unknown" when it could not be read.
 */
export type VcRuntimeState = "ok" | "missing" | "outdated" | "not_applicable" | "unknown";

export interface VcRuntimeStatus {
  readonly status: VcRuntimeState;
  /** Like "14.51.36247". */
  readonly installedVersion?: string;
  readonly requiredVersion?: string;
  /** Whether this build ships the installer; without it the repair opens Microsoft's download. */
  readonly bundled: boolean;
}

/**
 * How a repair ended: installed (or a newer one was already there), installed but the computer
 * needs a restart, the confirmation was declined, the installer failed, the download page was
 * opened (no bundled installer), or another repair is already running.
 */
export type VcRuntimeRepairOutcome = "installed" | "restart_required" | "cancelled" | "failed" | "opened_download" | "not_applicable" | "busy";

export interface VcRuntimeRepairResult {
  readonly outcome: VcRuntimeRepairOutcome;
  readonly exitCode?: number;
  /** Checked again after the installer finished. */
  readonly status: VcRuntimeStatus;
}

export interface GpuInfo {
  /** "not_applicable" off Windows, "unknown" when neither nvidia-smi nor Windows could tell. */
  readonly status: "detected" | "not_applicable" | "unknown";
  readonly hasNvidia: boolean;
  readonly gpuName?: string;
  /** Like "551.61". */
  readonly driverVersion?: string;
  /** At least NVIDIA_MINIMUM_DRIVER; false when the version is unknown. */
  readonly driverOk: boolean;
  readonly source?: "nvidia-smi" | "windows";
}

export interface SystemSetupApi {
  getVcRuntimeStatus(): Promise<VcRuntimeStatus>;
  /** Runs the bundled installer (Windows asks for confirmation), then checks again. */
  repairVcRuntime(): Promise<VcRuntimeRepairResult>;
  detectGpu(options?: { refresh?: boolean }): Promise<GpuInfo>;
}
