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
  resolveLocalSubtitleTerminalOutcome,
  type LocalSubtitleBatchSummary,
  type LocalSubtitleError,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleSessionSnapshot,
  type LocalSubtitleTaskEventEnvelope,
  type LocalSubtitleTaskSummary,
  type LocalSubtitleTranscript,
} from "@/type/localSubtitle";

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
  .refine((value) => value.trim() === value, "Must not have outer whitespace.");
const opaqueRefSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxOpaqueRefChars)
  .refine((value) => value.trim() === value, "Must not have outer whitespace.");
const displayNameSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars)
  .refine((value) => value.trim().length > 0, "Must not be blank.")
  .refine(noUnsafeControlCharacters, "Contains an unsupported control character.");
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
    byteSize: nonNegativeSafeIntegerSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxArtifactBytes,
    ),
    cueCount: nonNegativeSafeIntegerSchema.max(
      LOCAL_SUBTITLE_LIMITS.maxArtifactCues,
    ),
    sha256: sha256Schema,
    committedAt: isoTimestampSchema,
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
          value.artifactResults.some(
            (artifact) =>
              artifact.status === "skipped" &&
              artifact.errorCode === "cancelled_after_partial_commit",
          ),
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
    });

const resourceJobSummarySchema = z
  .object({
    jobId: idSchema,
    resourceId: idSchema,
    resourceType: z.enum(LOCAL_SUBTITLE_RESOURCE_TYPES),
    status: z.enum(LOCAL_SUBTITLE_RESOURCE_JOB_STATUSES),
    progress: percentageSchema,
    bytesCompleted: nonNegativeSafeIntegerSchema.optional(),
    bytesTotal: nonNegativeSafeIntegerSchema.optional(),
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
        .array(resourceJobSummarySchema)
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
      job: resourceJobSummarySchema,
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
    value.words?.forEach((word, index) => {
      if (word.startMs < value.startMs || word.endMs > value.endMs) {
        context.addIssue({
          code: "custom",
          path: ["words", index],
          message: "Word timestamps must stay inside their segment.",
        });
      }
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
      let previousStartMs = -1;
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
        if (segment.startMs < previousStartMs) {
          context.addIssue({
            code: "custom",
            path: ["segments", index, "startMs"],
            message: "Segments must be ordered by startMs.",
          });
        }
        if (segment.endMs > value.source.durationMs) {
          context.addIssue({
            code: "custom",
            path: ["segments", index, "endMs"],
            message: "Segments must stay inside source duration.",
          });
        }
        previousStartMs = segment.startMs;
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
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
