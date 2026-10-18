import { execFile } from "node:child_process";
import path from "node:path";
import { NVIDIA_MINIMUM_DRIVER, type GpuInfo } from "@/system-setup/contract";

/**
 * Whether this Windows computer has an NVIDIA graphics card that the CUDA acceleration pack can
 * use: nvidia-smi (installed with the driver) first, then the display adapters Windows lists.
 */
const COMMAND_TIMEOUT_MS = 5_000;

export type RunCommand = (file: string, args: readonly string[]) => Promise<string>;

export function runCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

function driverParts(value: string): [number, number] | undefined {
  const match = /^(\d{2,4})\.(\d{1,3})$/u.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function nvidiaDriverAtLeast(version: string | undefined, minimum = NVIDIA_MINIMUM_DRIVER): boolean {
  const actual = version ? driverParts(version) : undefined;
  const required = driverParts(minimum)!;
  return !!actual && (actual[0] - required[0] || actual[1] - required[1]) >= 0;
}

/** `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader`: one "name, version" line per card. */
export function parseNvidiaSmi(output: string): { gpuName: string; driverVersion?: string } | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.lastIndexOf(",");
    if (separator <= 0) continue;
    const gpuName = line.slice(0, separator).trim();
    const driverVersion = line.slice(separator + 1).trim();
    if (gpuName) return { gpuName, ...(driverParts(driverVersion) ? { driverVersion } : {}) };
  }
  return undefined;
}

/**
 * Windows reports NVIDIA drivers as e.g. 32.0.15.6110; the last five digits are NVIDIA's own
 * version (561.10).
 */
export function nvidiaVersionFromWindowsDriver(value: string | undefined): string | undefined {
  const parts = (value ?? "").trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) return undefined;
  const digits = `${parts[2]}${parts[3]!.padStart(4, "0")}`.slice(-5);
  return digits.length === 5 ? `${Number(digits.slice(0, 3))}.${digits.slice(3)}` : undefined;
}

/** "Name|DriverVersion" lines of Win32_VideoController; the first NVIDIA adapter. */
export function parseVideoControllers(output: string): { gpuName: string; driverVersion?: string } | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const [name, driver] = line.split("|");
    const gpuName = name?.trim();
    if (!gpuName || !/nvidia/iu.test(gpuName)) continue;
    const driverVersion = nvidiaVersionFromWindowsDriver(driver);
    return { gpuName, ...(driverVersion ? { driverVersion } : {}) };
  }
  return undefined;
}

export interface DetectGpuOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: RunCommand;
}

function detected(found: { gpuName: string; driverVersion?: string }, source: GpuInfo["source"]): GpuInfo {
  return { status: "detected", hasNvidia: true, ...found, driverOk: nvidiaDriverAtLeast(found.driverVersion), source };
}

export async function detectGpu(options: DetectGpuOptions = {}): Promise<GpuInfo> {
  if ((options.platform ?? process.platform) !== "win32") return { status: "not_applicable", hasNvidia: false, driverOk: false };
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const windows = env.SystemRoot || env.windir || "C:\\Windows";
  const smiCandidates = [path.join(windows, "System32", "nvidia-smi.exe"),
    path.join(env.ProgramW6432 || env.ProgramFiles || "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")];
  for (const smi of smiCandidates) {
    try {
      const found = parseNvidiaSmi(await run(smi, ["--query-gpu=name,driver_version", "--format=csv,noheader"]));
      if (found) return detected(found, "nvidia-smi");
    } catch { /* No driver tool here, or it failed: ask Windows. */ }
  }
  try {
    const powershell = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name)|$($_.DriverVersion)\" }"]);
    const found = parseVideoControllers(output);
    return found ? detected(found, "windows") : { status: "detected", hasNvidia: false, driverOk: false, source: "windows" };
  } catch {
    return { status: "unknown", hasNvidia: false, driverOk: false };
  }
}
