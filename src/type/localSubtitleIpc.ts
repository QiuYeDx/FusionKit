import { z } from "zod";
import {
  LOCAL_SUBTITLE_BACKENDS,
  LOCAL_SUBTITLE_BATCH_STATUSES,
  LOCAL_SUBTITLE_CONFLICT_POLICIES,
  LOCAL_SUBTITLE_DEVICE_PREFERENCES,
  LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS,
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  LOCAL_SUBTITLE_ENGINES,
  LOCAL_SUBTITLE_ERROR_CODES,
  LOCAL_SUBTITLE_ERROR_MANIFEST,
  LOCAL_SUBTITLE_FORMATS,
  LOCAL_SUBTITLE_HANDOFF_MODES,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_OPERATION_STAGES,
  LOCAL_SUBTITLE_OUTPUT_MODES,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_QUALITY_PRESETS,
  LOCAL_SUBTITLE_RESOURCE_JOB_STATUSES,
  LOCAL_SUBTITLE_RESOURCE_TYPES,
  LOCAL_SUBTITLE_TASK_MODES,
  LOCAL_SUBTITLE_TASK_STAGES,
  LOCAL_SUBTITLE_TASK_STATUSES,
  LOCAL_SUBTITLE_WARNING_CODES,
  SUBTITLE_TRANSLATION_IMPORT_STATUSES,
  SUBTITLE_TRANSLATION_START_FAILURE_REASONS,
  SUBTITLE_TRANSLATION_START_STATUSES,
  deriveLocalSubtitleBatchStatus,
  hasLocalSubtitleArtifactCancellationEvidence,
  resolveLocalSubtitleTerminalOutcome,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleError,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleResourceJobSummary,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskEventEnvelope,
  type LocalSubtitleTaskSummary,
  type LocalSubtitleTranscript,
} from "@/type/localSubtitle";

export type {
  LocalSubtitleResourceEventEnvelope,
  LocalSubtitleTaskEventEnvelope,
} from "@/type/localSubtitle";

export const LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS = {
  probeMedia: "local-subtitle:probe-media",
  probeRuntime: "local-subtitle:probe-runtime",
  listManagedResources: "local-subtitle:list-managed-resources",
  startResourceInstall: "local-subtitle:start-resource-install",
  cancelResourceJob: "local-subtitle:cancel-resource-job",
  deleteManagedResource: "local-subtitle:delete-managed-resource",
  getSessionSnapshot: "local-subtitle:get-session-snapshot",
  enqueue: "local-subtitle:enqueue",
  retryTask: "local-subtitle:retry-task",
  cancelBatch: "local-subtitle:cancel-batch",
  cancelTask: "local-subtitle:cancel-task",
  removeTask: "local-subtitle:remove-task",
  readArtifactText: "local-subtitle:read-artifact-text",
  revealArtifact: "local-subtitle:reveal-artifact",
  handoffArtifact: "local-subtitle:handoff-artifact",
} as const;

export const LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS = {
  registerOwnerSession: "local-subtitle:internal:register-owner-session",
  authorizeInputFiles: "local-subtitle:internal:authorize-input-files",
  revokeInputFile: "local-subtitle:internal:revoke-input-file",
  selectOutputDirectory: "local-subtitle:internal:select-output-directory",
  revokeOutputDirectory: "local-subtitle:internal:revoke-output-directory",
  importModel: "local-subtitle:internal:import-model",
} as const;

export const LOCAL_SUBTITLE_EVENT_CHANNELS = {
  taskEvent: "local-subtitle:task-event",
  resourceEvent: "local-subtitle:resource-event",
} as const;

export type LocalSubtitlePublicInvokeChannel =
  (typeof LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS)[keyof typeof LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS];
export type LocalSubtitlePreloadInternalChannel =
  (typeof LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS)[keyof typeof LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS];
export type LocalSubtitleEventChannel =
  (typeof LOCAL_SUBTITLE_EVENT_CHANNELS)[keyof typeof LOCAL_SUBTITLE_EVENT_CHANNELS];

export interface LocalSubtitleSecureIpcEnvelope<TPayload = unknown> {
  readonly ownerSessionId: string;
  readonly payload: TPayload;
}

export type LocalSubtitleIpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: LocalSubtitleError };

export function localSubtitleIpcSuccess<T>(
  data: T,
): LocalSubtitleIpcResult<T> {
  return { ok: true, data };
}

export function localSubtitleIpcFailure<T = never>(
  error: LocalSubtitleError,
): LocalSubtitleIpcResult<T> {
  return { ok: false, error };
}

export function localSubtitleIpcResultSchema<TSchema extends z.ZodTypeAny>(
  dataSchema: TSchema,
) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: localSubtitleErrorSchema }).strict(),
  ]);
}

const idSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxIdChars)
  .refine((value) => value.trim() === value, "Must not have outer whitespace.")
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..", "Must be an opaque id.");
const opaqueRefSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxOpaqueRefChars)
  .refine((value) => value.trim() === value, "Must not have outer whitespace.")
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..", "Must be an opaque ref.");
const ownerSessionIdSchema = z
  .string()
  .min(20)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const displayNameSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars)
  .refine((value) => value.trim().length > 0, "Must not be blank.")
  .refine(noUnsafeControlCharacters, "Contains an unsupported control character.")
  .refine(
    (value) => value !== "." && value !== ".." && !/[\\/]/u.test(value),
    "Must be a display leaf, not a path.",
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const safeIntegerSchema = z.number().int().safe();
const positiveSafeIntegerSchema = safeIntegerSchema.positive();
const nonNegativeSafeIntegerSchema = safeIntegerSchema.nonnegative();
const percentageSchema = z.number().finite().min(0).max(100);
const languageSchema = z
  .string()
  .min(2)
  .max(LOCAL_SUBTITLE_LIMITS.maxLanguageChars)
  .refine(
    (value) => value === "auto" || /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value),
    "Must be auto or a BCP-47-like language tag.",
  );

export function localSubtitleSecureIpcEnvelopeSchema<
  TSchema extends z.ZodTypeAny,
>(payloadSchema: TSchema) {
  return z
    .object({
      ownerSessionId: ownerSessionIdSchema,
      payload: payloadSchema,
    })
    .strict()
    .refine(
      (value) =>
        (serializedByteLength(value) ?? Number.POSITIVE_INFINITY) <=
        LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes,
      "Local subtitle secure IPC envelope exceeds the frame byte limit.",
    );
}

const diagnosticMetadataSchema = z
  .object(
    Object.fromEntries(
      LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS.map((key) => [
        key,
        z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]).optional(),
      ]),
    ) as Record<
      (typeof LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS)[number],
      z.ZodOptional<
        z.ZodUnion<
          [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
        >
      >
    >,
  )
  .strict();

