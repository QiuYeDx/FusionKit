export type RenamePathKind = "file" | "directory" | "other" | "missing";

export type RenameRiskLevel = "normal" | "warning" | "blocked";

export type NameTranslationScope =
  | "self"
  | "children"
  | "descendants"
  | "path_segments";

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
  preserveExtension: boolean;
  preserveLeadingDot: boolean;
  preserveTechnicalTokens: boolean;
  collisionPolicy: NameCollisionPolicy;
  pathSegmentRange?: PathSegmentRange;
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
  preserveExtension: true,
  preserveLeadingDot: true,
  preserveTechnicalTokens: true,
  collisionPolicy: "fail",
};

export interface SelectRenamePathsParams {
  title?: string;
  buttonLabel?: string;
  allowFiles?: boolean;
  allowDirectories?: boolean;
  multiSelections?: boolean;
}

export interface SelectRenamePathsResult {
  canceled: boolean;
  filePaths: string[];
}

export interface InspectRenamePathsParams {
  paths: string[];
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

export interface InspectRenamePathsResult {
  paths: InspectedRenamePath[];
}

export interface ScanRenameTargetsParams {
  options: NameTranslationOptions;
  maxTargets?: number;
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

export interface CheckRenameTargetPathsParams {
  paths: string[];
  concurrency?: number;
}

export interface CheckRenameTargetPathsResult {
  existingPaths: string[];
  errors: Array<{
    path: string;
    message: string;
  }>;
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
  expiresAt?: number;
  options: NameTranslationOptions;
  roots: string[];
  totalTargets: number;
  previewLimit: number;
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

export interface ValidateRenamePlanParams {
  plan: NameTranslationPlan;
  items: NameTranslationPlanItem[];
}

export interface RenamePlanValidationIssue {
  itemId?: string;
  code: string;
  message: string;
}

export interface ValidateRenamePlanResult {
  valid: boolean;
  errors: RenamePlanValidationIssue[];
  warnings: string[];
}

export interface ApplyRenamePlanParams {
  plan: NameTranslationPlan;
  items: NameTranslationPlanItem[];
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

export interface RollbackRenameJournalParams {
  journalId: string;
}

export interface RollbackRenameJournalResult {
  journalId: string;
  successCount: number;
  failedCount: number;
  failures: Array<{ itemId: string; path: string; error: string }>;
}

export type RenameJournalStatus =
  | "running"
  | "completed"
  | "failed"
  | "rolled_back";

export type RenameJournalOperationStatus =
  | "pending"
  | "temp_done"
  | "final_done"
  | "failed"
  | "rolled_back"
  | "rollback_blocked";

export interface RenameJournalOperation {
  itemId: string;
  kind: "file" | "directory";
  originalPath: string;
  tempPath?: string;
  finalPath: string;
  status: RenameJournalOperationStatus;
  error?: string;
}

export interface RenameJournal {
  journalId: string;
  planId: string;
  createdAt: number;
  updatedAt: number;
  status: RenameJournalStatus;
  operations: RenameJournalOperation[];
}
