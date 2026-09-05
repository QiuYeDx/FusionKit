import { describe, expect, it } from "vitest";
import productionDecision from "../../docs/v0.2.11/local-subtitle-transcriber/poc/pre006-production-decision.json";
import {
  LOCAL_SUBTITLE_ERROR_CODES,
  LOCAL_SUBTITLE_ERROR_MANIFEST,
  LOCAL_SUBTITLE_ERROR_SCOPES,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_OPERATION_STAGES,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  LOCAL_SUBTITLE_TASK_STATUSES,
  LOCAL_SUBTITLE_TASK_TRANSITIONS,
  LOCAL_SUBTITLE_WARNING_CODES,
  canTransitionLocalSubtitleTaskStatus,
  classifyLocalSubtitleTaskEvent,
  createLocalSubtitleBatchConfigSnapshot,
  createLocalSubtitleError,
  deriveLocalSubtitleBatchStatus,
  isLocalSubtitleErrorCode,
  resolveLocalSubtitleTerminalOutcome,
  transitionLocalSubtitleTaskState,
  type LocalSubtitleArtifactResult,
  type LocalSubtitleBatchConfigSnapshot,
  type LocalSubtitleErrorCode,
  type LocalSubtitleFormat,
  type LocalSubtitleTaskState,
  type LocalSubtitleTaskStatus,
} from "@/type/localSubtitle";

const EXPECTED_ERROR_CODES = [
  "invalid_ipc_request",
  "owner_released",
  "authorization_expired",
  "unsupported_platform",
  "unsupported_architecture",
  "runtime_missing",
  "runtime_protocol_mismatch",
  "runtime_crashed",
  "runtime_unresponsive",
  "media_runtime_missing",
  "media_runtime_invalid",
  "media_runtime_launch_failed",
  "accelerator_unavailable",
  "backend_mismatch",
  "backend_unverified",
  "model_missing",
  "model_incompatible",
  "model_corrupt",
  "model_download_failed",
  "model_disk_full",
  "resource_not_allowed",
  "resource_busy",
  "resource_signature_invalid",
  "limit_exceeded",
  "insufficient_disk",
  "media_probe_failed",
  "no_audio_stream",
  "media_changed",
  "media_decode_failed",
  "unsupported_media",
  "no_speech_detected",
  "transcription_failed",
  "transcript_quality_failed",
  "out_of_memory",
  "output_conflict",
  "output_write_failed",
  "cleanup_failed",
  "cancel_failed",
  "cancelled_after_partial_commit",
  "artifact_expired",
  "artifact_changed",
  "content_too_large",
  "invalid_content",
  "configuration_not_ready",
  "configuration_required",
  "directory_authorization_required",
  "profile_required",
  "profile_unavailable",
  "duplicate",
  "unsupported_format",
  "import_failed",
  "estimate_failed",
  "start_rejected",
] as const satisfies readonly LocalSubtitleErrorCode[];

const EXPECTED_TRANSITIONS = {
  queued: ["preparing_media", "cancelling", "failed"],
  preparing_media: ["loading_model", "transcribing", "cancelling", "failed"],
  loading_model: ["transcribing", "cancelling", "failed"],
  transcribing: ["post_processing", "cancelling", "failed"],
  post_processing: ["exporting", "cancelling", "failed"],
  exporting: ["completed", "cancelling", "failed"],
  completed: [],
  cancelling: ["completed", "cancelled", "failed"],
  cancelled: [],
  failed: [],
} as const satisfies Record<
  LocalSubtitleTaskStatus,
  readonly LocalSubtitleTaskStatus[]
>;

