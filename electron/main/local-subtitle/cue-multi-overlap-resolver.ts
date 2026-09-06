import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import type { LocalSubtitlePostProcessingWindow as Window } from "./subtitle-post-processor";
import { inspectMultiOverlapSource, type MultiOverlapSource } from "./cue-multi-overlap-evidence";

/** Only this one group may use two slots beyond the established optional admission cap. */
export function hasMultiOverlapBudget(roots: readonly string[], rootCount: number,
  primary: ReadonlyMap<string, number>, current: ReadonlyMap<string, number>) {
  return roots.length === 2 && roots[0] !== roots[1] && Number.isSafeInteger(rootCount) && rootCount >= 2 &&
    [...current.values()].reduce((sum, count) => sum + count, 0) + 2 <= rootCount * 2 + 2 &&
    roots.every(key => [1, 2].includes(primary.get(key) ?? 0) && current.get(key) === primary.get(key));
}
export function planMultiOverlapReview(input: {
  sourceIdentity: string; durationMs: number; leftWindow: Window; rightWindow: Window;
  leftRaw: readonly LocalSubtitleServerRawSegment[]; rightRaw: readonly LocalSubtitleServerRawSegment[];
  cues: readonly LocalSubtitleSegment[];
}) {
  const { leftWindow: a, rightWindow: b, cues } = input;
  if (a.retryDepth || b.retryDepth || a.rootPlanId !== b.rootPlanId || a.coreEndMs !== b.coreStartMs ||
      b.startMs >= a.endMs || b.startMs <= a.startMs || input.leftRaw.length < 2 || !input.rightRaw.length) return;
  const absolute = (s: LocalSubtitleServerRawSegment, w: Window) => ({ ...s, startMs: s.startMs + w.startMs, endMs: s.endMs + w.startMs });
  const lo = [absolute(input.leftRaw.at(-2)!, a), absolute(input.leftRaw.at(-1)!, a)] as const;
  const ro = absolute(input.rightRaw[0], b);
  if (lo[1].endMs > a.endMs + 100 || ro.endMs > b.endMs + 100) return;
  const sameText = (x: string, y: string) => x.replace(/\s/gu, "") === y.replace(/\s/gu, "");
  const matches = cues.flatMap((c, index) => {
    const second = cues[index + 1], right = cues[index + 2];
    return second && right && c.text === lo[0].text && c.startMs === lo[0].startMs && c.endMs === lo[0].endMs &&
      second.text === lo[1].text && second.startMs === lo[1].startMs && second.endMs === a.coreEndMs &&
      sameText(right.text, ro.text) && right.startMs === b.coreStartMs && right.endMs === ro.endMs ? [index] : [];
  });
  if (matches.length !== 1) return;
  const index = matches[0];
  const source: MultiOverlapSource = { sourceIdentity: input.sourceIdentity, left: [cues[index], cues[index + 1]],
    right: cues[index + 2], leftObserved: lo, rightObserved: ro };
  if (inspectMultiOverlapSource(source).status !== "source_supported") return;
  const starts = [b.startMs - 5000, b.startMs - 6000];
  if (starts.some(start => start < 0 || start > lo[0].startMs || start + 25000 > input.durationMs || start + 25000 < ro.endMs + 400)) return;
  const windows = starts.map((startMs, i): Window => {
    const endMs = startMs + 25000, key = `${b.windowKey}.multi-${i}`;
    return { ...b, windowKey: key, rootWindowKey: key, startMs, endMs, coreStartMs: startMs, coreEndMs: endMs,
      startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: startMs * 16, coreEndFrame: endMs * 16 };
  });
  return { source, indices: [index, index + 1, index + 2], windows, budgetRoots: [a.rootWindowKey, b.rootWindowKey] };
}
