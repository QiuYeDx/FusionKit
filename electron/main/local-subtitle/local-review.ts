import { createHash } from "node:crypto";
import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";

/** Review budgets are independent of inference retries and never authorize replacement. */
export const LOCAL_SUBTITLE_REVIEW_POLICY = Object.freeze({
  contextMs: 2_000,
  minWindowMs: 8_000,
  maxWindowMs: 30_000,
  maxWindows: 4,
  maxTotalAudioMs: 60_000,
  longSegmentMs: 15_000,
  repeatCount: 3,
  repeatGapMs: 3_000,
  maxConcerns: 128,
});

export interface ReviewSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface ReviewConcern {
  readonly startMs: number;
  readonly endMs: number;
  readonly kind: "long_segment" | "repeated_text" | "human_review" | "estimated_display_timing";
}

export interface LocalSubtitleReviewWindow {
  readonly windowKey: string;
  readonly sourceFingerprint: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly concernIndexes: readonly number[];
}

export interface LocalSubtitleReviewPlan {
  readonly schemaVersion: 1;
  readonly sourceFingerprint: string;
  readonly evidence: "review_hints_only";
  readonly concerns: readonly ReviewConcern[];
  readonly windows: readonly LocalSubtitleReviewWindow[];
  readonly deferredConcernCount: number;
  readonly totalAudioMs: number;
}

function fingerprint(durationMs: number, segments: readonly ReviewSegment[]): string {
  const digest = createHash("sha256").update(JSON.stringify(durationMs));
  for (const {startMs, endMs, text} of segments) digest.update(JSON.stringify([startMs, endMs, text]));
  return digest.digest("hex");
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validBounds(startMs: number, endMs: number, durationMs: number): boolean {
  return Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) &&
    startMs >= 0 && endMs > startMs && endMs <= durationMs;
}

function validateSegments(segments: readonly ReviewSegment[], durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs ||
      !Array.isArray(segments) || segments.length > LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments) throw Error("Invalid review source");
  let previousEnd = 0;
  for (const segment of segments) {
    if (!validBounds(segment.startMs, segment.endMs, durationMs) ||
        segment.startMs < previousEnd || typeof segment.text !== "string") throw Error("Invalid review timeline");
    previousEnd = segment.endMs;
  }
}

// This is a text comparison only, not semantic equivalence or acoustic evidence.
function comparisonText(segments: readonly ReviewSegment[]): string {
  return segments.map(segment => segment.text).join("").normalize("NFC").replace(/\s/gu, "");
}

function repeatedRanges(segments: readonly ReviewSegment[]): ReviewConcern[] {
  const ranges: ReviewConcern[] = [];
  let runStart = 0;
  for (let index = 1; index <= segments.length; index++) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (current && previous && comparisonText([previous]) &&
        comparisonText([current]) === comparisonText([previous]) &&
        current.startMs - previous.endMs <= LOCAL_SUBTITLE_REVIEW_POLICY.repeatGapMs) continue;
    if (index - runStart >= LOCAL_SUBTITLE_REVIEW_POLICY.repeatCount) {
      ranges.push({startMs: segments[runStart]!.startMs, endMs: previous!.endMs, kind: "repeated_text"});
    }
    runStart = index;
  }
  return ranges;
}

function windowKey(sourceFingerprint: string, startMs: number, endMs: number): string {
  return hash(["local-review-v1", sourceFingerprint, startMs, endMs]);
}

