export interface MarkdownWidgetInvocation {
  id: string;
  type: string;
  version: number;
  raw: string;
  propsRaw: unknown;
  source?: {
    offset?: number;
    line?: number;
    column?: number;
  };
}

/**
 * 解析 widget fenced code block 的语言、meta 和内容，
 * 返回 MarkdownWidgetInvocation 或 null。
 *
 * 支持的语法：
 * - ```qv-widget type="tool-call" version="1" id="search-1"
 * - ```qv:reference-card id="ref-1"
 */
export function parseWidgetFence(
  language: string,
  meta: string | undefined | null,
  rawBody: string,
): MarkdownWidgetInvocation | null {
  let type: string | undefined;

  if (language === "qv-widget") {
    type = extractMetaValue(meta, "type");
    if (!type) return null;
  } else if (language.startsWith("qv:")) {
    type = language.slice(3);
    const metaType = extractMetaValue(meta, "type");
    if (metaType) type = metaType;
  } else {
    return null;
  }

  if (!type) return null;

  const id =
    extractMetaValue(meta, "id") || `widget-${type}-${simpleHash(rawBody)}`;
  const versionStr = extractMetaValue(meta, "version");
  const version = versionStr ? parseInt(versionStr, 10) || 1 : 1;

  let propsRaw: unknown = null;
  const trimmed = rawBody.trim();
  if (trimmed) {
    try {
      propsRaw = JSON.parse(trimmed);
    } catch {
      return {
        id,
        type,
        version,
        raw: rawBody,
        propsRaw: null,
      };
    }
  }

  return {
    id,
    type,
    version,
    raw: rawBody,
    propsRaw,
  };
}

function extractMetaValue(
  meta: string | undefined | null,
  key: string,
): string | undefined {
  if (!meta) return undefined;
  const regex = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))`);
  const match = meta.match(regex);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}
