import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError,
  type LocalSubtitleArtifactResult,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleTaskSummary,
} from "../../src/type/localSubtitle";
import {
  localSubtitleResourceEventEnvelopeSchema,
  localSubtitleSessionSnapshotSchema,
  localSubtitleTaskEventEnvelopeSchema,
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

  it("allows more than ten task submissions in the flat task queue", () => {
    const registry = new LocalSubtitleSessionRegistry();

    for (let index = 1; index <= 11; index += 1) {
      const batchId = `batch-${index}`;
      registry.addBatch(
        OWNER_A,
        batch({
          batchId,
          tasks: [task({
            taskId: `task-${index}`,
            batchId,
            sourceKey: `source-key-${index}`,
          })],
        }),
      );
    }

    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 11,
      batches: expect.arrayContaining([
        expect.objectContaining({ batchId: "batch-11" }),
      ]),
    });
    expect(registry.getSnapshot(OWNER_A).batches).toHaveLength(11);
  });

  it("bounds a flat session by total tasks instead of internal batches", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const tasksPerBatch = LOCAL_SUBTITLE_LIMITS.maxBatchFiles;
    const batchCount = LOCAL_SUBTITLE_LIMITS.maxSessionTasks / tasksPerBatch;

    for (let batchIndex = 1; batchIndex <= batchCount; batchIndex += 1) {
      const batchId = `batch-${batchIndex}`;
      const taskOffset = (batchIndex - 1) * tasksPerBatch;
      registry.addBatch(
        OWNER_A,
        batch({
          batchId,
          tasks: Array.from({ length: tasksPerBatch }, (_, taskIndex) => {
            const ordinal = taskOffset + taskIndex + 1;
            return task({
              taskId: `task-${ordinal}`,
              batchId,
              sourceKey: `source-key-${ordinal}`,
            });
          }),
        }),
      );
    }

    expect(() =>
      registry.addBatch(
        OWNER_A,
        batch({
          batchId: "batch-overflow",
          tasks: [task({
            taskId: "task-overflow",
            batchId: "batch-overflow",
            sourceKey: "source-key-overflow",
          })],
        }),
      )
    ).toThrow(expect.objectContaining({
      code: "limit_exceeded",
      field: "tasks",
    }));
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

  it("publishes task and resource mutations on one owner revision cursor", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const taskEvents: unknown[] = [];
    const resourceEvents: unknown[] = [];
    registry.onTaskEvent(OWNER_A, (event) => taskEvents.push(event));
    registry.onTaskEvent(OWNER_A, () => {
      throw new Error("task delivery failed");
    });
    registry.onTaskEvent(OWNER_A, () =>
      Promise.reject(new Error("async task delivery failed")),
    );
    registry.onResourceEvent(OWNER_A, (event) => resourceEvents.push(event));

    const inserted = registry.addBatch(OWNER_A, batch());
    const resource = registry.upsertResourceJob(OWNER_A, resourceJob());
    const running = registry.upsertTask(
      OWNER_A,
      task({
        status: "preparing_media",
        progress: {
          stage: "preparing_media",
          stageProgress: 25,
          overallProgress: 5,
        },
        updatedAt: "2026-07-22T00:00:01.000Z",
      }),
    );
    await Promise.resolve();

    expect(inserted).toHaveLength(1);
    expect([inserted[0]?.revision, resource.revision, running.revision]).toEqual([
      1,
      2,
      3,
    ]);
    expect(taskEvents).toHaveLength(2);
    expect(resourceEvents).toHaveLength(1);
    expect(
      taskEvents.every(
        (event) => localSubtitleTaskEventEnvelopeSchema.safeParse(event).success,
      ),
    ).toBe(true);
    expect(taskEvents.every((event) => Object.isFrozen(event))).toBe(true);
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 3,
      batches: [
        {
          batchId: "batch-1",
          status: "running",
          tasks: [{ taskId: "task-1", status: "preparing_media" }],
        },
      ],
      resourceJobs: [{ jobId: "job-1" }],
    });
  });

  it("validates partial completion from artifact cancellation evidence", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const outputConfig = {
      ...batch().config,
      outputFormats: ["SRT", "LRC"] as const,
    };
    const advanceToExporting = (owner: LocalSubtitleOwnerKey) => {
      registry.addBatch(
        owner,
        batch({
          config: outputConfig,
          tasks: [task({ requestedFormats: ["SRT", "LRC"] })],
        }),
      );
      for (const [status, stageProgress, overallProgress] of [
        ["preparing_media", 100, 20],
        ["transcribing", 100, 80],
        ["post_processing", 100, 90],
        ["exporting", 50, 95],
      ] as const) {
        registry.upsertTask(
          owner,
          task({
            status,
            requestedFormats: ["SRT", "LRC"],
            progress: { stage: status, stageProgress, overallProgress },
          }),
        );
      }
    };
    const committed = committedArtifact("SRT");
    const ordinaryArtifacts = [
      committed,
      {
        format: "LRC",
        status: "failed",
        errorCode: "output_write_failed",
      },
    ] as const satisfies readonly LocalSubtitleArtifactResult[];
    advanceToExporting(OWNER_A);
    registry.upsertTask(
      OWNER_A,
      task({
        status: "cancelling",
        requestedFormats: ["SRT", "LRC"],
        progress: {
          stage: "cancelling",
          stageProgress: 0,
          overallProgress: 95,
        },
      }),
    );

    expect(
      registry.upsertTask(
        OWNER_A,
        task({
          status: "completed",
          requestedFormats: ["SRT", "LRC"],
          artifactResults: ordinaryArtifacts,
          completion: {
            outcome: "partial",
            artifacts: ordinaryArtifacts,
            warnings: [],
          },
          progress: {
            stage: "exporting",
            stageProgress: 100,
            overallProgress: 100,
          },
        }),
      ),
    ).toMatchObject({
      event: {
        task: {
          status: "completed",
          completion: { outcome: "partial", warnings: [] },
        },
      },
    });

    const cancelledArtifacts = [
      committed,
      {
        format: "LRC",
        status: "skipped",
        errorCode: "cancelled_after_partial_commit",
      },
    ] as const satisfies readonly LocalSubtitleArtifactResult[];
    advanceToExporting(OWNER_B);

    expect(
      registry.upsertTask(
        OWNER_B,
        task({
          status: "completed",
          requestedFormats: ["SRT", "LRC"],
          artifactResults: cancelledArtifacts,
          completion: {
            outcome: "partial",
            artifacts: cancelledArtifacts,
            warnings: ["cancelled_after_partial_commit"],
          },
          progress: {
            stage: "exporting",
            stageProgress: 100,
            overallProgress: 100,
          },
        }),
      ),
    ).toMatchObject({
      event: {
        task: {
          status: "completed",
          completion: {
            outcome: "partial",
            warnings: ["cancelled_after_partial_commit"],
          },
        },
      },
    });
  });

  it("commits staged batches without observation and can roll them back", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const listener = vi.fn();
    registry.onTaskEvent(OWNER_A, listener);
    const publication = registry.prepareBatchPublication(OWNER_A, batch());

    expect(publication.envelopes.map((event) => event.revision)).toEqual([1]);
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({ revision: 0, batches: [] });
    expect(publication.commit()).toBe(publication.envelopes);
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 1,
      batches: [{ batchId: "batch-1" }],
    });
    expect(listener).not.toHaveBeenCalled();

    publication.rollback();
    publication.rollback();
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({ revision: 0, batches: [] });
    expect(listener).not.toHaveBeenCalled();
    expect(() => publication.commit()).toThrow(
      expect.objectContaining({ code: "invalid_ipc_request" }),
    );
  });

  it("rejects a staged commit after another mutation advances the session", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const publication = registry.prepareBatchPublication(OWNER_A, batch());
    registry.upsertResourceJob(OWNER_A, resourceJob());

    expect(() => publication.commit()).toThrow(
      expect.objectContaining({ code: "invalid_content", field: "batch.publication" }),
    );
    publication.rollback();
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 1,
      batches: [],
      resourceJobs: [{ jobId: "job-1" }],
    });
  });

  it("serializes reentrant task and resource delivery by shared revision", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const delivered: string[] = [];
    registry.onTaskEvent(OWNER_A, (event) => {
      if (event.revision === 1) registry.upsertResourceJob(OWNER_A, resourceJob());
    });
    registry.onTaskEvent(OWNER_A, (event) => {
      delivered.push(`task:${event.revision}`);
    });
    registry.onResourceEvent(OWNER_A, (event) => {
      delivered.push(`resource:${event.revision}`);
    });

    const inserted = registry.addBatch(
      OWNER_A,
      batch({
        tasks: [
          task({ taskId: "task-1" }),
          task({ taskId: "task-2" }),
        ],
      }),
    );

    expect(inserted.map((event) => event.revision)).toEqual([1, 2]);
    expect(delivered).toEqual(["task:1", "task:2", "resource:3"]);
    expect(registry.getSnapshot(OWNER_A).revision).toBe(3);
  });

  it("stops queued delivery when a listener releases the owner", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const lateListener = vi.fn();
    registry.onTaskEvent(OWNER_A, () => {
      registry.releaseOwner(OWNER_A);
    });
    registry.onTaskEvent(OWNER_A, lateListener);

    registry.addBatch(
      OWNER_A,
      batch({
        tasks: [
          task({ taskId: "task-1" }),
          task({ taskId: "task-2" }),
        ],
      }),
    );

    expect(lateListener).not.toHaveBeenCalled();
    expect(() => registry.getSnapshot(OWNER_A)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
  });

  it("enforces legal same-generation transitions and monotonic progress", () => {
    const registry = new LocalSubtitleSessionRegistry();
    registry.addBatch(OWNER_A, batch());

    registry.upsertTask(
      OWNER_A,
      task({
        status: "preparing_media",
        progress: {
          stage: "preparing_media",
          stageProgress: 25,
          overallProgress: 5,
        },
        updatedAt: "2026-07-22T00:00:01.000Z",
      }),
    );
    registry.upsertTask(
      OWNER_A,
      task({
        status: "preparing_media",
        progress: {
          stage: "preparing_media",
          stageProgress: 50,
          overallProgress: 10,
        },
        updatedAt: "2026-07-22T00:00:02.000Z",
      }),
    );

    expect(() =>
      registry.upsertTask(
        OWNER_A,
        task({
          status: "preparing_media",
          progress: {
            stage: "preparing_media",
            stageProgress: 49,
            overallProgress: 10,
          },
          updatedAt: "2026-07-22T00:00:03.000Z",
        }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.progress",
    }));
    expect(() =>
      registry.upsertTask(
        OWNER_A,
        task({
          status: "loading_model",
          progress: {
            stage: "loading_model",
            stageProgress: 0,
            overallProgress: 9,
          },
          updatedAt: "2026-07-22T00:00:03.000Z",
        }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.progress",
    }));
    expect(() =>
      registry.upsertTask(
        OWNER_A,
        task({
          status: "post_processing",
          progress: {
            stage: "post_processing",
            stageProgress: 0,
            overallProgress: 20,
          },
          updatedAt: "2026-07-22T00:00:03.000Z",
        }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.status",
    }));
    expect(registry.getSnapshot(OWNER_A).revision).toBe(3);
  });

  it("rejects same-generation changes to immutable task fields", () => {
    const registry = new LocalSubtitleSessionRegistry();
    registry.addBatch(OWNER_A, batch());
    const mutations: readonly Partial<LocalSubtitleTaskSummary>[] = [
      { sourceKey: "replacement-source-key" },
      { displayName: "replacement.wav" },
      {
        model: {
          ...task().model,
          modelHash: "0".repeat(64),
        },
      },
      { resolvedBackend: "metal" },
      { requestedFormats: ["LRC"] },
      {
        createdAt: "2026-07-22T00:00:01.000Z",
        updatedAt: "2026-07-22T00:00:01.000Z",
      },
      {
        postAction: {
          mode: "enqueue_translation",
          preferredFormat: "SRT",
          importStatus: "pending",
          startStatus: "not_requested",
        },
      },
    ];

    for (const mutation of mutations) {
      expect(() => registry.upsertTask(OWNER_A, task(mutation))).toThrow(
        expect.objectContaining({
          code: "invalid_content",
          field: "task.immutable",
        }),
      );
    }
    expect(registry.getSnapshot(OWNER_A).revision).toBe(1);
  });

  it("enforces session-global task ids", () => {
    const registry = new LocalSubtitleSessionRegistry();
    registry.addBatch(OWNER_A, batch());

    expect(() =>
      registry.addBatch(
        OWNER_A,
        batch({
          batchId: "batch-2",
          tasks: [task({ batchId: "batch-2" })],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_content" }));
    expect(registry.getSnapshot(OWNER_A).revision).toBe(1);
  });

  it("admits a higher generation only as an exact failed-task retry", () => {
    const invalidInitial = new LocalSubtitleSessionRegistry();
    expect(() =>
      invalidInitial.addBatch(
        OWNER_A,
        batch({ tasks: [task({ generation: 2 })] }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "batch.tasks.generation",
    }));
    expect(invalidInitial.getSnapshot(OWNER_A).revision).toBe(0);

    const registry = new LocalSubtitleSessionRegistry();
    registry.addBatch(OWNER_A, batch());
    expect(() =>
      registry.upsertTask(
        OWNER_A,
        task({
          generation: 2,
          createdAt: "2026-07-22T00:00:01.000Z",
          updatedAt: "2026-07-22T00:00:01.000Z",
        }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.status",
    }));

    registry.upsertTask(
      OWNER_A,
      failedTask({ updatedAt: "2026-07-22T00:00:01.000Z" }),
    );
    expect(() =>
      registry.upsertTask(
        OWNER_A,
        task({ updatedAt: "2026-07-22T00:00:02.000Z" }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.status",
    }));
    expect(() =>
      registry.upsertTask(
        OWNER_A,
        task({
          generation: 3,
          createdAt: "2026-07-22T00:00:02.000Z",
          updatedAt: "2026-07-22T00:00:02.000Z",
        }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.generation",
    }));
    expect(() =>
      registry.upsertTask(
        OWNER_A,
        task({
          generation: 2,
          model: { ...task().model, modelHash: "0".repeat(64) },
          createdAt: "2026-07-22T00:00:02.000Z",
          updatedAt: "2026-07-22T00:00:02.000Z",
        }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.immutable",
    }));

    const retried = registry.upsertTask(
      OWNER_A,
      task({
        generation: 2,
        createdAt: "2026-07-22T00:00:02.000Z",
        updatedAt: "2026-07-22T00:00:02.000Z",
      }),
    );
    expect(retried).toMatchObject({
      generation: 2,
      event: { task: { status: "queued", generation: 2 } },
    });

    expect(() =>
      registry.upsertTask(
        OWNER_A,
        failedTask({ updatedAt: "2026-07-22T00:00:03.000Z" }),
      )
    ).toThrow(expect.objectContaining({
      code: "invalid_content",
      field: "task.generation",
    }));
    expect(registry.getSnapshot(OWNER_A).revision).toBe(3);
  });

  it("allows only an eligible GPU failure to change backend on the next generation", () => {
    const registry = new LocalSubtitleSessionRegistry();
    registry.addBatch(
      OWNER_A,
      batch({ tasks: [task({ resolvedBackend: "metal" })] }),
    );
    registry.upsertTask(
      OWNER_A,
      failedTask({
        resolvedBackend: "metal",
        error: createLocalSubtitleError(
          "runtime_crashed",
          "The GPU runtime failed.",
          { stage: "transcribing" },
        ),
        cpuRetryAvailable: true,
        updatedAt: "2026-07-22T00:00:01.000Z",
      }),
    );

    expect(() => registry.upsertTask(
      OWNER_A,
      task({
        generation: 2,
        resolvedBackend: "cuda",
        createdAt: "2026-07-22T00:00:02.000Z",
        updatedAt: "2026-07-22T00:00:02.000Z",
      }),
    )).toThrow(expect.objectContaining({ field: "task.immutable" }));

    const retried = registry.upsertTask(
      OWNER_A,
      task({
        generation: 2,
        resolvedBackend: "cpu",
        createdAt: "2026-07-22T00:00:02.000Z",
        updatedAt: "2026-07-22T00:00:02.000Z",
      }),
    );
    expect(retried).toMatchObject({
      generation: 2,
      event: { task: { status: "queued", resolvedBackend: "cpu" } },
    });
  });

  it("removes the final task and batch while retaining a generation tombstone", () => {
    const registry = new LocalSubtitleSessionRegistry();
    registry.addBatch(OWNER_A, batch());
    const removed = registry.removeTask(
      OWNER_A,
      "task-1",
      "2026-07-22T00:00:02.000Z",
    );

    expect(removed).toMatchObject({
      revision: 2,
      batchId: "batch-1",
      taskId: "task-1",
      generation: 1,
      event: { type: "task-removed" },
    });
    expect(registry.removeTask(OWNER_A, "task-1", NOW)).toBeUndefined();
    expect(registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 2,
      batches: [],
    });
    expect(() => registry.addBatch(OWNER_A, batch())).toThrow(
      expect.objectContaining({ code: "invalid_content" }),
    );
    expect(registry.getSnapshot(OWNER_A).revision).toBe(2);
  });

  it("sanitizes task failures before storing or emitting them", () => {
    const registry = new LocalSubtitleSessionRegistry();
    const privatePath = "/private/source/media.wav";
    registry.addBatch(OWNER_A, batch());

    const failed = registry.upsertTask(
      OWNER_A,
      task({
        status: "failed",
        progress: {
          stage: "transcribing",
          stageProgress: 40,
          overallProgress: 35,
        },
        error: createLocalSubtitleError(
          "transcription_failed",
          `failed at ${privatePath}`,
          {
            details: {
              summary: `token=secret at ${privatePath}`,
              truncated: false,
            },
          },
        ),
      }),
    );

    expect(JSON.stringify(failed)).not.toContain(privatePath);
    expect(JSON.stringify(failed)).not.toContain("token=secret");
    expect(failed).toMatchObject({
      event: {
        task: {
          error: {
            code: "transcription_failed",
            message: "The local subtitle task failed.",
          },
        },
      },
    });
  });

  it("shares shutdown and fences both existing and unseen owners", async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const listener = vi.fn();
    registry.onTaskEvent(OWNER_A, listener);
    registry.addBatch(OWNER_A, batch());

    const first = registry.shutdown();
    expect(registry.shutdown()).toBe(first);
    await first;
    expect(() => registry.getSnapshot(OWNER_A)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(() => registry.getSnapshot(OWNER_B)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(() => registry.addBatch(OWNER_A, batch())).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
    expect(listener).toHaveBeenCalledOnce();
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

function batch(
  overrides: Partial<LocalSubtitleBatchSummary> = {},
): LocalSubtitleBatchSummary {
  const tasks = overrides.tasks ?? [task()];
  return {
    batchId: "batch-1",
    status: tasks.every((entry) => entry.status === "queued")
      ? "queued"
      : "running",
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "cpu",
      resolvedBackend: "cpu",
      language: "auto",
      taskMode: "transcribe",
      vadEnabled: false,
      outputFormats: ["SRT"],
      outputMode: "source",
      conflictPolicy: "index",
      postActionMode: "export_only",
    },
    tasks,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function task(
  overrides: Partial<LocalSubtitleTaskSummary> = {},
): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key-1",
    generation: 1,
    displayName: "sample.wav",
    status: "queued",
    progress: {
      stage: "queued",
      stageProgress: 0,
      overallProgress: 0,
    },
    model: {
      engine: "whisper_cpp",
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
    },
    resolvedBackend: "cpu",
    requestedFormats: ["SRT"],
    artifactResults: [],
    postAction: {
      mode: "export_only",
      importStatus: "not_requested",
      startStatus: "not_requested",
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function committedArtifact(format: "SRT" | "LRC"): LocalSubtitleArtifactResult {
  const extension = format.toLowerCase();
  return {
    format,
    status: "committed",
    artifact: {
      artifactRef: `artifact-${extension}`,
      displayName: `sample.${extension}`,
      format,
      expiresAt: Date.parse("2026-07-23T00:00:00.000Z"),
    },
  };
}

function failedTask(
  overrides: Partial<LocalSubtitleTaskSummary> = {},
): LocalSubtitleTaskSummary {
  return task({
    status: "failed",
    error: createLocalSubtitleError(
      "transcription_failed",
      "Task execution failed.",
      { stage: "transcribing" },
    ),
    ...overrides,
  });
}
