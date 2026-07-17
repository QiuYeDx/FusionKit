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
      platform: process.platform,
      psPath: "/bin/ps",
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
    this.metalEvidence = emptyMetalBackendEvidence();
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
    const isMetal = this.options.backend === "metal";
    return {
      sampleCount: this.sampleCount,
      processIdObserved: this.lastProcessId,
      peakRamBytes: this.peakRamBytes || undefined,
      peakVramBytes: isCuda ? this.peakVramBytes : null,
      backendEvidence: isCuda
        ? "windows-gpu-process-memory-counter-with-nvidia-smi-fallback"
        : isMetal
          ? "bounded-whisper-server-metal-initialization-diagnostics"
          : "official-server-no-gpu-flag",
      ...(isMetal ? { backendEvidenceDetails: this.metalEvidence } : {}),
      backendVerified: isCuda
        ? this.peakVramBytes > 0
        : isMetal
          ? this.metalEvidence.backendVerified
          : true,
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

    const processMetrics = this.options.platform === "win32"
      ? await queryWindowsProcessMetrics({
        processId,
        includeGpu: this.options.backend === "cuda",
        powershellPath: this.options.powershellPath,
        execFileImpl: this.options.execFileImpl,
      })
      : await queryPosixProcessMetrics({
        processId,
        psPath: this.options.psPath,
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
    if (this.options.backend === "metal") {
      this.metalEvidence = mergeMetalBackendEvidence(
        this.metalEvidence,
        parseMetalBackendDiagnostics(this.options.diagnosticsProvider?.()),
      );
    }
    this.sampleCount += 1;
  }
}

export function parsePosixProcessRssBytes(value) {
  const rssKiB = Number(String(value).trim());
  return Number.isFinite(rssKiB) && rssKiB >= 0
    ? Math.round(rssKiB * 1024)
    : undefined;
}

export function parseMetalBackendDiagnostics(value) {
  const text = typeof value === "string"
    ? value
    : `${value?.stdout ?? ""}\n${value?.stderr ?? ""}`;
  const initializationObserved =
    /(?:ggml_metal_init|ggml_backend_metal_(?:device_)?init)/iu.test(text);
  const deviceObserved =
    /(?:found device|GPU name|using Metal backend|Metal device)/iu.test(text);
  const failureObserved =
    /(?:Metal[^\n]*(?:failed|unavailable|disabled)|failed[^\n]*Metal)/iu.test(text);
  return {
    initializationObserved,
    deviceObserved,
    failureObserved,
    backendVerified:
      initializationObserved && deviceObserved && !failureObserved,
  };
}

export function mergeMetalBackendEvidence(previous, current) {
  const initializationObserved = Boolean(
    previous?.initializationObserved || current?.initializationObserved,
  );
  const deviceObserved = Boolean(
    previous?.deviceObserved || current?.deviceObserved,
  );
  const failureObserved = Boolean(
    previous?.failureObserved || current?.failureObserved,
  );
  return {
    initializationObserved,
    deviceObserved,
    failureObserved,
    backendVerified:
      initializationObserved && deviceObserved && !failureObserved,
  };
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

async function queryPosixProcessMetrics(options) {
  try {
    const { stdout } = await options.execFileImpl(
      options.psPath,
      ["-o", "rss=", "-p", String(options.processId)],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    const ramBytes = parsePosixProcessRssBytes(stdout);
    return Number.isFinite(ramBytes) ? { ramBytes } : undefined;
  } catch {
    return undefined;
  }
}

function emptyMetalBackendEvidence() {
  return {
    initializationObserved: false,
    deviceObserved: false,
    failureObserved: false,
    backendVerified: false,
  };
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
