import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_SUBTITLE_MODEL_MANIFEST } from "../../electron/main/local-subtitle/model-manifest";
import { LocalSubtitleModelManager } from "../../electron/main/local-subtitle/model-manager";
import {
  LocalSubtitleResourceJobManager,
} from "../../electron/main/local-subtitle/resource-job";
import {
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";
import {
  LocalSubtitleVadManager,
  LocalSubtitleVadManagerError,
  type LocalSubtitleVadDefinition,
  type LocalSubtitleVadManagerOptions,
} from "../../electron/main/local-subtitle/vad-manager";
import {
  createRuntimeFixture,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const OWNER_A = Object.freeze({
  webContentsId: 401,
  ownerSessionId: "vad-owner-a",
});
const OWNER_B = Object.freeze({
  webContentsId: 402,
  ownerSessionId: "vad-owner-b",
});
const tempRoots: string[] = [];
let runtimeFixture: LocalSubtitleRuntimeFixture;
let verifiedRuntime: LocalSubtitleVerifiedRuntimeBundle;

beforeAll(async () => {
  runtimeFixture = await createRuntimeFixture();
  verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
    environment: runtimeFixture.environment,
    scope: "server",
    signatureVerifier: async () => true,
  });
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  })));
});

afterAll(async () => {
  await runtimeFixture.cleanup();
});

describe("local subtitle VAD manager", () => {
  it("downloads, verifies, load-smokes, commits, resolves and deletes VAD", async () => {
    const fixture = await createFixture();

    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({
        resourceId: fixture.definition.resourceId,
        resourceType: "vad",
        status: "not_installed",
      }),
    ]);
    expect(
      fixture.manager.startResourceInstall(OWNER_A, fixture.definition.resourceId),
    ).toMatchObject({ resourceType: "vad", status: "queued" });
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      resourceId: fixture.definition.resourceId,
      resourceType: "vad",
      status: "completed",
      progress: 100,
      bytesCompleted: fixture.definition.byteSize,
      bytesTotal: fixture.definition.byteSize,
    });
    expect(fixture.smokeVadLoad).toHaveBeenCalledOnce();
    expect(fixture.smokeVadLoad.mock.calls[0]?.[1]).toMatchObject({
      purpose: "vad_load_smoke",
      backend: "cpu",
      model: { storage: "managed", id: "large-v3-q5_0" },
      vadModel: {
        storage: "managed_staging",
        id: fixture.definition.resourceId,
        byteSize: fixture.definition.byteSize,
        sha256: fixture.definition.sha256,
      },
      threads: 1,
    });
    const managed = await fixture.manager.resolveManagedVad(
      fixture.definition.resourceId,
    );
    expect(await readFile(managed.absolutePath)).toEqual(fixture.vadBytes);
    await expect(readdir(path.dirname(managed.absolutePath))).resolves.toEqual(
      expect.arrayContaining([
        fixture.definition.fileName,
        fixture.definition.manifestFileName,
      ]),
    );
    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
    ]);
    await expect(
      fixture.manager.deleteManagedResource(fixture.definition.resourceId),
    ).resolves.toEqual({ deleted: true });
    await expect(lstat(path.dirname(managed.absolutePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("claims installs synchronously across owners", async () => {
    const downloadStarted = deferred<void>();
    const finishDownload = deferred<void>();
    const fixture = await createFixture({
      downloadResource: async (options) => {
        downloadStarted.resolve();
        await finishDownload.promise;
        await writeFile(options.destinationPath, fixtureBytes);
      },
    });
    const fixtureBytes = fixture.vadBytes;

    fixture.manager.startResourceInstall(OWNER_A, fixture.definition.resourceId);
    expect(() =>
      fixture.manager.startResourceInstall(OWNER_B, fixture.definition.resourceId)
    ).toThrow(expect.objectContaining({ localSubtitleCode: "resource_busy" }));
    await downloadStarted.promise;
    finishDownload.resolve();
    await fixture.manager.waitForIdle();
  });

  it("fails before download without a ready model and remains retryable", async () => {
    const resolveSmokeModel = vi.fn()
      .mockRejectedValueOnce(new LocalSubtitleVadManagerError(
        "model_missing",
        "A ready managed model is required for VAD load smoke.",
      ))
      .mockResolvedValue(managedModel());
    const fixture = await createFixture({ resolveSmokeModel });

    fixture.manager.startResourceInstall(OWNER_A, fixture.definition.resourceId);
    await fixture.manager.waitForIdle();
    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_missing" },
    });
    expect(fixture.downloadResource).not.toHaveBeenCalled();

    fixture.manager.startResourceInstall(OWNER_A, fixture.definition.resourceId);
    await fixture.manager.waitForIdle();
    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[1]).toMatchObject({
      status: "completed",
    });
    expect(fixture.downloadResource).toHaveBeenCalledOnce();
  });

  it("rejects a same-size VAD with the wrong hash before smoke or commit", async () => {
    const fixture = await createFixture({
      downloadResource: async (options) => {
        await writeFile(options.destinationPath, Buffer.alloc(
          options.expectedBytes,
          0xff,
        ));
      },
    });

    fixture.manager.startResourceInstall(OWNER_A, fixture.definition.resourceId);
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "resource_signature_invalid" },
    });
    expect(fixture.smokeVadLoad).not.toHaveBeenCalled();
    await expect(fixture.manager.listManagedResources()).resolves.toEqual([
      expect.objectContaining({ status: "not_installed" }),
    ]);
  });

  it("quarantines a committed directory that fails post-commit verification", async () => {
    const definition = createDefinition();
    const fixture = await createFixture({
      definition,
      renameDirectory: async (source, destination) => {
        await rename(source, destination);
        if (path.dirname(destination).endsWith(`${path.sep}vad`)) {
          await writeFile(
            path.join(destination, definition.fileName),
            Buffer.alloc(definition.byteSize, 0xee),
          );
        }
      },
    });

    fixture.manager.startResourceInstall(OWNER_A, definition.resourceId);
    await fixture.manager.waitForIdle();

    expect(fixture.registry.getSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "resource_signature_invalid" },
    });
    await expect(lstat(path.join(
      fixture.managedRoot,
      "vad",
      definition.resourceId,
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(fixture.managedRoot, "vad-staging"))).resolves
      .toEqual([]);
  });

  it("refuses busy deletion and removes the resource after it becomes idle", async () => {
    let busy = false;
    const fixture = await createFixture({ isResourceBusy: () => busy });
    fixture.manager.startResourceInstall(OWNER_A, fixture.definition.resourceId);
    await fixture.manager.waitForIdle();

    busy = true;
    await expect(
      fixture.manager.deleteManagedResource(fixture.definition.resourceId),
    ).rejects.toMatchObject({ localSubtitleCode: "resource_busy" });
    busy = false;
    await expect(
      fixture.manager.deleteManagedResource(fixture.definition.resourceId),
    ).resolves.toEqual({ deleted: true });
    await expect(
      fixture.manager.deleteManagedResource(fixture.definition.resourceId),
    ).resolves.toEqual({ deleted: false });
  });

  it("routes VAD through the model manager managed-resource API", async () => {
    const definition = createDefinition();
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-vad-routing-"));
    tempRoots.push(root);
    const registry = new LocalSubtitleSessionRegistry();
    const downloadResource = vi.fn(async () => undefined);
    const manager = new LocalSubtitleModelManager({
      managedResourceRoot: path.join(root, "managed"),
      runtimeEnvironment: {
        mode: "development",
        appRoot: root,
        platform: "darwin",
        arch: "arm64",
      },
      supervisor: {
        smokeModelLoad: vi.fn(async () => undefined),
        smokeVadLoad: vi.fn(async () => undefined),
      },
      sessionRegistry: registry,
      modelCatalog: [LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!],
      verifyServerRuntime: async () => verifiedRuntime,
      vadOptions: { definition, downloadResource },
    });

    await expect(manager.listManagedResources(OWNER_A)).resolves.toEqual([
      expect.objectContaining({ resourceType: "model" }),
      expect.objectContaining({
        resourceId: definition.resourceId,
        resourceType: "vad",
        status: "not_installed",
      }),
    ]);
    expect(manager.startResourceInstall(OWNER_A, definition.resourceId)).toMatchObject({
      resourceType: "vad",
      status: "queued",
    });
    await manager.waitForIdle();
    expect(manager.getSessionSnapshot(OWNER_A).resourceJobs[0]).toMatchObject({
      resourceType: "vad",
      status: "failed",
      error: { code: "model_missing" },
    });
    expect(downloadResource).not.toHaveBeenCalled();
    await expect(
      manager.deleteManagedResource(OWNER_A, definition.resourceId),
    ).resolves.toEqual({ deleted: false });
  });
});

