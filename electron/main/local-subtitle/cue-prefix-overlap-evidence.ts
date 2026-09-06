import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
export interface PrefixOverlapSource {
  readonly sourceIdentity: string;
  readonly left: LocalSubtitleSegment;
  readonly right: LocalSubtitleSegment;
  readonly leftObservation: Pick<LocalSubtitleServerRawSegment, "text" | "startMs" | "endMs">;
  readonly rightObservation: Pick<LocalSubtitleServerRawSegment, "text" | "startMs" | "endMs">;
}
export interface PrefixOverlapView {
  readonly id: string;
  readonly sourceIdentity: string;
  readonly mode: "uncompressed_non_vad";
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly segments: readonly LocalSubtitleServerRawSegment[];
}
type Observation = { id: string; supported: false; reason: string } | {
  id: string; supported: true; candidateMs: number; prefixLastPointMs: number;
  gapMs: number; longGap: boolean; nativeBoundary: boolean;
};
const reject = (reason: string, observations: Observation[] = []) => ({ status: "rejected" as const, reason, observations });
/** Exact source positions and full correspondence; shared by production and offline review. */
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });
const split = (text: string) => Array.from(graphemes.segment(text), s => s.segment);
const ignored = /^[、。！？!?，,；;：:\s]+$/u;
const indexed = (text: string) => {
  const original = split(text), units: string[] = [], positions: number[] = [];
  original.forEach((s, i) => { if (!ignored.test(s)) { units.push(s); positions.push(i); } });
  return { original, units, positions };
};
const positions = (text: readonly string[], part: readonly string[]) => {
  const result = [];
  for (let i = 0; i + part.length <= text.length; i++) if (part.every((s, j) => s === text[i + j])) result.push(i);
  return result;
};
const time = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const validSource = (c: PrefixOverlapSource["leftObservation"]) => c && typeof c.text === "string" && c.text.length > 0 && c.text.length <= 4096 &&
  !/[\r\n「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u.test(c.text) && time(c.startMs) && time(c.endMs) && c.endMs > c.startMs;

export function inspectPrefixOverlapSource(source: PrefixOverlapSource) {
  if (!source || typeof source.sourceIdentity !== "string" || !source.sourceIdentity || source.sourceIdentity.length > 256 ||
      ![source.left, source.right, source.leftObservation, source.rightObservation].every(validSource)) return reject("invalid_input");
  const { left, right, leftObservation: lo, rightObservation: ro } = source;
  if (lo.text !== left.text || ro.text !== right.text || lo.startMs !== left.startMs || lo.endMs !== left.endMs ||
      ro.endMs !== right.endMs || ro.startMs > right.startMs || left.endMs > right.startMs ||
      Math.min(lo.endMs, ro.endMs) <= Math.max(lo.startMs, ro.startMs)) return reject("invalid_source_provenance");
  const x = indexed(left.text), y = indexed(right.text);
  let length = Math.min(x.units.length, y.units.length);
  for (; length >= 6; length--) if (x.units.slice(-length).every((s, i) => s === y.units[i])) break;
  if (length < 6 || length >= x.units.length || y.units.length - length < 6) return reject("no_partial_prefix");
  const prefix = y.units.slice(0, length), remainder = y.units.slice(length);
  if (positions(x.units, prefix).length !== 1 || positions(y.units, prefix).length !== 1 ||
      positions(y.units, remainder).length !== 1) return reject("ambiguous_source");
  const cutOffset = y.positions[length], before = y.original.slice(0, cutOffset).join("");
  const targetWord = Array.from(words.segment(right.text)).find(w => w.index === before.length && w.isWordLike);
  if (!targetWord || /^\p{Script=Hiragana}$/u.test(targetWord.segment) || /^(?:だ|です|ます|を|は|が|に|で|と|て|た|ない|か)$/u.test(targetWord.segment))
    return reject("unsafe_word_boundary");
  return { status: "source_supported" as const, left, right, y, length, prefix, remainder, cutOffset, before };
}

export function inspectPrefixOverlapTiming(source: PrefixOverlapSource, views: readonly PrefixOverlapView[]) {
  if (!Array.isArray(views) || views.length < 2 || views.length > 4) return reject("invalid_input");
  const relation = inspectPrefixOverlapSource(source);
  if (relation.status === "rejected") return relation;
  const { left, right, y, length, prefix, remainder, cutOffset, before } = relation;
  const observations = views.map((view: PrefixOverlapView): Observation => {
    const fail = (reason: string): Observation => ({ id: view?.id, supported: false, reason });
    if (!view || typeof view.id !== "string" || !view.id || view.sourceIdentity !== source.sourceIdentity ||
        view.mode !== "uncompressed_non_vad" || !time(view.windowStartMs) || !time(view.windowEndMs) ||
        view.windowEndMs <= view.windowStartMs || !Array.isArray(view.segments) || view.segments.length > 128 ||
        view.segments.some(s => typeof s?.text !== "string") || view.segments.reduce((n, s) => n + s.text.length, 0) > 4096)
      return fail("invalid_view");
    let cursor = 0, previousEnd = 0, previousPoint = -1, tokenCount = 0;
    const tokens = [];
    for (const [segmentIndex, s] of view.segments.entries()) {
      if (!time(s.startMs) || !time(s.endMs) || s.endMs <= s.startMs || s.startMs < previousEnd ||
          s.endMs > view.windowEndMs - view.windowStartMs || !Array.isArray(s.dtwTokens) ||
          (tokenCount += s.dtwTokens.length) > 4096 || s.dtwTokens.some((t: { text: string }) => typeof t?.text !== "string") ||
          s.dtwTokens.map((t: { text: string }) => t.text).join("") !== s.text) return fail("invalid_segments_or_coverage");
      previousEnd = s.endMs;
      for (const t of s.dtwTokens) {
        const from = cursor; cursor += indexed(t.text).units.length;
        if (cursor === from) continue;
        if (!time(t.pointMs) || t.pointMs < previousPoint || t.pointMs > view.windowEndMs - view.windowStartMs)
          return fail("invalid_points");
        previousPoint = t.pointMs;
        tokens.push({ from, to: cursor, pointMs: t.pointMs + view.windowStartMs, segmentIndex });
      }
    }
    const b = indexed(view.segments.map(s => s.text).join(""));
    if (cursor !== b.units.length) return fail("grapheme_mismatch");
    const matches = positions(b.units, y.units);
    if (matches.length !== 1 || positions(b.units, prefix).length !== 1 || positions(b.units, remainder).length !== 1)
      return fail("not_unique_complete_correspondence");
    const from = matches[0], at = from + length, end = from + y.units.length;
    const anchor = tokens.filter(t => t.from >= from && t.to <= end);
    const first = anchor[0], last = anchor.at(-1), targetIndex = anchor.findIndex(t => t.from === at);
    if (!first || !last || first.from !== from || last.to !== end || targetIndex < 1 || targetIndex >= anchor.length - 1)
      return fail("token_interior_or_short_anchor");
    const previous = anchor[targetIndex - 1], target = anchor[targetIndex];
    const between = b.original.slice(b.positions[at - 1] + 1, b.positions[at]).join("");
    if (previous.segmentIndex === target.segmentIndex && !/[。！？!?]/u.test(between)) return fail("missing_sentence_evidence");
    const gapMs = target.pointMs - previous.pointMs;
    if (first.pointMs < left.startMs - 400 || previous.pointMs > left.endMs + 400 ||
        previous.pointMs < left.startMs || target.pointMs < right.startMs ||
        right.endMs - target.pointMs < 600 || last.pointMs > right.endMs + 400 || gapMs < 80 || gapMs > 8000)
      return fail("time_bounds");
    return { id: view.id, supported: true, candidateMs: target.pointMs, prefixLastPointMs: previous.pointMs,
      gapMs, longGap: gapMs > 2500, nativeBoundary: previous.segmentIndex !== target.segmentIndex };
  });
  if (new Set(views.map(v => v?.id)).size !== views.length || new Set(views.map(v => v?.windowStartMs)).size !== views.length)
    return reject("duplicate_observations", observations);
  const supported = observations.filter((o): o is Extract<Observation, { supported: true }> => o.supported);
  if (supported.length !== observations.length) return reject("unsupported_observation", observations);
  if (Math.max(...supported.map(o => o.candidateMs)) - Math.min(...supported.map(o => o.candidateMs)) > 300)
    return reject("unstable_time", observations);
  return { status: "supported" as const, sourceIdentity: source.sourceIdentity,
    replacement: { ...right, text: y.original.slice(cutOffset).join(""), startMs: supported[0].candidateMs },
    removedPrefix: before, sourceCutGrapheme: cutOffset, observations };
}
