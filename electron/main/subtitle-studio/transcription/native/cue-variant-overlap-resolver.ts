import type { LocalSubtitleSegment } from "../../../../../src/subtitle-studio/transcription/domain";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import type { LocalSubtitlePostProcessingWindow as Window } from "./subtitle-post-processor";
import { hasVariantSentenceEnd, inspectVariantOverlapSource, type VariantOverlapSource } from "./cue-variant-overlap-evidence";
export function hasVariantOverlapBudget(roots: readonly string[], count: number, primary: ReadonlyMap<string, number>, current: ReadonlyMap<string, number>, appliedRoots: ReadonlySet<string>) {
  return roots.length === 2 && roots[0] !== roots[1] && Number.isSafeInteger(count) && count >= 2 &&
    [...current.values()].reduce((a, b) => a + b, 0) + 2 <= count * 2 + 6 && roots.every(key => {
      const base = primary.get(key) ?? 0, used = current.get(key);
      return [1, 2].includes(base) && (used === base || used === base + 1 && appliedRoots.has(key));
    });
}
export function planVariantOverlapReview(input: {
  sourceIdentity: string; durationMs: number; leftWindow: Window; rightWindow: Window;
  leftRaw: readonly LocalSubtitleServerRawSegment[]; rightRaw: readonly LocalSubtitleServerRawSegment[]; cues: readonly LocalSubtitleSegment[];
}) {
  const { leftWindow: a, rightWindow: b, cues } = input;
  if (a.retryDepth || b.retryDepth || a.rootPlanId !== b.rootPlanId || a.coreEndMs !== b.coreStartMs || b.startMs >= a.endMs ||
      b.startMs <= a.startMs || !input.leftRaw.length || input.rightRaw.length < 2) return;
  const absolute = (s: LocalSubtitleServerRawSegment, w: Window) => ({ ...s, startMs: s.startMs + w.startMs, endMs: s.endMs + w.startMs });
  const ao = absolute(input.leftRaw.at(-1)!, a), raw = input.rightRaw.map(s => absolute(s, b));
  const equal = (x: string, y: string) => x.replace(/\s/gu, "") === y.replace(/\s/gu, "");
  const proposals = [];
  for (const offset of [0, 1]) {
    const after = raw.slice(offset, offset + 6), lastIndex = after.findIndex(s => hasVariantSentenceEnd(s.text));
    if (lastIndex < 1) continue;
    const observed = after.slice(0, lastIndex + 1), last = observed.at(-1)!;
    if (last.endMs > b.endMs + 100 || offset && cues.some(c => equal(c.text, raw[0].text))) continue;
    for (let i = 0; i + observed.length < cues.length; i++) {
      const left = cues[i], right = cues.slice(i + 1, i + 1 + observed.length);
      if (!equal(left.text, ao.text) || left.startMs !== ao.startMs || left.endMs !== a.coreEndMs ||
          right.some((c, j) => !equal(c.text, observed[j].text) || c.startMs !== (j ? observed[j].startMs : b.coreStartMs) || c.endMs !== observed[j].endMs)) continue;
      const source: VariantOverlapSource = { sourceIdentity: input.sourceIdentity, left, right, leftObserved: ao, rightObserved: observed,
        leftWindowEndMs: a.endMs, ...(offset ? { skipped: raw[0] } : {}) };
      if (inspectVariantOverlapSource(source).status !== "source_supported") continue;
      const starts = [b.startMs - 10000, b.startMs - 11000];
      if (starts.some(start => start < 0 || start > ao.startMs || start + 30000 > input.durationMs || start + 30000 < last.endMs + 400)) continue;
      const windows = starts.map((startMs, n): Window => {
        const endMs = startMs + 30000, key = `${b.windowKey}.variant-${n}`;
        return { ...b, windowKey: key, rootWindowKey: key, startMs, endMs, coreStartMs: startMs, coreEndMs: endMs,
          startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: startMs * 16, coreEndFrame: endMs * 16 };
      });
      proposals.push({ source, indices: [i, ...right.map((_, j) => i + 1 + j)], windows, budgetRoots: [a.rootWindowKey, b.rootWindowKey] });
    }
  }
  return proposals.length === 1 ? proposals[0] : undefined;
}
