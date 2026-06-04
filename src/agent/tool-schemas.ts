import { z } from "zod";
import { DEFAULT_QUEUE_BATCH_SIZE, MAX_QUEUE_BATCH_SIZE } from "./queue-batch";

// ---------------------------------------------------------------------------
// Agent 工具入参 Schema（精简版）
// 设计原则：参数尽量扁平，LLM 只需提供最少信息即可调用
// ---------------------------------------------------------------------------

/** scan_subtitle_files — 扫描目录中的字幕文件 */
export const scanSubtitleFilesSchema = z.object({
  directories: z
    .array(z.string())
    .min(1)
    .describe("Absolute directory paths to scan"),
  extensions: z
    .array(z.string())
    .default(["LRC", "SRT", "VTT"])
    .describe(
      "File extensions to include (uppercase). Default: all subtitle formats"
    ),
  recursive: z.boolean().default(true).describe("Scan subdirectories"),
});

/** queue_subtitle_translate_tasks — 将文件加入翻译队列 */
export const queueTranslateSchema = z.object({
  filePaths: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Absolute paths of subtitle files to translate. Use this only for small explicit file lists; for scan results, prefer scanId + batchStart + batchSize."
    ),
  scanId: z
    .string()
    .optional()
    .describe("scanId returned by scan_subtitle_files. Use this for batch queueing large scan results."),
  batchStart: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Zero-based start index within the scan result when scanId is used."),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUEUE_BATCH_SIZE)
    .default(DEFAULT_QUEUE_BATCH_SIZE)
    .describe(`Number of files to queue from scanId. Default ${DEFAULT_QUEUE_BATCH_SIZE}; max ${MAX_QUEUE_BATCH_SIZE}.`),
  sliceType: z
    .enum(["NORMAL", "SENSITIVE", "CUSTOM"])
    .default("NORMAL")
    .describe(
      "Translation slice strategy. Use CUSTOM when the user gives an explicit slice length, token/chunk limit, or phrases like 按照1200分词 / 每片1200 / 1200 tokens."
    ),
  customSliceLength: z
    .number()
    .int()
    .min(100)
    .max(2000)
    .optional()
    .describe(
      "Custom translation slice length. Set this to the explicit number from the user when they request custom slicing, e.g. 按照1200分词 -> customSliceLength=1200 and sliceType=CUSTOM."
    ),
  sourceLang: z
    .enum(["ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .default("JA")
    .describe("Source language code. Default: JA (Japanese)"),
  targetLang: z
    .enum(["ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .default("ZH")
    .describe("Target language code. Default: ZH (Chinese)"),
  translationOutputMode: z
    .enum(["bilingual", "target_only"])
    .default("bilingual")
    .describe("'bilingual' = keep source + target lines, 'target_only' = only translated text"),
  outputMode: z
    .enum(["source", "custom"])
    .default("source")
    .describe("'source' = save next to original, 'custom' = use outputDir"),
  outputDir: z
    .string()
    .optional()
    .describe("Output directory (required when outputMode is 'custom')"),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .default("index")
    .describe(
      "How to handle filename conflicts. 'index' = append numeric suffix (e.g. file_1.srt), 'overwrite' = replace existing file. Default: 'index'. Use 'overwrite' only when the user explicitly requests overwriting / replacing existing files."
    ),
  concurrentSlices: z
    .boolean()
    .default(true)
    .describe(
      "Whether to translate slices concurrently for faster speed. Default: true. Set to false only when the user explicitly requests sequential / non-concurrent / 串行 / 不要并发 / 逐条 processing."
    ),
});

/** queue_subtitle_convert_tasks — 将文件加入格式转换队列 */
export const queueConvertSchema = z.object({
  filePaths: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Absolute paths of subtitle files to convert. Use this only for small explicit file lists; for scan results, prefer scanId + batchStart + batchSize."
    ),
  scanId: z
    .string()
    .optional()
    .describe("scanId returned by scan_subtitle_files. Use this for batch queueing large scan results."),
  batchStart: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Zero-based start index within the scan result when scanId is used."),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUEUE_BATCH_SIZE)
    .default(DEFAULT_QUEUE_BATCH_SIZE)
    .describe(`Number of files to queue from scanId. Default ${DEFAULT_QUEUE_BATCH_SIZE}; max ${MAX_QUEUE_BATCH_SIZE}.`),
  to: z
    .enum(["LRC", "SRT", "VTT"])
    .describe("Target subtitle format"),
  outputMode: z
    .enum(["source", "custom"])
    .default("source")
    .describe("'source' = save next to original, 'custom' = use outputDir"),
  outputDir: z
    .string()
    .optional()
    .describe("Output directory (required when outputMode is 'custom')"),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .default("index")
    .describe(
      "How to handle filename conflicts. 'index' = append numeric suffix (e.g. file_1.srt), 'overwrite' = replace existing file. Default: 'index'. Use 'overwrite' only when the user explicitly requests overwriting / replacing existing files."
    ),
});

/** queue_subtitle_extract_tasks — 将文件加入语言提取队列 */
export const queueExtractSchema = z.object({
  filePaths: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Absolute paths of subtitle files to extract from. Use this only for small explicit file lists; for scan results, prefer scanId + batchStart + batchSize."
    ),
  scanId: z
    .string()
    .optional()
    .describe("scanId returned by scan_subtitle_files. Use this for batch queueing large scan results."),
  batchStart: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Zero-based start index within the scan result when scanId is used."),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUEUE_BATCH_SIZE)
    .default(DEFAULT_QUEUE_BATCH_SIZE)
    .describe(`Number of files to queue from scanId. Default ${DEFAULT_QUEUE_BATCH_SIZE}; max ${MAX_QUEUE_BATCH_SIZE}.`),
  keep: z
    .enum(["ZH", "JA"])
    .default("ZH")
    .describe("Which language to keep from bilingual subtitles"),
  outputMode: z
    .enum(["source", "custom"])
    .default("source")
    .describe("'source' = save next to original, 'custom' = use outputDir"),
  outputDir: z
    .string()
    .optional()
    .describe("Output directory (required when outputMode is 'custom')"),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .default("index")
    .describe(
      "How to handle filename conflicts. 'index' = append numeric suffix (e.g. file_1.srt), 'overwrite' = replace existing file. Default: 'index'. Use 'overwrite' only when the user explicitly requests overwriting / replacing existing files."
    ),
});

/** inspect_rename_paths — 检查名称翻译/重命名路径 */
export const inspectRenamePathsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .describe("Absolute file or directory paths to inspect for name translation / rename."),
});

