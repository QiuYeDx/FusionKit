import { execFile } from "node:child_process";
import path from "node:path";
import type { LocalSubtitleBackend } from "@/type/localSubtitle";
import {
  waitForLocalSubtitleMetalBackendEvidence,
  type LocalSubtitleServerBackendAttestation,
  type LocalSubtitleServerBackendAttestationContext,
  type LocalSubtitleServerSupervisorDependencies,
} from "./server-supervisor";

export const LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY = Object.freeze({
  metalEvidenceGraceMs: 1_000,
  // Windows performance counters have a multi-second cold start on otherwise
  // healthy hosts. Keep each native probe bounded inside a larger evidence gate.
  cudaEvidenceGraceMs: 10_000,
  cudaPollIntervalMs: 250,
  cudaProbeTimeoutMs: 5_000,
  cudaProbeMaxOutputBytes: 64 * 1024,
} as const);

export interface LocalSubtitleCudaProcessMemoryProbeOptions {
  readonly processId: number;
  readonly signal: AbortSignal;
}

export type LocalSubtitleCudaProcessMemoryProbe = (
  options: LocalSubtitleCudaProcessMemoryProbeOptions,
) => Promise<number | undefined>;

export interface LocalSubtitleProductionBackendAttestor {
  readonly supportedBackends: readonly Exclude<LocalSubtitleBackend, "cpu">[];
  readonly verifyBackend: NonNullable<
    LocalSubtitleServerSupervisorDependencies["verifyBackend"]
  >;
}

export function createLocalSubtitleProductionBackendAttestor(options: {
  readonly platform?: NodeJS.Platform | string;
  readonly arch?: string;
  readonly metalEvidenceGraceMs?: number;
  readonly cudaEvidenceGraceMs?: number;
  readonly cudaPollIntervalMs?: number;
  readonly cudaProcessMemoryProbe?: LocalSubtitleCudaProcessMemoryProbe;
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
} = {}): LocalSubtitleProductionBackendAttestor {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const metalEvidenceGraceMs = options.metalEvidenceGraceMs ??
    LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.metalEvidenceGraceMs;
  const cudaEvidenceGraceMs = options.cudaEvidenceGraceMs ??
    LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.cudaEvidenceGraceMs;
  const cudaPollIntervalMs = options.cudaPollIntervalMs ??
    LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.cudaPollIntervalMs;
  if (
    !Number.isSafeInteger(metalEvidenceGraceMs) ||
    metalEvidenceGraceMs < 1 ||
    metalEvidenceGraceMs > 10_000
  ) {
    throw new TypeError("The Metal backend evidence grace period is invalid.");
  }
  if (
    !Number.isSafeInteger(cudaEvidenceGraceMs) ||
    cudaEvidenceGraceMs < 1 ||
    cudaEvidenceGraceMs > 10_000 ||
    !Number.isSafeInteger(cudaPollIntervalMs) ||
    cudaPollIntervalMs < 1 ||
    cudaPollIntervalMs > cudaEvidenceGraceMs ||
    (options.cudaProcessMemoryProbe !== undefined &&
      typeof options.cudaProcessMemoryProbe !== "function")
  ) {
    throw new TypeError("The CUDA backend evidence policy is invalid.");
  }
  const supportsMetal = platform === "darwin" && arch === "arm64";
  const cudaProcessMemoryProbe = options.cudaProcessMemoryProbe ??
    (platform === "win32" && arch === "x64"
      ? createWindowsCudaProcessMemoryProbe(options.sourceEnvironment ?? process.env)
      : undefined);
  const supportsCuda =
    platform === "win32" &&
    arch === "x64" &&
    cudaProcessMemoryProbe !== undefined;

  return Object.freeze({
    supportedBackends: Object.freeze([
      ...(supportsMetal ? ["metal" as const] : []),
      ...(supportsCuda ? ["cuda" as const] : []),
    ]),
    verifyBackend: async (
      context: Readonly<LocalSubtitleServerBackendAttestationContext>,
    ) =>
      verifyProductionBackend(context, {
        supportsMetal,
        metalEvidenceGraceMs,
        supportsCuda,
        cudaEvidenceGraceMs,
        cudaPollIntervalMs,
        cudaProcessMemoryProbe,
      }),
  });
}

