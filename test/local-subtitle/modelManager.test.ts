import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { LocalSubtitleResourceEventEnvelope } from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_MODEL_MANIFEST,
  LocalSubtitleModelError,
  type LocalSubtitleModelManifestEntry,
} from "../../electron/main/local-subtitle/model-manifest";
import {
  verifyLocalSubtitleGgmlModelFile,
} from "../../electron/main/local-subtitle/ggml-model";
import {
  LocalSubtitleModelManager,
  type LocalSubtitleModelManagerOptions,
  type LocalSubtitleModelLoadSmokeTarget,
} from "../../electron/main/local-subtitle/model-manager";
import {
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";
import {
  createRuntimeFixture,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const OWNER = Object.freeze({ webContentsId: 41, ownerSessionId: "owner-model-a" });
const OWNER_B = Object.freeze({ webContentsId: 42, ownerSessionId: "owner-model-b" });
const tempRoots: string[] = [];
let runtimeFixture: LocalSubtitleRuntimeFixture;
let verifiedRuntime: LocalSubtitleVerifiedRuntimeBundle;
let verifiedMediaRuntime: LocalSubtitleVerifiedRuntimeBundle;

beforeAll(async () => {
  runtimeFixture = await createRuntimeFixture();
  verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
    environment: runtimeFixture.environment,
    scope: "server",
    signatureVerifier: async () => true,
  });
  verifiedMediaRuntime = await verifyLocalSubtitleRuntimeBundle({
    environment: runtimeFixture.environment,
    scope: "media",
    signatureVerifier: async () => true,
  });
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await runtimeFixture.cleanup();
});

