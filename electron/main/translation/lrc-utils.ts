/**
 * Clean model output for LRC translation.
 *
 * The model can wrap output in markdown or indent valid LRC lines. Keep only
 * valid LRC-style lines after trimming, so explanations are discarded while
 * timestamp and metadata lines are preserved.
 */
export function cleanTranslatedLrcContent(content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }

  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^```\s*(?:[a-z0-9_-]+)?$/i.test(line))
    .filter((line) => line.startsWith("["))
    .join("\n")
    .trim();
}
