import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError,
  resolveLocalSubtitleTerminalOutcome,
  type LocalSubtitleArtifactResult,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleTaskSummary,
  type LocalSubtitleTranscript,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS,
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS,
  enqueueLocalSubtitleBatchRequestSchema,
  localSubtitleBackendPreviewRequestSchema,
  localSubtitleBackendPreviewSummarySchema,
  localSubtitleCompletePostActionRequestSchema,
  localSubtitleAuthorizeInputFilesRequestSchema,
  localSubtitleAuthorizedMediaListSchema,
  localSubtitleArtifactRefRequestSchema,
  localSubtitleArtifactTextResultSchema,
  localSubtitleDiagnosticsSchema,
  localSubtitleErrorSchema,
  localSubtitleIpcResultSchema,
  localSubtitleManagedResourceListSchema,
  localSubtitleMediaProbeSummarySchema,
  localSubtitleImportModelRequestSchema,
  localSubtitleOwnerSessionRegistrationSchema,
  localSubtitleOutputDirectorySelectionSchema,
  localSubtitleListOverwriteRecoveriesResultSchema,
  localSubtitleRecoverOverwriteRequestSchema,
  localSubtitleRecoverOverwriteResultSchema,
  localSubtitleResourceJobSummarySchema,
  localSubtitleRuntimeSummarySchema,
  localSubtitleSecureIpcEnvelopeSchema,
  localSubtitleSessionSnapshotSchema,
  localSubtitleTaskEventEnvelopeSchema,
  localSubtitleTaskSummarySchema,
  localSubtitleTranscriptSchema,
  validateEnqueueLocalSubtitleBatchRequest,
  validateLocalSubtitleSessionSnapshot,
  validateLocalSubtitleTaskEventEnvelope,
  validateLocalSubtitleTranscript,
  type LocalSubtitlePublicInvokeChannel,
  type LocalSubtitlePreloadInternalChannel,
  type LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";

const NOW = "2026-07-21T12:00:00.000Z";
const SHA = "a".repeat(64);