describe("local subtitle production contract", () => {
  it("stays aligned with the PRE-006 production decision record", () => {
    const decisions = productionDecision.decisions;
    const launchModel = decisions.modelAndVadManifest.launchModels.find(
      (model) => model.defaultRecommended,
    );

    expect(productionDecision.status).toBe("go");
    expect(productionDecision.openPreBlockers).toEqual([]);
    expect(launchModel).toBeDefined();
    expect(LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION).toBe(
      decisions.engineRuntime.httpContract.version,
    );
    expect(LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION).toBe(
      decisions.modelAndVadManifest.schemaVersion,
    );
    expect(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine).toEqual({
      id: decisions.engineRuntime.engine.id.replace(".", "_"),
      version: decisions.engineRuntime.engine.version,
      commit: decisions.engineRuntime.engine.commit,
    });
    expect(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel).toEqual({
      id: launchModel?.id,
      sha256: launchModel?.sha256,
    });
    expect(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad).toEqual({
      id: decisions.modelAndVadManifest.vad.id,
      sha256: decisions.modelAndVadManifest.vad.sha256,
      tokenTimestamps:
        decisions.modelAndVadManifest.vad.tokenTimestampsAllowed,
      timelinePolicy:
        decisions.modelAndVadManifest.vad.timelinePolicy.replaceAll("-", "_"),
    });
    expect(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript).toMatchObject({
      pcmWindowMs:
        decisions.qualityPerformanceAndFootprint.transcriptStrategy.pcmWindowMs,
      overlapMs:
        decisions.qualityPerformanceAndFootprint.transcriptStrategy.overlapMs,
      maxRetryDepth:
        decisions.qualityPerformanceAndFootprint.transcriptStrategy
          .boundedRetryDepth,
      maxActiveNativeRequests:
        decisions.engineRuntime.httpContract.maxActiveRequests,
      privatePathEntropyBits:
        decisions.engineRuntime.httpContract.privatePathEntropyBits,
    });
  });
});

describe("local subtitle batch config snapshots", () => {
  it("copies and deeply freezes every nested configuration value", () => {
    const input = createMutableBatchConfig();
    const snapshot = createLocalSubtitleBatchConfigSnapshot(input);

    input.model.modelId = "mutated-model";
    input.inference.advanced.initialPrompt = "mutated prompt";
    input.inference.vad.enabled = false;
    (
      input.inference.rawQualityGate as unknown as { maxRetryDepth: number }
    ).maxRetryDepth = 0;
    if (
      input.output.mode !== "custom" ||
      input.postAction.mode === "export_only"
    ) {
      throw new Error("Expected custom output with translation handoff");
    }
    input.output.formats.push("LRC");
    input.output.directoryLeaseRef = "mutated-directory";
    input.postAction.preferredFormat = "LRC";

    expect(snapshot).toMatchObject({
      model: { modelId: "large-v3-q5_0" },
      inference: {
        cuePolicy: "sentence_readable_v2",
        advanced: { initialPrompt: "keep this prompt" },
        vad: { enabled: true },
        rawQualityGate: { maxRetryDepth: 3 },
      },
      output: {
        formats: ["SRT"],
        directoryLeaseRef: "directory-lease-1",
      },
      postAction: { preferredFormat: "SRT" },
    });
    expectDeeplyFrozen(snapshot);
  });

  it("copies the source-output and export-only union branches", () => {
    const input = createMutableBatchConfig();
    input.output = {
      mode: "source",
      formats: ["SRT", "LRC"],
      conflictPolicy: "overwrite",
    };
    input.postAction = { mode: "export_only" };

    const snapshot = createLocalSubtitleBatchConfigSnapshot(input);
    input.output.formats.pop();

    expect(snapshot.output).toEqual({
      mode: "source",
      formats: ["SRT", "LRC"],
      conflictPolicy: "overwrite",
    });
    expect(snapshot.postAction).toEqual({ mode: "export_only" });
    expectDeeplyFrozen(snapshot);
  });
});

