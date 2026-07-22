import { describe, expect, it, vi } from "vitest";
import { createLocalSubtitleError } from "../../src/type/localSubtitle";
import { localSubtitleSessionSnapshotSchema } from "../../src/type/localSubtitleIpc";
import type { LocalSubtitleOwnerKey } from "../../electron/main/local-subtitle/authorizations";
import {
  LocalSubtitleResourceJobExecutionError,
  LocalSubtitleResourceJobManager,
} from "../../electron/main/local-subtitle/resource-job";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";

const OWNER_A = Object.freeze({
  webContentsId: 41,
  ownerSessionId: "resource-job-owner-a",
}) satisfies LocalSubtitleOwnerKey;
const OWNER_B = Object.freeze({
  webContentsId: 42,
  ownerSessionId: "resource-job-owner-b",
}) satisfies LocalSubtitleOwnerKey;
const NOW = Date.parse("2026-07-22T01:00:00.000Z");

describe("LocalSubtitleResourceJobManager", () => {
  it("publishes a complete reusable model resource lifecycle", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const statuses: string[] = [];
    registry.onResourceEvent(OWNER_A, (envelope) => {
      if (envelope.event.type === "resource-job-updated") {
        statuses.push(envelope.event.job.status);
      }
    });
    const manager = managerFor(registry);

    const queued = manager.start({
      owner: OWNER_A,
      resourceId: "large-v3-q5_0",
      resourceType: "model",
      execute: (context) => {
        context.update({
          status: "acquiring",
          progress: 10,
          bytesCompleted: 10,
          bytesTotal: 100,
        });
        context.update({
          status: "acquiring",
          progress: 40,
          bytesCompleted: 40,
        });
        context.update({ status: "verifying", progress: 60 });
        context.update({ status: "load_smoke", progress: 80 });
        context.update({ status: "committing", progress: 95 });
        return { status: "completed" };
      },
    });

    expect(queued).toMatchObject({ status: "queued", progress: 0 });
    expect(registry.getSnapshot(OWNER_A).revision).toBe(1);
    await manager.waitForIdle();

    const snapshot = registry.getSnapshot(OWNER_A);
    expect(snapshot).toMatchObject({
      revision: 7,
      batches: [],
      resourceJobs: [
        {
          jobId: "job-1",
          status: "completed",
          progress: 100,
          bytesCompleted: 40,
          bytesTotal: 100,
        },
      ],
    });
    expect(statuses).toEqual([
      "queued",
      "acquiring",
      "acquiring",
      "verifying",
      "load_smoke",
      "committing",
      "completed",
    ]);
    expect(localSubtitleSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(Object.isFrozen(snapshot.resourceJobs[0])).toBe(true);
  });

  it("lets cancellation win before the commit boundary", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const manager = managerFor(registry);
    const started = deferred<void>();
    const finish = deferred<void>();
    let signal: AbortSignal | undefined;
    manager.start({
      owner: OWNER_A,
      resourceId: "large-v3-q5_0",
      resourceType: "model",
      execute: async (context) => {
        signal = context.signal;
        context.update({ status: "acquiring", progress: 25 });
        started.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await started.promise;

    expect(manager.cancel(OWNER_A, "job-1")).toEqual({ cancelled: true });
    expect(signal?.aborted).toBe(true);
    expect(manager.cancel(OWNER_A, "job-1")).toEqual({ cancelled: false });
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 3,
      resourceJobs: [{ status: "cancelling" }],
    });

    finish.resolve();
    await manager.waitForIdle();
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 4,
      resourceJobs: [{ status: "cancelled", progress: 25 }],
    });
  });

  it("lets a committed operation complete after a cancellation race", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const manager = managerFor(registry);
    const committing = deferred<void>();
    const finish = deferred<void>();
    manager.start({
      owner: OWNER_A,
      resourceId: "large-v3-q5_0",
      resourceType: "model",
      execute: async (context) => {
        context.update({ status: "acquiring", progress: 20 });
        context.update({ status: "verifying", progress: 50 });
        context.update({ status: "load_smoke", progress: 75 });
        context.update({ status: "committing", progress: 90 });
        committing.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await committing.promise;

    expect(manager.cancel(OWNER_A, "job-1")).toEqual({ cancelled: true });
    finish.resolve();
    await manager.waitForIdle();

    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 7,
      resourceJobs: [{ status: "completed", progress: 100 }],
    });
    expect(manager.cancel(OWNER_A, "job-1")).toEqual({ cancelled: false });
    expect(registry.getSnapshot(OWNER_A).revision).toBe(7);
  });

  it("does not reveal another owner's known job through cancellation", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const manager = managerFor(registry);
    const started = deferred<void>();
    const finish = deferred<void>();
    manager.start({
      owner: OWNER_A,
      resourceId: "large-v3-q5_0",
      resourceType: "model",
      execute: async (context) => {
        context.update({ status: "acquiring", progress: 15 });
        started.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await started.promise;

    const knownOtherOwnerJob = manager.cancel(OWNER_B, "job-1");
    const unknownJob = manager.cancel(OWNER_B, "unknown-job");
    expect(knownOtherOwnerJob).toEqual(unknownJob);
    expect(knownOtherOwnerJob).toEqual({ cancelled: false });
    expect(Object.isFrozen(knownOtherOwnerJob)).toBe(true);
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 2,
      resourceJobs: [{ status: "acquiring" }],
    });
    expect(registry.getSnapshot(OWNER_B)).toMatchObject({
      revision: 0,
      resourceJobs: [],
    });

    expect(manager.cancel(OWNER_A, "job-1")).toEqual({ cancelled: true });
    finish.resolve();
    await manager.waitForIdle();
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 4,
      resourceJobs: [{ status: "cancelled" }],
    });
  });

  it("synchronously fences owner release from late updates and completion", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const listener = vi.fn();
    registry.onResourceEvent(OWNER_A, listener);
    const manager = managerFor(registry);
    const started = deferred<void>();
    const finish = deferred<void>();
    let signal: AbortSignal | undefined;
    let lateUpdateError: unknown;
    manager.start({
      owner: OWNER_A,
      resourceId: "large-v3-q5_0",
      resourceType: "model",
      execute: async (context) => {
        signal = context.signal;
        context.update({ status: "acquiring", progress: 20 });
        started.resolve();
        await finish.promise;
        try {
          context.update({ status: "verifying", progress: 50 });
        } catch (error) {
          lateUpdateError = error;
        }
        return { status: "completed" };
      },
    });
    await started.promise;

    manager.releaseOwner(OWNER_A);
    expect(signal?.aborted).toBe(true);
    expect(() => registry.getSnapshot(OWNER_A)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(() =>
      manager.start({
        owner: OWNER_A,
        resourceId: "large-v3-q5_0",
        resourceType: "model",
        execute: () => undefined,
      }),
    ).toThrow(expect.objectContaining({ code: "owner_released" }));
    expect(() => manager.releaseOwner(OWNER_A)).not.toThrow();

    finish.resolve();
    await manager.waitForOwnerIdle(OWNER_A);
    expect(lateUpdateError).toBeInstanceOf(TypeError);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.getSnapshot(OWNER_B)).toMatchObject({
      revision: 0,
      resourceJobs: [],
    });
  });

  it("shares reentrant shutdown while synchronously aborting and awaiting cleanup", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const manager = managerFor(registry);
    const startedA = deferred<void>();
    const startedB = deferred<void>();
    const cleanupA = deferred<void>();
    const cleanupB = deferred<void>();
    const abortListener = vi.fn();
    let reentrantShutdown: Promise<void> | undefined;

    manager.start({
      owner: OWNER_A,
      resourceId: "large-v3-q5_0",
      resourceType: "model",
      execute: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            abortListener("a");
            reentrantShutdown = manager.shutdown();
          },
          { once: true },
        );
        startedA.resolve();
        await cleanupA.promise;
      },
    });
    manager.start({
      owner: OWNER_B,
      resourceId: "silero-v6.2.0",
      resourceType: "vad",
      execute: async ({ signal }) => {
        signal.addEventListener("abort", () => abortListener("b"), {
          once: true,
        });
        startedB.resolve();
        await cleanupB.promise;
      },
    });
    await Promise.all([startedA.promise, startedB.promise]);

    const shutdown = manager.shutdown();
    expect(reentrantShutdown).toBe(shutdown);
    expect(abortListener.mock.calls).toEqual([["a"], ["b"]]);
    expect(manager.shutdown()).toBe(shutdown);
    expect(() => registry.getSnapshot(OWNER_A)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(() => registry.getSnapshot(OWNER_B)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );

    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    cleanupA.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    cleanupB.resolve();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("sanitizes declared and unexpected path-bearing failures", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const manager = managerFor(registry);
    manager.start({
      owner: OWNER_A,
      resourceId: "large-v3-q5_0",
      resourceType: "model",
      execute: () => {
        throw new LocalSubtitleResourceJobExecutionError(
          createLocalSubtitleError(
            "model_corrupt",
            "Model verification failed at /private/models/source.bin.",
            {
              details: {
                summary: "token=secret path=/private/models/source.bin",
                truncated: false,
              },
              causeCode: "invalid_content",
            },
          ),
        );
      },
    });
    manager.start({
      owner: OWNER_A,
      resourceId: "imported-model",
      resourceType: "model",
      execute: () => {
        throw new Error(
          "Unexpected failure at /Users/private/import.bin with token=secret.",
        );
      },
    });

    await manager.waitForIdle();
    const snapshot = registry.getSnapshot(OWNER_A);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("/private/models/source.bin");
    expect(serialized).not.toContain("/Users/private/import.bin");
    expect(serialized).not.toContain("token=secret");
    expect(snapshot.resourceJobs).toMatchObject([
      {
        jobId: "job-1",
        status: "failed",
        error: {
          code: "model_corrupt",
          message: "The local subtitle resource operation failed.",
          causeCode: "invalid_content",
        },
      },
      {
        jobId: "job-2",
        status: "failed",
        error: {
          code: "resource_not_allowed",
          message: "The local subtitle resource operation failed.",
        },
      },
    ]);
    expect(snapshot.resourceJobs[0]?.error).not.toHaveProperty("details");
    expect(snapshot.resourceJobs[1]?.error).not.toHaveProperty("details");
  });
});

function managerFor(
  registry: LocalSubtitleSessionRegistry,
): LocalSubtitleResourceJobManager {
  let nextJobId = 1;
  return new LocalSubtitleResourceJobManager(registry, {
    now: () => NOW,
    jobIdFactory: () => `job-${nextJobId++}`,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
