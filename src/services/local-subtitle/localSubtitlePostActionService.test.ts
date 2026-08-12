import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import type { LocalSubtitleRuntimeState } from "./localSubtitleRuntimeService";
import { SubtitleSliceType } from "@/type/subtitle";
import {
  LocalSubtitlePostActionService,
  createLocalSubtitlePostActionFromReceipt,
} from "./localSubtitlePostActionService";

describe("LocalSubtitlePostActionService", () => {
  it("maps exact import receipt partitions without starting unrelated tasks", () => {
    expect(createLocalSubtitlePostActionFromReceipt(
      "enqueue_and_start_translation",
      "SRT",
      {
        receiptId: "receipt-1",
        snapshotId: "snapshot-1",
        addedTaskIds: ["translation-task-1"],
        startedTaskIds: [],
        waitingTaskIds: [],
        notStartedTaskIds: ["translation-task-1"],
        startFailures: [{
          taskId: "translation-task-1",
          reason: "estimate_failed",
        }],
        skipped: [],
      },
    )).toEqual({
      mode: "enqueue_and_start_translation",
      preferredFormat: "SRT",
      importStatus: "queued",
      startStatus: "failed",
      importReceiptId: "receipt-1",
      translationTaskId: "translation-task-1",
      startFailureReason: "estimate_failed",
    });
  });

  it("hands off a completed preferred artifact and releases its batch snapshot", async () => {
    const harness = createHarness();
    const service = new LocalSubtitlePostActionService(harness.options);
    const queued = createBatch("enqueue_and_start_translation", "SRT", false);
    service.registerAutomaticBatch(queued, "snapshot-1");

    harness.publish(createBatch(
      "enqueue_and_start_translation",
      "SRT",
      true,
    ));

    await vi.waitFor(() => {
      expect(harness.localApi.handoffArtifact).toHaveBeenCalledWith("artifact-srt");
      expect(harness.imports.importArtifact).toHaveBeenCalledWith({
        translationImportToken: "import-token-1",
        snapshotId: "snapshot-1",
      });
      expect(harness.localApi.completePostAction).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          postAction: expect.objectContaining({
            importStatus: "queued",
            startStatus: "started",
            translationTaskId: "translation-task-1",
          }),
        }),
      );
      expect(harness.imports.releaseBatch).toHaveBeenCalledWith("snapshot-1");
    });
    service.dispose();
  });

  it("does not substitute another committed format when the preferred one failed", async () => {
    const harness = createHarness();
    const service = new LocalSubtitlePostActionService(harness.options);
    const batch = createBatch("enqueue_translation", "LRC", true);
    service.registerAutomaticBatch(batch, "snapshot-2");

    await vi.waitFor(() => {
      expect(harness.localApi.completePostAction).toHaveBeenCalledWith(
        expect.objectContaining({
          postAction: expect.objectContaining({
            preferredFormat: "LRC",
            importStatus: "skipped",
            importErrorCode: "output_write_failed",
          }),
        }),
      );
      expect(harness.localApi.handoffArtifact).not.toHaveBeenCalled();
      expect(harness.imports.releaseBatch).toHaveBeenCalledWith("snapshot-2");
    });
    service.dispose();
  });

  it("does not automatically hand off artifacts committed during cancellation", async () => {
    const harness = createHarness();
    const service = new LocalSubtitlePostActionService(harness.options);
    const batch = createBatch("enqueue_translation", "SRT", true);
    const task = batch.tasks[0]!;
    const artifactResults = [
      ...task.artifactResults,
      {
        format: "LRC" as const,
        status: "failed" as const,
        errorCode: "cancelled_after_partial_commit" as const,
      },
    ];
    service.registerAutomaticBatch({
      ...batch,
      tasks: [{
        ...task,
        artifactResults,
        completion: {
          outcome: "partial",
          artifacts: artifactResults,
          warnings: ["cancelled_after_partial_commit"],
        },
      }],
    }, "snapshot-cancelled");

    await vi.waitFor(() => {
      expect(harness.localApi.completePostAction).toHaveBeenCalledWith(
        expect.objectContaining({
          postAction: expect.objectContaining({
            importStatus: "skipped",
            importErrorCode: "cancelled_after_partial_commit",
          }),
        }),
      );
      expect(harness.imports.releaseBatch).toHaveBeenCalledWith(
        "snapshot-cancelled",
      );
    });
    expect(harness.localApi.handoffArtifact).not.toHaveBeenCalled();
    expect(harness.imports.importArtifact).not.toHaveBeenCalled();
    service.dispose();
  });

  it("retains the snapshot while a failed transcription can still be retried", async () => {
    const harness = createHarness();
    const service = new LocalSubtitlePostActionService(harness.options);
    service.registerAutomaticBatch(
      createBatch("enqueue_translation", "SRT", false),
      "snapshot-retry",
    );
    const failed = createBatch("enqueue_translation", "SRT", false);
    harness.publish({
      ...failed,
      status: "failed",
      tasks: [{
        ...failed.tasks[0]!,
        status: "failed",
        error: {
          code: "transcription_failed",
          message: "Transcription failed.",
          stage: "transcribing",
          retryable: true,
        },
      }],
    });
    expect(harness.imports.releaseBatch).not.toHaveBeenCalled();

    const completed = createBatch("enqueue_translation", "SRT", true);
    harness.publish({
      ...completed,
      tasks: [{ ...completed.tasks[0]!, generation: 2 }],
    });

    await vi.waitFor(() => {
      expect(harness.localApi.completePostAction).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-1", generation: 2 }),
      );
      expect(harness.imports.releaseBatch).toHaveBeenCalledWith(
        "snapshot-retry",
      );
    });
    service.dispose();
  });

  it("reconciles a completion that arrived before automatic batch registration", async () => {
    const harness = createHarness();
    const service = new LocalSubtitlePostActionService(harness.options);
    harness.publish(createBatch("enqueue_translation", "SRT", true));

    service.registerAutomaticBatch(
      createBatch("enqueue_translation", "SRT", false),
      "snapshot-late-registration",
    );

    await vi.waitFor(() => {
      expect(harness.localApi.handoffArtifact).toHaveBeenCalledWith(
        "artifact-srt",
      );
      expect(harness.imports.releaseBatch).toHaveBeenCalledWith(
        "snapshot-late-registration",
      );
    });
    service.dispose();
  });

  it("prepares a fresh snapshot for a manual handoff", async () => {
    const harness = createHarness();
    const service = new LocalSubtitlePostActionService(harness.options);

    const result = await service.importManually({
      artifact: {
        artifactRef: "manual-artifact",
        displayName: "manual.srt",
        format: "SRT",
        expiresAt: Date.now() + 60_000,
      },
      mode: "enqueue_translation",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "enqueue_translation",
      receipt: { addedTaskIds: ["translation-task-1"] },
    });
    expect(harness.imports.prepareBatch).toHaveBeenCalledWith(
      "enqueue_translation",
    );
    await vi.waitFor(() => {
      expect(harness.imports.releaseBatch).toHaveBeenCalledWith("snapshot-new");
    });
    service.dispose();
  });

  it("reports whether a recorded translation task still exists", () => {
    const harness = createHarness();
    const service = new LocalSubtitlePostActionService(harness.options);

    expect(service.hasTranslationTask("translation-task-1")).toBe(true);
    expect(service.hasTranslationTask("translation-task-missing")).toBe(false);
    expect(service.hasTranslationTask("invalid task id")).toBe(false);
    service.dispose();
  });
});

