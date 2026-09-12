import type { LocalSubtitleSegment } from "../../../../../src/subtitle-studio/transcription/domain";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import type { LocalSubtitlePostProcessingWindow as Window } from "./subtitle-post-processor";
import { inspectContainedOverlapSource, type ContainedOverlapSource } from "./cue-contained-overlap-evidence";
export function hasContainedOverlapBudget(roots: readonly string[], count: number, primary: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>, appliedMultiRoots: ReadonlySet<string>) {
  return roots.length === 2 && roots[0] !== roots[1] && Number.isSafeInteger(count) && count >= 2 &&
    [...current.values()].reduce((a, b) => a + b, 0) + 2 <= count * 2 + 4 && roots.every(key => {
      const base = primary.get(key) ?? 0, used = current.get(key);
      return [1, 2].includes(base) && (used === base || used === base + 1 && appliedMultiRoots.has(key));
    });
}
export function planContainedOverlapReview(input: {
  sourceIdentity: string; durationMs: number; leftWindow: Window; rightWindow: Window;
  leftRaw: readonly LocalSubtitleServerRawSegment[]; rightRaw: readonly LocalSubtitleServerRawSegment[];
  cues: readonly LocalSubtitleSegment[];
}) {
  const { leftWindow: a, rightWindow: b, cues } = input;
  if (a.retryDepth || b.retryDepth || a.rootPlanId !== b.rootPlanId || a.coreEndMs !== b.coreStartMs ||
      b.startMs >= a.endMs || b.startMs <= a.startMs || !input.leftRaw.length || input.rightRaw.length < 2) return;
  const absolute = (s: LocalSubtitleServerRawSegment, w: Window) => ({ ...s, startMs: s.startMs + w.startMs, endMs: s.endMs + w.startMs });
  const observed = [absolute(input.leftRaw.at(-1)!, a), absolute(input.rightRaw[0], b), absolute(input.rightRaw[1], b)] as const;
  const [ao, bo, co] = observed;
  if (co.endMs > b.endMs + 100) return;
  const equal = (x: string, y: string) => x.replace(/\s/gu, "") === y.replace(/\s/gu, "");
  const matches = cues.flatMap((c, index) => {
    const r = cues[index + 1], f = cues[index + 2];
    return r && f && equal(c.text, ao.text) && c.startMs === ao.startMs && c.endMs === a.coreEndMs &&
      equal(r.text, bo.text) && r.startMs === b.coreStartMs && r.endMs === bo.endMs &&
      equal(f.text, co.text) && f.startMs === co.startMs && f.endMs === co.endMs ? [index] : [];
  });
  if (matches.length !== 1) return;
  const i = matches[0], source: ContainedOverlapSource = { sourceIdentity: input.sourceIdentity,
    cues: [cues[i], cues[i + 1], cues[i + 2]], observed, leftWindowEndMs: a.endMs };
  if (inspectContainedOverlapSource(source).status !== "source_supported") return;
  const starts = [b.startMs - 5000, b.startMs - 6000];
  if (starts.some(s => s < 0 || s > ao.startMs || s + 20000 > input.durationMs || s + 20000 < co.endMs + 400)) return;
  const windows = starts.map((startMs, index): Window => {
    const endMs = startMs + 20000, key = `${b.windowKey}.contained-${index}`;
    return { ...b, windowKey: key, rootWindowKey: key, startMs, endMs, coreStartMs: startMs, coreEndMs: endMs,
      startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: startMs * 16, coreEndFrame: endMs * 16 };
  });
  return { source, indices: [i, i + 1, i + 2], windows, budgetRoots: [a.rootWindowKey, b.rootWindowKey] };
}
