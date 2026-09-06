import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { OverlapGroupReview } from "./overlap-group-review";
import type { PrefixOverlapView } from "./cue-prefix-overlap-evidence";

const units = (text: string) => Array.from(text.normalize("NFKC").replace(/[\p{P}\s]/gu, ""));
const time = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
const places = (all: string[], part: string[]) => all.flatMap((_, i) =>
  part.length && i + part.length <= all.length && part.every((s, j) => s === all[i + j]) ? [i] : []);
const rejected = (reason: string) => ({ status: "rejected" as const, reason });

/** An explicit source choice is a review draft, never authority to overwrite a transcript. */
export function draftOverlapGroupSplice(review: OverlapGroupReview, cues: readonly LocalSubtitleSegment[], keep: "left" | "right") {
  if (!review || review.status !== "review_required" || !["left", "right"].includes(keep) ||
      !review.left.length || !review.right.length || review.left.length > 3 || review.right.length > 3) return rejected("invalid_group");
  const members = [...review.left, ...review.right], indices = members.map(m => m.cueIndex);
  if (indices.some((n, i) => !Number.isSafeInteger(n) || n < 0 || i > 0 && n !== indices[i - 1] + 1) ||
      indices.length !== review.indices.length || indices.some((n, i) => n !== review.indices[i])) return rejected("invalid_indices");
  for (const [i, m] of members.entries()) {
    const c = cues[m.cueIndex], s = m.observed, left = i < review.left.length;
    if (!c || c.text !== s.text.trim() || !time(s.startMs) || !time(s.endMs) || s.endMs <= s.startMs ||
        c.startMs !== (left ? s.startMs : Math.max(review.seamMs, s.startMs)) ||
        c.endMs !== (left ? Math.min(review.seamMs, s.endMs) : s.endMs)) return rejected("stale_source_projection");
  }
  if (cues.some((c, i) => !time(c.startMs) || !time(c.endMs) || c.endMs <= c.startMs ||
      !c.text.trim() || i > 0 && c.startMs < cues[i - 1].endMs) || new Set(cues.map(c => c.id)).size !== cues.length)
    return rejected("invalid_current_timeline");
  const originals = indices.map(i => cues[i]), startMs = originals[0].startMs, endMs = originals.at(-1)!.endMs;
  if (endMs - startMs > 10000) return rejected("group_too_long");
  const retained = review[keep];
  const replacements = retained.map((m, i): LocalSubtitleSegment => Object.freeze({
    id: cues[m.cueIndex].id, text: m.observed.text.trim(), estimatedTiming: true,
    startMs: i ? m.observed.startMs : startMs,
    endMs: i === retained.length - 1 ? endMs : m.observed.endMs,
  }));
  if (replacements.some((c, i) => c.startMs < startMs || c.endMs > endMs || c.endMs <= c.startMs ||
      i > 0 && c.startMs < replacements[i - 1].endMs)) return rejected("unsafe_retained_timeline");
  const retainedText = replacements.map(c => c.text).join(""), other = review[keep === "left" ? "right" : "left"];
  const removedText = other.map(m => m.observed.text).join("");
  const completeContainment = places(units(retainedText), units(removedText)).length === 1;
  return Object.freeze({ status: "review_required" as const, sourceIdentity: review.sourceIdentity, keep,
    startMs, endMs, originals: Object.freeze(originals), replacements: Object.freeze(replacements),
    retainedText, removedText, completeContainment,
    warnings: Object.freeze(completeContainment ? [] : ["unaccounted_source_content"]),
    proposedCues: Object.freeze([...cues.slice(0, indices[0]), ...replacements, ...cues.slice(indices.at(-1)! + 1)]),
  });
}

