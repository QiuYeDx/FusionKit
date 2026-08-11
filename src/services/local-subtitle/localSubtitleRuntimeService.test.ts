import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskEventEnvelope,
  type LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleIpcResult,
  LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";
import { LocalSubtitleRuntimeService } from "./localSubtitleRuntimeService";

const NOW = "2026-07-21T00:00:00.000Z";

describe("local subtitle runtime service", () => {
  it("subscribes to both event channels before requesting a snapshot", async () => {
    const pending = deferred<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>();
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockImplementationOnce(() => pending.promise);
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });

    const starting = service.start();
    await Promise.resolve();
    expect(fake.callOrder).toEqual([
      "subscribe:task",
      "subscribe:resource",
      "snapshot",
    ]);

    fake.emitResource({
      revision: 6,
      event: { type: "resource-job-updated", job: resourceJob() },
    });
    pending.resolve({ ok: true, data: snapshot(5) });

    await expect(starting).resolves.toBe(true);
    expect(service.getState()).toMatchObject({
      syncStatus: "ready",
      revision: 6,
      resourceJobs: [{ jobId: "job-1" }],
    });
    service.disposeForTests();
  });

  it("deduplicates an event already covered by the snapshot", async () => {
    const pending = deferred<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>();
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockImplementationOnce(() => pending.promise);
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });

    const starting = service.start();
    fake.emitResource({
      revision: 6,
      event: { type: "resource-job-updated", job: resourceJob() },
    });
    pending.resolve({ ok: true, data: snapshot(6, [], [resourceJob()]) });

    await starting;
    expect(service.getState()).toMatchObject({
      revision: 6,
      resourceJobs: [{ jobId: "job-1" }],
    });
    expect(service.getState().resourceJobs).toHaveLength(1);
    service.disposeForTests();
  });

  it("keeps a covered missing task tombstoned after bootstrap", async () => {
    const pending = deferred<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>();
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockImplementationOnce(() => pending.promise);
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });

    const starting = service.start();
    await Promise.resolve();
    fake.emitTask(taskUpdatedEvent(1, task()));
    pending.resolve({
      ok: true,
      data: snapshot(2, [batch(task({ taskId: "other-task" }))]),
    });
    await starting;

    fake.emitTask(taskUpdatedEvent(3, task()));

    expect(service.getState().revision).toBe(3);
    expect(
      service.getState().batches[0]!.tasks.map((entry) => entry.taskId),
    ).toEqual(["other-task"]);
    service.disposeForTests();
  });

  it("keeps a covered missing resource job tombstoned after bootstrap", async () => {
    const pending = deferred<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>();
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockImplementationOnce(() => pending.promise);
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });

    const starting = service.start();
    await Promise.resolve();
    fake.emitResource({
      revision: 1,
      event: { type: "resource-job-updated", job: resourceJob() },
    });
    pending.resolve({ ok: true, data: snapshot(2) });
    await starting;

    fake.emitResource({
      revision: 3,
      event: { type: "resource-job-updated", job: resourceJob() },
    });

    expect(service.getState()).toMatchObject({ revision: 3, resourceJobs: [] });
    service.disposeForTests();
  });

  it("coalesces a cross-channel revision gap into a snapshot resync", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot
      .mockResolvedValueOnce({ ok: true, data: snapshot(5) })
      .mockResolvedValueOnce({
        ok: true,
        data: snapshot(8, [batch(task({ status: "transcribing" }))], [
          resourceJob(),
        ]),
      });
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });
    await service.start();

    fake.emitResource({
      revision: 6,
      event: { type: "resource-job-updated", job: resourceJob() },
    });
    fake.emitTask(taskUpdatedEvent(8, task({ status: "transcribing" })));

    await vi.waitFor(() => {
      expect(service.getState()).toMatchObject({
        syncStatus: "ready",
        revision: 8,
        batches: [{ batchId: "batch-1" }],
      });
    });
    expect(fake.getSessionSnapshot).toHaveBeenCalledTimes(2);
    service.disposeForTests();
  });

  it("resyncs a gap even when one renderer subscriber throws", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot
      .mockResolvedValueOnce({ ok: true, data: snapshot(5) })
      .mockResolvedValueOnce({
        ok: true,
        data: snapshot(6, [batch(task())]),
      });
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });
    await service.start();
    const unsubscribe = service.subscribe(() => {
      throw new Error("observer failed");
    });

    fake.emitTask(taskUpdatedEvent(6, task()));

    await vi.waitFor(() => {
      expect(service.getState()).toMatchObject({
        syncStatus: "ready",
        revision: 6,
        batches: [{ batchId: "batch-1" }],
      });
    });
    expect(fake.getSessionSnapshot).toHaveBeenCalledTimes(2);
    unsubscribe();
    service.disposeForTests();
  });

  it("stays dirty after a failed required snapshot and retries on the next event", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot
      .mockResolvedValueOnce({ ok: true, data: snapshot(5) })
      .mockResolvedValueOnce({
        ok: false,
        error: createLocalSubtitleError(
          "runtime_unresponsive",
          "snapshot unavailable",
        ),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: snapshot(7, [batch(task())], [resourceJob()]),
      });
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });
    await service.start();

    fake.emitTask(taskUpdatedEvent(6, task()));
    await vi.waitFor(() => {
      expect(service.getState().syncStatus).toBe("error");
    });

    fake.emitResource({
      revision: 7,
      event: { type: "resource-job-updated", job: resourceJob() },
    });

    expect(service.getState().syncStatus).not.toBe("ready");
    await vi.waitFor(() => {
      expect(service.getState()).toMatchObject({
        syncStatus: "ready",
        revision: 7,
        batches: [{ batchId: "batch-1" }],
        resourceJobs: [{ jobId: "job-1" }],
      });
    });
    expect(fake.getSessionSnapshot).toHaveBeenCalledTimes(3);
    service.disposeForTests();
  });

  it("keeps the highest dropped revision as the overflow snapshot floor", async () => {
    const pending = deferred<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>();
    const fake = createFakeApi();
    fake.getSessionSnapshot
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ ok: true, data: snapshot(11) });
    const service = new LocalSubtitleRuntimeService({
      getApi: () => fake.api,
      maxBufferedEvents: 2,
    });

    const starting = service.start();
    await Promise.resolve();
    for (const revision of [10, 11, 9]) {
      fake.emitResource({
        revision,
        event: { type: "resource-job-updated", job: resourceJob() },
      });
    }
    pending.resolve({ ok: true, data: snapshot(9) });

    await expect(starting).resolves.toBe(true);
    expect(fake.getSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(service.getState()).toMatchObject({
      syncStatus: "ready",
      revision: 11,
    });
    service.disposeForTests();
  });

  it("installs the single-flight promise before notifying subscribers", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockResolvedValue({ ok: true, data: snapshot(0) });
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });
    let refreshed = false;
    service.subscribe(() => {
      if (service.getState().syncStatus === "syncing" && !refreshed) {
        refreshed = true;
        void service.refresh();
      }
    });

    await service.start();

    expect(refreshed).toBe(true);
    expect(fake.getSessionSnapshot).toHaveBeenCalledOnce();
    service.disposeForTests();
  });

  it("ignores late snapshot and event callbacks after owner disposal", async () => {
    const pending = deferred<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>();
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockImplementationOnce(() => pending.promise);
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });

    const starting = service.start();
    await Promise.resolve();
    service.disposeForTests();
    pending.resolve({ ok: true, data: snapshot(4, [], [resourceJob()]) });

    await expect(starting).resolves.toBe(false);
    fake.emitResource({
      revision: 5,
      event: { type: "resource-job-updated", job: resourceJob() },
    });
    expect(service.getState()).toMatchObject({
      syncStatus: "idle",
      revision: 0,
      resourceJobs: [],
    });
  });

  it("keeps the page-level unsubscribe from owning IPC listeners", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockResolvedValue({ ok: true, data: snapshot(0) });
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });
    const pageListener = vi.fn();
    const unsubscribePage = service.subscribe(pageListener);
    await service.start();

    unsubscribePage();
    fake.emitResource({
      revision: 1,
      event: { type: "resource-job-updated", job: resourceJob() },
    });

    expect(service.getState()).toMatchObject({
      revision: 1,
      resourceJobs: [{ jobId: "job-1" }],
    });
    expect(fake.removeTaskListener).not.toHaveBeenCalled();
    expect(fake.removeResourceListener).not.toHaveBeenCalled();

    service.disposeForTests();
    expect(fake.removeTaskListener).toHaveBeenCalledOnce();
    expect(fake.removeResourceListener).toHaveBeenCalledOnce();
  });

  it("retains the last good state when snapshot refresh fails", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot
      .mockResolvedValueOnce({
        ok: true,
        data: snapshot(1, [], [resourceJob()]),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: createLocalSubtitleError(
          "runtime_unresponsive",
          "snapshot unavailable",
        ),
      });
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });
    await service.start();

    await expect(service.refresh()).resolves.toBe(false);
    expect(service.getState()).toMatchObject({
      syncStatus: "error",
      revision: 1,
      resourceJobs: [{ jobId: "job-1" }],
      error: { code: "runtime_unresponsive" },
    });
    service.disposeForTests();
  });

  it("does not retain raw transport errors that may contain paths or tokens", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockRejectedValue(
      new Error("failed at /private/media.wav for ls-input-secret"),
    );
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });

    await expect(service.start()).resolves.toBe(false);

    const serialized = JSON.stringify(service.getState());
    expect(serialized).not.toContain("/private/media.wav");
    expect(serialized).not.toContain("ls-input-secret");
    expect(service.getState()).toMatchObject({
      syncStatus: "error",
      error: {
        code: "runtime_unresponsive",
        details: { summary: "The renderer transport rejected the request." },
      },
    });
    service.disposeForTests();
  });

  it("registers IPC listeners only once across repeated starts", async () => {
    const fake = createFakeApi();
    fake.getSessionSnapshot.mockResolvedValue({ ok: true, data: snapshot(0) });
    const service = new LocalSubtitleRuntimeService({ getApi: () => fake.api });

    await Promise.all([service.start(), service.start(), service.start()]);

    expect(fake.onTaskEvent).toHaveBeenCalledOnce();
    expect(fake.onResourceEvent).toHaveBeenCalledOnce();
    expect(fake.getSessionSnapshot).toHaveBeenCalledOnce();
    service.disposeForTests();
  });
});

