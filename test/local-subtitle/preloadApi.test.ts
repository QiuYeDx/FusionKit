import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  type LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";
import {
  createLocalSubtitleRendererApi,
  type CreateLocalSubtitleRendererApiOptions,
} from "../../electron/preload/local-subtitle-api";

const OWNER_SESSION_ID = "owner_session_1234567890";
const NOW = "2026-07-21T12:00:00.000Z";
const ACCEPTED_FAILURE = {
  ok: false as const,
  error: createLocalSubtitleError(
    "configuration_required",
    "Configuration is required.",
  ),
};

describe("local subtitle fixed preload API", () => {
  it("freezes the complete fixed API without a generic transport or owner id", () => {
    const { api } = createHarness();

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual(
      [
        "authorizeInputFiles",
        "probeMedia",
        "revokeInputFile",
        "selectOutputDirectory",
        "revokeOutputDirectory",
        "probeRuntime",
        "previewBackend",
        "listManagedResources",
        "startResourceInstall",
        "cancelResourceJob",
        "importModel",
        "deleteManagedResource",
        "getSessionSnapshot",
        "enqueue",
        "retryTask",
        "cancelBatch",
        "cancelTask",
        "removeTask",
        "readArtifactText",
        "revealArtifact",
        "handoffArtifact",
        "listOverwriteRecoveries",
        "recoverOverwrite",
        "onTaskEvent",
        "onResourceEvent",
      ].sort(),
    );
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("send");
    expect(api).not.toHaveProperty("channel");
    expect(api).not.toHaveProperty("ownerSessionId");
  });

  it("maps every command to its exact channel and private owner envelope", async () => {
    const mediaOne = syntheticFileWithHostileMimeType();
    const mediaTwo = syntheticFileWithHostileMimeType();
    const model = syntheticFileWithHostileMimeType();
    const { api, invoke } = createHarness(
      new Map([
        [mediaOne, "/private/media-one.wav"],
        [mediaTwo, "/private/media-two.mp4"],
        [model, "/private/model.bin"],
      ]),
    );

    await callEveryCommand(api, mediaOne, mediaTwo, model);

    const expectedCalls: Array<[string, unknown]> = [
      [
        LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
        {
          files: [
            { filePath: "/private/media-one.wav" },
            { filePath: "/private/media-two.mp4" },
          ],
        },
      ],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia, { fileToken: "file-1" }],
      [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile, { fileToken: "file-1" }],
      [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory, {}],
      [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory, { outputDirToken: "output-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeRuntime, {}],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.previewBackend, {
        modelId: "model-1",
        devicePreference: "auto",
      }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources, {}],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall, { resourceId: "model-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob, { jobId: "job-1" }],
      [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel, { filePath: "/private/model.bin", mode: "copy" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource, { resourceId: "model-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot, {}],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue, validEnqueueRequest()],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTask, { taskId: "task-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelBatch, { batchId: "batch-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask, { taskId: "task-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask, { taskId: "task-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText, { artifactRef: "artifact-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact, { artifactRef: "artifact-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact, { artifactRef: "artifact-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listOverwriteRecoveries, { limit: 20 }],
      [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.recoverOverwrite, { recoveryId: "recovery-1" }],
    ];

    expect(invoke).toHaveBeenCalledTimes(expectedCalls.length);
    expect(
      invoke.mock.calls.map(([channel, envelope]) => [
        channel,
        (envelope as { payload: unknown }).payload,
      ]),
    ).toEqual(expectedCalls);

    for (const [, envelope] of invoke.mock.calls) {
      expect(envelope).toEqual({
        ownerSessionId: OWNER_SESSION_ID,
        payload: (envelope as { payload: unknown }).payload,
      });
      expect(Object.keys(envelope as object).sort()).toEqual([
        "ownerSessionId",
        "payload",
      ]);
    }
  });

  it("fails closed for empty, partial, duplicate, or synthetic file selections", async () => {
    const validFile = {} as File;
    const unavailableFile = {} as File;
    const duplicateFile = {} as File;
    const { api, invoke, getPathForFile } = createHarness(
      new Map([
        [validFile, "/private/media.wav"],
        [unavailableFile, ""],
        [duplicateFile, "/private/media.wav"],
      ]),
    );

    await expect(api.authorizeInputFiles([])).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(getPathForFile).not.toHaveBeenCalled();

    await expect(
      api.authorizeInputFiles([validFile, unavailableFile]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    await expect(
      api.authorizeInputFiles([validFile, duplicateFile]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(invoke).not.toHaveBeenCalled();

    const tooManyFiles = Array.from(
      { length: LOCAL_SUBTITLE_LIMITS.maxBatchFiles + 1 },
      () => ({} as File),
    );
    await expect(api.authorizeInputFiles(tooManyFiles)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(getPathForFile).toHaveBeenCalledTimes(4);
  });

  it("uses webUtils for model imports and never reads renderer MIME metadata", async () => {
    const model = syntheticFileWithHostileMimeType();
    const { api, invoke, getPathForFile } = createHarness(
      new Map([[model, "/private/model.bin"]]),
    );

    await api.importModel(model, { mode: "move" });

    expect(getPathForFile.mock.calls[0]?.[0]).toBe(model);
    expect(invoke).toHaveBeenCalledWith(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
      {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { filePath: "/private/model.bin", mode: "move" },
      },
    );
  });

  it("returns owner_released for a failed handshake without touching files or IPC", async () => {
    const mediaOne = {} as File;
    const mediaTwo = {} as File;
    const model = {} as File;
    const { api, invoke, on, off, getPathForFile } = createHarness(
      new Map([
        [mediaOne, "/private/media-one.wav"],
        [mediaTwo, "/private/media-two.wav"],
        [model, "/private/model.bin"],
      ]),
      {
        ok: false,
        error: createLocalSubtitleError(
          "invalid_ipc_request",
          "Registration failed.",
        ),
      },
    );

    const results = await callEveryCommand(api, mediaOne, mediaTwo, model);
    expect(results).toHaveLength(23);
    expect(
      results.every(
        (result) => !result.ok && result.error.code === "owner_released",
      ),
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(getPathForFile).not.toHaveBeenCalled();

    api.onTaskEvent(vi.fn())();
    api.onResourceEvent(vi.fn())();
    expect(on).not.toHaveBeenCalled();
    expect(off).not.toHaveBeenCalled();
  });

  it("rejects malformed requests before invoking main", async () => {
    const model = {} as File;
    const { api, invoke, getPathForFile } = createHarness(
      new Map([[model, "/private/model.bin"]]),
    );

    await expect(api.probeMedia("/private/media.wav")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    await expect(
      api.startResourceInstall({
        resourceId: "model-1",
        url: "https://example.invalid/model.bin",
      } as never),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    await expect(api.importModel(model, { mode: "link" } as never)).resolves.toMatchObject(
      {
        ok: false,
        error: { code: "invalid_ipc_request" },
      },
    );
    await expect(api.recoverOverwrite("r".repeat(81))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(getPathForFile).not.toHaveBeenCalled();
  });

  it("strictly validates bounded main results and stabilizes transport failures", async () => {
    const { api, invoke } = createHarness();

    invoke.mockResolvedValueOnce({
      ok: true,
      data: { path: "/private/runtime" },
    });
    await expect(api.probeRuntime()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_content", stage: "ipc" },
    });

    invoke.mockResolvedValueOnce({
      ...ACCEPTED_FAILURE,
      padding: "x".repeat(LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes),
    });
    await expect(api.probeRuntime()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_content", stage: "ipc" },
    });

    invoke.mockRejectedValueOnce(new Error("secret path: /private/runtime"));
    const rejected = await api.probeRuntime();
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(JSON.stringify(rejected)).not.toContain("/private/runtime");

    invoke.mockResolvedValueOnce(ACCEPTED_FAILURE);
    await expect(api.probeRuntime()).resolves.toEqual(ACCEPTED_FAILURE);
  });

  it("subscribes only to strict bounded event channels and unbinds exactly once", () => {
    const { api, on, off } = createHarness();
    const taskListener = vi.fn();
    const resourceListener = vi.fn();

    const unsubscribeTask = api.onTaskEvent(taskListener);
    const unsubscribeResource = api.onResourceEvent(resourceListener);

    expect(on.mock.calls.map(([channel]) => channel)).toEqual([
      LOCAL_SUBTITLE_EVENT_CHANNELS.taskEvent,
      LOCAL_SUBTITLE_EVENT_CHANNELS.resourceEvent,
    ]);

    const taskTransportListener = on.mock.calls[0][1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    const resourceTransportListener = on.mock.calls[1][1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    const taskEvent = {
      batchId: "batch-1",
      taskId: "task-1",
      generation: 1,
      revision: 1,
      event: { type: "task-removed", removedAt: NOW },
    };
    const resourceEvent = {
      revision: 2,
      event: {
        type: "resource-job-removed",
        jobId: "job-1",
        removedAt: NOW,
      },
    };

    taskTransportListener({}, taskEvent);
    resourceTransportListener({}, resourceEvent);
    taskTransportListener({}, { ...taskEvent, path: "/private/media.wav" });
    resourceTransportListener({}, {
      ...resourceEvent,
      padding: "x".repeat(LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes),
    });

    expect(taskListener).toHaveBeenCalledOnce();
    expect(taskListener).toHaveBeenCalledWith(taskEvent);
    expect(resourceListener).toHaveBeenCalledOnce();
    expect(resourceListener).toHaveBeenCalledWith(resourceEvent);

    unsubscribeTask();
    unsubscribeTask();
    unsubscribeResource();
    unsubscribeResource();

    expect(off).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenNthCalledWith(
      1,
      LOCAL_SUBTITLE_EVENT_CHANNELS.taskEvent,
      taskTransportListener,
    );
    expect(off).toHaveBeenNthCalledWith(
      2,
      LOCAL_SUBTITLE_EVENT_CHANNELS.resourceEvent,
      resourceTransportListener,
    );
  });
});

function createHarness(
  filePaths = new Map<File, string>(),
  ownerSessionRegistration: unknown = {
    ok: true,
    data: { ownerSessionId: OWNER_SESSION_ID },
  },
) {
  const invoke = vi.fn().mockResolvedValue(ACCEPTED_FAILURE);
  const on = vi.fn();
  const off = vi.fn();
  const getPathForFile = vi.fn((file: File) => filePaths.get(file) ?? "");
  const options: CreateLocalSubtitleRendererApiOptions = {
    ipcRenderer: { invoke, on, off } as unknown as CreateLocalSubtitleRendererApiOptions["ipcRenderer"],
    webUtils: { getPathForFile },
    ownerSessionRegistration,
  };

  return {
    api: createLocalSubtitleRendererApi(options),
    invoke,
    on,
    off,
    getPathForFile,
  };
}

async function callEveryCommand(
  api: LocalSubtitleRendererApi,
  mediaOne: File,
  mediaTwo: File,
  model: File,
) {
  return Promise.all([
    api.authorizeInputFiles([mediaOne, mediaTwo]),
    api.probeMedia("file-1"),
    api.revokeInputFile("file-1"),
    api.selectOutputDirectory(),
    api.revokeOutputDirectory("output-1"),
    api.probeRuntime(),
    api.previewBackend({ modelId: "model-1", devicePreference: "auto" }),
    api.listManagedResources(),
    api.startResourceInstall({ resourceId: "model-1" }),
    api.cancelResourceJob("job-1"),
    api.importModel(model, { mode: "copy" }),
    api.deleteManagedResource("model-1"),
    api.getSessionSnapshot(),
    api.enqueue(validEnqueueRequest()),
    api.retryTask("task-1"),
    api.cancelBatch("batch-1"),
    api.cancelTask("task-1"),
    api.removeTask("task-1"),
    api.readArtifactText("artifact-1"),
    api.revealArtifact("artifact-1"),
    api.handoffArtifact("artifact-1"),
    api.listOverwriteRecoveries({ limit: 20 }),
    api.recoverOverwrite("recovery-1"),
  ]);
}

function syntheticFileWithHostileMimeType(): File {
  return Object.defineProperty({}, "type", {
    get() {
      throw new Error("File.type must not be trusted by the preload bridge.");
    },
  }) as File;
}

function validEnqueueRequest() {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    files: [{ fileToken: "file-1", audioStreamId: "stream-1" }],
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "auto" as const,
      language: "auto",
      taskMode: "transcribe" as const,
      qualityPreset: "subtitle_quality" as const,
      vadEnabled: true,
      advanced: {
        initialPrompt: "optional prompt",
        beamSize: 5,
        temperature: 0,
        vadMinSilenceMs: 500,
        maxCueDurationMs: 10_000,
        maxCueChars: 120,
        maxLineChars: 42,
      },
      output: {
        mode: "source" as const,
        formats: ["SRT", "LRC"] as Array<"SRT" | "LRC">,
        conflictPolicy: "index" as const,
      },
      postAction: { mode: "export_only" as const },
    },
  };
}
