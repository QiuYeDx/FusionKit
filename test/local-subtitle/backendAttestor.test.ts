import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsCudaProbeEnvironment,
  createLocalSubtitleProductionBackendAttestor,
  LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY,
  runBoundedProbe,
} from "../../electron/main/local-subtitle/backend-attestor";
import type {
  LocalSubtitleServerBackendAttestationContext,
  LocalSubtitleServerBackendEvidence,
} from "../../electron/main/local-subtitle/server-supervisor";

const RUNTIME_GENERATION = "a".repeat(64);

describe("local subtitle production backend attestor", () => {
  it("admits Windows CUDA only after positive memory for the exact child PID", async () => {
    const probe = vi.fn(async ({ processId }: { processId: number }) =>
      processId === 4321 ? 512 * 1024 * 1024 : undefined
    );
    const attestor = createLocalSubtitleProductionBackendAttestor({
      platform: "win32",
      arch: "x64",
      cudaProcessMemoryProbe: probe,
    });

    expect(attestor.supportedBackends).toEqual(["cuda"]);
    await expect(attestor.verifyBackend(cudaContext(4321))).resolves.toEqual({
      verified: true,
      processEpoch: 7,
      processId: 4321,
      backend: "cuda",
      runtimeGeneration: RUNTIME_GENERATION,
      serverArtifactId: "whisper-server-win-x64-cuda-test",
      acceleratorResourceId: "local-subtitle-windows-x64-cuda-test-v1",
      acceleratorPackGeneration: "b".repeat(64),
    });
    expect(probe).toHaveBeenCalledWith({
      processId: 4321,
      signal: expect.any(AbortSignal),
    });
  });

  it("fails closed when the exact CUDA PID never owns positive GPU memory", async () => {
    const attestor = createLocalSubtitleProductionBackendAttestor({
      platform: "win32",
      arch: "x64",
      cudaEvidenceGraceMs: 3,
      cudaPollIntervalMs: 1,
      cudaProcessMemoryProbe: async () => undefined,
    });

    await expect(attestor.verifyBackend(cudaContext(4322))).rejects.toThrow(
      /positive GPU memory/u,
    );
  });

  it("does not advertise a Windows CUDA attestor without a trusted probe path", () => {
    const attestor = createLocalSubtitleProductionBackendAttestor({
      platform: "win32",
      arch: "x64",
      sourceEnvironment: {},
    });

    expect(attestor.supportedBackends).toEqual([]);
  });

  it("preserves only the Windows system locations required by NVIDIA probes", () => {
    const environment = buildWindowsCudaProbeEnvironment({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      ProgramFiles: "C:\\Program Files",
      ProgramW6432: "C:\\Program Files",
      PATH: "C:\\untrusted",
      NODE_OPTIONS: "--require untrusted.js",
      OPENAI_API_KEY: "secret",
      HTTPS_PROXY: "http://secret.invalid",
    });

    expect(environment).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      LANG: "C",
      LC_ALL: "C",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      ProgramFiles: "C:\\Program Files",
      ProgramW6432: "C:\\Program Files",
    });
  });

  it("budgets enough time for a cold Windows GPU performance-counter probe", () => {
    expect(LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY).toMatchObject({
      cudaEvidenceGraceMs: 10_000,
      cudaProbeTimeoutMs: 5_000,
    });
    expect(
      LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.cudaEvidenceGraceMs,
    ).toBeGreaterThanOrEqual(
      LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.cudaProbeTimeoutMs,
    );
  });

  it("settles at its own deadline when a Windows child keeps inherited pipes open", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(() => true);
      let callback:
        | ((error: Error | null, stdout?: string) => void)
        | undefined;
      const executeFile = vi.fn((...callArgs: unknown[]) => {
        callback = callArgs.at(-1) as typeof callback;
        return { kill };
      }) as unknown as typeof import("node:child_process").execFile;

      const result = runBoundedProbe(
        "C:\\Windows\\System32\\probe.exe",
        [],
        {},
        new AbortController().signal,
        { executeFile, timeoutMs: 25 },
      );

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledOnce();

      callback?.(null, "late-success");
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles cancellation without waiting for the native probe callback", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(() => true);
      const executeFile = vi.fn(() => ({ kill })) as unknown as
        typeof import("node:child_process").execFile;
      const controller = new AbortController();
      const result = runBoundedProbe(
        "C:\\Windows\\System32\\probe.exe",
        [],
        {},
        controller.signal,
        { executeFile, timeoutMs: 25 },
      );
      const reason = new DOMException("cancelled", "AbortError");

      controller.abort(reason);

      await expect(result).rejects.toBe(reason);
      expect(kill).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function cudaContext(processId: number): LocalSubtitleServerBackendAttestationContext {
  return {
    processEpoch: 7,
    processId,
    backend: "cuda",
    runtimeGeneration: RUNTIME_GENERATION,
    serverArtifactId: "whisper-server-win-x64-cuda-test",
    acceleratorResourceId: "local-subtitle-windows-x64-cuda-test-v1",
    acceleratorPackGeneration: "b".repeat(64),
    evidence: Object.freeze({}) as LocalSubtitleServerBackendEvidence,
    signal: new AbortController().signal,
  };
}