function createFakeApi() {
  const callOrder: string[] = [];
  let taskListener: ((event: LocalSubtitleTaskEventEnvelope) => void) | undefined;
  let resourceListener:
    | ((event: LocalSubtitleResourceEventEnvelope) => void)
    | undefined;
  const removeTaskListener = vi.fn();
  const removeResourceListener = vi.fn();
  const getSessionSnapshot = vi.fn<
    () => Promise<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>
  >(() => Promise.resolve({ ok: true, data: snapshot(0) }));
  const onTaskEvent = vi.fn((listener: typeof taskListener) => {
    callOrder.push("subscribe:task");
    taskListener = listener;
    return removeTaskListener;
  });
  const onResourceEvent = vi.fn((listener: typeof resourceListener) => {
    callOrder.push("subscribe:resource");
    resourceListener = listener;
    return removeResourceListener;
  });
  const api = {
    onTaskEvent,
    onResourceEvent,
    getSessionSnapshot: vi.fn(() => {
      callOrder.push("snapshot");
      return getSessionSnapshot();
    }),
    revokeInputFile: vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { revoked: true } }),
    ),
    revokeOutputDirectory: vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { revoked: true } }),
    ),
  } as unknown as LocalSubtitleRendererApi;
  return {
    api,
    callOrder,
    getSessionSnapshot,
    onTaskEvent,
    onResourceEvent,
    removeTaskListener,
    removeResourceListener,
    emitTask(event: LocalSubtitleTaskEventEnvelope) {
      taskListener?.(event);
    },
    emitResource(event: LocalSubtitleResourceEventEnvelope) {
      resourceListener?.(event);
    },
  };
}

