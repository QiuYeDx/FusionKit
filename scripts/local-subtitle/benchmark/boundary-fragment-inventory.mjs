/** Read-only relation inventory. Text overlap never authorizes deletion or timing. */
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const indexText = text => {
  const original = Array.from(segmenter.segment(text), s => s.segment), units = [], positions = [];
  original.forEach((unit, i) => { if (!/^[\p{P}\s]+$/u.test(unit)) { units.push(unit); positions.push(i); } });
  return { units, positions };
};
const starts = (haystack, needle) => {
  const result = [];
  for (let i = 0; i + needle.length <= haystack.length; i++)
    if (needle.every((v, j) => v === haystack[i + j])) result.push(i);
  return result;
};
const span = (text, start, length) => [text.positions[start], text.positions[start + length - 1] + 1];

export function inventoryBoundaryFragments(input) {
  const empty = reason => ({ automaticAcceptance: false, reason, relations: [] });
  const { leftWindow: a, rightWindow: b, leftRaw, rightRaw } = input ?? {};
  const time = n => Number.isSafeInteger(n) && n >= 0;
  if (!a || !b || ![a.startMs, a.endMs, a.coreEndMs, b.startMs, b.endMs, b.coreStartMs].every(time) ||
      a.rootPlanId !== b.rootPlanId || typeof a.rootPlanId !== "string" || !a.rootPlanId ||
      a.retryDepth !== 0 || b.retryDepth !== 0 || a.coreEndMs !== b.coreStartMs ||
      !(a.startMs < b.startMs && b.startMs < a.endMs && a.endMs < b.endMs) ||
      a.coreEndMs < b.startMs || a.coreEndMs > a.endMs) return empty("invalid_windows");
  if (![leftRaw, rightRaw].every(segs => Array.isArray(segs) && segs.length <= 128 && segs.every(s =>
    typeof s?.text === "string" && s.text.length > 0 && s.text.length <= 1024 && time(s.startMs) && time(s.endMs) && s.endMs > s.startMs)))
    return empty("invalid_segments");
  for (const [segs, w] of [[leftRaw, a], [rightRaw, b]]) {
    if (segs.some((s, i) => s.endMs > w.endMs - w.startMs + 100 || (i > 0 && s.startMs < segs[i - 1].endMs)))
      return empty("invalid_segments");
  }
  const relations = [];
  for (let li = Math.max(0, leftRaw.length - 2); li < leftRaw.length; li++) {
    for (let ri = 0; ri < Math.min(2, rightRaw.length); ri++) {
      const l = leftRaw[li], r = rightRaw[ri];
      const observedOverlapMs = Math.min(l.endMs + a.startMs, r.endMs + b.startMs) -
        Math.max(l.startMs + a.startMs, r.startMs + b.startMs);
      if (observedOverlapMs <= 0) continue;
      const x = indexText(l.text), y = indexText(r.text);
      if (Math.min(x.units.length, y.units.length) < 6) continue;
      let kind, lx = 0, ry = 0, length = 0;
      const leftInRight = starts(y.units, x.units), rightInLeft = starts(x.units, y.units);
      if (x.units.length === y.units.length && leftInRight.length) { kind = "equal"; length = x.units.length; }
      else if (leftInRight.length) { kind = "left_contained"; ry = leftInRight[0]; length = x.units.length; }
      else if (rightInLeft.length) { kind = "right_contained"; lx = rightInLeft[0]; length = y.units.length; }
      else for (let n = Math.min(x.units.length, y.units.length); n >= 6; n--) {
        if (x.units.slice(-n).every((unit, i) => unit === y.units[i])) {
          kind = "suffix_prefix"; lx = x.units.length - n; length = n; break;
        }
      }
      if (!kind) continue;
      const matched = x.units.slice(lx, lx + length);
      relations.push({ kind, leftIndex: li, rightIndex: ri,
        leftText: l.text, rightText: r.text, matchedText: matched.join(""),
        leftSpan: span(x, lx, length), rightSpan: span(y, ry, length),
        ambiguous: starts(x.units, matched).length !== 1 || starts(y.units, matched).length !== 1,
        leftObservedMs: [a.startMs + l.startMs, a.startMs + l.endMs],
        rightObservedMs: [b.startMs + r.startMs, b.startMs + r.endMs], observedOverlapMs,
        seamMs: a.coreEndMs });
    }
  }
  return { automaticAcceptance: false,
    nativeOverrunMs: {
      left: Math.max(0, ...leftRaw.map(s => s.endMs - (a.endMs - a.startMs))),
      right: Math.max(0, ...rightRaw.map(s => s.endMs - (b.endMs - b.startMs))),
    }, relations };
}