describe("local subtitle task transitions", () => {
  it("implements the complete allowed and rejected transition matrix", () => {
    expect(LOCAL_SUBTITLE_TASK_TRANSITIONS).toEqual(EXPECTED_TRANSITIONS);

    for (const from of LOCAL_SUBTITLE_TASK_STATUSES) {
      for (const to of LOCAL_SUBTITLE_TASK_STATUSES) {
        expect(
          canTransitionLocalSubtitleTaskStatus(from, to),
          `${from} -> ${to}`,
        ).toBe(EXPECTED_TRANSITIONS[from].includes(to as never));
      }
    }
  });

  it("rejects transitions out of terminal states and other disallowed jumps", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      expect(
        transitionLocalSubtitleTaskState(
          taskState(status),
          "queued",
          transitionContext(),
        ),
      ).toEqual({ ok: false, reason: "transition_not_allowed" });
    }

    expect(
      transitionLocalSubtitleTaskState(
        taskState("queued"),
        "completed",
        transitionContext({ artifactResults: [committed("SRT")] }),
      ),
    ).toEqual({ ok: false, reason: "transition_not_allowed" });
  });

  it("accepts non-terminal transitions while replacing and freezing results", () => {
    const transition = transitionLocalSubtitleTaskState(
      taskState("queued"),
      "preparing_media",
      transitionContext(),
    );

    expect(transition).toEqual({
      ok: true,
      state: { status: "preparing_media", artifactResults: [] },
    });
    if (!transition.ok) return;
    expectDeeplyFrozen(transition.state);

    expect(
      transitionLocalSubtitleTaskState(
        taskState("queued"),
        "preparing_media",
        transitionContext({ artifactResults: [failed("SRT")] }),
      ),
    ).toEqual({ ok: false, reason: "artifact_results_invalid" });
  });

  it("allows exporting to complete only with a valid completion", () => {
    const artifactResults = [committed("SRT"), committed("LRC")];
    const transition = transitionLocalSubtitleTaskState(
      taskState("exporting"),
      "completed",
      transitionContext({
        requestedFormats: ["SRT", "LRC"],
        artifactResults,
      }),
    );

    expect(transition).toMatchObject({
      ok: true,
      state: {
        status: "completed",
        artifactResults,
        completion: { outcome: "full", artifacts: artifactResults },
      },
    });
    if (!transition.ok) return;
    expectDeeplyFrozen(transition.state);

    expect(
      transitionLocalSubtitleTaskState(
        taskState("exporting"),
        "completed",
        transitionContext({
          requestedFormats: ["SRT", "LRC"],
          artifactResults: [committed("SRT")],
        }),
      ),
    ).toEqual({ ok: false, reason: "terminal_outcome_invalid" });
  });

  it("lets a cancelling task preserve either a full or partial committed result", () => {
    const partial = transitionLocalSubtitleTaskState(
      taskState("cancelling"),
      "completed",
      transitionContext({
        requestedFormats: ["SRT", "LRC"],
        artifactResults: [
          committed("SRT"),
          skipped("LRC", "cancelled_after_partial_commit"),
        ],
      }),
    );

    expect(partial).toMatchObject({
      ok: true,
      state: {
        status: "completed",
        completion: {
          outcome: "partial",
          warnings: ["cancelled_after_partial_commit"],
        },
      },
    });

    const full = transitionLocalSubtitleTaskState(
      taskState("cancelling"),
      "completed",
      transitionContext({
        artifactResults: [committed("SRT")],
      }),
    );
    expect(full).toMatchObject({
      ok: true,
      state: {
        status: "completed",
        completion: { outcome: "full", warnings: [] },
      },
    });
    if (full.ok) expectDeeplyFrozen(full.state);
    expect(
      transitionLocalSubtitleTaskState(
        taskState("cancelling"),
        "completed",
        transitionContext({ artifactResults: [skipped("SRT")] }),
      ),
    ).toEqual({ ok: false, reason: "terminal_status_mismatch" });
  });

  it("lets an explicit ordinary completion override a late cancelling state", () => {
    const transition = transitionLocalSubtitleTaskState(
      taskState("cancelling"),
      "completed",
      transitionContext({
        requestedFormats: ["SRT", "LRC"],
        artifactResults: [
          committed("SRT"),
          failed("LRC", "output_write_failed"),
        ],
        cancellationRequested: false,
      }),
    );

    expect(transition).toMatchObject({
      ok: true,
      state: {
        status: "completed",
        completion: { outcome: "partial", warnings: [] },
      },
    });
    if (transition.ok) expectDeeplyFrozen(transition.state);
  });

  it("guards cancelled and failed terminal state invariants", () => {
    expect(
      transitionLocalSubtitleTaskState(
        taskState("cancelling"),
        "cancelled",
        transitionContext({ artifactResults: [committed("SRT")] }),
      ),
    ).toEqual({ ok: false, reason: "terminal_status_mismatch" });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("transcribing"),
        "failed",
        transitionContext(),
      ),
    ).toEqual({ ok: false, reason: "failure_error_required" });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("exporting"),
        "failed",
        transitionContext({
          artifactResults: [committed("SRT")],
          error: createLocalSubtitleError("output_write_failed", "failed"),
        }),
      ),
    ).toEqual({ ok: false, reason: "terminal_status_mismatch" });

    const error = createLocalSubtitleError(
      "transcription_failed",
      "runtime rejected inference",
    );
    expect(
      transitionLocalSubtitleTaskState(
        taskState("exporting"),
        "failed",
        transitionContext({
          artifactResults: [
            skipped("SRT", "cancelled_after_partial_commit"),
          ],
          error,
        }),
      ),
    ).toEqual({ ok: false, reason: "terminal_outcome_invalid" });

    const cancelError = createLocalSubtitleError(
      "cancel_failed",
      "partial cleanup failed",
    );
    expect(
      transitionLocalSubtitleTaskState(
        taskState("exporting"),
        "failed",
        transitionContext({
          artifactResults: [failed("SRT", "cancel_failed")],
          error: cancelError,
        }),
      ),
    ).toEqual({ ok: false, reason: "terminal_outcome_invalid" });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("exporting"),
        "failed",
        transitionContext({
          artifactResults: [failed("SRT", "cancel_failed")],
          cancellationRequested: true,
          error: cancelError,
        }),
      ),
    ).toEqual({
      ok: true,
      state: {
        status: "failed",
        artifactResults: [failed("SRT", "cancel_failed")],
        error: cancelError,
      },
    });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("cancelling"),
        "failed",
        transitionContext({
          artifactResults: [failed("SRT", "cancel_failed")],
          error: cancelError,
        }),
      ),
    ).toEqual({
      ok: true,
      state: {
        status: "failed",
        artifactResults: [failed("SRT", "cancel_failed")],
        error: cancelError,
      },
    });

    const failedTransition = transitionLocalSubtitleTaskState(
      taskState("transcribing"),
      "failed",
      transitionContext({ error }),
    );
    expect(failedTransition).toEqual({
      ok: true,
      state: {
        status: "failed",
        artifactResults: [],
        error,
      },
    });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("exporting"),
        "failed",
        transitionContext({ artifactResults: [failed("SRT")], error }),
      ),
    ).toEqual({
      ok: true,
      state: {
        status: "failed",
        artifactResults: [failed("SRT")],
        error,
      },
    });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("cancelling"),
        "cancelled",
        transitionContext({
          requestedFormats: ["SRT"],
          artifactResults: [skipped("LRC")],
        }),
      ),
    ).toEqual({ ok: false, reason: "artifact_results_invalid" });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("cancelling"),
        "cancelled",
        transitionContext({
          artifactResults: [
            skipped("SRT", "cancelled_after_partial_commit"),
          ],
        }),
      ),
    ).toEqual({ ok: false, reason: "terminal_outcome_invalid" });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("cancelling"),
        "cancelled",
        transitionContext({
          artifactResults: [failed("SRT", "cancel_failed")],
        }),
      ),
    ).toEqual({ ok: false, reason: "terminal_status_mismatch" });

    expect(
      transitionLocalSubtitleTaskState(
        taskState("cancelling"),
        "cancelled",
        transitionContext({
          requestedFormats: ["SRT", "LRC"],
          artifactResults: [failed("SRT"), skipped("LRC")],
        }),
      ),
    ).toEqual({
      ok: true,
      state: {
        status: "cancelled",
        artifactResults: [failed("SRT"), skipped("LRC")],
      },
    });
  });
});