describe("local subtitle fixed IPC surface", () => {
  it("keeps public, preload-internal, and event channels exact and disjoint", () => {
    const publicChannels = Object.values(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS);
    const internalChannels = Object.values(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
    );
    const eventChannels = Object.values(LOCAL_SUBTITLE_EVENT_CHANNELS);
    const allChannels = [...publicChannels, ...internalChannels, ...eventChannels];

    expect(publicChannels).toHaveLength(19);
    expect(internalChannels).toHaveLength(7);
    expect(eventChannels).toHaveLength(2);
    expect(new Set(allChannels).size).toBe(allChannels.length);
    expect(allChannels.every((channel) => channel.startsWith("local-subtitle:")))
      .toBe(true);
    expect(allChannels.some((channel) => channel.startsWith("audio:"))).toBe(
      false,
    );
    expect(Object.keys(LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS).sort()).toEqual(
      [...publicChannels].sort(),
    );
    expect(
      Object.keys(LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS).sort(),
    ).toEqual([...internalChannels].sort());
  });

  it("exposes only the fixed renderer methods without a generic transport", () => {
    type ExpectedRendererApiKey =
      | "authorizeInputFiles"
      | "probeMedia"
      | "revokeInputFile"
      | "selectOutputDirectory"
      | "revokeOutputDirectory"
      | "probeRuntime"
      | "previewBackend"
      | "listManagedResources"
      | "startResourceInstall"
      | "cancelResourceJob"
      | "importModel"
      | "deleteManagedResource"
      | "getSessionSnapshot"
      | "enqueue"
      | "retryTask"
      | "retryTaskOnCpu"
      | "cancelBatch"
      | "cancelTask"
      | "removeTask"
      | "completePostAction"
      | "readArtifactText"
      | "revealArtifact"
      | "handoffArtifact"
      | "listOverwriteRecoveries"
      | "recoverOverwrite"
      | "onTaskEvent"
      | "onResourceEvent";

    expectTypeOf<keyof LocalSubtitleRendererApi>().toEqualTypeOf<
      ExpectedRendererApiKey
    >();
    expectTypeOf<
      Extract<keyof LocalSubtitleRendererApi, "invoke" | "send" | "channel">
    >().toEqualTypeOf<never>();
    expectTypeOf<Parameters<LocalSubtitleRendererApi["authorizeInputFiles"]>>()
      .toEqualTypeOf<[files: File[]]>();
    expectTypeOf<Parameters<LocalSubtitleRendererApi["importModel"]>>()
      .toEqualTypeOf<[
        file: File,
        options: {
          readonly mode: "copy" | "move";
          readonly modelId: string;
        },
      ]>();
  });

  it("uses a strict preload-private owner envelope", () => {
    const schema = localSubtitleSecureIpcEnvelopeSchema(
      localSubtitleArtifactRefRequestSchema,
    );
    const envelope = {
      ownerSessionId: "owner_session_1234567890",
      payload: { artifactRef: "artifact-ref" },
    };

    expect(schema.parse(envelope)).toEqual(envelope);
    expect(
      schema.safeParse({ ...envelope, senderId: 7 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...envelope,
        ownerSessionId: "short",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...envelope,
        payload: { ...envelope.payload, path: "/private/result.srt" },
      }).success,
    ).toBe(false);
  });

  it("keeps overwrite recovery paging and selection path-free", () => {
    const summary = {
      recoveryId: "recovery-1",
      displayCode: "ABCDEF123456",
      taskId: "task-1",
      generation: 1,
      format: "SRT" as const,
      direction: "rollback" as const,
      state: "retry_failed" as const,
      createdAt: 1,
      requiresDirectorySelection: true,
    };
    expect(
      localSubtitleListOverwriteRecoveriesResultSchema.parse({
        status: "ready",
        items: [summary],
        nextCursor: { createdAt: 1, recoveryId: "recovery-1" },
      }),
    ).toEqual({
      status: "ready",
      items: [summary],
      nextCursor: { createdAt: 1, recoveryId: "recovery-1" },
    });
    expect(
      localSubtitleListOverwriteRecoveriesResultSchema.safeParse({
        status: "ready",
        items: [{ ...summary, directoryPath: "/private/output" }],
      }).success,
    ).toBe(false);
    expect(
      localSubtitleListOverwriteRecoveriesResultSchema.safeParse({
        status: "ready",
        items: [{ ...summary, displayCode: "recovery-1" }],
      }).success,
    ).toBe(false);
    expect(
      localSubtitleRecoverOverwriteRequestSchema.safeParse({
        recoveryId: "r".repeat(81),
      }).success,
    ).toBe(false);
    expect(
      localSubtitleRecoverOverwriteRequestSchema.safeParse({
        recoveryId: "recovery-1",
        outputDirToken: "output-token",
      }).success,
    ).toBe(false);
    expect(
      localSubtitleRecoverOverwriteResultSchema.safeParse({
        status: "recovered",
        outcome: "not_found",
      }).success,
    ).toBe(false);
    expect(
      localSubtitleListOverwriteRecoveriesResultSchema.safeParse({
        status: "blocked",
        items: [],
      }).success,
    ).toBe(false);
  });

  it("freezes every preload-internal request, result, and envelope policy", () => {
    const requests = validInternalOperationRequests();
    const results = validInternalOperationResults();
    const registerChannel =
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession;

    for (const channel of Object.values(
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
    )) {
      const contract = LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS[channel];
      expect(
        contract.requestSchema.safeParse(requests[channel]).success,
        `${channel}:request`,
      ).toBe(true);
      expect(
        contract.resultSchema.safeParse({
          ok: true,
          data: results[channel],
        }).success,
        `${channel}:result`,
      ).toBe(true);
      expect(contract.requiresOwnerEnvelope, channel).toBe(
        channel !== registerChannel,
      );
      expect(contract.maxRequestBytes, channel).toBe(
        LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes,
      );
      expect(contract.maxResultBytes, channel).toBe(
        LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes,
      );

      expect(
        contract.requestSchema.safeParse({
          ...(requests[channel] as Record<string, unknown>),
          ownerSessionId: "owner_session_1234567890",
        }).success,
        `${channel}:owner-injection`,
      ).toBe(false);

      const result = results[channel];
      const injectedResult = Array.isArray(result)
        ? [{ ...(result[0] as Record<string, unknown>), path: "/private/file" }]
        : { ...(result as Record<string, unknown>), path: "/private/file" };
      expect(
        contract.resultSchema.safeParse({
          ok: true,
          data: injectedResult,
        }).success,
        `${channel}:result-path-injection`,
      ).toBe(false);
    }

    expect(
      localSubtitleOwnerSessionRegistrationSchema.parse({
        ownerSessionId: "owner_session_1234567890",
      }),
    ).toEqual({ ownerSessionId: "owner_session_1234567890" });
    expect(
      localSubtitleOwnerSessionRegistrationSchema.safeParse({
        ownerSessionId: "owner_session_1234567890",
        senderId: 1,
      }).success,
    ).toBe(false);

    const maxPath = "x".repeat(32_768);
    expect(
      localSubtitleAuthorizeInputFilesRequestSchema.safeParse({
        files: [{ filePath: maxPath }],
      }).success,
    ).toBe(true);
    expect(
      localSubtitleAuthorizeInputFilesRequestSchema.safeParse({
        files: [{ filePath: `${maxPath}x` }],
      }).success,
    ).toBe(false);
    expect(
      localSubtitleAuthorizeInputFilesRequestSchema.safeParse({
        files: [
          {
            filePath: "/private/media.wav",
            url: "https://example.invalid/media.wav",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      localSubtitleImportModelRequestSchema.safeParse({
        filePath: "/private/model.bin",
        mode: "copy",
        modelId: "large-v3-q5_0",
        executable: "/tmp/whisper-server",
      }).success,
    ).toBe(false);
  });

  it("maps every public request to a strict path-free schema", () => {
    const fixtures = validPublicOperationRequests();
    const forbiddenFields: Record<string, unknown> = {
      path: "/private/media.wav",
      filePath: "/private/media.wav",
      outputPath: "/private/output.srt",
      url: "https://example.invalid/model.bin",
      executable: "/tmp/whisper-server",
      backendFlags: { flashAttention: true },
      ownerSessionId: "owner_session_1234567890",
    };

    for (const channel of Object.values(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
    )) {
      const contract = LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[channel];
      const fixture = fixtures[channel];
      expect(contract.requestSchema.safeParse(fixture).success, channel).toBe(
        true,
      );

      for (const [field, value] of Object.entries(forbiddenFields)) {
        expect(
          contract.requestSchema.safeParse({
            ...(fixture as Record<string, unknown>),
            [field]: value,
          }).success,
          `${channel}:${field}`,
        ).toBe(false);
      }
    }

    const installContract =
      LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall
      ];
    expect(installContract.requestSchema.parse({ resourceId: "model-1" }))
      .toEqual({ resourceId: "model-1" });
    expect(
      installContract.requestSchema.safeParse({
        resourceId: "https://example.invalid/model.bin",
      }).success,
    ).toBe(false);
    expect(
      LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia
      ].requestSchema.safeParse({ fileToken: "/private/media.wav" }).success,
    ).toBe(false);
    expect(
      LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact
      ].requestSchema.safeParse({ artifactRef: "C:\\private\\result.srt" })
        .success,
    ).toBe(false);
    expect(
      localSubtitleBackendPreviewRequestSchema.parse({
        modelId: "model-1",
        devicePreference: "auto",
      }),
    ).toEqual({ modelId: "model-1", devicePreference: "auto" });
    expect(
      localSubtitleBackendPreviewRequestSchema.safeParse({
        modelId: "model-1",
        devicePreference: "auto",
        runtimeGeneration: SHA,
      }).success,
    ).toBe(false);
  });

  it("maps every public result to a strict bounded path-free schema", () => {
    const fixtures = validPublicOperationResults();
    const forbiddenFields: Record<string, unknown> = {
      path: "/private/media.wav",
      filePath: "/private/media.wav",
      outputPath: "/private/output.srt",
      url: "https://example.invalid/model.bin",
      executable: "/tmp/whisper-server",
      backendFlags: { flashAttention: true },
      ownerSessionId: "owner_session_1234567890",
    };

    for (const channel of Object.values(
      LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
    )) {
      const contract = LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[channel];
      const fixture = fixtures[channel];
      expect(
        contract.resultSchema.safeParse({ ok: true, data: fixture }).success,
        channel,
      ).toBe(true);

      for (const [field, value] of Object.entries(forbiddenFields)) {
        const injected = Array.isArray(fixture)
          ? [{ ...(fixture[0] as Record<string, unknown>), [field]: value }]
          : { ...(fixture as Record<string, unknown>), [field]: value };
        expect(
          contract.resultSchema.safeParse({ ok: true, data: injected }).success,
          `${channel}:${field}`,
        ).toBe(false);
      }

      expect(
        contract.resultSchema.safeParse({
          ok: false,
          error: createLocalSubtitleError(
            "configuration_required",
            "Configuration is required.",
          ),
        }).success,
        `${channel}:failure`,
      ).toBe(true);
    }
  });

  it("keeps backend previews path, hash, generation, and flag free", () => {
    const preview = {
      devicePreference: "auto" as const,
      resolvedBackend: "cpu" as const,
      modelId: "model-1",
      serverArtifactId: "whisper-server-cpu",
      serverVersion: "1.9.1+b1ade71",
    };
    expect(localSubtitleBackendPreviewSummarySchema.parse(preview)).toEqual(
      preview,
    );
    for (const injected of [
      { absolutePath: "/private/runtime/server" },
      { modelHash: SHA },
      { artifactHash: SHA },
      { runtimeGeneration: SHA },
      { backendFlags: ["--flash-attn"] },
    ]) {
      expect(
        localSubtitleBackendPreviewSummarySchema.safeParse({
          ...preview,
          ...injected,
        }).success,
      ).toBe(false);
    }
  });

  it("assigns operation-specific frame budgets", () => {
    for (const [channel, contract] of Object.entries(
      LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS,
    )) {
      expect(contract.maxRequestBytes, channel).toBe(
        LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes,
      );
      const expectedResultBytes =
        channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot
          ? LOCAL_SUBTITLE_LIMITS.maxSessionSnapshotBytes
          : channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText
            ? LOCAL_SUBTITLE_LIMITS.maxArtifactBytes +
              LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes
            : LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes;
      expect(contract.maxResultBytes, channel).toBe(expectedResultBytes);
    }

    const artifactShell = {
      format: "SRT" as const,
      rawText: "",
      plainText: "",
      cueCount: 1,
    };
    const artifactShellBytes = new TextEncoder().encode(
      JSON.stringify(artifactShell),
    ).byteLength;
    const availableTextBytes =
      LOCAL_SUBTITLE_LIMITS.maxArtifactBytes - artifactShellBytes;
    const atArtifactLimit = {
      ...artifactShell,
      rawText: "x".repeat(availableTextBytes - 1),
      plainText: "x",
    };
    expect(
      localSubtitleArtifactTextResultSchema.safeParse(atArtifactLimit).success,
    ).toBe(true);
    expect(
      LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[
        LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText
      ].resultSchema.safeParse({ ok: true, data: atArtifactLimit }).success,
    ).toBe(true);
    expect(
      localSubtitleArtifactTextResultSchema.safeParse({
        ...atArtifactLimit,
        rawText: `${atArtifactLimit.rawText}x`,
      }).success,
    ).toBe(false);
  });

  it("bounds and cross-validates fixed API response summaries", () => {
    const authorized = validAuthorizedMedia();
    expect(localSubtitleAuthorizedMediaListSchema.parse([authorized])).toEqual([
      authorized,
    ]);
    expect(
      localSubtitleAuthorizedMediaListSchema.safeParse([authorized, authorized])
        .success,
    ).toBe(false);
    expect(
      localSubtitleAuthorizedMediaListSchema.safeParse([
        authorized,
        { ...authorized, fileToken: "file-token-2" },
      ]).success,
    ).toBe(false);
    expect(
      localSubtitleAuthorizedMediaListSchema.safeParse([
        { ...authorized, displayName: "/private/sample.wav" },
      ]).success,
    ).toBe(false);

    const probe = validMediaProbeSummary();
    expect(localSubtitleMediaProbeSummarySchema.parse(probe)).toEqual(probe);
    expect(
      localSubtitleMediaProbeSummarySchema.safeParse({
        ...probe,
        autoSelectedStreamId: "unknown-stream",
      }).success,
    ).toBe(false);
    for (const title of [" outer", "line\nbreak", "tab\tvalue", "line\u2028break"]) {
      expect(
        localSubtitleMediaProbeSummarySchema.safeParse({
          ...probe,
          audioTracks: [{ ...probe.audioTracks[0], title }],
        }).success,
      ).toBe(false);
    }

    expect(
      localSubtitleOutputDirectorySelectionSchema.parse({ cancelled: true }),
    ).toEqual({ cancelled: true });
    expect(
      localSubtitleOutputDirectorySelectionSchema.safeParse({
        cancelled: false,
        outputDirToken: "output-token",
        displayLabel: "Exports",
        expiresAt: Date.now() + 60_000,
        path: "/private/exports",
      }).success,
    ).toBe(false);

    expect(localSubtitleRuntimeSummarySchema.parse(validRuntimeSummary()))
      .toEqual(validRuntimeSummary());
    expect(
      localSubtitleManagedResourceListSchema.parse([validManagedResource()]),
    ).toEqual([validManagedResource()]);
    expect(
      localSubtitleManagedResourceListSchema.safeParse([
        {
          ...validManagedResource(),
          resourceId: "https://example.invalid/model.bin",
        },
      ]).success,
    ).toBe(false);
    expect(
      localSubtitleManagedResourceListSchema.safeParse([
        {
          ...validManagedResource(),
          resourceId: "vad-1",
          resourceType: "vad",
        },
      ]).success,
    ).toBe(false);
    expect(localSubtitleResourceJobSummarySchema.parse(validResourceJob()))
      .toEqual(validResourceJob());
  });
});

describe("local subtitle IPC request contract", () => {
  it("accepts the versioned metadata-only enqueue request", () => {
    const request = validEnqueueRequest();
    const result = validateEnqueueLocalSubtitleBatchRequest(request);

    expect(result).toEqual({ ok: true, data: request });
    expect(
      enqueueLocalSubtitleBatchRequestSchema.parse(
        JSON.parse(JSON.stringify(request)),
      ),
    ).toEqual(request);
  });

  it("rejects raw paths, executables, resolved backends, and unknown fields at every layer", () => {
    const cases: Array<[string, (request: any) => void]> = [
      ["root path", (request) => (request.path = "/private/media.wav")],
      [
        "file path",
        (request) => (request.files[0].filePath = "/private/media.wav"),
      ],
      [
        "model path",
        (request) => (request.config.modelPath = "/private/model.bin"),
      ],
      [
        "model hash",
        (request) => (request.config.modelHash = SHA),
      ],
      [
        "resolved backend",
        (request) => (request.config.resolvedBackend = "cuda"),
      ],
      [
        "removed quality preset",
        (request) => (request.config.qualityPreset = "balanced"),
      ],
      [
        "executable",
        (request) => (request.config.executable = "/tmp/whisper-server"),
      ],
      [
        "arguments",
        (request) => (request.config.args = ["--port", "9999"]),
      ],
      [
        "backend flags",
        (request) => (request.config.backendFlags = { flashAttention: true }),
      ],
      [
        "output path",
        (request) =>
          (request.config.output.outputPath = "/private/subtitles"),
      ],
      [
        "post action override",
        (request) => (request.config.postAction.autoStart = true),
      ],
    ];

    for (const [name, mutate] of cases) {
      const request = structuredClone(validEnqueueRequest());
      mutate(request);
      expect(validateEnqueueLocalSubtitleBatchRequest(request), name).toMatchObject({
        ok: false,
        error: { code: "invalid_ipc_request" },
      });
    }
  });

  it("keeps v1 device requests on the frozen CPU, CUDA, and Metal matrix", () => {
    const request = validEnqueueRequest();
    request.config.devicePreference = "vulkan" as "auto";

    const result = validateEnqueueLocalSubtitleBatchRequest(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request", field: "config.devicePreference" },
    });
  });

  it("requires an explicit VAD preference in every enqueue request", () => {
    const enabled = validEnqueueRequest();
    enabled.config.vadEnabled = true;
    expect(validateEnqueueLocalSubtitleBatchRequest(enabled).ok).toBe(true);

    const disabled = validEnqueueRequest();
    disabled.config.vadEnabled = false;
    expect(validateEnqueueLocalSubtitleBatchRequest(disabled).ok).toBe(true);

    const missing = validEnqueueRequest() as any;
    delete missing.config.vadEnabled;
    expect(validateEnqueueLocalSubtitleBatchRequest(missing).ok).toBe(false);
  });

  it("enforces output and post-action discriminants", () => {
    const duplicateFormats = validEnqueueRequest();
    duplicateFormats.config.output.formats = ["SRT", "SRT"];
    expect(validateEnqueueLocalSubtitleBatchRequest(duplicateFormats).ok).toBe(
      false,
    );

    const missingCustomToken = validEnqueueRequest() as any;
    missingCustomToken.config.output = {
      mode: "custom",
      formats: ["SRT"],
      conflictPolicy: "index",
    };
    expect(validateEnqueueLocalSubtitleBatchRequest(missingCustomToken).ok).toBe(
      false,
    );

    const wrongHandoffFormat = validEnqueueRequest();
    wrongHandoffFormat.config.output.formats = ["SRT"];
    wrongHandoffFormat.config.postAction = {
      mode: "enqueue_translation",
      preferredFormat: "LRC",
      translationSnapshotId: "translation-snapshot-1",
    };
    expect(validateEnqueueLocalSubtitleBatchRequest(wrongHandoffFormat).ok).toBe(
      false,
    );

    const preparedHandoff = validEnqueueRequest();
    preparedHandoff.config.postAction = {
      mode: "enqueue_translation",
      preferredFormat: "SRT",
      translationSnapshotId: "translation-snapshot-1",
    };
    expect(validateEnqueueLocalSubtitleBatchRequest(preparedHandoff).ok).toBe(
      true,
    );

    const missingSnapshot = structuredClone(preparedHandoff) as any;
    delete missingSnapshot.config.postAction.translationSnapshotId;
    expect(validateEnqueueLocalSubtitleBatchRequest(missingSnapshot).ok).toBe(
      false,
    );

    const invalidExportOnly = validEnqueueRequest() as any;
    invalidExportOnly.config.postAction = {
      mode: "export_only",
      preferredFormat: "SRT",
    };
    expect(validateEnqueueLocalSubtitleBatchRequest(invalidExportOnly).ok).toBe(
      false,
    );
  });

  it("accepts only terminal translation post-action completions", () => {
    const completion = {
      taskId: "task-1",
      generation: 1,
      postAction: {
        mode: "enqueue_translation" as const,
        preferredFormat: "SRT" as const,
        importStatus: "queued" as const,
        startStatus: "not_requested" as const,
        importReceiptId: "receipt-1",
        translationTaskId: "translation-task-1",
      },
    };
    expect(localSubtitleCompletePostActionRequestSchema.safeParse(completion).success)
      .toBe(true);
    expect(localSubtitleCompletePostActionRequestSchema.safeParse({
      ...completion,
      postAction: {
        mode: "enqueue_translation",
        preferredFormat: "SRT",
        importStatus: "pending",
        startStatus: "not_requested",
      },
    }).success).toBe(false);
    expect(localSubtitleCompletePostActionRequestSchema.safeParse({
      ...completion,
      postAction: {
        mode: "export_only",
        importStatus: "not_requested",
        startStatus: "not_requested",
      },
    }).success).toBe(false);
  });

  it("enforces batch count and prompt boundaries", () => {
    const atBatchLimit = validEnqueueRequest();
    atBatchLimit.files = Array.from(
      { length: LOCAL_SUBTITLE_LIMITS.maxBatchFiles },
      (_, index) => ({
        fileToken: `file-${index}`,
        audioStreamId: `stream-${index}`,
      }),
    );
    expect(validateEnqueueLocalSubtitleBatchRequest(atBatchLimit).ok).toBe(true);

    const aboveBatchLimit = structuredClone(atBatchLimit);
    aboveBatchLimit.files.push({
      fileToken: "file-over-limit",
      audioStreamId: "stream-over-limit",
    });
    expect(validateEnqueueLocalSubtitleBatchRequest(aboveBatchLimit).ok).toBe(
      false,
    );

    const atPromptLimit = validEnqueueRequest();
    atPromptLimit.config.advanced.initialPrompt = "x".repeat(
      LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars,
    );
    expect(validateEnqueueLocalSubtitleBatchRequest(atPromptLimit).ok).toBe(true);

    const abovePromptLimit = validEnqueueRequest();
    abovePromptLimit.config.advanced.initialPrompt = "x".repeat(
      LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars + 1,
    );
    expect(validateEnqueueLocalSubtitleBatchRequest(abovePromptLimit).ok).toBe(
      false,
    );
  });

  it("measures normal IPC frames in UTF-8 bytes before parsing", () => {
    const oversized = {
      ...validEnqueueRequest(),
      padding: "字".repeat(LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes),
    };
    const result = validateEnqueueLocalSubtitleBatchRequest(oversized);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "limit_exceeded",
        details: {
          metadata: { limit: LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes },
        },
      },
    });
  });

  it("rejects non-JSON frames without reflecting their content", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = validateEnqueueLocalSubtitleBatchRequest(circular);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_ipc_request",
        message: "Local subtitle IPC payload must be JSON serializable.",
        stage: "ipc",
        retryable: false,
      },
    });
  });
});