function snapshot(
  revision: number,
  batches: readonly LocalSubtitleBatchSummary[] = [],
  resourceJobs: readonly LocalSubtitleResourceJobSummary[] = [],
): LocalSubtitleSessionSnapshot {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    revision,
    batches,
    resourceJobs,
  };
}

function batch(taskValue: LocalSubtitleTaskSummary): LocalSubtitleBatchSummary {
  return {
    batchId: taskValue.batchId,
    status: taskValue.status === "queued" ? "queued" : "running",
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "auto",
      resolvedBackend: "cpu",
      language: "auto",
      taskMode: "transcribe",
      qualityPreset: "subtitle_quality",
      vadEnabled: true,
      outputFormats: ["SRT"],
      outputMode: "source",
      conflictPolicy: "index",
      postActionMode: "export_only",
    },
    tasks: [taskValue],
    createdAt: NOW,
    updatedAt: taskValue.updatedAt,
  };
}

function task(
  overrides: Partial<LocalSubtitleTaskSummary> = {},
): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key",
    generation: 1,
    displayName: "sample.wav",
    status: "queued",
    progress: { stage: "queued", stageProgress: 0, overallProgress: 0 },
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

function taskUpdatedEvent(
  revision: number,
  taskValue: LocalSubtitleTaskSummary,
): LocalSubtitleTaskEventEnvelope {
  return {
    batchId: taskValue.batchId,
    taskId: taskValue.taskId,
    generation: taskValue.generation,
    revision,
    event: { type: "task-updated", task: taskValue },
  };
}

function resourceJob(): LocalSubtitleResourceJobSummary {
  return {
    jobId: "job-1",
    resourceId: "model-1",
    resourceType: "model",
    status: "queued",
    progress: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