async function verifyProductionBackend(
  context: Readonly<LocalSubtitleServerBackendAttestationContext>,
  options: Readonly<{
    supportsMetal: boolean;
    metalEvidenceGraceMs: number;
    supportsCuda: boolean;
    cudaEvidenceGraceMs: number;
    cudaPollIntervalMs: number;
    cudaProcessMemoryProbe?: LocalSubtitleCudaProcessMemoryProbe;
  }>,
): Promise<LocalSubtitleServerBackendAttestation> {
  if (context.backend === "metal" && options.supportsMetal) {
    await waitForLocalSubtitleMetalBackendEvidence(
      context.evidence,
      context,
      context.signal,
      options.metalEvidenceGraceMs,
    );
  } else if (
    context.backend === "cuda" &&
    options.supportsCuda &&
    options.cudaProcessMemoryProbe
  ) {
    if (
      typeof context.acceleratorResourceId !== "string" ||
      context.acceleratorResourceId.length === 0 ||
      !/^[a-f0-9]{64}$/u.test(context.acceleratorPackGeneration ?? "")
    ) {
      throw new Error("The CUDA accelerator generation identity is invalid.");
    }
    await waitForCudaProcessMemory(
      context.processId,
      context.signal,
      options.cudaProcessMemoryProbe,
      options.cudaEvidenceGraceMs,
      options.cudaPollIntervalMs,
    );
  } else {
    throw new Error("The selected GPU backend has no production attestor.");
  }
  if (context.signal.aborted) {
    throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  return Object.freeze({
    verified: true,
    processEpoch: context.processEpoch,
    processId: context.processId,
    backend: context.backend,
    runtimeGeneration: context.runtimeGeneration,
    serverArtifactId: context.serverArtifactId,
    ...(context.backend === "cuda"
      ? {
          acceleratorResourceId: context.acceleratorResourceId,
          acceleratorPackGeneration: context.acceleratorPackGeneration,
        }
      : {}),
  });
}

async function waitForCudaProcessMemory(
  processId: number,
  signal: AbortSignal,
  probe: LocalSubtitleCudaProcessMemoryProbe,
  graceMs: number,
  pollIntervalMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("The CUDA backend process id is invalid.");
  }
  const deadline = Date.now() + graceMs;
  do {
    throwIfAborted(signal);
    const bytes = await probe({ processId, signal });
    throwIfAborted(signal);
    if (Number.isSafeInteger(bytes) && (bytes ?? 0) > 0) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delayWithSignal(Math.min(pollIntervalMs, remaining), signal);
  } while (Date.now() <= deadline);
  throw new Error("The exact CUDA process did not expose positive GPU memory.");
}

function createWindowsCudaProcessMemoryProbe(
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
): LocalSubtitleCudaProcessMemoryProbe | undefined {
  const systemRoot = safeAbsoluteWindowsPath(
    sourceEnvironment.SystemRoot ?? sourceEnvironment.WINDIR,
  );
  if (!systemRoot) return undefined;
  const system32 = path.win32.join(systemRoot, "System32");
  const powershellPath = path.win32.join(
    system32,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const nvidiaSmiPath = path.win32.join(system32, "nvidia-smi.exe");
  const environment = buildWindowsCudaProbeEnvironment(sourceEnvironment);
  if (!environment) return undefined;
  return async ({ processId, signal }) => {
    const wddmBytes = await queryWddmDedicatedBytes({
      processId,
      signal,
      powershellPath,
      environment,
    });
    if (wddmBytes !== undefined && wddmBytes > 0) return wddmBytes;
    return queryNvidiaSmiBytes({
      processId,
      signal,
      nvidiaSmiPath,
      environment,
    });
  };
}

async function queryWddmDedicatedBytes(options: {
  readonly processId: number;
  readonly signal: AbortSignal;
  readonly powershellPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<number | undefined> {
  const command =
    `$p = Get-Process -Id ${options.processId} -ErrorAction SilentlyContinue; ` +
    "if ($null -ne $p) { " +
    `$prefix = 'pid_${options.processId}_'; ` +
    "$samples = @((Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | " +
    "Where-Object { $_.InstanceName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) }); " +
    "$sum = $samples | Measure-Object CookedValue -Sum; " +
    "$bytes = if ($samples.Count -eq 0) { 0 } else { [long]$sum.Sum }; " +
    "[Console]::Out.Write($bytes) }";
  const stdout = await runBoundedProbe(
    options.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    options.environment,
    options.signal,
  );
  return parsePositiveInteger(stdout);
}

async function queryNvidiaSmiBytes(options: {
  readonly processId: number;
  readonly signal: AbortSignal;
  readonly nvidiaSmiPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<number | undefined> {
  const stdout = await runBoundedProbe(
    options.nvidiaSmiPath,
    [
      "--query-compute-apps=pid,used_gpu_memory",
      "--format=csv,noheader,nounits",
    ],
    options.environment,
    options.signal,
  );
  if (stdout === undefined) return undefined;
  let totalMiB = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    const [pidText, memoryText] = line.split(",", 2).map((value) => value.trim());
    if (Number(pidText) !== options.processId || !/^\d+$/u.test(memoryText ?? "")) {
      continue;
    }
    totalMiB += Number(memoryText);
  }
  const bytes = totalMiB * 1024 * 1024;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

function runBoundedProbe(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      env: environment,
      timeout:
        LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.cudaProbeTimeoutMs,
      maxBuffer:
        LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.cudaProbeMaxOutputBytes,
      windowsHide: true,
      shell: false,
      signal,
    }, (error, stdout) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      resolve(error ? undefined : String(stdout ?? ""));
    });
  });
}

export function buildWindowsCudaProbeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv | undefined {
  const systemRoot = safeAbsoluteWindowsPath(
    source.SystemRoot ?? source.WINDIR,
  );
  if (!systemRoot) return undefined;
  const system32 = path.win32.join(systemRoot, "System32");
  const environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: system32,
    LANG: "C",
    LC_ALL: "C",
  } as unknown as NodeJS.ProcessEnv;
  for (
    const key of ["TEMP", "TMP", "ProgramFiles", "ProgramW6432"] as const
  ) {
    const value = safeAbsoluteWindowsPath(source[key]);
    if (value) environment[key] = value;
  }
  return Object.freeze(environment);
}

function safeAbsoluteWindowsPath(value: string | undefined): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value
  ) {
    return undefined;
  }
  return value;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!/^\s*\d+\s*$/u.test(value ?? "")) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    timeout.unref?.();
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}
