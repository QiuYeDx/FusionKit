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
  createLocalSubtitleServerSession,
  type LocalSubtitleServerSession,
} from "../../electron/main/local-subtitle/server-session";
import {
  LocalSubtitleServerSupervisor,
  LocalSubtitleServerSupervisorError,
  type LocalSubtitleServerBackendAttestation,
  type LocalSubtitleServerHttpClientLike,
  type LocalSubtitleServerModelLoadSmokeOptions,
  type LocalSubtitleServerSupervisorLoadOptions,
  type LocalSubtitleServerVadLoadSmokeOptions,
} from "../../electron/main/local-subtitle/server-supervisor";
import { createLocalSubtitleProductionBackendAttestor } from "../../electron/main/local-subtitle/backend-attestor";
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
      runtimePinCount: 0,
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
    expect(harness.children[0]?.killSignals).toEqual([]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: initial.processEpoch,
      leaseCount: 0,
    });
  });

  it("reuses a warm process epoch across sequential task leases", async () => {
    const client = new FakeHttpClient();
    const harness = createHarness({ clients: [client] });
    const firstLease = await harness.supervisor.acquire(OWNER_A, loadOptions());
    const first = await harness.supervisor.beginInference(
      firstLease,
      inferenceRequest(1),
    ).result;

    await harness.supervisor.release(firstLease);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: first.processEpoch,
      leaseCount: 0,
    });
    expect(harness.children[0]?.killSignals).toEqual([]);

    const secondLease = await harness.supervisor.acquire(OWNER_B, loadOptions());
    const second = await harness.supervisor.beginInference(
      secondLease,
      inferenceRequest(2),
    ).result;

    expect(second.processEpoch).toBe(first.processEpoch);
    expect(harness.spawnRecords).toHaveLength(1);
    expect(client.readinessCalls).toBe(1);
    expect(client.healthCalls).toBe(2);
    expect(client.inferenceCalls).toBe(2);
    await harness.supervisor.release(secondLease);
    expect(harness.children[0]?.killSignals).toEqual([]);

    harness.supervisor.releaseOwner(OWNER_A);
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.children[0]?.killSignals).toEqual([]);
    harness.supervisor.releaseOwner(OWNER_B);
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("pins one exact runtime across task leases and blocks smoke, switches, and idle retirement", async () => {
    const client = new FakeHttpClient();
    const harness = createHarness({ clients: [client], idleTimeoutMs: 1 });
    const pin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-1",
      loadOptions(),
    );
    const processEpoch = harness.supervisor.snapshot.processEpoch;

    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      leaseCount: 0,
      runtimePinCount: 1,
      processEpoch,
    });
    await expect(
      harness.supervisor.smokeModelLoad(OWNER_B, smokeLoadOptions()),
    ).rejects.toMatchObject({ code: "resource_busy" });
    await expect(
      harness.supervisor.acquire(OWNER_B, noVadLoadOptions()),
    ).rejects.toMatchObject({ code: "resource_busy" });

    const firstLease = await harness.supervisor.acquirePinnedTaskLease(pin);
    const first = await harness.supervisor.beginInference(
      firstLease,
      inferenceRequest(1),
    ).result;
    await harness.supervisor.release(firstLease);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.children[0]?.killSignals).toEqual([]);

    const secondLease = await harness.supervisor.acquirePinnedTaskLease(pin);
    const second = await harness.supervisor.beginInference(
      secondLease,
      inferenceRequest(2),
    ).result;
    await harness.supervisor.release(secondLease);

    expect(first.processEpoch).toBe(processEpoch);
    expect(second.processEpoch).toBe(processEpoch);
    expect(harness.spawnRecords).toHaveLength(1);
    expect(client.readinessCalls).toBe(1);
    expect(client.inferenceCalls).toBe(2);

    harness.supervisor.releaseBatchRuntimePin(pin);
    await waitFor(() => harness.children[0]?.killSignals.includes("SIGTERM"));
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "unloaded",
      runtimePinCount: 0,
    });
  });

  it("publishes pin authority before startup awaits readiness", async () => {
    const readiness = deferred<LocalSubtitleServerHealthResponse>();
    const client = new FakeHttpClient({ readiness: [() => readiness.promise] });
    const harness = createHarness({ clients: [client] });

    const acquiring = harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-starting",
      loadOptions(),
    );
    await waitFor(() => client.readinessCalls === 1);

    expect(harness.supervisor.snapshot).toMatchObject({
      state: "starting",
      runtimePinCount: 1,
    });
    await expect(
      harness.supervisor.smokeModelLoad(OWNER_B, smokeLoadOptions()),
    ).rejects.toMatchObject({ code: "resource_busy" });
    await expect(
      harness.supervisor.acquire(OWNER_B, noVadLoadOptions()),
    ).rejects.toMatchObject({ code: "resource_busy" });

    readiness.resolve(HEALTHY);
    const pin = await acquiring;
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      runtimePinCount: 1,
    });
    harness.supervisor.releaseBatchRuntimePin(pin);
  });

  it("keeps a compatible owner pin alive when another owner is released", async () => {
    const harness = createHarness();
    const firstPin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-a",
      loadOptions(),
    );
    const secondPin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_B,
      "batch-b",
      loadOptions(),
    );
    const processEpoch = harness.supervisor.snapshot.processEpoch;

    harness.supervisor.releaseOwner(OWNER_A);
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.children[0]?.killSignals).toEqual([]);
    await expect(
      harness.supervisor.acquirePinnedTaskLease(firstPin),
    ).rejects.toMatchObject({ code: "owner_released" });

    const lease = await harness.supervisor.acquirePinnedTaskLease(secondPin);
    await expect(
      harness.supervisor.beginInference(lease, inferenceRequest(1)).result,
    ).resolves.toMatchObject({ processEpoch });
    await harness.supervisor.release(lease);
    harness.supervisor.releaseBatchRuntimePin(secondPin);
    harness.supervisor.releaseOwner(OWNER_B);
    await harness.supervisor.drainBackgroundCleanup();

    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
  });

  it("rejects pre-aborted warm acquire and pin paths without leaking authority", async () => {
    const controller = new AbortController();
    controller.abort();

    const acquireHarness = createHarness();
    const warmLease = await acquireHarness.supervisor.acquire(
      OWNER_A,
      loadOptions(),
    );
    await acquireHarness.supervisor.release(warmLease);
    await expect(
      acquireHarness.supervisor.acquire(
        OWNER_B,
        loadOptions(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "owner_released" });
    expect(acquireHarness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 1,
      leaseCount: 0,
      runtimePinCount: 0,
    });
    expect(acquireHarness.spawnRecords).toHaveLength(1);

    const pinHarness = createHarness();
    const pinWarmLease = await pinHarness.supervisor.acquire(
      OWNER_A,
      loadOptions(),
    );
    await pinHarness.supervisor.release(pinWarmLease);
    await expect(
      pinHarness.supervisor.acquireBatchRuntimePin(
        OWNER_B,
        "batch-pre-aborted",
        loadOptions(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "owner_released" });
    expect(pinHarness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 1,
      leaseCount: 0,
      runtimePinCount: 0,
    });
    expect(pinHarness.spawnRecords).toHaveLength(1);

    const pinnedLeaseHarness = createHarness();
    const pin = await pinnedLeaseHarness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-pinned-pre-aborted",
      loadOptions(),
    );
    await expect(
      pinnedLeaseHarness.supervisor.acquirePinnedTaskLease(
        pin,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "owner_released" });
    expect(pinnedLeaseHarness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 1,
      leaseCount: 0,
      runtimePinCount: 1,
    });
    expect(pinnedLeaseHarness.spawnRecords).toHaveLength(1);
    pinnedLeaseHarness.supervisor.releaseBatchRuntimePin(pin);
  });

  it("revokes child task leases when their runtime pin is released", async () => {
    const harness = createHarness();
    const pin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-release-pin",
      loadOptions(),
    );
    const lease = await harness.supervisor.acquirePinnedTaskLease(pin);

    expect(harness.supervisor.snapshot).toMatchObject({
      leaseCount: 1,
      runtimePinCount: 1,
    });
    harness.supervisor.releaseBatchRuntimePin(pin);

    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      leaseCount: 0,
      runtimePinCount: 0,
    });
    expect(() =>
      harness.supervisor.beginInference(lease, inferenceRequest(1)),
    ).toThrow(expect.objectContaining({ code: "owner_released" }));
    await expect(harness.supervisor.release(lease)).resolves.toBeUndefined();
  });

  it("fences an active child request when its runtime pin is released", async () => {
    const firstClient = new FakeHttpClient({
      inference: [(request) =>
        new Promise<LocalSubtitleServerInferenceResponse>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new Error("pin released")),
            { once: true },
          );
        })],
    });
    const secondClient = new FakeHttpClient();
    const harness = createHarness({ clients: [firstClient, secondClient] });
    const firstPin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-active-release",
      loadOptions(),
    );
    const lease = await harness.supervisor.acquirePinnedTaskLease(firstPin);
    const inference = harness.supervisor.beginInference(
      lease,
      inferenceRequest(1),
    );
    await waitFor(() => firstClient.inferenceCalls === 1);

    harness.supervisor.releaseBatchRuntimePin(firstPin);

    await expect(inference.result).rejects.toBeInstanceOf(
      LocalSubtitleServerSupervisorError,
    );
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "unloaded",
      leaseCount: 0,
      runtimePinCount: 0,
      activeRequest: false,
    });

    const secondPin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-active-release",
      loadOptions(),
    );
    const secondLease = await harness.supervisor.acquirePinnedTaskLease(secondPin);
    await expect(
      harness.supervisor.beginInference(secondLease, inferenceRequest(2)).result,
    ).resolves.toMatchObject({ processEpoch: 2 });
    await harness.supervisor.release(secondLease);
    harness.supervisor.releaseBatchRuntimePin(secondPin);
  });

  it("refuses nonterminal shutdown while a runtime pin is active", async () => {
    const harness = createHarness();
    const pin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-nonterminal-shutdown",
      loadOptions(),
    );

    await expect(harness.supervisor.shutdown("idle")).rejects.toMatchObject({
      code: "resource_busy",
    });
    await expect(
      harness.supervisor.shutdown("last_owner"),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(harness.children[0]?.killSignals).toEqual([]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 1,
      leaseCount: 0,
      runtimePinCount: 1,
    });

    const lease = await harness.supervisor.acquirePinnedTaskLease(pin);
    await expect(
      harness.supervisor.beginInference(lease, inferenceRequest(1)).result,
    ).resolves.toMatchObject({ processEpoch: 1 });
    await harness.supervisor.release(lease);
    harness.supervisor.releaseBatchRuntimePin(pin);
  });

  it("re-arms idle retirement after owner release removes the final pin", async () => {
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
    const residentLease = await harness.supervisor.acquire(
      OWNER_A,
      loadOptions(),
    );
    await harness.supervisor.release(residentLease);
    const staleIdle = idleCallbacks.at(-1)!;
    const pin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_B,
      "batch-owner-release",
      loadOptions(),
    );
    const callbackCountBeforeRelease = idleCallbacks.length;

    harness.supervisor.releaseOwner(OWNER_B);
    await harness.supervisor.drainBackgroundCleanup();

    expect(idleCallbacks.length).toBeGreaterThan(callbackCountBeforeRelease);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      leaseCount: 0,
      runtimePinCount: 0,
    });
    await expect(
      harness.supervisor.acquirePinnedTaskLease(pin),
    ).rejects.toMatchObject({ code: "owner_released" });

    staleIdle();
    await Promise.resolve();
    expect(harness.children[0]?.killSignals).toEqual([]);

    idleCallbacks.at(-1)!();
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
    expect(harness.supervisor.snapshot.state).toBe("unloaded");
  });

  it("terminal shutdown fences runtime pins, child leases, and active requests", async () => {
    const pending = deferred<LocalSubtitleServerInferenceResponse>();
    const client = new FakeHttpClient({ inference: [() => pending.promise] });
    const harness = createHarness({ clients: [client] });
    const pin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-terminal-shutdown",
      loadOptions(),
    );
    const lease = await harness.supervisor.acquirePinnedTaskLease(pin);
    const inference = harness.supervisor.beginInference(
      lease,
      inferenceRequest(1),
    );
    await waitFor(() => client.inferenceCalls === 1);

    const shutdown = harness.supervisor.shutdown("app_quit");

    expect(harness.supervisor.shutdown("update")).toBe(shutdown);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "disposed",
      leaseCount: 0,
      runtimePinCount: 0,
      activeRequest: true,
    });
    await expect(
      harness.supervisor.acquirePinnedTaskLease(pin),
    ).rejects.toMatchObject({ code: "owner_released" });
    expect(() =>
      harness.supervisor.beginInference(lease, inferenceRequest(2)),
    ).toThrow(expect.objectContaining({ code: "shutdown" }));

    await expect(shutdown).resolves.toBeUndefined();
    await expect(inference.result).rejects.toBeInstanceOf(
      LocalSubtitleServerSupervisorError,
    );
    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "disposed",
      leaseCount: 0,
      runtimePinCount: 0,
      activeRequest: false,
    });
  });

  it("retires a warm zero-lease process after the idle timeout", async () => {
    const harness = createHarness({ idleTimeoutMs: 1 });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await harness.supervisor.release(lease);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      leaseCount: 0,
    });
    await waitFor(() => harness.children[0]?.killSignals.includes("SIGTERM"));
    await harness.supervisor.drainBackgroundCleanup();

    expect(harness.supervisor.snapshot).toMatchObject({
      state: "unloaded",
      leaseCount: 0,
    });
  });

  it("does not carry resident owners across an idle-retired process epoch", async () => {
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
    const first = await harness.supervisor.acquire(OWNER_A, loadOptions());
    await harness.supervisor.release(first);

    idleCallbacks.at(-1)!();
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.supervisor.snapshot.state).toBe("unloaded");

    const second = await harness.supervisor.acquire(OWNER_B, loadOptions());
    await harness.supervisor.release(second);
    harness.supervisor.releaseOwner(OWNER_B);
    await harness.supervisor.drainBackgroundCleanup();

    expect(harness.children[1]?.killSignals).toEqual(["SIGTERM"]);
    expect(harness.supervisor.snapshot.state).toBe("unloaded");
  });

  it("re-registers every active lease owner after an idle process restart", async () => {
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
    const first = await harness.supervisor.acquire(OWNER_A, loadOptions());
    const second = await harness.supervisor.acquire(OWNER_B, loadOptions());

    idleCallbacks.at(-1)!();
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "unloaded",
      leaseCount: 2,
    });

    await harness.supervisor.beginInference(first, inferenceRequest(1)).result;
    expect(harness.supervisor.snapshot.processEpoch).toBe(2);
    await harness.supervisor.release(first);
    await harness.supervisor.release(second);
    harness.supervisor.releaseOwner(OWNER_A);
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.children[1]?.killSignals).toEqual([]);

    harness.supervisor.releaseOwner(OWNER_B);
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.children[1]?.killSignals).toEqual(["SIGTERM"]);
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

  it("retires a VAD load smoke with pinned staging VAD and no inference", async () => {
    const child = new FakeChild({ closeOnSignal: "never" });
    const client = new FakeHttpClient();
    const harness = createHarness({ children: [child], clients: [client] });

    const smoke = harness.supervisor.smokeVadLoad(
      OWNER_A,
      vadSmokeLoadOptions(),
    );
    await waitFor(() => child.killSignals.includes("SIGTERM"));

    expect(client.readinessCalls).toBe(1);
    expect(client.inferenceCalls).toBe(0);
    expect(harness.supervisor.snapshot).toMatchObject({
      purpose: "vad_load_smoke",
      modelId: "large-v3-q5_0",
      vadModelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
    });
    expect(harness.spawnRecords[0]?.args).toEqual(expect.arrayContaining([
      "--vad-model",
      vadSmokeLoadOptions().vadModel.absolutePath,
      "--no-gpu",
    ]));

    child.close(null, "SIGTERM");
    await expect(smoke).resolves.toBeUndefined();
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "unloaded",
      leaseCount: 0,
      activeRequest: false,
    });
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
    harness.supervisor.releaseOwner(OWNER_B);
    await harness.supervisor.drainBackgroundCleanup();
    expect(harness.children[1]?.killSignals).toEqual(["SIGTERM"]);
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

  it("retires a warm epoch before acquiring an incompatible load identity", async () => {
    const harness = createHarness();
    const first = await harness.supervisor.acquire(OWNER_A, loadOptions());
    await harness.supervisor.release(first);

    const second = await harness.supervisor.acquire(
      OWNER_B,
      loadOptions({ model: managedModel("another-model", HASH_B) }),
    );

    expect(harness.children[0]?.killSignals).toEqual(["SIGTERM"]);
    expect(harness.spawnRecords).toHaveLength(2);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 2,
      modelId: "another-model",
      leaseCount: 1,
    });
    await harness.supervisor.release(second);
  });

  it("waits for an incompatible acquire to settle when its owner is released", async () => {
    const retirementEntered = deferred<void>();
    const allowRetirement = deferred<void>();
    let gateFirstCleanup = true;
    const harness = createHarness({
      beforeCleanupSession: async () => {
        if (!gateFirstCleanup) return;
        gateFirstCleanup = false;
        retirementEntered.resolve(undefined);
        await allowRetirement.promise;
      },
    });
    const first = await harness.supervisor.acquire(OWNER_A, loadOptions());
    await harness.supervisor.release(first);
    const acquiring = harness.supervisor.acquire(
      OWNER_B,
      loadOptions({ model: managedModel("another-model", HASH_B) }),
    );
    let acquireSettled = false;
    void acquiring.then(
      () => {
        acquireSettled = true;
      },
      () => {
        acquireSettled = true;
      },
    );
    await retirementEntered.promise;

    harness.supervisor.releaseOwner(OWNER_B);
    const cleanup = harness.supervisor.drainBackgroundCleanup();
    let cleanupSettled = false;
    void cleanup.then(
      () => {
        cleanupSettled = true;
      },
      () => {
        cleanupSettled = true;
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const waitedForAcquire = !cleanupSettled;
    allowRetirement.resolve(undefined);

    await expect(acquiring).rejects.toMatchObject({ code: "owner_released" });
    await cleanup;
    expect(waitedForAcquire).toBe(true);
    expect(acquireSettled).toBe(true);
    expect(harness.createdSessions).toHaveLength(1);
    expect(harness.spawnRecords).toHaveLength(1);
  });

  it("waits for an incompatible acquire before terminal shutdown completes", async () => {
    const retirementEntered = deferred<void>();
    const allowRetirement = deferred<void>();
    let gateFirstCleanup = true;
    const harness = createHarness({
      beforeCleanupSession: async () => {
        if (!gateFirstCleanup) return;
        gateFirstCleanup = false;
        retirementEntered.resolve(undefined);
        await allowRetirement.promise;
      },
    });
    const first = await harness.supervisor.acquire(OWNER_A, loadOptions());
    await harness.supervisor.release(first);
    const acquiring = harness.supervisor.acquire(
      OWNER_B,
      loadOptions({ model: managedModel("another-model", HASH_B) }),
    );
    let acquireSettled = false;
    let acquireError: unknown;
    const observedAcquire = acquiring.then(
      () => {
        acquireSettled = true;
      },
      (error: unknown) => {
        acquireSettled = true;
        acquireError = error;
      },
    );
    await retirementEntered.promise;

    const shutdown = harness.supervisor.shutdown("app_quit");
    allowRetirement.resolve(undefined);
    await expect(shutdown).resolves.toBeUndefined();
    const shutdownWaitedForAcquire = acquireSettled;
    await observedAcquire;

    expect(shutdownWaitedForAcquire).toBe(true);
    expect(acquireError).toMatchObject({ code: "owner_released" });
    expect(harness.createdSessions).toHaveLength(1);
    expect(harness.spawnRecords).toHaveLength(1);
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

    const request = {
      ...inferenceRequest(1),
      expectedFileIdentity: { ...inferenceRequest(1).expectedFileIdentity },
    } as {
      requestGeneration: number;
      language: string;
      expectedFileIdentity: {
        dev: number;
        ino: number;
        size: number;
        mtimeMs: number;
        ctimeMs: number;
      };
    } & LocalSubtitleServerInferenceRequest;
    const originalExpectedFileIdentity = { ...request.expectedFileIdentity };
    const operation = harness.supervisor.beginInference(lease, request);
    request.requestGeneration = 99;
    request.language = "ja";
    request.expectedFileIdentity.ino += 1;
    request.expectedFileIdentity.size += 1;
    health.resolve(HEALTHY);
    await operation.result;

    expect(client.inferenceRequests[0]).toMatchObject({
      requestGeneration: 1,
      language: "auto",
      expectedFileIdentity: originalExpectedFileIdentity,
    });
    expect(Object.isFrozen(client.inferenceRequests[0])).toBe(true);
    expect(
      Object.isFrozen(client.inferenceRequests[0]!.expectedFileIdentity),
    ).toBe(true);
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

  it("caches shutdown before an abort listener reenters it", async () => {
    let harness!: SupervisorHarness;
    let reentered: Promise<void> | undefined;
    const client = new FakeHttpClient({
      inference: [(request) =>
        new Promise<LocalSubtitleServerInferenceResponse>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reentered = harness.supervisor.shutdown("fatal");
            reject(new Error("aborted by shutdown"));
          }, { once: true });
        })],
    });
    harness = createHarness({ clients: [client] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());
    const inference = harness.supervisor.beginInference(lease, inferenceRequest(1));
    await waitFor(() => client.inferenceCalls === 1);

    const first = harness.supervisor.shutdown("app_quit");

    expect(reentered).toBe(first);
    expect(harness.supervisor.shutdown("update")).toBe(first);
    await expect(first).resolves.toBeUndefined();
    await expect(inference.result).rejects.toBeInstanceOf(
      LocalSubtitleServerSupervisorError,
    );
  });

  it("escalates SIGTERM to SIGKILL and cleans only after close and late stderr", async () => {
    const child = new FakeChild({ closeOnSignal: "SIGKILL" });
    child.onKill = (signal) => {
      if (signal === "SIGKILL") child.stderr.write("late shutdown line\n");
    };
    const harness = createHarness({ children: [child] });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await harness.supervisor.release(lease);
    await harness.supervisor.shutdown("last_owner");

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

    await harness.supervisor.release(lease);
    await expect(harness.supervisor.shutdown("last_owner")).rejects.toMatchObject({
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

  it("latches an idle cleanup failure and retries it during shutdown", async () => {
    const harness = createHarness({ cleanupFailures: 1, idleTimeoutMs: 1 });
    const lease = await harness.supervisor.acquire(OWNER_A, loadOptions());

    await harness.supervisor.release(lease);
    await waitFor(() => harness.supervisor.snapshot.state === "faulted");
    await harness.supervisor.drainBackgroundCleanup();
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

  it("attests Metal from bounded opaque evidence bound to the exact child epoch", async () => {
    const child = new FakeChild();
    const client = new FakeHttpClient({
      readiness: [async () => {
        child.stderr.write("ggml_meta");
        child.stderr.write("l_init: loading kernels\nfound device: Apple GPU\n");
        return HEALTHY;
      }],
    });
    const attestor = createLocalSubtitleProductionBackendAttestor({
      platform: "darwin",
      arch: "arm64",
      metalEvidenceGraceMs: 25,
    });
    let evidenceKeys: string[] | undefined;
    const harness = createHarness({
      children: [child],
      clients: [client],
      verifyBackend: async (context) => {
        evidenceKeys = Object.keys(context.evidence);
        return attestor.verifyBackend(context);
      },
    });

    await expect(
      harness.supervisor.acquire(OWNER_A, loadOptions({ backend: "metal" })),
    ).resolves.toBeDefined();
    expect(evidenceKeys).toEqual([]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 1,
      processId: child.pid,
      backend: "metal",
      runtimeGeneration: verifiedRuntime.runtimeGeneration,
      serverArtifactId: SERVER_ARTIFACT_ID,
    });
    expect(harness.spawnRecords[0]?.args).not.toContain("--no-gpu");
  });

  it.each([
    ["missing device evidence", "ggml_metal_init: loading kernels\n"],
    [
      "an initialization failure",
      "ggml_metal_init: found device: Apple GPU\n" +
        "ggml_metal_init: error: could not create command queue\n",
    ],
  ])(
    "rejects Metal production attestation with %s",
    async (_label, diagnostics) => {
      const child = new FakeChild();
      const client = new FakeHttpClient({
        readiness: [async () => {
          child.stderr.write(diagnostics);
          return HEALTHY;
        }],
      });
      const attestor = createLocalSubtitleProductionBackendAttestor({
        platform: "darwin",
        arch: "arm64",
        metalEvidenceGraceMs: 10,
      });
      const harness = createHarness({
        children: [child],
        clients: [client],
        verifyBackend: attestor.verifyBackend,
      });

      await expect(
        harness.supervisor.acquire(OWNER_A, loadOptions({ backend: "metal" })),
      ).rejects.toMatchObject({ code: "backend_unverified", processEpoch: 1 });
      expect(child.killSignals).toEqual(["SIGTERM"]);
    },
  );

  it("rejects a Metal failure marker that arrives after positive startup markers", async () => {
    const child = new FakeChild();
    const client = new FakeHttpClient({
      readiness: [async () => {
        child.stderr.write(
          "ggml_metal_init: loading kernels\nfound device: Apple GPU\n",
        );
        setTimeout(() => {
          child.stderr.write(
            "ggml_metal_init: error: late command queue failure\n",
          );
        }, 0);
        return HEALTHY;
      }],
    });
    const attestor = createLocalSubtitleProductionBackendAttestor({
      platform: "darwin",
      arch: "arm64",
      metalEvidenceGraceMs: 25,
    });
    const harness = createHarness({
      children: [child],
      clients: [client],
      verifyBackend: attestor.verifyBackend,
    });

    await expect(
      harness.supervisor.acquire(OWNER_A, loadOptions({ backend: "metal" })),
    ).rejects.toMatchObject({ code: "backend_unverified" });
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("rejects Metal evidence when the production attestor target is unsupported", async () => {
    const child = new FakeChild();
    const client = new FakeHttpClient({
      readiness: [async () => {
        child.stderr.write(
          "ggml_metal_init: loading kernels\nfound device: Apple GPU\n",
        );
        return HEALTHY;
      }],
    });
    const attestor = createLocalSubtitleProductionBackendAttestor({
      platform: "win32",
      arch: "x64",
      metalEvidenceGraceMs: 10,
    });
    const harness = createHarness({
      children: [child],
      clients: [client],
      verifyBackend: attestor.verifyBackend,
    });

    expect(attestor.supportedBackends).toEqual([]);
    await expect(
      harness.supervisor.acquire(OWNER_A, loadOptions({ backend: "metal" })),
    ).rejects.toMatchObject({ code: "backend_unverified" });
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

  it("ignores an idle callback superseded on the same warm process epoch", async () => {
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
    const first = await harness.supervisor.acquire(OWNER_A, loadOptions());
    await harness.supervisor.release(first);
    expect(idleCallbacks.length).toBeGreaterThanOrEqual(2);
    const superseded = idleCallbacks.at(-1)!;

    const second = await harness.supervisor.acquire(OWNER_A, loadOptions());
    superseded();
    await Promise.resolve();

    expect(harness.children[0]?.killSignals).toEqual([]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 1,
      leaseCount: 1,
    });
    await harness.supervisor.release(second);
  });

  it("ignores a warm idle callback after the same epoch becomes batch-pinned", async () => {
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
    await harness.supervisor.release(lease);
    const staleIdle = idleCallbacks.at(-1)!;

    const pin = await harness.supervisor.acquireBatchRuntimePin(
      OWNER_A,
      "batch-pinned",
      loadOptions(),
    );
    staleIdle();
    await Promise.resolve();

    expect(harness.children[0]?.killSignals).toEqual([]);
    expect(harness.supervisor.snapshot).toMatchObject({
      state: "ready",
      processEpoch: 1,
      runtimePinCount: 1,
    });
    harness.supervisor.releaseBatchRuntimePin(pin);
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
  readonly beforeCleanupSession?: (
    session: LocalSubtitleServerSession,
  ) => Promise<void>;
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
  readonly createdSessions: LocalSubtitleServerSession[];
  readonly cleanupEvents: CleanupEvent[];
}

function createHarness(options: HarnessOptions = {}): SupervisorHarness {
  const children = [...(options.children ?? [])];
  const clients = [...(options.clients ?? [])];
  const spawnRecords: SpawnRecord[] = [];
  const createdSessions: LocalSubtitleServerSession[] = [];
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
      createSession: async (managedResourceRoot) => {
        const session = await createLocalSubtitleServerSession(
          managedResourceRoot,
        );
        createdSessions.push(session);
        return session;
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
        await options.beforeCleanupSession?.(session);
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
  const harness = {
    supervisor,
    children,
    spawnRecords,
    createdSessions,
    cleanupEvents,
  };
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

function vadSmokeLoadOptions(
  overrides: Partial<LocalSubtitleServerVadLoadSmokeOptions> = {},
): LocalSubtitleServerVadLoadSmokeOptions {
  return {
    verifiedRuntime,
    serverArtifactId: SERVER_ARTIFACT_ID,
    purpose: "vad_load_smoke",
    backend: "cpu",
    model: managedModel("large-v3-q5_0", HASH_A),
    vadModel: {
      storage: "managed_staging",
      id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
      absolutePath: path.join(managedRoot(), "vad-staging", "vad.bin"),
      byteSize: 885_098,
      sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
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
    expectedFileIdentity: Object.freeze({
      dev: 1,
      ino: 2,
      size: 4_096,
      mtimeMs: 1_000.25,
      ctimeMs: 1_000.5,
    }),
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
