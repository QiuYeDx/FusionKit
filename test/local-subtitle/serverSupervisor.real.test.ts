import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from "@/type/localSubtitle";
import { verifyLocalSubtitleRuntimeBundle } from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleServerSupervisor } from "../../electron/main/local-subtitle/server-supervisor";
import { createRuntimeFixture, sha256 } from "./runtimeFixture";

const realPaths = {
  server:
    process.env.FUSIONKIT_BE001_REAL_SERVER ??
    process.env.FUSIONKIT_NATIVE001_REAL_SERVER,
  model:
    process.env.FUSIONKIT_BE001_REAL_MODEL ??
    process.env.FUSIONKIT_NATIVE001_REAL_MODEL,
  vad:
    process.env.FUSIONKIT_BE001_REAL_VAD ??
    process.env.FUSIONKIT_NATIVE001_REAL_VAD,
  window:
    process.env.FUSIONKIT_BE001_REAL_WINDOW ??
    process.env.FUSIONKIT_NATIVE001_REAL_WINDOW,
};
const hasRealFixture =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  Object.values(realPaths).every(
    (value) => typeof value === "string" && value.length > 0,
  );

describe("local subtitle server supervisor real contract", () => {
  it.skipIf(!hasRealFixture)(
    "reuses one official CPU process and removes its private session",
    async () => {
      const serverPath = path.resolve(realPaths.server!);
      const sourceModelPath = path.resolve(realPaths.model!);
      const sourceVadPath = path.resolve(realPaths.vad!);
      const windowPath = path.resolve(realPaths.window!);
      const [serverStat, modelStat, vadStat, windowStat] = await Promise.all([
        stat(serverPath),
        stat(sourceModelPath),
        stat(sourceVadPath),
        stat(windowPath),
      ]);
      expect([
        serverStat.isFile(),
        modelStat.isFile(),
        vadStat.isFile(),
        windowStat.isFile(),
      ]).toEqual([true, true, true, true]);

      const fixtureRoot = await mkdtemp(
        path.join(os.tmpdir(), "fusionkit-be001-real-"),
      );
      const managedResourceRoot = path.join(fixtureRoot, "managed");
      const modelPath = path.join(managedResourceRoot, "models", "model.bin");
      const vadPath = path.join(managedResourceRoot, "vad", "vad.bin");
      await Promise.all([
        mkdir(path.dirname(modelPath), { recursive: true, mode: 0o700 }),
        mkdir(path.dirname(vadPath), { recursive: true, mode: 0o700 }),
      ]);
      await Promise.all([
        link(sourceModelPath, modelPath),
        link(sourceVadPath, vadPath),
      ]);

      const runtimeFixture = await createRuntimeFixture();
      const serverArtifactId = "whisper-server-mac-arm64-metal-cpu";
      const stagedServerPath = runtimeFixture.artifactPaths[serverArtifactId]!;
      const supervisor = new LocalSubtitleServerSupervisor({
        managedResourceRoot,
      });
      const owner = Object.freeze({
        webContentsId: 1,
        ownerSessionId: "be001-real-owner",
      });
      let lease:
        | Awaited<ReturnType<LocalSubtitleServerSupervisor["acquire"]>>
        | undefined;

      try {
        await copyFile(serverPath, stagedServerPath);
        await chmod(stagedServerPath, 0o755);
        const stagedArtifact = runtimeFixture.manifest.artifacts.find(
          (artifact) => artifact.id === serverArtifactId,
        );
        if (!stagedArtifact) {
          throw new Error("The staged real server artifact is missing.");
        }
        stagedArtifact.byteSize = serverStat.size;
        stagedArtifact.sha256 = sha256(await readFile(stagedServerPath));
        await runtimeFixture.rewriteManifest();
        const verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
          environment: runtimeFixture.environment,
          scope: "server",
          signatureVerifier: async (candidate) => candidate === stagedServerPath,
        });

        lease = await supervisor.acquire(
          owner,
          {
            verifiedRuntime,
            serverArtifactId,
            purpose: "inference",
            backend: "cpu",
            model: {
              storage: "managed",
              id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
              absolutePath: modelPath,
              byteSize: modelStat.size,
              sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
            },
            vadModel: {
              storage: "managed",
              id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
              absolutePath: vadPath,
              byteSize: vadStat.size,
              sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
            },
            threads: 4,
            sourceEnvironment: process.env,
          },
        );
        const firstPid = supervisor.snapshot.processId;
        expect(firstPid).toBeTypeOf("number");

        for (const requestGeneration of [1, 2]) {
          const result = await supervisor.beginInference(lease, {
            requestGeneration,
            filePath: windowPath,
            expectedFileIdentity: Object.freeze({
              dev: windowStat.dev,
              ino: windowStat.ino,
              size: windowStat.size,
              mtimeMs: windowStat.mtimeMs,
              ctimeMs: windowStat.ctimeMs,
            }),
            language: "auto",
            taskMode: "transcribe",
            beamSize: 5,
            temperature: 0,
            vadEnabled: true,
            vadMinSilenceMs: 500,
          }).result;
          expect(result).toMatchObject({
            processEpoch: 1,
            response: {
              requestGeneration,
              sessionDisposition: "reusable",
              result: { contractVersion: 1, task: "transcribe" },
            },
          });
          expect(supervisor.snapshot.processId).toBe(firstPid);
        }

        await supervisor.release(lease);
        lease = undefined;
        expect(supervisor.snapshot).toMatchObject({
          state: "ready",
          processId: firstPid,
          leaseCount: 0,
          activeRequest: false,
        });
        supervisor.releaseOwner(owner);
        await supervisor.drainBackgroundCleanup();
        expect(supervisor.snapshot).toMatchObject({
          state: "unloaded",
          leaseCount: 0,
          activeRequest: false,
        });
        await expect(
          readdir(path.join(managedResourceRoot, "temp")),
        ).resolves.toEqual([]);
      } finally {
        if (lease) await supervisor.release(lease).catch(() => undefined);
        await supervisor.shutdown("app_quit").catch(() => undefined);
        await Promise.all([
          runtimeFixture.cleanup(),
          rm(fixtureRoot, { recursive: true, force: true }),
        ]);
      }
    },
    180_000,
  );
});
