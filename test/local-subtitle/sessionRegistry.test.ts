import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  createLocalSubtitleError,
  type LocalSubtitleResourceJobSummary,
} from "../../src/type/localSubtitle";
import {
  localSubtitleResourceEventEnvelopeSchema,
  localSubtitleSessionSnapshotSchema,
} from "../../src/type/localSubtitleIpc";
import type { LocalSubtitleOwnerKey } from "../../electron/main/local-subtitle/authorizations";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";

const OWNER_A = Object.freeze({
  webContentsId: 31,
  ownerSessionId: "session-registry-owner-a",
}) satisfies LocalSubtitleOwnerKey;
const OWNER_B = Object.freeze({
  webContentsId: 32,
  ownerSessionId: "session-registry-owner-b",
}) satisfies LocalSubtitleOwnerKey;
const NOW = "2026-07-22T00:00:00.000Z";

describe("LocalSubtitleSessionRegistry", () => {
  it("starts with an immutable MODEL-001 snapshot and empty batches", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const snapshot = registry.getSnapshot(OWNER_A);

    expect(snapshot).toEqual({
      schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
      revision: 0,
      batches: [],
      resourceJobs: [],
    });
    expect(localSubtitleSessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.batches)).toBe(true);
    expect(Object.isFrozen(snapshot.resourceJobs)).toBe(true);
  });

  it("increments one shared revision exactly once per update or removal", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const events: unknown[] = [];
    registry.onResourceEvent(OWNER_A, (event) => {
      events.push(event);
    });
    registry.onResourceEvent(OWNER_A, () => {
      throw new Error("delivery failed");
    });
    registry.onResourceEvent(OWNER_A, () => Promise.reject(new Error("async failure")));

    const queued = registry.upsertResourceJob(OWNER_A, resourceJob());
    const acquiring = registry.upsertResourceJob(
      OWNER_A,
      resourceJob({ status: "acquiring", progress: 20 }),
    );
    expect(registry.removeResourceJob(OWNER_A, "unknown-job", NOW)).toBeUndefined();
    const removed = registry.removeResourceJob(OWNER_A, "job-1", NOW);
    await Promise.resolve();

    expect([queued.revision, acquiring.revision, removed?.revision]).toEqual([
      1,
      2,
      3,
    ]);
    expect(events).toHaveLength(3);
    expect(
      events.every(
        (event) => localSubtitleResourceEventEnvelopeSchema.safeParse(event).success,
      ),
    ).toBe(true);
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 3,
      batches: [],
      resourceJobs: [],
    });
  });

  it("isolates owner revisions, snapshots, and event delivery", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const ownerAListener = vi.fn();
    const ownerBListener = vi.fn();
    registry.onResourceEvent(OWNER_A, ownerAListener);
    registry.onResourceEvent(OWNER_B, ownerBListener);

    registry.upsertResourceJob(OWNER_A, resourceJob());
    expect(registry.getResourceJob(OWNER_B, "job-1")).toBeUndefined();
    expect(registry.removeResourceJob(OWNER_B, "job-1", NOW)).toBeUndefined();
    registry.upsertResourceJob(
      OWNER_B,
      resourceJob({ jobId: "job-b", resourceId: "model-b" }),
    );

    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 1,
      resourceJobs: [{ jobId: "job-1" }],
    });
    expect(registry.getSnapshot(OWNER_B)).toMatchObject({
      revision: 1,
      resourceJobs: [{ jobId: "job-b" }],
    });
    expect(ownerAListener).toHaveBeenCalledOnce();
    expect(ownerBListener).toHaveBeenCalledOnce();
  });

  it("synchronously releases an owner and fences every late mutation", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.onResourceEvent(OWNER_A, listener);
    registry.upsertResourceJob(OWNER_A, resourceJob());

    expect(registry.releaseOwner(OWNER_A)).toBe(true);
    expect(registry.releaseOwner(OWNER_A)).toBe(false);
    unsubscribe();
    expect(() => registry.getSnapshot(OWNER_A)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(() =>
      registry.upsertResourceJob(
        OWNER_A,
        resourceJob({ status: "acquiring", progress: 10 }),
      )
    ).toThrow(expect.objectContaining({ code: "owner_released" }));
    expect(() => registry.removeResourceJob(OWNER_A, "job-1", NOW)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(listener).toHaveBeenCalledOnce();

    expect(registry.getSnapshot(OWNER_B)).toMatchObject({
      revision: 0,
      batches: [],
    });
  });

  it("rejects extra path fields and strips private error diagnostics", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const withPath = {
      ...resourceJob(),
      sourcePath: "/private/source/model.bin",
    };
    expect(() => registry.upsertResourceJob(OWNER_A, withPath as never)).toThrow(
      expect.objectContaining({ code: "invalid_content" }),
    );
    expect(registry.getSnapshot(OWNER_A).revision).toBe(0);

    const failed = registry.upsertResourceJob(
      OWNER_A,
      resourceJob({
        status: "failed",
        error: createLocalSubtitleError(
          "model_corrupt",
          "failed at /private/source/model.bin",
          {
            details: {
              summary: "token=secret at /private/source/model.bin",
              truncated: false,
            },
          },
        ),
      }),
    );
    expect(JSON.stringify(failed)).not.toContain("/private/source/model.bin");
    expect(JSON.stringify(failed)).not.toContain("token=secret");
    expect(failed).toMatchObject({
      event: {
        job: {
          error: {
            code: "model_corrupt",
            message: "The local subtitle resource operation failed.",
          },
        },
      },
    });
    expect(Object.isFrozen((failed.event as any).job.error)).toBe(true);
  });
});

function resourceJob(
  overrides: Partial<LocalSubtitleResourceJobSummary> = {},
): LocalSubtitleResourceJobSummary {
  return {
    jobId: "job-1",
    resourceId: "large-v3-q5_0",
    resourceType: "model",
    status: "queued",
    progress: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