export const localSubtitleDiagnosticsSchema = z
  .object({
    summary: z
      .string()
      .max(LOCAL_SUBTITLE_LIMITS.maxDiagnosticSummaryChars)
      .refine(noUnsafeControlCharacters)
      .optional(),
    lines: z
      .array(
        z
          .string()
          .max(LOCAL_SUBTITLE_LIMITS.maxDiagnosticLineChars)
          .refine(noUnsafeControlCharacters),
      )
      .max(LOCAL_SUBTITLE_LIMITS.maxDiagnosticLines)
      .optional(),
    metadata: diagnosticMetadataSchema.optional(),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      (serializedByteLength(value) ?? Number.POSITIVE_INFINITY) <=
      LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes,
    "Diagnostics exceed the byte limit.",
  );

export const localSubtitleErrorSchema = z
  .object({
    code: z.enum(LOCAL_SUBTITLE_ERROR_CODES),
    message: z
      .string()
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxDiagnosticSummaryChars)
      .refine(noUnsafeControlCharacters),
    stage: z.enum(LOCAL_SUBTITLE_OPERATION_STAGES),
    retryable: z.boolean(),
    field: z.string().min(1).max(256).optional(),
    details: localSubtitleDiagnosticsSchema.optional(),
    causeCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retryable !== LOCAL_SUBTITLE_ERROR_MANIFEST[value.code].retryable) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "retryable must match the versioned error manifest.",
      });
    }
  });

const modelSnapshotSchema = z
  .object({
    engine: z.enum(LOCAL_SUBTITLE_ENGINES),
    engineVersion: z.literal(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version),
    engineCommit: z.literal(LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit),
    modelManifestVersion: z.literal(LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION),
    modelId: idSchema,
    modelHash: sha256Schema,
  })
  .strict();

const artifactSummarySchema = z
  .object({
    artifactRef: opaqueRefSchema,
    displayName: displayNameSchema,
    format: z.enum(LOCAL_SUBTITLE_FORMATS),
    expiresAt: positiveSafeIntegerSchema,
  })
  .strict();

const artifactResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      format: z.enum(LOCAL_SUBTITLE_FORMATS),
      status: z.literal("committed"),
      artifact: artifactSummarySchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.format !== value.artifact.format) {
        context.addIssue({
          code: "custom",
          path: ["artifact", "format"],
          message: "Artifact format must match its result format.",
        });
      }
    }),
  z
    .object({
      format: z.enum(LOCAL_SUBTITLE_FORMATS),
      status: z.literal("failed"),
      errorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES),
    })
    .strict(),
  z
    .object({
      format: z.enum(LOCAL_SUBTITLE_FORMATS),
      status: z.literal("skipped"),
      errorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
    })
    .strict(),
]);

const completionResultSchema = z
  .object({
    outcome: z.enum(["full", "partial"]),
    artifacts: z.array(artifactResultSchema).min(1).max(LOCAL_SUBTITLE_FORMATS.length),
    warnings: z
      .array(z.enum(LOCAL_SUBTITLE_WARNING_CODES))
      .max(LOCAL_SUBTITLE_WARNING_CODES.length),
  })
  .strict()
  .superRefine((value, context) => {
    const formats = new Set(value.artifacts.map((artifact) => artifact.format));
    if (formats.size !== value.artifacts.length) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Artifact formats must be unique.",
      });
    }
    const committed = value.artifacts.filter(
      (artifact) => artifact.status === "committed",
    ).length;
    if (committed === 0) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "A completion result requires a committed artifact.",
      });
    }
    if (value.outcome === "full" && committed !== value.artifacts.length) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "A full outcome requires every artifact to be committed.",
      });
    }
    if (value.outcome === "partial" && committed === value.artifacts.length) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "A partial outcome requires at least one non-committed artifact.",
      });
    }
  });

const postActionStateSchema = z
  .object({
    mode: z.enum(LOCAL_SUBTITLE_HANDOFF_MODES),
    preferredFormat: z.enum(LOCAL_SUBTITLE_FORMATS).optional(),
    importStatus: z.enum(SUBTITLE_TRANSLATION_IMPORT_STATUSES),
    startStatus: z.enum(SUBTITLE_TRANSLATION_START_STATUSES),
    importReceiptId: idSchema.optional(),
    translationTaskId: idSchema.optional(),
    importErrorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
    startFailureReason: z
      .enum(SUBTITLE_TRANSLATION_START_FAILURE_REASONS)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const addIssue = (path: string, message: string) => {
      context.addIssue({ code: "custom", path: [path], message });
    };

    if (value.mode === "export_only") {
      if (value.preferredFormat !== undefined) {
        addIssue(
          "preferredFormat",
          "Export-only tasks cannot select a handoff format.",
        );
      }
      if (
        value.importStatus !== "not_requested" ||
        value.startStatus !== "not_requested"
      ) {
        addIssue("mode", "Export-only tasks cannot have translation activity.");
      }
      if (
        value.importReceiptId !== undefined ||
        value.translationTaskId !== undefined ||
        value.importErrorCode !== undefined ||
        value.startFailureReason !== undefined
      ) {
        addIssue(
          "mode",
          "Export-only tasks cannot include translation result metadata.",
        );
      }
    } else if (value.preferredFormat === undefined) {
      addIssue(
        "preferredFormat",
        "Translation handoff requires a preferred format.",
      );
    }

    if (
      value.mode === "enqueue_translation" &&
      value.startStatus !== "not_requested"
    ) {
      addIssue(
        "startStatus",
        "Enqueue-only mode cannot request translation start.",
      );
    }

    const importQueued = value.importStatus === "queued";
    if (importQueued) {
      if (value.translationTaskId === undefined) {
        addIssue(
          "translationTaskId",
          "A queued import requires a translation task id.",
        );
      }
      if (value.importReceiptId === undefined) {
        addIssue(
          "importReceiptId",
          "A queued import requires an immutable receipt id.",
        );
      }
    } else {
      if (value.translationTaskId !== undefined) {
        addIssue(
          "translationTaskId",
          "A translation task id requires a queued import.",
        );
      }
      if (value.importReceiptId !== undefined) {
        addIssue(
          "importReceiptId",
          "An import receipt id requires a queued import.",
        );
      }
    }

    if (
      value.importStatus === "failed" &&
      value.importErrorCode === undefined
    ) {
      addIssue("importErrorCode", "A failed import requires an error code.");
    }
    if (
      value.importStatus !== "failed" &&
      value.importStatus !== "skipped" &&
      value.importErrorCode !== undefined
    ) {
      addIssue(
        "importErrorCode",
        "Only failed or skipped imports may include an import error code.",
      );
    }

    if (value.startStatus !== "not_requested" && !importQueued) {
      addIssue(
        "startStatus",
        "Translation start activity requires a queued import.",
      );
    }
    if (
      value.startStatus === "failed" &&
      value.startFailureReason === undefined
    ) {
      addIssue(
        "startFailureReason",
        "A failed translation start requires a reason.",
      );
    }
    if (
      value.startStatus !== "failed" &&
      value.startFailureReason !== undefined
    ) {
      addIssue(
        "startFailureReason",
        "Only a failed translation start may include a failure reason.",
      );
    }
  });

const taskProgressSchema = z
  .object({
    stage: z.enum(LOCAL_SUBTITLE_TASK_STAGES),
    stageProgress: percentageSchema,
    overallProgress: percentageSchema,
    completedWindows: nonNegativeSafeIntegerSchema.optional(),
    totalWindows: nonNegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.completedWindows !== undefined &&
      value.totalWindows !== undefined &&
      value.completedWindows > value.totalWindows
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedWindows"],
        message: "Completed windows cannot exceed total windows.",
      });
    }
  });

