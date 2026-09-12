import type { LocalSubtitleSegment } from "../../../../../src/subtitle-studio/transcription/domain";
import type { PrefixOverlapView } from "./cue-prefix-overlap-evidence";
type Span = Pick<LocalSubtitleSegment, "text" | "startMs" | "endMs">;
export interface ContainedOverlapSource {
  sourceIdentity: string;
  cues: readonly [LocalSubtitleSegment, LocalSubtitleSegment, LocalSubtitleSegment];
  observed: readonly [Span, Span, Span];
  leftWindowEndMs: number;
}
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });
const split = (s: string) => Array.from(graphemes.segment(s), x => x.segment);
const indexed = (s: string) => {
  const original = split(s), units: string[] = [], offsets: number[] = [];
  original.forEach((g, i) => { if (!/^[、。！？!?，,；;：:\s]+$/u.test(g)) { units.push(g); offsets.push(i); } });
  return { original, units, offsets };
};
const quoted = /[「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u;
const time = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const span = (s: Span) => s && typeof s.text === "string" && s.text.length > 0 && s.text.length <= 2048 &&
  time(s.startMs) && time(s.endMs) && s.endMs > s.startMs && !quoted.test(s.text);
const locations = (a: readonly string[], b: readonly string[]) => a.flatMap((_, i) =>
  i + b.length <= a.length && b.every((g, j) => g === a[i + j]) ? [i] : []);
const reject = (reason: string) => ({ status: "rejected" as const, reason });
export function inspectContainedOverlapSource(source: ContainedOverlapSource) {
  if (!source || typeof source.sourceIdentity !== "string" || !source.sourceIdentity || source.sourceIdentity.length > 256 ||
      !Array.isArray(source.cues) || source.cues.length !== 3 || !Array.isArray(source.observed) || source.observed.length !== 3 ||
      !time(source.leftWindowEndMs) || ![...source.cues, ...source.observed].every(span)) return reject("invalid_source");
  const [a, b, c] = source.cues, [ao, bo, co] = source.observed;
  if (source.cues.some((s, i) => s.text.replace(/\s/gu, "") !== source.observed[i].text.replace(/\s/gu, "")) ||
      a.startMs !== ao.startMs || a.endMs !== b.startMs || b.endMs !== c.startMs || a.endMs > ao.endMs ||
      b.startMs < bo.startMs || b.endMs !== bo.endMs || c.startMs !== co.startMs || c.endMs !== co.endMs ||
      Math.min(ao.endMs, bo.endMs) <= Math.max(ao.startMs, bo.startMs) ||
      Math.abs(ao.endMs - source.leftWindowEndMs) > 100 || /[。！？!?\r\n]/u.test(a.text + b.text)) return reject("source_provenance");
  const x = indexed(a.text), m = indexed(b.text), f = indexed(c.text), found = locations(x.units, m.units);
  if (found.length !== 1 || m.units.length < 10 || f.units.length < 12) return reject("ambiguous_containment");
  const at = found[0], end = at + m.units.length;
  if (at < 12 || x.units.length - end < 1 || x.units.length - end > 4) return reject("unsupported_edge_tail");
  const prefix = x.original.slice(0, x.offsets[at]).join("").trimEnd(), tail = x.original.slice(x.offsets[end]).join("");
  const pieces = [prefix, b.text, c.text], p = indexed(prefix), composed = [...p.units, ...m.units, ...f.units];
  if (composed.length > 1024) return reject("source_limit");
  const joined = pieces.join("");
  if (![prefix.length, prefix.length + b.text.length].every(at => Array.from(words.segment(joined)).some(w => w.index === at && w.isWordLike)))
    return reject("unsafe_word_boundary");
  return { status: "source_supported" as const, source, pieces, p: p.units, m: m.units, f: f.units, composed, tail };
}

type Token = { from: number; to: number; pointMs: number; segment: number };
function inspectView(r: Extract<ReturnType<typeof inspectContainedOverlapSource>, { status: "source_supported" }>, v: PrefixOverlapView) {
  if (!v || !v.id || v.sourceIdentity !== r.source.sourceIdentity || v.mode !== "uncompressed_non_vad" ||
      !time(v.windowStartMs) || !time(v.windowEndMs) || v.windowEndMs <= v.windowStartMs || !Array.isArray(v.segments) ||
      !v.segments.length || v.segments.length > 128 || v.segments.some(s => !span(s)) ||
      v.segments.reduce((sum, s) => sum + s.text.length, 0) > 4096) return reject("invalid_view");
  const full = indexed(v.segments.map(s => s.text).join("")), tokens: Token[] = [];
  let cursor = 0, lastPoint = -1, lastEnd = 0, count = 0;
  for (const [segment, s] of v.segments.entries()) {
    if (s.startMs < lastEnd || s.endMs > v.windowEndMs - v.windowStartMs || !Array.isArray(s.dtwTokens) ||
        (count += s.dtwTokens.length) > 4096 || s.dtwTokens.some((t: { text: string }) => typeof t?.text !== "string") ||
        s.dtwTokens.map((t: { text: string }) => t.text).join("") !== s.text) return reject("invalid_coverage");
    lastEnd = s.endMs;
    for (const t of s.dtwTokens) {
      const length = indexed(t.text).units.length;if (!length) continue;
      if (!time(t.pointMs) || t.pointMs < lastPoint || t.pointMs > v.windowEndMs - v.windowStartMs) return reject("invalid_points");
      lastPoint = t.pointMs;tokens.push({ from: cursor, to: cursor + length, pointMs: t.pointMs + v.windowStartMs, segment });cursor += length;
    }
  }
  if (cursor !== full.units.length) return reject("grapheme_coverage");
  if (locations(full.units, indexed(r.tail).units).length || [r.m, r.f].some(p => locations(full.units, p.slice(0, 6)).length !== 1))
    return reject("extra_or_repeated_words");
  const matches: { from: number; differences: { offset: number; source: string; candidate: string }[] }[] = [];
  for (let from = 0; from + r.composed.length <= full.units.length; from++) {
    const differences = r.composed.flatMap((g, offset) => g === full.units[from + offset] ? [] : [{ offset, source: g, candidate: full.units[from + offset] }]);
    if (differences.length <= 3 && differences.every(d => d.offset < 2 || d.offset >= r.p.length + 6 && d.offset < r.p.length + r.m.length - 2) &&
        differences.filter(d => d.offset >= r.p.length).length <= 1) matches.push({ from, differences });
  }
  if (matches.length !== 1) return reject("no_unique_complete_correspondence");
  const { from, differences } = matches[0], end = from + r.composed.length, anchor = tokens.filter(t => t.from >= from && t.to <= end);
  if (!anchor.length || anchor[0].from !== from || anchor.at(-1)!.to !== end) return reject("partial_token");
  const [a, , c] = r.source.cues;
  if (tokens.some(t => (t.to <= from || t.from >= end) && t.pointMs >= a.startMs && t.pointMs <= c.endMs)) return reject("unmatched_speech");
  const cuts = [r.p.length, r.p.length + r.m.length], points: number[] = [];
  for (const t of anchor) {
    const offset = t.from - from, finish = t.to - from, piece = offset < cuts[0] ? 0 : offset < cuts[1] ? 1 : 2;
    const observation = r.source.observed[piece];
    if (t.pointMs < observation.startMs - 400 || t.pointMs > observation.endMs + 400 ||
        piece === 1 && t.pointMs > r.source.observed[0].endMs + 400 || cuts.some(cut => offset < cut && finish > cut)) return reject("source_point_bounds");
  }
  for (const cut of cuts) {
    const i = anchor.findIndex(t => t.from === from + cut), target = anchor[i], prior = anchor[i - 1];
    if (!target || !prior || target.pointMs - prior.pointMs < 120 || target.pointMs - prior.pointMs > 8000) return reject("unsafe_cut");
    const between = full.original.slice(full.offsets[target.from - 1] + 1, full.offsets[target.from]).join("");
    if (prior.segment === target.segment && !/[。！？!?]/u.test(between)) return reject("missing_sentence_evidence");
    points.push(target.pointMs);
  }
  if (Math.abs(points[1] - r.source.leftWindowEndMs) > 750) return reject("not_window_edge_continuation");
  return { status: "view_supported" as const, id: v.id, points, differences };
}
export function inspectContainedOverlapTiming(source: ContainedOverlapSource, views: readonly PrefixOverlapView[]) {
  const r = inspectContainedOverlapSource(source);if (r.status === "rejected") return r;
  if (!Array.isArray(views) || views.length !== 2 || new Set(views.map(v => v?.id)).size !== 2 || new Set(views.map(v => v?.windowStartMs)).size !== 2)
    return reject("two_distinct_views_required");
  const inspected = views.map(v => inspectView(r, v));
  const observations = inspected.flatMap(v => v.status === "view_supported" ? [v] : []);
  if (observations.length !== 2) return { ...reject("unsupported_observation"), observations: inspected };
  const prefixDifferences = observations.map(o => o.differences.filter(d => d.offset < r.p.length));
  if (JSON.stringify(prefixDifferences[0]) !== JSON.stringify(prefixDifferences[1]) ||
      observations.every(o => o.differences.some(d => d.offset >= r.p.length))) return reject("inconsistent_lexical_evidence");
  if ([0, 1].some(i => Math.abs(observations[0].points[i] - observations[1].points[i]) > 300)) return reject("unstable_time");
  const times = [source.cues[0].startMs, ...observations[0].points, source.cues[2].endMs];
  if (times.some((t, i) => i && t - times[i - 1] < 600)) return reject("short_result");
  return { status: "supported" as const, removedTail: r.tail, observations,
    replacements: source.cues.map((s, i) => ({ ...s, text: r.pieces[i], startMs: times[i], endMs: times[i + 1] })) };
}
