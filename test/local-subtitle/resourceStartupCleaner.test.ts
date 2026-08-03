import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST } from "../../electron/main/local-subtitle/accelerator-manifest";
import {
  cleanupLocalSubtitleResourceStartupOrphans,
  type CleanupLocalSubtitleResourceStartupOptions,
  type LocalSubtitleStartupDownloadDefinition,
} from "../../electron/main/local-subtitle/resource-startup-cleaner";
import { LOCAL_SUBTITLE_VAD_MANIFEST } from "../../electron/main/local-subtitle/vad-manifest";

const roots: string[] = [];
const SOURCE_URL = "https://models.example.test/resource.bin";
const ALLOWED_HOSTS = ["models.example.test", "cdn.example.test"];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    })));
});

describe("local subtitle resource startup cleaner", () => {
  it("preserves a manifest-bound resumable download pair", async () => {
    const fixture = await createFixture([definition("test-model", 10)]);
    const partPath = path.join(fixture.downloads, "test-model.part");
    const metadataPath = path.join(fixture.downloads, "test-model.part.json");
    await writeFile(partPath, Buffer.from("1234"));
    await writeMetadata(metadataPath, {
      resourceId: "test-model",
      expectedBytes: 10,
      bytesCompleted: 4,
      etag: '"model-v1"',
    });

    const result = await fixture.cleanup();

    expect(result).toMatchObject({
      preservedDownloads: 1,
      removedDownloadStates: 0,
    });
    expect(await readFile(partPath, "utf8")).toBe("1234");
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
      bytesCompleted: 4,
      etag: '"model-v1"',
    });
  });

  it("removes one-sided, mismatched and validator-free known states only", async () => {
    const definitions = [
      definition("orphan-part", 10),
      definition("orphan-metadata", 10),
      definition("mismatched", 10),
      definition("no-validator", 10),
    ];
    const fixture = await createFixture(definitions);
    await writeFile(path.join(fixture.downloads, "orphan-part.part"), "1234");
    await writeMetadata(
      path.join(fixture.downloads, "orphan-metadata.part.json"),
      {
        resourceId: "orphan-metadata",
        expectedBytes: 10,
        bytesCompleted: 4,
        etag: '"orphan-v1"',
      },
    );
    for (const resourceId of ["mismatched", "no-validator"]) {
      await writeFile(path.join(fixture.downloads, `${resourceId}.part`), "1234");
      await writeMetadata(
        path.join(fixture.downloads, `${resourceId}.part.json`),
        {
          resourceId,
          expectedBytes: resourceId === "mismatched" ? 11 : 10,
          bytesCompleted: 4,
          ...(resourceId === "no-validator" ? {} : { etag: '"state-v1"' }),
        },
      );
    }
    const temporaryMetadata = path.join(
      fixture.downloads,
      `orphan-part.part.json.tmp-${uuid(90)}`,
    );
    await writeFile(temporaryMetadata, "temporary");
    await writeFile(path.join(fixture.downloads, "unknown.part"), "keep");
    await writeFile(path.join(fixture.downloads, "unknown.part.json"), "keep");

    const result = await fixture.cleanup();

    expect(result).toMatchObject({
      removedDownloadStates: 4,
      removedMetadataTemporaries: 1,
    });
    expect((await readdir(fixture.downloads)).sort()).toEqual([
      "unknown.part",
      "unknown.part.json",
    ]);
  });

  it("cleans exact model, VAD and accelerator staging names but ignores unknown leaves", async () => {
    const fixture = await createFixture([definition("test-model", 10)], {
      platform: "win32",
      arch: "x64",
    });
    const candidates = [
      path.join(fixture.managedRoot, "model-staging", `.import-${uuid(1)}-Ab12Cd`),
      path.join(
        fixture.managedRoot,
        "vad-staging",
        `.install-${LOCAL_SUBTITLE_VAD_MANIFEST.vad.id}-${uuid(2)}-Xy12Z9`,
      ),
      path.join(
        fixture.managedRoot,
        "accelerator-staging",
        `.superseded-${LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.packId}-${uuid(3)}`,
      ),
    ];
    await Promise.all(candidates.map((candidate) =>
      mkdir(candidate, { recursive: true, mode: 0o700 })));
    const unknown = path.join(
      fixture.managedRoot,
      "model-staging",
      `.import-not-a-production-id-${uuid(4)}`,
    );
    await mkdir(unknown, { recursive: true, mode: 0o700 });

    const result = await fixture.cleanup({
      quarantineIdFactory: sequentialUuidFactory(20),
    });

    expect(result.removedStagingDirectories).toBe(3);
    await Promise.all(candidates.map((candidate) =>
      expect(lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" })));
    await expect(lstat(unknown)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("leaves an exact-name symlink untouched while settling other cleanup work", async () => {
    const fixture = await createFixture([definition("test-model", 10)]);
    const target = path.join(fixture.root, "outside.bin");
    const partPath = path.join(fixture.downloads, "test-model.part");
    await writeFile(target, "outside");
    await symlink(target, partPath);
    const staging = path.join(
      fixture.managedRoot,
      "model-staging",
      `.cleanup-${uuid(5)}`,
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });

    await expect(fixture.cleanup()).rejects.toThrow(
      "download state is not an owned regular file",
    );

    expect((await lstat(partPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("outside");
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks directory identity after quarantine rename and keeps replacements", async () => {
    const fixture = await createFixture([definition("test-model", 10)]);
    const candidate = path.join(
      fixture.managedRoot,
      "model-staging",
      `.delete-${uuid(6)}`,
    );
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const quarantineId = uuid(7);

    await expect(fixture.cleanup({
      quarantineIdFactory: () => quarantineId,
      renameDirectory: async (source, destination) => {
        await rename(source, destination);
        await rm(destination, { recursive: true, force: false });
        await mkdir(destination, { mode: 0o700 });
      },
    })).rejects.toThrow("object changed identity");

    const replacement = path.join(
      fixture.managedRoot,
      "model-staging",
      `.startup-cleanup-${quarantineId}`,
    );
    await expect(lstat(replacement)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("attempts every staging cleanup and preserves the first failure object", async () => {
    const fixture = await createFixture([definition("test-model", 10)]);
    const stagingRoot = path.join(fixture.managedRoot, "model-staging");
    await Promise.all([
      mkdir(path.join(stagingRoot, `.cleanup-${uuid(8)}`), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(path.join(stagingRoot, `.delete-${uuid(9)}`), {
        recursive: true,
        mode: 0o700,
      }),
    ]);
    const failure = new Error("expected cleanup failure");
    const removeDirectory = vi.fn(async () => {
      throw failure;
    });

    await expect(fixture.cleanup({
      quarantineIdFactory: sequentialUuidFactory(30),
      removeDirectory,
    })).rejects.toBe(failure);
    expect(removeDirectory).toHaveBeenCalledTimes(2);
  });
});

function definition(
  resourceId: string,
  expectedBytes: number,
): LocalSubtitleStartupDownloadDefinition {
  return Object.freeze({
    resourceId,
    sourceUrl: SOURCE_URL,
    allowedHosts: ALLOWED_HOSTS,
    expectedBytes,
    downloadDirectoryName: "downloads",
  });
}

async function createFixture(
  downloadDefinitions: readonly LocalSubtitleStartupDownloadDefinition[],
  defaults: Partial<CleanupLocalSubtitleResourceStartupOptions> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-startup-cleaner-"));
  roots.push(root);
  const managedRoot = path.join(root, "managed");
  const baseOptions: CleanupLocalSubtitleResourceStartupOptions = {
    managedResourceRoot: managedRoot,
    platform: process.platform,
    arch: process.arch,
    downloadDefinitions,
    quarantineIdFactory: sequentialUuidFactory(100),
    ...defaults,
  };
  await cleanupLocalSubtitleResourceStartupOrphans(baseOptions);
  return {
    root,
    managedRoot,
    downloads: path.join(managedRoot, "downloads"),
    cleanup: (overrides: Partial<CleanupLocalSubtitleResourceStartupOptions> = {}) =>
      cleanupLocalSubtitleResourceStartupOrphans({
        ...baseOptions,
        ...overrides,
      }),
  };
}

async function writeMetadata(
  absolutePath: string,
  options: {
    readonly resourceId: string;
    readonly expectedBytes: number;
    readonly bytesCompleted: number;
    readonly etag?: string;
  },
): Promise<void> {
  await writeFile(absolutePath, `${JSON.stringify({
    schemaVersion: 1,
    sourceUrl: SOURCE_URL,
    effectiveUrl: SOURCE_URL,
    expectedBytes: options.expectedBytes,
    bytesCompleted: options.bytesCompleted,
    ...(options.etag === undefined ? {} : { etag: options.etag }),
  })}\n`);
}

function sequentialUuidFactory(start: number): () => string {
  let next = start;
  return () => uuid(next++);
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
