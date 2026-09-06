import { parseSubtitleCueDocument } from "@/utils/subtitleCueProtocol";

export const LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS = 12_000;
export const LOCAL_SUBTITLE_PREVIEW_CUES_PER_PAGE = 60;

export function createLocalSubtitleArtifactPreviewPage(rawText: string, requestedPage: number,
  pageSize = LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS) {
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS;
  const pageCount = Math.max(1, Math.ceil(rawText.length / size));
  const pageIndex = Math.min(pageCount - 1, Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  const boundary = (offset: number) => offset > 0 && /[\uD800-\uDBFF]/u.test(rawText[offset - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(rawText[offset] ?? "") ? offset - 1 : offset;
  return { pageIndex, pageCount, text: rawText.slice(boundary(pageIndex * size), boundary((pageIndex + 1) * size)) };
}

export interface LocalSubtitlePreviewCue {
  number: number;
  start: string;
  end?: string;
  text: string;
}

/** Display-only projection: retain full cues and literal text; never infer LRC ends. */
export function parseLocalSubtitlePreview(rawText: string, format: "SRT" | "LRC"): LocalSubtitlePreviewCue[] | null {
  try {
    const document = parseSubtitleCueDocument(rawText, format);
    return document.parts.filter(part => part.cueId).map((part, index) => {
      if (format === "SRT") {
        const [start, end] = part.prefix[1]!.trim().split(/\s+-->\s+/u);
        return { number: index + 1, start: start.replace(",", "."), end: end.split(/\s/u)[0].replace(",", "."), text: part.original.join("\n") };
      }
      return { number: index + 1, start: part.prefix[0].trim().replace(/\]\[/gu, "] ["), text: part.original.join("\n") };
    });
  } catch { return null; }
}

export function filterLocalSubtitlePreview(cues: readonly LocalSubtitlePreviewCue[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? cues.filter(cue => `${cue.text}\n${cue.start}\n${cue.end ?? ""}`.toLocaleLowerCase().includes(needle)) : cues;
}
