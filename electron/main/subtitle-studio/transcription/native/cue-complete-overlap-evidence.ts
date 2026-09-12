import type { LocalSubtitleOverlapReview } from "./cue-overlap-resolver";
import type { LocalSubtitleServerRawSegment } from "./server-contract";

interface CompleteOverlapInput {
  review: Pick<LocalSubtitleOverlapReview, "left" | "right" | "leftObservation" | "rightObservation" | "window">;
  rightWindowStartMs: number;
  candidate: readonly LocalSubtitleServerRawSegment[];
}
/** Exact complete-group evidence, shared with offline listening qualification. */
const units = (text: string) => Array.from(text.replace(/[\p{P}\s]/gu, ""));
const lexical = (text: string) => /[\p{L}\p{N}]/u.test(text);
const validTime = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
const count = (text: string, part: string) => {
  let n = 0, at = 0;
  while ((at = text.indexOf(part, at)) >= 0) { n++; at++; }
  return n;
};

export function inspectCompleteOverlapWitness({ review, rightWindowStartMs, candidate }: CompleteOverlapInput) {
  const reject = (reason: string) => ({ supported: false as const, reason });
  if (!review || !validTime(rightWindowStartMs) ||
      !Array.isArray(candidate) || candidate.length > 128 ||
      candidate.some(s => typeof s?.text !== "string" || s.text.length > 4096) ||
      candidate.reduce((n, s) => n + s.text.length, 0) > 4096) return reject("invalid_input");
  const { left, right, leftObservation, rightObservation, window } = review;
  if (![left, right, leftObservation, rightObservation].every(s => s && typeof s.text === "string" &&
      s.text.length <= 4096 && validTime(s.startMs) && validTime(s.endMs) && s.endMs > s.startMs) ||
      !window || !validTime(window.startMs) || !validTime(window.endMs) ||
      window.endMs - window.startMs > 20000 || window.endMs <= window.startMs ||
      left.text !== leftObservation.text || right.text !== rightObservation.text ||
      left.endMs !== right.startMs || right.endMs !== rightWindowStartMs + rightObservation.endMs)
    return reject("invalid_provenance");
  const targetStartMs = rightWindowStartMs + rightObservation.startMs;
  if (targetStartMs < left.startMs || targetStartMs >= right.endMs ||
      left.startMs < window.startMs || right.endMs > window.endMs) return reject("invalid_provenance");
  const x = units(left.text), y = units(right.text), target = y.join("");
  let prefix = 0;
  while (prefix < Math.min(x.length, y.length) && x[prefix] === y[prefix]) prefix++;
  if (x.length < 8 || y.length < 12 || y.length > 128 || y.length <= x.length ||
      prefix < 3 || prefix === x.length) return reject("insufficient_relation");
  let previousEnd = 0;
  for (const s of candidate) {
    if (!validTime(s.startMs) || !validTime(s.endMs) || s.startMs < previousEnd || s.endMs <= s.startMs ||
        s.endMs > window.endMs - window.startMs) return reject("invalid_segments");
    previousEnd = s.endMs;
  }
  const all = candidate.map(s => units(s.text).join("")).join("");
  if (count(all, target) !== 1) return reject("nonunique_complete_text");
  const groups = [];
  for (let first = 0; first < candidate.length; first++) {
    let text = "";
    for (let last = first; last < candidate.length && last < first + 8; last++) {
      if (!lexical(candidate[last].text) ||
          (last > first && candidate[last].startMs - candidate[last - 1].endMs > 1500)) break;
      text += units(candidate[last].text).join("");
      if (text === target) groups.push({ first, last });
      if (!target.startsWith(text)) break;
    }
  }
  if (groups.length !== 1) return reject("no_unique_complete_group");
  const { first, last } = groups[0], group = candidate.slice(first, last + 1);
  const startMs = group[0].startMs + window.startMs, endMs = group.at(-1)!.endMs + window.startMs;
  if (Math.abs(startMs - targetStartMs) > 400 || Math.abs(endMs - right.endMs) > 400)
    return reject("right_observation_time_disagrees");
  if (candidate.some((s, i) => (i < first || i > last) && lexical(s.text) &&
      s.endMs + window.startMs > left.startMs + 400 && s.startMs + window.startMs < right.endMs - 400))
    return reject("other_witness_words_in_removed_region");
  let previousPoint = -1, firstPoint = -1, tokenCount = 0, speechTokens = 0;
  for (const s of group) {
    if (!Array.isArray(s.dtwTokens) || (tokenCount += s.dtwTokens.length) > 4096 ||
        s.dtwTokens.some((t: { text: string }) => typeof t?.text !== "string") ||
        s.dtwTokens.map((t: { text: string }) => t.text).join("") !== s.text)
      return reject("invalid_token_coverage");
    for (const token of s.dtwTokens) {
      if (!lexical(token.text)) continue;
      const point = token.pointMs;
      if (!validTime(point) || point < previousPoint || point < s.startMs - 400 || point > s.endMs + 400 ||
          point > window.endMs - window.startMs) return reject("invalid_token_points");
      if (!speechTokens++) firstPoint = point;
      previousPoint = point;
    }
  }
  if (speechTokens < 2 || previousPoint - firstPoint < 600 ||
      Math.abs(firstPoint + window.startMs - targetStartMs) > 400) return reject("unsupported_onset");
  return {
    supported: true as const,
    replacement: { ...right, startMs: targetStartMs },
    evidence: { first, last, witnessStartMs: startMs, witnessEndMs: endMs,
      firstPointMs: firstPoint + window.startMs, commonPrefixUnits: prefix,
      removedDisplayRange: [left.startMs, targetStartMs] },
  };
}