export const localSubtitleTaskSummarySchema: z.ZodType<LocalSubtitleTaskSummary> =
  z
    .object({
      taskId: idSchema,
      batchId: idSchema,
      generation: positiveSafeIntegerSchema,
      displayName: displayNameSchema,
      durationMs: positiveSafeIntegerSchema
        .max(LOCAL_SUBTITLE_LIMITS.maxDurationMs)
        .optional(),
      status: z.enum(LOCAL_SUBTITLE_TASK_STATUSES),
      progress: taskProgressSchema,
      model: modelSnapshotSchema,
      resolvedBackend: z.enum(LOCAL_SUBTITLE_BACKENDS),
      requestedFormats: z
        .array(z.enum(LOCAL_SUBTITLE_FORMATS))
        .min(1)
        .max(LOCAL_SUBTITLE_FORMATS.length),
      artifactResults: z
        .array(artifactResultSchema)
        .max(LOCAL_SUBTITLE_FORMATS.length),
      completion: completionResultSchema.optional(),
      postAction: postActionStateSchema,
      error: localSubtitleErrorSchema.optional(),
      createdAt: isoTimestampSchema,
      updatedAt: isoTimestampSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.requestedFormats).size !== value.requestedFormats.length) {
        context.addIssue({
          code: "custom",
          path: ["requestedFormats"],
          message: "Requested formats must be unique.",
        });
      }
      const terminal = resolveLocalSubtitleTerminalOutcome({
        requestedFormats: value.requestedFormats,
        artifactResults: value.artifactResults,
        cancellationRequested:
          value.status === "cancelled" ||
          hasLocalSubtitleArtifactCancellationEvidence(value.artifactResults),
      });
      if (value.status === "completed") {
        if (!terminal.ok || terminal.status !== "completed") {
          context.addIssue({
            code: "custom",
            path: ["artifactResults"],
            message: "Completed tasks require a valid committed artifact outcome.",
          });
        }
        if (value.completion === undefined) {
          context.addIssue({
            code: "custom",
            path: ["completion"],
            message: "Completed tasks require completion details.",
          });
        } else if (
          terminal.ok &&
          terminal.status === "completed" &&
          JSON.stringify(value.completion) !==
            JSON.stringify(terminal.completion)
        ) {
          context.addIssue({
            code: "custom",
            path: ["completion"],
            message: "Completion details must match artifact results.",
          });
        }
      } else if (value.completion !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["completion"],
          message: "Only completed tasks may include completion details.",
        });
      }
      if (
        value.status === "cancelled" &&
        (value.artifactResults.some(
          (artifact) =>
            artifact.status === "failed" &&
            artifact.errorCode === "cancel_failed",
        ) ||
          (terminal.ok && terminal.status !== "cancelled"))
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifactResults"],
          message: "Cancelled tasks cannot contain a failed terminal outcome.",
        });
      }
      if (value.status === "failed" && value.error === undefined) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "Failed tasks require a structured error.",
        });
      }
      if (value.status !== "failed" && value.error !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "Only failed tasks may include a terminal error.",
        });
      }
      if (
        (value.status === "failed" || value.status === "cancelled") &&
        value.artifactResults.some((artifact) => artifact.status === "committed")
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifactResults"],
          message: "Failed or cancelled tasks cannot contain committed artifacts.",
        });
      }
      const artifactFormats = new Set<string>();
      value.artifactResults.forEach((artifact, index) => {
        if (!value.requestedFormats.includes(artifact.format)) {
          context.addIssue({
            code: "custom",
            path: ["artifactResults", index, "format"],
            message: "Artifact result format must be requested by the task.",
          });
        }
        if (artifactFormats.has(artifact.format)) {
          context.addIssue({
            code: "custom",
            path: ["artifactResults", index, "format"],
            message: "Artifact result formats must be unique.",
          });
        }
        artifactFormats.add(artifact.format);
      });

      const expectedStageByStatus: Partial<
        Record<(typeof LOCAL_SUBTITLE_TASK_STATUSES)[number], string>
      > = {
        queued: "queued",
        preparing_media: "preparing_media",
        loading_model: "loading_model",
        transcribing: "transcribing",
        post_processing: "post_processing",
        exporting: "exporting",
        completed: "exporting",
        cancelling: "cancelling",
        cancelled: "cancelling",
      };
      const expectedStage = expectedStageByStatus[value.status];
      if (expectedStage !== undefined && value.progress.stage !== expectedStage) {
        context.addIssue({
          code: "custom",
          path: ["progress", "stage"],
          message: "Task progress stage must match task status.",
        });
      }
      if (
        value.status === "queued" &&
        (value.progress.stageProgress !== 0 || value.progress.overallProgress !== 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["progress"],
          message: "Queued task progress must start at zero.",
        });
      }
      if (
        value.status === "completed" &&
        (value.progress.stageProgress !== 100 ||
          value.progress.overallProgress !== 100)
      ) {
        context.addIssue({
          code: "custom",
          path: ["progress"],
          message: "Completed task progress must be 100 percent.",
        });
      }
      if (
        [
          "queued",
          "preparing_media",
          "loading_model",
          "transcribing",
          "post_processing",
        ].includes(value.status) &&
        value.artifactResults.length > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifactResults"],
          message: "Artifacts cannot exist before the exporting stage.",
        });
      }
      const hasCancellationMarker = value.artifactResults.some(
        (artifact) =>
          artifact.status === "skipped" &&
          artifact.errorCode === "cancelled_after_partial_commit",
      );
      if (
        hasCancellationMarker &&
        value.status !== "cancelling" &&
        value.status !== "completed"
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifactResults"],
          message: "Cancellation markers require cancelling or completed status.",
        });
      }
      if (value.postAction.preferredFormat !== undefined &&
          !value.requestedFormats.includes(value.postAction.preferredFormat)) {
        context.addIssue({
          code: "custom",
          path: ["postAction", "preferredFormat"],
          message: "Handoff format must be one of the requested formats.",
        });
      }
      if (
        (value.postAction.importStatus === "importing" ||
          value.postAction.importStatus === "queued") &&
        (value.postAction.preferredFormat === undefined ||
          !value.artifactResults.some(
            (artifact) =>
              artifact.status === "committed" &&
              artifact.format === value.postAction.preferredFormat,
          ))
      ) {
        context.addIssue({
          code: "custom",
          path: ["postAction", "importStatus"],
          message: "Translation import requires its selected committed artifact.",
        });
      }
    });

