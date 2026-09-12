import { z } from "zod";
import { LOCAL_SUBTITLE_LIMITS, LOCAL_SUBTITLE_BACKENDS, LOCAL_SUBTITLE_OPERATION_STAGES, LOCAL_SUBTITLE_ERROR_CODES, LOCAL_SUBTITLE_ERROR_MANIFEST, LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS, LOCAL_SUBTITLE_RESOURCE_TYPES, LOCAL_SUBTITLE_RESOURCE_JOB_STATUSES, LocalSubtitleResourceJobSummary, LocalSubtitleResourceEventEnvelope } from "./contracts";
const idSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxIdChars)
  .refine((value) => value.trim() === value, "Must not have outer whitespace.")
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..", "Must be an opaque id.");

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

const isoTimestampSchema = z.string().datetime({ offset: true });

const safeIntegerSchema = z.number().int().safe();

const positiveSafeIntegerSchema = safeIntegerSchema.positive();

const nonNegativeSafeIntegerSchema = safeIntegerSchema.nonnegative();

const percentageSchema = z.number().finite().min(0).max(100);

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
    modelFormat: boundedMetadataStringSchema.optional(),
    quantization: boundedMetadataStringSchema.optional(),
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
    if (
      value.resourceType !== "model" &&
      (value.modelFormat !== undefined || value.quantization !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelFormat"],
        message: "Only managed models may include model format metadata.",
      });
    }
  });

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

export type LocalSubtitleManagedResourceSummary = z.infer<typeof localSubtitleManagedResourceSummarySchema>;

export const localSubtitleSessionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().safe().nonnegative(),
  batches: z.array(z.never()).max(0),
  resourceJobs: z.array(localSubtitleResourceJobSummarySchema).max(LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs),
}).strict();
