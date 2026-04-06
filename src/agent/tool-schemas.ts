import { z } from "zod";

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
    .describe("Absolute paths of subtitle files to translate"),
  sliceType: z
    .enum(["NORMAL", "SENSITIVE", "CUSTOM"])
    .default("NORMAL")
    .describe("Translation slice strategy"),
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
    .describe("Absolute paths of subtitle files to convert"),
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
    .describe("Absolute paths of subtitle files to extract from"),
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

// ---------------------------------------------------------------------------
// 类型导出
// ---------------------------------------------------------------------------

export type ScanSubtitleFilesArgs = z.infer<typeof scanSubtitleFilesSchema>;
export type QueueTranslateArgs = z.infer<typeof queueTranslateSchema>;
export type QueueConvertArgs = z.infer<typeof queueConvertSchema>;
export type QueueExtractArgs = z.infer<typeof queueExtractSchema>;