function createHarness() {
  let state = runtimeState([]);
  let listener: () => void = () => undefined;
  const runtime = {
    getState: () => state,
    subscribe: vi.fn((next: () => void) => {
      listener = next;
      return () => undefined;
    }),
  };
  const localApi = {
    handoffArtifact: vi.fn(async () => ({
      ok: true as const,
      data: {
        translationImportToken: "import-token-1",
        expiresAt: Date.now() + 60_000,
      },
    })),
    completePostAction: vi.fn(async (request) => ({
      ok: true as const,
      data: {
        ...createBatch(request.postAction.mode, request.postAction.preferredFormat!, true)
          .tasks[0]!,
        postAction: request.postAction,
      },
    })),
  };
  const receipt = {
    receiptId: "receipt-1",
    snapshotId: "snapshot-1",
    addedTaskIds: ["translation-task-1"],
    startedTaskIds: ["translation-task-1"],
    waitingTaskIds: [],
    notStartedTaskIds: [],
    startFailures: [],
    skipped: [],
  } as const;
  const imports = {
    prepareBatch: vi.fn(async () => ({
      ok: true as const,
      snapshot: {
        snapshotId: "snapshot-new",
        createdAt: Date.now(),
        handoffMode: "enqueue_translation" as const,
        executionBinding: { status: "ready" as const, taskProfileId: "p1", taskProfileLabel: "P1" },
        sourceLang: "JA" as const,
        targetLang: "ZH" as const,
        translationOutputMode: "bilingual" as const,
        sliceType: SubtitleSliceType.NORMAL,
        outputMode: "source" as const,
        conflictPolicy: "index" as const,
        concurrentSlices: true,
      },
      canAutoStart: true,
      warnings: [],
    })),
    importArtifact: vi.fn(async () => receipt),
    releaseBatch: vi.fn(async () => undefined),
    hasTask: vi.fn((taskId: string) => taskId === "translation-task-1"),
  };
  return {
    localApi,
    imports,
    options: {
      runtime,
      getLocalApi: () => localApi,
      imports,
      retryDelaysMs: [0],
    },
    publish(batch: LocalSubtitleBatchSummary) {
      state = runtimeState([batch]);
      listener();
    },
  };
}

