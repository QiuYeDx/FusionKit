/** Offline audit only. Stable token intervals do not authorize subtitle timings. */
import { findInsertionOnlySpans } from "./local-boundary-evidence.mjs";

const units = text => Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text), x => x.segment);
const lexical = /[\p{L}\p{N}]/u;
const millis = value => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) : NaN;

function inspect(source, offset, view, timing) {
  const fail = reason => ({ id: view?.id, reasons: [reason], interval: null, nativeBoundaryMs: null });
  if (!view || view.mode !== "uncompressed_non_vad" || view.mediaSha256 !== source.mediaSha256 ||
      !Number.isSafeInteger(view.windowStartMs) || view.windowStartMs < 0 ||
      !Number.isSafeInteger(view.windowEndMs) || view.windowEndMs <= view.windowStartMs ||
      !Array.isArray(view.segments) || view.segments.length > 128) return fail("invalid_provenance");
  let previousEnd = 0;
  for (const segment of view.segments) {
    const start = millis(segment?.start), end = millis(segment?.end);
    if (typeof segment?.text !== "string" || !segment.text || segment.text.length > 4096 ||
        !(start >= previousEnd && end > start && end + view.windowStartMs <= view.windowEndMs)) return fail("invalid_segments");
    previousEnd = end;
  }
  if (view.segments.reduce((sum, s) => sum + s.text.length, 0) > 8192) return fail("text_budget_exceeded");
  const groups = [];
  let budget = 200000;
  for (let first = 0; first < view.segments.length; first++) {
    let text = "";
    for (let last = first; last < view.segments.length; last++) {
      text += view.segments[last].text;
      if (text.length > source.text.length * 2 + 16) break;
      budget -= source.text.length * text.length;
      if (budget < 0) return fail("comparison_budget_exceeded");
      const matches = findInsertionOnlySpans(source.text, text);
      // Uniqueness is checked in the entire parent, never by choosing a nearby time.
      if (matches.length !== 1) continue;
      const match = matches[0];
      if (match.end - match.start >= 12 && match.start < offset && offset < match.end) groups.push({ first, last, match });
    }
  }
  groups.sort((a, b) => (b.match.end - b.match.start) - (a.match.end - a.match.start));
  const best = groups[0];
  if (!best) return fail("no_exact_complete_group");
  if (groups[1] && groups[1].match.end - groups[1].match.start === best.match.end - best.match.start) return fail("ambiguous_group");
  const words = [];
  let candidateOffset = 0;
  for (let index = best.first; index <= best.last; index++) {
    const segment = view.segments[index];
    if (!Array.isArray(segment.words) || segment.words.length > 4096 ||
        segment.words.some(w => typeof w?.word !== "string") ||
        segment.words.map(w => w.word).join("") !== segment.text) return fail("word_text_coverage_mismatch");
    let previousWordEnd = millis(segment.start);
    for (const word of segment.words) {
      const start = millis(word.start), end = millis(word.end);
      if (timing === "ordinary" && !(start >= previousWordEnd && end >= start && end <= millis(segment.end))) return fail("invalid_word_order");
      previousWordEnd = end;
      const from = best.match.offsets[candidateOffset];
      candidateOffset += units(word.word).length;
      const to = best.match.offsets[candidateOffset];
      if (lexical.test(word.word)) words.push({ word: word.word, from, to, start, end, segmentIndex: index,
        ...(timing === "dtw" ? { dtw: word.t_dtw } : {}) });
    }
  }
  if (words.some(w => w.from < offset && offset < w.to)) return fail("inside_token");
  const left = words.findLast(w => w.to === offset), right = words.find(w => w.from === offset);
  if (!left || !right) return fail("missing_adjacent_words");
  if (timing === "dtw") {
    let previousPoint = -1;
    for (const word of words) {
      if (!Number.isSafeInteger(word.dtw) || word.dtw < 0 ||
          word.dtw * 10 + view.windowStartMs > view.windowEndMs || word.dtw < previousPoint) return fail("invalid_dtw_sequence");
      previousPoint = word.dtw;
    }
    const points = { leftPointMs: view.windowStartMs + left.dtw * 10, rightPointMs: view.windowStartMs + right.dtw * 10 };
    const reasons = [];
    if (points.leftPointMs >= points.rightPointMs) reasons.push("degenerate_dtw_boundary");
    if (points.leftPointMs <= source.startMs || points.rightPointMs >= source.endMs) reasons.push("outside_parent");
    return { id: view.id, group: [best.first, best.last], sourceSpan: [best.match.start, best.match.end],
      points, reasons, semantics: "token_interior_points_not_speech_edges" };
  }
  const interval = { leftEndMs: view.windowStartMs + left.end, rightStartMs: view.windowStartMs + right.start };
  const reasons = [];
  if ([left, right].some(w => w.start === w.end || w.end - w.start > 2000)) reasons.push("invalid_adjacent_word");
  if (right.start - left.end < 0 || right.start - left.end > 1000) reasons.push("unsupported_word_gap");
  if (interval.leftEndMs <= source.startMs || interval.rightStartMs >= source.endMs) reasons.push("outside_parent");
  // Punctuation token times are deliberately not substituted for speech edges.
  const nativeBoundaryMs = left.segmentIndex !== right.segmentIndex
    ? view.windowStartMs + millis(view.segments[right.segmentIndex].start) : null;
  return { id: view.id, group: [best.first, best.last], sourceSpan: [best.match.start, best.match.end],
    left, right, interval, nativeBoundaryMs, reasons };
}

