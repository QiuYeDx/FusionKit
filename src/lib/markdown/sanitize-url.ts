const JAVASCRIPT_PROTOCOL = /^javascript:/i;
const DATA_PROTOCOL = /^data:/i;
const VBSCRIPT_PROTOCOL = /^vbscript:/i;

/**
 * 清理 URL，移除危险协议。
 * 返回安全的 URL 字符串，或空字符串。
 */
export function sanitizeUrl(url: string | Blob | undefined | null): string {
  if (!url) return "";
  if (typeof url !== "string") return "";

  const trimmed = url.trim();

  if (
    JAVASCRIPT_PROTOCOL.test(trimmed) ||
    VBSCRIPT_PROTOCOL.test(trimmed)
  ) {
    return "";
  }

  if (DATA_PROTOCOL.test(trimmed)) {
    if (trimmed.startsWith("data:image/")) {
      return trimmed;
    }
    return "";
  }

  return trimmed;
}
