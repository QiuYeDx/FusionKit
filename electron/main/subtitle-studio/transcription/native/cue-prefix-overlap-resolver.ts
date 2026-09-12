import type { LocalSubtitleSegment } from "../../../../../src/subtitle-studio/transcription/domain";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import type { LocalSubtitlePostProcessingWindow as Window } from "./subtitle-post-processor";
import { inspectPrefixOverlapSource, type PrefixOverlapSource } from "./cue-prefix-overlap-evidence";

/** Reserve the entire two-observation group before starting either request. */
export function hasPrefixOverlapBudget(roots: readonly string[], rootCount: number,
  acceptedPrimaryCounts: ReadonlyMap<string, number>, currentCounts: ReadonlyMap<string, number>) {
  return roots.length === 2 && roots[0] !== roots[1] && Number.isSafeInteger(rootCount) && rootCount >= 2 &&
    [...currentCounts.values()].reduce((sum, count) => sum + count, 0) + 2 <= rootCount * 2 &&
    roots.every(key => [1, 2].includes(acceptedPrimaryCounts.get(key) ?? 0) &&
      currentCounts.get(key) === acceptedPrimaryCounts.get(key));
}

export function planPrefixOverlapReview(input: {
  sourceIdentity: string; durationMs: number; leftWindow: Window; rightWindow: Window;
  leftRaw: readonly LocalSubtitleServerRawSegment[]; rightRaw: readonly LocalSubtitleServerRawSegment[];
  cues: readonly LocalSubtitleSegment[];
}) {
  const { leftWindow: a, rightWindow: b, cues } = input;
  const lo = input.leftRaw.at(-1), ro = input.rightRaw[0];
  if (!lo || !ro || a.retryDepth || b.retryDepth || a.rootPlanId !== b.rootPlanId ||
      a.coreEndMs !== b.coreStartMs || b.startMs >= a.endMs || b.startMs <= a.startMs) return;
  const leftObservation = { ...lo, startMs: lo.startMs + a.startMs, endMs: lo.endMs + a.startMs };
  const rightObservation = { ...ro, startMs: ro.startMs + b.startMs, endMs: ro.endMs + b.startMs };
  const leftIndices = cues.flatMap((c, i) => c.text === lo.text && c.startMs === leftObservation.startMs &&
    c.endMs === leftObservation.endMs ? [i] : []);
  const rightIndices = cues.flatMap((c, i) => c.text === ro.text && c.startMs === b.coreStartMs &&
    c.endMs === rightObservation.endMs ? [i] : []);
  if (leftIndices.length !== 1 || rightIndices.length !== 1 || rightIndices[0] !== leftIndices[0] + 1) return;
  const leftIndex = leftIndices[0], rightIndex = rightIndices[0];
  const source: PrefixOverlapSource = { sourceIdentity: input.sourceIdentity, left: cues[leftIndex], right: cues[rightIndex],
    leftObservation, rightObservation };
  if (inspectPrefixOverlapSource(source).status !== "source_supported") return;
  const starts = [b.startMs - 5000, b.startMs - 6000];
  if (starts.some(start => start < 0 || start > leftObservation.startMs ||
      start + 20000 > input.durationMs || start + 20000 < rightObservation.endMs + 400)) return;
  const windows: Window[] = starts.map((startMs, index) => {
    const endMs = startMs + 20000, key = `${b.windowKey}.prefix-${index}`;
    return Object.freeze({ ...b, windowKey: key, rootWindowKey: key, startMs, endMs,
      coreStartMs: startMs, coreEndMs: endMs, startFrame: startMs * 16, endFrame: endMs * 16,
      coreStartFrame: startMs * 16, coreEndFrame: endMs * 16 });
  });
  return { source, leftIndex, rightIndex, windows, budgetRoots: [a.rootWindowKey, b.rootWindowKey] };
}
