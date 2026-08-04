import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LocalSubtitleBackendResolver,
  isLocalSubtitleVerifiedBackendResolution,
  matchesLocalSubtitleBackendResolutionRuntime,
} from "../../electron/main/local-subtitle/backend-resolver";
import type { LocalSubtitleVerifiedRuntimeBundle } from "../../electron/main/local-subtitle/resource-path";

const RUNTIME_GENERATION = "a".repeat(64);
const MODEL_HASH = "b".repeat(64);
const MODEL = Object.freeze({
  storage: "managed" as const,
  id: "large-v3-q5_0",
  absolutePath: "/managed/models/large-v3-q5_0/model.bin",
  byteSize: 1024,
  sha256: MODEL_HASH,
});

describe("LocalSubtitleBackendResolver", () => {
  it.each(["auto", "cpu"] as const)(
    "freezes an identity-bound %s to CPU resolution",
    async (devicePreference) => {
      const runtime = fakeRuntime();
      const resolution = await resolver(runtime).resolveBackend({
        devicePreference,
        admittedRuntimeGeneration: RUNTIME_GENERATION,
        model: MODEL,
      });

      expect(isLocalSubtitleVerifiedBackendResolution(resolution)).toBe(true);
      expect(resolution).toMatchObject({
        devicePreference,
        resolvedBackend: "cpu",
        runtimeGeneration: RUNTIME_GENERATION,
        model: { id: MODEL.id, sha256: MODEL_HASH },
        serverArtifact: {
          id: "whisper-server-cpu",
          kind: "server",
          backend: "metal_cpu",
        },
      });
      expect(Object.isFrozen(resolution)).toBe(true);
      expect(Object.isFrozen(resolution.model)).toBe(true);
      expect(Object.isFrozen(resolution.serverArtifact)).toBe(true);
      expect(matchesLocalSubtitleBackendResolutionRuntime(resolution, runtime)).toBe(
        true,
      );
    },
  );

  it.each(["cuda", "metal"] as const)(
    "rejects explicit %s without falling back or probing a CPU runtime",
    async (devicePreference) => {
      const verifyServerRuntime = vi.fn(async () => fakeRuntime());
      const backendResolver = new LocalSubtitleBackendResolver({
        verifyServerRuntime,
        selectCpuServerArtifact: selectCpuArtifact,
      });

      await expect(
        backendResolver.resolveBackend({
          devicePreference,
          admittedRuntimeGeneration: RUNTIME_GENERATION,
          model: MODEL,
        }),
      ).rejects.toMatchObject({ localSubtitleCode: "backend_unverified" });
      expect(verifyServerRuntime).not.toHaveBeenCalled();
    },
  );

  it.each(["auto", "metal"] as const)(
    "admits an exact macOS Metal artifact for %s when production attestation is available",
    async (devicePreference) => {
      const runtime = fakeRuntime();
      const resolution = await new LocalSubtitleBackendResolver({
        verifyServerRuntime: async () => runtime,
        metalAttestationAvailable: true,
        selectCpuServerArtifact: selectCpuArtifact,
        selectMetalServerArtifact: selectCpuArtifact,
      }).resolveBackend({
        devicePreference,
        admittedRuntimeGeneration: RUNTIME_GENERATION,
        model: MODEL,
      });

      expect(resolution).toMatchObject({
        devicePreference,
        resolvedBackend: "metal",
        target: { platform: "darwin", arch: "arm64" },
        serverArtifact: { backend: "metal_cpu" },
      });
      expect(matchesLocalSubtitleBackendResolutionRuntime(resolution, runtime)).toBe(
        true,
      );
    },
  );

  it("keeps explicit CPU on the shared Metal/CPU artifact", async () => {
    const runtime = fakeRuntime();
    const resolution = await new LocalSubtitleBackendResolver({
      verifyServerRuntime: async () => runtime,
      metalAttestationAvailable: true,
      selectCpuServerArtifact: selectCpuArtifact,
      selectMetalServerArtifact: selectCpuArtifact,
    }).resolveBackend({
      devicePreference: "cpu",
      admittedRuntimeGeneration: RUNTIME_GENERATION,
      model: MODEL,
    });

    expect(resolution.resolvedBackend).toBe("cpu");
  });

  it("does not admit Metal on a Windows runtime", async () => {
    const runtime = fakeWindowsRuntime();
    const backendResolver = new LocalSubtitleBackendResolver({
      verifyServerRuntime: async () => runtime,
      metalAttestationAvailable: true,
      selectCpuServerArtifact: selectCpuArtifact,
      selectMetalServerArtifact: selectCpuArtifact,
    });

    await expect(
      backendResolver.resolveBackend({
        devicePreference: "metal",
        admittedRuntimeGeneration: RUNTIME_GENERATION,
        model: MODEL,
      }),
    ).rejects.toMatchObject({ localSubtitleCode: "backend_unverified" });
    await expect(
      backendResolver.resolveBackend({
        devicePreference: "auto",
        admittedRuntimeGeneration: RUNTIME_GENERATION,
        model: MODEL,
      }),
    ).resolves.toMatchObject({ resolvedBackend: "cpu" });
  });

  it("rejects a runtime generation change during admission", async () => {
    await expect(
      resolver(fakeRuntime("c".repeat(64))).resolveBackend({
        devicePreference: "auto",
        admittedRuntimeGeneration: RUNTIME_GENERATION,
        model: MODEL,
      }),
    ).rejects.toMatchObject({ localSubtitleCode: "media_runtime_invalid" });
  });

  it("rejects forged proofs and detects exact artifact drift", async () => {
    const runtime = fakeRuntime();
    const resolution = await resolver(runtime).resolveBackend({
      devicePreference: "auto",
      admittedRuntimeGeneration: RUNTIME_GENERATION,
      model: MODEL,
    });
    const forged = Object.freeze({ ...resolution });
    const changedRuntime = Object.freeze({
      ...runtime,
      artifactPaths: Object.freeze({
        ...runtime.artifactPaths,
        "whisper-server-cpu": Object.freeze({
          ...runtime.artifactPaths["whisper-server-cpu"]!,
          absolutePath: "/runtime/replaced-whisper-server",
        }),
      }),
    }) as LocalSubtitleVerifiedRuntimeBundle;

    expect(isLocalSubtitleVerifiedBackendResolution(forged)).toBe(false);
    expect(matchesLocalSubtitleBackendResolutionRuntime(resolution, changedRuntime)).toBe(
      false,
    );
  });
});

