import { z, type ZodSchema } from "zod";
import {
  scanSubtitleFilesSchema,
  queueTranslateSchema,
  queueConvertSchema,
  queueExtractSchema,
} from "./tool-schemas";

// ---------------------------------------------------------------------------
// Tool Registry — 4 个核心工具
// ---------------------------------------------------------------------------

export interface ToolDefinition<T = any> {
  name: string;
  description: string;
  schema: ZodSchema<T>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "scan_subtitle_files",
    description:
      "Scan one or more directories for subtitle files (LRC/SRT/VTT). " +
      "Returns a list of discovered file paths with metadata. " +
      "Call this FIRST when the user mentions a directory path.",
    schema: scanSubtitleFilesSchema,
  },
  {
    name: "queue_subtitle_translate",
    description:
      "Add subtitle files to the TRANSLATION queue. " +
      "Translates subtitle text content into another language. " +
      "Requires filePaths from a previous scan result.",
    schema: queueTranslateSchema,
  },
  {
    name: "queue_subtitle_convert",
    description:
      "Add subtitle files to the FORMAT CONVERSION queue. " +
      "Converts between subtitle formats (SRT↔LRC↔VTT). " +
      "Requires filePaths from a previous scan result.",
    schema: queueConvertSchema,
  },
  {
    name: "queue_subtitle_extract",
    description:
      "Add subtitle files to the LANGUAGE EXTRACTION queue. " +
      "Extracts one language (Chinese or Japanese) from bilingual subtitles. " +
      "Requires filePaths from a previous scan result.",
    schema: queueExtractSchema,
  },
];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}

export function validateToolArgs<T>(toolName: string, args: unknown): T {
  const def = getToolDefinition(toolName);
  if (!def) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return def.schema.parse(args) as T;
}

/**
 * 生成 OpenAI function-calling 格式的工具描述列表
 */
export function getToolDescriptionsForLLM(): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}> {
  return TOOL_DEFINITIONS.map((def) => ({
    type: "function" as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: zodToJsonSchema(def.schema),
    },
  }));
}

// ---------------------------------------------------------------------------
// Zod → JSON Schema 转换
// ---------------------------------------------------------------------------

function zodToJsonSchema(schema: ZodSchema): Record<string, any> {
  try {
    const jsonSchema = z.toJSONSchema(schema);
    delete jsonSchema["$schema"];
    return jsonSchema;
  } catch {
    return { type: "object", properties: {}, required: [] };
  }
}
