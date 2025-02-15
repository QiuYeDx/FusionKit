export enum SubtitleFileType {
  LRC = "LRC",
  SRT = "SRT",
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

export type SubtitleTranslatorTask = {
  fileName: string;
  // fileType: SubtitleFileType;
  sliceType: SubtitleSliceType;
  originFileURL: string; // 源文件路径
  targetFileURL: string; // 输出文件路径
  status: TaskStatus; // 任务状态
  totalFragments?: number; // 总分片数
  resolvedFragments?: number; // 已完成的分片数
  progress?: number;
  controller?: AbortController; // 用于任务取消
  costEstimate?: number; // 费用预估
  errorLog?: string[]; // 错误日志

  apiKey: string;
  apiModel: string;
  endPoint: string;

  extraInfo?: { [key: string]: any };
};
