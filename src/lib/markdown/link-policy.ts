const SAFE_PROTOCOLS = ["http:", "https:", "mailto:"];

/**
 * 检查 URL 是否符合安全策略。
 * - trusted：允许所有 URL。
 * - untrusted：只允许 http / https / mailto 和站内相对路径。
 */
export function isUrlAllowed(
  url: string | undefined,
  profile: "trusted" | "untrusted",
): boolean {
  if (!url) return false;
  if (profile === "trusted") return true;

  if (url.startsWith("/") || url.startsWith("#") || url.startsWith("?")) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * 为外部链接添加安全属性
 */
export function getSafeLinkProps(
  href: string | undefined,
  profile: "trusted" | "untrusted",
): Record<string, string> {
  if (!href) return {};

  const isExternal =
    href.startsWith("http://") || href.startsWith("https://");

  if (isExternal || profile === "untrusted") {
    return {
      target: "_blank",
      rel: "noopener noreferrer",
    };
  }

  return {};
}