describe("local subtitle terminal outcomes", () => {
  it("resolves all committed requested formats as full completion", () => {
    const artifactResults = [committed("SRT"), committed("LRC")];
    const result = resolveLocalSubtitleTerminalOutcome({
      requestedFormats: ["SRT", "LRC"],
      artifactResults,
    });

    expect(result).toEqual({
      ok: true,
      status: "completed",
      completion: {
        outcome: "full",
        artifacts: artifactResults,
        warnings: [],
      },
    });
    if (!result.ok || result.status !== "completed") return;
    expect(result.completion.artifacts).not.toBe(artifactResults);
    expectDeeplyFrozen(result.completion);
  });

  it("resolves mixed artifact results as partial without rolling back commits", () => {
    const committedArtifact = committed("SRT");
    const failedArtifact = failed("LRC");
    const result = resolveLocalSubtitleTerminalOutcome({
      requestedFormats: ["SRT", "LRC"],
      artifactResults: [committedArtifact, failedArtifact],
    });

    expect(result).toEqual({
      ok: true,
      status: "completed",
      completion: {
        outcome: "partial",
        artifacts: [committedArtifact, failedArtifact],
        warnings: [],
      },
    });
  });

  it("fails when no artifact committed and at least one artifact failed", () => {
    expect(
      resolveLocalSubtitleTerminalOutcome({
        requestedFormats: ["SRT", "LRC"],
        artifactResults: [
          failed("SRT", "output_write_failed"),
          failed("LRC", "output_conflict"),
        ],
      }),
    ).toEqual({ ok: true, status: "failed" });
  });

  it("cancels before the first commit and completes partial after a commit", () => {
    expect(
      resolveLocalSubtitleTerminalOutcome({
        requestedFormats: ["SRT", "LRC"],
        artifactResults: [skipped("SRT"), skipped("LRC")],
        cancellationRequested: true,
      }),
    ).toEqual({ ok: true, status: "cancelled" });

    const partial = resolveLocalSubtitleTerminalOutcome({
      requestedFormats: ["SRT", "LRC"],
      artifactResults: [
        committed("SRT"),
        skipped("LRC", "cancelled_after_partial_commit"),
      ],
      cancellationRequested: true,
    });
    expect(partial).toMatchObject({
      ok: true,
      status: "completed",
      completion: {
        outcome: "partial",
        warnings: ["cancelled_after_partial_commit"],
      },
    });

    expect(
      resolveLocalSubtitleTerminalOutcome({
        requestedFormats: ["SRT"],
        artifactResults: [failed("SRT", "cancel_failed")],
        cancellationRequested: true,
      }),
    ).toEqual({ ok: true, status: "failed" });

    expect(
      resolveLocalSubtitleTerminalOutcome({
        requestedFormats: ["SRT", "LRC"],
        artifactResults: [
          committed("SRT"),
          failed("LRC", "cancel_failed"),
        ],
        cancellationRequested: true,
      }),
    ).toMatchObject({
      ok: true,
      status: "completed",
      completion: {
        outcome: "partial",
        warnings: ["cancelled_after_partial_commit"],
      },
    });
  });

  it.each([
    {
      name: "no requested formats",
      requestedFormats: [] as LocalSubtitleFormat[],
      artifactResults: [] as LocalSubtitleArtifactResult[],
      expected: { ok: false, reason: "no_requested_formats" },
    },
    {
      name: "duplicate requested format",
      requestedFormats: ["SRT", "SRT"] as LocalSubtitleFormat[],
      artifactResults: [committed("SRT")],
      expected: {
        ok: false,
        reason: "duplicate_requested_format",
        format: "SRT",
      },
    },
    {
      name: "unexpected result format",
      requestedFormats: ["SRT"] as LocalSubtitleFormat[],
      artifactResults: [committed("LRC")],
      expected: {
        ok: false,
        reason: "unexpected_artifact_format",
        format: "LRC",
      },
    },
    {
      name: "duplicate result",
      requestedFormats: ["SRT"] as LocalSubtitleFormat[],
      artifactResults: [committed("SRT"), failed("SRT")],
      expected: {
        ok: false,
        reason: "duplicate_artifact_result",
        format: "SRT",
      },
    },
    {
      name: "incomplete results",
      requestedFormats: ["SRT", "LRC"] as LocalSubtitleFormat[],
      artifactResults: [committed("SRT")],
      expected: { ok: false, reason: "incomplete_artifact_results" },
    },
    {
      name: "mismatched committed artifact format",
      requestedFormats: ["SRT"] as LocalSubtitleFormat[],
      artifactResults: [committed("SRT", "LRC")],
      expected: {
        ok: false,
        reason: "committed_artifact_format_mismatch",
        format: "SRT",
      },
    },
    {
      name: "all skipped without cancellation",
      requestedFormats: ["SRT"] as LocalSubtitleFormat[],
      artifactResults: [skipped("SRT")],
      expected: { ok: false, reason: "no_failed_artifact" },
    },
    {
      name: "partial cancellation without a skipped marker",
      requestedFormats: ["SRT", "LRC"] as LocalSubtitleFormat[],
      artifactResults: [committed("SRT"), skipped("LRC")],
      cancellationRequested: true,
      expected: { ok: false, reason: "cancellation_marker_missing" },
    },
    {
      name: "cancellation marker without cancellation",
      requestedFormats: ["SRT", "LRC"] as LocalSubtitleFormat[],
      artifactResults: [
        committed("SRT"),
        skipped("LRC", "cancelled_after_partial_commit"),
      ],
      cancellationRequested: false,
      expected: { ok: false, reason: "unexpected_cancellation_marker" },
    },
    {
      name: "cancellation cleanup failure without cancellation",
      requestedFormats: ["SRT"] as LocalSubtitleFormat[],
      artifactResults: [failed("SRT", "cancel_failed")],
      cancellationRequested: false,
      expected: {
        ok: false,
        reason: "unexpected_cancellation_cleanup_failure",
      },
    },
    {
      name: "partial cleanup failure without cancellation",
      requestedFormats: ["SRT", "LRC"] as LocalSubtitleFormat[],
      artifactResults: [committed("SRT"), failed("LRC", "cancel_failed")],
      cancellationRequested: false,
      expected: {
        ok: false,
        reason: "unexpected_cancellation_cleanup_failure",
      },
    },
    {
      name: "partial-commit marker without a committed artifact",
      requestedFormats: ["SRT"] as LocalSubtitleFormat[],
      artifactResults: [
        skipped("SRT", "cancelled_after_partial_commit"),
      ],
      cancellationRequested: true,
      expected: { ok: false, reason: "cancellation_marker_without_commit" },
    },
  ])("rejects invalid completion input: $name", (testCase) => {
    expect(
      resolveLocalSubtitleTerminalOutcome({
        requestedFormats: testCase.requestedFormats,
        artifactResults: testCase.artifactResults,
        cancellationRequested: testCase.cancellationRequested,
      }),
    ).toEqual(testCase.expected);
  });
});

