import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleTaskSummary,
} from "@/type/localSubtitle";
import {
  validateEnqueueLocalSubtitleBatchRequest,
  type LocalSubtitleAuthorizedMedia,
  type LocalSubtitleManagedResourceSummary,
  type LocalSubtitleRuntimeSummary,
} from "@/type/localSubtitleIpc";
import { DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES } from "@/store/tools/subtitle/localSubtitleTranscriberConfig";
import {
  canManuallyHandoffLocalSubtitleArtifact,
  createLocalSubtitleBackendPreviewKey,
  createLocalSubtitleBatchRequest,
  deriveLocalSubtitleTaskProgressDisplay,
  deriveLocalSubtitleDraftMediaProbeStatus,
  deriveLocalSubtitleStartIssue,
  findLocalSubtitleTask,
  flattenLocalSubtitleTasksInQueueOrder,
  formatLocalSubtitleBytes,
  formatLocalSubtitleDuration,
  getLocalSubtitleFileFormatLabel,
  getLocalSubtitleTrackCodecLabel,
  getLocalSubtitleTrackLanguageLabel,
  getInstalledLocalSubtitleResourceBytes,
  getLatestLocalSubtitleResourceJobs,
  getLocalSubtitleModelImportTarget,
  getReadyLocalSubtitleModels,
  isLocalSubtitleDevicePreferenceAvailable,
  isLocalSubtitleResourceJobActive,
  isLocalSubtitleTaskActive,
  mergeLocalSubtitleVisibleBatches,
  pruneLocalSubtitleDraftAudioSelections,
  reconcileLocalSubtitleDraftMediaProbes,
  resolveLocalSubtitleConflictPolicy,
  shouldRequestLocalSubtitleBackendPreview,
  supportedLocalSubtitleConflictPolicies,
} from "./localSubtitleTranscriberModel";

const file: LocalSubtitleAuthorizedMedia = {
  fileToken: "file-token",
  sourceKey: "source-key",
  displayName: "interview.mp4",
  byteSize: 1024,
  expiresAt: 10_000,
};

const model: LocalSubtitleManagedResourceSummary = {
  resourceId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
  resourceType: "model",
  displayName: "Whisper large-v3 Q5",
  status: "ready",
  byteSize: 4_000_000_000,
  isDefault: true,
  compatibleBackends: ["cpu", "metal"],
};

const runtime: LocalSubtitleRuntimeSummary = {
  schemaVersion: 1,
  platform: "darwin",
  arch: "arm64",
  runtimeGeneration: "a".repeat(64),
  runner: { status: "ready", version: "1.9.1" },
  mediaRuntime: { status: "ready", version: "7.1" },
  backends: [
    { backend: "cpu", status: "available" },
    { backend: "metal", status: "available" },
  ],
};

