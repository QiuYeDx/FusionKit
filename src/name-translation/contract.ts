import { z } from "zod";

/**
 * Shared protocol between the name translator renderer and the main-process
 * name-translation module. Renderer code reaches these channels only through
 * the fixed `window.nameTranslation` preload API.
 */
export const NAME_TRANSLATION_CHANNELS = {
  selectPaths: "name-translation:select-paths",
  inspectPaths: "name-translation:inspect-paths",
  listDirectory: "name-translation:list-directory",
  collectDescendants: "name-translation:collect-descendants",
  translate: "name-translation:translate",
  cancelTranslate: "name-translation:cancel-translate",
  preflight: "name-translation:preflight",
  apply: "name-translation:apply",
  undo: "name-translation:undo",
  listJournals: "name-translation:list-journals",
  dismissJournal: "name-translation:dismiss-journal",
} as const;

export type NameTranslationChannel =
  (typeof NAME_TRANSLATION_CHANNELS)[keyof typeof NAME_TRANSLATION_CHANNELS];

export const NAME_TRANSLATION_CHANNEL_PREFIX = "name-translation:";

export const NAME_TRANSLATION_LIMITS = Object.freeze({
  maxInputPaths: 500,
  maxPathChars: 32_768,
  maxDirectoryEntries: 5_000,
  maxCollectedEntries: 20_000,
  maxRenameItems: 20_000,
  maxTranslateItems: 80,
  maxTranslateChars: 12_000,
  maxInstructionsChars: 1_000,
  maxNameChars: 255,
  maxNameBytes: 255,
});

export const NAME_LANGUAGES = [
  "ZH",
  "ZH_HANT",
  "JA",
  "EN",
  "KO",
  "FR",
  "DE",
  "ES",
  "RU",
  "PT",
] as const;
export type NameLanguage = (typeof NAME_LANGUAGES)[number];
export type NameSourceLanguage = "auto" | NameLanguage;

export type NameEntryKind = "file" | "directory";

export interface NameEntry {
  /** Canonical absolute path produced by the main process. */
  readonly path: string;
  readonly name: string;
  readonly parentPath: string;
  readonly kind: NameEntryKind;
  readonly hidden: boolean;
  readonly symlink: boolean;
  /** `dev:ino` from a bigint lstat, used to detect replaced entries. */
  readonly identity: string;
}

export type NameInspectRejectReason =
  | "missing"
  | "protected"
  | "temp_proxy"
  | "unsupported"
  | "unreadable";

export interface NameInspectRejection {
  readonly path: string;
  readonly reason: NameInspectRejectReason;
}

export interface InspectNamePathsResult {
  readonly entries: readonly NameEntry[];
  readonly rejected: readonly NameInspectRejection[];
}

export interface NameDirectoryListing {
  readonly path: string;
  readonly entries: readonly NameEntry[];
  readonly truncated: boolean;
  readonly error?: string;
}

