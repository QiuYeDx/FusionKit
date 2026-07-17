import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ProcessMetricsMonitor {
  constructor(options) {
    this.options = {
      backend: "cpu",
      intervalMs: 1_000,
      execFileImpl: execFileAsync,
      powershellPath: defaultPowerShellPath(),
      nvidiaSmiPath: defaultNvidiaSmiPath(),
      ...options,
    };
    this.running = false;
    this.loopPromise = undefined;
    this.peakRamBytes = 0;
    this.peakVramBytes = 0;
    this.sampleCount = 0;
    this.lastProcessId = undefined;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.sampleLoop();
  }

  async stop() {
    this.running = false;
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  summary() {
    const isCuda = this.options.backend === "cuda";
    return {
      sampleCount: this.sampleCount,
      processIdObserved: this.lastProcessId,
      peakRamBytes: this.peakRamBytes || undefined,
      peakVramBytes: isCuda ? this.peakVramBytes : null,
      backendEvidence: isCuda
        ? "windows-gpu-process-memory-counter-with-nvidia-smi-fallback"
        : "official-server-no-gpu-flag",
      backendVerified: isCuda ? this.peakVramBytes > 0 : true,
    };
  }

  async sampleLoop() {
    while (this.running) {
      const started = performance.now();
      await this.sampleOnce();
      const elapsed = performance.now() - started;
      await delay(Math.max(25, this.options.intervalMs - elapsed));
    }
  }

  async sampleOnce() {
    const processId = this.options.processIdProvider?.();
    if (!Number.isInteger(processId) || processId <= 0) return;
    this.lastProcessId = processId;

    const processMetrics = await queryWindowsProcessMetrics({
      processId,
      includeGpu: this.options.backend === "cuda",
      powershellPath: this.options.powershellPath,
      execFileImpl: this.options.execFileImpl,
    });
    const ramBytes = processMetrics?.ramBytes;
    let vramBytes = processMetrics?.vramBytes;
    if (this.options.backend === "cuda" && vramBytes === undefined) {
      vramBytes = await queryNvidiaProcessVramBytes({
        processId,
        nvidiaSmiPath: this.options.nvidiaSmiPath,
        execFileImpl: this.options.execFileImpl,
      });
    }
    if (Number.isFinite(ramBytes)) {
      this.peakRamBytes = Math.max(this.peakRamBytes, ramBytes);
    }
    if (Number.isFinite(vramBytes)) {
      this.peakVramBytes = Math.max(this.peakVramBytes, vramBytes);
    }
    this.sampleCount += 1;
  }
}

export function parseNvidiaComputeApps(value, expectedProcessId) {
  const entries = String(value)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [pidText, memoryText] = line.split(",", 2).map((part) => part.trim());
      const processId = Number(pidText);
      const memoryMiB = Number(memoryText?.replace(/\s*MiB$/iu, ""));
      return Number.isInteger(processId) && Number.isFinite(memoryMiB)
        ? [{ processId, memoryBytes: Math.round(memoryMiB * 1024 * 1024) }]
        : [];
    });
  return entries
    .filter((entry) => entry.processId === expectedProcessId)
    .reduce((total, entry) => total + entry.memoryBytes, 0);
}

export function parseWindowsProcessMetrics(value, includeGpu) {
  const [ramText, vramText] = String(value).trim().split(",", 2);
  const ramBytes = Number(ramText);
  const vramBytes = Number(vramText);
  if (!Number.isFinite(ramBytes) || ramBytes < 0) return undefined;
  return {
    ramBytes,
    vramBytes: includeGpu && Number.isFinite(vramBytes) && vramBytes >= 0
      ? vramBytes
      : undefined,
  };
}

async function queryWindowsProcessMetrics(options) {
  const gpuCommand = options.includeGpu
    ? `$prefix = 'pid_${options.processId}_'; ` +
      "$gpuSamples = @((Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | " +
      "Where-Object { $_.InstanceName.StartsWith($prefix) }); " +
      "$gpu = $gpuSamples | Measure-Object CookedValue -Sum; " +
      "$gpuBytes = if ($gpuSamples.Count -eq 0) { -1 } else { [long]$gpu.Sum }; "
    : "$gpuBytes = 0; ";
  const command =
    `$p = Get-Process -Id ${options.processId} -ErrorAction SilentlyContinue; ` +
    "if ($null -ne $p) { " +
    gpuCommand +
    "[Console]::Out.Write(('{0},{1}' -f [long]$p.WorkingSet64, $gpuBytes)) }";
  try {
    const { stdout } = await options.execFileImpl(
      options.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    return parseWindowsProcessMetrics(stdout, options.includeGpu);
  } catch {
    return undefined;
  }
}

async function queryNvidiaProcessVramBytes(options) {
  try {
    const { stdout } = await options.execFileImpl(
      options.nvidiaSmiPath,
      [
        "--query-compute-apps=pid,used_gpu_memory",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024 },
    );
    return parseNvidiaComputeApps(stdout, options.processId);
  } catch {
    return undefined;
  }
}

function defaultPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function defaultNvidiaSmiPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "nvidia-smi.exe");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
