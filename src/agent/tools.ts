import { tool } from "ai";
import {
  scanSubtitleFilesSchema,
  queueTranslateSchema,
  queueConvertSchema,
  queueExtractSchema,
  inspectRenamePathsSchema,
  createNameTranslationPlanSchema,
  applyNameTranslationPlanSchema,
  scanSubtitleRecoveryTasksSchema,
  queueRecoveredSubtitleTranslateSchema,
} from "./tool-schemas";
import {
  executeScan,
  executeQueueTranslate,
  executeQueueConvert,
  executeQueueExtract,
  executeInspectRenamePaths,
  executeCreateNameTranslationPlan,
  executeApplyNameTranslationPlan,
  executeScanSubtitleRecoveryTasks,
  executeQueueRecoveredSubtitleTranslate,
} from "./tool-executor";

// ---------------------------------------------------------------------------
// AI SDK Tool Definitions — 字幕工具 + 名称翻译工具
// ---------------------------------------------------------------------------

export const agentTools = {
  scan_subtitle_files: tool({
    description:
      "Scan one or more directories for subtitle files (LRC/SRT/VTT). " +
      "Returns a list of discovered file paths with metadata. " +
      "Call this FIRST when the user mentions a directory path.",
    inputSchema: scanSubtitleFilesSchema,
    execute: async (args) => executeScan(args),
  }),

  queue_subtitle_translate: tool({
    description:
      "Add subtitle files to the TRANSLATION queue. " +
      "Translates subtitle text from one language to another (default: Japanese→Chinese, bilingual output). " +
      "Supports languages: ZH(Chinese), JA(Japanese), EN(English), KO(Korean), FR(French), DE(German), ES(Spanish), RU(Russian), PT(Portuguese). " +
      "When the user requests an explicit slice length such as 按照1200分词 / every 1200 tokens, set sliceType=CUSTOM and customSliceLength to that number. " +
      "Use filePaths for small explicit lists, or use scanId + batchStart + batchSize from a previous scan result for large batch queueing.",
    inputSchema: queueTranslateSchema,
    execute: async (args) => executeQueueTranslate(args),
  }),

  queue_subtitle_convert: tool({
    description:
      "Add subtitle files to the FORMAT CONVERSION queue. " +
      "Converts between subtitle formats (SRT↔LRC↔VTT). " +
      "Use filePaths for small explicit lists, or use scanId + batchStart + batchSize from a previous scan result for large batch queueing.",
    inputSchema: queueConvertSchema,
    execute: async (args) => executeQueueConvert(args),
  }),

  queue_subtitle_extract: tool({
    description:
      "Add subtitle files to the LANGUAGE EXTRACTION queue. " +
      "Extracts one language (Chinese or Japanese) from bilingual subtitles. " +
      "Use filePaths for small explicit lists, or use scanId + batchStart + batchSize from a previous scan result for large batch queueing.",
    inputSchema: queueExtractSchema,
    execute: async (args) => executeQueueExtract(args),
  }),

  inspect_rename_paths: tool({
    description:
      "Inspect file or directory paths before file/folder name translation or batch rename. " +
      "Use this when the user's rename scope is ambiguous or you need to know whether a path is a file or directory. " +
      "This tool never changes the filesystem.",
    inputSchema: inspectRenamePathsSchema,
    execute: async (args) => executeInspectRenamePaths(args),
  }),

  create_name_translation_plan: tool({
    description:
      "Create a dry-run plan for translating file or folder names without changing file contents. " +
      "Use this for 文件名/文件夹名/重命名/改名/name translation requests. " +
      "Always call this before any rename apply. It returns a planId, preview, counts, warnings, and confirmation requirement.",
    inputSchema: createNameTranslationPlanSchema,
    execute: async (args) => executeCreateNameTranslationPlan(args),
  }),

  apply_name_translation_plan: tool({
    description:
      "Apply a previously created name translation plan after explicit user confirmation. " +
      "Never call this automatically from Auto Execute mode. The latest user message must clearly confirm applying the rename plan.",
    inputSchema: applyNameTranslationPlanSchema,
    execute: async (args) => executeApplyNameTranslationPlan(args),
  }),

  scan_subtitle_recovery_tasks: tool({
    description:
      "Scan for FusionKit recovery manifests (*.fusionkit.resume.json) to find unfinished subtitle translation tasks. " +
      "Use this when the user wants to resume/recover/continue previous failed or interrupted subtitle translations. " +
      "Returns a recoveryScanId and candidate preview. Do NOT use scan_subtitle_files for recovery manifests.",
    inputSchema: scanSubtitleRecoveryTasksSchema,
    execute: async (args) => executeScanSubtitleRecoveryTasks(args),
  }),

  queue_recovered_subtitle_translate: tool({
    description:
      "Add recovered subtitle translation candidates to the translation queue. " +
      "Use recoveryScanId from scan_subtitle_recovery_tasks for batch queueing, or checkpointPaths for small explicit lists. " +
      "Language, slice strategy, and output directory are determined by the recovery manifest — do NOT override them.",
    inputSchema: queueRecoveredSubtitleTranslateSchema,
    execute: async (args) => executeQueueRecoveredSubtitleTranslate(args),
  }),
};
