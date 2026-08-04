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
  createLocalSubtitleBatchRequest,
  deriveLocalSubtitleStartIssue,
  findLocalSubtitleTask,
  formatLocalSubtitleBytes,
  getCommittedSrtArtifact,
  getInstalledLocalSubtitleResourceBytes,
  getLatestLocalSubtitleResourceJobs,
  getReadyLocalSubtitleModels,
  isLocalSubtitleResourceJobActive,
  isLocalSubtitleTaskActive,
} from "./localSubtitleTranscriberModel";

const file: LocalSubtitleAuthorizedMedia = {
  fileToken: "file-token",
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
  it("offers only managed models that are already ready", () => {
    expect(
      getReadyLocalSubtitleModels([
        model,
        { ...model, resourceId: "installing", status: "installing" },
        { ...model, resourceId: "vad", resourceType: "vad" },
      ]).map((entry) => entry.resourceId),
    ).toEqual([LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id]);
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
      backendPreviewStatus: "ready" as const,
      backendPreviewModelId: model.resourceId,
      selectedFiles: [file],
      outputMode: "source" as const,
      outputDirectory: null,
    };

    expect(deriveLocalSubtitleStartIssue(ready)).toBeNull();
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, runtime: null }),
    ).toBe("runtime_unavailable");
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, selectedModelId: "missing" }),
    ).toBe("model_required");
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
      deriveLocalSubtitleStartIssue({ ...ready, selectedFiles: [] }),
    ).toBe("file_required");
    expect(
      deriveLocalSubtitleStartIssue({ ...ready, outputMode: "custom" }),
    ).toBe("output_directory_required");
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
    });

    expect(validateEnqueueLocalSubtitleBatchRequest(request).ok).toBe(true);
    expect(request).toMatchObject({
      files: files.map((entry) => ({ fileToken: entry.fileToken })),
      config: {
        modelId: model.resourceId,
        devicePreference: "auto",
        taskMode: "transcribe",
        vadEnabled: false,
        output: {
          mode: "source",
          formats: ["SRT"],
          conflictPolicy: "index",
        },
        postAction: { mode: "export_only" },
      },
    });
  });

  it("does not let another active task block a ready draft batch", () => {
    expect(deriveLocalSubtitleStartIssue({
      environmentLoading: false,
      environmentError: false,
      runtime,
      runtimeSyncStatus: "ready",
      readyModels: [model],
      selectedModelId: model.resourceId,
      backendPreviewStatus: "ready",
      backendPreviewModelId: model.resourceId,
      selectedFiles: [file],
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
        qualityPreset: "subtitle_quality",
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
    expect(getCommittedSrtArtifact(task)?.artifactRef).toBe("artifact-ref");
  });
});

function createTask(): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
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