interface FixtureOverrides extends Partial<LocalSubtitleVadManagerOptions> {
  readonly downloadResource?: LocalSubtitleVadManagerOptions["downloadResource"];
}

async function createFixture(overrides: FixtureOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-vad-manager-"));
  tempRoots.push(root);
  const managedRoot = path.join(root, "managed");
  const definition = overrides.definition ?? createDefinition();
  const vadBytes = Buffer.alloc(definition.byteSize, 0x5a);
  const registry = new LocalSubtitleSessionRegistry();
  const resourceJobs = new LocalSubtitleResourceJobManager(registry);
  const smokeVadLoad = vi.fn(async () => undefined);
  const downloadResource = vi.fn(
    overrides.downloadResource ?? (async (options) => {
      await writeFile(options.destinationPath, vadBytes);
      options.onProgress?.(vadBytes.length, vadBytes.length);
      return {};
    }),
  );
  const manager = new LocalSubtitleVadManager({
    managedResourceRoot: managedRoot,
    platform: "darwin",
    resourceJobs,
    supervisor: { smokeVadLoad },
    resolveSmokeModel: async () => managedModel(managedRoot),
    verifyServerRuntime: async () => verifiedRuntime,
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    definition,
    ...overrides,
    downloadResource,
  });
  return {
    manager,
    registry,
    managedRoot,
    definition,
    vadBytes,
    smokeVadLoad,
    downloadResource,
  };
}

function createDefinition(): LocalSubtitleVadDefinition {
  const bytes = Buffer.alloc(4_096, 0x5a);
  return Object.freeze({
    resourceId: "silero-vad-test-ggml",
    displayName: "Silero VAD test fixture",
    version: "test-v1",
    fileName: "silero-vad.bin",
    downloadUrl: "https://example.com/silero-vad.bin",
    allowedDownloadHosts: Object.freeze(["example.com"]),
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    isDefault: true,
    manifestFileName: "manifest.json",
    manifestBytes: Buffer.from('{"fixture":"vad"}\n', "utf8"),
  });
}

function managedModel(managedRoot = path.join(os.tmpdir(), "fusionkit-model")) {
  return Object.freeze({
    storage: "managed" as const,
    id: "large-v3-q5_0",
    absolutePath: path.join(managedRoot, "models", "large-v3-q5_0", "model.bin"),
    byteSize: 1_081_140_203,
    sha256: "a".repeat(64),
  });
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
