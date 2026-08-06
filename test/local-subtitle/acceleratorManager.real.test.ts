import { link, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION,
  LocalSubtitleAcceleratorManager,
} from "../../electron/main/local-subtitle/accelerator-manager";
import {
  createLocalSubtitleProductionBackendAttestor,
} from "../../electron/main/local-subtitle/backend-attestor";
import { LocalSubtitleBackendResolver } from "../../electron/main/local-subtitle/backend-resolver";
import { LOCAL_SUBTITLE_MODEL_MANIFEST } from "../../electron/main/local-subtitle/model-manifest";
import {
  LocalSubtitleResourceJobManager,
} from "../../electron/main/local-subtitle/resource-job";
import {
  verifyLocalSubtitleRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import {
  LocalSubtitleServerSupervisor,
  type LocalSubtitleServerLease,
} from "../../electron/main/local-subtitle/server-supervisor";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REAL_MODEL_PATH = process.env.FUSIONKIT_MODEL002_REAL_MODEL;
const REAL_CUDA_ARCHIVE_PATH =
  process.env.FUSIONKIT_MODEL002_REAL_CUDA_ARCHIVE;
const HAS_REAL_FIXTURE =
  process.platform === "win32" &&
  process.arch === "x64" &&
  typeof REAL_MODEL_PATH === "string" &&
  path.isAbsolute(REAL_MODEL_PATH) &&
  typeof REAL_CUDA_ARCHIVE_PATH === "string" &&
  path.isAbsolute(REAL_CUDA_ARCHIVE_PATH);
const OWNER = Object.freeze({
  webContentsId: 603,
  ownerSessionId: "model002-real-cuda-owner",
});

describe("local subtitle accelerator manager real contract", () => {
  it.skipIf(!HAS_REAL_FIXTURE)(
    "installs the pinned archive and admits its exact CUDA process in production",
    async () => {
      const pack = LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION;
      const model = LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!;
      const sourceModelPath = path.resolve(REAL_MODEL_PATH!);
      const sourceArchivePath = path.resolve(REAL_CUDA_ARCHIVE_PATH!);
      const [sourceModelStat, sourceArchiveStat] = await Promise.all([
        stat(sourceModelPath),
        stat(sourceArchivePath),
      ]);
      expect(sourceModelStat.isFile()).toBe(true);
      expect(sourceModelStat.size).toBe(model.byteSize);
      expect(sourceArchiveStat.isFile()).toBe(true);
      expect(sourceArchiveStat.size).toBe(pack.sourceArchive.byteSize);

      const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "fk-m2-cuda-"));
      const managedResourceRoot = path.join(fixtureRoot, "managed");
      const managedModelPath = path.join(
        managedResourceRoot,
        "models",
        model.id,
        model.fileName,
      );
      await mkdir(path.dirname(managedModelPath), {
        recursive: true,
        mode: 0o700,
      });
      await link(sourceModelPath, managedModelPath);

      const registry = new LocalSubtitleSessionRegistry();
      const resourceJobs = new LocalSubtitleResourceJobManager(registry);
      const manager = new LocalSubtitleAcceleratorManager({
        managedResourceRoot,
        platform: "win32",
        arch: "x64",
        resourceJobs,
        downloadResource: async (options) => {
          await link(sourceArchivePath, options.destinationPath);
          options.onProgress?.(sourceArchiveStat.size, sourceArchiveStat.size);
          return {};
        },
      });
      let supervisor: LocalSubtitleServerSupervisor | undefined;
      let lease: LocalSubtitleServerLease | undefined;

      try {
        expect(manager.startResourceInstall(OWNER, pack.resourceId)).toMatchObject({
          resourceType: "accelerator",
          status: "queued",
        });
        await manager.waitForIdle();
        expect(registry.getSnapshot(OWNER).resourceJobs).toEqual([
          expect.objectContaining({
            resourceId: pack.resourceId,
            status: "completed",
            progress: 100,
            bytesCompleted:
              pack.sourceArchive.byteSize + pack.installedByteSize,
            bytesTotal: pack.sourceArchive.byteSize + pack.installedByteSize,
          }),
        ]);
        const acceleratorPack = await manager.resolveManagedAccelerator(
          pack.resourceId,
        );
        const verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
          environment: {
            mode: "development",
            appRoot: PROJECT_ROOT,
            platform: "win32",
            arch: "x64",
          },
          scope: "server",
        });
        const attestor = createLocalSubtitleProductionBackendAttestor();
        expect(attestor.supportedBackends).toContain("cuda");
        const managedModel = Object.freeze({
          storage: "managed" as const,
          id: model.id,
          absolutePath: managedModelPath,
          byteSize: model.byteSize,
          sha256: model.sha256,
        });
        const resolver = new LocalSubtitleBackendResolver({
          verifyServerRuntime: async () => verifiedRuntime,
          cudaAttestationAvailable: true,
          resolveCudaAccelerator: async () =>
            manager.resolveManagedAccelerator(pack.resourceId),
        });
        const resolution = await resolver.resolveBackend({
          devicePreference: "cuda",
          admittedRuntimeGeneration: verifiedRuntime.runtimeGeneration,
          model: managedModel,
        });
        expect(resolution).toMatchObject({
          resolvedBackend: "cuda",
          serverArtifact: {
            id: acceleratorPack.serverArtifactId,
            backend: "cuda",
          },
          acceleratorPack: {
            resourceId: pack.resourceId,
            packGeneration: acceleratorPack.packGeneration,
          },
        });

        supervisor = new LocalSubtitleServerSupervisor({
          managedResourceRoot,
          startupTimeoutMs: 120_000,
          dependencies: { verifyBackend: attestor.verifyBackend },
        });
        lease = await supervisor.acquire(OWNER, {
          verifiedRuntime,
          serverArtifactId: resolution.serverArtifact.id,
          purpose: "inference",
          backend: "cuda",
          model: managedModel,
          acceleratorPack,
          threads: 4,
        });
        expect(supervisor.snapshot).toMatchObject({
          state: "ready",
          backend: "cuda",
          modelId: model.id,
          serverArtifactId: acceleratorPack.serverArtifactId,
          leaseCount: 1,
        });
        await supervisor.release(lease);
        lease = undefined;
        await supervisor.shutdown("app_quit");
        supervisor = undefined;
        await expect(manager.deleteManagedResource(pack.resourceId)).resolves
          .toEqual({ deleted: true });
      } finally {
        if (lease && supervisor) {
          await supervisor.release(lease).catch(() => undefined);
        }
        await supervisor?.shutdown("app_quit").catch(() => undefined);
        await manager.shutdown().catch(() => undefined);
        await rm(fixtureRoot, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
    },
    300_000,
  );
});
