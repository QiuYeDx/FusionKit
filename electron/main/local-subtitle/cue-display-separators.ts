import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { PrefixOverlapView } from "./cue-prefix-overlap-evidence";

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });
const separator = /^[、。！？!?，,；;：:\s]+$/u;
const quotes = /[「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u;
const dependent = /^(?:だ|です|ます|を|は|が|に|で|と|て|た|ない|か)$/u;
const time = (value: number | null): value is number => Number.isSafeInteger(value) && value !== null && value >= 0;

function indexed(text: string) {
  const units: string[] = [], positions: number[] = [], separators = new Set<number>();
  for (const item of graphemes.segment(text)) {
    if (separator.test(item.segment)) { separators.add(units.length); continue; }
    // Equal-length kana folding is a position correspondence, never replacement text.
    units.push(item.segment.replace(/[ァ-ヶ]/gu, kana => String.fromCharCode(kana.charCodeAt(0) - 0x60)));
    positions.push(item.index);
  }
  return { units, positions, separators };
}

type Boundary = { offset: number; pointMs: number };

/** Complete native groups only: never carve a matching phrase out of changed text. */
function inspectView(cue: LocalSubtitleSegment, view: PrefixOverlapView): Boundary[] {
  const duration = view.windowEndMs - view.windowStartMs;
  if (view.mode !== "uncompressed_non_vad" || !view.id ||
      !time(view.windowStartMs) || !time(view.windowEndMs) || duration <= 0 || duration > 30000 ||
      view.windowStartMs >= cue.endMs || view.windowEndMs <= cue.startMs ||
      !Array.isArray(view.segments) || view.segments.length > 128 ||
      view.segments.some(s => typeof s?.text !== "string") ||
      view.segments.reduce((n, s) => n + s.text.length, 0) > 4096) return [];
  const source = indexed(cue.text), tokens: { from: number; to: number; pointMs: number }[] = [];
  const candidate: string[] = [], parts = [0], explicit = new Set<number>();
  let previousPoint = -1, previousEnd = 0, tokenCount = 0;
  for (const segment of view.segments) {
    if (!time(segment.startMs) || !time(segment.endMs) || segment.endMs <= segment.startMs ||
        segment.startMs < previousEnd || segment.endMs > duration || !Array.isArray(segment.dtwTokens) ||
        (tokenCount += segment.dtwTokens.length) > 4096 ||
        segment.dtwTokens.some((t: { text: string }) => typeof t?.text !== "string") ||
        segment.dtwTokens.map((t: { text: string }) => t.text).join("") !== segment.text) return [];
    previousEnd = segment.endMs;
    // Existing seam consumers admit outer narration wrappers. Internal quotation
    // boundaries cannot be used as phrase evidence.
    const unwrapped = segment.text.replace(/^[「『“]+|[」』”]+$/gu, "");
    if (quotes.test(unwrapped)) return [];
    const cleanToken = (text: string) => text.replace(/[「」『』“”]/gu, "");
    for (const token of segment.dtwTokens) {
      const from = candidate.length, parsed = indexed(cleanToken(token.text));
      parsed.separators.forEach(offset => explicit.add(from + offset));
      candidate.push(...parsed.units);
      if (from === candidate.length) continue;
      if (!time(token.pointMs) || token.pointMs < previousPoint || token.pointMs > duration) return [];
      previousPoint = token.pointMs;
      tokens.push({ from, to: candidate.length, pointMs: view.windowStartMs + token.pointMs });
    }
    parts.push(candidate.length);
  }
  const safe = new Set(Array.from(words.segment(cue.text)).filter(item => item.isWordLike &&
    !dependent.test(item.segment) && !/^[\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(item.segment)).map(item => item.index));
  const result = new Map<number, number>();
  let budget = 200_000;
  for (let first = 0; first < parts.length - 1; first++) {
    for (let last = first + 1; last < parts.length; last++) {
      const from = parts[first]!, end = parts[last]!, size = end - from;
      if (size > source.units.length) break;
      if (size < 8) continue;
      const matches: number[] = [];
      for (let start = 0; start + size <= source.units.length; start++) {
        let equal = true;
        for (let j = 0; j < size; j++) {
          if (--budget < 0) return [];
          if (source.units[start + j] !== candidate[from + j]) { equal = false; break; }
        }
        if (equal) matches.push(start);
      }
      if (matches.length !== 1) continue;
      const start = matches[0]!;
      // Repeated occurrences in this native view are ambiguous even if the cue
      // itself contains only one occurrence. Keep the original in that case.
      let occurrences = 0;
      for (let at = 0; at + size <= candidate.length; at++) {
        let equal = true;
        for (let j = 0; j < size; j++) {
          if (--budget < 0) return [];
          if (candidate[at + j] !== candidate[from + j]) { equal = false; break; }
        }
        if (equal) occurrences++;
      }
      if (occurrences !== 1) continue;
      const head = tokens.find(t => t.from === from), tail = tokens.find(t => t.to === end);
      if (!head || !tail || head.pointMs < cue.startMs - 800 || tail.pointMs > cue.endMs + 800) continue;
      const boundaries = new Set([...explicit, ...parts.slice(first + 1, last)]);
      for (const at of boundaries) {
        if (at - from < 3 || end - at < 3) continue;
        const offset = source.positions[start + at - from]!;
        if (!safe.has(offset) || offset <= 0 || offset >= cue.text.length ||
            separator.test(cue.text[offset - 1]!) || separator.test(cue.text[offset]!)) continue;
        const left = tokens.find(t => t.to === at), right = tokens.find(t => t.from === at);
        if (!left || !right || left.pointMs < cue.startMs || right.pointMs > cue.endMs ||
            right.pointMs - left.pointMs < 80 || right.pointMs - left.pointMs > 12000) continue;
        // A one-kana leading token can drift into background audio. Corroborate
        // the small lexical anchor after it, rather than treating that token as
        // the onset of a word. This supplies no timing cut.
        const anchor = tokens.find(t => t.from >= at && t.to >= at + 2 && t.to <= Math.min(end, at + 6));
        if (!anchor || anchor.pointMs > cue.endMs) continue;
        const prior = result.get(offset);
        if (prior !== undefined && prior !== anchor.pointMs) return [];
        result.set(offset, anchor.pointMs);
      }
    }
  }
  return [...result].map(([offset, pointMs]) => ({ offset, pointMs }));
}

/**
 * Final display pass. Two distinct, already-retained non-VAD observations must
 * locate an explicit separator at the same source position and nearby DTW point.
 * Point gaps alone never supply a separator or a new cue time.
 */
export function restoreFinalLocalSubtitleSeparators(
  cue: LocalSubtitleSegment, sourceIdentity: string, views: readonly PrefixOverlapView[],
): LocalSubtitleSegment {
  if (!sourceIdentity || cue.text.length < 8 || cue.text.length > 1024 ||
      !/\p{Script=Hiragana}/u.test(cue.text) || quotes.test(cue.text) || /[\r\n]/u.test(cue.text) ||
      !time(cue.startMs) || !time(cue.endMs) || cue.endMs <= cue.startMs || views.length > 16) return cue;
  const observations = views.filter(view => view.sourceIdentity === sourceIdentity).map(view => ({ view, boundaries: inspectView(cue, view) }));
  const offsets = new Set<number>();
  for (const [i, a] of observations.entries()) for (const b of observations.slice(i + 1)) {
    if (a.view.id === b.view.id || Math.abs(a.view.windowStartMs - b.view.windowStartMs) < 200) continue;
    for (const left of a.boundaries) if (b.boundaries.some(right => left.offset === right.offset &&
      Math.abs(left.pointMs - right.pointMs) <= 400)) offsets.add(left.offset);
  }
  if (!offsets.size || offsets.size > 8 || cue.text.length + offsets.size > 1024) return cue;
  let text = cue.text;
  for (const offset of [...offsets].sort((a, b) => b - a)) text = text.slice(0, offset) + " " + text.slice(offset);
  return Object.freeze({ ...cue, text });
}