function runtimeState(
  batches: readonly LocalSubtitleBatchSummary[],
): LocalSubtitleRuntimeState {
  return {
    syncStatus: "ready",
    revision: 1,
    batches,
    resourceJobs: [],
    error: null,
  };
}

function createBatch(
  mode: "enqueue_translation" | "enqueue_and_start_translation",
  preferredFormat: "SRT" | "LRC",
  completed: boolean,
): LocalSubtitleBatchSummary {
  const task = createTask(mode, preferredFormat, completed);
  return {
    batchId: "batch-1",
    status: completed ? "completed" : "queued",
    config: {
      modelId: task.model.modelId,
      devicePreference: "cpu",
      resolvedBackend: "cpu",
      language: "auto",
      taskMode: "transcribe",
      vadEnabled: false,
      outputFormats: ["SRT", "LRC"],
      outputMode: "source",
      conflictPolicy: "index",
      postActionMode: mode,
      preferredHandoffFormat: preferredFormat,
    },
    tasks: [task],
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:01:00.000Z",
  };
}

function createTask(
  mode: "enqueue_translation" | "enqueue_and_start_translation",
  preferredFormat: "SRT" | "LRC",
  completed: boolean,
): LocalSubtitleTaskSummary {
  const artifactResults = completed
    ? [
        {
          format: "SRT" as const,
          status: "committed" as const,
          artifact: {
            artifactRef: "artifact-srt",
            displayName: "sample.srt",
            format: "SRT" as const,
            expiresAt: Date.now() + 60_000,
          },
        },
        ...(preferredFormat === "LRC"
          ? [{
              format: "LRC" as const,
              status: "failed" as const,
              errorCode: "output_write_failed" as const,
            }]
          : []),
      ]
    : [];
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key",
    generation: 1,
    displayName: "sample.wav",
    status: completed ? "completed" : "queued",
    progress: {
      stage: completed ? "exporting" : "queued",
      stageProgress: completed ? 100 : 0,
      overallProgress: completed ? 100 : 0,
    },
    model: {
      engine: "whisper_cpp",
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: 1,
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
    },
    resolvedBackend: "cpu",
    requestedFormats: ["SRT", "LRC"],
    artifactResults,
    ...(completed
      ? {
          completion: {
            outcome: preferredFormat === "LRC" ? "partial" as const : "full" as const,
            artifacts: artifactResults,
            warnings: [],
          },
        }
      : {}),
    postAction: {
      mode,
      preferredFormat,
      importStatus: "pending",
      startStatus: "not_requested",
    },
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:01:00.000Z",
  };
}