describe("local subtitle error manifest", () => {
  it("exposes the exact version-one error code manifest", () => {
    expect(LOCAL_SUBTITLE_ERROR_CODES).toEqual(EXPECTED_ERROR_CODES);
    expect(Object.keys(LOCAL_SUBTITLE_ERROR_MANIFEST)).toEqual(
      EXPECTED_ERROR_CODES,
    );
    expect(LOCAL_SUBTITLE_WARNING_CODES).toEqual([
      "cancelled_after_partial_commit",
    ]);

    for (const code of EXPECTED_ERROR_CODES) {
      const definition = LOCAL_SUBTITLE_ERROR_MANIFEST[code];
      expect(LOCAL_SUBTITLE_ERROR_SCOPES).toContain(definition.scope);
      expect(LOCAL_SUBTITLE_OPERATION_STAGES).toContain(definition.defaultStage);
      expect(Object.isFrozen(definition), code).toBe(true);
      expect(isLocalSubtitleErrorCode(code), code).toBe(true);
    }
    expect(isLocalSubtitleErrorCode("audio:transcription_failed")).toBe(false);
    expect(isLocalSubtitleErrorCode(null)).toBe(false);
  });

  it("keeps preflight, task, cancellation, artifact, and handoff codes stable", () => {
    expect(LOCAL_SUBTITLE_ERROR_MANIFEST).toMatchObject({
      invalid_ipc_request: {
        scope: "request",
        defaultStage: "ipc",
        retryable: false,
        blocksBatchCommit: true,
      },
      media_runtime_missing: {
        scope: "batch",
        defaultStage: "preflight",
        retryable: true,
        blocksBatchCommit: true,
      },
      media_runtime_invalid: {
        scope: "batch",
        defaultStage: "preflight",
        retryable: true,
        blocksBatchCommit: true,
      },
      media_runtime_launch_failed: {
        scope: "batch",
        defaultStage: "preflight",
        retryable: true,
        blocksBatchCommit: true,
      },
      backend_mismatch: {
        scope: "batch",
        defaultStage: "preflight",
        retryable: false,
        blocksBatchCommit: true,
      },
      backend_unverified: {
        scope: "batch",
        defaultStage: "preflight",
        retryable: true,
        blocksBatchCommit: true,
      },
      transcription_failed: {
        scope: "task",
        defaultStage: "transcribing",
        retryable: true,
        blocksBatchCommit: false,
      },
      transcript_quality_failed: {
        scope: "task",
        defaultStage: "post_processing",
        retryable: true,
        blocksBatchCommit: false,
      },
      cancelled_after_partial_commit: {
        scope: "task",
        defaultStage: "exporting",
        retryable: false,
        blocksBatchCommit: false,
      },
      artifact_expired: {
        scope: "artifact",
        defaultStage: "artifact",
        retryable: true,
        blocksBatchCommit: false,
      },
      artifact_changed: {
        scope: "artifact",
        defaultStage: "artifact",
        retryable: false,
        blocksBatchCommit: false,
      },
      start_rejected: {
        scope: "handoff",
        defaultStage: "handoff",
        retryable: true,
        blocksBatchCommit: false,
      },
    });
  });

  it("creates immutable errors from manifest defaults and controlled overrides", () => {
    const lines = ["sanitized stderr"];
    const metadata = { attempt: 1 };
    const error = createLocalSubtitleError(
      "media_runtime_launch_failed",
      "Could not start bundled FFmpeg",
      {
        stage: "preparing_media",
        field: "mediaRef",
        causeCode: "media_runtime_invalid",
        details: { lines, metadata, truncated: false },
      },
    );

    lines[0] = "mutated input";
    metadata.attempt = 2;

    expect(error).toMatchObject({
      code: "media_runtime_launch_failed",
      message: "Could not start bundled FFmpeg",
      stage: "preparing_media",
      retryable: true,
      field: "mediaRef",
      causeCode: "media_runtime_invalid",
      details: {
        lines: ["sanitized stderr"],
        metadata: { attempt: 1 },
        truncated: false,
      },
    });
    expectDeeplyFrozen(error);
  });
});