describe("local subtitle model manager", () => {
  it("shares one startup cleanup operation and gates resources until it completes", async () => {
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const startupCleanup = vi.fn(() => cleanupGate);
    const fixture = await createFixture({ startupCleanup });

    const first = fixture.manager.initialize();
    const second = fixture.manager.initialize();
    expect(second).toBe(first);
    expect(() => fixture.manager.getSessionSnapshot(OWNER)).toThrowError(
      expect.objectContaining({ localSubtitleCode: "resource_busy" }),
    );
    releaseCleanup();
    await first;

    expect(startupCleanup).toHaveBeenCalledOnce();
    expect(fixture.manager.getSessionSnapshot(OWNER)).toMatchObject({
      resourceJobs: [],
    });
  });

  it("locks a startup cleanup failure and fails managed-resource APIs closed", async () => {
    const failure = new Error("startup cleanup failed");
    const fixture = await createFixture({
      startupCleanup: async () => {
        throw failure;
      },
    });

    const initialization = fixture.manager.initialize();
    await expect(initialization).rejects.toBe(failure);
    expect(fixture.manager.initialize()).toBe(initialization);
    expect(() => fixture.manager.getSessionSnapshot(OWNER)).toThrowError(
      expect.objectContaining({ localSubtitleCode: "resource_not_allowed" }),
    );
  });

  it("downloads, verifies, load-smokes and commits an allowlisted model", async () => {
    const fixture = await createFixture({
      downloadResource: async (options) => {
        await writeFile(options.destinationPath, fixtureBytes);
        options.onProgress?.(fixtureBytes.length, fixtureBytes.length);
        return {};
      },
    });
    const fixtureBytes = fixture.bytes;

    const queued = fixture.manager.startResourceInstall(
      OWNER,
      fixture.model.id,
    );
    expect(queued).toMatchObject({
      resourceId: fixture.model.id,
      resourceType: "model",
      status: "queued",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.manager.getSessionSnapshot(OWNER)).toMatchObject({
      resourceJobs: [
        {
          resourceId: fixture.model.id,
          status: "completed",
          progress: 100,
          bytesCompleted: fixture.model.byteSize,
          bytesTotal: fixture.model.byteSize,
        },
      ],
    });
    await expect(fixture.manager.listManagedResources(OWNER)).resolves.toMatchObject([
      { resourceId: fixture.model.id, status: "ready" },
    ]);
    expect(fixture.smoke).toHaveBeenCalledOnce();
  });

  it("claims the model before the first await and hides another owner's job", async () => {
    const fixture = await createFixture({
      downloadResource: async (options) => {
        await writeFile(options.destinationPath, fixtureBytes);
        return {};
      },
    });
    const fixtureBytes = fixture.bytes;

    fixture.manager.startResourceInstall(OWNER, fixture.model.id);
    expect(() =>
      fixture.manager.startResourceInstall(OWNER_B, fixture.model.id)
    ).toThrow(expect.objectContaining({ localSubtitleCode: "resource_busy" }));
    expect(fixture.manager.getSessionSnapshot(OWNER_B)).toMatchObject({
      revision: 0,
      resourceJobs: [],
    });
    await fixture.manager.waitForIdle();
  });

  it("refuses busy deletion and removes an idle managed model", async () => {
    let busy = false;
    const fixture = await createFixture({
      downloadResource: async (options) => {
        await writeFile(options.destinationPath, fixtureBytes);
        return {};
      },
      isResourceBusy: () => busy,
    });
    const fixtureBytes = fixture.bytes;
    fixture.manager.startResourceInstall(OWNER, fixture.model.id);
    await fixture.manager.waitForIdle();

    busy = true;
    await expect(
      fixture.manager.deleteManagedResource(OWNER, fixture.model.id),
    ).rejects.toMatchObject({ localSubtitleCode: "resource_busy" });
    busy = false;
    await expect(
      fixture.manager.deleteManagedResource(OWNER, fixture.model.id),
    ).resolves.toEqual({ deleted: true });
    await expect(fixture.manager.listManagedResources(OWNER)).resolves.toMatchObject([
      { resourceId: fixture.model.id, status: "not_installed" },
    ]);
    await expect(
      fixture.manager.deleteManagedResource(OWNER, fixture.model.id),
    ).resolves.toEqual({ deleted: false });
  });

  it("copies, verifies, load-smokes and atomically commits a managed model", async () => {
    const fixture = await createFixture();
    const statuses: string[] = [];
    fixture.manager.onResourceEvent(OWNER, (envelope) => {
      if (envelope.event.type === "resource-job-updated") {
        statuses.push(envelope.event.job.status);
      }
    });

    const queued = fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    expect(queued).toMatchObject({
      resourceId: fixture.model.id,
      status: "queued",
      progress: 0,
    });
    await fixture.manager.waitForIdle();

    await expect(lstat(fixture.sourcePath)).resolves.toMatchObject({
      size: fixture.bytes.length,
    });
    const managed = await fixture.manager.resolveManagedModel(fixture.model.id);
    expect(managed).toMatchObject({
      storage: "managed",
      id: fixture.model.id,
      byteSize: fixture.bytes.length,
      sha256: fixture.model.sha256,
    });
    expect(await readFile(managed.absolutePath)).toEqual(fixture.bytes);
    expect(fixture.smoke).toHaveBeenCalledOnce();
    expect(fixture.smoke.mock.calls[0]?.[1]).toMatchObject({
      purpose: "model_load_smoke",
      backend: "cpu",
      model: {
        storage: "managed_staging",
        id: fixture.model.id,
      },
    });
    expect(fixture.smoke.mock.calls[0]?.[1]).not.toHaveProperty("vadModel");
    expect(statuses).toEqual(expect.arrayContaining([
      "acquiring",
      "verifying",
      "load_smoke",
      "committing",
      "completed",
    ]));
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "completed",
      progress: 100,
      bytesCompleted: fixture.bytes.length,
      bytesTotal: fixture.bytes.length,
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);

    const listed = await fixture.manager.listManagedResources(OWNER);
    expect(listed).toEqual([
      expect.objectContaining({
        resourceId: fixture.model.id,
        status: "ready",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(fixture.managedRoot);
    expect(JSON.stringify(fixture.manager.getSessionSnapshot(OWNER))).not.toContain(
      fixture.sourcePath,
    );
  });

  it("deletes the source only after a successful explicit move commit", async () => {
    const fixture = await createFixture();

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await fixture.manager.waitForIdle();

    await expect(lstat(fixture.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fixture.manager.resolveManagedModel(fixture.model.id)).resolves.toMatchObject({
      storage: "managed",
      id: fixture.model.id,
    });
  });

  it("preserves a move source and removes staging when load smoke fails", async () => {
    const fixture = await createFixture({
      smoke: vi.fn(async () => {
        throw new Error("smoke rejected");
      }),
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await fixture.manager.waitForIdle();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_download_failed" },
    });
    await expect(fixture.manager.resolveManagedModel(fixture.model.id)).rejects.toMatchObject({
      localSubtitleCode: "model_missing",
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("preserves a missing CPU server as a runtime resource failure", async () => {
    const fixture = await createFixture({
      verifyServerRuntime: async () => verifiedMediaRuntime,
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.smoke).not.toHaveBeenCalled();
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "runtime_missing" },
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("rolls back a committed move when deleting the source fails", async () => {
    const fixture = await createFixture({
      removeSourceFile: async () => {
        throw new Error("unlink denied");
      },
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await fixture.manager.waitForIdle();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_download_failed" },
    });
    await expect(fixture.manager.resolveManagedModel(fixture.model.id)).rejects.toMatchObject({
      localSubtitleCode: "model_missing",
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("fails before copying when verified free space is insufficient", async () => {
    const fixture = await createFixture({ availableBytes: async () => 1 });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.smoke).not.toHaveBeenCalled();
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_disk_full" },
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("rejects a CTranslate2-style directory without invoking the runner", async () => {
    const fixture = await createFixture();
    const modelDirectory = path.join(fixture.root, "ctranslate2-large-v3");
    await mkdir(modelDirectory);
    await writeFile(path.join(modelDirectory, "model.bin"), "not ggml");

    fixture.manager.importModel({
      owner: OWNER,
      filePath: modelDirectory,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.smoke).not.toHaveBeenCalled();
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_incompatible" },
    });
  });

  it("rejects a symbolic-link source without following it", async () => {
    const fixture = await createFixture();
    const linkPath = path.join(fixture.root, "linked-model.bin");
    await symlink(fixture.sourcePath, linkPath);

    fixture.manager.importModel({
      owner: OWNER,
      filePath: linkPath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.smoke).not.toHaveBeenCalled();
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_incompatible" },
    });
  });

  it("rejects a same-size hash mismatch and removes its staged copy", async () => {
    const fixture = await createFixture();
    const corrupted = Buffer.from(fixture.bytes);
    corrupted[corrupted.length - 1] ^= 0xff;
    await writeFile(fixture.sourcePath, corrupted);

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.smoke).not.toHaveBeenCalled();
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_corrupt" },
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("cancels during copy and leaves neither a managed model nor staging", async () => {
    const fixture = await createFixture({ payloadBytes: 4 * 1024 * 1024 });
    let requested = false;
    fixture.manager.onResourceEvent(OWNER, (envelope) => {
      if (
        !requested &&
        envelope.event.type === "resource-job-updated" &&
        envelope.event.job.status === "acquiring" &&
        (envelope.event.job.bytesCompleted ?? 0) > 0
      ) {
        requested = true;
        fixture.manager.cancelResourceJob(OWNER, envelope.event.job.jobId);
      }
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(requested).toBe(true);
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "cancelled",
    });
    await expect(lstat(fixture.sourcePath)).resolves.toMatchObject({
      size: fixture.bytes.length,
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
    await expect(fixture.manager.resolveManagedModel(fixture.model.id)).rejects.toMatchObject({
      localSubtitleCode: "model_missing",
    });
  });

  it("reports an existing managed model as a conflict without replacing it", async () => {
    const fixture = await createFixture();
    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();
    const first = await fixture.manager.resolveManagedModel(fixture.model.id);
    const firstBytes = await readFile(first.absolutePath);

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs.at(-1)).toMatchObject({
      status: "failed",
      error: { code: "resource_busy" },
    });
    expect(await readFile(first.absolutePath)).toEqual(firstBytes);
  });

  it("does not accept a source path from inside the managed root", async () => {
    const fixture = await createFixture();
    const internalSource = path.join(fixture.managedRoot, "selected-model.bin");
    await mkdir(fixture.managedRoot, { recursive: true });
    await writeFile(internalSource, fixture.bytes);

    fixture.manager.importModel({
      owner: OWNER,
      filePath: internalSource,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "resource_not_allowed" },
    });
  });

  it("fences owner release, aborts smoke and waits for staging cleanup", async () => {
    let smokeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      smokeStarted = resolve;
    });
    const fixture = await createFixture({
      smoke: vi.fn((_owner, _options, signal) => {
        smokeStarted();
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    });
    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await started;

    fixture.manager.releaseOwner(OWNER);
    await fixture.manager.waitForIdle();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
    expect(() => fixture.manager.getSessionSnapshot(OWNER)).toThrowError(
      expect.objectContaining({ code: "owner_released" }),
    );
  });

  it("leaves an injected session registry for the composite owner to release", async () => {
    const sessionRegistry = new LocalSubtitleSessionRegistry();
    const fixture = await createFixture({ sessionRegistry });
    expect(fixture.manager.getSessionSnapshot(OWNER)).toMatchObject({
      revision: 0,
      batches: [],
      resourceJobs: [],
    });

    fixture.manager.releaseOwner(OWNER);

    expect(() => fixture.manager.getSessionSnapshot(OWNER)).toThrow(
      expect.objectContaining({ localSubtitleCode: "owner_released" }),
    );
    await expect(fixture.manager.listManagedResources(OWNER)).rejects.toMatchObject({
      localSubtitleCode: "owner_released",
    });
    expect(sessionRegistry.getSnapshot(OWNER)).toMatchObject({
      revision: 0,
      batches: [],
      resourceJobs: [],
    });

    expect(sessionRegistry.releaseOwner(OWNER)).toBe(true);
    expect(() => sessionRegistry.getSnapshot(OWNER)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
  });

  it("invalidates a cached ready model when its managed file changes", async () => {
    const fixture = await createFixture();
    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();
    const managed = await fixture.manager.resolveManagedModel(fixture.model.id);
    const replacement = Buffer.from(fixture.bytes);
    replacement[replacement.length - 1] ^= 0xff;
    await writeFile(managed.absolutePath, replacement);

    await expect(fixture.manager.listManagedResources(OWNER)).resolves.toEqual([
      expect.objectContaining({
        resourceId: fixture.model.id,
        status: "invalid",
        errorCode: "model_corrupt",
      }),
    ]);
  });

  it("keeps resource events and snapshots on one monotonic owner revision", async () => {
    const fixture = await createFixture();
    const events: LocalSubtitleResourceEventEnvelope[] = [];
    fixture.manager.onResourceEvent(OWNER, (event) => events.push(event));

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(events.length).toBeGreaterThan(5);
    expect(events.map((event) => event.revision)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(fixture.manager.getSessionSnapshot(OWNER)).toMatchObject({
      revision: events.length,
      batches: [],
    });
  });

  it("deep-validates an injected catalog before any filesystem access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-model-catalog-"));
    tempRoots.push(root);
    const managedRoot = path.join(root, "managed");
    const base = LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!;
    const supervisor: LocalSubtitleModelLoadSmokeTarget = {
      smokeModelLoad: vi.fn(async () => undefined),
    };
    const createManager = (model: LocalSubtitleModelManifestEntry) =>
      new LocalSubtitleModelManager({
        managedResourceRoot: managedRoot,
        runtimeEnvironment: {
          mode: "development",
          appRoot: root,
          platform: "darwin",
          arch: "arm64",
        },
        supervisor,
        modelCatalog: [model],
      });

    for (const model of [
      { ...base, id: "../../escaped-model" },
      { ...base, fileName: "../escaped.bin" },
      { ...base, fileName: "model.bin:stream" },
      { ...base, fileName: "model.bin." },
    ] as LocalSubtitleModelManifestEntry[]) {
      expect(() => createManager(model)).toThrowError(LocalSubtitleModelError);
    }

    const mutable = {
      ...base,
      id: "safe-test-model",
      fileName: "ggml-safe-test-model.bin",
      ggml: {
        ...base.ggml,
        headerInt32Le: [...base.ggml.headerInt32Le],
      },
    } as LocalSubtitleModelManifestEntry;
    const manager = createManager(mutable);
    (mutable as { id: string }).id = "../../mutated";
    (mutable as { fileName: string }).fileName = "../mutated.bin";

    await expect(manager.listManagedResources(OWNER)).resolves.toEqual([
      expect.objectContaining({
        resourceId: "safe-test-model",
        status: "not_installed",
      }),
    ]);
    await expect(lstat(managedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an incomplete empty model directory as invalid and non-installable", async () => {
    const fixture = await createFixture();
    const modelDirectory = path.join(
      fixture.managedRoot,
      "models",
      fixture.model.id,
    );
    await mkdir(modelDirectory, { recursive: true, mode: 0o700 });

    await expect(fixture.manager.listManagedResources(OWNER)).resolves.toEqual([
      expect.objectContaining({
        resourceId: fixture.model.id,
        status: "invalid",
        errorCode: "model_corrupt",
      }),
    ]);

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "resource_busy" },
    });
  });

  it("reports symbolic-link and non-directory model placeholders as invalid", async () => {
    for (const placeholder of ["symlink", "file"] as const) {
      const fixture = await createFixture();
      const modelsRoot = path.join(fixture.managedRoot, "models");
      const modelDirectory = path.join(modelsRoot, fixture.model.id);
      await mkdir(modelsRoot, { recursive: true, mode: 0o700 });
      if (placeholder === "symlink") {
        const outside = path.join(fixture.root, "outside-model-placeholder");
        await mkdir(outside, { mode: 0o700 });
        await symlink(outside, modelDirectory, "dir");
      } else {
        await writeFile(modelDirectory, "not a model directory");
      }

      await expect(fixture.manager.listManagedResources(OWNER)).resolves.toEqual([
        expect.objectContaining({
          resourceId: fixture.model.id,
          status: "invalid",
          errorCode: "resource_not_allowed",
        }),
      ]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects any existing model root with non-private permissions",
    async () => {
      for (const rootName of ["managed", "models", "model-staging"] as const) {
        const fixture = await createFixture();
        await mkdir(fixture.managedRoot, { recursive: true, mode: 0o700 });
        const target = rootName === "managed"
          ? fixture.managedRoot
          : path.join(fixture.managedRoot, rootName);
        if (target !== fixture.managedRoot) {
          await mkdir(target, { mode: 0o700 });
        }
        await chmod(target, 0o755);

        fixture.manager.importModel({
          owner: OWNER,
          filePath: fixture.sourcePath,
          mode: "move",
        });
        await fixture.manager.waitForIdle();

        expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
        expect(fixture.smoke).not.toHaveBeenCalled();
        expect(
          fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0],
        ).toMatchObject({
          status: "failed",
          error: { code: "resource_not_allowed" },
        });
      }
    },
  );

  it("revalidates the staging root after the disk-space probe", async () => {
    let outsideRoot = "";
    const fixture = await createFixture({
      availableBytes: async (stagingRoot) => {
        outsideRoot = path.join(path.dirname(path.dirname(stagingRoot)), "outside-staging");
        await mkdir(outsideRoot, { mode: 0o700 });
        await rename(stagingRoot, `${stagingRoot}-original`);
        await symlink(outsideRoot, stagingRoot, "dir");
        return Number.MAX_SAFE_INTEGER;
      },
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await fixture.manager.waitForIdle();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(await readdir(outsideRoot)).toEqual([]);
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "resource_not_allowed" },
    });
  });

  it("revalidates the models root after load smoke before committing", async () => {
    let outsideRoot = "";
    const fixture = await createFixture({
      smoke: vi.fn(async (_owner, options) => {
        const stagingRoot = path.dirname(path.dirname(options.model.absolutePath));
        const managedRoot = path.dirname(stagingRoot);
        const modelsRoot = path.join(managedRoot, "models");
        outsideRoot = path.join(path.dirname(managedRoot), "outside-models");
        await mkdir(outsideRoot, { mode: 0o700 });
        await rename(modelsRoot, `${modelsRoot}-original`);
        await symlink(outsideRoot, modelsRoot, "dir");
      }),
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await fixture.manager.waitForIdle();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(await readdir(outsideRoot)).toEqual([]);
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "resource_not_allowed" },
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("rejects same-mode root replacements after capturing their identities", async () => {
    for (const rootName of ["managed", "models", "model-staging"] as const) {
      const fixture = await createFixture();
      fixture.manager.importModel({
        owner: OWNER,
        filePath: fixture.sourcePath,
        mode: "copy",
      });
      await fixture.manager.waitForIdle();
      const target = rootName === "managed"
        ? fixture.managedRoot
        : path.join(fixture.managedRoot, rootName);
      await rename(target, `${target}-replaced`);
      await mkdir(target, { mode: 0o700 });

      await expect(fixture.manager.listManagedResources(OWNER)).resolves.toEqual([
        expect.objectContaining({
          resourceId: fixture.model.id,
          status: "invalid",
          errorCode: "resource_not_allowed",
        }),
      ]);
    }
  });

  it("rolls back both final and staging paths when post-link identity validation fails", async () => {
    const fixture = await createFixture({
      commitModelLink: async (source, destination) => {
        await link(source, destination);
        const changed = Buffer.from(await readFile(destination));
        changed[changed.length - 1] ^= 0xff;
        await writeFile(destination, changed);
      },
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_corrupt" },
    });
    await expect(
      lstat(path.join(fixture.managedRoot, "models", fixture.model.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("binds a verifier result to the exact staged file identity", async () => {
    const fixture = await createFixture({
      verifyModelFile: async (filePath, expected, signal) => {
        const verification = await verifyLocalSubtitleGgmlModelFile(
          filePath,
          expected,
          signal,
        );
        const bytes = await readFile(filePath);
        await unlink(filePath);
        await writeFile(filePath, bytes, { mode: 0o600 });
        return verification;
      },
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.smoke).not.toHaveBeenCalled();
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_corrupt" },
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("does not downgrade a commit-phase cancellation failure to cancelled", async () => {
    const fixture = await createFixture({
      commitModelLink: async () => {
        throw new Error("commit denied");
      },
    });
    fixture.manager.onResourceEvent(OWNER, (envelope) => {
      if (
        envelope.event.type === "resource-job-updated" &&
        envelope.event.job.status === "committing"
      ) {
        fixture.manager.cancelResourceJob(OWNER, envelope.event.job.jobId);
      }
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();

    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_download_failed" },
    });
  });

  it("treats a no-op source remover as a failed move and restores the source", async () => {
    const fixture = await createFixture({
      removeSourceFile: async () => undefined,
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await fixture.manager.waitForIdle();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_download_failed" },
    });
    await expect(fixture.manager.resolveManagedModel(fixture.model.id)).rejects.toMatchObject({
      localSubtitleCode: "model_missing",
    });
    expect(
      (await readdir(fixture.root)).filter((name) =>
        name.startsWith(".fusionkit-model-move-"),
      ),
    ).toEqual([]);
  });

  it("does not claim a pre-existing same-inode move quarantine", async () => {
    const fixture = await createFixture({
      stagingIdFactory: () => "existing",
    });
    const preExistingPath = path.join(
      fixture.root,
      ".fusionkit-model-move-existing",
    );
    await link(fixture.sourcePath, preExistingPath);

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await fixture.manager.waitForIdle();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    expect(await readFile(preExistingPath)).toEqual(fixture.bytes);
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "model_download_failed" },
    });
    await expect(fixture.manager.resolveManagedModel(fixture.model.id)).rejects.toMatchObject({
      localSubtitleCode: "model_missing",
    });
  });

  it("retains the managed copy when source deletion reports failure after unlink", async () => {
    const fixture = await createFixture({
      removeSourceFile: async (quarantinePath) => {
        await unlink(quarantinePath);
        throw new Error("unlink completion was not acknowledged");
      },
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await expect(fixture.manager.waitForIdle()).rejects.toMatchObject({
      localSubtitleCode: "cancel_failed",
    });

    await expect(lstat(fixture.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.manager.getSessionSnapshot(OWNER).resourceJobs[0]).toMatchObject({
      status: "failed",
      error: { code: "cancel_failed" },
    });
    await expect(fixture.manager.listManagedResources(OWNER)).resolves.toEqual([
      expect.objectContaining({
        resourceId: fixture.model.id,
        status: "invalid",
        errorCode: "cancel_failed",
      }),
    ]);
    const retainedPath = path.join(
      fixture.managedRoot,
      "models",
      fixture.model.id,
      fixture.model.fileName,
    );
    expect(await readFile(retainedPath)).toEqual(fixture.bytes);
    await expect(fixture.manager.shutdown()).rejects.toMatchObject({
      localSubtitleCode: "cancel_failed",
    });
  });

  it("retries a blocked source restore before rolling back the managed copy", async () => {
    const fixture = await createFixture({
      removeSourceFile: async (quarantinePath) => {
        const sourcePath = path.join(
          path.dirname(quarantinePath),
          "selected-model.bin",
        );
        await writeFile(sourcePath, "replacement");
        throw new Error("source path occupied");
      },
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "move",
    });
    await expect(fixture.manager.waitForIdle()).rejects.toMatchObject({
      localSubtitleCode: "cancel_failed",
    });
    await expect(fixture.manager.shutdown()).rejects.toMatchObject({
      localSubtitleCode: "cancel_failed",
    });
    await unlink(fixture.sourcePath);

    await fixture.manager.shutdown();

    expect(await readFile(fixture.sourcePath)).toEqual(fixture.bytes);
    await expect(
      lstat(path.join(fixture.managedRoot, "models", fixture.model.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(fixture.root)).filter((name) =>
        name.startsWith(".fusionkit-model-move-"),
      ),
    ).toEqual([]);
  });

  it("rediscovers a moved cleanup quarantine and serializes retry with shutdown", async () => {
    let removeCalls = 0;
    const fixture = await createFixture({
      smoke: vi.fn(async () => {
        throw new Error("smoke rejected");
      }),
      removeStagingDirectory: async (quarantinePath) => {
        removeCalls += 1;
        if (removeCalls === 1) {
          await rename(
            quarantinePath,
            path.join(path.dirname(quarantinePath), ".cleanup-relocated-12345678"),
          );
          throw new Error("cleanup interrupted after rename");
        }
        if (removeCalls === 2) throw new Error("cleanup still blocked");
        await rm(quarantinePath, { recursive: true, force: false });
      },
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await expect(fixture.manager.waitForIdle()).rejects.toMatchObject({
      localSubtitleCode: "cancel_failed",
    });
    expect(await stagingEntries(fixture.managedRoot)).toEqual([
      ".cleanup-relocated-12345678",
    ]);

    const firstShutdown = fixture.manager.shutdown();
    const secondShutdown = fixture.manager.shutdown();
    expect(firstShutdown).toBe(secondShutdown);
    await Promise.all([firstShutdown, secondShutdown]);

    expect(removeCalls).toBe(3);
    expect(await stagingEntries(fixture.managedRoot)).toEqual([]);
  });

  it("does not accept a no-op staging remover as cleanup proof", async () => {
    const fixture = await createFixture({
      smoke: vi.fn(async () => {
        throw new Error("smoke rejected");
      }),
      removeStagingDirectory: async () => undefined,
    });

    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await expect(fixture.manager.waitForIdle()).rejects.toMatchObject({
      localSubtitleCode: "cancel_failed",
    });

    expect(await stagingEntries(fixture.managedRoot)).toEqual([
      expect.stringMatching(/^\.cleanup-/u),
    ]);
    await expect(fixture.manager.shutdown()).rejects.toMatchObject({
      localSubtitleCode: "cancel_failed",
    });
  });

  it("rejects non-canonical metadata returned by a managed verifier", async () => {
    const fixture = await createFixture();
    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();
    const secondManager = new LocalSubtitleModelManager({
      managedResourceRoot: fixture.managedRoot,
      runtimeEnvironment: {
        mode: "development",
        appRoot: fixture.root,
        platform: "darwin",
        arch: "arm64",
      },
      supervisor: fixture.supervisor,
      modelCatalog: [fixture.model],
      verifyModelFile: async (filePath, expected, signal) => {
        const verification = await verifyLocalSubtitleGgmlModelFile(
          filePath,
          expected,
          signal,
        );
        return {
          ...verification,
          modelId: "wrong-model",
          absolutePath: path.join(fixture.root, "outside.bin"),
          sha256: "f".repeat(64),
        };
      },
    });

    await expect(
      secondManager.resolveManagedModel(fixture.model.id),
    ).rejects.toMatchObject({ localSubtitleCode: "model_corrupt" });
  });

  it("aborts an owner-bound managed verification on owner release", async () => {
    const fixture = await createFixture();
    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const secondManager = new LocalSubtitleModelManager({
      managedResourceRoot: fixture.managedRoot,
      runtimeEnvironment: {
        mode: "development",
        appRoot: fixture.root,
        platform: "darwin",
        arch: "arm64",
      },
      supervisor: fixture.supervisor,
      modelCatalog: [fixture.model],
      verifyModelFile: async (_filePath, _expected, signal) => {
        markStarted();
        return new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });

    const listing = secondManager.listManagedResources(OWNER);
    await started;
    secondManager.releaseOwner(OWNER);

    await expect(listing).rejects.toMatchObject({
      localSubtitleCode: "owner_released",
    });
  });

  it("waits for an abort-insensitive verifier and fences its late cache write", async () => {
    const fixture = await createFixture();
    fixture.manager.importModel({
      owner: OWNER,
      filePath: fixture.sourcePath,
      mode: "copy",
    });
    await fixture.manager.waitForIdle();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseVerifier!: () => void;
    const verifierGate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const verify = vi.fn(async (filePath, expected) => {
      const verification = await verifyLocalSubtitleGgmlModelFile(
        filePath,
        expected,
      );
      markStarted();
      await verifierGate;
      return verification;
    });
    const secondManager = new LocalSubtitleModelManager({
      managedResourceRoot: fixture.managedRoot,
      runtimeEnvironment: {
        mode: "development",
        appRoot: fixture.root,
        platform: "darwin",
        arch: "arm64",
      },
      supervisor: fixture.supervisor,
      modelCatalog: [fixture.model],
      verifyModelFile: verify,
    });

    const resolving = secondManager.resolveManagedModel(fixture.model.id);
    await started;
    let shutdownSettled = false;
    const shutdown = secondManager.shutdown().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    releaseVerifier();

    await expect(resolving).rejects.toMatchObject({
      localSubtitleCode: "owner_released",
    });
    await shutdown;
    expect(verify).toHaveBeenCalledOnce();
    await expect(
      secondManager.resolveManagedModel(fixture.model.id),
    ).rejects.toMatchObject({ localSubtitleCode: "owner_released" });
    expect(verify).toHaveBeenCalledOnce();
  });
});

interface FixtureOptions {
  readonly payloadBytes?: number;
  readonly smoke?: ReturnType<typeof vi.fn>;
  readonly availableBytes?: (directory: string) => Promise<number>;
  readonly removeSourceFile?: (absolutePath: string) => Promise<void>;
  readonly commitModelLink?: (source: string, destination: string) => Promise<void>;
  readonly removeStagingDirectory?: (absolutePath: string) => Promise<void>;
  readonly verifyModelFile?: LocalSubtitleModelManagerOptions["verifyModelFile"];
  readonly verifyServerRuntime?: LocalSubtitleModelManagerOptions["verifyServerRuntime"];
  readonly stagingIdFactory?: () => string;
  readonly sessionRegistry?: LocalSubtitleSessionRegistry;
  readonly downloadResource?: LocalSubtitleModelManagerOptions["downloadResource"];
  readonly isResourceBusy?: LocalSubtitleModelManagerOptions["isResourceBusy"];
  readonly startupCleanup?: LocalSubtitleModelManagerOptions["startupCleanup"];
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-model-manager-"));
  tempRoots.push(root);
  const managedRoot = path.join(root, "managed");
  const bytes = createGgmlModel(options.payloadBytes ?? 256);
  const sourcePath = path.join(root, "selected-model.bin");
  await writeFile(sourcePath, bytes);
  const model: LocalSubtitleModelManifestEntry = {
    ...LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!,
    id: "test-large-v3-q5_0",
    fileName: "ggml-test-large-v3-q5_0.bin",
    byteSize: bytes.length,
    sha256: sha256(bytes),
  };
  const smoke = options.smoke ?? vi.fn(async () => undefined);
  const supervisor: LocalSubtitleModelLoadSmokeTarget = {
    smokeModelLoad: smoke,
  };
  const manager = new LocalSubtitleModelManager({
    managedResourceRoot: managedRoot,
    runtimeEnvironment: {
      mode: "development",
      appRoot: root,
      platform: "darwin",
      arch: "arm64",
    },
    supervisor,
    ...(options.sessionRegistry === undefined
      ? {}
      : { sessionRegistry: options.sessionRegistry }),
    modelCatalog: [model],
    verifyServerRuntime: options.verifyServerRuntime ?? (async () => fakeRuntime()),
    availableBytes: options.availableBytes ?? (async () => Number.MAX_SAFE_INTEGER),
    ...(options.stagingIdFactory === undefined
      ? {}
      : { stagingIdFactory: options.stagingIdFactory }),
    ...(options.removeSourceFile === undefined
      ? {}
      : { removeSourceFile: options.removeSourceFile }),
    ...(options.commitModelLink === undefined
      ? {}
      : { commitModelLink: options.commitModelLink }),
    ...(options.removeStagingDirectory === undefined
      ? {}
      : { removeStagingDirectory: options.removeStagingDirectory }),
    ...(options.verifyModelFile === undefined
      ? {}
      : { verifyModelFile: options.verifyModelFile }),
    ...(options.downloadResource === undefined
      ? {}
      : { downloadResource: options.downloadResource }),
    ...(options.isResourceBusy === undefined
      ? {}
      : { isResourceBusy: options.isResourceBusy }),
    ...(options.startupCleanup === undefined
      ? {}
      : { startupCleanup: options.startupCleanup }),
  });
  return {
    root,
    managedRoot,
    sourcePath,
    bytes,
    model,
    manager,
    smoke,
    supervisor,
  };
}

function createGgmlModel(payloadBytes: number): Buffer {
  const entry = LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!;
  const bytes = Buffer.alloc(48 + payloadBytes, 0x5a);
  Buffer.from(entry.ggml.magicHex, "hex").copy(bytes, 0);
  entry.ggml.headerInt32Le.forEach((value, index) => {
    bytes.writeInt32LE(value, 4 + index * 4);
  });
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeRuntime(): LocalSubtitleVerifiedRuntimeBundle {
  return verifiedRuntime;
}

async function stagingEntries(managedRoot: string): Promise<string[]> {
  try {
    return await readdir(path.join(managedRoot, "model-staging"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
