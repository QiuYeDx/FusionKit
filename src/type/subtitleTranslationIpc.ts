import { z } from "zod";

export const SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS = {
  registerOwnerSession:
    "subtitle-translation:internal:register-owner-session",
  authorizeInputFile:
    "subtitle-translation:internal:authorize-input-file",
  readInputFile:
    "subtitle-translation:internal:read-input-file",
  revokeInputFile:
    "subtitle-translation:internal:revoke-input-file",
  selectAgentInputFiles:
    "subtitle-translation:internal:select-agent-input-files",
  readAgentInputFile:
    "subtitle-translation:internal:read-agent-input-file",
  revokeAgentInputSelection:
    "subtitle-translation:internal:revoke-agent-input-selection",
  registerAgentAuthorizedTask:
    "subtitle-translation:internal:register-agent-authorized-task",
  registerAuthorizedTask:
    "subtitle-translation:internal:register-authorized-task",
  revealTaskSource:
    "subtitle-translation:internal:reveal-task-source",
  selectOutputDirectory:
    "subtitle-translation:internal:select-output-directory",
  revokeOutputDirectory:
    "subtitle-translation:internal:revoke-output-directory",
  reauthorizeTaskTarget:
    "subtitle-translation:internal:reauthorize-task-target",
  acquireImportDirectoryLease:
    "subtitle-translation:internal:acquire-import-directory-lease",
  releaseImportDirectoryLease:
    "subtitle-translation:internal:release-import-directory-lease",
  createGeneratedImportCandidate:
    "subtitle-translation:internal:create-generated-import-candidate",
  commitGeneratedImportCandidate:
    "subtitle-translation:internal:commit-generated-import-candidate",
  releaseGeneratedImportCandidate:
    "subtitle-translation:internal:release-generated-import-candidate",
  releaseGeneratedTask:
    "subtitle-translation:internal:release-generated-task",
} as const;

export type SubtitleTranslationPreloadInternalChannel =
  (typeof SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS)[keyof typeof SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS];

export const SUBTITLE_TRANSLATION_LIMITS = Object.freeze({
  maxOpaqueRefChars: 200,
  maxDisplayLabelChars: 255,
  maxPathChars: 32_768,
  maxIpcFrameBytes: 64 * 1024,
  maxAgentSelectionFiles: 100,
});

export const SUBTITLE_TRANSLATION_ERROR_CODES = [
  "invalid_ipc_request",
  "owner_released",
  "authorization_expired",
  "output_write_failed",
  "invalid_content",
  "task_not_active",
  "task_reference_conflict",
  "artifact_expired",
  "content_too_large",
] as const;

export type SubtitleTranslationErrorCode =
  (typeof SUBTITLE_TRANSLATION_ERROR_CODES)[number];

export interface SubtitleTranslationIpcError {
  readonly code: SubtitleTranslationErrorCode;
  readonly message: string;
  readonly field?: string;
}

export type SubtitleTranslationIpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SubtitleTranslationIpcError };

export interface SubtitleTranslationSecureIpcEnvelope<TPayload = unknown> {
  readonly ownerSessionId: string;
  readonly payload: TPayload;
}

export interface SubtitleTranslationOwnerSessionRegistration {
  readonly ownerSessionId: string;
}

export interface SubtitleTranslationDirectorySelection {
  readonly cancelled: boolean;
  readonly directoryToken?: string;
  readonly displayLabel?: string;
  readonly expiresAt?: number;
}

export interface SubtitleTranslationDirectoryRevocation {
  readonly revoked: boolean;
}

export interface SubtitleTranslationInputFileAuthorization {
  readonly inputToken: string;
  readonly displayName: string;
  readonly expiresAt: number;
}

export interface SubtitleTranslationInputFileRevocation {
  readonly revoked: boolean;
}

export interface SubtitleTranslationInputFileContent {
  readonly displayName: string;
  readonly content: string;
}

export interface SubtitleTranslationAgentInputSelectionItem {
  readonly itemRef: string;
  readonly displayName: string;
}

export type SubtitleTranslationAgentInputSelection =
  | { readonly cancelled: true }
  | {
      readonly cancelled: false;
      readonly selectionRef: string;
      readonly files: readonly SubtitleTranslationAgentInputSelectionItem[];
      readonly expiresAt: number;
    };

