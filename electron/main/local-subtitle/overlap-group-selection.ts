import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { OverlapGroupReview } from "./overlap-group-review";
import type { PrefixOverlapView } from "./cue-prefix-overlap-evidence";
import { draftOverlapGroupSplice, inspectOverlapGroupSplice } from "./overlap-group-splice";

const sides = ["left", "right"] as const;
/** Preflight before spending requests. Missing source words cannot be fixed by choosing a side. */
export function overlapGroupSourceOptions(review: OverlapGroupReview, cues: readonly LocalSubtitleSegment[]) {
  return sides.filter(side => {
    const draft = draftOverlapGroupSplice(review, cues, side);
    return draft.status === "review_required" && draft.completeContainment;
  });
}

export function selectOverlapGroupSource(review: OverlapGroupReview, cues: readonly LocalSubtitleSegment[], views: readonly PrefixOverlapView[]) {
  const options = overlapGroupSourceOptions(review, cues);
  if (!options.length) return {status: "rejected" as const, reason: "no_complete_source"};
  const inspected = options.map(keep => ({keep, decision: inspectOverlapGroupSplice(review, cues, keep, views)}));
  const supported = inspected.filter(r => r.decision.status === "supported");
  const chosen = supported[0];
  if (!chosen || chosen.decision.status !== "supported") return {status: "rejected" as const, reason: "unsupported_observations", inspected};
  // Two supported sides necessarily contain each other: retain existing left divisions.
  // Never rank differing words by length, confidence, or number of cues.
  return {status: "supported" as const, keep: chosen.keep, draft: chosen.decision.draft,
    reason: supported.length === 2 ? "equivalent_sources_keep_left" : "only_supported_complete_source", inspected};
}
