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
  checkpointPath?: string;
  completedOutputPath?: string;
  remainingOutputPath?: string;
  errorLogPath?: string;
  resumable?: boolean;
  failedFragmentIndexes?: number[];
  resolvedFragments?: number;
  totalFragments?: number;
};

export type SubtitleTranslatorTask = {
  fileName: string;
  fileContent: string;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  originFileURL: string;
  targetFileURL: string;
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

  apiKey: string;
  apiModel: string;
  endPoint: string;

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
  /** checkpoint 文件路径，续跑时传入主进程 */
  checkpointPath?: string;
};

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
