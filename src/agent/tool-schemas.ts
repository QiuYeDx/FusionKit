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
    .default(["LRC", "SRT", "VTT", "ASS", "SSA", "SBV"])
    .describe(
      "File extensions to include (uppercase). Default: all supported subtitle formats"
    ),
  recursive: z.boolean().default(true).describe("Scan subdirectories"),
});

/** queue_subtitle_translate_tasks — 将文件加入翻译队列 */
export const queueTranslateSchema = z.object({
  paths: z
    .array(z.string().min(3).max(4096))
    .min(1)
    .max(20)
    .optional()
    .describe("Subtitle files or folders exactly as the user typed them (folders give their LRC/SRT/VTT files in name order, up to 100). Paths the user did not type are refused. Omit to open FusionKit's file picker."),
  recursive: z.boolean().optional().describe("With folder paths: include subfolders. Only when the user asked for them."),
  outputDirectory: z
    .string()
    .min(3)
    .max(4096)
    .optional()
    .describe("An output folder exactly as the user typed it. Omit to save next to each input, or set outputMode='custom' to let the user pick one."),
  sliceType: z
    .enum(["NORMAL", "SENSITIVE", "CUSTOM"])
    .optional()
    .describe(
      "Translation slice strategy. Use CUSTOM when the user gives an explicit slice length, token/chunk limit, or phrases like 按照1200分词 / 每片1200 / 1200 tokens. Omit unless the user asked for it: the tool page's current setting is used."
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
    .optional()
    .describe("Source language code. Omit unless the user asked for it: the tool page's current setting is used."),
  targetLang: z
    .enum(["ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .optional()
    .describe("Target language code. Omit unless the user asked for it: the tool page's current setting is used."),
  translationOutputMode: z
    .enum(["bilingual", "target_only"])
    .optional()
    .describe("'bilingual' = keep source + target lines, 'target_only' = only translated text. Omit unless the user asked for it: the tool page's current setting is used."),
  outputMode: z
    .enum(["source", "custom"])
    .optional()
    .describe(
      "'source' = save next to each selected input (used when omitted); 'custom' = ask the user to select an output directory with FusionKit's fixed picker. The translator page's saved folder cannot be reused without picking it again.",
    ),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .optional()
    .describe(
      "How to handle filename conflicts. 'index' = append numeric suffix (e.g. file_1.srt), 'overwrite' = replace existing file. Use 'overwrite' only when the user explicitly requests overwriting / replacing existing files. Omit unless the user asked for it: the tool page's current setting is used."
    ),
  concurrentSlices: z
    .boolean()
    .optional()
    .describe(
      "Whether to translate slices concurrently for faster speed. Set to false only when the user explicitly requests sequential / non-concurrent / 串行 / 不要并发 / 逐条 processing. Omit unless the user asked for it: the tool page's current setting is used."
    ),
}).strict();

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
    .enum(["LRC", "SRT", "VTT", "ASS", "SSA", "SBV"])
    .optional()
    .describe("Target subtitle format. Omit unless the user asked for it: the tool page's current setting is used."),
  outputMode: z
    .enum(["source", "custom"])
    .optional()
    .describe("'source' = save next to original, 'custom' = a user-chosen output directory. Omit unless the user asked for it: the tool page's current setting is used."),
  outputDir: z
    .string()
    .optional()
    .describe("Only a directory the user typed in this conversation. Otherwise omit it and FusionKit asks the user with a directory picker."),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .optional()
    .describe(
      "How to handle filename conflicts. 'index' = append numeric suffix (e.g. file_1.srt), 'overwrite' = replace existing file. Use 'overwrite' only when the user explicitly requests overwriting / replacing existing files. Omit unless the user asked for it: the tool page's current setting is used."
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
    .enum(["ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .optional()
    .describe("Which language to keep from bilingual subtitles. Omit unless the user asked for it: the tool page's current setting is used."),
  outputMode: z
    .enum(["source", "custom"])
    .optional()
    .describe("'source' = save next to original, 'custom' = a user-chosen output directory. Omit unless the user asked for it: the tool page's current setting is used."),
  outputDir: z
    .string()
    .optional()
    .describe("Only a directory the user typed in this conversation. Otherwise omit it and FusionKit asks the user with a directory picker."),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .optional()
    .describe(
      "How to handle filename conflicts. 'index' = append numeric suffix (e.g. file_1.srt), 'overwrite' = replace existing file. Use 'overwrite' only when the user explicitly requests overwriting / replacing existing files. Omit unless the user asked for it: the tool page's current setting is used."
    ),
});

/** inspect_rename_paths — 检查名称翻译/重命名路径 */
export const inspectRenamePathsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .describe("Absolute file or directory paths to inspect for name translation / rename."),
});

/** create_name_translation_plan — 创建名称翻译预览计划（不改动磁盘） */
export const createNameTranslationPlanSchema = z.object({
  roots: z
    .array(z.string())
    .min(1)
    .describe("Absolute file or directory paths provided by the user."),
  scope: z
    .enum(["self", "children", "descendants"])
    .default("self")
    .describe(
      "What to rename. self = the given paths themselves; children = direct children of the given folders; descendants = everything inside the given folders recursively (only when the user explicitly asks for nested content)."
    ),
  targetKind: z
    .enum(["files", "directories", "both"])
    .default("both")
    .describe("For children/descendants: rename files, folders or both. Ignored for self."),
  includeRoots: z
    .boolean()
    .default(false)
    .describe("For children/descendants: also rename the given folders themselves."),
  includeHidden: z.boolean().optional().describe("Include hidden files. Omit unless the user asked for it: the tool page's current setting is used."),
  sourceLang: z
    .enum(["auto", "ZH", "ZH_HANT", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .optional()
    .describe("Omit unless the user asked for it: the tool page's current setting is used."),
  targetLang: z
    .enum(["ZH", "ZH_HANT", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"])
    .optional()
    .describe("Omit unless the user asked for it: the tool page's current setting is used."),
  nameFormat: z
    .enum(["translated", "translated_original", "original_translated"])
    .optional()
    .describe("translated replaces the name; translated_original gives 'Translated (Original)'; original_translated gives 'Original (Translated)'. Omit unless the user asked for a format: the name translator page's format (including its bracket style or custom template) is used."),
  instructions: z
    .string()
    .max(1000)
    .optional()
    .describe("Optional extra translation requirements from the user, e.g. how to handle person names. When omitted, the name translator page's requirements are used."),
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
  path: z
    .string()
    .min(3)
    .max(4096)
    .optional()
    .describe("A folder to scan, or one *.fusionkit.resume.json manifest, exactly as the user typed it. Paths the user did not type are refused. Omit to use the picker."),
  selectionMode: z
    .enum(["directory", "manifest"])
    .default("directory")
    .describe("Without path: open a fixed native directory or manifest picker."),
  includeCompleted: z.boolean().default(false),
}).strict();

/** queue_recovered_subtitle_translate — 把恢复候选加入翻译队列 */
export const queueRecoveredSubtitleTranslateSchema = z.object({
  recoveryScanId: z
    .string()
    .min(1)
    .describe("recoveryScanId returned by scan_subtitle_recovery_tasks."),
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
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .optional()
    .describe(
      "Final output filename conflict policy. Use overwrite only when explicitly requested. Omit unless the user asked for it: the translator page's current setting is used.",
    ),
  concurrentSlices: z
    .boolean()
    .optional()
    .describe("Whether resumed unfinished slices may run concurrently. Omit unless the user asked for it: the translator page's current setting is used."),
}).strict();

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
