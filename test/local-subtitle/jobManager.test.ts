import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError,
  type LocalSubtitleArtifactResult,
} from "../../src/type/localSubtitle";
import type { EnqueueLocalSubtitleBatchRequest } from "../../src/type/localSubtitleIpc";
import {
  LocalSubtitleCapabilityLeaseCoordinator,
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  type LocalSubtitleOwnerKey,
} from "../../electron/main/local-subtitle/authorizations";
import {
  LocalSubtitleJobManager,
  type LocalSubtitleJobTaskExecutionContext,
  type LocalSubtitleJobTaskExecutor,
} from "../../electron/main/local-subtitle/job-manager";
import { LocalSubtitleSessionRegistry } from "../../electron/main/local-subtitle/session-registry";

const OWNER_A = Object.freeze({
  webContentsId: 71,
  ownerSessionId: "job-manager-owner-a",
}) satisfies LocalSubtitleOwnerKey;
const OWNER_B = Object.freeze({
  webContentsId: 72,
  ownerSessionId: "job-manager-owner-b",
}) satisfies LocalSubtitleOwnerKey;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LocalSubtitleJobManager", () => {
  it("atomically publishes a frozen CPU no-VAD batch before execution", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    const events: unknown[] = [];
    harness.manager.onTaskEvent(OWNER_A, (event) => events.push(event));
    const request = await harness.createRequest(harness.fileToken);

    const batch = await harness.manager.enqueue(OWNER_A, request);
    request.config.language = "ja";
    request.config.advanced.initialPrompt = "mutated";

    expect(batch).toMatchObject({
      batchId: "batch-1",
      status: "queued",
      config: {
        devicePreference: "cpu",
        resolvedBackend: "cpu",
        language: "auto",
        vadEnabled: false,
        outputFormats: ["SRT"],
      },
      tasks: [
        {
          taskId: "task-1",
          generation: 1,
          status: "queued",
          displayName: "sample.wav",
        },
      ],
    });
    expect(harness.executor.execute).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.tasks[0])).toBe(true);
    expect(harness.inputs.revokeDraft(OWNER_A, harness.fileToken)).toBe(false);

    harness.flushScheduled();
    await harness.manager.waitForIdle();
    expect(harness.executor.execute).toHaveBeenCalledOnce();
    const context = harness.executor.execute.mock.calls[0]![0];
    expect(context.config.language).toBe("auto");
    expect(context.config.inference.advanced.initialPrompt).toBe("original");
    expect(Object.isFrozen(context.config)).toBe(true);
  });

  it("serializes the complete working-stage chain into one revision stream", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    const revisions: number[] = [];
    const statuses: string[] = [];
    harness.manager.onTaskEvent(OWNER_A, (event) => {
      revisions.push(event.revision);
      statuses.push(
        event.event.type === "task-updated"
          ? event.event.task.status
          : event.event.type,
      );
    });

    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(statuses).toEqual([
      "queued",
      "preparing_media",
      "preparing_media",
      "loading_model",
      "transcribing",
      "post_processing",
      "exporting",
      "completed",
    ]);
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      revision: 8,
      batches: [
        {
          status: "completed",
          tasks: [
            {
              status: "completed",
              progress: { stageProgress: 100, overallProgress: 100 },
              completion: { outcome: "full", warnings: [] },
              artifactResults: [
                { format: "SRT", status: "committed" },
              ],
            },
          ],
        },
      ],
    });
    await expect(
      harness.inputs.resolveTaskLease(
        OWNER_A,
        "task-1",
        "transcribe",
      ),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
  });

  it("runs an app-scoped FIFO across owners", async () => {
    const first = deferred<void>();
    const starts: string[] = [];
    const harness = await createHarness({
      executor: executor(async (context) => {
        starts.push(context.taskId);
        if (context.taskId === "task-1") await first.promise;
        return successfulExecution(context);
      }),
      taskIds: ["task-1", "task-2"],
      batchIds: ["batch-1", "batch-2"],
    });
    const secondInput = await authorizeInput(harness.inputs, OWNER_B, "second.wav");

    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    await harness.manager.enqueue(
      OWNER_B,
      await harness.createRequest(secondInput.fileToken, OWNER_B),
    );
    harness.flushScheduled();
    await waitFor(() => starts.length === 1);
    expect(starts).toEqual(["task-1"]);

    first.resolve();
    await harness.manager.waitForIdle();
    expect(starts).toEqual(["task-1", "task-2"]);
    expect(harness.manager.getSessionSnapshot(OWNER_A).revision).toBe(8);
    expect(harness.manager.getSessionSnapshot(OWNER_B).revision).toBe(8);
  });

  it("preserves invocation-order FIFO while concurrent enqueue preflight finishes out of order", async () => {
    const firstModel = deferred<void>();
    const firstExecution = deferred<void>();
    const starts: string[] = [];
    const harness = await createHarness({
      executor: executor(async (context) => {
        starts.push(context.taskId);
        if (context.taskId === "task-1") await firstExecution.promise;
        return successfulExecution(context);
      }),
      taskIds: ["task-1", "task-2"],
      batchIds: ["batch-1", "batch-2"],
    });
    let modelResolution = 0;
    harness.modelResolver.resolveManagedModel.mockImplementation(async () => {
      modelResolution += 1;
      if (modelResolution === 1) await firstModel.promise;
      return harness.managedModel;
    });
    const secondInput = await authorizeInput(harness.inputs, OWNER_B, "second.wav");

    const firstEnqueue = harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    await waitFor(() => modelResolution === 1);
    const secondEnqueue = harness.manager.enqueue(
      OWNER_B,
      await harness.createRequest(secondInput.fileToken, OWNER_B),
    );
    await secondEnqueue;
    harness.flushScheduled();
    await Promise.resolve();
    expect(starts).toEqual([]);

    firstModel.resolve();
    await firstEnqueue;
    await waitFor(() => starts.length === 1);
    expect(starts).toEqual(["task-1"]);
    firstExecution.resolve();
    await harness.manager.waitForIdle();
    expect(starts).toEqual(["task-1", "task-2"]);
  });

  it("renews queued input and running output leases before their original expiry", async () => {
    const firstExecution = deferred<void>();
    const starts: string[] = [];
    const leaseClock = { now: 1_000 };
    const harness = await createHarness({
      executor: executor(async (context) => {
        starts.push(context.taskId);
        if (context.taskId === "task-1") await firstExecution.promise;
        return successfulExecution(context);
      }),
      taskIds: ["task-1", "task-2"],
      batchIds: ["batch-1", "batch-2"],
      leaseClock,
      leaseTtlMs: 100,
      leaseRenewalIntervalMs: 40,
      manualLeaseRenewal: true,
    });
    const outputRoot = path.join(harness.root, "output");
    await mkdir(outputRoot);
    const output = await harness.outputs.authorize(OWNER_A, outputRoot);
    const secondInput = await authorizeInput(harness.inputs, OWNER_B, "queued.wav");
    await harness.manager.enqueue(
      OWNER_A,
      customOutputRequest(harness.fileToken, output.outputDirToken),
    );
    await harness.manager.enqueue(
      OWNER_B,
      await harness.createRequest(secondInput.fileToken, OWNER_B),
    );
    harness.flushScheduled();
    await waitFor(() => starts.length === 1);

    leaseClock.now = 1_050;
    await harness.runLeaseRenewal();
    leaseClock.now = 1_101;
    await expect(
      harness.outputs.resolveBatchLease(OWNER_A, "batch-1"),
    ).resolves.toMatchObject({ directoryPath: await realpath(outputRoot) });

    firstExecution.resolve();
    await harness.manager.waitForIdle();
    expect(starts).toEqual(["task-1", "task-2"]);
  });

  it("cancels a queued task without invoking its executor", async () => {
    const first = deferred<void>();
    const harness = await createHarness({
      executor: executor(async (context) => {
        if (context.taskId === "task-1") await first.promise;
        return successfulExecution(context);
      }),
      taskIds: ["task-1", "task-2"],
      batchIds: ["batch-1", "batch-2"],
    });
    const secondInput = await authorizeInput(harness.inputs, OWNER_A, "queued.wav");
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(secondInput.fileToken),
    );
    harness.flushScheduled();
    await Promise.resolve();

    expect(harness.manager.cancelTask(OWNER_A, "task-2")).toEqual({
      cancelled: true,
    });
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        expect.anything(),
        { tasks: [{ taskId: "task-2", status: "cancelled" }] },
      ],
    });
    expect(harness.manager.cancelTask(OWNER_A, "task-2")).toEqual({
      cancelled: false,
    });

    first.resolve();
    await harness.manager.waitForIdle();
    expect(
      harness.executor.execute.mock.calls.map(([context]) => context.taskId),
    ).toEqual(["task-1"]);
  });

  it("aborts a running task and settles it as cancelled", async () => {
    const harness = await createHarness({
      executor: executor(
        (context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      ),
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await waitFor(() => harness.executor.execute.mock.calls.length === 1);

    expect(harness.manager.cancelTask(OWNER_A, "task-1")).toEqual({
      cancelled: true,
    });
    await harness.manager.waitForIdle();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [{ status: "cancelled", tasks: [{ status: "cancelled" }] }],
    });
  });

  it("preserves a fully committed result when cancellation arrives too late", async () => {
    const harness = await createHarness({
      executor: executor(
        (context) =>
          new Promise((resolve) => {
            advanceExecutionToExporting(context);
            context.signal.addEventListener(
              "abort",
              () => resolve({
                status: "completed",
                artifactResults: [committedArtifact()],
                durationMs: 1_000,
              }),
              { once: true },
            );
          }),
      ),
    });
    const statuses: string[] = [];
    harness.manager.onTaskEvent(OWNER_A, (event) => {
      if (event.event.type === "task-updated") statuses.push(event.event.task.status);
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await waitFor(() => harness.executor.execute.mock.calls.length === 1);

    expect(harness.manager.cancelTask(OWNER_A, "task-1")).toEqual({
      cancelled: true,
    });
    await harness.manager.waitForIdle();

    expect(statuses.slice(-2)).toEqual(["cancelling", "completed"]);
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "completed",
          tasks: [
            {
              status: "completed",
              completion: { outcome: "full", warnings: [] },
              artifactResults: [{ format: "SRT", status: "committed" }],
            },
          ],
        },
      ],
    });
  });

  it("does not renew task leases after a fully committed result", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    const originalRenew = harness.inputs.renewTaskLease.bind(harness.inputs);
    let renewals = 0;
    vi.spyOn(harness.inputs, "renewTaskLease").mockImplementation(
      async (...args) => {
        renewals += 1;
        if (renewals > 1) throw new Error("late terminal renewal failed");
        return originalRenew(...args);
      },
    );

    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(renewals).toBe(1);
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [{ status: "completed", tasks: [{ status: "completed" }] }],
    });
  });

  it("preserves cancel_failed when executor cleanup fails after abort", async () => {
    const harness = await createHarness({
      executor: executor(
        (context) =>
          new Promise((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => resolve({
                status: "failed",
                error: createLocalSubtitleError(
                  "cancel_failed",
                  "private cleanup failure",
                  { stage: "cancelling" },
                ),
                artifactResults: [
                  {
                    format: "SRT",
                    status: "failed",
                    errorCode: "cancel_failed",
                  },
                ],
              }),
              { once: true },
            );
          }),
      ),
    });
    const request = await harness.createRequest(harness.fileToken);
    const releaseInputLease = vi.spyOn(harness.inputs, "releaseTaskLease");
    const releaseOutputLease = vi.spyOn(harness.outputs, "releaseBatchLease");
    await harness.manager.enqueue(OWNER_A, request);
    harness.flushScheduled();
    await waitFor(() => harness.executor.execute.mock.calls.length === 1);

    expect(harness.manager.cancelTask(OWNER_A, "task-1")).toEqual({
      cancelled: true,
    });
    await harness.manager.waitForIdle();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "failed",
          tasks: [
            {
              status: "failed",
              error: { code: "cancel_failed" },
              artifactResults: [
                { format: "SRT", status: "failed", errorCode: "cancel_failed" },
              ],
            },
          ],
        },
      ],
    });
    expect(releaseInputLease).toHaveBeenCalledWith(OWNER_A, "task-1");
    expect(releaseOutputLease).toHaveBeenCalledWith(OWNER_A, "batch-1");
    await expect(
      harness.inputs.resolveTaskLease(OWNER_A, "task-1", "transcribe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      harness.outputs.resolveBatchLease(OWNER_A, "batch-1"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      harness.manager.retryTask(OWNER_A, "task-1"),
    ).rejects.toMatchObject({
      localSubtitleCode: "invalid_ipc_request",
      field: "taskId",
      message: expect.stringContaining("new owner session"),
    });
  });

  it("releases leases and refuses retry after non-cancellation cleanup failure", async () => {
    const harness = await createHarness({
      executor: executor(async () => ({
        status: "failed",
        error: createLocalSubtitleError(
          "cleanup_failed",
          "private cleanup failure",
          { stage: "cleanup" },
        ),
      })),
    });
    const request = await harness.createRequest(harness.fileToken);
    const releaseInputLease = vi.spyOn(harness.inputs, "releaseTaskLease");
    const releaseOutputLease = vi.spyOn(harness.outputs, "releaseBatchLease");

    await harness.manager.enqueue(OWNER_A, request);
    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "failed",
          tasks: [
            {
              status: "failed",
              error: { code: "cleanup_failed" },
              artifactResults: [],
            },
          ],
        },
      ],
    });
    expect(releaseInputLease).toHaveBeenCalledWith(OWNER_A, "task-1");
    expect(releaseOutputLease).toHaveBeenCalledWith(OWNER_A, "batch-1");
    await expect(
      harness.inputs.resolveTaskLease(OWNER_A, "task-1", "transcribe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      harness.outputs.resolveBatchLease(OWNER_A, "batch-1"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      harness.manager.retryTask(OWNER_A, "task-1"),
    ).rejects.toMatchObject({
      localSubtitleCode: "invalid_ipc_request",
      field: "taskId",
      message: expect.stringContaining("new owner session"),
    });
  });

  it("preserves cleanup_failed when invalid artifacts require terminal fallback", async () => {
    const harness = await createHarness({
      executor: executor(async () => ({
        status: "failed",
        error: createLocalSubtitleError(
          "cleanup_failed",
          "private cleanup failure",
          { stage: "cleanup" },
        ),
        artifactResults: [committedArtifact()],
      })),
    });
    const releaseInputLease = vi.spyOn(harness.inputs, "releaseTaskLease");
    const releaseOutputLease = vi.spyOn(harness.outputs, "releaseBatchLease");

    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "failed",
          tasks: [
            {
              status: "failed",
              error: { code: "cleanup_failed" },
              artifactResults: [],
            },
          ],
        },
      ],
    });
    expect(releaseInputLease).toHaveBeenCalledWith(OWNER_A, "task-1");
    expect(releaseOutputLease).toHaveBeenCalledWith(OWNER_A, "batch-1");
    await expect(
      harness.manager.retryTask(OWNER_A, "task-1"),
    ).rejects.toMatchObject({
      localSubtitleCode: "invalid_ipc_request",
      field: "taskId",
      message: expect.stringContaining("new owner session"),
    });
  });

  it("preserves cancel_failed when invalid artifacts require terminal fallback", async () => {
    const harness = await createHarness({
      executor: executor(
        (context) =>
          new Promise((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => resolve({
                status: "failed",
                error: createLocalSubtitleError(
                  "cancel_failed",
                  "private cleanup failure",
                  { stage: "cancelling" },
                ),
                artifactResults: [committedArtifact()],
              }),
              { once: true },
            );
          }),
      ),
    });
    const releaseInputLease = vi.spyOn(harness.inputs, "releaseTaskLease");
    const releaseOutputLease = vi.spyOn(harness.outputs, "releaseBatchLease");

    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await waitFor(() => harness.executor.execute.mock.calls.length === 1);
    expect(harness.manager.cancelTask(OWNER_A, "task-1")).toEqual({
      cancelled: true,
    });
    await harness.manager.waitForIdle();

    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "failed",
          tasks: [
            {
              status: "failed",
              error: { code: "cancel_failed" },
              artifactResults: [],
            },
          ],
        },
      ],
    });
    expect(releaseInputLease).toHaveBeenCalledWith(OWNER_A, "task-1");
    expect(releaseOutputLease).toHaveBeenCalledWith(OWNER_A, "batch-1");
    await expect(
      harness.manager.retryTask(OWNER_A, "task-1"),
    ).rejects.toMatchObject({
      localSubtitleCode: "invalid_ipc_request",
      field: "taskId",
      message: expect.stringContaining("new owner session"),
    });
  });

  it("revalidates an exact managed model identity before execution", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    harness.modelResolver.resolveManagedModel.mockImplementation(
      async () => Object.freeze({ ...harness.managedModel }),
    );

    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(harness.modelResolver.resolveManagedModel).toHaveBeenCalledTimes(2);
    expect(harness.executor.execute).toHaveBeenCalledOnce();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [{ status: "completed", tasks: [{ status: "completed" }] }],
    });
  });

  it("fails before execution when the queued managed model identity changes", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.modelResolver.resolveManagedModel.mockResolvedValueOnce(
      Object.freeze({ ...harness.managedModel, sha256: "0".repeat(64) }),
    );

    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(harness.executor.execute).not.toHaveBeenCalled();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "failed",
          tasks: [
            {
              generation: 1,
              status: "failed",
              error: { code: "model_corrupt", stage: "loading_model" },
            },
          ],
        },
      ],
    });
    await expect(
      harness.inputs.resolveTaskLease(OWNER_A, "task-1", "transcribe"),
    ).resolves.toMatchObject({ displayName: "sample.wav" });
  });

  it("reports a dequeue model resolver rejection at loading_model", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.modelResolver.resolveManagedModel.mockRejectedValueOnce(
      Object.assign(new Error("managed model disappeared"), {
        localSubtitleCode: "model_missing" as const,
      }),
    );

    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(harness.executor.execute).not.toHaveBeenCalled();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "failed",
          tasks: [
            {
              status: "failed",
              error: { code: "model_missing", stage: "loading_model" },
            },
          ],
        },
      ],
    });
  });

  it("retains failed leases and retries the immutable snapshot at generation two", async () => {
    let attempt = 0;
    const harness = await createHarness({
      executor: executor(async (context) => {
        attempt += 1;
        if (attempt === 1) {
          return {
            status: "failed",
            error: createLocalSubtitleError(
              "transcription_failed",
              "private failure",
              { stage: "transcribing" },
            ),
          };
        }
        return successfulExecution(context);
      }),
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await harness.manager.waitForIdle();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [{ status: "failed", tasks: [{ status: "failed", generation: 1 }] }],
    });
    await expect(
      harness.inputs.resolveTaskLease(OWNER_A, "task-1", "transcribe"),
    ).resolves.toMatchObject({ displayName: "sample.wav" });

    const retried = await harness.manager.retryTask(OWNER_A, "task-1");
    expect(retried).toMatchObject({ status: "queued", generation: 2 });
    harness.flushScheduled();
    await harness.manager.waitForIdle();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        { status: "completed", tasks: [{ status: "completed", generation: 2 }] },
      ],
    });
    const contexts = harness.executor.execute.mock.calls.map(([context]) => context);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.config).toBe(contexts[0]?.config);
    expect(contexts.map((context) => context.generation)).toEqual([1, 2]);
  });

  it("revalidates the frozen model again before a retry generation", async () => {
    const harness = await createHarness({
      executor: executor(async () => ({
        status: "failed",
        error: createLocalSubtitleError(
          "transcription_failed",
          "private failure",
          { stage: "transcribing" },
        ),
      })),
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await harness.manager.waitForIdle();
    expect(harness.executor.execute).toHaveBeenCalledOnce();

    harness.modelResolver.resolveManagedModel.mockResolvedValueOnce(
      Object.freeze({
        ...harness.managedModel,
        absolutePath: `${harness.managedModel.absolutePath}.replaced`,
      }),
    );
    await harness.manager.retryTask(OWNER_A, "task-1");
    await harness.manager.waitForIdle();

    expect(harness.modelResolver.resolveManagedModel).toHaveBeenCalledTimes(3);
    expect(harness.executor.execute).toHaveBeenCalledOnce();
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      batches: [
        {
          status: "failed",
          tasks: [
            {
              generation: 2,
              status: "failed",
              model: {
                modelId: harness.managedModel.id,
                modelHash: harness.managedModel.sha256,
              },
              error: { code: "model_corrupt", stage: "loading_model" },
            },
          ],
        },
      ],
    });
  });

  it("removes only terminal tasks and revokes their artifacts", async () => {
    const revokeTask = vi.fn(() => 1);
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
      artifacts: { revokeTask },
    });
    const queued = await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    expect(() => harness.manager.removeTask(OWNER_A, "task-1")).toThrow(
      expect.objectContaining({ localSubtitleCode: "resource_busy" }),
    );
    harness.flushScheduled();
    await harness.manager.waitForIdle();

    expect(harness.manager.removeTask(OWNER_A, "task-1")).toEqual({
      removed: true,
    });
    expect(revokeTask).toHaveBeenCalledWith(OWNER_A, "task-1");
    expect(harness.manager.getSessionSnapshot(OWNER_A)).toMatchObject({
      revision: 9,
      batches: [],
    });
    expect(harness.manager.removeTask(OWNER_A, queued.tasks[0]!.taskId)).toEqual({
      removed: false,
    });
  });

  it("rolls capability commit back to drafts when session publication fails", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    vi.spyOn(harness.registry, "prepareBatchPublication").mockImplementationOnce(() => {
      throw new Error("publish failed");
    });

    await expect(
      harness.manager.enqueue(
        OWNER_A,
        await harness.createRequest(harness.fileToken),
      ),
    ).rejects.toThrow("publish failed");
    expect(harness.registry.getSnapshot(OWNER_A).revision).toBe(0);
    expect(harness.inputs.revokeDraft(OWNER_A, harness.fileToken)).toBe(true);
    expect(harness.executor.execute).not.toHaveBeenCalled();
  });

  it("rolls an unobserved staged batch back when lease post-validation fails", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    const events: unknown[] = [];
    harness.manager.onTaskEvent(OWNER_A, (event) => events.push(event));
    vi.spyOn(harness.inputs, "_assertCommitted").mockImplementationOnce(() => {
      throw new Error("post-commit lease validation failed");
    });

    await expect(
      harness.manager.enqueue(
        OWNER_A,
        await harness.createRequest(harness.fileToken),
      ),
    ).rejects.toThrow("post-commit lease validation failed");
    expect(events).toEqual([]);
    expect(harness.registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 0,
      batches: [],
    });
    expect(harness.inputs.revokeDraft(OWNER_A, harness.fileToken)).toBe(true);
    expect(harness.executor.execute).not.toHaveBeenCalled();
  });

  it("rejects unsupported valid schema combinations without consuming drafts", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    const request = await harness.createRequest(harness.fileToken);
    request.config.vadEnabled = true;

    await expect(harness.manager.enqueue(OWNER_A, request)).rejects.toMatchObject({
      localSubtitleCode: "invalid_ipc_request",
      field: "config",
    });
    expect(harness.inputs.revokeDraft(OWNER_A, harness.fileToken)).toBe(true);
  });

  it("rejects source output before resolving or reserving capabilities", async () => {
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
    });
    const inputResolve = vi.spyOn(harness.inputs, "resolveDraft");
    const outputResolve = vi.spyOn(harness.outputs, "resolveDraft");
    const outputPrepare = vi.spyOn(harness.outputs, "_prepare");
    const reserveBatch = vi.spyOn(harness.leases, "reserveBatch");

    await expect(
      harness.manager.enqueue(OWNER_A, enqueueRequest(harness.fileToken)),
    ).rejects.toMatchObject({
      localSubtitleCode: "invalid_ipc_request",
      field: "config",
    });

    expect(harness.modelResolver.resolveManagedModel).not.toHaveBeenCalled();
    expect(inputResolve).not.toHaveBeenCalled();
    expect(outputResolve).not.toHaveBeenCalled();
    expect(outputPrepare).not.toHaveBeenCalled();
    expect(reserveBatch).not.toHaveBeenCalled();
    expect(harness.executor.execute).not.toHaveBeenCalled();
    expect(harness.registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 0,
      batches: [],
    });
    await expect(
      harness.inputs.resolveDraft(
        OWNER_A,
        harness.fileToken,
        "transcribe",
      ),
    ).resolves.toMatchObject({ displayName: "sample.wav" });
  });

  it("rejects media runtime preflight without consuming capability drafts", async () => {
    const verifyRuntime = vi.fn(async () => {
      throw createLocalSubtitleError(
        "media_runtime_invalid",
        "The bundled media runtime is invalid.",
        { stage: "preflight" },
      );
    });
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
      verifyRuntime,
    });
    const request = await harness.createRequest(harness.fileToken);
    if (request.config.output.mode !== "custom") {
      throw new Error("Expected custom output.");
    }

    await expect(harness.manager.enqueue(OWNER_A, request)).rejects.toMatchObject({
      code: "media_runtime_invalid",
      stage: "preflight",
    });

    expect(verifyRuntime).toHaveBeenCalledOnce();
    expect(harness.inputs.revokeDraft(OWNER_A, harness.fileToken)).toBe(true);
    expect(
      harness.outputs.revokeDraft(
        OWNER_A,
        request.config.output.outputDirToken,
      ),
    ).toBe(true);
    expect(harness.executor.execute).not.toHaveBeenCalled();
    expect(harness.registry.getSnapshot(OWNER_A)).toMatchObject({
      revision: 0,
      batches: [],
    });
  });

  it("fences late executor completion on owner release", async () => {
    const completion = deferred<void>();
    const harness = await createHarness({
      executor: executor(async (context) => {
        await completion.promise;
        return successfulExecution(context);
      }),
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await waitFor(() => harness.executor.execute.mock.calls.length === 1);
    const before = harness.registry.getSnapshot(OWNER_A).revision;

    harness.manager.releaseOwner(OWNER_A);
    completion.resolve();
    await harness.manager.waitForOwnerIdle(OWNER_A);
    expect(harness.registry.getSnapshot(OWNER_A).revision).toBe(before);
    harness.registry.releaseOwner(OWNER_A);
    expect(() => harness.registry.getSnapshot(OWNER_A)).toThrow(
      expect.objectContaining({ code: "owner_released" }),
    );
  });

  it("caches shutdown before synchronous abort reentry", async () => {
    let reentrant: Promise<void> | undefined;
    let manager!: LocalSubtitleJobManager;
    const harness = await createHarness({
      executor: executor(
        (context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                reentrant = manager.shutdown("app_quit");
                reject(new Error("shutdown"));
              },
              { once: true },
            );
          }),
      ),
    });
    manager = harness.manager;
    await manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    harness.flushScheduled();
    await waitFor(() => harness.executor.execute.mock.calls.length === 1);

    const first = manager.shutdown("app_quit");
    expect(reentrant).toBe(first);
    expect(manager.shutdown("update")).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });

  it("continues shutdown cleanup after an artifact revocation throws", async () => {
    const executorSettled = deferred<void>();
    const aborted = deferred<void>();
    let taskOneFailed = false;
    const revokeTask = vi.fn((_owner: LocalSubtitleOwnerKey, taskId: string) => {
      if (taskId === "task-1" && !taskOneFailed) {
        taskOneFailed = true;
        throw new Error("artifact cleanup failed");
      }
      return 1;
    });
    const harness = await createHarness({
      executor: executor(
        (context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                void executorSettled.promise.then(() => reject(new Error("aborted")));
              },
              { once: true },
            );
          }),
      ),
      artifacts: { revokeTask },
      taskIds: ["task-1", "task-2"],
      batchIds: ["batch-1", "batch-2"],
    });
    const secondInput = await authorizeInput(harness.inputs, OWNER_A, "second.wav");
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(secondInput.fileToken),
    );
    harness.flushScheduled();
    await waitFor(() => harness.executor.execute.mock.calls.length === 1);

    let shutdownSettled = false;
    const first = harness.manager.shutdown("app_quit");
    const shutdown = first.finally(() => {
      shutdownSettled = true;
    });
    expect(harness.manager.shutdown("update")).toBe(first);
    await aborted.promise;
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(revokeTask.mock.calls.map(([, taskId]) => taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
    await expect(
      harness.inputs.resolveTaskLease(OWNER_A, "task-1", "transcribe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });
    await expect(
      harness.inputs.resolveTaskLease(OWNER_A, "task-2", "transcribe"),
    ).rejects.toMatchObject({ code: "invalid_ipc_request" });

    executorSettled.resolve();
    await expect(shutdown).rejects.toThrow("artifact cleanup failed");
    await expect(harness.manager.waitForIdle()).resolves.toBeUndefined();

    const retry = harness.manager.shutdown("app_quit");
    expect(retry).not.toBe(first);
    expect(harness.manager.shutdown("update")).toBe(retry);
    await expect(retry).resolves.toBeUndefined();
    expect(harness.manager.shutdown("app_quit")).toBe(retry);
    expect(revokeTask.mock.calls.map(([, taskId]) => taskId)).toEqual([
      "task-1",
      "task-2",
      "task-1",
    ]);
  });

  it("retries a lease renewal cancellation that failed during shutdown", async () => {
    let cancellationAttempts = 0;
    const harness = await createHarness({
      executor: executor(async (context) => successfulExecution(context)),
      manualLeaseRenewal: true,
      cancelLeaseRenewal: () => {
        cancellationAttempts += 1;
        if (cancellationAttempts === 1) {
          throw new Error("lease renewal cancellation failed");
        }
      },
    });
    await harness.manager.enqueue(
      OWNER_A,
      await harness.createRequest(harness.fileToken),
    );

    const first = harness.manager.shutdown("app_quit");
    await expect(first).rejects.toThrow("lease renewal cancellation failed");
    const retry = harness.manager.shutdown("app_quit");
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBeUndefined();
    expect(cancellationAttempts).toBe(2);
  });
});