export interface CollectNameDescendantsResult {
  readonly directories: readonly NameDirectoryListing[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface SelectNamePathsResult {
  readonly canceled: boolean;
  readonly paths: readonly string[];
}

export interface NameTranslationRuntimeModel {
  readonly profileId?: string;
  readonly apiKey: string;
  readonly modelKey: string;
  readonly endpoint: string;
  readonly apiFormat?: "chat_completions" | "responses";
  readonly outputTokenParameter?: "max_tokens" | "max_completion_tokens";
}

export interface NameTranslateItem {
  readonly id: string;
  /** Name stem without the file extension. */
  readonly name: string;
  readonly kind: NameEntryKind;
  /** Last folder segments for context, e.g. "アニメ/第1期". */
  readonly context?: string;
}

export interface NameTranslateRequest {
  readonly requestId: string;
  readonly model: NameTranslationRuntimeModel;
  readonly sourceLang: NameSourceLanguage;
  readonly targetLang: NameLanguage;
  readonly instructions?: string;
  readonly items: readonly NameTranslateItem[];
}

export interface NameTranslateResult {
  readonly items: readonly { readonly id: string; readonly name: string }[];
  readonly failedIds: readonly string[];
}

export interface NameRenameItem {
  readonly path: string;
  readonly kind: NameEntryKind;
  readonly identity: string;
  readonly newName: string;
}

export type NameIssueCode =
  | "empty_name"
  | "illegal_chars"
  | "reserved_name"
  | "trailing_dot_space"
  | "too_long"
  | "duplicate_target"
  | "target_exists"
  | "source_missing"
  | "source_changed"
  | "protected_path"
  | "duplicate_source";

export type NamePreflightStatus = "ready" | "unchanged" | "issue";

export interface NamePreflightItem {
  readonly path: string;
  readonly status: NamePreflightStatus;
  readonly issue?: NameIssueCode;
}

export interface NamePreflightResult {
  readonly items: readonly NamePreflightItem[];
  readonly readyCount: number;
  readonly issueCount: number;
}

export interface NameRenamedEntry {
  readonly from: string;
  readonly to: string;
  readonly kind: NameEntryKind;
}

export interface NameUnrecoveredEntry {
  /** Where the entry currently is on disk. */
  readonly currentPath: string;
  /** Where it was expected to be restored to. */
  readonly expectedPath: string;
  readonly message: string;
}

export type NameApplyResult =
  | {
      readonly status: "completed";
      readonly journalId: string;
      readonly renamed: readonly NameRenamedEntry[];
    }
  | {
      readonly status: "rejected";
      readonly preflight: NamePreflightResult;
    }
  | {
      readonly status: "failed";
      readonly journalId?: string;
      readonly failedPath: string;
      readonly message: string;
      readonly rollback: "complete" | "partial";
      readonly unrecovered: readonly NameUnrecoveredEntry[];
    };

export type NameJournalStatus =
  | "running"
  | "completed"
  | "failed"
  | "rolled_back"
  | "undone"
  | "undo_partial"
  | "dismissed";

export interface NameJournalSummary {
  readonly journalId: string;
  readonly createdAt: number;
  readonly status: NameJournalStatus;
  readonly itemCount: number;
  readonly stepCount: number;
  readonly undoneCount: number;
}

export interface NameUndoResult {
  readonly status: "completed" | "partial";
  readonly restoredCount: number;
  readonly failures: readonly NameUnrecoveredEntry[];
}

export type NameTranslationErrorCode =
  | "invalid_request"
  | "model_auth"
  | "model_quota"
  | "model_not_found"
  | "model_failed"
  | "model_incomplete"
  | "cancelled"
  | "too_many_entries"
  | "journal_not_found"
  | "busy"
  | "internal";

export interface NameTranslationError {
  readonly code: NameTranslationErrorCode;
  readonly message: string;
}

export type NameTranslationIpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: NameTranslationError };

export interface NameTranslationRendererApi {
  selectPaths(request: {
    kind: NameEntryKind;
    title?: string;
  }): Promise<NameTranslationIpcResult<SelectNamePathsResult>>;
  inspectPaths(request: {
    paths: readonly string[];
    source: "picker" | "drop" | "agent";
  }): Promise<NameTranslationIpcResult<InspectNamePathsResult>>;
  listDirectory(request: {
    path: string;
    includeHidden: boolean;
  }): Promise<NameTranslationIpcResult<NameDirectoryListing>>;
  collectDescendants(request: {
    path: string;
    includeHidden: boolean;
  }): Promise<NameTranslationIpcResult<CollectNameDescendantsResult>>;
  translate(
    request: NameTranslateRequest,
  ): Promise<NameTranslationIpcResult<NameTranslateResult>>;
  cancelTranslate(request: {
    requestId: string;
  }): Promise<NameTranslationIpcResult<{ cancelled: boolean }>>;
  preflight(request: {
    items: readonly NameRenameItem[];
  }): Promise<NameTranslationIpcResult<NamePreflightResult>>;
  apply(request: {
    items: readonly NameRenameItem[];
  }): Promise<NameTranslationIpcResult<NameApplyResult>>;
  undo(request: {
    journalId: string;
  }): Promise<NameTranslationIpcResult<NameUndoResult>>;
  listJournals(): Promise<
    NameTranslationIpcResult<{ journals: readonly NameJournalSummary[] }>
  >;
  dismissJournal(request: {
    journalId: string;
  }): Promise<NameTranslationIpcResult<{ dismissed: boolean }>>;
}

// ---------------------------------------------------------------------------
// Request schemas (validated in the main process)
// ---------------------------------------------------------------------------

const pathSchema = z
  .string()
  .min(1)
  .max(NAME_TRANSLATION_LIMITS.maxPathChars)
  .refine((value) => !value.includes("\0"), "path contains NUL");

const kindSchema = z.enum(["file", "directory"]);
const languageSchema = z.enum(NAME_LANGUAGES);

export const selectPathsRequestSchema = z
  .object({ kind: kindSchema, title: z.string().max(200).optional() })
  .strict();

export const inspectPathsRequestSchema = z
  .object({
    paths: z.array(pathSchema).min(1).max(NAME_TRANSLATION_LIMITS.maxInputPaths),
    source: z.enum(["picker", "drop", "agent"]),
  })
  .strict();

export const directoryRequestSchema = z
  .object({ path: pathSchema, includeHidden: z.boolean() })
  .strict();

export const runtimeModelSchema = z
  .object({
    profileId: z.string().max(200).optional(),
    apiKey: z.string().min(1).max(4_096),
    modelKey: z.string().min(1).max(512),
    endpoint: z.string().min(1).max(2_048),
    apiFormat: z.enum(["chat_completions", "responses"]).optional(),
    outputTokenParameter: z
      .enum(["max_tokens", "max_completion_tokens"])
      .optional(),
  })
  .strict();

export const translateRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    model: runtimeModelSchema,
    sourceLang: z.union([z.literal("auto"), languageSchema]),
    targetLang: languageSchema,
    instructions: z
      .string()
      .max(NAME_TRANSLATION_LIMITS.maxInstructionsChars)
      .optional(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(32),
            name: z.string().min(1).max(1_024),
            kind: kindSchema,
            context: z.string().max(1_024).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(NAME_TRANSLATION_LIMITS.maxTranslateItems),
  })
  .strict();

export const cancelTranslateRequestSchema = z
  .object({ requestId: z.string().min(1).max(128) })
  .strict();

export const renameItemsRequestSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            path: pathSchema,
            kind: kindSchema,
            identity: z.string().min(1).max(128),
            newName: z.string().max(1_024),
          })
          .strict(),
      )
      .min(1)
      .max(NAME_TRANSLATION_LIMITS.maxRenameItems),
  })
  .strict();

export const journalRequestSchema = z
  .object({ journalId: z.string().regex(/^[a-z0-9_-]{8,80}$/i) })
  .strict();
