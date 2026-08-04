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