const batchConfigSummarySchema = z
  .object({
    modelId: idSchema,
    devicePreference: z.enum(LOCAL_SUBTITLE_DEVICE_PREFERENCES),
    resolvedBackend: z.enum(LOCAL_SUBTITLE_BACKENDS),
    language: languageSchema,
    taskMode: z.enum(LOCAL_SUBTITLE_TASK_MODES),
    qualityPreset: z.enum(LOCAL_SUBTITLE_QUALITY_PRESETS),
    vadEnabled: z.boolean(),
    outputFormats: z
      .array(z.enum(LOCAL_SUBTITLE_FORMATS))
      .min(1)
      .max(LOCAL_SUBTITLE_FORMATS.length),
    outputMode: z.enum(LOCAL_SUBTITLE_OUTPUT_MODES),
    conflictPolicy: z.enum(LOCAL_SUBTITLE_CONFLICT_POLICIES),
    postActionMode: z.enum(LOCAL_SUBTITLE_HANDOFF_MODES),
    preferredHandoffFormat: z.enum(LOCAL_SUBTITLE_FORMATS).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.outputFormats).size !== value.outputFormats.length) {
      context.addIssue({
        code: "custom",
        path: ["outputFormats"],
        message: "Output formats must be unique.",
      });
    }
    if (
      value.postActionMode === "export_only" &&
      value.preferredHandoffFormat !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["preferredHandoffFormat"],
        message: "Export-only batches cannot select a handoff format.",
      });
    }
    if (
      value.postActionMode !== "export_only" &&
      (value.preferredHandoffFormat === undefined ||
        !value.outputFormats.includes(value.preferredHandoffFormat))
    ) {
      context.addIssue({
        code: "custom",
        path: ["preferredHandoffFormat"],
        message: "Handoff format must be an enabled output format.",
      });
    }
  });

export const localSubtitleBatchSummarySchema: z.ZodType<LocalSubtitleBatchSummary> =
  z
    .object({
      batchId: idSchema,
      status: z.enum(LOCAL_SUBTITLE_BATCH_STATUSES),
      config: batchConfigSummarySchema,
      tasks: z
        .array(localSubtitleTaskSummarySchema)
        .max(LOCAL_SUBTITLE_LIMITS.maxBatchFiles),
      createdAt: isoTimestampSchema,
      updatedAt: isoTimestampSchema,
    })
    .strict()
    .superRefine((value, context) => {
      const taskIds = new Set<string>();
      value.tasks.forEach((task, index) => {
        if (task.batchId !== value.batchId) {
          context.addIssue({
            code: "custom",
            path: ["tasks", index, "batchId"],
            message: "Task batchId must match its containing batch.",
          });
        }
        if (taskIds.has(task.taskId)) {
          context.addIssue({
            code: "custom",
            path: ["tasks", index, "taskId"],
            message: "Task ids must be unique within a batch.",
          });
        }
        taskIds.add(task.taskId);
      });
      if (value.status !== deriveLocalSubtitleBatchStatus(value.tasks)) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Batch status must be derived from its task summaries.",
        });
      }
    });

export const localSubtitleResourceJobSummarySchema: z.ZodType<LocalSubtitleResourceJobSummary> =
  z
    .object({
      jobId: idSchema,
      resourceId: idSchema,
      resourceType: z.enum(LOCAL_SUBTITLE_RESOURCE_TYPES),
      status: z.enum(LOCAL_SUBTITLE_RESOURCE_JOB_STATUSES),
      progress: percentageSchema,
      bytesCompleted: nonNegativeSafeIntegerSchema
        .max(LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes)
        .optional(),
      bytesTotal: nonNegativeSafeIntegerSchema
        .max(LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes)
        .optional(),
      error: localSubtitleErrorSchema.optional(),
      createdAt: isoTimestampSchema,
      updatedAt: isoTimestampSchema,
    })
    .strict()
    .superRefine((value, context) => {
    if (
      value.bytesCompleted !== undefined &&
      value.bytesTotal !== undefined &&
      value.bytesCompleted > value.bytesTotal
    ) {
      context.addIssue({
        code: "custom",
        path: ["bytesCompleted"],
        message: "Completed bytes cannot exceed total bytes.",
      });
    }
    if (value.status === "failed" && value.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed resource jobs require a structured error.",
      });
    }
    });

export const localSubtitleSessionSnapshotSchema: z.ZodType<LocalSubtitleSessionSnapshot> =
  z
    .object({
      schemaVersion: z.literal(LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION),
      revision: nonNegativeSafeIntegerSchema,
      batches: z
        .array(localSubtitleBatchSummarySchema)
        .max(LOCAL_SUBTITLE_LIMITS.maxSessionBatches),
      resourceJobs: z
        .array(localSubtitleResourceJobSummarySchema)
        .max(LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs),
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.batches.map((batch) => batch.batchId)).size !== value.batches.length) {
        context.addIssue({
          code: "custom",
          path: ["batches"],
          message: "Batch ids must be unique within a snapshot.",
        });
      }
      if (new Set(value.resourceJobs.map((job) => job.jobId)).size !== value.resourceJobs.length) {
        context.addIssue({
          code: "custom",
          path: ["resourceJobs"],
          message: "Resource job ids must be unique within a snapshot.",
        });
      }
    });

const taskEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("task-updated"),
      task: localSubtitleTaskSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("task-removed"),
      removedAt: isoTimestampSchema,
    })
    .strict(),
]);

export const localSubtitleTaskEventEnvelopeSchema: z.ZodType<LocalSubtitleTaskEventEnvelope> =
  z
    .object({
      batchId: idSchema,
      taskId: idSchema,
      generation: positiveSafeIntegerSchema,
      revision: positiveSafeIntegerSchema,
      event: taskEventSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.event.type === "task-updated") {
        if (value.event.task.batchId !== value.batchId) {
          context.addIssue({
            code: "custom",
            path: ["event", "task", "batchId"],
            message: "Event batchId must match the task.",
          });
        }
        if (value.event.task.taskId !== value.taskId) {
          context.addIssue({
            code: "custom",
            path: ["event", "task", "taskId"],
            message: "Event taskId must match the task.",
          });
        }
        if (value.event.task.generation !== value.generation) {
          context.addIssue({
            code: "custom",
            path: ["event", "task", "generation"],
            message: "Event generation must match the task.",
          });
        }
      }
    });

const resourceEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("resource-job-updated"),
      job: localSubtitleResourceJobSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("resource-job-removed"),
      jobId: idSchema,
      removedAt: isoTimestampSchema,
    })
    .strict(),
]);

export const localSubtitleResourceEventEnvelopeSchema: z.ZodType<LocalSubtitleResourceEventEnvelope> =
  z
    .object({
      revision: positiveSafeIntegerSchema,
      event: resourceEventSchema,
    })
    .strict();

const advancedSettingsSchema = z
  .object({
    initialPrompt: z
      .string()
      .max(LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars)
      .refine(noUnsafeControlCharacters)
      .optional(),
    beamSize: z.number().int().min(1).max(10),
    temperature: z.number().finite().min(0).max(1),
    vadMinSilenceMs: z.number().int().min(100).max(5000),
    maxCueDurationMs: z.number().int().min(500).max(
      LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs,
    ),
    maxCueChars: z.number().int().min(20).max(
      LOCAL_SUBTITLE_LIMITS.maxCueTextChars,
    ),
    maxLineChars: z.number().int().min(10).max(
      LOCAL_SUBTITLE_LIMITS.maxLineChars,
    ),
  })
  .strict();

const outputRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("source"),
      formats: z
        .array(z.enum(LOCAL_SUBTITLE_FORMATS))
        .min(1)
        .max(LOCAL_SUBTITLE_FORMATS.length),
      conflictPolicy: z.enum(LOCAL_SUBTITLE_CONFLICT_POLICIES),
    })
    .strict(),
  z
    .object({
      mode: z.literal("custom"),
      formats: z
        .array(z.enum(LOCAL_SUBTITLE_FORMATS))
        .min(1)
        .max(LOCAL_SUBTITLE_FORMATS.length),
      conflictPolicy: z.enum(LOCAL_SUBTITLE_CONFLICT_POLICIES),
      outputDirToken: opaqueRefSchema,
    })
    .strict(),
]);

const postActionRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("export_only") }).strict(),
  z
    .object({
      mode: z.literal("enqueue_translation"),
      preferredFormat: z.enum(LOCAL_SUBTITLE_FORMATS),
    })
    .strict(),
  z
    .object({
      mode: z.literal("enqueue_and_start_translation"),
      preferredFormat: z.enum(LOCAL_SUBTITLE_FORMATS),
    })
    .strict(),
]);

export const enqueueLocalSubtitleBatchRequestSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION),
    files: z
      .array(
        z
          .object({
            fileToken: opaqueRefSchema,
            audioStreamId: idSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxBatchFiles),
    config: z
      .object({
        modelId: idSchema,
        devicePreference: z.enum(LOCAL_SUBTITLE_DEVICE_PREFERENCES),
        language: languageSchema,
        taskMode: z.enum(LOCAL_SUBTITLE_TASK_MODES),
        qualityPreset: z.enum(LOCAL_SUBTITLE_QUALITY_PRESETS),
        vadEnabled: z.boolean(),
        advanced: advancedSettingsSchema,
        output: outputRequestSchema,
        postAction: postActionRequestSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const fileTokens = new Set<string>();
    value.files.forEach((file, index) => {
      if (fileTokens.has(file.fileToken)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "fileToken"],
          message: "File tokens must be unique within a batch.",
        });
      }
      fileTokens.add(file.fileToken);
    });

    if (new Set(value.config.output.formats).size !== value.config.output.formats.length) {
      context.addIssue({
        code: "custom",
        path: ["config", "output", "formats"],
        message: "Output formats must be unique.",
      });
    }
    if (
      value.config.postAction.mode !== "export_only" &&
      !value.config.output.formats.includes(
        value.config.postAction.preferredFormat,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["config", "postAction", "preferredFormat"],
        message: "Handoff format must be an enabled output format.",
      });
    }
  });

export type EnqueueLocalSubtitleBatchRequest = z.infer<
  typeof enqueueLocalSubtitleBatchRequestSchema
>;

export const localSubtitleTaskIdRequestSchema = z
  .object({ taskId: idSchema })
  .strict();
export const localSubtitleBatchIdRequestSchema = z
  .object({ batchId: idSchema })
  .strict();
export const localSubtitleResourceIdRequestSchema = z
  .object({ resourceId: idSchema })
  .strict();
export const localSubtitleResourceJobIdRequestSchema = z
  .object({ jobId: idSchema })
  .strict();
export const localSubtitleFileTokenRequestSchema = z
  .object({ fileToken: opaqueRefSchema })
  .strict();
export const localSubtitleOutputDirTokenRequestSchema = z
  .object({ outputDirToken: opaqueRefSchema })
  .strict();
export const localSubtitleArtifactRefRequestSchema = z
  .object({ artifactRef: opaqueRefSchema })
  .strict();
export const localSubtitleEmptyRequestSchema = z.object({}).strict();

const privateFilePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => value.trim().length > 0, "File path must not be blank.")
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "File path contains an unsupported control character.",
  );

export const localSubtitleOwnerSessionRegistrationSchema = z
  .object({ ownerSessionId: ownerSessionIdSchema })
  .strict();
export const localSubtitleAuthorizeInputFilesRequestSchema = z
  .object({
    files: z
      .array(z.object({ filePath: privateFilePathSchema }).strict())
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxBatchFiles),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.files.map((file) => file.filePath)).size !==
      value.files.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Input file paths must be unique within an authorization request.",
      });
    }
  });
export const localSubtitleImportModelRequestSchema = z
  .object({
    filePath: privateFilePathSchema,
    mode: z.enum(["copy", "move"]),
  })
  .strict();

const boundedMetadataStringSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxMediaMetadataFieldChars)
  .refine(
    (value) => value.trim() === value && value.length > 0,
    "Must be a non-blank trimmed value.",
  )
  .refine(
    (value) => !/[\t\r\n\u2028\u2029]/u.test(value),
    "Media metadata must be a single line.",
  )
  .refine(noUnsafeControlCharacters);

export const localSubtitleAuthorizedMediaSchema = z
  .object({
    fileToken: opaqueRefSchema,
    displayName: displayNameSchema,
    byteSize: positiveSafeIntegerSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes,
    ),
    expiresAt: positiveSafeIntegerSchema,
  })
  .strict();
export const localSubtitleAuthorizedMediaListSchema = z
  .array(localSubtitleAuthorizedMediaSchema)
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxBatchFiles)
  .superRefine((value, context) => {
    if (new Set(value.map((entry) => entry.fileToken)).size !== value.length) {
      context.addIssue({
        code: "custom",
        message: "Authorized media tokens must be unique.",
      });
    }
  });

export const localSubtitleMediaTrackSummarySchema = z
  .object({
    streamId: idSchema,
    ordinal: positiveSafeIntegerSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxMediaTracks,
    ),
    isDefault: z.boolean(),
    language: boundedMetadataStringSchema.optional(),
    title: boundedMetadataStringSchema.optional(),
    codec: boundedMetadataStringSchema.optional(),
    channels: positiveSafeIntegerSchema.max(256).optional(),
    sampleRateHz: positiveSafeIntegerSchema.max(1_536_000).optional(),
  })
  .strict();

export const localSubtitleMediaProbeSummarySchema = z
  .object({
    fileToken: opaqueRefSchema,
    displayName: displayNameSchema,
    durationMs: positiveSafeIntegerSchema.max(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
    audioTracks: z
      .array(localSubtitleMediaTrackSummarySchema)
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxMediaTracks),
    autoSelectedStreamId: idSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const streamIds = new Set(value.audioTracks.map((track) => track.streamId));
    if (streamIds.size !== value.audioTracks.length) {
      context.addIssue({
        code: "custom",
        path: ["audioTracks"],
        message: "Media track stream ids must be unique.",
      });
    }
    if (
      new Set(value.audioTracks.map((track) => track.ordinal)).size !==
      value.audioTracks.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["audioTracks"],
        message: "Media track ordinals must be unique.",
      });
    }
    if (!streamIds.has(value.autoSelectedStreamId)) {
      context.addIssue({
        code: "custom",
        path: ["autoSelectedStreamId"],
        message: "The automatic selection must reference a returned stream id.",
      });
    }
  });

export const localSubtitleOutputDirectorySelectionSchema = z.discriminatedUnion(
  "cancelled",
  [
    z.object({ cancelled: z.literal(true) }).strict(),
    z
      .object({
        cancelled: z.literal(false),
        outputDirToken: opaqueRefSchema,
        displayLabel: displayNameSchema,
        expiresAt: positiveSafeIntegerSchema,
      })
      .strict(),
  ],
);

export const LOCAL_SUBTITLE_RUNTIME_PROBE_STATUSES = [
  "ready",
  "missing",
  "invalid",
  "launch_failed",
] as const;
export const LOCAL_SUBTITLE_BACKEND_PROBE_STATUSES = [
  "available",
  "unavailable",
  "unverified",
] as const;

