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

export type SubtitleTranslatorTask = {
  fileName: string;
  fileContent: string;
  sliceType: SubtitleSliceType;
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
  }; // 费用预估
  errorLog?: string[]; // 错误日志

  apiKey: string;
  apiModel: string;
  endPoint: string;

  extraInfo?: { [key: string]: any };
  conflictPolicy?: OutputConflictPolicy;
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
  keep: "ZH" | "JA";
  status: TaskStatus;
  progress?: number;
  errorLog?: string[];
  extraInfo?: { [key: string]: any };
  outputFilePath?: string;
  conflictPolicy?: OutputConflictPolicy;
};