describe("local subtitle transcriber page model", () => {
  it("separates the file format from audio track language metadata", () => {
    expect(getLocalSubtitleFileFormatLabel("episode.mp4")).toBe("MP4");
    expect(getLocalSubtitleFileFormatLabel("voice.WaV")).toBe("WAV");
    expect(getLocalSubtitleFileFormatLabel("no-extension")).toBeUndefined();
    expect(getLocalSubtitleFileFormatLabel("unsafe.aac/other")).toBeUndefined();

    expect(getLocalSubtitleTrackLanguageLabel("und")).toBeUndefined();
    expect(getLocalSubtitleTrackLanguageLabel(" UND ")).toBeUndefined();
    expect(getLocalSubtitleTrackLanguageLabel("ja")).toBe("ja");

    expect(getLocalSubtitleTrackCodecLabel("aac", "MP4")).toBe("AAC");
    expect(getLocalSubtitleTrackCodecLabel("mp3", "MP3")).toBeUndefined();
  });

  it("offers only managed models that are already ready", () => {
    expect(
      getReadyLocalSubtitleModels([
        model,
        { ...model, resourceId: "installing", status: "installing" },
        { ...model, resourceId: "vad", resourceType: "vad" },
      ]).map((entry) => entry.resourceId),
    ).toEqual([LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id]);
  });

  it("matches imports to an exact uninstalled model size", () => {
    const fullModel = {
      ...model,
      resourceId: "large-v3",
      displayName: "Whisper large-v3 F16",
      status: "not_installed" as const,
      byteSize: 3_095_033_483,
      isDefault: false,
    };

    expect(getLocalSubtitleModelImportTarget(
      [model, fullModel],
      fullModel.byteSize,
    )).toBe(fullModel);
    expect(getLocalSubtitleModelImportTarget(
      [{ ...fullModel, status: "ready" }],
      fullModel.byteSize,
    )).toBeNull();
    expect(getLocalSubtitleModelImportTarget([fullModel], 123)).toBeNull();
  });

  it("offers only execution devices reported as available", () => {
    expect(isLocalSubtitleDevicePreferenceAvailable(runtime, "auto")).toBe(true);
    expect(isLocalSubtitleDevicePreferenceAvailable(runtime, "cpu")).toBe(true);
    expect(isLocalSubtitleDevicePreferenceAvailable(runtime, "metal")).toBe(true);
    expect(isLocalSubtitleDevicePreferenceAvailable(runtime, "cuda")).toBe(false);

    const unverifiedCuda = {
      ...runtime,
      platform: "win32" as const,
      arch: "x64" as const,
      backends: [
        { backend: "cpu" as const, status: "available" as const },
        {
          backend: "cuda" as const,
          status: "unverified" as const,
          errorCode: "backend_unverified" as const,
        },
      ],
    };
    expect(isLocalSubtitleDevicePreferenceAvailable(unverifiedCuda, "cuda")).toBe(false);
    expect(isLocalSubtitleDevicePreferenceAvailable(
      { ...runtime, mediaRuntime: { status: "missing", errorCode: "media_runtime_missing" } },
      "cpu",
    )).toBe(false);
    expect(isLocalSubtitleDevicePreferenceAvailable(null, "auto")).toBe(false);
  });

  it("derives resource actions and disk usage from the latest session job", () => {
    const older = createResourceJob({
      jobId: "job-1",
      status: "acquiring",
      updatedAt: "2026-08-03T00:00:01.000Z",
    });
    const latest = createResourceJob({
      jobId: "job-2",
      status: "failed",
      updatedAt: "2026-08-03T00:00:02.000Z",
    });
    const vadJob = createResourceJob({
      jobId: "job-3",
      resourceId: "vad-1",
      resourceType: "vad",
      status: "verifying",
      updatedAt: "2026-08-03T00:00:03.000Z",
    });

    const byResource = getLatestLocalSubtitleResourceJobs([
      latest,
      vadJob,
      older,
    ]);
    expect(byResource.get(model.resourceId)).toBe(latest);
    expect(byResource.get("vad-1")).toBe(vadJob);
    expect(isLocalSubtitleResourceJobActive(latest)).toBe(false);
    expect(isLocalSubtitleResourceJobActive(vadJob)).toBe(true);
    expect(getInstalledLocalSubtitleResourceBytes([
      model,
      { ...model, resourceId: "pending", status: "not_installed", byteSize: 50 },
      { ...model, resourceId: "ready", byteSize: 1_024 },
    ])).toBe(model.byteSize + 1_024);
    expect(formatLocalSubtitleBytes(1_024)).toBe("1.00 KB");
  });

  it("requires verified runtime, session, model, file, and custom output in order", () => {
    const ready = {
      environmentLoading: false,
      environmentError: false,
      runtime,
      runtimeSyncStatus: "ready" as const,
      readyModels: [model],
      selectedModelId: model.resourceId,
      vadEnabled: true,
      vadReady: true,
      backendPreviewStatus: "ready" as const,
      backendPreviewModelId: model.resourceId,
      backendPreviewDevicePreference: "auto" as const,
      devicePreference: "auto" as const,
      selectedFiles: [file],
      mediaProbeStatus: "ready" as const,
      outputMode: "source" as const,
      outputDirectory: null,
    };

    expect(deriveLocalSubtitleStartIssue(ready)).toBeNull();
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, runtime: null }),
    ).toBe("runtime_unavailable");
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, devicePreference: "cuda" }),
    ).toBe("backend_preview_unavailable");
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, selectedModelId: "missing" }),
    ).toBe("model_required");
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, vadReady: false }),
    ).toBe("vad_required");
    expect(
      deriveLocalSubtitleStartIssue({
        ...ready,
        backendPreviewStatus: "loading",
      }),
    ).toBe("backend_preview_loading");
    expect(
      deriveLocalSubtitleStartIssue({
        ...ready,
        backendPreviewStatus: "error",
      }),
    ).toBe("backend_preview_unavailable");
    expect(
      deriveLocalSubtitleStartIssue({
        ...ready,
        backendPreviewModelId: "another-model",
      }),
    ).toBe("backend_preview_loading");
    expect(
      deriveLocalSubtitleStartIssue({
        ...ready,
        backendPreviewDevicePreference: "cpu",
      }),
    ).toBe("backend_preview_loading");
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, selectedFiles: [] }),
    ).toBe("file_required");
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, outputMode: "custom" }),
    ).toBe("output_directory_required");
  });

  it("reuses a successful backend preview across session resynchronization", () => {
    const previewKey = createLocalSubtitleBackendPreviewKey({
      runtime,
      modelId: model.resourceId,
      devicePreference: "auto",
    });
    const base = {
      previewKey,
      cachedPreviewKey: previewKey,
      environmentLoading: false,
      environmentError: false,
      taskMediaOperationActive: false,
    };

    expect(shouldRequestLocalSubtitleBackendPreview({
      ...base,
      runtimeSyncStatus: "syncing",
    })).toBe(false);
    expect(shouldRequestLocalSubtitleBackendPreview({
      ...base,
      runtimeSyncStatus: "ready",
    })).toBe(false);
    expect(shouldRequestLocalSubtitleBackendPreview({
      ...base,
      cachedPreviewKey: null,
      runtimeSyncStatus: "ready",
    })).toBe(true);
    expect(shouldRequestLocalSubtitleBackendPreview({
      ...base,
      cachedPreviewKey: null,
      runtimeSyncStatus: "ready",
      taskMediaOperationActive: true,
    })).toBe(false);
    expect(createLocalSubtitleBackendPreviewKey({
      runtime: { ...runtime, runtimeGeneration: "b".repeat(64) },
      modelId: model.resourceId,
      devicePreference: "auto",
    })).not.toBe(previewKey);
    expect(createLocalSubtitleBackendPreviewKey({
      runtime,
      modelId: model.resourceId,
      devicePreference: "cpu",
    })).not.toBe(previewKey);
    expect(createLocalSubtitleBackendPreviewKey({
      runtime,
      modelId: model.resourceId,
      devicePreference: "cuda",
    })).toBeNull();
  });

  it("builds one production request entry for every authorized batch file", () => {
    const files = [
      file,
      { ...file, fileToken: "file-token-2", displayName: "panel.mkv" },
      { ...file, fileToken: "file-token-3", displayName: "briefing.wav" },
    ];
    const request = createLocalSubtitleBatchRequest({
      files,
      modelId: model.resourceId,
      preferences: DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
      outputDirectory: null,
      explicitAudioStreamIds: new Map([["file-token-2", "stream-track-2"]]),
      postAction: { mode: "export_only" },
    });

    expect(validateEnqueueLocalSubtitleBatchRequest(request).ok).toBe(true);
    expect(request).toMatchObject({
      files: [
        { fileToken: "file-token" },
        { fileToken: "file-token-2", audioStreamId: "stream-track-2" },
        { fileToken: "file-token-3" },
      ],
      config: {
        modelId: model.resourceId,
        devicePreference: "auto",
        taskMode: "transcribe",
        vadEnabled: true,
        output: {
          mode: "source",
          formats: ["SRT"],
          conflictPolicy: "index",
        },
        postAction: { mode: "export_only" },
      },
    });
  });

  it("keeps selected output formats and the prepared translation snapshot", () => {
    const request = createLocalSubtitleBatchRequest({
      files: [file],
      modelId: model.resourceId,
      preferences: {
        ...DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
        devicePreference: "cuda",
        vadEnabled: false,
        beamSize: 2,
        temperature: 0.35,
        outputFormats: ["SRT", "LRC"],
      },
      initialPrompt: "FusionKit product names",
      taskMode: "translate_to_english",
      outputDirectory: null,
      conflictPolicy: "overwrite",
      postAction: {
        mode: "enqueue_translation",
        preferredFormat: "LRC",
        translationSnapshotId: "translation-snapshot-1",
      },
    });

    expect(validateEnqueueLocalSubtitleBatchRequest(request).ok).toBe(true);
    expect(request.config).toMatchObject({
      devicePreference: "cuda",
      taskMode: "translate_to_english",
      vadEnabled: false,
      advanced: {
        initialPrompt: "FusionKit product names",
        beamSize: 2,
        temperature: 0.35,
      },
      output: {
        formats: ["SRT", "LRC"],
        conflictPolicy: "overwrite",
      },
      postAction: {
        mode: "enqueue_translation",
        preferredFormat: "LRC",
        translationSnapshotId: "translation-snapshot-1",
      },
    });
  });

  it("derives bounded draft probe readiness and media durations", () => {
    const readyProbe = {
      status: "ready" as const,
      summary: {
        fileToken: file.fileToken,
        displayName: file.displayName,
        durationMs: 3_661_000,
        audioTracks: [
          { streamId: "stream-1", ordinal: 1, isDefault: true },
        ],
        autoSelectedStreamId: "stream-1",
      },
    };
    expect(deriveLocalSubtitleDraftMediaProbeStatus([file], new Map())).toBe(
      "loading",
    );
    expect(deriveLocalSubtitleDraftMediaProbeStatus(
      [file],
      new Map([[file.fileToken, readyProbe]]),
    )).toBe("ready");
    expect(deriveLocalSubtitleDraftMediaProbeStatus(
      [file],
      new Map([[file.fileToken, {
        status: "error" as const,
        error: { message: "probe failed" },
      }]]),
    )).toBe("error");
    expect(formatLocalSubtitleDuration(3_661_000)).toBe("1:01:01");
  });

  it("preserves existing draft metadata and audio selections when files are appended", () => {
    const readyProbe = {
      status: "ready" as const,
      summary: {
        fileToken: file.fileToken,
        displayName: file.displayName,
        durationMs: 10_000,
        audioTracks: [
          { streamId: "stream-1", ordinal: 1, isDefault: true },
        ],
        autoSelectedStreamId: "stream-1",
      },
    };
    const appended = {
      ...file,
      fileToken: "file-token-2",
      sourceKey: "source-key-2",
      displayName: "second.wav",
    };
    const probes = new Map([[file.fileToken, readyProbe]]);
    const selections = new Map([[file.fileToken, "stream-1"]]);

    const nextProbes = reconcileLocalSubtitleDraftMediaProbes(
      [file, appended],
      probes,
    );
    expect(nextProbes.get(file.fileToken)).toBe(readyProbe);
    expect(nextProbes.get(appended.fileToken)).toEqual({ status: "loading" });
    expect(pruneLocalSubtitleDraftAudioSelections(
      [file, appended],
      selections,
    )).toBe(selections);

    expect(reconcileLocalSubtitleDraftMediaProbes(
      [appended],
      nextProbes,
    )).toEqual(new Map([
      [appended.fileToken, { status: "loading" }],
    ]));
    expect(pruneLocalSubtitleDraftAudioSelections(
      [appended],
      selections,
    )).toEqual(new Map());
  });

  it("does not let another active task block a ready draft batch", () => {
    expect(deriveLocalSubtitleStartIssue({
      environmentLoading: false,
      environmentError: false,
      runtime,
      runtimeSyncStatus: "ready",
      readyModels: [model],
      selectedModelId: model.resourceId,
      vadEnabled: false,
      vadReady: false,
      backendPreviewStatus: "ready",
      backendPreviewModelId: model.resourceId,
      backendPreviewDevicePreference: "auto",
      devicePreference: "auto",
      selectedFiles: [file],
      mediaProbeStatus: "ready",
      outputMode: "source",
      outputDirectory: null,
    })).toBeNull();
  });

  it("finds the active task and exposes only a committed SRT artifact", () => {
    const task = createTask();
    const batch: LocalSubtitleBatchSummary = {
      batchId: task.batchId,
      status: "completed",
      config: {
        modelId: model.resourceId,
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
      tasks: [task],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };

    expect(findLocalSubtitleTask([batch], task.batchId, task.taskId)).toBe(task);
    expect(isLocalSubtitleTaskActive(task)).toBe(false);
  });

  it("offers a fresh preferred-format handoff only when no translation task remains", () => {
    const task = {
      ...createTask(),
      postAction: {
        mode: "enqueue_translation" as const,
        preferredFormat: "SRT" as const,
        importStatus: "queued" as const,
        startStatus: "not_requested" as const,
        importReceiptId: "receipt-1",
        translationTaskId: "translation-task-1",
      },
    };

    expect(canManuallyHandoffLocalSubtitleArtifact(task, "SRT", false)).toBe(false);
    expect(canManuallyHandoffLocalSubtitleArtifact(task, "SRT", true)).toBe(true);
    expect(canManuallyHandoffLocalSubtitleArtifact(task, "LRC", true)).toBe(false);
    expect(canManuallyHandoffLocalSubtitleArtifact({
      postAction: {
        ...task.postAction,
        importStatus: "failed",
        startStatus: "not_requested",
        translationTaskId: undefined,
      },
    }, "SRT", false)).toBe(true);
  });

  it("keeps live batches and their tasks in FIFO admission order", () => {
    const firstTask = {
      ...createTask(),
      taskId: "z-random-id",
      batchId: "batch-first",
      displayName: "first.wav",
    };
    const secondTask = {
      ...createTask(),
      taskId: "a-random-id",
      batchId: "batch-first",
      displayName: "second.wav",
    };
    const firstBatch = createBatch("batch-first", [firstTask, secondTask]);
    const secondBatch = createBatch("batch-second", [{
      ...createTask(),
      taskId: "m-random-id",
      batchId: "batch-second",
      displayName: "third.wav",
    }]);

    const visible = mergeLocalSubtitleVisibleBatches(
      [firstBatch],
      [firstBatch, secondBatch],
    );

    expect(visible.map((batch) => batch.batchId)).toEqual([
      "batch-first",
      "batch-second",
    ]);
    expect(
      flattenLocalSubtitleTasksInQueueOrder(visible).map((task) => task.displayName),
    ).toEqual(["first.wav", "second.wav", "third.wav"]);
  });

  it("derives one transcription percentage from window progress", () => {
    expect(deriveLocalSubtitleTaskProgressDisplay({
      status: "transcribing",
      progress: {
        stage: "transcribing",
        stageProgress: 18,
        overallProgress: 39,
        completedWindows: 6,
        totalWindows: 32,
      },
    })).toEqual({
      percent: 19,
      completedWindows: 6,
      totalWindows: 32,
    });
  });

  it("falls back to stage progress when transcription window counts are invalid", () => {
    expect(deriveLocalSubtitleTaskProgressDisplay({
      status: "transcribing",
      progress: {
        stage: "transcribing",
        stageProgress: 42.6,
        overallProgress: 61,
        completedWindows: 7,
        totalWindows: 0,
      },
    })).toEqual({ percent: 43 });
  });

  it.each([
    "queued",
    "preparing_media",
    "loading_model",
    "post_processing",
    "exporting",
    "cancelling",
    "completed",
    "cancelled",
    "failed",
  ] as const)("hides task progress while status is %s", (status) => {
    const stage =
      status === "completed" || status === "cancelled" || status === "failed"
        ? "exporting"
        : status;
    expect(deriveLocalSubtitleTaskProgressDisplay({
      status,
      progress: {
        stage,
        stageProgress: 75,
        overallProgress: 80,
      },
    })).toBeNull();
  });

  it("hides a stale non-transcription progress payload", () => {
    expect(deriveLocalSubtitleTaskProgressDisplay({
      status: "transcribing",
      progress: {
        stage: "loading_model",
        stageProgress: 100,
        overallProgress: 30,
      },
    })).toBeNull();
  });

  it("falls back to automatic numbering when overwrite is unavailable", () => {
    expect(supportedLocalSubtitleConflictPolicies(runtime)).toEqual(["index"]);
    expect(resolveLocalSubtitleConflictPolicy(runtime, "overwrite")).toBe("index");

    const overwriteRuntime: LocalSubtitleRuntimeSummary = {
      ...runtime,
      supportedOutputConflictPolicies: ["index", "overwrite"],
    };
    expect(supportedLocalSubtitleConflictPolicies(overwriteRuntime)).toEqual([
      "index",
      "overwrite",
    ]);
    expect(resolveLocalSubtitleConflictPolicy(overwriteRuntime, "overwrite"))
      .toBe("overwrite");
  });
});

