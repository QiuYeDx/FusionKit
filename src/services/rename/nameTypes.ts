export type NameTranslationScope =
  | "self"
  | "children"
  | "descendants"
  | "path_segments";

export type RenamePathKind = "file" | "directory" | "other" | "missing";

export type RenameRiskLevel = "normal" | "warning" | "blocked";

export type NameTranslationTargetKind = "files" | "directories" | "both";

export type NameCollisionPolicy = "fail" | "append_index";

export type NameTranslationLanguage =
  | "ZH"
  | "JA"
  | "EN"
  | "KO"
  | "FR"
  | "DE"
  | "ES"
  | "RU"
  | "PT";

export type NameTranslationSourceLanguage = "auto" | NameTranslationLanguage;

export type NameNamingStyle =
  | "preserve"
  | "space"
  | "kebab"
  | "snake"
  | "title"
  | "lower";

export type NameOutputMode =
  | "target_only"
  | "bilingual_target_first"
  | "bilingual_original_first";

export interface PathSegmentRange {
  startPath: string;
  endPath: string;
  includeEndFileName: boolean;
}

export interface NameTranslationOptions {
  roots: string[];
  scope: NameTranslationScope;
  targetKind: NameTranslationTargetKind;
  recursive: boolean;
  maxDepth: number;
  includeHidden: boolean;
  includeRoot: boolean;
  sourceLang: NameTranslationSourceLanguage;
  targetLang: NameTranslationLanguage;
  namingStyle: NameNamingStyle;
  outputMode: NameOutputMode;
  bilingualSeparator: string;
  preserveExtension: boolean;
  preserveLeadingDot: boolean;
  preserveTechnicalTokens: boolean;
  collisionPolicy: NameCollisionPolicy;
  pathSegmentRange?: PathSegmentRange;
}

export interface InspectedRenamePath {
  path: string;
  exists: boolean;
  kind: RenamePathKind;
  basename: string;
  parentPath: string;
  directFileCount?: number;
  directDirectoryCount?: number;
  hidden?: boolean;
  symlink?: boolean;
  riskLevel: RenameRiskLevel;
  warnings: string[];
}

export type SelectedPath = InspectedRenamePath;

export type ApplyProgressPhase =
  | "validating"
  | "applying"
  | "rolling_back"
  | "done"
  | "failed";

export interface ApplyProgress {
  phase: ApplyProgressPhase;
  message: string;
}

export type NameTranslationPlanningPhase =
  | "idle"
  | "scanning"
  | "classifying"
  | "translating"
  | "checking_targets"
  | "validating"
  | "storing"
  | "done"
  | "failed"
  | "cancelled";

export interface NameTranslationPlanningMetrics {
  scanDurationMs?: number;
  classifyingDurationMs?: number;
  translationDurationMs?: number;
  translationRequestCount?: number;
  translationBatchCount?: number;
  translationConcurrencyPeak?: number;
  translationCacheHitCount?: number;
  translationFastPathCount?: number;
  pathCheckDurationMs?: number;
  pathCheckRequestCount?: number;
  planBuildDurationMs?: number;
  totalPlanningDurationMs?: number;
}

export interface NameTranslationPlanningProgress {
  phase: NameTranslationPlanningPhase;
  message?: string;
  totalTargets?: number;
  scannedTargets?: number;
  translatableCount?: number;
  translatedCount?: number;
  cacheHitCount?: number;
  fastPathCount?: number;
  activeBatchCount?: number;
  completedBatchCount?: number;
  totalBatchCount?: number;
  retryCount?: number;
  warningCount?: number;
  metrics?: NameTranslationPlanningMetrics;
}

export const DEFAULT_NAME_TRANSLATION_OPTIONS: Omit<
  NameTranslationOptions,
  "roots"
> = {
  scope: "self",
  targetKind: "files",
  recursive: false,
  maxDepth: 1,
  includeHidden: false,
  includeRoot: true,
  sourceLang: "auto",
  targetLang: "ZH",
  namingStyle: "preserve",
  outputMode: "target_only",
  bilingualSeparator: " - ",
  preserveExtension: true,
  preserveLeadingDot: true,
  preserveTechnicalTokens: true,
  collisionPolicy: "fail",
};