describe("local subtitle batch status derivation", () => {
  it.each([
    { statuses: [] as LocalSubtitleTaskStatus[], expected: "queued" },
    { statuses: ["queued"] as LocalSubtitleTaskStatus[], expected: "queued" },
    {
      statuses: ["queued", "transcribing"] as LocalSubtitleTaskStatus[],
      expected: "running",
    },
    {
      statuses: ["transcribing", "cancelling"] as LocalSubtitleTaskStatus[],
      expected: "cancelling",
    },
    {
      statuses: ["completed", "failed"] as LocalSubtitleTaskStatus[],
      expected: "completed",
    },
    {
      statuses: ["cancelled", "cancelled"] as LocalSubtitleTaskStatus[],
      expected: "cancelled",
    },
    {
      statuses: ["failed", "cancelled"] as LocalSubtitleTaskStatus[],
      expected: "failed",
    },
  ])("derives $expected from $statuses", ({ statuses, expected }) => {
    expect(
      deriveLocalSubtitleBatchStatus(
        statuses.map((status) => ({ status })),
      ),
    ).toBe(expected);
  });
});

describe("local subtitle event classification", () => {
  it.each([
    {
      name: "duplicate revision",
      cursor: { revision: 7, generation: 3 },
      event: { revision: 7, generation: 3 },
      expected: {
        action: "ignore",
        needsSnapshot: false,
        advanceRevision: false,
        reason: "duplicate_revision",
      },
    },
    {
      name: "stale revision",
      cursor: { revision: 7, generation: 3 },
      event: { revision: 6, generation: 3 },
      expected: {
        action: "ignore",
        needsSnapshot: false,
        advanceRevision: false,
        reason: "stale_revision",
      },
    },
    {
      name: "stale generation with next revision",
      cursor: { revision: 7, generation: 3 },
      event: { revision: 8, generation: 2 },
      expected: {
        action: "ignore",
        needsSnapshot: false,
        advanceRevision: true,
        reason: "stale_generation",
      },
    },
    {
      name: "stale generation with revision gap",
      cursor: { revision: 7, generation: 3 },
      event: { revision: 10, generation: 2 },
      expected: {
        action: "ignore",
        needsSnapshot: true,
        advanceRevision: false,
        reason: "revision_gap",
      },
    },
    {
      name: "revision gap",
      cursor: { revision: 7, generation: 3 },
      event: { revision: 9, generation: 3 },
      expected: {
        action: "apply",
        needsSnapshot: true,
        advanceRevision: true,
        reason: "revision_gap",
      },
    },
    {
      name: "next revision",
      cursor: { revision: 7, generation: 3 },
      event: { revision: 8, generation: 3 },
      expected: {
        action: "apply",
        needsSnapshot: false,
        advanceRevision: true,
      },
    },
    {
      name: "new generation",
      cursor: { revision: 7, generation: 3 },
      event: { revision: 8, generation: 4 },
      expected: {
        action: "apply",
        needsSnapshot: false,
        advanceRevision: true,
      },
    },
    {
      name: "cursor without task generation",
      cursor: { revision: 7 },
      event: { revision: 8, generation: 1 },
      expected: {
        action: "apply",
        needsSnapshot: false,
        advanceRevision: true,
      },
    },
  ])("classifies $name", ({ cursor, event, expected }) => {
    expect(classifyLocalSubtitleTaskEvent(cursor, event)).toEqual(expected);
  });
});

