import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import type { PrefixOverlapView } from "./cue-prefix-overlap-evidence";

type Span = Pick<LocalSubtitleSegment, "text" | "startMs" | "endMs">;
export interface MultiOverlapSource {
  readonly sourceIdentity: string;
  readonly left: readonly [LocalSubtitleSegment, LocalSubtitleSegment];
  readonly right: LocalSubtitleSegment;
  readonly leftObserved: readonly [Span, Span];
  readonly rightObserved: Span;
}
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });
const ignored = /^[、。！？!?，,；;：:\s]+$/u;
const quotes = /[「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u;
const terminal = /[。！？!?]/u;
const time = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const span = (s: Span) => s && typeof s.text === "string" && s.text.length > 0 && s.text.length <= 2048 &&
  time(s.startMs) && time(s.endMs) && s.endMs > s.startMs;
const unspaced = (s: string) => s.replace(/\s/gu, "");
const indexed = (text: string) => {
  const original = Array.from(graphemes.segment(text), g => g.segment), units: string[] = [], offsets: number[] = [];
  original.forEach((g, i) => { if (!ignored.test(g)) { units.push(g); offsets.push(i); } });
  return { original, units, offsets };
};
const positions = (a: readonly string[], b: readonly string[]) => a.flatMap((_, i) =>
  i + b.length <= a.length && b.every((x, j) => a[i + j] === x) ? [i] : []);
const reject = (reason: string) => ({ status: "rejected" as const, reason });

/** Account for the whole source range before requesting any additional audio. */
export function inspectMultiOverlapSource(source: MultiOverlapSource) {
  if (!source || !source.sourceIdentity || source.sourceIdentity.length > 256 || !Array.isArray(source.left) ||
      source.left.length !== 2 || !Array.isArray(source.leftObserved) || source.leftObserved.length !== 2 ||
      ![...source.left, source.right, ...source.leftObserved, source.rightObserved].every(span)) return reject("invalid_source");
  const [a, b] = source.left, [ao, bo] = source.leftObserved, r = source.right, ro = source.rightObserved;
  if ([a, b, r, ao, bo, ro].some(s => quotes.test(s.text)) || /[\r\n]/u.test(a.text + b.text) ||
      /[。！？!?]\s*$/u.test(a.text) || a.endMs !== b.startMs || b.endMs !== r.startMs ||
      a.startMs !== ao.startMs || a.endMs !== ao.endMs || b.startMs !== bo.startMs || b.endMs > bo.endMs ||
      r.startMs < ro.startMs || r.endMs !== ro.endMs ||
      Math.min(bo.endMs, ro.endMs) <= Math.max(bo.startMs, ro.startMs) ||
      unspaced(a.text) !== unspaced(ao.text) || unspaced(b.text) !== unspaced(bo.text) || unspaced(r.text) !== unspaced(ro.text))
    return reject("source_provenance");
  const ai = indexed(a.text), bi = indexed(b.text), x = indexed(a.text + b.text), y = indexed(r.text);
  if (bi.units.length < 6) return reject("short_source");
  let overlapLength = Math.min(x.units.length, y.units.length);
  for (; overlapLength >= 6; overlapLength--) if (x.units.slice(-overlapLength).every((g, i) => g === y.units[i])) break;
  if (overlapLength < bi.units.length + 2 || x.units.length - overlapLength < 6 || y.units.length - overlapLength < 12)
    return reject("not_multi_parent_overlap");
  const overlap = y.units.slice(0, overlapLength);
  if (positions(x.units, overlap).length !== 1 || positions(y.units, overlap).length !== 1 ||
      positions(y.units, bi.units).length !== 1) return reject("ambiguous_source");
  const rightCut = y.offsets[overlapLength];
  const text = a.text + b.text + y.original.slice(rightCut).join("").replace(/\r?\n/g, " ");
  const composed = indexed(text);
  if (composed.units.length > 1024 || composed.units.length !== x.units.length + y.units.length - overlapLength)
    return reject("composition_limit");
  return { status: "source_supported" as const, source, text, composed, overlap, overlapLength,
    rightCut, firstLength: ai.units.length, leftLength: x.units.length, removedPrefix: y.original.slice(0, rightCut).join("") };
}

type Token = { from: number; to: number; pointMs: number; segmentIndex: number };
type Boundary = { offset: number; pointMs: number };
type ViewEvidence = { id: string; quoted: boolean; boundaries: Boundary[]; firstPointMs: number; lastPointMs: number };

function inspectView(relation: Extract<ReturnType<typeof inspectMultiOverlapSource>, { status: "source_supported" }>, view: PrefixOverlapView) {
  if (!view || !view.id || view.sourceIdentity !== relation.source.sourceIdentity || view.mode !== "uncompressed_non_vad" ||
      !time(view.windowStartMs) || !time(view.windowEndMs) || view.windowEndMs <= view.windowStartMs ||
      !Array.isArray(view.segments) || !view.segments.length || view.segments.length > 128 ||
      view.segments.some((s: LocalSubtitleServerRawSegment) => !span(s)) ||
      view.segments.reduce((n: number, s: LocalSubtitleServerRawSegment) => n + s.text.length, 0) > 4096) return reject("invalid_view");
  const full = view.segments.map((s: LocalSubtitleServerRawSegment) => s.text).join("");
  const trimmed = full.trim(), quoted = trimmed.startsWith("「") && trimmed.endsWith("」");
  if (quotes.test(quoted ? trimmed.slice(1, -1) : full)) return reject("quoted_structure");
  // Only this module recognizes one outer wrapper, and requires an unquoted peer.
  const viewIndex = indexed(full.replace(/[「」]/gu, ""));
  const tokens: Token[] = [];let cursor = 0, previousPoint = -1, previousEnd = 0, count = 0;
  for (const [segmentIndex, s] of view.segments.entries()) {
    if (s.startMs < previousEnd || s.endMs > view.windowEndMs - view.windowStartMs || !Array.isArray(s.dtwTokens) ||
        (count += s.dtwTokens.length) > 4096 || s.dtwTokens.some((t: {text: string}) => typeof t?.text !== "string") ||
        s.dtwTokens.map((t: {text: string}) => t.text).join("") !== s.text) return reject("invalid_coverage");
    previousEnd = s.endMs;
    for (const t of s.dtwTokens) {
      const length = indexed(t.text.replace(/[「」]/gu, "")).units.length;
      if (!length) continue;
      if (!time(t.pointMs) || t.pointMs < previousPoint || t.pointMs > view.windowEndMs - view.windowStartMs) return reject("invalid_points");
      previousPoint = t.pointMs;
      tokens.push({ from: cursor, to: cursor + length, pointMs: t.pointMs + view.windowStartMs, segmentIndex });cursor += length;
    }
  }
  if (cursor !== viewIndex.units.length) return reject("grapheme_coverage");
  const matches = positions(viewIndex.units, relation.composed.units);
  if (matches.length !== 1 || positions(viewIndex.units, relation.overlap).length !== 1) return reject("not_unique_complete_text");
  const from = matches[0], end = from + relation.composed.units.length;
  const anchor = tokens.filter(t => t.from >= from && t.to <= end);
  if (!anchor.length || anchor[0].from !== from || anchor.at(-1)!.to !== end) return reject("partial_token");
  const { source } = relation;
  if (tokens.some(t => (t.to <= from || t.from >= end) &&
      t.pointMs >= source.left[0].startMs && t.pointMs <= source.right.endMs)) return reject("unmatched_speech_in_source_range");
  for (const t of anchor) {
    const position = t.from - from, finish = t.to - from;
    const scope = position < relation.firstLength ? source.leftObserved[0] : position < relation.leftLength ? source.leftObserved[1] : source.rightObserved;
    if (t.pointMs < scope.startMs - 400 || t.pointMs > scope.endMs + 400 ||
        position < relation.firstLength && finish > relation.firstLength || position < relation.leftLength && finish > relation.leftLength)
      return reject("source_point_bounds");
  }
  const boundaries: Boundary[] = [];
  for (let i = 1; i < anchor.length - 1; i++) {
    const t = anchor[i], previous = anchor[i - 1], offset = t.from - from;
    if (offset < relation.leftLength + 6 || relation.composed.units.length - offset < 12) continue;
    const gap = t.pointMs - previous.pointMs;
    if (gap < 120 || gap > 8000 || t.pointMs <= source.right.startMs || source.right.endMs - t.pointMs < 600) continue;
    const between = viewIndex.original.slice(viewIndex.offsets[t.from - 1] + 1, viewIndex.offsets[t.from]).join("");
    if (previous.segmentIndex === t.segmentIndex && !terminal.test(between)) continue;
    const cut = relation.composed.offsets[offset], before = relation.composed.original.slice(0, cut).join("");
    const word = Array.from(words.segment(relation.text)).find(w => w.index === before.length && w.isWordLike);
    if (!word || /^\p{Script=Hiragana}$/u.test(word.segment) || /^(?:です|ます|ない)$/u.test(word.segment)) continue;
    boundaries.push({ offset, pointMs: t.pointMs });
  }
  const evidence: ViewEvidence = { id: view.id, quoted, boundaries, firstPointMs: anchor[0].pointMs, lastPointMs: anchor.at(-1)!.pointMs };
  return { status: "view_supported" as const, evidence };
}

/** Resolve only one complete shared sentence boundary; preserve the original outer times. */
export function inspectMultiOverlapTiming(source: MultiOverlapSource, views: readonly PrefixOverlapView[]) {
  const relation = inspectMultiOverlapSource(source);
  if (relation.status === "rejected") return relation;
  if (!Array.isArray(views) || views.length !== 2 || new Set(views.map(v => v?.id)).size !== 2 ||
      new Set(views.map(v => v?.windowStartMs)).size !== 2) return reject("two_distinct_views_required");
  const inspected = views.map((v: PrefixOverlapView) => inspectView(relation, v));
  if (inspected.some(v => v.status === "rejected")) return { ...reject("unsupported_observation"), observations: inspected };
  const evidence = inspected.flatMap(v => v.status === "view_supported" ? [v.evidence] : []);
  if (evidence.every(v => v.quoted)) return reject("unquoted_peer_required");
  const shared = evidence[0].boundaries.filter(b => evidence[1].boundaries.some(c => c.offset === b.offset && Math.abs(c.pointMs - b.pointMs) <= 300));
  if (shared.length !== 1) return { ...reject("no_unique_shared_boundary"), observations: evidence };
  const boundary = shared[0], cut = relation.composed.offsets[boundary.offset];
  return { status: "supported" as const, removedPrefix: relation.removedPrefix, observations: evidence,
    replacements: [
      { ...source.left[0], text: relation.composed.original.slice(0, cut).join("").trimEnd(), endMs: boundary.pointMs },
      { ...source.right, text: relation.composed.original.slice(cut).join(""), startMs: boundary.pointMs },
    ] };
}
