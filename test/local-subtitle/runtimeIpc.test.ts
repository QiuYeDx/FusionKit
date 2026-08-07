import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleRuntimeSummarySchema,
} from "@/type/localSubtitleIpc";
import type { LocalSubtitleIpcHandlerContext } from "../../electron/main/local-subtitle/ipc";
import { LocalSubtitleMediaError } from "../../electron/main/local-subtitle/media-normalizer";
import {
  loadLocalSubtitleRuntimeManifest,
  verifyLocalSubtitleRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import { LocalSubtitleRuntimeIpcBridge } from "../../electron/main/local-subtitle/runtime-ipc";
import { createAcceleratorFixture } from "./acceleratorFixture";
import {
  createRuntimeFixture,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const fixtures: LocalSubtitleRuntimeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("local subtitle runtime IPC bridge", () => {
  it("returns a usable runtime summary from verified bundled components", async () => {
    const fixture = await runtimeFixture();
    const loaded = await loadLocalSubtitleRuntimeManifest(fixture.environment);
    const bridge = new LocalSubtitleRuntimeIpcBridge({
      environment: fixture.environment,
      mediaRuntimeVerifier: {
        verifyRuntime: async () => ({
          runtimeGeneration: loaded.manifestSha256,
        }),
      },
      supportedGpuBackends: ["metal"],
      verifyServerRuntime: () =>
        verifyLocalSubtitleRuntimeBundle({
          environment: fixture.environment,
          scope: "server",
          signatureVerifier: async () => true,
        }),
    });

    const result = await probe(bridge);

    expect(result).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        platform: "darwin",
        arch: "arm64",
        runtimeGeneration: loaded.manifestSha256,
        runner: { status: "ready", version: "v1.9.1+f049fff" },
        mediaRuntime: { status: "ready", version: "8.1.2" },
        backends: [
          { backend: "cpu", status: "available" },
          {
            backend: "cuda",
            status: "unavailable",
            errorCode: "accelerator_unavailable",
          },
          { backend: "metal", status: "available" },
        ],
      },
    });
    if (!result.ok) throw new Error("Expected a successful runtime probe.");
    expect(localSubtitleRuntimeSummarySchema.safeParse(result.data).success).toBe(true);
  });

  it("reports a media launch failure without hiding the verified runner", async () => {
    const fixture = await runtimeFixture();
    const bridge = new LocalSubtitleRuntimeIpcBridge({
      environment: fixture.environment,
      mediaRuntimeVerifier: {
        verifyRuntime: async () => {
          throw new LocalSubtitleMediaError(
            "runtime_launch_failed",
            "media_runtime_launch_failed",
            "preflight",
            "The bundled media runtime did not launch.",
          );
        },
      },
      supportedGpuBackends: ["metal"],
      verifyServerRuntime: () =>
        verifyLocalSubtitleRuntimeBundle({
          environment: fixture.environment,
          scope: "server",
          signatureVerifier: async () => true,
        }),
    });

    const result = await probe(bridge);

    expect(result).toMatchObject({
      ok: true,
      data: {
        runner: { status: "ready" },
        mediaRuntime: {
          status: "launch_failed",
          errorCode: "media_runtime_launch_failed",
        },
        backends: [
          { backend: "cpu", status: "available" },
          {
            backend: "cuda",
            status: "unavailable",
            errorCode: "accelerator_unavailable",
          },
          { backend: "metal", status: "available" },
        ],
      },
    });
  });

  it("reports a verified installed Windows CUDA accelerator as available", async () => {
    const fixture = await runtimeFixture();
    const accelerator = await createAcceleratorFixture();
    try {
      const loaded = await loadLocalSubtitleRuntimeManifest(fixture.environment);
      const windowsLoaded = Object.freeze({
        ...loaded,
        manifest: Object.freeze({
          ...loaded.manifest,
          target: Object.freeze({
            platform: "win32" as const,
            arch: "x64" as const,
          }),
        }),
      });
      const bridge = new LocalSubtitleRuntimeIpcBridge({
        environment: fixture.environment,
        mediaRuntimeVerifier: {
          verifyRuntime: async () => ({
            runtimeGeneration: loaded.manifestSha256,
          }),
        },
        supportedGpuBackends: ["cuda"],
        resolveCudaAccelerator: async () => accelerator.proof,
        loadRuntimeManifest: async () => windowsLoaded,
        verifyServerRuntime: () =>
          verifyLocalSubtitleRuntimeBundle({
            environment: fixture.environment,
            scope: "server",
            signatureVerifier: async () => true,
          }),
      });

      await expect(probe(bridge)).resolves.toMatchObject({
        ok: true,
        data: {
          platform: "win32",
          arch: "x64",
          backends: [
            { backend: "cpu", status: "available" },
            { backend: "cuda", status: "available" },
            {
              backend: "metal",
              status: "unavailable",
              errorCode: "accelerator_unavailable",
            },
          ],
        },
      });
    } finally {
      await accelerator.cleanup();
    }
  });

  it("keeps CUDA unverified when the managed accelerator proof is unavailable", async () => {
    const fixture = await runtimeFixture();
    const loaded = await loadLocalSubtitleRuntimeManifest(fixture.environment);
    const bridge = new LocalSubtitleRuntimeIpcBridge({
      environment: fixture.environment,
      mediaRuntimeVerifier: {
        verifyRuntime: async () => ({
          runtimeGeneration: loaded.manifestSha256,
        }),
      },
      supportedGpuBackends: ["cuda"],
      resolveCudaAccelerator: async () => {
        throw new Error("not installed");
      },
      verifyServerRuntime: () =>
        verifyLocalSubtitleRuntimeBundle({
          environment: fixture.environment,
          scope: "server",
          signatureVerifier: async () => true,
        }),
    });

    await expect(probe(bridge)).resolves.toMatchObject({
      ok: true,
      data: {
        backends: expect.arrayContaining([
          {
            backend: "cuda",
            status: "unverified",
            errorCode: "backend_unverified",
          },
        ]),
      },
    });
  });

  it("coalesces duplicate runtime probes for the same document owner", async () => {
    const fixture = await runtimeFixture();
    const loaded = await loadLocalSubtitleRuntimeManifest(fixture.environment);
    const verificationGate = deferred<void>();
    let activeVerifications = 0;
    const verifyRuntime = vi.fn(async () => {
      activeVerifications += 1;
      if (activeVerifications > 1) {
        activeVerifications -= 1;
        throw new LocalSubtitleMediaError(
          "limit_exceeded",
          "limit_exceeded",
          "preflight",
          "A duplicate runtime verification exceeded the owner operation limit.",
        );
      }
      try {
        await verificationGate.promise;
        return { runtimeGeneration: loaded.manifestSha256 };
      } finally {
        activeVerifications -= 1;
      }
    });
    const bridge = new LocalSubtitleRuntimeIpcBridge({
      environment: fixture.environment,
      mediaRuntimeVerifier: { verifyRuntime },
      verifyServerRuntime: () =>
        verifyLocalSubtitleRuntimeBundle({
          environment: fixture.environment,
          scope: "server",
          signatureVerifier: async () => true,
        }),
    });

    const first = probe(bridge);
    await waitForCondition(() => verifyRuntime.mock.calls.length === 1);
    const second = probe(bridge);
    await new Promise((resolve) => setTimeout(resolve, 0));
    verificationGate.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(verifyRuntime).toHaveBeenCalledOnce();
    expect(firstResult).toMatchObject({
      ok: true,
      data: { mediaRuntime: { status: "ready" } },
    });
    expect(secondResult).toEqual(firstResult);

    await expect(probe(bridge)).resolves.toMatchObject({
      ok: true,
      data: { mediaRuntime: { status: "ready" } },
    });
    expect(verifyRuntime).toHaveBeenCalledTimes(2);
  });
});

async function runtimeFixture(): Promise<LocalSubtitleRuntimeFixture> {
  const fixture = await createRuntimeFixture();
  fixtures.push(fixture);
  return fixture;
}

async function probe(bridge: LocalSubtitleRuntimeIpcBridge) {
  const handler = bridge.handlers.public?.[
    LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeRuntime
  ];
  if (!handler) throw new Error("The runtime probe handler is missing.");
  const controller = new AbortController();
  return handler({}, {
    owner: { webContentsId: 1, ownerSessionId: "runtime-ipc-owner" },
    ownerIdentity: {
      senderId: 1,
      ownerSessionId: "runtime-ipc-owner",
      processId: 11,
      frameId: 0,
    },
    event: {} as LocalSubtitleIpcHandlerContext["event"],
    capabilities: {} as LocalSubtitleIpcHandlerContext["capabilities"],
    signal: controller.signal,
    isOwnerCurrent: () => true,
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

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition not reached.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