function resolver(runtime: LocalSubtitleVerifiedRuntimeBundle) {
  return new LocalSubtitleBackendResolver({
    verifyServerRuntime: async () => runtime,
    selectCpuServerArtifact: selectCpuArtifact,
  });
}

function selectCpuArtifact(runtime: LocalSubtitleVerifiedRuntimeBundle) {
  return runtime.artifactPaths["whisper-server-cpu"]!;
}

function fakeRuntime(
  runtimeGeneration = RUNTIME_GENERATION,
): LocalSubtitleVerifiedRuntimeBundle {
  return Object.freeze({
    schemaVersion: 1 as const,
    target: Object.freeze({ platform: "darwin" as const, arch: "arm64" as const }),
    scope: "server" as const,
    root: "/runtime",
    manifestPath: "/runtime/manifest.json",
    manifestSha256: runtimeGeneration,
    runtimeGeneration,
    integrityProfile: "development" as const,
    artifactPaths: Object.freeze({
      "whisper-server-cpu": Object.freeze({
        id: "whisper-server-cpu",
        kind: "server" as const,
        backend: "metal_cpu" as const,
        absolutePath: path.join("/runtime", "whisper-server"),
        byteSize: 1024,
        sha256: "d".repeat(64),
        version: "1.9.1+b1ade71",
        signatureKind: "adhoc" as const,
      }),
    }),
    evidenceFileCount: 1,
    noPathFallback: true as const,
    ready: true as const,
  }) as LocalSubtitleVerifiedRuntimeBundle;
}

function fakeWindowsRuntime(): LocalSubtitleVerifiedRuntimeBundle {
  const runtime = fakeRuntime();
  return Object.freeze({
    ...runtime,
    target: Object.freeze({ platform: "win32" as const, arch: "x64" as const }),
    integrityProfile: "development" as const,
    artifactPaths: Object.freeze({
      "whisper-server-cpu": Object.freeze({
        ...runtime.artifactPaths["whisper-server-cpu"]!,
        backend: "cpu" as const,
        absolutePath: path.join("/runtime", "whisper-server.exe"),
        signatureKind: "unsigned" as const,
      }),
    }),
  }) as LocalSubtitleVerifiedRuntimeBundle;
}