describe("local subtitle event and snapshot schemas", () => {
  it("round-trips a task event with fixed ids, generation, and revision", () => {
    const task = validTaskSummary();
    const event = {
      batchId: task.batchId,
      taskId: task.taskId,
      generation: task.generation,
      revision: 7,
      event: { type: "task-updated" as const, task },
    };

    expect(validateLocalSubtitleTaskEventEnvelope(event)).toEqual({
      ok: true,
      data: event,
    });
    expect(
      localSubtitleTaskEventEnvelopeSchema.parse(
        JSON.parse(JSON.stringify(event)),
      ),
    ).toEqual(event);
  });

  it("rejects mismatched envelope identity and nested unknown fields", () => {
    const task = validTaskSummary();
    const mismatched = {
      batchId: task.batchId,
      taskId: "another-task",
      generation: task.generation,
      revision: 7,
      event: { type: "task-updated" as const, task },
    };
    expect(validateLocalSubtitleTaskEventEnvelope(mismatched).ok).toBe(false);

    const injected = structuredClone(mismatched) as any;
    injected.taskId = task.taskId;
    injected.event.task.sourcePath = "/private/media.wav";
    expect(validateLocalSubtitleTaskEventEnvelope(injected)).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
  });

  it("keeps session snapshots path-free and JSON round-trippable", () => {
    const snapshot = validSessionSnapshot();
    expect(validateLocalSubtitleSessionSnapshot(snapshot)).toEqual({
      ok: true,
      data: snapshot,
    });
    expect(
      localSubtitleSessionSnapshotSchema.parse(
        JSON.parse(JSON.stringify(snapshot)),
      ),
    ).toEqual(snapshot);

    const injected = structuredClone(snapshot) as any;
    injected.batches[0].tasks[0].outputPath = "/private/subtitles/sample.srt";
    expect(validateLocalSubtitleSessionSnapshot(injected).ok).toBe(false);

    const legacySnapshot = structuredClone(snapshot) as any;
    legacySnapshot.recoveredSession = { batches: [] };
    expect(validateLocalSubtitleSessionSnapshot(legacySnapshot)).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });
  });

  it("requires snapshot batch status to match the shared task aggregate", () => {
    const snapshot = structuredClone(validSessionSnapshot()) as any;
    snapshot.batches[0]!.status = "running";

    expect(validateLocalSubtitleSessionSnapshot(snapshot)).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request", field: "batches.0.status" },
    });
  });

  it("uses the larger snapshot frame budget without weakening strict parsing", () => {
    const belowSnapshotLimit = {
      ...validSessionSnapshot(),
      padding: "x".repeat(LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes + 1),
    };
    expect(validateLocalSubtitleSessionSnapshot(belowSnapshotLimit)).toMatchObject({
      ok: false,
      error: { code: "invalid_ipc_request" },
    });

    const aboveSnapshotLimit = {
      ...validSessionSnapshot(),
      padding: "x".repeat(LOCAL_SUBTITLE_LIMITS.maxSessionSnapshotBytes + 1),
    };
    expect(validateLocalSubtitleSessionSnapshot(aboveSnapshotLimit)).toMatchObject({
      ok: false,
      error: { code: "limit_exceeded" },
    });
  });
});