export interface SubtitleTranslationAgentInputSelectionRequest {
  readonly selectionRef: string;
  readonly itemRef: string;
}

export interface SubtitleTranslationAgentInputSelectionRevocation {
  readonly revoked: boolean;
}

export interface SubtitleTranslationAgentTaskRegistrationRequest
  extends SubtitleTranslationAgentInputSelectionRequest {
  readonly taskId: string;
  readonly outputMode: "source" | "custom";
  readonly outputFileName: string;
  readonly directoryToken?: string;
}

export interface SubtitleTranslationGeneratedTaskReference {
  readonly kind: "generated_task_v1";
  readonly source: {
    readonly kind: "generated_content";
    readonly displayName: string;
  };
  readonly target: {
    readonly kind: "authorized_directory";
    readonly token: string;
    readonly displayLabel: string;
  };
}

export interface SubtitleTranslationAuthorizedTaskReference {
  readonly kind: "authorized_task_v1";
  readonly source: {
    readonly kind: "authorized_file";
    readonly token: string;
    readonly displayName: string;
  };
  readonly target: {
    readonly kind: "authorized_directory";
    readonly token: string;
    readonly displayLabel: string;
  };
}

export interface SubtitleTranslationLegacyTaskReference {
  readonly kind: "legacy_path_v1";
  readonly originFilePath: string;
  readonly targetDirectoryPath: string;
  readonly checkpointPath?: string;
}

export type SubtitleTranslationTaskReference =
  | SubtitleTranslationAuthorizedTaskReference
  | SubtitleTranslationGeneratedTaskReference
  | SubtitleTranslationLegacyTaskReference;

export interface SubtitleTranslationAuthorizedTaskRegistrationRequest {
  readonly taskId: string;
  readonly inputToken: string;
  readonly outputMode: "source" | "custom";
  readonly outputFileName: string;
  readonly directoryToken?: string;
}

export interface SubtitleTranslationTaskSourceReveal {
  readonly revealed: boolean;
}

export type SubtitleTranslationTaskTargetReauthorization =
  | {
      readonly cancelled: true;
      readonly taskId: string;
    }
  | {
      readonly cancelled: false;
      readonly taskId: string;
      readonly target: SubtitleTranslationGeneratedTaskReference["target"];
      readonly expiresAt: number;
    };

export interface SubtitleTranslationImportDirectoryLease {
  readonly directoryLeaseToken: string;
  readonly displayLabel: string;
  readonly expiresAt: number;
}

export interface SubtitleTranslationGeneratedImportCandidateRequest {
  readonly translationImportToken: string;
  readonly snapshotId: string;
  readonly outputMode: "source" | "custom";
  readonly directoryLeaseToken?: string;
}

export interface SubtitleTranslationGeneratedImportCandidate {
  readonly taskId: string;
  readonly handoffKey: string;
  readonly candidateBinding: string;
  readonly displayName: string;
  readonly format: "SRT" | "LRC";
  readonly content: string;
  readonly reference: SubtitleTranslationGeneratedTaskReference;
}

export interface SubtitleTranslationGeneratedImportCandidateControl {
  readonly taskId: string;
  readonly handoffKey: string;
  readonly candidateBinding: string;
}

