// ---------------------------------------------------------------------------
// Session titles — cut from the first message at once, named by the agent model
// after the first reply. A title the user set is never replaced.
// ---------------------------------------------------------------------------

export const EXCERPT_GRAPHEMES = 24;
export const TITLE_GRAPHEMES = 32;
export const MANUAL_TITLE_GRAPHEMES = 80;

function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** Saved titles hold at most this many UTF-16 units, whatever the graphemes are made of. */
export const MAX_TITLE_LENGTH = 200;

function clip(text: string, limit: number, ellipsis: boolean): string {
  const parts = graphemes(text);
  let kept = "";
  let count = 0;
  for (const part of parts) {
    if (count === limit || kept.length + part.length > MAX_TITLE_LENGTH - 1) break;
    kept += part; count++;
  }
  if (kept.length === text.length) return text;
  return kept.trimEnd() + (ellipsis ? "…" : "");
}

/** The first non-empty line of what the user typed, as a one-line title. */
export function excerptTitle(text: string): string {
  const line = text.split(/\r?\n/).map((value) => value.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return clip(line, EXCERPT_GRAPHEMES, true);
}

/** A title the user typed: one line, trimmed; empty means no change. */
export function normalizeManualTitle(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), MANUAL_TITLE_GRAPHEMES, false);
}

/** Quotes around the whole answer; book-title marks inside a title are part of it. */
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "「": "」", "『": "』", "`": "`" };
const MARKDOWN = /^[#*_\s]+|[*_\s]+$/g;
const TRAILING_PUNCTUATION = /[。．.!！?？,，、;；:：…~～\s]+$/u;

function unquote(text: string): string {
  const close = QUOTE_PAIRS[text[0]];
  return close && text.length > 1 && text.endsWith(close) ? text.slice(1, -close.length).trim() : text;
}

/** What the model answered, reduced to a short title; empty when nothing usable is left. */
export function cleanGeneratedTitle(text: string): string {
  let line = text.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? "";
  line = line.replace(/^(?:title|标题|題名|タイトル)\s*[:：]\s*/i, "");
  for (let index = 0; index < 3; index++) line = unquote(line.replace(MARKDOWN, "").replace(TRAILING_PUNCTUATION, ""));
  line = line.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(line)) return "";
  return clip(line, TITLE_GRAPHEMES, false);
}