/** create_name_translation_plan — 创建名称翻译 dry-run 计划 */
export const createNameTranslationPlanSchema = z.object({
  roots: z
    .array(z.string())
    .min(1)
    .describe("Absolute file or directory paths provided by the user."),
  scope: z
    .enum(["self", "children", "descendants", "path_segments"])
    .default("self")
    .describe(
      "Rename scope. Use self for the selected basename, children for direct children, descendants only when the user explicitly requests recursion, path_segments only for explicit path-segment renaming."
    ),
  targetKind: z
    .enum(["files", "directories", "both"])
    .default("files")
    .describe("Which target kinds to rename."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Whether to include nested descendants. Must be true only when recursion is explicit."),
  maxDepth: z.number().int().min(0).max(20).default(1),
  includeHidden: z.boolean().default(false),
  includeRoot: z
    .boolean()
    .default(true)
    .describe("Whether to include the root path itself when scope allows it."),
  sourceLang: z
    .enum(["auto", "ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .default("auto"),
  targetLang: z
    .enum(["ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .default("ZH"),
  namingStyle: z
    .enum(["preserve", "space", "kebab", "snake", "title", "lower"])
    .default("preserve"),
  collisionPolicy: z
    .enum(["fail", "append_index"])
    .default("fail")
    .describe("Default fail. Use append_index only when the user explicitly accepts indexed names."),
  pathSegmentStartPath: z
    .string()
    .optional()
    .describe("Required when scope=path_segments: the path segment where translation starts."),
  pathSegmentEndPath: z
    .string()
    .optional()
    .describe("Required when scope=path_segments: the path segment where translation ends."),
  includeEndFileName: z.boolean().default(true),
});

/** apply_name_translation_plan — 应用已确认的名称翻译计划 */
export const applyNameTranslationPlanSchema = z.object({
  planId: z.string().min(1).describe("Plan id returned by create_name_translation_plan."),
  confirmationText: z
    .string()
    .optional()
    .describe("The user's latest explicit confirmation text, if available."),
});

/** scan_subtitle_recovery_tasks — 扫描恢复清单 */
export const scanSubtitleRecoveryTasksSchema = z.object({
  roots: z
    .array(z.string())
    .optional()
    .describe("Absolute directories to scan for *.fusionkit.resume.json."),
  checkpointPaths: z
    .array(z.string())
    .optional()
    .describe("Explicit *.fusionkit.resume.json file paths to inspect."),
  useCurrentOutputDir: z
    .boolean()
    .default(false)
    .describe(
      "Use current subtitle translator output directory when user asks to scan previous output without giving a path.",
    ),
  recursive: z.boolean().default(true),
  maxDepth: z.number().int().min(0).max(12).default(8),
  maxFiles: z.number().int().min(1).max(500).default(500),
  includeCompleted: z.boolean().default(false),
});

/** queue_recovered_subtitle_translate — 把恢复候选加入翻译队列 */
export const queueRecoveredSubtitleTranslateSchema = z.object({
  recoveryScanId: z
    .string()
    .optional()
    .describe("recoveryScanId returned by scan_subtitle_recovery_tasks."),
  checkpointPaths: z
    .array(z.string())
    .optional()
    .describe("Explicit checkpoint paths. Use only for small explicit lists."),
  candidateIds: z
    .array(z.string())
    .optional()
    .describe("Specific candidate ids from a recovery scan preview."),
  batchStart: z.number().int().min(0).default(0),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUEUE_BATCH_SIZE)
    .default(DEFAULT_QUEUE_BATCH_SIZE),
  recoverability: z
    .enum(["ready", "ready_from_manifest", "both"])
    .default("both")
    .describe("Which recoverable candidates to queue."),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .default("index")
    .describe(
      "Final output filename conflict policy. Use overwrite only when explicitly requested.",
    ),
  concurrentSlices: z
    .boolean()
    .default(true)
    .describe("Whether resumed unfinished slices may run concurrently."),
});

// ---------------------------------------------------------------------------
// 类型导出
// ---------------------------------------------------------------------------

export type ScanSubtitleFilesArgs = z.infer<typeof scanSubtitleFilesSchema>;
export type QueueTranslateArgs = z.infer<typeof queueTranslateSchema>;
export type QueueConvertArgs = z.infer<typeof queueConvertSchema>;
export type QueueExtractArgs = z.infer<typeof queueExtractSchema>;
export type InspectRenamePathsArgs = z.infer<typeof inspectRenamePathsSchema>;
export type CreateNameTranslationPlanArgs = z.infer<
  typeof createNameTranslationPlanSchema
>;
export type ApplyNameTranslationPlanArgs = z.infer<
  typeof applyNameTranslationPlanSchema
>;
export type ScanSubtitleRecoveryTasksArgs = z.infer<
  typeof scanSubtitleRecoveryTasksSchema
>;
export type QueueRecoveredSubtitleTranslateArgs = z.infer<
  typeof queueRecoveredSubtitleTranslateSchema
>;
