export interface HeadingMeta {
  id: string;
  text: string;
  level: number;
  index: number;
  offset?: number;
}

export function slugifyHeading(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .trim();
}

interface ExtractHeadingMetaOptions {
  maxLevel?: number;
}

export function extractHeadingMeta(
  content: string,
  options: ExtractHeadingMetaOptions = {}
): HeadingMeta[] {
  const { maxLevel = 6 } = options;

  const headingRegex = /^(#{1,6})\s+(.+)$/;
  const occurrences = new Map<string, number>();
  const headingMeta: HeadingMeta[] = [];
  let fallbackIndex = 1;
  let inCodeBlock = false;
  let offset = 0;

  const lines = content.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      offset += line.length + 1;
      continue;
    }

    if (!inCodeBlock) {
      const cleanedLine = line.replace(/`+/g, "");
      const match = headingRegex.exec(cleanedLine);
      if (match) {
        const level = match[1].length;

        if (level <= maxLevel) {
          const text = match[2].trim();
          let baseSlug = slugifyHeading(text);

          if (!baseSlug) {
            baseSlug = `section-${fallbackIndex}`;
            fallbackIndex += 1;
          }

          const currentCount = occurrences.get(baseSlug) ?? 0;
          occurrences.set(baseSlug, currentCount + 1);

          const id =
            currentCount === 0 ? baseSlug : `${baseSlug}-${currentCount + 1}`;
          const hashIndex = line.indexOf(match[1]);

          headingMeta.push({
            id,
            text,
            level,
            index: headingMeta.length,
            offset: offset + Math.max(0, hashIndex),
          });
        }
      }
    }

    offset += line.length + 1;
  }

  return headingMeta;
}