function createMutableBatchConfig(): MutableBatchConfig {
  return {
    schemaVersion: 1,
    serverHttpContractVersion: 1,
    snapshotId: "snapshot-1",
    createdAt: "2026-07-21T00:00:00.000Z",
    model: {
      engine: "whisper_cpp",
      engineVersion: "v1.9.1",
      engineCommit: "f049fff95a089aa9969deb009cdd4892b3e74916",
      modelManifestVersion: 1,
      modelId: "large-v3-q5_0",
      modelHash:
        "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
    },
    devicePreference: "auto",
    resolvedBackend: "metal",
    language: "auto",
    taskMode: "transcribe",
    inference: {
      advanced: {
        initialPrompt: "keep this prompt",
        beamSize: 5,
        temperature: 0,
        vadMinSilenceMs: 500,
        maxCueDurationMs: 7_000,
        maxCueChars: 84,
        maxLineChars: 42,
      },
      vad: {
        enabled: true,
        modelId: "silero-vad-v6.2.0-ggml",
        tokenTimestamps: false,
        timelinePolicy: "mapped_segment_timestamps_only",
      },
      rawQualityGate: {
        maxSegmentDurationMs: 15_000,
        repeatedCueThreshold: 8,
        repeatedCoverageMs: 15_000,
        maxRetryDepth: 3,
      },
    },
    output: {
      mode: "custom",
      formats: ["SRT"],
      conflictPolicy: "index",
      directoryLeaseRef: "directory-lease-1",
      displayLabel: "Subtitles",
    },
    postAction: {
      mode: "enqueue_translation",
      preferredFormat: "SRT",
      translationSnapshotId: "translation-snapshot-1",
    },
  };
}