describe("local subtitle error and result schemas", () => {
  it("derives retryability from the versioned manifest", () => {
    const error = createLocalSubtitleError(
      "media_runtime_invalid",
      "Bundled media runtime failed verification.",
    );
    expect(localSubtitleErrorSchema.parse(error)).toEqual(error);

    expect(
      localSubtitleErrorSchema.safeParse({ ...error, retryable: false }).success,
    ).toBe(false);
  });

  it("bounds diagnostics by UTF-8 bytes and an exact metadata allowlist", () => {
    const ascii = {
      truncated: false,
      lines: Array.from({ length: 22 }, () => "x".repeat(1000)),
      metadata: { attempt: 1, backend: "metal" },
    };
    expect(localSubtitleDiagnosticsSchema.safeParse(ascii).success).toBe(true);

    const multibyte = {
      ...ascii,
      lines: Array.from({ length: 22 }, () => "字".repeat(1000)),
    };
    expect(localSubtitleDiagnosticsSchema.safeParse(multibyte).success).toBe(
      false,
    );

    expect(
      localSubtitleDiagnosticsSchema.safeParse({
        truncated: false,
        metadata: { path: "/private/media.wav" },
      }).success,
    ).toBe(false);
  });

  it("creates strict generic IPC result schemas", () => {
    const schema = localSubtitleIpcResultSchema(
      localSubtitleArtifactRefRequestSchema,
    );
    expect(
      schema.parse({ ok: true, data: { artifactRef: "artifact-ref" } }),
    ).toEqual({ ok: true, data: { artifactRef: "artifact-ref" } });
    expect(
      schema.safeParse({
        ok: true,
        data: { artifactRef: "artifact-ref", path: "/private/result.srt" },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ok: false,
        error: createLocalSubtitleError("artifact_expired", "Expired."),
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("local subtitle transcript and task summary schemas", () => {
  it("round-trips canonical integer-millisecond transcripts", () => {
    const transcript = validTranscript();
    expect(validateLocalSubtitleTranscript(transcript)).toEqual({
      ok: true,
      data: transcript,
    });
    expect(
      localSubtitleTranscriptSchema.parse(
        JSON.parse(JSON.stringify(transcript)),
      ),
    ).toEqual(transcript);

    const timestamped = validTranscript();
    delete timestamped.segments[0].estimatedTiming;
    timestamped.segments[0].words = [
      { startMs: 1000, endMs: 1400, text: "sample" },
      { startMs: 1400, endMs: 2000, text: "words" },
    ];
    expect(validateLocalSubtitleTranscript(timestamped)).toEqual({
      ok: true,
      data: timestamped,
    });

    const falseEstimate = validTranscript() as any;
    falseEstimate.segments[0].estimatedTiming = false;
    expect(validateLocalSubtitleTranscript(falseEstimate).ok).toBe(false);

    const wordsAndEstimate = validTranscript() as any;
    wordsAndEstimate.segments[0].words = [
      { startMs: 1000, endMs: 1500, text: "sample" },
    ];
    expect(validateLocalSubtitleTranscript(wordsAndEstimate).ok).toBe(false);

    const overlappingSegments = validTranscript() as any;
    overlappingSegments.segments.push({
      id: "seg-002",
      startMs: 1500,
      endMs: 2500,
      text: "overlap",
    });
    expect(validateLocalSubtitleTranscript(overlappingSegments).ok).toBe(false);

    const reversedWords = validTranscript() as any;
    delete reversedWords.segments[0].estimatedTiming;
    reversedWords.segments[0].words = [
      { startMs: 1400, endMs: 1600, text: "later" },
      { startMs: 1200, endMs: 1300, text: "earlier" },
    ];
    expect(validateLocalSubtitleTranscript(reversedWords).ok).toBe(false);
  });

  it.each(["line\rbreak", "line\u2028break", "line\u2029break", "bad\u0085text", "bad\ud800text", "bad\ud800", "bad\udc00text"])(
    "rejects non-canonical line separators, controls, and Unicode scalars",
    (text) => {
      const transcript = validTranscript();
      transcript.segments[0].text = text;
      expect(validateLocalSubtitleTranscript(transcript).ok).toBe(false);
    },
  );

  it("rejects v1 Vulkan, raw paths, unsafe timelines, and compressed word time", () => {
    const vulkan = validTranscript() as any;
    vulkan.model.backend = "vulkan";
    expect(validateLocalSubtitleTranscript(vulkan).ok).toBe(false);

    const withPath = validTranscript() as any;
    withPath.source.path = "/private/media.wav";
    expect(validateLocalSubtitleTranscript(withPath).ok).toBe(false);

    const overDuration = validTranscript();
    overDuration.source.durationMs = LOCAL_SUBTITLE_LIMITS.maxDurationMs + 1;
    expect(validateLocalSubtitleTranscript(overDuration).ok).toBe(false);

    const wordOutsideSegment = validTranscript();
    wordOutsideSegment.segments[0].words = [
      { startMs: 0, endMs: 1500, text: "outside" },
    ];
    expect(validateLocalSubtitleTranscript(wordOutsideSegment).ok).toBe(false);

    const unordered = validTranscript();
    unordered.segments.push({
      id: "segment-2",
      startMs: 500,
      endMs: 900,
      text: "earlier",
    });
    expect(validateLocalSubtitleTranscript(unordered).ok).toBe(false);
  });

  it("enforces duration and text boundaries while keeping artifact integrity private", () => {
    const atDurationLimit = validTranscript();
    atDurationLimit.source.durationMs = LOCAL_SUBTITLE_LIMITS.maxDurationMs;
    expect(validateLocalSubtitleTranscript(atDurationLimit).ok).toBe(true);

    const atTextLimit = validTranscript();
    atTextLimit.segments[0].text = Array.from(
      { length: LOCAL_SUBTITLE_LIMITS.maxCueLines },
      () => "x".repeat(LOCAL_SUBTITLE_LIMITS.maxLineChars),
    ).join("\n");
    expect(validateLocalSubtitleTranscript(atTextLimit).ok).toBe(true);

    const overLineLimit = validTranscript();
    overLineLimit.segments[0].text = "x".repeat(
      LOCAL_SUBTITLE_LIMITS.maxLineChars + 1,
    );
    expect(validateLocalSubtitleTranscript(overLineLimit).ok).toBe(false);

    const task = completedTaskSummary();
    const committed = task.artifactResults[0];
    if (committed.status !== "committed") throw new Error("fixture mismatch");
    const atLimitOutcome = resolveLocalSubtitleTerminalOutcome({
      requestedFormats: task.requestedFormats,
      artifactResults: task.artifactResults,
    });
    if (!atLimitOutcome.ok || atLimitOutcome.status !== "completed") {
      throw new Error("invalid limit fixture");
    }
    task.completion = atLimitOutcome.completion;
    expect(localSubtitleTaskSummarySchema.safeParse(task).success).toBe(true);

    (committed.artifact as any).sha256 = SHA;
    expect(localSubtitleTaskSummarySchema.safeParse(task).success).toBe(false);
  });

  it("requires task completion details to exactly match artifact results", () => {
    const task = completedTaskSummary();
    expect(localSubtitleTaskSummarySchema.safeParse(task).success).toBe(true);

    const cancellationCleanupFailure = completedTaskSummary();
    cancellationCleanupFailure.artifactResults[1] = {
      format: "LRC",
      status: "failed",
      errorCode: "cancel_failed",
    };
    const cancellationOutcome = resolveLocalSubtitleTerminalOutcome({
      requestedFormats: cancellationCleanupFailure.requestedFormats,
      artifactResults: cancellationCleanupFailure.artifactResults,
      cancellationRequested: true,
    });
    if (!cancellationOutcome.ok || cancellationOutcome.status !== "completed") {
      throw new Error("invalid cancellation cleanup fixture");
    }
    cancellationCleanupFailure.completion = cancellationOutcome.completion;
    expect(
      localSubtitleTaskSummarySchema.safeParse(cancellationCleanupFailure).success,
    ).toBe(true);

    const cancelledCleanupFailure = validTaskSummary() as any;
    cancelledCleanupFailure.status = "cancelled";
    cancelledCleanupFailure.progress = {
      stage: "cancelling",
      stageProgress: 100,
      overallProgress: 99,
    };
    cancelledCleanupFailure.artifactResults = [
      { format: "SRT", status: "failed", errorCode: "cancel_failed" },
    ];
    expect(
      localSubtitleTaskSummarySchema.safeParse(cancelledCleanupFailure).success,
    ).toBe(false);

    const cancelledAfterOrdinaryFailure = validTaskSummary() as any;
    cancelledAfterOrdinaryFailure.status = "cancelled";
    cancelledAfterOrdinaryFailure.progress = {
      stage: "cancelling",
      stageProgress: 100,
      overallProgress: 99,
    };
    cancelledAfterOrdinaryFailure.artifactResults = [
      {
        format: "SRT",
        status: "failed",
        errorCode: "output_write_failed",
      },
      { format: "LRC", status: "skipped" },
    ];
    expect(
      localSubtitleTaskSummarySchema.safeParse(cancelledAfterOrdinaryFailure)
        .success,
    ).toBe(true);

    task.completion = {
      ...task.completion!,
      outcome: "full",
    };
    expect(localSubtitleTaskSummarySchema.safeParse(task).success).toBe(false);

    const cancelledWithCommit = completedTaskSummary() as any;
    cancelledWithCommit.status = "cancelled";
    delete cancelledWithCommit.completion;
    expect(localSubtitleTaskSummarySchema.safeParse(cancelledWithCommit).success)
      .toBe(false);
  });

  it("binds task status to progress stage and artifact visibility", () => {
    const queuedWithArtifact = validTaskSummary() as any;
    queuedWithArtifact.artifactResults = [completedArtifactResults()[0]];
    expect(localSubtitleTaskSummarySchema.safeParse(queuedWithArtifact).success)
      .toBe(false);

    const queuedAtExporting = validTaskSummary() as any;
    queuedAtExporting.progress = {
      stage: "exporting",
      stageProgress: 50,
      overallProgress: 95,
    };
    expect(localSubtitleTaskSummarySchema.safeParse(queuedAtExporting).success)
      .toBe(false);

    const exportingWithCommit = validTaskSummary() as any;
    exportingWithCommit.status = "exporting";
    exportingWithCommit.progress = {
      stage: "exporting",
      stageProgress: 50,
      overallProgress: 95,
    };
    exportingWithCommit.artifactResults = [completedArtifactResults()[0]];
    expect(localSubtitleTaskSummarySchema.safeParse(exportingWithCommit).success)
      .toBe(true);
  });

  it("exposes CPU retry only for eligible failed GPU generations", () => {
    const eligible = validTaskSummary() as any;
    eligible.status = "failed";
    eligible.error = createLocalSubtitleError(
      "runtime_crashed",
      "The GPU runtime failed.",
      { stage: "transcribing" },
    );
    eligible.cpuRetryAvailable = true;
    expect(localSubtitleTaskSummarySchema.safeParse(eligible).success).toBe(true);

    eligible.resolvedBackend = "cpu";
    expect(localSubtitleTaskSummarySchema.safeParse(eligible).success).toBe(false);

    eligible.resolvedBackend = "metal";
    eligible.error = createLocalSubtitleError(
      "media_decode_failed",
      "The media could not be decoded.",
    );
    expect(localSubtitleTaskSummarySchema.safeParse(eligible).success).toBe(false);
  });

  it("derives cancellation warnings instead of accepting self-asserted state", () => {
    const fullWithCancellationWarning = completedTaskSummary() as any;
    fullWithCancellationWarning.artifactResults = [
      completedArtifactResults()[0],
      {
        format: "LRC",
        status: "committed",
        artifact: {
          artifactRef: "artifact-ref-2",
          displayName: "sample.lrc",
          format: "LRC",
          expiresAt: 1_800_000_000_000,
        },
      },
    ];
    fullWithCancellationWarning.completion = {
      outcome: "full",
      artifacts: structuredClone(fullWithCancellationWarning.artifactResults),
      warnings: ["cancelled_after_partial_commit"],
    };
    expect(
      localSubtitleTaskSummarySchema.safeParse(fullWithCancellationWarning)
        .success,
    ).toBe(false);
  });

  it("requires queued import identity before any translation start state", () => {
    const impossibleStart = validTaskSummary() as any;
    impossibleStart.postAction = {
      mode: "enqueue_and_start_translation",
      preferredFormat: "SRT",
      importStatus: "failed",
      startStatus: "started",
      importErrorCode: "import_failed",
    };
    expect(localSubtitleTaskSummarySchema.safeParse(impossibleStart).success)
      .toBe(false);

    const failedStartWithoutTask = validTaskSummary() as any;
    failedStartWithoutTask.postAction = {
      mode: "enqueue_and_start_translation",
      preferredFormat: "SRT",
      importStatus: "queued",
      startStatus: "failed",
      startFailureReason: "start_rejected",
    };
    expect(
      localSubtitleTaskSummarySchema.safeParse(failedStartWithoutTask).success,
    ).toBe(false);

    const started = completedTaskSummary() as any;
    started.postAction = {
      mode: "enqueue_and_start_translation",
      preferredFormat: "SRT",
      importStatus: "queued",
      startStatus: "started",
      importReceiptId: "receipt-1",
      translationTaskId: "translation-task-1",
    };
    expect(localSubtitleTaskSummarySchema.safeParse(started).success).toBe(
      true,
    );
  });

  it("preserves failed-format handoff state without substituting another artifact", () => {
    const skippedHandoff = completedTaskSummary() as any;
    skippedHandoff.postAction = {
      mode: "enqueue_translation",
      preferredFormat: "LRC",
      importStatus: "skipped",
      startStatus: "not_requested",
      importErrorCode: "unsupported_format",
    };
    expect(localSubtitleTaskSummarySchema.safeParse(skippedHandoff).success)
      .toBe(true);

    const importingWithoutCommit = validTaskSummary() as any;
    importingWithoutCommit.postAction = {
      mode: "enqueue_translation",
      preferredFormat: "SRT",
      importStatus: "importing",
      startStatus: "not_requested",
    };
    expect(
      localSubtitleTaskSummarySchema.safeParse(importingWithoutCommit).success,
    ).toBe(false);
  });
});

describe("local subtitle module ownership", () => {
  it("does not import or extend the remote audio contracts", () => {
    for (const file of ["localSubtitle.ts", "localSubtitleIpc.ts"]) {
      const source = readFileSync(
        path.join(process.cwd(), "src", "type", file),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["'][^"']*audio[^"']*["']/i);
      expect(source).not.toContain("audio:");
    }
  });
});

function validEnqueueRequest() {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    files: [{ fileToken: "file-token-1", audioStreamId: "stream-1" }],
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
      postAction: { mode: "export_only" as const } as
        | { mode: "export_only" }
        | {
            mode: "enqueue_translation" | "enqueue_and_start_translation";
            preferredFormat: "SRT" | "LRC";
            translationSnapshotId: string;
          },
    },
  };
}

function modelSnapshot() {
  return {
    engine: "whisper_cpp" as const,
    engineVersion: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
    engineCommit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
    modelManifestVersion: LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
    modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
    modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
  };
}

function validTaskSummary(): LocalSubtitleTaskSummary {
  return {
    taskId: "task-1",
    batchId: "batch-1",
    sourceKey: "source-key-1",
    generation: 1,
    displayName: "sample.wav",
    durationMs: 60_000,
    status: "queued",
    progress: {
      stage: "queued",
      stageProgress: 0,
      overallProgress: 0,
    },
    model: modelSnapshot(),
    resolvedBackend: "metal",
    requestedFormats: ["SRT", "LRC"],
    artifactResults: [],
    postAction: {
      mode: "export_only",
      importStatus: "not_requested",
      startStatus: "not_requested",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function completedArtifactResults(): LocalSubtitleArtifactResult[] {
  return [
    {
      format: "SRT",
      status: "committed",
      artifact: {
        artifactRef: "artifact-ref-1",
        displayName: "sample.srt",
        format: "SRT",
        expiresAt: 1_800_000_000_000,
      },
    },
    {
      format: "LRC",
      status: "failed",
      errorCode: "output_write_failed",
    },
  ];
}

function completedTaskSummary(): Mutable<LocalSubtitleTaskSummary> {
  const artifactResults = completedArtifactResults();
  const terminal = resolveLocalSubtitleTerminalOutcome({
    requestedFormats: ["SRT", "LRC"],
    artifactResults,
  });
  if (!terminal.ok || terminal.status !== "completed") {
    throw new Error("invalid completion fixture");
  }

  return {
    ...validTaskSummary(),
    status: "completed",
    progress: {
      stage: "exporting",
      stageProgress: 100,
      overallProgress: 100,
    },
    artifactResults,
    completion: terminal.completion,
  } as Mutable<LocalSubtitleTaskSummary>;
}

function validBatchSummary(): LocalSubtitleBatchSummary {
  return {
    batchId: "batch-1",
    status: "queued",
    config: {
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      devicePreference: "auto",
      resolvedBackend: "metal",
      language: "auto",
      taskMode: "transcribe",
      vadEnabled: true,
      outputFormats: ["SRT", "LRC"],
      outputMode: "source",
      conflictPolicy: "index",
      postActionMode: "export_only",
    },
    tasks: [validTaskSummary()],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function validSessionSnapshot() {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    revision: 6,
    batches: [validBatchSummary()],
    resourceJobs: [],
  };
}

function validInternalOperationRequests(): Record<
  LocalSubtitlePreloadInternalChannel,
  unknown
> {
  return {
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession]: {},
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles]: {
      files: [{ filePath: "/private/sample.wav" }],
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile]: {
      fileToken: "file-token-1",
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory]: {},
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory]: {
      outputDirToken: "output-token-1",
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel]: {
      filePath: "/private/model.bin",
      mode: "copy",
      modelId: "large-v3-q5_0",
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.recoverOverwrite]: {
      recoveryId: "recovery-1",
    },
  };
}

function validInternalOperationResults(): Record<
  LocalSubtitlePreloadInternalChannel,
  unknown
> {
  return {
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession]: {
      ownerSessionId: "owner_session_1234567890",
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles]: [
      validAuthorizedMedia(),
    ],
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile]: {
      revoked: true,
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory]: {
      cancelled: false,
      outputDirToken: "output-token-1",
      displayLabel: "Exports",
      expiresAt: Date.parse(NOW) + 60_000,
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory]: {
      revoked: true,
    },
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel]: validResourceJob(),
    [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.recoverOverwrite]: {
      status: "recovered",
      outcome: "rolled_back",
    },
  };
}

function validPublicOperationRequests(): Record<
  LocalSubtitlePublicInvokeChannel,
  unknown
> {
  return {
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia]: {
      fileToken: "file-token-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeRuntime]: {},
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.previewBackend]: {
      modelId: "model-1",
      devicePreference: "auto",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources]: {},
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall]: {
      resourceId: "model-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob]: {
      jobId: "resource-job-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource]: {
      resourceId: "model-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot]: {},
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue]: validEnqueueRequest(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTask]: { taskId: "task-1" },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTaskOnCpu]: {
      taskId: "task-1",
      generation: 1,
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelBatch]: {
      batchId: "batch-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: { taskId: "task-1" },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask]: { taskId: "task-1" },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.completePostAction]: {
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
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText]: {
      artifactRef: "artifact-ref-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact]: {
      artifactRef: "artifact-ref-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact]: {
      artifactRef: "artifact-ref-1",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listOverwriteRecoveries]: {
      limit: 25,
    },
  };
}

function validPublicOperationResults(): Record<
  LocalSubtitlePublicInvokeChannel,
  unknown
> {
  return {
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia]:
      validMediaProbeSummary(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeRuntime]: validRuntimeSummary(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.previewBackend]: {
      devicePreference: "auto",
      resolvedBackend: "cpu",
      modelId: "model-1",
      serverArtifactId: "whisper-server-cpu",
      serverVersion: "1.9.1+b1ade71",
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources]: [
      validManagedResource(),
    ],
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall]:
      validResourceJob(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob]: {
      cancelled: true,
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource]: {
      deleted: true,
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot]:
      validSessionSnapshot(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue]: validBatchSummary(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTask]: validTaskSummary(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTaskOnCpu]: validTaskSummary(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelBatch]: {
      cancelledTaskIds: ["task-1"],
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: { cancelled: true },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask]: { removed: true },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.completePostAction]:
      validTaskSummary(),
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText]: {
      format: "SRT",
      rawText: "1\n00:00:01,000 --> 00:00:02,000\nsample\n",
      plainText: "sample",
      cueCount: 1,
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact]: {
      revealed: true,
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact]: {
      translationImportToken: "translation-import-token-1",
      expiresAt: Date.parse(NOW) + 60_000,
    },
    [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listOverwriteRecoveries]: {
      status: "ready",
      items: [],
    },
  };
}

