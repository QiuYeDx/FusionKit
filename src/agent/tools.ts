import { tool } from "ai";
import {
  scanSubtitleFilesSchema,
  queueTranslateSchema,
  queueConvertSchema,
  queueExtractSchema,
} from "./tool-schemas";
import {
  executeScan,
  executeQueueTranslate,
  executeQueueConvert,
  executeQueueExtract,
} from "./tool-executor";

// ---------------------------------------------------------------------------
// AI SDK Tool Definitions — 4 个核心工具
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
      "Requires filePaths from a previous scan result.",
    inputSchema: queueTranslateSchema,
    execute: async (args) => executeQueueTranslate(args),
  }),

  queue_subtitle_convert: tool({
    description:
      "Add subtitle files to the FORMAT CONVERSION queue. " +
      "Converts between subtitle formats (SRT↔LRC↔VTT). " +
      "Requires filePaths from a previous scan result.",
    inputSchema: queueConvertSchema,
    execute: async (args) => executeQueueConvert(args),
  }),

  queue_subtitle_extract: tool({
    description:
      "Add subtitle files to the LANGUAGE EXTRACTION queue. " +
      "Extracts one language (Chinese or Japanese) from bilingual subtitles. " +
      "Requires filePaths from a previous scan result.",
    inputSchema: queueExtractSchema,
    execute: async (args) => executeQueueExtract(args),
  }),
};