type MutableBatchConfig = {
  -readonly [Key in keyof LocalSubtitleBatchConfigSnapshot]: Mutable<
    LocalSubtitleBatchConfigSnapshot[Key]
  >;
};

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

function committed(
  format: LocalSubtitleFormat,
  artifactFormat: LocalSubtitleFormat = format,
): LocalSubtitleArtifactResult {
  return {
    format,
    status: "committed",
    artifact: {
      artifactRef: `artifact-${format.toLowerCase()}`,
      displayName: `episode.${format.toLowerCase()}`,
      format: artifactFormat,
      expiresAt: 1_800_000_000_000,
    },
  };
}

function failed(
  format: LocalSubtitleFormat,
  errorCode: LocalSubtitleErrorCode = "output_write_failed",
): LocalSubtitleArtifactResult {
  return { format, status: "failed", errorCode };
}

function skipped(
  format: LocalSubtitleFormat,
  errorCode?: LocalSubtitleErrorCode,
): LocalSubtitleArtifactResult {
  return {
    format,
    status: "skipped",
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function taskState(status: LocalSubtitleTaskStatus): LocalSubtitleTaskState {
  return { status, artifactResults: [] };
}

function transitionContext(
  overrides: Partial<
    Parameters<typeof transitionLocalSubtitleTaskState>[2]
  > = {},
): Parameters<typeof transitionLocalSubtitleTaskState>[2] {
  return { requestedFormats: ["SRT"], ...overrides };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;

  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeeplyFrozen(nested);
  }
}