export interface SubtitleTranslationRendererApi {
  authorizeInputFile(file: File): Promise<
    SubtitleTranslationIpcResult<SubtitleTranslationInputFileAuthorization>
  >;
  revokeInputFile(
    inputToken: string,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationInputFileRevocation>>;
  readInputFile(
    inputToken: string,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationInputFileContent>>;
  selectAgentInputFiles(): Promise<
    SubtitleTranslationIpcResult<SubtitleTranslationAgentInputSelection>
  >;
  readAgentInputFile(
    request: SubtitleTranslationAgentInputSelectionRequest,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationInputFileContent>>;
  revokeAgentInputSelection(
    selectionRef: string,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationAgentInputSelectionRevocation>>;
  registerAgentAuthorizedTask(
    request: SubtitleTranslationAgentTaskRegistrationRequest,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationAuthorizedTaskReference>>;
  registerAuthorizedTask(
    request: SubtitleTranslationAuthorizedTaskRegistrationRequest,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationAuthorizedTaskReference>>;
  revealTaskSource(
    taskId: string,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationTaskSourceReveal>>;
  selectOutputDirectory(): Promise<
    SubtitleTranslationIpcResult<SubtitleTranslationDirectorySelection>
  >;
  revokeOutputDirectory(
    directoryToken: string,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationDirectoryRevocation>>;
  reauthorizeTaskTarget(
    taskId: string,
  ): Promise<
    SubtitleTranslationIpcResult<SubtitleTranslationTaskTargetReauthorization>
  >;
  acquireImportDirectoryLease(request: {
    readonly directoryToken: string;
    readonly snapshotId: string;
    readonly expiresAt: number;
  }): Promise<SubtitleTranslationIpcResult<SubtitleTranslationImportDirectoryLease>>;
  releaseImportDirectoryLease(
    directoryLeaseToken: string,
  ): Promise<SubtitleTranslationIpcResult<{ readonly released: boolean }>>;
  createGeneratedImportCandidate(
    request: SubtitleTranslationGeneratedImportCandidateRequest,
  ): Promise<SubtitleTranslationIpcResult<SubtitleTranslationGeneratedImportCandidate>>;
  commitGeneratedImportCandidate(
    request: SubtitleTranslationGeneratedImportCandidateControl,
  ): Promise<SubtitleTranslationIpcResult<{ readonly committed: boolean }>>;
  releaseGeneratedImportCandidate(
    request: SubtitleTranslationGeneratedImportCandidateControl,
  ): Promise<SubtitleTranslationIpcResult<{ readonly released: boolean }>>;
  releaseGeneratedTask(
    taskId: string,
  ): Promise<SubtitleTranslationIpcResult<{ readonly released: boolean }>>;
}

const noUnsafeControlCharacters = (value: string) =>
  !/[\u0000-\u001f\u007f]/u.test(value);
const reservedWindowsLeaf =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export const subtitleTranslationOwnerSessionIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );

export const subtitleTranslationTaskIdSchema = z
  .string()
  .min("subtitle-task-x".length)
  .max(160)
  .regex(/^subtitle-task-[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);

export const subtitleTranslationOpaqueRefSchema = z
  .string()
  .min(1)
  .max(SUBTITLE_TRANSLATION_LIMITS.maxOpaqueRefChars)
  .refine((value) => value.trim() === value)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
  .refine((value) => value !== "." && value !== "..");

export const subtitleTranslationDisplayLabelSchema = z
  .string()
  .min(1)
  .max(SUBTITLE_TRANSLATION_LIMITS.maxDisplayLabelChars)
  .refine((value) => value.trim().length > 0)
  .refine(noUnsafeControlCharacters)
  .refine((value) => !/[\\/]/u.test(value));

export const subtitleTranslationOutputLeafSchema =
  subtitleTranslationDisplayLabelSchema
    .refine((value) => value !== "." && value !== "..")
    .refine((value) => !/[. ]$/u.test(value))
    .refine((value) => !reservedWindowsLeaf.test(value));

const legacyPathSchema = z
  .string()
  .min(1)
  .max(SUBTITLE_TRANSLATION_LIMITS.maxPathChars)
  .refine(noUnsafeControlCharacters);
const legacyOriginPathSchema = z.union([z.literal(""), legacyPathSchema]);

export const subtitleTranslationGeneratedTaskReferenceSchema = z
  .object({
    kind: z.literal("generated_task_v1"),
    source: z
      .object({
        kind: z.literal("generated_content"),
        displayName: subtitleTranslationOutputLeafSchema,
      })
      .strict(),
    target: z
      .object({
        kind: z.literal("authorized_directory"),
        token: subtitleTranslationOpaqueRefSchema,
        displayLabel: subtitleTranslationDisplayLabelSchema,
      })
      .strict(),
  })
  .strict();

export const subtitleTranslationAuthorizedTaskReferenceSchema = z
  .object({
    kind: z.literal("authorized_task_v1"),
    source: z
      .object({
        kind: z.literal("authorized_file"),
        token: subtitleTranslationOpaqueRefSchema,
        displayName: subtitleTranslationOutputLeafSchema,
      })
      .strict(),
    target: subtitleTranslationGeneratedTaskReferenceSchema.shape.target,
  })
  .strict();

export const subtitleTranslationLegacyTaskReferenceSchema = z
  .object({
    kind: z.literal("legacy_path_v1"),
    originFilePath: legacyOriginPathSchema,
    targetDirectoryPath: legacyPathSchema,
    checkpointPath: legacyPathSchema.optional(),
  })
  .strict();

export const subtitleTranslationTaskReferenceSchema = z.discriminatedUnion(
  "kind",
  [
    subtitleTranslationAuthorizedTaskReferenceSchema,
    subtitleTranslationGeneratedTaskReferenceSchema,
    subtitleTranslationLegacyTaskReferenceSchema,
  ],
);

export const subtitleTranslationRegisterOwnerRequestSchema = z.object({}).strict();
export const subtitleTranslationAuthorizeInputFileRequestSchema = z
  .object({ filePath: legacyPathSchema })
  .strict();
export const subtitleTranslationRevokeInputFileRequestSchema = z
  .object({ inputToken: subtitleTranslationOpaqueRefSchema })
  .strict();
export const subtitleTranslationReadInputFileRequestSchema = z
  .object({ inputToken: subtitleTranslationOpaqueRefSchema })
  .strict();
export const subtitleTranslationSelectAgentInputFilesRequestSchema = z
  .object({})
  .strict();
export const subtitleTranslationAgentInputSelectionRequestSchema = z
  .object({
    selectionRef: subtitleTranslationOpaqueRefSchema,
    itemRef: subtitleTranslationOpaqueRefSchema,
  })
  .strict();
export const subtitleTranslationRevokeAgentInputSelectionRequestSchema = z
  .object({ selectionRef: subtitleTranslationOpaqueRefSchema })
  .strict();
export const subtitleTranslationRegisterAuthorizedTaskRequestSchema = z
  .object({
    taskId: subtitleTranslationTaskIdSchema,
    inputToken: subtitleTranslationOpaqueRefSchema,
    outputMode: z.enum(["source", "custom"]),
    outputFileName: subtitleTranslationOutputLeafSchema,
    directoryToken: subtitleTranslationOpaqueRefSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.outputMode === "custom") !== Boolean(value.directoryToken)) {
      context.addIssue({
        code: "custom",
        message: "Custom output requires exactly one directory authority.",
      });
    }
  });
export const subtitleTranslationRegisterAgentAuthorizedTaskRequestSchema =
  subtitleTranslationAgentInputSelectionRequestSchema
    .extend({
      taskId: subtitleTranslationTaskIdSchema,
      outputMode: z.enum(["source", "custom"]),
      outputFileName: subtitleTranslationOutputLeafSchema,
      directoryToken: subtitleTranslationOpaqueRefSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.outputMode === "custom") !== Boolean(value.directoryToken)) {
        context.addIssue({
          code: "custom",
          message: "Custom output requires exactly one directory authority.",
        });
      }
    });
export const subtitleTranslationRevealTaskSourceRequestSchema = z
  .object({ taskId: subtitleTranslationTaskIdSchema })
  .strict();
export const subtitleTranslationSelectDirectoryRequestSchema = z.object({}).strict();
export const subtitleTranslationRevokeDirectoryRequestSchema = z
  .object({ directoryToken: subtitleTranslationOpaqueRefSchema })
  .strict();
export const subtitleTranslationReauthorizeTaskTargetRequestSchema = z
  .object({ taskId: subtitleTranslationTaskIdSchema })
  .strict();
export const subtitleTranslationAcquireImportDirectoryLeaseRequestSchema = z
  .object({
    directoryToken: subtitleTranslationOpaqueRefSchema,
    snapshotId: subtitleTranslationOpaqueRefSchema,
    expiresAt: z.number().int().safe().positive(),
  })
  .strict();
export const subtitleTranslationReleaseImportDirectoryLeaseRequestSchema = z
  .object({ directoryLeaseToken: subtitleTranslationOpaqueRefSchema })
  .strict();
export const subtitleTranslationCreateGeneratedImportCandidateRequestSchema = z
  .object({
    localOwnerSessionId: subtitleTranslationOwnerSessionIdSchema,
    translationImportToken: subtitleTranslationOpaqueRefSchema,
    snapshotId: subtitleTranslationOpaqueRefSchema,
    outputMode: z.enum(["source", "custom"]),
    directoryLeaseToken: subtitleTranslationOpaqueRefSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.outputMode === "custom") !== Boolean(value.directoryLeaseToken)) {
      context.addIssue({
        code: "custom",
        message: "Custom output requires exactly one private directory lease.",
      });
    }
  });
export const subtitleTranslationGeneratedImportCandidateControlSchema = z
  .object({
    taskId: subtitleTranslationTaskIdSchema,
    handoffKey: subtitleTranslationOpaqueRefSchema,
    candidateBinding: subtitleTranslationOpaqueRefSchema,
  })
  .strict();
export const subtitleTranslationReleaseGeneratedTaskRequestSchema = z
  .object({ taskId: subtitleTranslationTaskIdSchema })
  .strict();

export const subtitleTranslationErrorSchema = z
  .object({
    code: z.enum(SUBTITLE_TRANSLATION_ERROR_CODES),
    message: z.string().min(1).max(512).refine(noUnsafeControlCharacters),
    field: z.string().min(1).max(64).optional(),
  })
  .strict();

export const subtitleTranslationDirectorySelectionSchema = z
  .object({
    cancelled: z.boolean(),
    directoryToken: subtitleTranslationOpaqueRefSchema.optional(),
    displayLabel: subtitleTranslationDisplayLabelSchema.optional(),
    expiresAt: z.number().int().safe().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasAuthorization =
      value.directoryToken !== undefined &&
      value.displayLabel !== undefined &&
      value.expiresAt !== undefined;
    if (value.cancelled === hasAuthorization) {
      context.addIssue({
        code: "custom",
        message: "Cancelled selections must not contain directory authority.",
      });
    }
  });

export const subtitleTranslationDirectoryRevocationSchema = z
  .object({ revoked: z.boolean() })
  .strict();

export const subtitleTranslationInputFileAuthorizationSchema = z
  .object({
    inputToken: subtitleTranslationOpaqueRefSchema,
    displayName: subtitleTranslationOutputLeafSchema,
    expiresAt: z.number().int().safe().positive(),
  })
  .strict();

export const subtitleTranslationInputFileRevocationSchema = z
  .object({ revoked: z.boolean() })
  .strict();

export const subtitleTranslationInputFileContentSchema = z
  .object({
    displayName: subtitleTranslationOutputLeafSchema,
    content: z.string().min(1).max(16 * 1024 * 1024),
  })
  .strict();

export const subtitleTranslationAgentInputSelectionSchema =
  z.discriminatedUnion("cancelled", [
    z.object({ cancelled: z.literal(true) }).strict(),
    z.object({
      cancelled: z.literal(false),
      selectionRef: subtitleTranslationOpaqueRefSchema,
      files: z.array(z.object({
        itemRef: subtitleTranslationOpaqueRefSchema,
        displayName: subtitleTranslationOutputLeafSchema,
      }).strict())
        .min(1)
        .max(SUBTITLE_TRANSLATION_LIMITS.maxAgentSelectionFiles),
      expiresAt: z.number().int().safe().positive(),
    }).strict(),
  ]);

export const subtitleTranslationAgentInputSelectionRevocationSchema = z
  .object({ revoked: z.boolean() })
  .strict();

export const subtitleTranslationTaskSourceRevealSchema = z
  .object({ revealed: z.boolean() })
  .strict();

export const subtitleTranslationTaskTargetReauthorizationSchema =
  z.discriminatedUnion("cancelled", [
    z.object({
      cancelled: z.literal(true),
      taskId: subtitleTranslationTaskIdSchema,
    }).strict(),
    z.object({
      cancelled: z.literal(false),
      taskId: subtitleTranslationTaskIdSchema,
      target: subtitleTranslationGeneratedTaskReferenceSchema.shape.target,
      expiresAt: z.number().int().safe().positive(),
    }).strict(),
  ]);

export const subtitleTranslationImportDirectoryLeaseSchema = z
  .object({
    directoryLeaseToken: subtitleTranslationOpaqueRefSchema,
    displayLabel: subtitleTranslationDisplayLabelSchema,
    expiresAt: z.number().int().safe().positive(),
  })
  .strict();

export const subtitleTranslationGeneratedImportCandidateSchema = z
  .object({
    taskId: subtitleTranslationTaskIdSchema,
    handoffKey: subtitleTranslationOpaqueRefSchema,
    candidateBinding: subtitleTranslationOpaqueRefSchema,
    displayName: subtitleTranslationOutputLeafSchema,
    format: z.enum(["SRT", "LRC"]),
    content: z.string().min(1).max(16 * 1024 * 1024),
    reference: subtitleTranslationGeneratedTaskReferenceSchema,
  })
  .strict();

const subtitleTranslationReleasedSchema = z.object({ released: z.boolean() }).strict();
const subtitleTranslationCommittedSchema = z.object({ committed: z.boolean() }).strict();

export function subtitleTranslationIpcResultSchema<
  TSchema extends z.ZodTypeAny,
>(dataSchema: TSchema) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    z.object({ ok: z.literal(false), error: subtitleTranslationErrorSchema }).strict(),
  ]);
}