export function normalizeNameTranslationOptions(
  input: NameTranslationOptions
): NameTranslationOptions {
  const roots = Array.isArray(input?.roots)
    ? [
        ...new Set(
          input.roots.filter(
            (root) => typeof root === "string" && root.length > 0
          )
        ),
      ]
    : [];
  const next: NameTranslationOptions = {
    ...DEFAULT_NAME_TRANSLATION_OPTIONS,
    ...input,
    roots,
  };

  if (next.scope === "self") {
    return {
      ...next,
      includeRoot: true,
      recursive: false,
      maxDepth: 0,
    };
  }

  if (next.scope === "children") {
    return {
      ...next,
      includeRoot: false,
      recursive: false,
      maxDepth: 1,
    };
  }

  if (next.scope === "descendants") {
    const requestedDepth = Number.isFinite(next.maxDepth)
      ? Math.floor(next.maxDepth)
      : 0;
    return {
      ...next,
      includeRoot: false,
      recursive: true,
      maxDepth: requestedDepth >= 2 ? Math.min(20, requestedDepth) : 5,
    };
  }

  return {
    ...next,
    recursive: false,
    maxDepth: Number.isFinite(next.maxDepth)
      ? Math.max(0, Math.min(20, Math.floor(next.maxDepth)))
      : 0,
  };
}

export interface NameTranslationTarget {
  id: string;
  kind: "file" | "directory";
  absolutePath: string;
  parentPath: string;
  originalName: string;
  stem: string;
  extension: string;
  depthFromRoot: number;
  anchorRoot: string;
  size?: number;
  modifiedAt?: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface ScanRenameTargetsResult {
  targets: NameTranslationTarget[];
  totalCount: number;
  truncated: boolean;
  warnings: string[];
}

export interface CheckRenameTargetPathsResult {
  existingPaths: string[];
  errors: Array<{
    path: string;
    message: string;
  }>;
}

export interface BatchPathCheckResult {
  existingPaths: Set<string>;
  errorPaths: Map<string, string>;
}

export type NamePlanItemStatus =
  | "ready"
  | "unchanged"
  | "skipped"
  | "blocked"
  | "applied"
  | "failed"
  | "rolled_back";

export interface NameTranslationPlanItem {
  id: string;
  targetId: string;
  kind: "file" | "directory";
  sourcePath: string;
  sourceParentPath: string;
  originalName: string;
  translatedStem: string;
  newName: string;
  targetPath: string;
  status: NamePlanItemStatus;
  reason?: string;
  warnings: string[];
}

export interface ClarificationRequired {
  code: string;
  message: string;
  choices?: string[];
}

export interface NameTranslationPlan {
  planId: string;
  createdAt: number;
  expiresAt: number;
  options: NameTranslationOptions;
  roots: string[];
  totalTargets: number;
  previewLimit: number;
  items: NameTranslationPlanItem[];
  itemsPreview: NameTranslationPlanItem[];
  itemsStored: boolean;
  readyCount: number;
  blockedCount: number;
  skippedCount: number;
  unchangedCount: number;
  warnings: string[];
  clarificationRequired?: ClarificationRequired;
  applyable: boolean;
}

export interface NameTranslationPlanSummary {
  planId: string;
  totalTargets: number;
  previewLimit: number;
  itemsPreview: NameTranslationPlanItem[];
  readyCount: number;
  blockedCount: number;
  skippedCount: number;
  unchangedCount: number;
  warnings: string[];
  clarificationRequired?: ClarificationRequired;
  applyable: boolean;
}

export interface NameTranslationModelInputItem {
  id: string;
  kind: "file" | "directory";
  originalName: string;
  stem: string;
  extension: string;
  contextPath?: string;
}

export interface NameTranslationModelOutputItem {
  id: string;
  translatedStem: string;
  confidence?: "high" | "medium" | "low";
  note?: string;
}

export interface ValidateRenamePlanResult {
  valid: boolean;
  errors: Array<{ itemId?: string; code: string; message: string }>;
  warnings: string[];
}

export interface NameTranslationApplyResult {
  planId: string;
  journalId: string;
  startedAt: number;
  finishedAt: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  failures: Array<{
    itemId: string;
    sourcePath: string;
    targetPath: string;
    error: string;
  }>;
}

export interface RollbackRenameJournalResult {
  journalId: string;
  successCount: number;
  failedCount: number;
  failures: Array<{ itemId: string; path: string; error: string }>;
}

export class NameTranslationPlannerError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "NameTranslationPlannerError";
  }
}
