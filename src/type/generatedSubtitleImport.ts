import type { SubtitleTranslationHandoffMode } from "./localSubtitle";
import type {
  OutputConflictPolicy,
  OutputPathMode,
  SubtitleSliceType,
  TranslationLanguage,
  TranslationOutputMode,
} from "./subtitle";

export type AutomaticSubtitleTranslationHandoffMode = Exclude<
  SubtitleTranslationHandoffMode,
  "export_only"
>;

export type SubtitleTranslationExecutionBindingSummary =
  | Readonly<{
      status: "ready";
      taskProfileId: string;
      taskProfileLabel: string;
    }>
  | Readonly<{ status: "needs_configuration" }>;

export interface SubtitleTranslationImportConfigSummary {
  readonly snapshotId: string;
  readonly createdAt: number;
  readonly handoffMode: AutomaticSubtitleTranslationHandoffMode;
  readonly executionBinding: SubtitleTranslationExecutionBindingSummary;
  readonly sourceLang: TranslationLanguage;
  readonly targetLang: TranslationLanguage;
  readonly translationOutputMode: TranslationOutputMode;
  readonly sliceType: SubtitleSliceType;
  readonly customSliceLength?: number;
  readonly outputMode: OutputPathMode;
  readonly outputDirectoryLabel?: string;
  readonly conflictPolicy: OutputConflictPolicy;
  readonly concurrentSlices: boolean;
  readonly thinkingEnabled?: boolean;
}

export type PrepareGeneratedSubtitleImportResult =
  | Readonly<{
      ok: true;
      snapshot: SubtitleTranslationImportConfigSummary;
      canAutoStart: boolean;
      warnings: readonly string[];
    }>
  | Readonly<{
      ok: false;
      code:
        | "configuration_not_ready"
        | "directory_authorization_required"
        | "profile_required";
      warnings: readonly string[];
    }>;

export type SubtitleTranslationImportStartFailureReason =
  | "estimate_failed"
  | "configuration_required"
  | "profile_unavailable"
  | "authorization_expired"
  | "start_rejected";

export type SubtitleTranslationImportSkipReason =
  | "duplicate"
  | "unsupported_format"
  | "artifact_expired"
  | "artifact_changed"
  | "content_too_large"
  | "invalid_ipc_request"
  | "owner_released"
  | "output_write_failed"
  | "invalid_content";

export interface SubtitleTranslationImportReceipt {
  readonly receiptId: string;
  readonly snapshotId: string;
  readonly addedTaskIds: readonly string[];
  readonly startedTaskIds: readonly string[];
  readonly waitingTaskIds: readonly string[];
  readonly notStartedTaskIds: readonly string[];
  readonly startFailures: readonly Readonly<{
    taskId: string;
    reason: SubtitleTranslationImportStartFailureReason;
  }>[];
  readonly skipped: readonly Readonly<{
    displayName: string;
    reason: SubtitleTranslationImportSkipReason;
  }>[];
}