function validAuthorizedMedia() {
  return {
    fileToken: "file-token-1",
    sourceKey: "source-key-1",
    displayName: "sample.wav",
    byteSize: 1024,
    expiresAt: Date.parse(NOW) + 60_000,
  };
}

function validMediaProbeSummary() {
  return {
    fileToken: "file-token-1",
    displayName: "sample.wav",
    durationMs: 60_000,
    audioTracks: [
      {
        streamId: "stream-1",
        ordinal: 1,
        isDefault: true,
        language: "ja",
        title: "Main audio",
        codec: "aac",
        channels: 2,
        sampleRateHz: 48_000,
      },
    ],
    autoSelectedStreamId: "stream-1",
  };
}

function validRuntimeSummary() {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    platform: "darwin",
    arch: "arm64",
    runtimeGeneration: SHA,
    runner: {
      status: "ready",
      version: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
    },
    mediaRuntime: { status: "ready", version: "8.1.2" },
    backends: [
      { backend: "metal", status: "available" },
      { backend: "cpu", status: "available" },
    ],
  };
}

function validManagedResource() {
  return {
    resourceId: "model-1",
    resourceType: "model",
    displayName: "Large v3 Q5",
    status: "ready",
    version: "1",
    modelFormat: "ggml",
    quantization: "q5_0",
    byteSize: 1_081_140_203,
    isDefault: true,
    compatibleBackends: ["cpu", "metal"],
  };
}

function validResourceJob() {
  return {
    jobId: "resource-job-1",
    resourceId: "model-1",
    resourceType: "model",
    status: "queued",
    progress: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function validTranscript(): Mutable<LocalSubtitleTranscript> {
  return {
    schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
    source: { displayName: "sample.wav", durationMs: 60_000 },
    model: {
      engine: "whisper_cpp",
      modelId: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
      modelHash: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
      backend: "metal",
    },
    detectedLanguage: "ja",
    languageProbability: 0.98,
    segments: [
      {
        id: "segment-1",
        startMs: 1000,
        endMs: 2000,
        text: "sample",
        estimatedTiming: true,
        confidence: 0.9,
      },
    ],
  } as Mutable<LocalSubtitleTranscript>;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Array<Mutable<U>>
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};