interface HarnessOptions {
  readonly executor: ReturnType<typeof executor>;
  readonly verifyRuntime?: ReturnType<typeof vi.fn>;
  readonly taskIds?: readonly string[];
  readonly batchIds?: readonly string[];
  readonly artifacts?: { revokeTask(owner: LocalSubtitleOwnerKey, taskId: string): number };
  readonly leaseClock?: { now: number };
  readonly leaseTtlMs?: number;
  readonly leaseRenewalIntervalMs?: number;
  readonly manualLeaseRenewal?: boolean;
  readonly cancelLeaseRenewal?: () => void;
}

async function createHarness(options: HarnessOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-manager-"));
  tempRoots.push(root);
  const inputPath = path.join(root, "sample.wav");
  await writeFile(inputPath, "sample-audio");
  const leaseClock = options.leaseClock ?? { now: Date.now() };
  const inputs = new LocalSubtitleInputAuthorizationRegistry({
    tokenFactory: sequence("input"),
    now: () => leaseClock.now,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const outputs = new LocalSubtitleOutputDirectoryAuthorizationRegistry({
    tokenFactory: sequence("output"),
    now: () => leaseClock.now,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const file = await inputs.authorize(OWNER_A, inputPath);
  const registry = new LocalSubtitleSessionRegistry();
  const leases = new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs, {
    reservationIdFactory: sequence("reservation"),
    now: () => leaseClock.now,
  });
  const scheduled: Array<() => void> = [];
  let manuallyScheduled = true;
  const taskIds = [...(options.taskIds ?? ["task-1"])];
  const batchIds = [...(options.batchIds ?? ["batch-1"])];
  let now = Date.parse("2026-07-22T01:00:00.000Z");
  const managedModel = Object.freeze({
    storage: "managed" as const,
    id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
    absolutePath: path.join(root, "managed-model.bin"),
    byteSize: 1024,
    sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
  });
  const modelResolver = {
    resolveManagedModel: vi.fn(async () => managedModel),
  };
  const runtimeVerifier = {
    verifyRuntime: options.verifyRuntime ??
      vi.fn(async () => ({ runtimeGeneration: "a".repeat(64) })),
  };
  let requestOutputIndex = 0;
  const leaseRenewals: Array<{
    cancelled: boolean;
    readonly operation: () => void;
  }> = [];
  let leaseScheduleCount = 0;
  const manager = new LocalSubtitleJobManager({
    registry,
    inputs,
    outputs,
    leases,
    runtimeVerifier,
    modelResolver,
    executor: options.executor,
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    now: () => now++,
    batchIdFactory: () => batchIds.shift() ?? "batch-fallback",
    taskIdFactory: () => taskIds.shift() ?? "task-fallback",
    snapshotIdFactory: sequence("snapshot"),
    schedule: (operation) => {
      if (manuallyScheduled) scheduled.push(operation);
      else queueMicrotask(operation);
    },
    ...(options.leaseRenewalIntervalMs === undefined
      ? {}
      : { leaseRenewalIntervalMs: options.leaseRenewalIntervalMs }),
    ...(options.manualLeaseRenewal
      ? {
          scheduleLeaseRenewal: (operation: () => void) => {
            const renewal = { cancelled: false, operation };
            leaseRenewals.push(renewal);
            leaseScheduleCount += 1;
            return () => {
              renewal.cancelled = true;
              options.cancelLeaseRenewal?.();
            };
          },
        }
      : {}),
  });
  return {
    root,
    manager,
    registry,
    inputs,
    outputs,
    leases,
    runtimeVerifier,
    executor: options.executor,
    managedModel,
    modelResolver,
    fileToken: file.fileToken,
    createRequest: async (
      fileToken: string,
      owner: LocalSubtitleOwnerKey = OWNER_A,
    ) => {
      const outputRoot = path.join(root, `request-output-${++requestOutputIndex}`);
      await mkdir(outputRoot);
      const output = await outputs.authorize(owner, outputRoot);
      return customOutputRequest(fileToken, output.outputDirToken);
    },
    flushScheduled: () => {
      manuallyScheduled = false;
      while (scheduled.length > 0) scheduled.shift()!();
    },
    runLeaseRenewal: async () => {
      const renewal = leaseRenewals.find((candidate) => !candidate.cancelled);
      if (!renewal) throw new Error("No local subtitle lease renewal was scheduled.");
      renewal.cancelled = true;
      const before = leaseScheduleCount;
      renewal.operation();
      await waitFor(() => leaseScheduleCount > before);
    },
  };
}

function enqueueRequest(fileToken: string): EnqueueLocalSubtitleBatchRequest {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    files: [{ fileToken }],
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "cpu",
      language: "auto",
      taskMode: "transcribe",
      qualityPreset: "balanced",
      vadEnabled: false,
      advanced: {
        initialPrompt: "original",
        beamSize: 5,
        temperature: 0,
        vadMinSilenceMs: 500,
        maxCueDurationMs: 7_000,
        maxCueChars: 84,
        maxLineChars: 42,
      },
      output: {
        mode: "source",
        formats: ["SRT"],
        conflictPolicy: "index",
      },
      postAction: { mode: "export_only" },
    },
  };
}

function customOutputRequest(
  fileToken: string,
  outputDirToken: string,
): EnqueueLocalSubtitleBatchRequest {
  const request = enqueueRequest(fileToken);
  request.config.output = {
    mode: "custom",
    outputDirToken,
    formats: ["SRT"],
    conflictPolicy: "index",
  };
  return request;
}

async function successfulExecution(
  context: LocalSubtitleJobTaskExecutionContext,
) {
  advanceExecutionToExporting(context);
  return {
    status: "completed" as const,
    artifactResults: [committedArtifact()],
    durationMs: 1_000,
  };
}

function advanceExecutionToExporting(
  context: LocalSubtitleJobTaskExecutionContext,
): void {
  context.update({
    status: "preparing_media",
    progress: {
      stage: "preparing_media",
      stageProgress: 50,
      overallProgress: 5,
    },
    durationMs: 1_000,
  });
  context.update({
    status: "loading_model",
    progress: { stage: "loading_model", stageProgress: 100, overallProgress: 10 },
  });
  context.update({
    status: "transcribing",
    progress: { stage: "transcribing", stageProgress: 100, overallProgress: 80 },
  });
  context.update({
    status: "post_processing",
    progress: {
      stage: "post_processing",
      stageProgress: 100,
      overallProgress: 90,
    },
  });
  context.update({
    status: "exporting",
    progress: { stage: "exporting", stageProgress: 50, overallProgress: 95 },
  });
}

function committedArtifact(): LocalSubtitleArtifactResult {
  return {
    format: "SRT",
    status: "committed",
    artifact: {
      artifactRef: "artifact-1",
      displayName: "sample.srt",
      format: "SRT",
      expiresAt: Date.parse("2026-07-23T01:00:00.000Z"),
    },
  };
}

function executor(
  execute: LocalSubtitleJobTaskExecutor["execute"],
) {
  return { execute: vi.fn(execute) };
}

async function authorizeInput(
  inputs: LocalSubtitleInputAuthorizationRegistry,
  owner: LocalSubtitleOwnerKey,
  name: string,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusionkit-job-input-"));
  tempRoots.push(root);
  const filePath = path.join(root, name);
  await writeFile(filePath, name);
  return inputs.authorize(owner, filePath);
}

function sequence(prefix: string) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for local subtitle job state.");
}
