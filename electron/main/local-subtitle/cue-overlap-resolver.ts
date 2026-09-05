import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import type { LocalSubtitlePostProcessingWindow as Window } from "./subtitle-post-processor";

const fingerprint = (text: string) => text.normalize("NFKC").toLocaleLowerCase("und").replace(/[\p{P}\s]/gu, "");
const occurrences = (text: string, part: string) => {
  let count = 0, offset = 0;
  while ((offset = text.indexOf(part, offset)) >= 0) { count++; offset++; }
  return count;
};

export interface LocalSubtitleOverlapReview {
  readonly window: Window;
  readonly budgetRootWindowKey: string;
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly left: LocalSubtitleSegment;
  readonly right: LocalSubtitleSegment;
  readonly leftObservation: LocalSubtitleServerRawSegment;
  readonly rightObservation: LocalSubtitleServerRawSegment;
}

/** Detect a clipped tail / interior continuation; detection alone never removes text. */
export function planLocalSubtitleOverlapReview(input: {
  leftWindow: Window; rightWindow: Window;
  leftRaw: readonly LocalSubtitleServerRawSegment[];
  rightRaw: readonly LocalSubtitleServerRawSegment[];
  cues: readonly LocalSubtitleSegment[];
}): LocalSubtitleOverlapReview | undefined {
  const { leftWindow: a, rightWindow: b, cues } = input;
  const left = input.leftRaw.at(-1), right = input.rightRaw[0];
  if (!left || !right || a.retryDepth || b.retryDepth || a.rootPlanId !== b.rootPlanId ||
      a.coreEndMs !== b.coreStartMs || b.startMs >= a.endMs || b.startMs <= a.startMs) return;
  const start = a.startMs + left.startMs, end = b.startMs + right.endMs;
  const rightStart = b.startMs + right.startMs;
  const x = fingerprint(left.text), y = fingerprint(right.text);
  if (!/\p{Script=Hiragana}/u.test(x) || x.length < 8 || y.length <= x.length || y.length > 128 ||
      y.startsWith(x) || Math.abs(a.endMs - (a.startMs + left.endMs)) > 100 ||
      start < b.startMs - 1000 || start >= a.coreEndMs || rightStart < start ||
      rightStart >= a.endMs || end < a.endMs + 600 || end > b.endMs - 2000) return;
  const leftIndices = cues.flatMap((cue, index) => cue.text === left.text && cue.startMs === start &&
    cue.endMs === a.coreEndMs ? [index] : []);
  const rightIndices = cues.flatMap((cue, index) => cue.text === right.text && cue.startMs === b.coreStartMs &&
    cue.endMs === end ? [index] : []);
  if (leftIndices.length !== 1 || rightIndices.length !== 1 || rightIndices[0] !== leftIndices[0]! + 1) return;
  const startMs = Math.max(a.startMs, b.startMs - 5000), endMs = Math.min(b.endMs, a.endMs + 10000);
  if (endMs - startMs > 20000 || startMs >= start - 400 || endMs <= end + 400) return;
  const window: Window = Object.freeze({ ...b, windowKey: `${b.windowKey}.seam`, rootWindowKey: `${b.windowKey}.seam`,
    startMs, endMs, coreStartMs: startMs, coreEndMs: endMs,
    startFrame: startMs * 16, endFrame: endMs * 16, coreStartFrame: startMs * 16, coreEndFrame: endMs * 16 });
  return Object.freeze({ window, budgetRootWindowKey: b.rootWindowKey, leftIndex: leftIndices[0]!, rightIndex: rightIndices[0]!,
    left: cues[leftIndices[0]!]!, right: cues[rightIndices[0]!]!, leftObservation: left, rightObservation: right });
}

/** Select an existing complete observation only with a unique, two-sided audio witness. */
export function resolveLocalSubtitleOverlap(review: LocalSubtitleOverlapReview,
  candidate: readonly LocalSubtitleServerRawSegment[]) {
  if (candidate.length > 128 || candidate.reduce((n, s) => n + s.text.length, 0) > 4096) return;
  const { left, right, window } = review;
  const matches = candidate.filter(s => s.startMs + window.startMs < right.endMs &&
    s.endMs + window.startMs > left.startMs && /[\p{L}\p{N}]/u.test(s.text));
  if (matches.length !== 1) return;
  const witness = matches[0]!;
  if (Math.abs(witness.startMs + window.startMs - left.startMs) > 400 ||
      Math.abs(witness.endMs + window.startMs - right.endMs) > 400) return;
  const x = Array.from(fingerprint(left.text)), y = Array.from(fingerprint(right.text)), z = Array.from(fingerprint(witness.text));
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(x.length, z.length) && x[prefix] === z[prefix]) prefix++;
  while (suffix < Math.min(y.length, z.length) && y[y.length - 1 - suffix] === z[z.length - 1 - suffix]) suffix++;
  if (prefix < Math.max(6, Math.ceil(x.length * .75)) || prefix === x.length ||
      suffix < Math.max(8, Math.ceil(y.length * .75)) || prefix + suffix < z.length + 2) return;
  const full = fingerprint(candidate.map(s => s.text).join(""));
  if (occurrences(full, z.slice(0, prefix).join("")) !== 1 ||
      occurrences(full, z.slice(-suffix).join("")) !== 1) return;
  const tokens = witness.dtwTokens;
  if (!tokens || tokens.length > 4096 || tokens.map(t => t.text).join("") !== witness.text) return;
  let previous = -1, firstPoint = -1, lexical = 0;
  for (const token of tokens) {
    if (!/[\p{L}\p{N}]/u.test(token.text)) continue;
    const point = token.pointMs;
    if (point === null || !Number.isSafeInteger(point) || point < 0 || point < previous ||
        point > window.endMs - window.startMs || point + window.startMs < left.startMs - 400 ||
        point + window.startMs > right.endMs + 400) return;
    if (!lexical) firstPoint = point;
    previous = point; lexical++;
  }
  if (lexical < 2 || previous - firstPoint < 600) return;
  return Object.freeze({
    replacement: Object.freeze({ ...right, id: `${left.id}.seam`, startMs: left.startMs }),
    evidence: Object.freeze({ discarded: review.leftObservation, selected: review.rightObservation, witness,
      window, prefixUnits: prefix, suffixUnits: suffix }),
  });
}