export function subtitleTranslationSecureIpcEnvelopeSchema<
  TSchema extends z.ZodTypeAny,
>(payloadSchema: TSchema) {
  return z
    .object({
      ownerSessionId: subtitleTranslationOwnerSessionIdSchema,
      payload: payloadSchema,
    })
    .strict()
    .refine(
      (value) =>
        byteLength(value) <= SUBTITLE_TRANSLATION_LIMITS.maxIpcFrameBytes,
    );
}

export const SUBTITLE_TRANSLATION_INTERNAL_OPERATION_CONTRACTS = {
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.authorizeInputFile]: {
    requestSchema: subtitleTranslationAuthorizeInputFileRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationInputFileAuthorizationSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeInputFile]: {
    requestSchema: subtitleTranslationRevokeInputFileRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationInputFileRevocationSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readInputFile]: {
    requestSchema: subtitleTranslationReadInputFileRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationInputFileContentSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectAgentInputFiles]: {
    requestSchema: subtitleTranslationSelectAgentInputFilesRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationAgentInputSelectionSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readAgentInputFile]: {
    requestSchema: subtitleTranslationAgentInputSelectionRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationInputFileContentSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeAgentInputSelection]: {
    requestSchema: subtitleTranslationRevokeAgentInputSelectionRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationAgentInputSelectionRevocationSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAgentAuthorizedTask]: {
    requestSchema: subtitleTranslationRegisterAgentAuthorizedTaskRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationAuthorizedTaskReferenceSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAuthorizedTask]: {
    requestSchema: subtitleTranslationRegisterAuthorizedTaskRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationAuthorizedTaskReferenceSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskSource]: {
    requestSchema: subtitleTranslationRevealTaskSourceRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationTaskSourceRevealSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory]: {
    requestSchema: subtitleTranslationSelectDirectoryRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationDirectorySelectionSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory]: {
    requestSchema: subtitleTranslationRevokeDirectoryRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationDirectoryRevocationSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.reauthorizeTaskTarget]: {
    requestSchema: subtitleTranslationReauthorizeTaskTargetRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationTaskTargetReauthorizationSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.acquireImportDirectoryLease]: {
    requestSchema: subtitleTranslationAcquireImportDirectoryLeaseRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationImportDirectoryLeaseSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseImportDirectoryLease]: {
    requestSchema: subtitleTranslationReleaseImportDirectoryLeaseRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationReleasedSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.createGeneratedImportCandidate]: {
    requestSchema: subtitleTranslationCreateGeneratedImportCandidateRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationGeneratedImportCandidateSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.commitGeneratedImportCandidate]: {
    requestSchema: subtitleTranslationGeneratedImportCandidateControlSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationCommittedSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedImportCandidate]: {
    requestSchema: subtitleTranslationGeneratedImportCandidateControlSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationReleasedSchema,
    ),
  },
  [SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedTask]: {
    requestSchema: subtitleTranslationReleaseGeneratedTaskRequestSchema,
    resultSchema: subtitleTranslationIpcResultSchema(
      subtitleTranslationReleasedSchema,
    ),
  },
} as const;

export function subtitleTranslationIpcSuccess<T>(
  data: T,
): SubtitleTranslationIpcResult<T> {
  return { ok: true, data };
}

export function subtitleTranslationIpcFailure<T = never>(
  code: SubtitleTranslationErrorCode,
  message: string,
  field?: string,
): SubtitleTranslationIpcResult<T> {
  return {
    ok: false,
    error: { code, message, ...(field ? { field } : {}) },
  };
}

export function parseSubtitleTranslationTaskReference(
  value: unknown,
): SubtitleTranslationTaskReference | undefined {
  const parsed = subtitleTranslationTaskReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