const runtimeComponentSummarySchema = z
  .object({
    status: z.enum(LOCAL_SUBTITLE_RUNTIME_PROBE_STATUSES),
    version: boundedMetadataStringSchema.optional(),
    errorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "ready" && value.errorCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Ready runtime components cannot include an error code.",
      });
    }
    if (value.status !== "ready" && value.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Unavailable runtime components require an error code.",
      });
    }
  });

const backendProbeSummarySchema = z
  .object({
    backend: z.enum(LOCAL_SUBTITLE_BACKENDS),
    status: z.enum(LOCAL_SUBTITLE_BACKEND_PROBE_STATUSES),
    errorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "available" && value.errorCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Available backends cannot include an error code.",
      });
    }
    if (value.status !== "available" && value.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Unavailable backends require an error code.",
      });
    }
  });

export const localSubtitleRuntimeSummarySchema = z
  .object({
    schemaVersion: z.literal(LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION),
    platform: z.enum(["win32", "darwin"]),
    arch: z.enum(["x64", "arm64"]),
    runtimeGeneration: sha256Schema,
    runner: runtimeComponentSummarySchema,
    mediaRuntime: runtimeComponentSummarySchema,
    backends: z
      .array(backendProbeSummarySchema)
      .min(1)
      .max(LOCAL_SUBTITLE_BACKENDS.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.platform === "win32" && value.arch !== "x64") ||
      (value.platform === "darwin" && value.arch !== "arm64")
    ) {
      context.addIssue({
        code: "custom",
        path: ["arch"],
        message: "Runtime platform and architecture must match a release profile.",
      });
    }
    if (
      new Set(value.backends.map((backend) => backend.backend)).size !==
      value.backends.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["backends"],
        message: "Runtime backend summaries must be unique.",
      });
    }
  });

export const LOCAL_SUBTITLE_MANAGED_RESOURCE_STATUSES = [
  "not_installed",
  "installing",
  "ready",
  "invalid",
] as const;

export const localSubtitleManagedResourceSummarySchema = z
  .object({
    resourceId: idSchema,
    resourceType: z.enum(LOCAL_SUBTITLE_RESOURCE_TYPES),
    displayName: displayNameSchema,
    status: z.enum(LOCAL_SUBTITLE_MANAGED_RESOURCE_STATUSES),
    version: boundedMetadataStringSchema.optional(),
    byteSize: positiveSafeIntegerSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes,
    ),
    isDefault: z.boolean(),
    compatibleBackends: z
      .array(z.enum(LOCAL_SUBTITLE_BACKENDS))
      .min(1)
      .max(LOCAL_SUBTITLE_BACKENDS.length),
    errorCode: z.enum(LOCAL_SUBTITLE_ERROR_CODES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.compatibleBackends).size !== value.compatibleBackends.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibleBackends"],
        message: "Compatible backends must be unique.",
      });
    }
    if (value.status === "invalid" && value.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Invalid managed resources require an error code.",
      });
    }
    if (value.status !== "invalid" && value.errorCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Only invalid managed resources may include an error code.",
      });
    }
  });
export const localSubtitleManagedResourceListSchema = z
  .array(localSubtitleManagedResourceSummarySchema)
  .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeArtifacts)
  .superRefine((value, context) => {
    if (new Set(value.map((entry) => entry.resourceId)).size !== value.length) {
      context.addIssue({
        code: "custom",
        message: "Managed resource ids must be unique.",
      });
    }
  });

export const localSubtitleRevokeResultSchema = z
  .object({ revoked: z.boolean() })
  .strict();
export const localSubtitleCancelResourceJobResultSchema = z
  .object({ cancelled: z.boolean() })
  .strict();
export const localSubtitleDeleteManagedResourceResultSchema = z
  .object({ deleted: z.boolean() })
  .strict();
export const localSubtitleCancelBatchResultSchema = z
  .object({
    cancelledTaskIds: z
      .array(idSchema)
      .max(LOCAL_SUBTITLE_LIMITS.maxBatchFiles),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.cancelledTaskIds).size !== value.cancelledTaskIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["cancelledTaskIds"],
        message: "Cancelled task ids must be unique.",
      });
    }
  });
export const localSubtitleCancelTaskResultSchema = z
  .object({ cancelled: z.boolean() })
  .strict();
export const localSubtitleRemoveTaskResultSchema = z
  .object({ removed: z.boolean() })
  .strict();

export const localSubtitleArtifactTextResultSchema = z
  .object({
    format: z.enum(LOCAL_SUBTITLE_FORMATS),
    rawText: z
      .string()
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxArtifactBytes)
      .refine(noUnsafeControlCharacters),
    plainText: z
      .string()
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxArtifactBytes)
      .refine(noUnsafeControlCharacters),
    cueCount: positiveSafeIntegerSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxArtifactCues,
    ),
  })
  .strict()
  .refine(
    (value) =>
      (serializedByteLength(value) ?? Number.POSITIVE_INFINITY) <=
      LOCAL_SUBTITLE_LIMITS.maxArtifactBytes,
    "Artifact text exceeds the versioned byte limit.",
  );
export const localSubtitleRevealArtifactResultSchema = z
  .object({ revealed: z.literal(true) })
  .strict();
export const localSubtitleHandoffResultSchema = z
  .object({
    translationImportToken: opaqueRefSchema,
    expiresAt: positiveSafeIntegerSchema,
  })
  .strict();

export type LocalSubtitleAuthorizedMedia = z.infer<
  typeof localSubtitleAuthorizedMediaSchema
>;
export type LocalSubtitleMediaProbeSummary = z.infer<
  typeof localSubtitleMediaProbeSummarySchema
>;
export type LocalSubtitleOutputDirectorySelection = z.infer<
  typeof localSubtitleOutputDirectorySelectionSchema
>;
export type LocalSubtitleRuntimeSummary = z.infer<
  typeof localSubtitleRuntimeSummarySchema
>;
export type LocalSubtitleManagedResourceSummary = z.infer<
  typeof localSubtitleManagedResourceSummarySchema
>;
export type LocalSubtitleArtifactTextResult = z.infer<
  typeof localSubtitleArtifactTextResultSchema
>;
export type LocalSubtitleHandoffResult = z.infer<
  typeof localSubtitleHandoffResultSchema
>;
export type LocalSubtitleOwnerSessionRegistration = z.infer<
  typeof localSubtitleOwnerSessionRegistrationSchema
>;
export type LocalSubtitleAuthorizeInputFilesRequest = z.infer<
  typeof localSubtitleAuthorizeInputFilesRequestSchema
>;
export type LocalSubtitleImportModelRequest = z.infer<
  typeof localSubtitleImportModelRequestSchema
>;

const subtitleTextSchema = z
  .string()
  .min(1)
  .max(
    LOCAL_SUBTITLE_LIMITS.maxCueTextChars +
      LOCAL_SUBTITLE_LIMITS.maxCueLines -
      1,
  )
  .refine((value) => value.trim().length > 0, "Subtitle text must not be blank.")
  .refine(noUnsafeControlCharacters)
  .refine(
    (value) => !/[\r\u2028\u2029]/u.test(value),
    "Subtitle line breaks must use LF.",
  )
  .refine((value) => value.split("\n").length <= LOCAL_SUBTITLE_LIMITS.maxCueLines)
  .refine(
    (value) =>
      value
        .split("\n")
        .reduce((total, line) => total + line.length, 0) <=
      LOCAL_SUBTITLE_LIMITS.maxCueTextChars,
  )
  .refine((value) =>
    value.split("\n").every((line) => line.length <= LOCAL_SUBTITLE_LIMITS.maxLineChars),
  );

