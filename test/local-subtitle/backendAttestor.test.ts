import { describe, expect, it, vi } from "vitest";
import {
  createLocalSubtitleProductionBackendAttestor,
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
