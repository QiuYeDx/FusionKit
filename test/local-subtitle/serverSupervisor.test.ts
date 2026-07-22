import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from "../../src/type/localSubtitle";
import {
  LocalSubtitleServerContractError,
  type LocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerInferenceResponse,
} from "../../electron/main/local-subtitle/server-contract";
import type {
  LocalSubtitleServerHealthResponse,
  LocalSubtitleServerHttpEndpoint,
} from "../../electron/main/local-subtitle/server-http-client";
import {
  cleanupLocalSubtitleServerSession,
  type LocalSubtitleServerSession,
} from "../../electron/main/local-subtitle/server-session";
import {
  LocalSubtitleServerSupervisor,
  LocalSubtitleServerSupervisorError,
  type LocalSubtitleServerBackendAttestation,
  type LocalSubtitleServerHttpClientLike,
  type LocalSubtitleServerModelLoadSmokeOptions,
  type LocalSubtitleServerSupervisorLoadOptions,
} from "../../electron/main/local-subtitle/server-supervisor";
import {
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import {
  createRuntimeFixture,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const SERVER_ARTIFACT_ID = "whisper-server-mac-arm64-metal-cpu";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const OWNER_A = Object.freeze({ webContentsId: 17, ownerSessionId: "owner-a" });
const OWNER_B = Object.freeze({ webContentsId: 18, ownerSessionId: "owner-b" });
const HEALTHY = Object.freeze({ sessionDisposition: "reusable" } as const);
type InferenceLoadOptions = Extract<
  LocalSubtitleServerSupervisorLoadOptions,
  { readonly purpose: "inference" }
>;

let runtimeFixture: LocalSubtitleRuntimeFixture;
let verifiedRuntime: LocalSubtitleVerifiedRuntimeBundle;
let harnesses: SupervisorHarness[] = [];

beforeAll(async () => {
  runtimeFixture = await createRuntimeFixture();
  verifiedRuntime = await verifyLocalSubtitleRuntimeBundle({
    environment: runtimeFixture.environment,
    scope: "server",
    signatureVerifier: async () => true,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of harnesses) {
    for (const child of harness.children) child.close(0, null);
    await harness.supervisor.shutdown("app_quit").catch(() => undefined);
    await harness.supervisor.drainBackgroundCleanup();
  }
  harnesses = [];
});

afterAll(async () => {
  await runtimeFixture.cleanup();
});

describe("LocalSubtitleServerSupervisor", () => {
  it("stays lazy, launches CPU with --no-gpu, and reuses one PID for matching leases", async () => {
    const harness = createHarness();

    expect(harness.spawnRecords).toHaveLength(0);
    expect(harness.supervisor.snapshot).toEqual({
      state: "unloaded",
      leaseCount: 0,
      activeRequest: false,
    });

    const first = await harness.supervisor.acquire(OWNER_A, loadOptions());
    const initial = harness.supervisor.snapshot;
    const second = await harness.supervisor.acquire(OWNER_B, loadOptions());

    expect(harness.spawnRecords).toHaveLength(1);
    expect(harness.spawnRecords[0]?.args.filter((arg) => arg === "--no-gpu"))
      .toEqual(["--no-gpu"]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: initial.processEpoch,
      processId: initial.processId,
      leaseCount: 2,
      purpose: "inference",
      backend: "cpu",
    });
    expect(harness.supervisor.snapshot).not.toHaveProperty("backendVerified");

    await harness.supervisor.release(first);
    expect(harness.children[0]?.killSignals).toEqual([]);
    await harness.supervisor.release(second);
    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("runs an explicitly no-VAD inference without loading a VAD model", async () => {
    const client = new FakeHttpClient();
    const harness = createHarness({ clients: [client] });
    const lease = await harness.supervisor.acquire(OWNER_A, noVadLoadOptions());

    const result = await harness.supervisor.beginInference(lease, {
      ...inferenceRequest(1),
      vadEnabled: false,
    }).result;

    expect(result.response.requestGeneration).toBe(1);
    expect(harness.spawnRecords[0]?.args).not.toContain("--vad-model");
    expect(client.inferenceRequests[0]?.vadEnabled).toBe(false);
    await harness.supervisor.release(lease);
  });

  it("rejects inference when the request VAD mode differs from the load identity", async () => {
    const withVadClient = new FakeHttpClient();
    const withVadHarness = createHarness({
      clients: [withVadClient],
      idleTimeoutMs: 1,
    });
    const withVadLease = await withVadHarness.supervisor.acquire(
      OWNER_A,
      loadOptions(),
    );
    expect(() =>
      withVadHarness.supervisor.beginInference(withVadLease, {
        ...inferenceRequest(1),
        vadEnabled: false,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
    expect(withVadClient.inferenceCalls).toBe(0);
    expect(withVadHarness.supervisor.snapshot.activeRequest).toBe(false);
    await waitFor(() => withVadHarness.children[0]?.killSignals.includes("SIGTERM"));
    await withVadHarness.supervisor.release(withVadLease);

    const withoutVadClient = new FakeHttpClient();
    const withoutVadHarness = createHarness({ clients: [withoutVadClient] });
    const withoutVadLease = await withoutVadHarness.supervisor.acquire(
      OWNER_B,
      noVadLoadOptions(),
    );
    expect(() =>
      withoutVadHarness.supervisor.beginInference(
        withoutVadLease,
        inferenceRequest(1),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
    expect(withoutVadClient.inferenceCalls).toBe(0);
    await withoutVadHarness.supervisor.release(withoutVadLease);
  });

  it("retires a model load smoke before success without VAD or inference", async () => {
    const child = new FakeChild({ closeOnSignal: "never" });
    const client = new FakeHttpClient();
    const harness = createHarness({ children: [child], clients: [client] });
    let settled = false;

    const smoke = harness.supervisor
      .smokeModelLoad(OWNER_A, smokeLoadOptions())
      .finally(() => {
        settled = true;
      });
    await waitFor(() => child.killSignals.includes("SIGTERM"));

    expect(settled).toBe(false);
    expect(harness.cleanupEvents).toEqual([]);
    expect(client.readinessCalls).toBe(1);
    expect(client.inferenceCalls).toBe(0);
    expect(harness.spawnRecords[0]?.args).not.toContain("--vad-model");
    expect(
      harness.spawnRecords[0]?.args.filter((value) => value === "--no-gpu"),
    ).toEqual(["--no-gpu"]);

    child.stderr.write("late smoke shutdown line\n");
    child.close(null, "SIGTERM");
    await expect(smoke).resolves.toBeUndefined();

    expect(harness.cleanupEvents).toEqual([
      expect.objectContaining({ childClosed: true }),
    ]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "unloaded",
      leaseCount: 0,
      activeRequest: false,
      lastDiagnostics: {
        lines: expect.arrayContaining(["[stderr] late smoke shutdown line"]),
      },
    });
    expect(harness.supervisor.snapshot).not.toHaveProperty("processEpoch");
  });

  it("keeps smoke leases purpose-bound and incompatible with inference reuse", async () => {
    const smokeClient = new FakeHttpClient();
    const inferenceClient = new FakeHttpClient();
    const harness = createHarness({ clients: [smokeClient, inferenceClient] });
    const smokeLease = await harness.supervisor.acquire(
      OWNER_A,
      smokeLoadOptions(),
    );

    expect(harness.supervisor.snapshot).toMatchObject({
      state: "unloaded",
      leaseCount: 1,
    });
    expect(() =>
      harness.supervisor.beginInference(smokeLease, inferenceRequest(1)),
    ).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
    await expect(
      harness.supervisor.acquire(OWNER_B, loadOptions()),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(smokeClient.inferenceCalls).toBe(0);

    await harness.supervisor.release(smokeLease);
    const inferenceLease = await harness.supervisor.acquire(
      OWNER_B,
      loadOptions(),
    );
    expect(harness.spawnRecords).toHaveLength(2);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      purpose: "inference",
      leaseCount: 1,
    });
    await harness.supervisor.release(inferenceLease);
  });

  it("rejects a matching smoke in the ready-to-retire window", async () => {
    let harness!: SupervisorHarness;
    let second: Promise<void> | undefined;
    let observationError: Error | undefined;
    const observedReady = deferred<void>();
    const client = new FakeHttpClient({
      readiness: [() => {
        let checks = 0;
        const observe = () => {
          if (harness.supervisor.snapshot.state === "ready") {
            second = harness.supervisor.smokeModelLoad(
              OWNER_B,
              smokeLoadOptions(),
            );
            observedReady.resolve(undefined);
            return;
          }
          checks += 1;
          if (checks >= 100) {
            observationError = new Error(
              "The smoke process did not expose its ready retirement window.",
            );
            observedReady.resolve(undefined);
            return;
          }
          queueMicrotask(observe);
        };
        queueMicrotask(observe);
        return Promise.resolve(HEALTHY);
      }],
    });
    harness = createHarness({ clients: [client] });
    const first = harness.supervisor.smokeModelLoad(OWNER_A, smokeLoadOptions());

    await observedReady.promise;
    if (observationError) throw observationError;
    await expect(second).rejects.toMatchObject({ code: "resource_busy" });

    await expect(first).resolves.toBeUndefined();
    expect(harness.spawnRecords).toHaveLength(1);
  });

  it("rejects smoke success when closed-session cleanup fails", async () => {
    const harness = createHarness({ cleanupFailures: 1 });

    await expect(
      harness.supervisor.smokeModelLoad(OWNER_A, smokeLoadOptions()),
    ).rejects.toMatchObject({
      code: "runtime_unresponsive",
      processEpoch: 1,
    });
    expect(harness.cleanupEvents).toHaveLength(1);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "faulted",
      leaseCount: 0,
    });

    await expect(harness.supervisor.shutdown("app_quit")).resolves.toBeUndefined();
    expect(harness.cleanupEvents).toHaveLength(2);
  });

  it("rejects a smoke VAD before creating a private process session", async () => {
    const harness = createHarness();
    const invalid = {
      ...smokeLoadOptions(),
      vadModel: loadOptions().vadModel,
    };

    await expect(
      harness.supervisor.smokeModelLoad(OWNER_A, invalid as never),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(harness.spawnRecords).toHaveLength(0);
    expect(harness.cleanupEvents).toHaveLength(0);
  });

  it("rejects a different load identity while a lease is active", async () => {
    const harness = createHarness();
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await expect(
      harness.supervisor.acquire(
        OWNER_B,
        loadOptions({
          model: managedModel("another-model", HASH_B),
        }),
      ),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(harness.spawnRecords).toHaveLength(1);

    await harness.supervisor.release(lease);
  });

  it("snapshots mutable load and inference inputs before the first await", async () => {
    const health = deferred<LocalSubtitleServerHealthResponse>();
    const client = new FakeHttpClient({ health: [() => health.promise] });
    const harness = createHarness({ clients: [client] });
    const options = loadOptions();
    const originalModelPath = options.model.absolutePath;
    const acquiring = harness.supervisor.acquire(OWNER_A, options);
    (options.model as { absolutePath: string }).absolutePath = path.join(
      managedRoot(),
      "mutated-model.bin",
    );
    const lease = await acquiring;

    expect(harness.spawnRecords[0]?.args).toContain(originalModelPath);
    expect(harness.spawnRecords[0]?.args).not.toContain(
      options.model.absolutePath,
    );

    const request = inferenceRequest(1) as {
      requestGeneration: number;
      language: string;
    } & LocalSubtitleServerInferenceRequest;
    const operation = harness.supervisor.beginInference(lease, request);
    request.requestGeneration = 99;
    request.language = "ja";
    health.resolve(HEALTHY);
    await operation.result;

    expect(client.inferenceRequests[0]).toMatchObject({
      requestGeneration: 1,
      language: "auto",
    });
    await harness.supervisor.release(lease);
  });

  it("retries only reusable readiness failures and fails fast on schema errors", async () => {
    const retryClient = new FakeHttpClient({
      readiness: [readiness503(), HEALTHY],
    });
    const retryHarness = createHarness({ clients: [retryClient] });
    const retryLease = await retryHarness.supervisor.acquire(
      OWNER_A,
      loadOptions(),
    );

    expect(retryClient.readinessCalls).toBe(2);
    expect(retryHarness.spawnRecords).toHaveLength(1);
    await retryHarness.supervisor.release(retryLease);

    const schemaClient = new FakeHttpClient({
      readiness: [schemaFailure()],
    });
    const schemaHarness = createHarness({ clients: [schemaClient] });
    await expect(
      schemaHarness.supervisor.acquire(OWNER_A, loadOptions()),
    ).rejects.toMatchObject({
      code: "invalid_response",
      sessionDisposition: "restart_required",
    });
    expect(schemaClient.readinessCalls).toBe(1);
    expect(schemaHarness.spawnRecords).toHaveLength(1);
  });

  it("retries an early startup close with a fresh session and endpoint", async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const firstClient = new FakeHttpClient({
      readiness: [() => {
        firstChild.close(1, null);
        return Promise.reject(readiness503());
      }],
    });
    const harness = createHarness({
      children: [firstChild, secondChild],
      clients: [firstClient, new FakeHttpClient()],
    });

    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    expect(harness.spawnRecords).toHaveLength(2);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 2,
      processId: secondChild.pid,
    });
    const firstTemp = harness.spawnRecords[0]?.options.env?.TEMP;
    const secondTemp = harness.spawnRecords[1]?.options.env?.TEMP;
    expect(firstTemp).toBeTypeOf("string");
    expect(secondTemp).toBeTypeOf("string");
    expect(path.dirname(firstTemp!)).not.toBe(path.dirname(secondTemp!));
    expect(harness.spawnRecords[0]?.args).not.toEqual(
      harness.spawnRecords[1]?.args,
    );
    expect(harness.cleanupEvents).toEqual([
      expect.objectContaining({ childClosed: true }),
    ]);
    await harness.supervisor.release(lease);
  });

  it("retires a generation after runtime health failure and starts a fresh one", async () => {
    const firstClient = new FakeHttpClient({ health: [runtimeHealthFailure()] });
    const secondClient = new FakeHttpClient();
    const harness = createHarness({ clients: [firstClient, secondClient] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());
    const firstEpoch = harness.supervisor.snapshot.processEpoch;

    await expect(
      harness.supervisor.beginInference(lease, inferenceRequest(1)).result,
    ).rejects.toMatchObject({ sessionDisposition: "restart_required" });
    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);

    const next = await harness.supervisor.beginInference(
      lease,
      inferenceRequest(2),
    ).result;
    expect(next).toMatchObject({
      processEpoch: expect.any(Number),
      response: { requestGeneration: 2 },
    });
    expect(next.processEpoch).not.toBe(firstEpoch);
    expect(harness.spawnRecords).toHaveLength(2);

    await harness.supervisor.release(lease);
  });

  it("claims the single-active request ticket synchronously", async () => {
    const inference = deferred<LocalSubtitleServerInferenceResponse>();
    const client = new FakeHttpClient({ inference: [() => inference.promise] });
    const harness = createHarness({ clients: [client] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    const active = harness.supervisor.beginInference(lease, inferenceRequest(1));
    expect(() =>
      harness.supervisor.beginInference(lease, inferenceRequest(2)),
    ).toThrow(expect.objectContaining({ code: "resource_busy" }));

    inference.resolve(inferenceResponse(1));
    await expect(active.result).resolves.toMatchObject({
      response: { requestGeneration: 1 },
    });
    await harness.supervisor.release(lease);
  });

  it("keeps a ready generation reusable after a pre-aborted request", async () => {
    const client = new FakeHttpClient();
    const harness = createHarness({ clients: [client] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());
    const epoch = harness.supervisor.snapshot.processEpoch;
    const controller = new AbortController();
    controller.abort();

    await expect(
      harness.supervisor.beginInference(
        lease,
        inferenceRequest(1, controller.signal),
      ).result,
    ).rejects.toMatchObject({ code: "owner_released" });
    expect(harness.children[0]?.killSignals).toEqual([]);

    const next = await harness.supervisor.beginInference(
      lease,
      inferenceRequest(2),
    ).result;
    expect(next.processEpoch).toBe(epoch);
    expect(harness.spawnRecords).toHaveLength(1);
    await harness.supervisor.release(lease);
  });

  it("fences a cancelled mid-request result and succeeds on a new epoch", async () => {
    const late = deferred<LocalSubtitleServerInferenceResponse>();
    const firstClient = new FakeHttpClient({ inference: [() => late.promise] });
    const secondClient = new FakeHttpClient();
    const harness = createHarness({ clients: [firstClient, secondClient] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    const first = harness.supervisor.beginInference(lease, inferenceRequest(1));
    await waitFor(() => firstClient.inferenceCalls === 1);
    await harness.supervisor.cancelRequest(first.ticket);
    await expect(first.result).rejects.toBeInstanceOf(
      LocalSubtitleServerSupervisorError,
    );

    const second = harness.supervisor.beginInference(lease, inferenceRequest(2));
    late.resolve(inferenceResponse(1));
    await expect(second.result).resolves.toMatchObject({
      processEpoch: 2,
      response: { requestGeneration: 2 },
    });
    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
    expect(harness.spawnRecords).toHaveLength(2);
    await harness.supervisor.release(lease);
  });

  it("force-settles an active request when the child closes unexpectedly", async () => {
    const pending = deferred<LocalSubtitleServerInferenceResponse>();
    const client = new FakeHttpClient({ inference: [() => pending.promise] });
    const harness = createHarness({ clients: [client] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    const operation = harness.supervisor.beginInference(
      lease,
      inferenceRequest(1),
    );
    await waitFor(() => client.inferenceCalls === 1);
    harness.children[0]?.close(9, null);

    await expect(operation.result).rejects.toMatchObject({
      code: "runtime_crashed",
      processEpoch: 1,
    });
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.cleanupEvents).toEqual([
      expect.objectContaining({ childClosed: true }),
    ]);
  });

  it("escalates SIGTERM to SIGKILL and cleans only after close and late stderr", async () => {
    const child = new FakeChild({ closeOnSignal: "SIGKILL" });
    child.onKill = (signal) => {
      if (signal === "SIGKILL") child.stderr.write("late shutdown line\n");
    };
    const harness = createHarness({ children: [child] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await harness.supervisor.release(lease);

    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.cleanupEvents).toEqual([
      expect.objectContaining({ childClosed: true }),
    ]);
    expect(harness.supervisor.snapshot.lastDiagnostics?.lines).toContain(
      "[stderr] late shutdown line",
    );
  });

  it("stays faulted, preserves the session, and blocks respawn without close", async () => {
    const child = new FakeChild({ closeOnSignal: "never" });
    const harness = createHarness({ children: [child] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await expect(harness.supervisor.release(lease)).rejects.toMatchObject({
      code: "runtime_unresponsive",
      processEpoch: 1,
    });
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.cleanupEvents).toEqual([]);
    expect(harness.supervisor.snapshot.state).toBe("faulted");

    await expect(
      harness.supervisor.acquire(OWNER_B, loadOptions()),
    ).rejects.toMatchObject({ code: "runtime_unresponsive" });
    expect(harness.spawnRecords).toHaveLength(1);
    expect(harness.cleanupEvents).toEqual([]);

    child.close(null, "SIGKILL");
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.cleanupEvents).toEqual([
      expect.objectContaining({ childClosed: true }),
    ]);
  });

  it("retries a transient closed-session cleanup failure during shutdown", async () => {
    const harness = createHarness({ cleanupFailures: 1 });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await expect(harness.supervisor.release(lease)).rejects.toMatchObject({
      code: "runtime_unresponsive",
    });
    expect(harness.supervisor.snapshot.state).toBe("faulted");
    expect(harness.cleanupEvents).toHaveLength(1);

    await expect(harness.supervisor.shutdown("app_quit")).resolves.toBeUndefined();
    expect(harness.cleanupEvents).toHaveLength(2);
    expect(harness.supervisor.snapshot.state).toBe("disposed");
  });

  it("latches a pre-spawn cleanup failure and recovers it only at shutdown", async () => {
    const harness = createHarness({
      cleanupFailures: 1,
      createHttpClientError: new Error("Injected client construction failure."),
    });

    await expect(
      harness.supervisor.acquire(OWNER_A, loadOptions()),
    ).rejects.toMatchObject({ code: "runtime_unresponsive" });
    expect(harness.spawnRecords).toHaveLength(0);
    expect(harness.cleanupEvents).toHaveLength(1);
    expect(harness.supervisor.snapshot.state).toBe("faulted");

    await expect(
      harness.supervisor.acquire(OWNER_B, loadOptions()),
    ).rejects.toMatchObject({ code: "runtime_unresponsive" });
    await expect(harness.supervisor.shutdown("app_quit")).resolves.toBeUndefined();
    expect(harness.cleanupEvents).toHaveLength(2);
  });

  it("prioritizes an unconfirmed close over the original inference error", async () => {
    const child = new FakeChild({ closeOnSignal: "never" });
    const client = new FakeHttpClient({ inference: [schemaFailure()] });
    const harness = createHarness({ children: [child], clients: [client] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await expect(
      harness.supervisor.beginInference(lease, inferenceRequest(1)).result,
    ).rejects.toMatchObject({
      code: "runtime_unresponsive",
      processEpoch: 1,
    });
    expect(harness.supervisor.snapshot.state).toBe("faulted");

    child.close(null, "SIGKILL");
    await harness.supervisor.drainBackgroundCleanup();
  });

  it("requires exact main-process GPU attestation and distinguishes mismatch", async () => {
    const missing = createHarness();
    await expect(
      missing.supervisor.acquire(OWNER_A, loadOptions({ backend: "metal" })),
    ).rejects.toMatchObject({ code: "backend_unverified" });
    expect(missing.spawnRecords).toHaveLength(1);

    const mismatch = createHarness({
      verifyBackend: async (context) => ({
        verified: true,
        processEpoch: context.processEpoch,
        processId: context.processId,
        backend: "cuda",
        runtimeGeneration: context.runtimeGeneration,
        serverArtifactId: context.serverArtifactId,
      } as LocalSubtitleServerBackendAttestation),
    });
    await expect(
      mismatch.supervisor.acquire(OWNER_B, loadOptions({ backend: "metal" })),
    ).rejects.toMatchObject({ code: "backend_mismatch" });
    expect(mismatch.spawnRecords).toHaveLength(1);
  });

  it("aborts a GPU attestation probe at the startup deadline", async () => {
    let attestationAborted = false;
    const harness = createHarness({
      startupTimeoutMs: 25,
      verifyBackend: async (context) =>
        new Promise<LocalSubtitleServerBackendAttestation>(() => {
          context.signal.addEventListener(
            "abort",
            () => {
              attestationAborted = true;
            },
            { once: true },
          );
        }),
    });

    await expect(
      harness.supervisor.acquire(OWNER_A, loadOptions({ backend: "metal" })),
    ).rejects.toMatchObject({ code: "startup_timeout" });
    expect(attestationAborted).toBe(true);
    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("releases an owner synchronously, fences its request, and preserves another lease", async () => {
    const late = deferred<LocalSubtitleServerInferenceResponse>();
    const firstClient = new FakeHttpClient({ inference: [() => late.promise] });
    const secondClient = new FakeHttpClient();
    const harness = createHarness({ clients: [firstClient, secondClient] });
    const firstLease = await harness.supervisor.acquire(OWNER_A, loadOptions());
    const secondLease = await harness.supervisor.acquire(OWNER_B, loadOptions());
    const active = harness.supervisor.beginInference(
      firstLease,
      inferenceRequest(1),
    );
    await waitFor(() => firstClient.inferenceCalls === 1);

    expect(harness.supervisor.releaseOwner(OWNER_A)).toBeUndefined();
    expect(() =>
      harness.supervisor.beginInference(firstLease, inferenceRequest(2)),
    ).toThrow(expect.objectContaining({ code: "owner_released" }));
    await harness.supervisor.drainBackgroundCleanup();
    await expect(active.result).rejects.toBeInstanceOf(
      LocalSubtitleServerSupervisorError,
    );

    await expect(
      harness.supervisor.acquire(OWNER_A, loadOptions()),
    ).rejects.toMatchObject({ code: "owner_released" });
    await expect(
      harness.supervisor.beginInference(secondLease, inferenceRequest(3)).result,
    ).resolves.toMatchObject({
      processEpoch: 2,
      response: { requestGeneration: 3 },
    });
    await harness.supervisor.release(secondLease);
  });

  it("ignores an idle callback captured from an older process epoch", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const idleCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation((
      (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 500 && typeof handler === "function") {
          idleCallbacks.push(() => handler(...args));
        }
        return nativeSetTimeout(handler, timeout, ...args);
      }
    ) as typeof setTimeout);

    const harness = createHarness({ idleTimeoutMs: 500 });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());
    expect(idleCallbacks).toHaveLength(1);

    harness.children[0]?.close(8, null);
    await waitFor(() => harness.supervisor.snapshot.state === "unloaded");
    await harness.supervisor.drainBackgroundCleanup();

    await harness.supervisor.beginInference(lease, inferenceRequest(1)).result;
    expect(harness.spawnRecords).toHaveLength(2);
    idleCallbacks[0]?.();
    await Promise.resolve();
    expect(harness.children[1]?.killSignals).toEqual([]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 2,
    });
    await harness.supervisor.release(lease);
  });
});

interface HarnessOptions {
  readonly clients?: readonly FakeHttpClient[];
  readonly children?: readonly FakeChild[];
  readonly idleTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly cleanupFailures?: number;
  readonly createHttpClientError?: Error;
  readonly verifyBackend?: (
    context: Parameters<
      NonNullable<
        ConstructorParameters<typeof LocalSubtitleServerSupervisor>[0]["dependencies"]
      >["verifyBackend"]
    >[0],
  ) => Promise<LocalSubtitleServerBackendAttestation>;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

interface CleanupEvent {
  readonly root: string;
  readonly childClosed: boolean;
}

interface SupervisorHarness {
  readonly supervisor: LocalSubtitleServerSupervisor;
  readonly children: FakeChild[];
  readonly spawnRecords: SpawnRecord[];
  readonly cleanupEvents: CleanupEvent[];
}

function createHarness(options: HarnessOptions = {}): SupervisorHarness {
  const children = [...(options.children ?? [])];
  const clients = [...(options.clients ?? [])];
  const spawnRecords: SpawnRecord[] = [];
  const cleanupEvents: CleanupEvent[] = [];
  const childBySessionRoot = new Map<string, FakeChild>();
  let nextPort = 43_000;
  let cleanupFailures = options.cleanupFailures ?? 0;

  const supervisor = new LocalSubtitleServerSupervisor({
    managedResourceRoot: managedRoot(),
    startupTimeoutMs: options.startupTimeoutMs ?? 100,
    startupPollIntervalMs: 1,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    abortGraceMs: 5,
    terminateGraceMs: 5,
    forceKillGraceMs: 5,
    maxStartAttempts: 2,
    dependencies: {
      reservePort: async () => {
        const port = nextPort;
        nextPort += 1;
        return { port, release: async () => undefined };
      },
      createHttpClient: (_endpoint: LocalSubtitleServerHttpEndpoint) => {
        if (options.createHttpClientError) throw options.createHttpClientError;
        return clients.shift() ?? new FakeHttpClient();
      },
      spawnProcess: (command, args, spawnOptions) => {
        const child = children[spawnRecords.length] ?? new FakeChild();
        children[spawnRecords.length] = child;
        spawnRecords.push({ command, args: [...args], options: spawnOptions });
        const temporaryDirectory = spawnOptions.env?.TEMP;
        if (typeof temporaryDirectory === "string") {
          childBySessionRoot.set(path.dirname(temporaryDirectory), child);
        }
        return child.asChildProcess();
      },
      cleanupSession: async (session: LocalSubtitleServerSession) => {
        const child = childBySessionRoot.get(session.root);
        cleanupEvents.push({
          root: session.root,
          childClosed: child?.closed ?? false,
        });
        if (cleanupFailures > 0) {
          cleanupFailures -= 1;
          throw new Error("Injected transient session cleanup failure.");
        }
        return cleanupLocalSubtitleServerSession(session);
      },
      ...(options.verifyBackend === undefined
        ? {}
        : { verifyBackend: options.verifyBackend }),
    },
  });
  const harness = { supervisor, children, spawnRecords, cleanupEvents };
  harnesses.push(harness);
  return harness;
}

class FakeChild extends EventEmitter {
  static nextPid = 81_000;

  readonly pid = FakeChild.nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  readonly closeOnSignal: NodeJS.Signals | "never";
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;
  onKill: (signal: NodeJS.Signals) => void = () => undefined;

  constructor(options: {
    readonly closeOnSignal?: NodeJS.Signals | "never";
  } = {}) {
    super();
    this.closeOnSignal = options.closeOnSignal ?? "SIGTERM";
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    const normalized = typeof signal === "number" ? "SIGTERM" : signal;
    this.killSignals.push(normalized);
    this.onKill(normalized);
    if (this.closeOnSignal === normalized) {
      queueMicrotask(() => this.close(null, normalized));
    }
    return true;
  }

  close(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode, signalCode);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

type HealthOutcome =
  | LocalSubtitleServerHealthResponse
  | Error
  | (() => Promise<LocalSubtitleServerHealthResponse>);
type InferenceOutcome =
  | LocalSubtitleServerInferenceResponse
  | Error
  | ((request: LocalSubtitleServerInferenceRequest) =>
      Promise<LocalSubtitleServerInferenceResponse>);

class FakeHttpClient implements LocalSubtitleServerHttpClientLike {
  readonly sessionDisposition = "reusable" as const;
  readonly #readiness: HealthOutcome[];
  readonly #health: HealthOutcome[];
  readonly #inference: InferenceOutcome[];
  readinessCalls = 0;
  healthCalls = 0;
  inferenceCalls = 0;
  readonly inferenceRequests: LocalSubtitleServerInferenceRequest[] = [];

  constructor(options: {
    readonly readiness?: readonly HealthOutcome[];
    readonly health?: readonly HealthOutcome[];
    readonly inference?: readonly InferenceOutcome[];
  } = {}) {
    this.#readiness = [...(options.readiness ?? [])];
    this.#health = [...(options.health ?? [])];
    this.#inference = [...(options.inference ?? [])];
  }

  async probeReadiness(): Promise<LocalSubtitleServerHealthResponse> {
    this.readinessCalls += 1;
    return resolveOutcome(this.#readiness.shift() ?? HEALTHY);
  }

  async health(): Promise<LocalSubtitleServerHealthResponse> {
    this.healthCalls += 1;
    return resolveOutcome(this.#health.shift() ?? HEALTHY);
  }

  async inference(
    request: LocalSubtitleServerInferenceRequest,
  ): Promise<LocalSubtitleServerInferenceResponse> {
    this.inferenceCalls += 1;
    this.inferenceRequests.push(request);
    const outcome = this.#inference.shift() ?? inferenceResponse(request.requestGeneration);
    if (typeof outcome === "function") return outcome(request);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

async function resolveOutcome(
  outcome: HealthOutcome,
): Promise<LocalSubtitleServerHealthResponse> {
  if (typeof outcome === "function") return outcome();
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

function loadOptions(
  overrides: Partial<InferenceLoadOptions> = {},
): InferenceLoadOptions {
  return {
    verifiedRuntime,
    serverArtifactId: SERVER_ARTIFACT_ID,
    purpose: "inference",
    backend: "cpu",
    model: managedModel("large-v3-q5_0", HASH_A),
    vadModel: {
      storage: "managed",
      id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
      absolutePath: path.join(managedRoot(), "vad", "vad.bin"),
      byteSize: 885_098,
      sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
    },
    threads: 4,
    ...overrides,
  };
}

function noVadLoadOptions(): InferenceLoadOptions {
  const { vadModel: _vadModel, ...options } = loadOptions();
  return options;
}

function smokeLoadOptions(
  overrides: Partial<LocalSubtitleServerModelLoadSmokeOptions> = {},
): LocalSubtitleServerModelLoadSmokeOptions {
  return {
    verifiedRuntime,
    serverArtifactId: SERVER_ARTIFACT_ID,
    purpose: "model_load_smoke",
    backend: "cpu",
    model: {
      storage: "managed_staging",
      id: "large-v3-q5_0",
      absolutePath: path.join(
        managedRoot(),
        "model-staging",
        "large-v3-q5_0.bin",
      ),
      byteSize: 1_081_140_203,
      sha256: HASH_A,
    },
    threads: 1,
    ...overrides,
  };
}

function managedModel(id: string, sha256: string) {
  return {
    storage: "managed" as const,
    id,
    absolutePath: path.join(managedRoot(), "models", id, "model.bin"),
    byteSize: 1_081_140_203,
    sha256,
  };
}

function managedRoot(): string {
  return path.join(runtimeFixture.tempRoot, "managed");
}

function inferenceRequest(
  requestGeneration: number,
  signal?: AbortSignal,
): LocalSubtitleServerInferenceRequest {
  return {
    requestGeneration,
    filePath: path.join(managedRoot(), "windows", "window.wav"),
    language: "auto",
    taskMode: "transcribe",
    beamSize: 5,
    temperature: 0,
    vadEnabled: true,
    vadMinSilenceMs: 500,
    ...(signal === undefined ? {} : { signal }),
  };
}

function inferenceResponse(
  requestGeneration: number,
): LocalSubtitleServerInferenceResponse {
  return Object.freeze({
    requestGeneration,
    sessionDisposition: "reusable",
    result: Object.freeze({
      contractVersion: 1,
      task: "transcribe",
      language: "en",
      durationMs: 1_000,
      text: "test",
      segments: Object.freeze([]),
      wordTimelineStatus: "not_requested",
    }),
  });
}

function readiness503(): LocalSubtitleServerContractError {
  return new LocalSubtitleServerContractError(
    "http_error",
    "The local inference server is still starting.",
    {
      localSubtitleCode: "runtime_unresponsive",
      sessionDisposition: "reusable",
      httpStatus: 503,
    },
  );
}

function schemaFailure(): LocalSubtitleServerContractError {
  return new LocalSubtitleServerContractError(
    "invalid_response",
    "The local inference health response is invalid.",
    {
      localSubtitleCode: "runtime_protocol_mismatch",
      sessionDisposition: "restart_required",
    },
  );
}

function runtimeHealthFailure(): LocalSubtitleServerContractError {
  return new LocalSubtitleServerContractError(
    "timeout",
    "The ready local inference process stopped responding.",
    {
      localSubtitleCode: "runtime_unresponsive",
      sessionDisposition: "restart_required",
    },
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("The fake operation did not reach the expected state.");
}
