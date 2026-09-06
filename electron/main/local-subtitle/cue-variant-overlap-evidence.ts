import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { PrefixOverlapView } from "./cue-prefix-overlap-evidence";
type Span = Pick<LocalSubtitleSegment, "text" | "startMs" | "endMs">;
export interface VariantOverlapSource {
  sourceIdentity: string; left: LocalSubtitleSegment; right: readonly LocalSubtitleSegment[];
  leftObserved: Span; rightObserved: readonly Span[]; skipped?: Span; leftWindowEndMs: number;
}
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });
const kana = (g: string) => /^[ァ-ヶ]$/u.test(g) ? String.fromCodePoint(g.codePointAt(0)! - 0x60) : g;
const indexed = (s: string) => {
  const original = Array.from(graphemes.segment(s), x => x.segment), units: string[] = [], offsets: number[] = [];
  original.forEach((g, i) => { if (!/^[、。！？!?，,；;：:\s]+$/u.test(g)) { units.push(g); offsets.push(i); } });
  return { original, units, offsets, folded: units.map(kana) };
};
const quoted = /[「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u;
const time = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const span = (s: Span) => s && typeof s.text === "string" && !!s.text && s.text.length <= 2048 && !quoted.test(s.text) &&
  time(s.startMs) && time(s.endMs) && s.endMs > s.startMs;
const equal = (a: string, b: string) => a.replace(/\s/gu, "") === b.replace(/\s/gu, "");
const positions = (a: readonly string[], b: readonly string[]) => a.flatMap((_, i) => i + b.length <= a.length && b.every((g, j) => g === a[i + j]) ? [i] : []);
const reject = (reason: string) => ({ status: "rejected" as const, reason });
export const hasVariantSentenceEnd = (s: string) => /(?:[。！？!?]|(?:です|ます|でした|ました|ください)(?:ね|よ)?|(?:る|た|だ|ない)(?:わ|よ|ね))\s*$/u.test(s);
export function inspectVariantOverlapSource(s: VariantOverlapSource) {
  if (!s || typeof s.sourceIdentity !== "string" || !s.sourceIdentity || s.sourceIdentity.length > 256 || !time(s.leftWindowEndMs) ||
      !Array.isArray(s.right) || s.right.length < 2 || s.right.length > 6 || !Array.isArray(s.rightObserved) || s.rightObserved.length !== s.right.length ||
      ![s.left, s.leftObserved, ...s.right, ...s.rightObserved].every(span)) return reject("invalid_source");
  const a = s.left, ao = s.leftObserved, b = s.right[0], bo = s.rightObserved[0], last = s.right.at(-1)!;
  if (!equal(a.text, ao.text) || a.startMs !== ao.startMs || a.endMs > ao.endMs || a.endMs !== b.startMs ||
      Math.abs(ao.endMs - s.leftWindowEndMs) > 100 || Math.min(ao.endMs, bo.endMs) <= Math.max(ao.startMs, bo.startMs) ||
      s.right.some((r, i) => !equal(r.text, s.rightObserved[i].text) || r.endMs !== s.rightObserved[i].endMs ||
        (i ? r.startMs !== s.rightObserved[i].startMs || r.startMs !== s.right[i - 1].endMs : r.startMs < bo.startMs)) ||
      s.right.slice(0, -1).some(r => /[。！？!?]/u.test(r.text) || hasVariantSentenceEnd(r.text)) ||
      !hasVariantSentenceEnd(last.text) || last.endMs - bo.startMs > 18000) return reject("source_provenance");
  const x = indexed(a.text), y = indexed(b.text), start = x.units.length - y.units.length;
  if (y.units.length < 7 || y.units.length > 24 || start < 6 ||
      !x.units.slice(start, -1).every((g, i) => g === y.units[i]) || x.units.at(-1) === y.units.at(-1) ||
      !/^[ぁ-ゖ]$/u.test(x.units.at(-1)!) || !/^[ぁ-ゖ]$/u.test(y.units.at(-1)!)) return reject("not_terminal_variant");
  const common = y.folded.slice(0, -1), rightText = s.right.map(r => r.text).join(""), r = indexed(rightText);
  if (r.units.length > 120 || positions(x.folded, common).length !== 1 || positions(r.folded, common).length !== 1) return reject("ambiguous_source");
  const prefix = x.original.slice(0, x.offsets[start]).join("").trimEnd(), p = indexed(prefix), removed = x.original.slice(x.offsets[start]).join("");
  if (s.skipped && (!span(s.skipped) || positions(p.units, indexed(s.skipped.text).units).length !== 1 ||
      Math.min(s.skipped.endMs, ao.endMs) <= Math.max(s.skipped.startMs, ao.startMs))) return reject("unaccounted_skipped_source");
  if (!Array.from(words.segment(prefix + rightText)).some(w => w.index === prefix.length && w.isWordLike)) return reject("unsafe_word_boundary");
  return { status: "source_supported" as const, source: s, prefix, rightText, removed, p, r, y, common,
    composed: [...p.units, ...r.units], folded: [...p.folded, ...r.folded] };
}
type Difference = { offset: number; source: string; candidate: string; kanaOnly: boolean };
type Token = { from: number; to: number; pointMs: number; segment: number };
function inspectView(r: Extract<ReturnType<typeof inspectVariantOverlapSource>, { status: "source_supported" }>, v: PrefixOverlapView) {
  if (!v || !v.id || v.sourceIdentity !== r.source.sourceIdentity || v.mode !== "uncompressed_non_vad" || !time(v.windowStartMs) ||
      !time(v.windowEndMs) || v.windowEndMs <= v.windowStartMs || !Array.isArray(v.segments) || !v.segments.length || v.segments.length > 128 ||
      v.segments.some(s => !span(s)) || v.segments.reduce((n, s) => n + s.text.length, 0) > 4096) return reject("invalid_view");
  const full = indexed(v.segments.map(s => s.text).join("")), tokens: Token[] = [];
  let cursor = 0, previousPoint = -1, previousEnd = 0, count = 0;
  for (const [segment, s] of v.segments.entries()) {
    if (s.startMs < previousEnd || s.endMs > v.windowEndMs - v.windowStartMs || !Array.isArray(s.dtwTokens) ||
        (count += s.dtwTokens.length) > 4096 || s.dtwTokens.some((t: { text: string }) => typeof t?.text !== "string") ||
        s.dtwTokens.map((t: { text: string }) => t.text).join("") !== s.text) return reject("invalid_coverage");
    previousEnd = s.endMs;
    for (const t of s.dtwTokens) {
      const length = indexed(t.text).units.length;if (!length) continue;
      if (!time(t.pointMs) || t.pointMs < previousPoint || t.pointMs > v.windowEndMs - v.windowStartMs) return reject("invalid_points");
      previousPoint = t.pointMs;tokens.push({ from: cursor, to: cursor + length, pointMs: t.pointMs + v.windowStartMs, segment });cursor += length;
    }
  }
  if (cursor !== full.units.length) return reject("grapheme_coverage");
  if (positions(full.folded, r.y.folded).length !== 1 || positions(full.folded, r.common).length !== 1 || positions(full.folded, indexed(r.removed).folded).length)
    return reject("repeated_or_missing_words");
  const matches: { from: number; differences: Difference[] }[] = [];
  for (let from = 0; from + r.composed.length <= full.units.length; from++) {
    const differences = r.composed.flatMap((g, offset) => g === full.units[from + offset] ? [] : [{ offset, source: g, candidate: full.units[from + offset], kanaOnly: kana(g) === full.folded[from + offset] }]);
    const edits = differences.filter(d => !d.kanaOnly);
    if (edits.length > 4 || edits.some(d => d.offset >= r.p.units.length && d.offset < r.p.units.length + r.y.units.length ||
        !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(d.source) || !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(d.candidate))) continue;
    const runs: number[][] = [];
    edits.forEach(d => { const last = runs.at(-1);if (last && d.offset === last.at(-1)! + 1) last.push(d.offset);else runs.push([d.offset]); });
    if (runs.length > 2 || runs.some((run, i) => run.length > 2 || i && run[0] - runs[i - 1].at(-1)! < 7)) continue;
    matches.push({ from, differences });
  }
  if (matches.length !== 1) return reject("no_unique_complete_correspondence");
  const { from, differences } = matches[0], end = from + r.composed.length, cut = from + r.p.units.length;
  const anchor = tokens.filter(t => t.from >= from && t.to <= end), i = anchor.findIndex(t => t.from === cut);
  if (!anchor.length || anchor[0].from !== from || anchor.at(-1)!.to !== end || i < 1) return reject("partial_token");
  const source = r.source, last = source.right.at(-1)!;
  if (tokens.some(t => (t.to <= from || t.from >= end) && t.pointMs >= source.left.startMs && t.pointMs <= last.endMs)) return reject("unmatched_speech");
  for (const t of anchor) {
    const bounds = t.from < cut ? source.leftObserved : { startMs: source.rightObserved[0].startMs, endMs: source.rightObserved.at(-1)!.endMs };
    if (t.pointMs < bounds.startMs - 400 || t.pointMs > bounds.endMs + 400 || t.from < cut && t.to > cut) return reject("source_point_bounds");
  }
  const target = anchor[i], prior = anchor[i - 1], between = full.original.slice(full.offsets[cut - 1] + 1, full.offsets[cut]).join("");
  if (prior.segment === target.segment && !/[。！？!?]/u.test(between)) return reject("missing_sentence_evidence");
  if (target.pointMs - prior.pointMs < 120 || target.pointMs - prior.pointMs > 8000 || target.pointMs < source.rightObserved[0].startMs ||
      target.pointMs > source.rightObserved[0].endMs) return reject("unsafe_cut");
  return { status: "view_supported" as const, id: v.id, candidateMs: target.pointMs, differences };
}
export function inspectVariantOverlapTiming(source: VariantOverlapSource, views: readonly PrefixOverlapView[]) {
  const r = inspectVariantOverlapSource(source);if (r.status === "rejected") return r;
  if (!Array.isArray(views) || views.length !== 2 || new Set(views.map(v => v?.id)).size !== 2 || new Set(views.map(v => v?.windowStartMs)).size !== 2)
    return reject("two_distinct_views_required");
  const inspected = views.map(v => inspectView(r, v)), observations = inspected.flatMap(v => v.status === "view_supported" ? [v] : []);
  if (observations.length !== 2) return { ...reject("unsupported_observation"), observations: inspected };
  if (observations[0].differences.some(d => !d.kanaOnly && observations[1].differences.some(e => e.offset === d.offset && !e.kanaOnly))) return reject("unconfirmed_lexical_change");
  if (Math.abs(observations[0].candidateMs - observations[1].candidateMs) > 300) return reject("unstable_time");
  const point = observations[0].candidateMs, endMs = source.right.at(-1)!.endMs;
  if (point - source.left.startMs < 600 || endMs - point < 600 || endMs - point > 18000) return reject("unsafe_duration");
  return { status: "supported" as const, observations, removedVariant: r.removed,
    replacements: [{ ...source.left, text: r.prefix, endMs: point }, { ...source.right[0], text: r.rightText, startMs: point, endMs }] };
}
