/**
 * 字幕翻译模块 - 类型定义
 *
 * 整个翻译模块的数据流：
 *   渲染进程 --IPC--> TranslationService --创建--> LRC/SRT Translator --调用--> LLM API
 *   翻译结果通过 IPC 事件（update-progress / task-resolved / task-failed）回传给渲染进程
 */

/** 支持的字幕文件格式 */
export enum SubtitleFileType {
  LRC = "LRC",
  SRT = "SRT",
}

/**
 * 分片策略类型，决定每次发送给 LLM 的文本量（token 上限）。
 * 越小的分片精度越高但请求次数更多、费用更高。
 * 具体数值映射见 constants.ts 中的 DEFAULT_SLICE_LENGTH_MAP。
 */
export enum SubtitleSliceType {
  /** 常规模式，单片最大 3000 tokens */
  NORMAL = "NORMAL",
  /** 敏感模式，单片最大 100 tokens，适用于需要高精度翻译的内容 */
  SENSITIVE = "SENSITIVE",
  /** 自定义，由用户自行指定 token 上限 */
  CUSTOM = "CUSTOM",
}

/** 翻译任务的生命周期状态 */
export enum TaskStatus {
  NOT_STARTED = "NotStarted",
  WAITING = "Waiting",
  /** 翻译进行中 */
  PENDING = "Pending",
  /** 翻译成功完成 */
  RESOLVED = "Resolved",
  FAILED = "Failed",
}

/** 输出文件同名冲突策略："overwrite" 直接覆盖 | "index" 自动追加序号 */
export type OutputConflictPolicy = "overwrite" | "index";

/** ISO 639-1 风格的语言代码，用于指定源语言和目标语言 */
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

/** 翻译输出模式："bilingual" 保留原文+译文双语 | "target_only" 仅输出译文 */
export type TranslationOutputMode = "bilingual" | "target_only";

/**
 * 单个字幕翻译任务的完整描述，由渲染进程构建后通过 IPC 发送到主进程。
 * 包含文件信息、API 配置、翻译选项、以及运行时状态（进度/错误日志等）。
 */
export type SubtitleTranslatorTask = {
  fileName: string;
  fileContent: string;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  originFileURL: string;
  /** 输出目录路径（非完整文件路径，文件名由 fileName 决定） */
  targetFileURL: string;
  status: TaskStatus;
  totalFragments?: number;
  resolvedFragments?: number;
  /** 0-100 的百分比进度 */
  progress?: number;
  controller?: AbortController;
  costEstimate?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** 单位：美元 */
    estimatedCost: number;
    fragmentCount: number;
  };
  /** 按时间顺序记录的日志，翻译失败时会随 task-failed 事件发给渲染进程 */
  errorLog?: string[];

  // ---- LLM API 配置 ----
  apiKey: string;
  apiModel: string;
  /** OpenAI 兼容的 chat completions 端点 */
  endPoint: string;

  sourceLang?: TranslationLanguage;
  targetLang?: TranslationLanguage;
  translationOutputMode?: TranslationOutputMode;

  extraInfo?: { [key: string]: any };
  conflictPolicy?: OutputConflictPolicy;
  /** 是否启用分片并发翻译（多个分片同时调用 API） */
  concurrentSlices?: boolean;

  /**
   * 续跑模式（仅由 retry 流程设置）：
   *   - auto:    有可用 checkpoint 则续跑，否则首次执行
   *   - resume:  必须加载 checkpoint，加载失败则报错
   *   - restart: 忽略 checkpoint，全部重新翻译
   */
  recoveryMode?: TranslationRecoveryMode;
  /** 续跑清单文件路径，续跑时由 renderer 传入 */
  checkpointPath?: string;
};

// ─── Recovery & Checkpoint ──────────────────────────────────────────────────

export type TranslationRecoveryMode = "auto" | "resume" | "restart";

export type CheckpointFragmentStatus =
  | "pending"
  | "running"
  | "resolved"
  | "failed";

export type CheckpointFragment = {
  index: number;
  sourceHash: string;
  sourceContent: string;
  translatedContent?: string;
  status: CheckpointFragmentStatus;
  attempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  model?: string;
};

/**
 * 翻译检查点清单，持久化到 `*.fusionkit.resume.json`。
 * 是任务恢复的唯一依据；不包含 apiKey 等敏感信息。
 */
export type TranslationCheckpointManifest = {
  schemaVersion: 1;
  taskId: string;
  status: "running" | "failed" | "cancelled" | "completed";
  createdAt: string;
  updatedAt: string;

  fileName: string;
  sourceFilePath?: string;
  sourceContentHash: string;
  sourceSize?: number;
  sourceMtimeMs?: number;

  outputDir: string;
  finalOutputPath?: string;
  completedOutputPath: string;
  remainingOutputPath: string;
  errorLogPath?: string;

  options: {
    fileType: SubtitleFileType;
    sliceType: SubtitleSliceType;
    customSliceLength?: number;
    sourceLang: string;
    targetLang: string;
    translationOutputMode: "bilingual" | "target_only";
  };

  fragments: CheckpointFragment[];
};

/**
 * 恢复信息摘要，附加到 task-failed / update-progress payload，
 * 也保存在 renderer 端的 SubtitleTranslatorTask.recovery 中。
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