/** Strict evidence tier. Lexical variants remain reviewable; no fuzzy deletion rule. */
export function inspectOverlapGroupSplice(review: OverlapGroupReview, cues: readonly LocalSubtitleSegment[],
  keep: "left" | "right", views: readonly PrefixOverlapView[]) {
  const draft = draftOverlapGroupSplice(review, cues, keep);
  if (draft.status === "rejected") return draft;
  if (!draft.completeContainment) return rejected("unaccounted_source_content");
  if (views.length !== 2 || new Set(views.map(v => v.id)).size !== 2 ||
      new Set(views.map(v => v.windowStartMs)).size !== 2) return rejected("two_distinct_observations_required");
  const target = units(draft.retainedText), other = units(draft.removedText);
  const observations: { id: string; points: number[] }[] = [];
  for (const [vi, view] of views.entries()) {
    const w = review.windows[vi];
    if (!w || view.id !== w.windowKey || view.sourceIdentity !== review.sourceIdentity || view.mode !== "uncompressed_non_vad" ||
        view.windowStartMs !== w.startMs || view.windowEndMs !== w.endMs || !view.segments.length || view.segments.length > 128 ||
        view.segments.reduce((n, s) => n + s.text.length, 0) > 4096) return rejected("invalid_observation_identity");
    let previousEnd = 0, previousPoint = -1;
    const all: string[] = [], points: number[] = [], segmentOffsets: number[] = [0];
    for (const s of view.segments) {
      if (!time(s.startMs) || !time(s.endMs) || s.endMs <= s.startMs || s.startMs < previousEnd ||
          s.endMs > w.endMs - w.startMs || !s.dtwTokens?.length || s.dtwTokens.length > 4096 ||
          s.dtwTokens.map(t => t.text).join("") !== s.text) return rejected("invalid_observation_coverage");
      previousEnd = s.endMs;
      const segmentUnits: string[] = [];
      for (const t of s.dtwTokens) {
        const u = units(t.text);if (!u.length) continue;
        if (!time(t.pointMs) || t.pointMs < previousPoint || t.pointMs > w.endMs - w.startMs) return rejected("invalid_observation_points");
        previousPoint = t.pointMs;segmentUnits.push(...u);points.push(...u.map(() => w.startMs + t.pointMs!));
      }
      if (segmentUnits.join("") !== units(s.text).join("")) return rejected("invalid_normalized_coverage");
      all.push(...segmentUnits);segmentOffsets.push(all.length);
    }
    const found = places(all, target);
    if (found.length !== 1 || places(all, other).length !== 1) return rejected("missing_or_repeated_complete_text");
    const from = found[0], to = from + target.length;
    // Accept complete observation segments only, including all leading/trailing words.
    if (!segmentOffsets.includes(from) || !segmentOffsets.includes(to)) return rejected("partial_observation_group");
    const candidatePoints = points.slice(from, to);
    if (points.some((p, i) => (i < from || i >= to) && p >= draft.startMs && p <= draft.endMs)) return rejected("unaccounted_observation_content");
    if (candidatePoints.some(p => p < draft.startMs - 400 || p > draft.endMs + 400) ||
        candidatePoints.at(-1)! - candidatePoints[0] < 600) return rejected("unsupported_group_time");
    // The shared occurrence must also occupy both source observations' time ranges.
    const commonStart = places(target, other)[0];
    let cursor = commonStart;
    const removed = review[keep === "left" ? "right" : "left"];
    for (const m of removed) {
      const end = cursor + units(m.observed.text).length;
      if (candidatePoints.slice(cursor, end).some(p => p < m.observed.startMs - 400 || p > m.observed.endMs + 400))
        return rejected("source_time_disagrees");
      cursor = end;
    }
    cursor = 0;
    for (const m of review[keep]) {
      const end = cursor + units(m.observed.text).length;
      if (candidatePoints.slice(cursor, end).some(p => p < m.observed.startMs - 400 || p > m.observed.endMs + 400))
        return rejected("source_time_disagrees");
      cursor = end;
    }
    observations.push({id: view.id, points: candidatePoints});
  }
  if (observations[0].points.some((p, i) => Math.abs(p - observations[1].points[i]) > 300)) return rejected("unstable_group_time");
  return Object.freeze({status: "supported" as const, draft, observations: Object.freeze(observations)});
}
