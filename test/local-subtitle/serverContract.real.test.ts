import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from "@/type/localSubtitle";
import { verifyLocalSubtitleRuntimeBundle } from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleServerHttpClient } from "../../electron/main/local-subtitle/server-http-client";
import { createLocalSubtitleServerDiagnosticCollector } from "../../electron/main/local-subtitle/server-diagnostics";
import {
  createLocalSubtitleServerEndpoint,
  createLocalSubtitleServerProcessDescriptor,
} from "../../electron/main/local-subtitle/server-process-contract";
import { createRuntimeFixture, sha256 } from "./runtimeFixture";

const realPaths = {
  server: process.env.FUSIONKIT_NATIVE001_REAL_SERVER,
  model: process.env.FUSIONKIT_NATIVE001_REAL_MODEL,
  vad: process.env.FUSIONKIT_NATIVE001_REAL_VAD,
  window: process.env.FUSIONKIT_NATIVE001_REAL_WINDOW,
};
const hasRealFixture = Object.values(realPaths).every(
  (value) => typeof value === "string" && value.length > 0,
);
const realBackend = process.env.FUSIONKIT_NATIVE001_REAL_BACKEND === "metal"
  ? "metal"
  : "cpu";

describe("local subtitle official server real contract", () => {
  it.skipIf(!hasRealFixture)(
    "reuses one pinned server process for two successful requests",
    async () => {
      const serverPath = path.resolve(realPaths.server!);
      const modelPath = path.resolve(realPaths.model!);
      const vadPath = path.resolve(realPaths.vad!);
      const windowPath = path.resolve(realPaths.window!);
      const [serverStat, modelStat, vadStat, windowStat] = await Promise.all([
        stat(serverPath),
        stat(modelPath),
        stat(vadPath),
        stat(windowPath),
      ]);
      expect(serverStat.isFile()).toBe(true);
      expect(modelStat.isFile()).toBe(true);
      expect(vadStat.isFile()).toBe(true);
      expect(windowStat.isFile()).toBe(true);

      const fixtureRoot = await mkdtemp(
        path.join(os.tmpdir(), "fusionkit-native001-real-"),
      );
      const sessionRoot = path.join(fixtureRoot, "session");
      const publicDirectory = path.join(sessionRoot, "public");
      const temporaryDirectory = path.join(sessionRoot, "tmp");
      await Promise.all([
        mkdir(publicDirectory, { recursive: true, mode: 0o700 }),
        mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
      ]);

      const managedResourceRoot = commonAncestor(modelPath, vadPath);
      const endpoint = createLocalSubtitleServerEndpoint({
        port: await reserveLoopbackPort(),
      });
      const serverArtifactId = "whisper-server-mac-arm64-metal-cpu";
      const runtimeFixture = await createRuntimeFixture();
      const stagedServerPath = runtimeFixture.artifactPaths[serverArtifactId]!;
      let verifiedRuntime: Awaited<
        ReturnType<typeof verifyLocalSubtitleRuntimeBundle>
      >;
      try {
        await copyFile(serverPath, stagedServerPath);
        await chmod(stagedServerPath, 0o755);
        const stagedServerArtifact = runtimeFixture.manifest.artifacts.find(
          (artifact) => artifact.id === serverArtifactId,
        );
        if (!stagedServerArtifact) {
          throw new Error("The staged real server artifact is missing.");
        }
        stagedServerArtifact.byteSize = serverStat.size;
        stagedServerArtifact.sha256 = sha256(await readFile(stagedServerPath));
        await runtimeFixture.rewriteManifest();
        verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
          environment: runtimeFixture.environment,
          scope: "server",
          signatureVerifier: async (candidate) => candidate === stagedServerPath,
        });
      } catch (error) {
        await Promise.all([
          runtimeFixture.cleanup(),
          rm(fixtureRoot, { recursive: true, force: true }),
        ]);
        throw error;
      }
      expect(
        verifiedRuntime.artifactPaths[serverArtifactId]?.absolutePath,
      ).toBe(stagedServerPath);
      const descriptor = createLocalSubtitleServerProcessDescriptor({
        endpoint,
        verifiedRuntime,
        serverArtifactId,
        backend: realBackend,
        managedResourceRoot,
        model: {
          id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
          absolutePath: modelPath,
          byteSize: modelStat.size,
          sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
        },
        vadModel: {
          id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
          absolutePath: vadPath,
          byteSize: vadStat.size,
          sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
        },
        threads: 4,
        sessionRoot,
        emptyPublicDirectory: publicDirectory,
        temporaryDirectory,
        sourceEnvironment: process.env,
      });
      const diagnostics = createLocalSubtitleServerDiagnosticCollector({
        privateValues: [
          serverPath,
          stagedServerPath,
          runtimeFixture.runtimeRoot,
          modelPath,
          vadPath,
          windowPath,
          fixtureRoot,
          endpoint.privatePath,
          String(endpoint.port),
        ],
      });
      let child: ChildProcessWithoutNullStreams | undefined;
      let childClosed: Promise<void> | undefined;
      let childError: Error | undefined;

      try {
        child = spawn(descriptor.command, [...descriptor.args], {
          ...descriptor.spawnOptions,
          stdio: ["ignore", "pipe", "pipe"],
        });
        childClosed = new Promise<void>((resolve) =>
          child!.once("close", () => resolve()),
        );
        child.stdout.on("data", (chunk: Buffer) =>
          diagnostics.append("stdout", chunk),
        );
        child.stderr.on("data", (chunk: Buffer) =>
          diagnostics.append("stderr", chunk),
        );
        child.once("error", (error) => {
          childError = error;
        });
        const client = new LocalSubtitleServerHttpClient(endpoint, {
          inferenceMs: 5 * 60 * 1_000,
        });
        await waitUntilReady(
          client,
          child,
          () => childError,
          () => diagnostics.finish(),
        );
        const pid = child.pid;
        expect(pid).toBeTypeOf("number");

        for (const requestGeneration of [1, 2]) {
          const response = await client.inference({
            requestGeneration,
            filePath: windowPath,
            language: "auto",
            taskMode: "transcribe",
            beamSize: 5,
            temperature: 0,
            vadEnabled: true,
            vadMinSilenceMs: 500,
          });
          expect(response).toMatchObject({
            requestGeneration,
            sessionDisposition: "reusable",
            result: {
              contractVersion: 1,
              task: "transcribe",
            },
          });
          expect(child.pid).toBe(pid);
          expect(child.exitCode).toBeNull();
        }
      } finally {
        await terminateChild(child, childClosed);
        diagnostics.finish();
        await Promise.all([
          rm(fixtureRoot, { recursive: true, force: true }),
          runtimeFixture.cleanup(),
        ]);
      }
    },
    180_000,
  );
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve a loopback test port.");
  }
  return address.port;
}

async function waitUntilReady(
  client: LocalSubtitleServerHttpClient,
  child: ChildProcessWithoutNullStreams,
  getChildError: () => Error | undefined,
  getDiagnostics: () => ReturnType<
    ReturnType<typeof createLocalSubtitleServerDiagnosticCollector>["finish"]
  >,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (
      getChildError() ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      const details = getDiagnostics().lines?.join(" | ") ?? "no diagnostics";
      throw new Error(`The real server exited before readiness: ${details}`);
    }
    try {
      await client.probeReadiness();
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("The real server did not become ready before the deadline.");
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams | undefined,
  childClosed: Promise<void> | undefined,
): Promise<void> {
  if (!child || !childClosed) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (await settlesWithin(childClosed, 5_000)) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (!(await settlesWithin(childClosed, 2_000))) {
    throw new Error("The real server process did not exit after SIGKILL.");
  }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function commonAncestor(left: string, right: string): string {
  let candidate = path.dirname(left);
  while (candidate !== path.dirname(candidate)) {
    const relative = path.relative(candidate, right);
    if (
      relative.length > 0 &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      return candidate;
    }
    candidate = path.dirname(candidate);
  }
  throw new Error("The real model fixtures do not share a controlled root.");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
