import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalSubtitleAcceleratorManager,
  type LocalSubtitleAcceleratorManagerOptions,
  type LocalSubtitleAcceleratorPackDefinition,
} from "../../electron/main/local-subtitle/accelerator-manager";
import { LOCAL_SUBTITLE_MODEL_MANIFEST } from "../../electron/main/local-subtitle/model-manifest";
import { LocalSubtitleModelManager } from "../../electron/main/local-subtitle/model-manager";
import { LocalSubtitleResourceJobManager } from "../../electron/main/local-subtitle/resource-job";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";

const OWNER_A = Object.freeze({
  webContentsId: 301,
  ownerSessionId: "accelerator-owner-a",
});
const OWNER_B = Object.freeze({
  webContentsId: 302,
  ownerSessionId: "accelerator-owner-b",
});
const tempRoots: string[] = [];
const packBytes = new WeakMap<object, readonly Buffer[]>();

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })),
  );
});

describe("local subtitle accelerator manager", () => {
  it("routes accelerator list, install and delete through the existing managed-resource API", async () => {
    const pack = createPack("cuda-pack-managed-api", 0x30);
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-accelerator-routing-"));
    tempRoots.push(root);
    const registry = new LocalSubtitleSessionRegistry();
    const manager = new LocalSubtitleModelManager({
      managedResourceRoot: path.join(root, "managed"),
      runtimeEnvironment: {
        mode: "development",
        appRoot: root,
        platform: "win32",
        arch: "x64",
      },
      supervisor: { smokeModelLoad: vi.fn(async () => undefined) },
      sessionRegistry: registry,
      modelCatalog: [LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!],
      acceleratorOptions: {
        packs: [pack],
        availableBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadResource: async (options) => {
          await writeFile(
            options.destinationPath,
            Buffer.alloc(pack.sourceArchive.byteSize, 0x61),
          );
          options.onProgress?.(
            pack.sourceArchive.byteSize,
            pack.sourceArchive.byteSize,
          );
          return {};
        },
        extractArchive: async (options) => {
          await materializePack(pack, options.destinationDirectory);
          options.onProgress?.(1, 1);
          return {};
        },
        probePack: async () => undefined,
      },
    });

    await expect(manager.listManagedResources(OWNER_A)).resolves.toEqual([
      expect.objectContaining({ resourceType: "model" }),
      expect.objectContaining({
        resourceId: pack.resourceId,
        resourceType: "accelerator",
        status: "not_installed",
      }),
    ]);
    expect(manager.startResourceInstall(OWNER_A, pack.resourceId)).toMatchObject({
      resourceType: "accelerator",
      status: "queued",
    });
    await manager.waitForIdle();
    await expect(manager.listManagedResources(OWNER_A)).resolves.toEqual([
      expect.objectContaining({ resourceType: "model" }),
      expect.objectContaining({ resourceType: "accelerator", status: "ready" }),
    ]);
    await expect(
      manager.deleteManagedResource(OWNER_A, pack.resourceId),
    ).resolves.toEqual({ deleted: true });
  });

  it("downloads, extracts, probes, atomically commits and lists an accelerator", async () => {
    const pack = createPack("cuda-pack-v1", 0x31);
    const fixture = await createFixture([pack]);

    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({
        resourceId: pack.resourceId,
        resourceType: "accelerator",
        status: "not_installed",
        compatibleBackends: ["cuda"],
      }),
    ]);
    const queued = fixture.manager.startResourceInstall(OWNER_A, pack.resourceId);
    expect(queued).toMatchObject({
      resourceId: pack.resourceId,
      resourceType: "accelerator",
      status: "queued",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      resourceId: pack.resourceId,
      status: "completed",
      progress: 100,
      bytesCompleted: pack.sourceArchive.byteSize + pack.installedByteSize,
      bytesTotal: pack.sourceArchive.byteSize + pack.installedByteSize,
    });
    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({ resourceId: pack.resourceId, status: "ready" }),
    ]);
    expect(fixture.probePack).toHaveBeenCalledOnce();
    expect(fixture.downloadResource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: pack.sourceArchive.downloadUrl,
        allowedHosts: pack.sourceArchive.allowedDownloadHosts,
        partFileName: `${pack.resourceId}.part`,
      }),
    );
    await expect(
      readdir(path.join(fixture.managedRoot, "accelerator-staging")),
    ).resolves.toEqual([]);
  });

  it("claims an install synchronously across owners", async () => {
    const pack = createPack("cuda-pack-claimed", 0x32);
    const extractionStarted = deferred<void>();
    const finishExtraction = deferred<void>();
    const fixture = await createFixture([pack], {
      extractArchive: async (options) => {
        extractionStarted.resolve();
        await finishExtraction.promise;
        await materializePack(pack, options.destinationDirectory);
      },
    });

    fixture.manager.startResourceInstall(OWNER_A, pack.resourceId);
    expect(() =>
      fixture.manager.startResourceInstall(OWNER_B, pack.resourceId)
    ).toThrow(expect.objectContaining({ localSubtitleCode: "resource_busy" }));
    expect(fixture.registry.getSnapshot(OWNER_B)).toMatchObject({
      revision: 0,
      resourceJobs: [],
    });
    await extractionStarted.promise;
    finishExtraction.resolve();
    await fixture.manager.waitForIdle();
  });

  it("serializes installs across accelerator pack versions", async () => {
    const oldPack = createPack("cuda-pack-version-a", 0x32);
    const newPack = createPack("cuda-pack-version-b", 0x33);
    const extractionStarted = deferred<void>();
    const finishExtraction = deferred<void>();
    const fixture = await createFixture([oldPack, newPack], {
      extractArchive: async (options) => {
        if (options.contract === oldPack.archiveContract) {
          extractionStarted.resolve();
          await finishExtraction.promise;
        }
        const pack = options.contract === oldPack.archiveContract ? oldPack : newPack;
        await materializePack(pack, options.destinationDirectory);
      },
    });

    fixture.manager.startResourceInstall(OWNER_A, oldPack.resourceId);
    await extractionStarted.promise;
    expect(() =>
      fixture.manager.startResourceInstall(OWNER_B, newPack.resourceId)
    ).toThrow(expect.objectContaining({ localSubtitleCode: "resource_busy" }));
    finishExtraction.resolve();
    await fixture.manager.waitForIdle();
  });

  it("fails before download when the full archive and expanded pack do not fit", async () => {
    const pack = createPack("cuda-pack-no-space", 0x33);
    const fixture = await createFixture([pack], {
      availableBytes: async () => 1,
    });

    fixture.manager.startResourceInstall(OWNER_A, pack.resourceId);
    await fixture.manager.waitForIdle();

    expect(fixture.downloadResource).not.toHaveBeenCalled();
    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "insufficient_disk" },
    });
  });

  it("cancels before commit and removes the private transaction directory", async () => {
    const pack = createPack("cuda-pack-cancel", 0x33);
    const downloadStarted = deferred<void>();
    const fixture = await createFixture([pack], {
      downloadResource: async (options) => {
        downloadStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    });

    const job = fixture.manager.startResourceInstall(OWNER_A, pack.resourceId);
    await downloadStarted.promise;
    expect(fixture.jobs.cancel(OWNER_A, job.jobId)).toEqual({ cancelled: true });
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "cancelled",
    });
    await expect(
      readdir(path.join(fixture.managedRoot, "accelerator-staging")),
    ).resolves.toEqual([]);
  });

  it("aborts active acquisition and waits for cleanup during shutdown", async () => {
    const pack = createPack("cuda-pack-shutdown", 0x33);
    const downloadStarted = deferred<void>();
    const fixture = await createFixture([pack], {
      downloadResource: async (options) => {
        downloadStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    });
    fixture.manager.startResourceInstall(OWNER_A, pack.resourceId);
    await downloadStarted.promise;

    const shutdown = fixture.manager.shutdown();
    expect(fixture.manager.shutdown()).toBe(shutdown);
    await shutdown;

    await expect(
      readdir(path.join(fixture.managedRoot, "accelerator-staging")),
    ).resolves.toEqual([]);
    expect(() =>
      fixture.manager.startResourceInstall(OWNER_B, pack.resourceId)
    ).toThrow(expect.objectContaining({ localSubtitleCode: "owner_released" }));
  });

  it("refuses busy deletion and removes an idle verified pack", async () => {
    const pack = createPack("cuda-pack-delete", 0x34);
    let busy = false;
    const fixture = await createFixture([pack], {
      isResourceBusy: () => busy,
    });
    fixture.manager.startResourceInstall(OWNER_A, pack.resourceId);
    await fixture.manager.waitForIdle();

    busy = true;
    await expect(
      fixture.manager.deleteManagedResource(pack.resourceId),
    ).rejects.toMatchObject({ localSubtitleCode: "resource_busy" });
    busy = false;
    await expect(
      fixture.manager.deleteManagedResource(pack.resourceId),
    ).resolves.toEqual({ deleted: true });
    await expect(
      fixture.manager.deleteManagedResource(pack.resourceId),
    ).resolves.toEqual({ deleted: false });
  });

  it("drops the verification cache and rejects same-size artifact drift", async () => {
    const pack = createPack("cuda-pack-cache-drift", 0x34);
    const fixture = await createFixture([pack]);
    fixture.manager.startResourceInstall(OWNER_A, pack.resourceId);
    await fixture.manager.waitForIdle();
    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
    ]);

    const server = pack.artifacts.find((artifact) => artifact.kind === "server")!;
    await writeFile(
      path.join(
        finalPackPath(fixture.managedRoot, pack),
        ...server.relativePath.split("/"),
      ),
      Buffer.alloc(server.byteSize, 0x7e),
    );

    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({
        status: "invalid",
        errorCode: "resource_signature_invalid",
      }),
    ]);
  });

  it("lets a verified commit complete when cancellation races after rename", async () => {
    const pack = createPack("cuda-pack-late-cancel", 0x35);
    let jobId: string | undefined;
    let jobs: LocalSubtitleResourceJobManager | undefined;
    const fixture = await createFixture([pack], {
      renameDirectory: async (source, destination) => {
        await rename(source, destination);
        if (path.basename(destination) === pack.resourceId) {
          expect(jobId).toBeDefined();
          expect(jobs!.cancel(OWNER_A, jobId!)).toEqual({ cancelled: true });
        }
      },
    });
    jobs = fixture.jobs;
    jobId = fixture.manager.startResourceInstall(OWNER_A, pack.resourceId).jobId;
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "completed",
      progress: 100,
    });
    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({ resourceId: pack.resourceId, status: "ready" }),
    ]);
  });

  it("rolls back a corrupt post-commit pack and preserves the old version", async () => {
    const oldPack = createPack("cuda-pack-old", 0x36);
    const newPack = createPack("cuda-pack-new", 0x37);
    const fixture = await createFixture([oldPack, newPack], {
      renameDirectory: async (source, destination) => {
        await rename(source, destination);
        if (path.basename(destination) === newPack.resourceId) {
          const server = newPack.artifacts.find((artifact) => artifact.kind === "server")!;
          await writeFile(
            path.join(destination, ...server.relativePath.split("/")),
            Buffer.alloc(server.byteSize, 0x7f),
          );
        }
      },
    });
    await installExistingPack(fixture.managedRoot, oldPack);

    fixture.manager.startResourceInstall(OWNER_A, newPack.resourceId);
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "resource_signature_invalid" },
    });
    await expect(lstat(finalPackPath(fixture.managedRoot, oldPack))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(lstat(finalPackPath(fixture.managedRoot, newPack))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes an old known version only after the new pack passes post-commit verification", async () => {
    const oldPack = createPack("cuda-pack-old-ready", 0x38);
    const newPack = createPack("cuda-pack-new-ready", 0x39);
    const fixture = await createFixture([oldPack, newPack]);
    await installExistingPack(fixture.managedRoot, oldPack);

    fixture.manager.startResourceInstall(OWNER_A, newPack.resourceId);
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "completed",
    });
    await expect(lstat(finalPackPath(fixture.managedRoot, oldPack))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(finalPackPath(fixture.managedRoot, newPack))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("retries cleanup when a superseded pack was already quarantined", async () => {
    const oldPack = createPack("cuda-pack-old-retry", 0x3a);
    const newPack = createPack("cuda-pack-new-retry", 0x3b);
    let cleanupAttempts = 0;
    const fixture = await createFixture([oldPack, newPack], {
      removeDirectory: async (absolutePath) => {
        if (path.basename(absolutePath).startsWith(".superseded-")) {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error("transient cleanup failure");
        }
        await rm(absolutePath, {
          recursive: true,
          force: false,
          maxRetries: 5,
          retryDelay: 200,
        });
      },
    });
    await installExistingPack(fixture.managedRoot, oldPack);

    fixture.manager.startResourceInstall(OWNER_A, newPack.resourceId);
    await fixture.manager.waitForIdle();

    expect(cleanupAttempts).toBe(2);
    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "completed",
    });
    await expect(
      readdir(path.join(fixture.managedRoot, "accelerator-staging")),
    ).resolves.toEqual([]);
  });
});

