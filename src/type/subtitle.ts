import type { ModelApiFormat, OutputTokenParameter } from "@/type/model";
import type {
  SubtitleTranslationAuthorizedTaskReference,
  SubtitleTranslationGeneratedTaskReference,
  SubtitleTranslationPreparedRecoveredTask,
  SubtitleTranslationRecoveryCandidateSummary,
  SubtitleTranslationRecoveryScanSelection,
} from "./subtitleTranslationIpc";

export enum SubtitleFileType {
  LRC = "LRC",
  SRT = "SRT",
  VTT = "VTT",
}

export enum SubtitleSliceType {
  NORMAL = "NORMAL",
  SENSITIVE = "SENSITIVE",
  CUSTOM = "CUSTOM",
}

export enum TaskStatus {
  NOT_STARTED = "NotStarted",
  WAITING = "Waiting",
  PENDING = "Pending",
  RESOLVED = "Resolved",
  FAILED = "Failed",
}

export type OutputConflictPolicy = "overwrite" | "index";
export type OutputPathMode = "custom" | "source";

export type TranslationLanguage =
  | "ZH"
  | "JA"
  | "EN"
  | "KO"
  | "FR"
  | "DE"
  | "ES"
  | "RU"
  | "PT";

export type TranslationOutputMode = "bilingual" | "target_only";

export type SubtitleModelApiFormat = ModelApiFormat;
export type SubtitleOutputTokenParameter = OutputTokenParameter;

export type SubtitleTaskReadyExecutionBinding = Readonly<{
  status: "ready";
  profileId: string;
  profileLabel: string;
  apiKey: string;
  apiModel: string;
  endPoint: string;
  apiFormat?: SubtitleModelApiFormat;
  outputTokenParameter?: SubtitleOutputTokenParameter;
  maxOutputTokens?: number;
  thinkingEnabled?: boolean;
}>;

export type SubtitleTaskExecutionBinding =
  | SubtitleTaskReadyExecutionBinding
  | Readonly<{ status: "needs_configuration" }>;

export const SUPPORTED_LANGUAGES: {
  code: TranslationLanguage;
  labelKey: string;
}[] = [
  { code: "ZH", labelKey: "subtitle:translator.languages.ZH" },
  { code: "JA", labelKey: "subtitle:translator.languages.JA" },
  { code: "EN", labelKey: "subtitle:translator.languages.EN" },
  { code: "KO", labelKey: "subtitle:translator.languages.KO" },
  { code: "FR", labelKey: "subtitle:translator.languages.FR" },
  { code: "DE", labelKey: "subtitle:translator.languages.DE" },
  { code: "ES", labelKey: "subtitle:translator.languages.ES" },
  { code: "RU", labelKey: "subtitle:translator.languages.RU" },
  { code: "PT", labelKey: "subtitle:translator.languages.PT" },
];

/** 语言提取工具支持的目标语言（复用 TranslationLanguage） */
export type ExtractKeepLanguage = TranslationLanguage;

/** 提取工具可选语言列表，复用翻译器的 i18n key */
export const EXTRACT_SUPPORTED_LANGUAGES: {
  code: ExtractKeepLanguage;
  labelKey: string;
}[] = [
  { code: "ZH", labelKey: "subtitle:translator.languages.ZH" },
  { code: "JA", labelKey: "subtitle:translator.languages.JA" },
  { code: "EN", labelKey: "subtitle:translator.languages.EN" },
  { code: "KO", labelKey: "subtitle:translator.languages.KO" },
  { code: "FR", labelKey: "subtitle:translator.languages.FR" },
  { code: "DE", labelKey: "subtitle:translator.languages.DE" },
  { code: "ES", labelKey: "subtitle:translator.languages.ES" },
  { code: "RU", labelKey: "subtitle:translator.languages.RU" },
  { code: "PT", labelKey: "subtitle:translator.languages.PT" },
];

/**
 * 续跑模式：
 *   - auto:    有可用 checkpoint 则续跑，否则首次执行
 *   - resume:  必须加载 checkpoint
 *   - restart: 忽略 checkpoint，重新翻译
 */
export type TranslationRecoveryMode = "auto" | "resume" | "restart";

/**
 * 恢复信息摘要，由 task-failed / update-progress 事件携带，
 * 保存在 SubtitleTranslatorTask.recovery 中供 UI 使用。
 */
export type SubtitleTranslationRecovery = {
  checkpointRef?: string;
  resumable?: boolean;
  failedFragmentIndexes?: number[];
  resolvedFragments?: number;
  totalFragments?: number;
};

export type TranslationRecoveryInputMode =
  | "source_file"
  | "manifest_fragments";

export type SubtitleTranslatorTask = {
  taskId: string;
  fileName: string;
  fileContent: string;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  status: TaskStatus;
  totalFragments?: number;
  resolvedFragments?: number;
  progress?: number;
  controller?: AbortController;
  costEstimate?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
    fragmentCount: number;
    loading?: boolean;
  };
  errorLog?: string[];

  executionBinding: SubtitleTaskExecutionBinding;

  sourceLang?: TranslationLanguage;
  targetLang?: TranslationLanguage;
  translationOutputMode?: TranslationOutputMode;

  extraInfo?: { [key: string]: any };
  conflictPolicy?: OutputConflictPolicy;
  concurrentSlices?: boolean;

  /** 续跑恢复信息（失败任务携带，用于续跑重试） */
  recovery?: SubtitleTranslationRecovery;
  /** 续跑模式，仅在重试时设置 */
  recoveryMode?: TranslationRecoveryMode;
  /** Owner-bound opaque checkpoint authority. */
  checkpointRef?: string;
  /** 恢复输入模式：source_file 依赖源文件分片，manifest_fragments 直接使用 manifest 中的分片 */
  recoveryInputMode?: TranslationRecoveryInputMode;
  /** Path-free authority for newly selected or generated subtitle tasks. */
  taskReference?:
    | SubtitleTranslationAuthorizedTaskReference
    | SubtitleTranslationGeneratedTaskReference;
};

export type TranslationRecoveryCandidate =
  SubtitleTranslationRecoveryCandidateSummary;
export type TranslationRecoveryScanResult = Exclude<
  SubtitleTranslationRecoveryScanSelection,
  { cancelled: true }
>;
export type RecoveredSubtitleTaskDraft = SubtitleTranslationPreparedRecoveredTask;

export type SubtitleConverterTask = {
  fileName: string;
  fileContent: string;
  from: SubtitleFileType;
  to: SubtitleFileType;
  originFileURL: string;
  targetFileURL: string;
  status: TaskStatus;
  progress?: number;
  errorLog?: string[];
  extraInfo?: { [key: string]: any };
  outputFilePath?: string;
  conflictPolicy?: OutputConflictPolicy;
};

export type SubtitleExtractorTask = {
  fileName: string;
  fileContent: string;
  fileType: SubtitleFileType;
  originFileURL: string;
  targetFileURL: string;
  keep: ExtractKeepLanguage;
  status: TaskStatus;
  progress?: number;
  errorLog?: string[];
  extraInfo?: { [key: string]: any };
  outputFilePath?: string;
  conflictPolicy?: OutputConflictPolicy;
};