const wordSchema = z
  .object({
    startMs: nonNegativeSafeIntegerSchema.max(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
    endMs: positiveSafeIntegerSchema.max(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
    text: subtitleTextSchema,
    probability: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine((value) => value.endMs > value.startMs, {
    path: ["endMs"],
    message: "Word endMs must be greater than startMs.",
  });

const segmentSchema = z
  .object({
    id: idSchema,
    startMs: nonNegativeSafeIntegerSchema.max(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
    endMs: positiveSafeIntegerSchema.max(LOCAL_SUBTITLE_LIMITS.maxDurationMs),
    text: subtitleTextSchema,
    words: z
      .array(wordSchema)
      .max(LOCAL_SUBTITLE_LIMITS.maxWordsPerSegment)
      .optional(),
    estimatedTiming: z.literal(true).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    speaker: z.string().min(1).max(128).refine(noUnsafeControlCharacters).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endMs <= value.startMs) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Segment endMs must be greater than startMs.",
      });
    }
    if (value.estimatedTiming && value.words !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["estimatedTiming"],
        message: "Estimated timing cannot be combined with word timestamps.",
      });
    }
    let previousWordEndMs = value.startMs;
    value.words?.forEach((word, index) => {
      if (word.startMs < value.startMs || word.endMs > value.endMs) {
        context.addIssue({
          code: "custom",
          path: ["words", index],
          message: "Word timestamps must stay inside their segment.",
        });
      }
      if (word.startMs < previousWordEndMs) {
        context.addIssue({
          code: "custom",
          path: ["words", index, "startMs"],
          message: "Words must be ordered and non-overlapping.",
        });
      }
      previousWordEndMs = Math.max(previousWordEndMs, word.endMs);
    });
  });

export const localSubtitleTranscriptSchema: z.ZodType<LocalSubtitleTranscript> =
  z
    .object({
      schemaVersion: z.literal(LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION),
      source: z
        .object({
          displayName: displayNameSchema,
          durationMs: positiveSafeIntegerSchema.max(
            LOCAL_SUBTITLE_LIMITS.maxDurationMs,
          ),
        })
        .strict(),
      model: z
        .object({
          engine: z.enum(LOCAL_SUBTITLE_ENGINES),
          modelId: idSchema,
          modelHash: sha256Schema,
          backend: z.enum(LOCAL_SUBTITLE_BACKENDS),
        })
        .strict(),
      detectedLanguage: languageSchema
        .refine((value) => value !== "auto", "Detected language cannot be auto.")
        .optional(),
      languageProbability: z.number().finite().min(0).max(1).optional(),
      segments: z
        .array(segmentSchema)
        .min(1)
        .max(LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments),
    })
    .strict()
    .superRefine((value, context) => {
      const ids = new Set<string>();
      let previousEndMs = 0;
      let wordCount = 0;
      value.segments.forEach((segment, index) => {
        if (ids.has(segment.id)) {
          context.addIssue({
            code: "custom",
            path: ["segments", index, "id"],
            message: "Segment ids must be unique.",
          });
        }
        ids.add(segment.id);
        if (segment.startMs < previousEndMs) {
          context.addIssue({
            code: "custom",
            path: ["segments", index, "startMs"],
            message: "Segments must be ordered and non-overlapping.",
          });
        }
        if (segment.endMs > value.source.durationMs) {
          context.addIssue({
            code: "custom",
            path: ["segments", index, "endMs"],
            message: "Segments must stay inside source duration.",
          });
        }
        previousEndMs = Math.max(previousEndMs, segment.endMs);
        wordCount += segment.words?.length ?? 0;
      });
      if (wordCount > LOCAL_SUBTITLE_LIMITS.maxTranscriptWords) {
        context.addIssue({
          code: "custom",
          path: ["segments"],
          message: "Transcript word count exceeds the versioned limit.",
        });
      }
    });

function boundedLocalSubtitleIpcResultSchema<
  TSchema extends z.ZodTypeAny,
>(dataSchema: TSchema, maxBytes: number) {
  return localSubtitleIpcResultSchema(dataSchema).refine(
    (value) =>
      (serializedByteLength(value) ?? Number.POSITIVE_INFINITY) <= maxBytes,
    "Local subtitle IPC result exceeds its operation byte limit.",
  );
}

function boundedLocalSubtitleIpcRequestSchema<TSchema extends z.ZodTypeAny>(
  requestSchema: TSchema,
) {
  return requestSchema.refine(
    (value) =>
      (serializedByteLength(value) ?? Number.POSITIVE_INFINITY) <=
      LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes,
    "Local subtitle IPC request exceeds the frame byte limit.",
  );
}

export interface LocalSubtitlePublicOperationContract {
  readonly requestSchema: z.ZodTypeAny;
  readonly resultSchema: z.ZodTypeAny;
  readonly maxRequestBytes: number;
  readonly maxResultBytes: number;
}

const normalRequestBytes = LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes;
const normalResultBytes = LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes;
const artifactTextResultBytes =
  LOCAL_SUBTITLE_LIMITS.maxArtifactBytes + LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes;

export const LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS: Record<
  LocalSubtitlePublicInvokeChannel,
  LocalSubtitlePublicOperationContract
> = {
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleFileTokenRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleMediaProbeSummarySchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeRuntime]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleEmptyRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleRuntimeSummarySchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleEmptyRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleManagedResourceListSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleResourceIdRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleResourceJobSummarySchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleResourceJobIdRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleCancelResourceJobResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleResourceIdRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleDeleteManagedResourceResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.getSessionSnapshot]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleEmptyRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleSessionSnapshotSchema,
      LOCAL_SUBTITLE_LIMITS.maxSessionSnapshotBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: LOCAL_SUBTITLE_LIMITS.maxSessionSnapshotBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.enqueue]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      enqueueLocalSubtitleBatchRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleBatchSummarySchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.retryTask]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleTaskIdRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleTaskSummarySchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelBatch]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleBatchIdRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleCancelBatchResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelTask]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleTaskIdRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleCancelTaskResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.removeTask]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleTaskIdRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleRemoveTaskResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleArtifactRefRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleArtifactTextResultSchema,
      artifactTextResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: artifactTextResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleArtifactRefRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleRevealArtifactResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
  [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleArtifactRefRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleHandoffResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
  },
};

export interface LocalSubtitleInternalOperationContract
  extends LocalSubtitlePublicOperationContract {
  readonly requiresOwnerEnvelope: boolean;
}

export const LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS: Record<
  LocalSubtitlePreloadInternalChannel,
  LocalSubtitleInternalOperationContract
