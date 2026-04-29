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

export type SubtitleTranslatorTask = {
  fileName: string;
  fileContent: string;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  originFileURL: string; // 源文件路径
  targetFileURL: string; // 输出文件路径
  status: TaskStatus; // 任务状态
  totalFragments?: number; // 总分片数
  resolvedFragments?: number; // 已完成的分片数
  progress?: number;
  controller?: AbortController; // 用于任务取消
  costEstimate?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
    fragmentCount: number;
    loading?: boolean;
  }; // 费用预估
  errorLog?: string[]; // 错误日志

  apiKey: string;
  apiModel: string;
  endPoint: string;

  sourceLang?: TranslationLanguage;
  targetLang?: TranslationLanguage;
  translationOutputMode?: TranslationOutputMode;

  extraInfo?: { [key: string]: any };
  conflictPolicy?: OutputConflictPolicy;
  concurrentSlices?: boolean;
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
