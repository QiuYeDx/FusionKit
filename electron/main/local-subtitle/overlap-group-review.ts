import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import type { LocalSubtitlePostProcessingWindow as Window } from "./subtitle-post-processor";

/** Admission only. Similar words and overlapping estimated times never authorize deletion. */
export const OVERLAP_GROUP_REVIEW_POLICY = Object.freeze({
  maxSegmentsPerSide: 3, minOverlapMs: 300, maxGroupMs: 10000,
  minUnits: 8, maxUnits: 160, minSimilarity: 0.72, witnessMs: 20000,
});
interface Member {
  readonly rawIndex: number;
  readonly cueIndex: number;
  readonly observed: Readonly<{ startMs: number; endMs: number; text: string }>;
}
export interface OverlapGroupReview {
  readonly status: "review_required";
  readonly sourceIdentity: string;
  readonly seamMs: number;
  readonly left: readonly Member[];
  readonly right: readonly Member[];
  readonly indices: readonly number[];
  readonly similarity: number;
  readonly windows: readonly Window[];
  readonly budgetRoots: readonly string[];
}
const units = (s: string) => Array.from(s.normalize("NFKC").replace(/[\p{P}\s]/gu, ""));
function similarity(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) current.push(Math.min(current[j] + 1, previous[j + 1] + 1,
      previous[j] + (a[i] === b[j] ? 0 : 1)));
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
const overlap = (a: Member, b: Member) => Math.min(a.observed.endMs, b.observed.endMs) - Math.max(a.observed.startMs, b.observed.startMs);
const validWindow = (w: Window) => [w.windowKey, w.rootWindowKey, w.rootPlanId].every(s => typeof s === "string" && s.length > 0 && s.length <= 256) &&
  w.retryDepth === 0 && w.parentWindowKey === undefined && w.windowKey === w.rootWindowKey &&
  [w.startMs, w.endMs, w.coreStartMs, w.coreEndMs, w.startFrame, w.endFrame, w.coreStartFrame, w.coreEndFrame]
    .every(n => Number.isSafeInteger(n) && n >= 0) &&
  w.startMs <= w.coreStartMs && w.coreStartMs < w.coreEndMs && w.coreEndMs <= w.endMs &&
  w.startFrame <= w.coreStartFrame && w.coreStartFrame < w.coreEndFrame && w.coreEndFrame <= w.endFrame &&
  [[w.startFrame, w.startMs], [w.endFrame, w.endMs], [w.coreStartFrame, w.coreStartMs], [w.coreEndFrame, w.coreEndMs]]
    .every(([frame, ms]) => Math.round(frame / 16) === ms);

