import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from "../../src/type/localSubtitle";
import {
  LocalSubtitleAcceleratorManager,
  type LocalSubtitleAcceleratorPackDefinition,
  type LocalSubtitleVerifiedAcceleratorPack,
} from "../../electron/main/local-subtitle/accelerator-manager";
import { LocalSubtitleResourceJobManager } from "../../electron/main/local-subtitle/resource-job";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";
import { createPe } from "./runtimeFixture";

export interface LocalSubtitleAcceleratorFixture {
  readonly managedRoot: string;
  readonly pack: LocalSubtitleAcceleratorPackDefinition;
  readonly proof: LocalSubtitleVerifiedAcceleratorPack;
  cleanup(): Promise<void>;
}

export async function createAcceleratorFixture(): Promise<
  LocalSubtitleAcceleratorFixture
> {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-local-subtitle-accelerator-"),
  );
  const managedRoot = path.join(tempRoot, "managed");
  const server = createPe("x64");
  const library = Buffer.concat([createPe("x64"), Buffer.from([1])]);
  const resourceId = "local-subtitle-windows-x64-cuda-test-v1";
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, packId: resourceId }, null, 2)}\n`,
  );
  const artifacts = [
    {
      id: "whisper-server-win-x64-cuda-test",
      kind: "server" as const,
      relativePath: "win-x64/cuda/whisper-server.exe",
      byteSize: server.byteLength,
      sha256: sha256(server),
    },
    {
      id: "cuda-dependency-test-dll",
      kind: "dynamic_library" as const,
      relativePath: "win-x64/cuda/ggml-cuda.dll",
      byteSize: library.byteLength,
      sha256: sha256(library),
    },
  ];
  const pack: LocalSubtitleAcceleratorPackDefinition = Object.freeze({
    resourceId,
    displayName: "CUDA test accelerator",
    version: "v1.9.1+cuda-test",
    engine: { ...LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine },
    target: { platform: "win32", arch: "x64", backend: "cuda" },
    signatureKind: "unsigned",
    sourceArchive: {
      fileName: "cuda-test.zip",
      downloadUrl: "https://downloads.example.test/cuda-test.zip",
      allowedDownloadHosts: ["downloads.example.test"],
      byteSize: 64,
      sha256: "a".repeat(64),
    },
    installedByteSize: server.byteLength + library.byteLength,
    manifestRelativePath: "manifests/accelerator.json",
    manifestBytes,
    archiveContract: Object.freeze({
      archive: {
        byteSize: 64,
        sha256: "a".repeat(64),
        expandedFileCount: artifacts.length,
        expandedByteSize: server.byteLength + library.byteLength,
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
  const packRoot = path.join(managedRoot, "accelerators", resourceId);
  await Promise.all(artifacts.map(async (artifact, index) => {
    const absolutePath = path.join(
      packRoot,
      ...artifact.relativePath.split("/"),
    );
    await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, index === 0 ? server : library);
  }));
  const manifestPath = path.join(
    packRoot,
    ...pack.manifestRelativePath.split("/"),
  );
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, manifestBytes);

  const manager = new LocalSubtitleAcceleratorManager({
    managedResourceRoot: managedRoot,
    platform: "win32",
    arch: "x64",
    resourceJobs: new LocalSubtitleResourceJobManager(
      new LocalSubtitleSessionRegistry(),
    ),
    packs: [pack],
  });
  const proof = await manager.resolveManagedAccelerator(resourceId);
  return {
    managedRoot,
    pack,
    proof,
    cleanup: async () => {
      await manager.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