interface FixtureOverrides {
  readonly availableBytes?: LocalSubtitleAcceleratorManagerOptions["availableBytes"];
  readonly extractArchive?: LocalSubtitleAcceleratorManagerOptions["extractArchive"];
  readonly downloadResource?: LocalSubtitleAcceleratorManagerOptions["downloadResource"];
  readonly renameDirectory?: LocalSubtitleAcceleratorManagerOptions["renameDirectory"];
  readonly isResourceBusy?: LocalSubtitleAcceleratorManagerOptions["isResourceBusy"];
  readonly removeDirectory?: LocalSubtitleAcceleratorManagerOptions["removeDirectory"];
}

async function createFixture(
  packs: readonly LocalSubtitleAcceleratorPackDefinition[],
  overrides: FixtureOverrides = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-accelerator-manager-"));
  tempRoots.push(root);
  const managedRoot = path.join(root, "managed");
  const registry = new LocalSubtitleSessionRegistry();
  let nextJobId = 1;
  const jobs = new LocalSubtitleResourceJobManager(registry, {
    jobIdFactory: () => `accelerator-job-${nextJobId++}`,
    sessionRegistryOwnership: "shared",
  });
  const defaultDownloadResource = async (
    options: Parameters<NonNullable<LocalSubtitleAcceleratorManagerOptions["downloadResource"]>>[0],
  ) => {
    const pack = packs.find(
      (candidate) => candidate.sourceArchive.downloadUrl === options.sourceUrl,
    )!;
    const bytes = Buffer.alloc(pack.sourceArchive.byteSize, 0x61);
    await writeFile(options.destinationPath, bytes);
    options.onProgress?.(bytes.length, bytes.length);
    return {};
  };
  const downloadResource = vi.fn(
    overrides.downloadResource ?? defaultDownloadResource,
  );
  const extractArchive = overrides.extractArchive ?? (async (options) => {
    const pack = packs.find(
      (candidate) => candidate.archiveContract === options.contract,
    )!;
    await materializePack(pack, options.destinationDirectory);
    options.onProgress?.(
      pack.sourceArchive.byteSize + pack.installedByteSize,
      pack.sourceArchive.byteSize + pack.installedByteSize,
    );
    return {};
  });
  const probePack = vi.fn(async () => undefined);
  const manager = new LocalSubtitleAcceleratorManager({
    managedResourceRoot: managedRoot,
    platform: "win32",
    arch: "x64",
    resourceJobs: jobs,
    packs,
    availableBytes: overrides.availableBytes ?? (async () => Number.MAX_SAFE_INTEGER),
    downloadResource,
    extractArchive,
    probePack,
    ...(overrides.renameDirectory === undefined
      ? {}
      : { renameDirectory: overrides.renameDirectory }),
    ...(overrides.isResourceBusy === undefined
      ? {}
      : { isResourceBusy: overrides.isResourceBusy }),
    ...(overrides.removeDirectory === undefined
      ? {}
      : { removeDirectory: overrides.removeDirectory }),
  });
  return {
    root,
    managedRoot,
    registry,
    jobs,
    manager,
    downloadResource,
    probePack,
  };
}