function createTask(): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key",
    generation: 1,
    displayName: "interview.mp4",
    status: "completed",
    progress: {
      stage: "exporting",
      stageProgress: 100,
      overallProgress: 100,
    },
    model: {
      engine: "whisper_cpp",
      engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
      engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
      modelManifestVersion: 1,
      modelId: model.resourceId,
      modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
    },
    resolvedBackend: "cpu",
    requestedFormats: ["SRT"],
    artifactResults: [
      {
        format: "SRT",
        status: "committed",
        artifact: {
          artifactRef: "artifact-ref",
          displayName: "interview.srt",
          format: "SRT",
          expiresAt: 10_000,
        },
      },
    ],
    completion: {
      outcome: "full",
      artifacts: [
        {
          format: "SRT",
          status: "committed",
          artifact: {
            artifactRef: "artifact-ref",
            displayName: "interview.srt",
            format: "SRT",
            expiresAt: 10_000,
          },
        },
      ],
      warnings: [],
    },
    postAction: {
      mode: "export_only",
      importStatus: "not_requested",
      startStatus: "not_requested",
    },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:01:00.000Z",
  };
}

function createBatch(
  batchId: string,
  tasks: readonly LocalSubtitleTaskSummary[],
): LocalSubtitleBatchSummary {
  const firstTask = tasks[0] ?? createTask();
  return {
    batchId,
    status: "completed",
    config: {
      modelId: model.resourceId,
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
    createdAt: firstTask.createdAt,
    updatedAt: firstTask.updatedAt,
  };
}

function createResourceJob(
  patch: Partial<LocalSubtitleResourceJobSummary>,
): LocalSubtitleResourceJobSummary {
  return {
    jobId: "job-1",
    resourceId: model.resourceId,
    resourceType: "model",
    status: "queued",
    progress: 0,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...patch,
  };
}