export function planOverlapGroupReview(input: {
  sourceIdentity: string; durationMs: number; leftWindow: Window; rightWindow: Window;
  leftRaw: readonly LocalSubtitleServerRawSegment[]; rightRaw: readonly LocalSubtitleServerRawSegment[];
  cues: readonly LocalSubtitleSegment[];
}): OverlapGroupReview | undefined {
  const { leftWindow: a, rightWindow: b, cues } = input, p = OVERLAP_GROUP_REVIEW_POLICY;
  if (!input.sourceIdentity || input.sourceIdentity.length > 256 || !Number.isSafeInteger(input.durationMs) || input.durationMs <= 0 ||
      !validWindow(a) || !validWindow(b) || a.rootPlanId !== b.rootPlanId || a.windowKey === b.windowKey ||
      a.coreEndMs !== b.coreStartMs || b.startMs <= a.startMs || b.startMs >= a.endMs ||
      a.coreEndMs <= b.startMs || a.coreEndMs >= a.endMs || a.endMs > input.durationMs || b.endMs > input.durationMs ||
      !input.leftRaw.length || !input.rightRaw.length || input.leftRaw.length > 128 || input.rightRaw.length > 128) return;
  const map = (raw: readonly LocalSubtitleServerRawSegment[], w: Window): Member[] | undefined => {
    const members: Member[] = []; let last = -1;
    for (const [rawIndex, r] of raw.entries()) {
      if (!Number.isSafeInteger(r.startMs) || !Number.isSafeInteger(r.endMs) || r.startMs < 0 ||
          r.startMs < last || r.endMs <= r.startMs || r.endMs > w.endMs - w.startMs + 100 ||
          typeof r.text !== "string" || !r.text.trim() || r.text.length > 4096) return;
      last = r.endMs;
      const observed = Object.freeze({ text: r.text, startMs: w.startMs + r.startMs, endMs: w.startMs + r.endMs });
      const startMs = Math.max(w.coreStartMs, observed.startMs), endMs = Math.min(w.coreEndMs, observed.endMs);
      if (endMs <= startMs) continue; // Non-owned context is not a displayed cue.
      const matches = cues.flatMap((c, i) => c.text === r.text.trim() && c.startMs === startMs && c.endMs === endMs ? [i] : []);
      members.push({ rawIndex, cueIndex: matches.length === 1 ? matches[0] : -1, observed });
    }
    return members;
  };
  const lm = map(input.leftRaw, a), rm = map(input.rightRaw, b); if (!lm || !rm) return;
  const pairs = cues.flatMap((c, i) => c.endMs === a.coreEndMs && cues[i + 1]?.startMs === b.coreStartMs ? [i] : []);
  if (pairs.length !== 1) return;
  const ls = lm.find(m => m.cueIndex === pairs[0]), rs = rm.find(m => m.cueIndex === pairs[0] + 1);
  if (!ls || !rs || overlap(ls, rs) < p.minOverlapMs) return;
  const left = new Set([ls]), right = new Set([rs]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of lm) if (!left.has(m) && [...right].some(n => overlap(m, n) >= p.minOverlapMs)) { left.add(m); changed = true; }
    for (const m of rm) if (!right.has(m) && [...left].some(n => overlap(m, n) >= p.minOverlapMs)) { right.add(m); changed = true; }
    if (left.size > p.maxSegmentsPerSide || right.size > p.maxSegmentsPerSide) return;
  }
  const l = [...left].sort((x, y) => x.rawIndex - y.rawIndex), r = [...right].sort((x, y) => x.rawIndex - y.rawIndex);
  if ([l, r].some(side => side.some((m, i) => m.cueIndex < 0 || i > 0 && m.rawIndex !== side[i - 1].rawIndex + 1))) return;
  const all = [...l, ...r], indices = all.map(m => m.cueIndex);
  if (indices.some((n, i) => i > 0 && n !== indices[i - 1] + 1)) return;
  const startMs = Math.min(...all.map(m => m.observed.startMs)), endMs = Math.max(...all.map(m => m.observed.endMs));
  if (endMs - startMs > p.maxGroupMs) return;
  const x = units(l.map(m => m.observed.text).join("")), y = units(r.map(m => m.observed.text).join(""));
  if ([x, y].some(s => s.length < p.minUnits || s.length > p.maxUnits)) return;
  const score = similarity(x, y); if (score < p.minSimilarity) return;
  const starts = [startMs - 5000, startMs - 6000];
  if (starts.some(s => s < 0 || s + p.witnessMs > input.durationMs || s + p.witnessMs < endMs + 1000)) return;
  const windows = starts.map((startMs, i): Window => {
    const endMs = startMs + p.witnessMs, key = `${b.windowKey}.group-${i}`;
    return Object.freeze({ ...b, windowKey: key, rootWindowKey: key, startMs, endMs, coreStartMs: startMs, coreEndMs: endMs,
      startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: startMs * 16, coreEndFrame: endMs * 16 });
  });
  return Object.freeze({ status: "review_required", sourceIdentity: input.sourceIdentity, seamMs: a.coreEndMs,
    left: Object.freeze(l.map(m => Object.freeze(m))), right: Object.freeze(r.map(m => Object.freeze(m))), indices: Object.freeze(indices),
    similarity: score, windows: Object.freeze(windows), budgetRoots: Object.freeze([a.rootWindowKey, b.rootWindowKey]) });
}