> = {
  [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleEmptyRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleOwnerSessionRegistrationSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
    requiresOwnerEnvelope: false,
  },
  [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleAuthorizeInputFilesRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleAuthorizedMediaListSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
    requiresOwnerEnvelope: true,
  },
  [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleFileTokenRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleRevokeResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
    requiresOwnerEnvelope: true,
  },
  [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleEmptyRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleOutputDirectorySelectionSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
    requiresOwnerEnvelope: true,
  },
  [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleOutputDirTokenRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleRevokeResultSchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
    requiresOwnerEnvelope: true,
  },
  [LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel]: {
    requestSchema: boundedLocalSubtitleIpcRequestSchema(
      localSubtitleImportModelRequestSchema,
    ),
    resultSchema: boundedLocalSubtitleIpcResultSchema(
      localSubtitleResourceJobSummarySchema,
      normalResultBytes,
    ),
    maxRequestBytes: normalRequestBytes,
    maxResultBytes: normalResultBytes,
    requiresOwnerEnvelope: true,
  },
};

export interface LocalSubtitleRendererApi {
  authorizeInputFiles(
    files: File[],
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleAuthorizedMedia[]>>;
  probeMedia(
    fileToken: string,
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleMediaProbeSummary>>;
  revokeInputFile(
    fileToken: string,
  ): Promise<LocalSubtitleIpcResult<z.infer<typeof localSubtitleRevokeResultSchema>>>;
  selectOutputDirectory(): Promise<
    LocalSubtitleIpcResult<LocalSubtitleOutputDirectorySelection>
  >;
  revokeOutputDirectory(
    outputDirToken: string,
  ): Promise<LocalSubtitleIpcResult<z.infer<typeof localSubtitleRevokeResultSchema>>>;
  probeRuntime(): Promise<LocalSubtitleIpcResult<LocalSubtitleRuntimeSummary>>;
  listManagedResources(): Promise<
    LocalSubtitleIpcResult<LocalSubtitleManagedResourceSummary[]>
  >;
  startResourceInstall(request: {
    readonly resourceId: string;
  }): Promise<LocalSubtitleIpcResult<LocalSubtitleResourceJobSummary>>;
  cancelResourceJob(
    jobId: string,
  ): Promise<
    LocalSubtitleIpcResult<
      z.infer<typeof localSubtitleCancelResourceJobResultSchema>
    >
  >;
  importModel(
    file: File,
    options: { readonly mode: "copy" | "move" },
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleResourceJobSummary>>;
  deleteManagedResource(
    resourceId: string,
  ): Promise<
    LocalSubtitleIpcResult<
      z.infer<typeof localSubtitleDeleteManagedResourceResultSchema>
    >
  >;
  getSessionSnapshot(): Promise<
    LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>
  >;
  enqueue(
    request: EnqueueLocalSubtitleBatchRequest,
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleBatchSummary>>;
  retryTask(
    taskId: string,
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleTaskSummary>>;
  cancelBatch(
    batchId: string,
  ): Promise<
    LocalSubtitleIpcResult<z.infer<typeof localSubtitleCancelBatchResultSchema>>
  >;
  cancelTask(
    taskId: string,
  ): Promise<
    LocalSubtitleIpcResult<z.infer<typeof localSubtitleCancelTaskResultSchema>>
  >;
  removeTask(
    taskId: string,
  ): Promise<
    LocalSubtitleIpcResult<z.infer<typeof localSubtitleRemoveTaskResultSchema>>
  >;
  readArtifactText(
    artifactRef: string,
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleArtifactTextResult>>;
  revealArtifact(
    artifactRef: string,
  ): Promise<
    LocalSubtitleIpcResult<z.infer<typeof localSubtitleRevealArtifactResultSchema>>
  >;
  handoffArtifact(
    artifactRef: string,
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleHandoffResult>>;
  onTaskEvent(
    listener: (event: LocalSubtitleTaskEventEnvelope) => void,
  ): () => void;
  onResourceEvent(
    listener: (event: LocalSubtitleResourceEventEnvelope) => void,
  ): () => void;
}

export function validateEnqueueLocalSubtitleBatchRequest(
  payload: unknown,
): LocalSubtitleIpcResult<EnqueueLocalSubtitleBatchRequest> {
  return validateIpcFrame(enqueueLocalSubtitleBatchRequestSchema, payload);
}

export function validateLocalSubtitleTaskEventEnvelope(
  payload: unknown,
): LocalSubtitleIpcResult<LocalSubtitleTaskEventEnvelope> {
  return validateIpcFrame(localSubtitleTaskEventEnvelopeSchema, payload);
}

export function validateLocalSubtitleResourceEventEnvelope(
  payload: unknown,
): LocalSubtitleIpcResult<LocalSubtitleResourceEventEnvelope> {
  return validateIpcFrame(localSubtitleResourceEventEnvelopeSchema, payload);
}

export function validateLocalSubtitleSessionSnapshot(
  payload: unknown,
): LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot> {
  return validateIpcFrame(
    localSubtitleSessionSnapshotSchema,
    payload,
    LOCAL_SUBTITLE_LIMITS.maxSessionSnapshotBytes,
  );
}

export function validateLocalSubtitleTranscript(
  payload: unknown,
): LocalSubtitleIpcResult<LocalSubtitleTranscript> {
  const result = localSubtitleTranscriptSchema.safeParse(payload);
  if (result.success) return localSubtitleIpcSuccess(result.data);
  return schemaFailure(result.error, "invalid_content");
}

export function validateLocalSubtitleControlRequest<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): LocalSubtitleIpcResult<T> {
  return validateIpcFrame(schema, payload);
}

function validateIpcFrame<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  maxBytes = LOCAL_SUBTITLE_LIMITS.maxIpcFrameBytes,
): LocalSubtitleIpcResult<T> {
  const frameBytes = serializedByteLength(payload);
  if (frameBytes === null) {
    return localSubtitleIpcFailure({
      code: "invalid_ipc_request",
      message: "Local subtitle IPC payload must be JSON serializable.",
      stage: "ipc",
      retryable: LOCAL_SUBTITLE_ERROR_MANIFEST.invalid_ipc_request.retryable,
    });
  }
  if (frameBytes > maxBytes) {
    return localSubtitleIpcFailure({
      code: "limit_exceeded",
      message: "Local subtitle IPC payload exceeds the versioned frame limit.",
      stage: "ipc",
      retryable: LOCAL_SUBTITLE_ERROR_MANIFEST.limit_exceeded.retryable,
      details: {
        truncated: false,
        metadata: {
          limit: maxBytes,
          observed: frameBytes,
        },
      },
    });
  }

  const result = schema.safeParse(payload);
  if (result.success) return localSubtitleIpcSuccess(result.data);
  return schemaFailure(result.error, "invalid_ipc_request");
}

function schemaFailure(
  error: z.ZodError,
  code: "invalid_ipc_request" | "invalid_content",
): LocalSubtitleIpcResult<never> {
  const firstIssue = error.issues[0];
  const field = firstIssue?.path.map(String).join(".") || undefined;
  return localSubtitleIpcFailure({
    code,
    message: "Local subtitle payload does not match the versioned schema.",
    stage: code === "invalid_ipc_request" ? "ipc" : "post_processing",
    retryable: LOCAL_SUBTITLE_ERROR_MANIFEST[code].retryable,
    ...(field === undefined ? {} : { field }),
  });
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function noUnsafeControlCharacters(value: string): boolean {
  return (
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}