function createPack(
  resourceId: string,
  fill: number,
): LocalSubtitleAcceleratorPackDefinition {
  const server = createPe(160, fill);
  const library = createPe(192, fill + 1);
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, packId: resourceId }, null, 2)}\n`,
    "utf8",
  );
  const artifacts = [
    {
      id: `${resourceId}-server`,
      kind: "server" as const,
      relativePath: "win-x64/cuda/whisper-server.exe",
      byteSize: server.length,
      sha256: sha256(server),
    },
    {
      id: `${resourceId}-library`,
      kind: "dynamic_library" as const,
      relativePath: "win-x64/cuda/ggml-cuda.dll",
      byteSize: library.length,
      sha256: sha256(library),
    },
  ];
  const pack: LocalSubtitleAcceleratorPackDefinition = Object.freeze({
    resourceId,
    displayName: `CUDA pack ${resourceId}`,
    version: resourceId,
    sourceArchive: {
      fileName: `${resourceId}.zip`,
      downloadUrl: `https://downloads.example.test/${resourceId}.zip`,
      allowedDownloadHosts: ["downloads.example.test"],
      byteSize: 64,
      sha256: "a".repeat(64),
    },
    installedByteSize: artifacts.reduce((total, artifact) => total + artifact.byteSize, 0),
    manifestRelativePath: "manifests/accelerator.json",
    manifestBytes,
    archiveContract: Object.freeze({
      archive: {
        byteSize: 64,
        sha256: "a".repeat(64),
        expandedFileCount: 2,
        expandedByteSize: artifacts.reduce(
          (total, artifact) => total + artifact.byteSize,
          0,
        ),
      },
      selectedEntries: artifacts.map((artifact) => ({
        archiveName: path.posix.basename(artifact.relativePath),
        outputRelativePath: artifact.relativePath,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
      })),
      excludedEntries: [],
      maxEntryBytes: 1024,
      maxCompressionRatio: 200,
    }),
    artifacts,
  });
  packBytes.set(pack, Object.freeze([server, library]));
  return pack;
}

async function materializePack(
  pack: LocalSubtitleAcceleratorPackDefinition,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const bytes = packBytes.get(pack);
  if (!bytes || bytes.length !== pack.artifacts.length) {
    throw new Error("Missing accelerator pack test bytes.");
  }
  for (const [index, artifact] of pack.artifacts.entries()) {
    const absolutePath = path.join(destination, ...artifact.relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, bytes[index]!);
  }
}

async function installExistingPack(
  managedRoot: string,
  pack: LocalSubtitleAcceleratorPackDefinition,
): Promise<void> {
  const finalPath = finalPackPath(managedRoot, pack);
  await materializePack(pack, finalPath);
  const manifestPath = path.join(finalPath, ...pack.manifestRelativePath.split("/"));
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, pack.manifestBytes);
}

function finalPackPath(
  managedRoot: string,
  pack: LocalSubtitleAcceleratorPackDefinition,
): string {
  return path.join(managedRoot, "accelerators", pack.resourceId);
}

function createPe(byteSize: number, fill: number): Buffer {
  const bytes = Buffer.alloc(byteSize, fill);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(0x8664, 68);
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
