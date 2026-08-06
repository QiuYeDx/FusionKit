import { link, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCAL_SUBTITLE_MODEL_MANIFEST } from "../../electron/main/local-subtitle/model-manifest";
import {
  LocalSubtitleResourceJobManager,
} from "../../electron/main/local-subtitle/resource-job";
import {
  verifyLocalSubtitleRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleServerSupervisor } from "../../electron/main/local-subtitle/server-supervisor";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";
import {
  LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION,
  LocalSubtitleVadManager,
} from "../../electron/main/local-subtitle/vad-manager";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REAL_MODEL_PATH = process.env.FUSIONKIT_MODEL002_REAL_MODEL;
const HAS_REAL_FIXTURE =
  process.platform === "win32" &&
  process.arch === "x64" &&
  typeof REAL_MODEL_PATH === "string" &&
  path.isAbsolute(REAL_MODEL_PATH);
const OWNER = Object.freeze({
  webContentsId: 602,
  ownerSessionId: "model002-real-vad-owner",
});

describe("local subtitle VAD manager real contract", () => {
  it.skipIf(!HAS_REAL_FIXTURE)(
    "downloads, native-load-smokes, commits, resolves and deletes the pinned VAD",
    async () => {
      const model = LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!;
      const sourceModelPath = path.resolve(REAL_MODEL_PATH!);
      const sourceModelStat = await stat(sourceModelPath);
      expect(sourceModelStat.isFile()).toBe(true);
      expect(sourceModelStat.size).toBe(model.byteSize);

      const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "fk-m2-vad-"));
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
      const supervisor = new LocalSubtitleServerSupervisor({
        managedResourceRoot,
        startupTimeoutMs: 120_000,
      });
      const verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
        environment: {
          mode: "development",
          appRoot: PROJECT_ROOT,
          platform: "win32",
          arch: "x64",
        },
        scope: "server",
      });
      const manager = new LocalSubtitleVadManager({
        managedResourceRoot,
        platform: "win32",
        resourceJobs,
        supervisor,
        resolveSmokeModel: async () => Object.freeze({
          storage: "managed" as const,
          id: model.id,
          absolutePath: managedModelPath,
          byteSize: model.byteSize,
          sha256: model.sha256,
        }),
        verifyServerRuntime: async () => verifiedRuntime,
      });

      try {
        expect(manager.startResourceInstall(
          OWNER,
          LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.resourceId,
        )).toMatchObject({
          resourceType: "vad",
          status: "queued",
        });
        await manager.waitForIdle();

        expect(registry.getSnapshot(OWNER).resourceJobs).toEqual([
          expect.objectContaining({
            resourceId: LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.resourceId,
            status: "completed",
            progress: 100,
            bytesCompleted: LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.byteSize,
            bytesTotal: LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.byteSize,
          }),
        ]);
        await expect(manager.listManagedResources()).resolves.toEqual([
          expect.objectContaining({ status: "ready" }),
        ]);
        const resolved = await manager.resolveManagedVad(
          LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.resourceId,
        );
        await expect(stat(resolved.absolutePath)).resolves.toMatchObject({
          size: LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.byteSize,
        });
        expect(resolved).toMatchObject({
          id: LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.resourceId,
          sha256: LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.sha256,
        });
        await expect(manager.deleteManagedResource(
          LOCAL_SUBTITLE_PRODUCTION_VAD_DEFINITION.resourceId,
        )).resolves.toEqual({ deleted: true });
      } finally {
        await manager.shutdown().catch(() => undefined);
        await supervisor.shutdown("app_quit").catch(() => undefined);
        await rm(fixtureRoot, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
    },
    180_000,
  );
});