function audit(source, offset, observations, timing) {
  if (!source || typeof source.text !== "string" || source.text.length > 4096 ||
      !/^[a-f0-9]{64}$/u.test(source.mediaSha256 ?? "") ||
      !Number.isSafeInteger(source.startMs) || !Number.isSafeInteger(source.endMs) ||
      source.startMs < 0 || source.endMs <= source.startMs ||
      !Number.isSafeInteger(offset) || offset <= 0 || offset >= units(source.text).length ||
      !Array.isArray(observations) || observations.length < 2 || observations.length > 4 ||
      observations.some(v => typeof v?.id !== "string" || !v.id)) throw new Error("invalid_audit_input");
  const reasons = [];
  if (new Set(observations.map(v => v.id)).size !== observations.length ||
      new Set(observations.map(v => `${v.windowStartMs}:${v.windowEndMs}`)).size !== observations.length) reasons.push("duplicate_observation");
  if (new Set(observations.map(v => v.windowStartMs)).size < 2) reasons.push("no_shifted_window");
  const reviewed = observations.map(v => inspect(source, offset, v, timing));
  if (reviewed.some(v => v.reasons.length)) reasons.push("invalid_observation");
  const intervals = reviewed.map(v => timing === "dtw" ? v.points : v.interval).filter(Boolean);
  let spread = null;
  if (intervals.length === reviewed.length) {
    const range = key => Math.max(...intervals.map(i => i[key])) - Math.min(...intervals.map(i => i[key]));
    spread = Object.fromEntries((timing === "dtw" ? ["leftPointMs", "rightPointMs"] : ["leftEndMs", "rightStartMs"]).map(key => [key, range(key)]));
    if (Object.values(spread).some(value => value > 300)) reasons.push("window_disagreement");
  }
  return { offset, automaticAcceptance: false,
    ...(timing === "dtw" ? { stableDtwEvidence: reasons.length === 0 } : { stableWordEvidence: reasons.length === 0 }),
    reasons, spread, observations: reviewed };
}

export const auditLocalWordBoundary = (source, offset, observations) => audit(source, offset, observations, "ordinary");
export const auditLocalDtwBoundary = (source, offset, observations) => audit(source, offset, observations, "dtw");
