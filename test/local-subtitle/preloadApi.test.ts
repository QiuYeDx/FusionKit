import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
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
  it("freezes the complete versioned API without a generic transport or owner id", () => {
    const { api } = createHarness();

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual(
      [
        "bridgeVersion",
        "captureInputFile",
        "authorizeCapturedInputFiles",
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
        "retryTaskOnCpu",
        "cancelBatch",
        "cancelTask",
        "removeTask",
        "completePostAction",
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
    expect(api.bridgeVersion).toBe(LOCAL_SUBTITLE_IPC_BRIDGE_VERSION);
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
      [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel, {
        filePath: "/private/model.bin",
        mode: "copy",
        modelId: "large-v3-q5_0",
      }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource, { resourceId: "model-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot, {}],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue, validEnqueueRequest()],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTask, { taskId: "task-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTaskOnCpu, {
        taskId: "task-1",
        generation: 1,
      }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelBatch, { batchId: "batch-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask, { taskId: "task-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask, { taskId: "task-1" }],
      [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.completePostAction, {
        taskId: "task-1",
        generation: 1,
        postAction: {
          mode: "enqueue_translation",
          preferredFormat: "SRT",
          importStatus: "queued",
          startStatus: "not_requested",
          importReceiptId: "receipt-1",
          translationTaskId: "translation-task-1",
        },
      }],
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

  it("captures native paths synchronously and exposes only an opaque one-time reference", async () => {
    const file = {} as File;
    const privatePath = "/private/dragged-media.wav";
    const { api, invoke, getPathForFile } = createHarness(
      new Map([[file, privatePath]]),
    );

    const captured = api.captureInputFile(file);

    expect(captured).not.toBeInstanceOf(Promise);
    expect(getPathForFile).toHaveBeenCalledWith(file);
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(captured)).not.toContain(privatePath);
    if (!captured.ok) throw new Error("Expected synchronous input capture.");
    expect(captured.data).toMatchObject({ fileCount: 1 });

    await api.authorizeCapturedInputFiles(captured.data.captureRef);
    expect(invoke).toHaveBeenCalledOnce();
    await expect(
      api.authorizeCapturedInputFiles(captured.data.captureRef),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_expired", field: "captureRef" },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("captures an Explorer batch one original File at a time", () => {
    const mediaOne = {} as File;
    const mediaTwo = {} as File;
    const { api, getPathForFile } = createHarness(
      new Map([
        [mediaOne, String.raw`H:\private\native-drop-one.wav`],
        [mediaTwo, String.raw`H:\private\native-drop-two.wav`],
      ]),
    );

    const firstCapture = api.captureInputFile(mediaOne);
    if (!firstCapture.ok) throw new Error("Expected the first File capture.");
    const captured = api.captureInputFile(
      mediaTwo,
      firstCapture.data.captureRef,
    );

    expect(captured).toMatchObject({ ok: true, data: { fileCount: 2 } });
    expect(getPathForFile.mock.calls.map(([file]) => file)).toEqual([
      mediaOne,
      mediaTwo,
    ]);
    expect(
      api.captureInputFile([mediaOne, mediaTwo] as unknown as File),
    ).toMatchObject({
      ok: false,
      error: { code: "authorization_expired", field: "files.0" },
    });
  });

  it("expires preload-private captures without ever forwarding their paths", async () => {
    const file = {} as File;
    let currentTime = 1_000;
    const { api, invoke } = createHarness(
      new Map([[file, "/private/expiring.wav"]]),
      undefined,
      { now: () => currentTime },
    );
    const captured = api.captureInputFile(file);
    if (!captured.ok) throw new Error("Expected synchronous input capture.");

    currentTime += 30_001;
    await expect(
      api.authorizeCapturedInputFiles(captured.data.captureRef),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_expired", field: "captureRef" },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fails closed for malformed, partial, duplicate, or synthetic captures", async () => {
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

    expect(api.captureInputFile(validFile, "invalid-ref")).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(getPathForFile).not.toHaveBeenCalled();

    const partial = api.captureInputFile(validFile);
    if (!partial.ok) throw new Error("Expected a partial capture.");
    expect(
      api.captureInputFile(unavailableFile, partial.data.captureRef),
    ).toMatchObject({
      ok: false,
      error: {
        code: "authorization_expired",
        stage: "preflight",
        field: "files.1",
      },
    });
    await expect(
      api.authorizeCapturedInputFiles(partial.data.captureRef),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_expired", field: "captureRef" },
    });

    const duplicate = api.captureInputFile(validFile);
    if (!duplicate.ok) throw new Error("Expected a duplicate test capture.");
    expect(
      api.captureInputFile(duplicateFile, duplicate.data.captureRef),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(getPathForFile).toHaveBeenCalledTimes(4);
  });

  it("bounds incremental File captures to the batch limit", () => {
    const tooManyFiles = Array.from(
      { length: LOCAL_SUBTITLE_LIMITS.maxBatchFiles + 1 },
      () => ({} as File),
    );
    const { api, getPathForFile } = createHarness(
      new Map(
        tooManyFiles.map((file, index) => [
          file,
          `/private/media-${index}.wav`,
        ]),
      ),
    );

    let capture = api.captureInputFile(tooManyFiles[0]!);
    for (let index = 1; index < LOCAL_SUBTITLE_LIMITS.maxBatchFiles; index += 1) {
      if (!capture.ok) throw new Error("Expected a bounded batch capture.");
      capture = api.captureInputFile(
        tooManyFiles[index]!,
        capture.data.captureRef,
      );
    }
    if (!capture.ok) throw new Error("Expected a full batch capture.");

    expect(
      api.captureInputFile(
        tooManyFiles[LOCAL_SUBTITLE_LIMITS.maxBatchFiles]!,
        capture.data.captureRef,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
    expect(getPathForFile).toHaveBeenCalledTimes(
      LOCAL_SUBTITLE_LIMITS.maxBatchFiles,
    );
  });

  it("uses webUtils for model imports and never reads renderer MIME metadata", async () => {
    const model = syntheticFileWithHostileMimeType();
    const { api, invoke, getPathForFile } = createHarness(
      new Map([[model, "/private/model.bin"]]),
    );

    await api.importModel(model, {
      mode: "move",
      modelId: "large-v3",
    });

    expect(getPathForFile.mock.calls[0]?.[0]).toBe(model);
    expect(invoke).toHaveBeenCalledWith(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel,
      {
        ownerSessionId: OWNER_SESSION_ID,
        payload: {
          filePath: "/private/model.bin",
          mode: "move",
          modelId: "large-v3",
        },
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
    expect(results).toHaveLength(25);
    expect(
      results.every(
        (result) => !result.ok && result.error.code === "owner_released",
      ),
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(getPathForFile).not.toHaveBeenCalled();
    expect(api.bridgeVersion).toBe(0);

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
      error: { code: "runtime_protocol_mismatch", stage: "ipc" },
    });
    expect(JSON.stringify(rejected)).not.toContain("/private/runtime");

    invoke.mockResolvedValueOnce(ACCEPTED_FAILURE);
    await expect(api.probeRuntime()).resolves.toEqual(ACCEPTED_FAILURE);
  });

  it("forwards Unicode paths and enqueue-and-start translation through the versioned bridge", async () => {
    const file = {} as File;
    const filePath = String.raw`H:\我のNas\media\rrr\白嫖DLsite(asmr.one)\【RJ01567709】【已自翻】【藤村莉央&恋鈴桃歌】\wav\5.素っ気ない鳩羽のおまんこ借りて身勝手寝バックえっち♡.wav`;
    const { api, invoke } = createHarness(new Map([[file, filePath]]));

    const captured = api.captureInputFile(file);
    if (!captured.ok) throw new Error("Expected synchronous input capture.");
    await api.authorizeCapturedInputFiles(captured.data.captureRef);
    await api.enqueue({
      ...validEnqueueRequest(),
      config: {
        ...validEnqueueRequest().config,
        output: {
          ...validEnqueueRequest().config.output,
          conflictPolicy: "overwrite",
        },
        postAction: {
          mode: "enqueue_and_start_translation",
          preferredFormat: "LRC",
          translationSnapshotId: "translation-snapshot-one",
        },
      },
    });

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles,
      {
        ownerSessionId: OWNER_SESSION_ID,
        payload: { files: [{ filePath }] },
      },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue,
      expect.objectContaining({
        ownerSessionId: OWNER_SESSION_ID,
        payload: expect.objectContaining({
          config: expect.objectContaining({
            output: expect.objectContaining({ conflictPolicy: "overwrite" }),
            postAction: {
              mode: "enqueue_and_start_translation",
              preferredFormat: "LRC",
              translationSnapshotId: "translation-snapshot-one",
            },
          }),
        }),
      }),
    );
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
    data: {
      ownerSessionId: OWNER_SESSION_ID,
      bridgeVersion: LOCAL_SUBTITLE_IPC_BRIDGE_VERSION,
    },
  },
  overrides: Pick<
    CreateLocalSubtitleRendererApiOptions,
    "now" | "createInputCaptureNonce"
  > = {},
) {
  const invoke = vi.fn().mockResolvedValue(ACCEPTED_FAILURE);
  const on = vi.fn();
  const off = vi.fn();
  const getPathForFile = vi.fn((file: File) => filePaths.get(file) ?? "");
  const options: CreateLocalSubtitleRendererApiOptions = {
    ipcRenderer: { invoke, on, off } as unknown as CreateLocalSubtitleRendererApiOptions["ipcRenderer"],
    webUtils: { getPathForFile },
    ownerSessionRegistration,
    ...overrides,
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
  const firstCapture = api.captureInputFile(mediaOne);
  const captured = firstCapture.ok
    ? api.captureInputFile(mediaTwo, firstCapture.data.captureRef)
    : firstCapture;
  const authorizeInputFiles = captured.ok
    ? api.authorizeCapturedInputFiles(captured.data.captureRef)
    : Promise.resolve(captured);
  return Promise.all([
    authorizeInputFiles,
    api.probeMedia("file-1"),
    api.revokeInputFile("file-1"),
    api.selectOutputDirectory(),
    api.revokeOutputDirectory("output-1"),
    api.probeRuntime(),
    api.previewBackend({ modelId: "model-1", devicePreference: "auto" }),
    api.listManagedResources(),
    api.startResourceInstall({ resourceId: "model-1" }),
    api.cancelResourceJob("job-1"),
    api.importModel(model, { mode: "copy", modelId: "large-v3-q5_0" }),
    api.deleteManagedResource("model-1"),
    api.getSessionSnapshot(),
    api.enqueue(validEnqueueRequest()),
    api.retryTask("task-1"),
    api.retryTaskOnCpu({ taskId: "task-1", generation: 1 }),
    api.cancelBatch("batch-1"),
    api.cancelTask("task-1"),
    api.removeTask("task-1"),
    api.completePostAction({
      taskId: "task-1",
      generation: 1,
      postAction: {
        mode: "enqueue_translation",
        preferredFormat: "SRT",
        importStatus: "queued",
        startStatus: "not_requested",
        importReceiptId: "receipt-1",
        translationTaskId: "translation-task-1",
      },
    }),
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
