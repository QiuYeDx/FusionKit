export function parseCodeBlockMeta(meta: string | undefined | null): {
  title?: string;
  highlightLines?: string;
} {
  if (!meta) return {};
  const result: { title?: string; highlightLines?: string } = {};

  const titleMatch = meta.match(/title\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (titleMatch) {
    result.title = titleMatch[1] ?? titleMatch[2] ?? titleMatch[3];
  }

  const highlightMatch = meta.match(/\{([\d,\s-]+)\}/);
  if (highlightMatch) {
    result.highlightLines = highlightMatch[1].trim();
  }

  return result;
}