export function planLocalSubtitleReview(input: {
  readonly durationMs: number;
  readonly segments: readonly ReviewSegment[];
  readonly humanConcerns?: readonly Pick<ReviewConcern, "startMs" | "endMs">[];
  readonly estimatedTimingConcerns?: readonly Pick<ReviewConcern, "startMs" | "endMs">[];
}): LocalSubtitleReviewPlan {
  validateSegments(input.segments, input.durationMs);
  const policy = LOCAL_SUBTITLE_REVIEW_POLICY;
  const human = input.humanConcerns ?? [];
  const estimates = input.estimatedTimingConcerns ?? [];
  if (!Array.isArray(human) || human.length > policy.maxConcerns ||
      human.some(region => !validBounds(region.startMs, region.endMs, input.durationMs))) {
    throw Error("Invalid human review bounds");
  }
  if (!Array.isArray(estimates) || estimates.length > LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments ||
      estimates.some(region => !validBounds(region.startMs, region.endMs, input.durationMs))) {
    throw Error("Invalid estimated timing bounds");
  }
  // Human concerns get budget priority; never interpret annotation labels or notes here.
  const allConcerns: ReviewConcern[] = [
    ...human.map(region => ({startMs: region.startMs, endMs: region.endMs, kind: "human_review" as const})),
    ...input.segments.filter(segment => segment.endMs - segment.startMs > policy.longSegmentMs)
      .map(({startMs, endMs}) => ({startMs, endMs, kind: "long_segment" as const})),
    ...repeatedRanges(input.segments),
    ...estimates.map(({startMs, endMs}) => ({startMs, endMs, kind: "estimated_display_timing" as const})),
  ];
  const concerns = allConcerns.slice(0, policy.maxConcerns);
  const sourceFingerprint = fingerprint(input.durationMs, input.segments);
  let deferredConcernCount = allConcerns.length - concerns.length;
  const proposals: {startMs: number; endMs: number; concernIndexes: number[]}[] = [];
  for (const [index, concern] of concerns.entries()) {
    let startMs = Math.max(0, concern.startMs - policy.contextMs);
    let endMs = Math.min(input.durationMs, concern.endMs + policy.contextMs);
    const targetLength = Math.min(input.durationMs, policy.minWindowMs);
    if (endMs - startMs < targetLength) {
      startMs = Math.max(0, startMs - Math.ceil((targetLength - (endMs - startMs)) / 2));
      endMs = Math.min(input.durationMs, startMs + targetLength);
      startMs = Math.max(0, endMs - targetLength);
    }
    // Preserve whole overlapping cues when they fit; an overlong concern is deferred intact.
    for (const segment of input.segments) {
      if (segment.endMs <= startMs || segment.startMs >= endMs) continue;
      const nextStart = Math.min(startMs, segment.startMs);
      const nextEnd = Math.max(endMs, segment.endMs);
      if (nextEnd - nextStart <= policy.maxWindowMs) {
        startMs = nextStart;
        endMs = nextEnd;
      }
    }
    if (endMs - startMs > policy.maxWindowMs) {
      deferredConcernCount++;
      continue;
    }
    proposals.push({startMs, endMs, concernIndexes: [index]});
  }
  // Temporal merging first, then prioritize groups containing earlier (human-first) concerns.
  proposals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: typeof proposals = [];
  for (const proposal of proposals) {
    const previous = merged.at(-1);
    if (previous && proposal.startMs <= previous.endMs &&
        Math.max(previous.endMs, proposal.endMs) - previous.startMs <= policy.maxWindowMs) {
      previous.endMs = Math.max(previous.endMs, proposal.endMs);
      previous.concernIndexes.push(...proposal.concernIndexes);
    } else merged.push({...proposal, concernIndexes: [...proposal.concernIndexes]});
  }
  merged.sort((a, b) => Math.min(...a.concernIndexes) - Math.min(...b.concernIndexes));
  const windows: LocalSubtitleReviewWindow[] = [];
  let totalAudioMs = 0;
  for (const proposal of merged) {
    const duration = proposal.endMs - proposal.startMs;
    if (windows.length >= policy.maxWindows || totalAudioMs + duration > policy.maxTotalAudioMs) {
      deferredConcernCount += proposal.concernIndexes.length;
      continue;
    }
    totalAudioMs += duration;
    windows.push(Object.freeze({
      ...proposal,
      concernIndexes: Object.freeze(proposal.concernIndexes),
      sourceFingerprint,
      windowKey: windowKey(sourceFingerprint, proposal.startMs, proposal.endMs),
    }));
  }
  return Object.freeze({schemaVersion: 1, sourceFingerprint, evidence: "review_hints_only",
    concerns: Object.freeze(concerns.map(concern => Object.freeze(concern))),
    windows: Object.freeze(windows.sort((a, b) => a.startMs - b.startMs)),
    deferredConcernCount, totalAudioMs});
}

export type LocalSubtitleCandidateRisk =
  | "empty_candidate" | "text_changed" | "timing_changed" | "repeated_text"
  | "touches_window_edge" | "source_crosses_window_edge" | "overlaps_outside_source";

export function assessLocalSubtitleReviewCandidate(input: {
  readonly durationMs: number;
  readonly sourceSegments: readonly ReviewSegment[];
  readonly window: LocalSubtitleReviewWindow;
  readonly candidate: {
    readonly windowKey: string;
    readonly sourceFingerprint: string;
    readonly segments: readonly ReviewSegment[];
  };
}) {
  validateSegments(input.sourceSegments, input.durationMs);
  const { window, candidate } = input;
  if (!validBounds(window.startMs, window.endMs, input.durationMs) ||
      window.endMs - window.startMs > LOCAL_SUBTITLE_REVIEW_POLICY.maxWindowMs ||
      window.sourceFingerprint !== fingerprint(input.durationMs, input.sourceSegments) ||
      window.windowKey !== windowKey(window.sourceFingerprint, window.startMs, window.endMs) ||
      candidate.windowKey !== window.windowKey || candidate.sourceFingerprint !== window.sourceFingerprint) {
    throw Error("Stale or mismatched review candidate");
  }
  validateSegments(candidate.segments, window.endMs - window.startMs);
  const projected = candidate.segments.map(segment => Object.freeze({
    startMs: segment.startMs + window.startMs,
    endMs: segment.endMs + window.startMs,
    text: segment.text,
  }));
  const source = input.sourceSegments.filter(segment => segment.endMs > window.startMs && segment.startMs < window.endMs);
  const sameText = comparisonText(source) === comparisonText(projected);
  const sameTiming = source.length === projected.length && source.every((segment, index) =>
    segment.startMs === projected[index]!.startMs && segment.endMs === projected[index]!.endMs);
  const risks: LocalSubtitleCandidateRisk[] = [];
  if (!comparisonText(projected)) risks.push("empty_candidate");
  if (!sameText) risks.push("text_changed");
  if (!sameTiming) risks.push("timing_changed");
  if (repeatedRanges(projected).length > 0) risks.push("repeated_text");
  if (projected.some(segment => segment.startMs === window.startMs || segment.endMs === window.endMs)) risks.push("touches_window_edge");
  if (source.some(segment => segment.startMs < window.startMs || segment.endMs > window.endMs)) risks.push("source_crosses_window_edge");
  // A partially intersecting original cue also belongs outside the candidate replacement region.
  if (source.some(segment => (segment.startMs < window.startMs || segment.endMs > window.endMs) &&
      projected.some(other => other.startMs < segment.endMs && other.endMs > segment.startMs))) risks.push("overlaps_outside_source");
  return Object.freeze({
    windowKey: window.windowKey,
    sourceFingerprint: window.sourceFingerprint,
    textRelation: sameText ? "same_whitespace_normalized_text" as const : "changed" as const,
    timingRelation: sameTiming ? "same" as const : "changed" as const,
    acousticVerification: "unverified" as const,
    automaticReplacementAllowed: false as const,
    risks: Object.freeze(risks),
    projectedSegments: Object.freeze(projected),
  });
}
