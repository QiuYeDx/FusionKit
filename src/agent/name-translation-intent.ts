export type AgentOperationIntent =
  | "name_translation"
  | "subtitle_translation"
  | "unknown";

const NAME_TRANSLATION_RE =
  /(文件名|文件夹名|目录名|名称翻译|重命名|批量改名|改名|rename|file\s*name|folder\s*name|directory\s*name)/i;
const SUBTITLE_TRANSLATION_RE =
  /(字幕|subtitle|srt|lrc|vtt).*(翻译|translate)|(翻译|translate).*(字幕|subtitle|srt|lrc|vtt)/i;

export function classifyAgentOperationIntent(
  text: string
): AgentOperationIntent {
  const normalized = text.trim();
  if (!normalized) return "unknown";

  if (NAME_TRANSLATION_RE.test(normalized)) return "name_translation";
  if (SUBTITLE_TRANSLATION_RE.test(normalized)) return "subtitle_translation";
  return "unknown";
}
