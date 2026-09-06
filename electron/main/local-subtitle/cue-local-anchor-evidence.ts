/** Read-only local timing evidence; consumers decide whether a source boundary may be used. */
export interface LocalAnchorSource { readonly text: string; readonly startMs: number; readonly endMs: number; readonly contextText?: string; }
export interface LocalAnchorView { readonly id?: string; readonly windowStartMs: number; readonly windowEndMs: number;
  readonly segments: readonly { readonly text: string; readonly startMs: number; readonly endMs: number;
    readonly dtwTokens?: readonly { readonly text: string; readonly pointMs: number | null }[] }[]; }
export interface LocalAnchorBoundary { readonly offset: number; readonly leftPointMs: number; readonly rightPointMs: number;
  readonly anchorStartMs: number; readonly anchorEndMs: number; readonly sourceSpan: readonly number[];
  readonly anchors: readonly string[]; readonly nativeBoundary: boolean; }
export interface LocalAnchorInspection { readonly id?: string; readonly reasons: readonly string[]; readonly boundaries: readonly LocalAnchorBoundary[]; }
interface IndexedText { original: string[]; units: string[]; positions: number[]; }
interface AnchorToken { from: number; to: number; pointMs: number; segmentIndex: number; }
export interface LocalPrefixSeparator {
  readonly offset: number;
  readonly leftAnchor: string;
  readonly rightAnchor: string;
  readonly unmatchedCandidate: string;
}

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });
const punctuation = /^[、。！？!?，,；;：:]$/u;
const lexical = /[\p{L}\p{N}]/u;
const dependent = /^(?:だ|です|ます|を|は|が|に|で|と|て|た|ない|か)$/u;
const split = (text: string) => Array.from(graphemes.segment(text), x => x.segment);


function indexed(text: string): IndexedText {
  const original = split(text), units: string[] = [], positions: number[] = [];
  original.forEach((unit, index) => { if (!punctuation.test(unit)) { units.push(unit); positions.push(index); } });
  return { original, units, positions };
}

function occurrences(units: string[], part: string[]) {
  let count = 0;
  for (let i = 0; i + part.length <= units.length; i++) {
    if (part.every((unit, j) => unit === units[i + j]) && ++count > 1) break;
  }
  return count;
}

function wordOffsets(text: string, data: IndexedText) {
  const utf16 = new Map([[0, 0]]);
  let cursor = 0;
  data.original.forEach((unit, i) => { cursor += unit.length; utf16.set(cursor, i + 1); });
  const edges = new Set([data.units.length]), starts = new Set<number>();
  for (const word of words.segment(text)) {
    const start = data.positions.indexOf(utf16.get(word.index) ?? -1);
    const endGrapheme = utf16.get(word.index + word.segment.length);
    const end = data.positions.findIndex(p => p >= (endGrapheme ?? Infinity));
    if (start >= 0) edges.add(start);
    edges.add(end < 0 ? data.units.length : end);
    const honorific = /^(?:お|ご)$/u.test(word.segment) && /^\p{Script=Han}/u.test(text.slice(word.index + word.segment.length));
    if (start >= 0 && word.isWordLike && !dependent.test(word.segment) &&
        (!/^\p{Script=Hiragana}$/u.test(word.segment) || honorific)) starts.add(start);
  }
  return { edges, starts };
}

function exactRuns(a: string[], b: string[]) {
  if (a.length * b.length > 1_000_000) return null;
  const runs = [];
  let previous = new Uint16Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    const row = new Uint16Array(b.length + 1);
    for (let j = 0; j < b.length; j++) {
      if (a[i] !== b[j]) continue;
      const length = row[j + 1] = previous[j] + 1;
      if (length >= 12 && (i + 1 === a.length || j + 1 === b.length || a[i + 1] !== b[j + 1])) {
        runs.push({ sourceStart: i + 1 - length, candidateStart: j + 1 - length, length });
        if (runs.length > 128) return null;
      }
    }
    previous = row;
  }
  return runs;
}

/** Neutral text separation only. No word replacement, presence claim or new time. */
export function inspectLocalPrefixSeparators(source: LocalAnchorSource, view: LocalAnchorView,
  beforeOffset: number): readonly LocalPrefixSeparator[] {
  if (!source.text || source.text.length > 4096 || (source.contextText?.length ?? 0) > 4096 ||
      !Number.isSafeInteger(source.startMs) || source.startMs < 0 || !Number.isSafeInteger(source.endMs) || source.endMs <= source.startMs ||
      !Number.isSafeInteger(view.windowStartMs) || view.windowStartMs < 0 || !Number.isSafeInteger(view.windowEndMs) || view.windowEndMs <= view.windowStartMs ||
      /[\r\n「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u.test(source.text) ||
      !Number.isSafeInteger(beforeOffset) || beforeOffset <= 0 || view.segments.length > 128 ||
      view.segments.some(s => !s.text || s.text.length > 8192) ||
      view.segments.reduce((sum, s) => sum + s.text.length, 0) > 8192) return [];
  const a = indexed(source.text), b = indexed(view.segments.map(s => s.text).join(""));
  if (beforeOffset > a.original.length) return [];
  const context = source.contextText === undefined ? a : indexed(source.contextText);
  const sourceWords = wordOffsets(source.text, a), candidateWords = wordOffsets(view.segments.map(s => s.text).join(""), b);
  const nativeEnds: { start: number; end: number }[] = [];
  let cursor = 0, previousEnd = 0, budget = 200_000;
  for (const segment of view.segments) {
    if (!Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) || segment.startMs < previousEnd ||
        segment.endMs <= segment.startMs || segment.endMs > view.windowEndMs - view.windowStartMs) return [];
    previousEnd = segment.endMs;
    const start = cursor;
    cursor += indexed(segment.text).units.length;
    if (/[。！？!?]$/u.test(segment.text) && segment.endMs + view.windowStartMs > source.startMs &&
        segment.startMs + view.windowStartMs < source.endMs) nativeEnds.push({ start, end: cursor });
  }
  if (cursor !== b.units.length) return [];
  const equals = (haystack: string[], at: number, part: string[]) => {
    if (at < 0 || at + part.length > haystack.length) return false;
    for (let i = 0; i < part.length; i++) {
      if (--budget < 0 || haystack[at + i] !== part[i]) return false;
    }
    return true;
  };
  const unique = (haystack: string[], part: string[]) => {
    let count = 0;
    for (let i = 0; i + part.length <= haystack.length; i++) {
      if (equals(haystack, i, part) && ++count > 1) return false;
      if (budget < 0) return false;
    }
    return count === 1;
  };
  const proposals = new Map<number, LocalPrefixSeparator>();
  for (let at = 1; at < a.units.length && a.positions[at]! < beforeOffset; at++) {
    if (--budget < 0) return [];
    if (!sourceWords.starts.has(at) || /[\p{P}\s]/u.test(a.original[a.positions[at]! - 1]! + a.original[a.positions[at]!]!)) continue;
    for (const end of nativeEnds) {
      if (--budget < 0) return [];
      let selected: LocalPrefixSeparator | undefined;
      for (let length = Math.min(32, at, end.end - end.start); length >= 4 && !selected; length--) {
        if (--budget < 0) return [];
        if (!sourceWords.edges.has(at - length) || !candidateWords.edges.has(end.end - length)) continue;
        const left = a.units.slice(at - length, at);
        if (/\s/u.test(left.join("")) || !equals(b.units, end.end - length, left)) continue;
        for (let gap = 0; gap <= 8 && !selected; gap++) {
          if (--budget < 0) return [];
          const rightStart = end.end + gap;
          if (!candidateWords.starts.has(rightStart)) continue;
          for (let rightLength = 8; rightLength <= 32 && at + rightLength <= a.units.length; rightLength++) {
            if (--budget < 0) return [];
            if (!sourceWords.edges.has(at + rightLength) || !candidateWords.edges.has(rightStart + rightLength)) continue;
            const right = a.units.slice(at, at + rightLength);
            if (/\s/u.test(right.join("")) || !equals(b.units, rightStart, right)) continue;
            // Do not lengthen an already matched anchor merely to escape repetition.
            if (![left, right].every(part => unique(context.units, part) && unique(b.units, part))) return [];
            selected = { offset: a.positions[at]!, leftAnchor: left.join(""), rightAnchor: right.join(""),
              unmatchedCandidate: b.units.slice(end.end, rightStart).join("") };
            break;
          }
          if (budget < 0) return [];
        }
      }
      if (selected) {
        // Uniqueness above prevents choosing between repeated lexical occurrences.
        if (proposals.has(selected.offset)) return [];
        proposals.set(selected.offset, selected);
        if (proposals.size > 2) return [];
      }
      if (budget < 0) return [];
    }
  }
  return [...proposals.values()];
}

export function inspectLocalAnchorEvidence(source: LocalAnchorSource, view: LocalAnchorView): LocalAnchorInspection {
  const fail = (reason: string): LocalAnchorInspection => ({ id: view?.id, reasons: [reason], boundaries: [] });
  if (!source || typeof source.text !== "string" || !source.text || source.text.length > 4096 ||
      (source.contextText !== undefined && (typeof source.contextText !== "string" || source.contextText.length > 4096)) ||
      !Number.isSafeInteger(source.startMs) || source.startMs < 0 || !Number.isSafeInteger(source.endMs) || source.endMs <= source.startMs ||
      /[\r\n「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u.test(source.text) || !view ||
      !Number.isSafeInteger(view.windowStartMs) || view.windowStartMs < 0 ||
      !Number.isSafeInteger(view.windowEndMs) || view.windowEndMs <= view.windowStartMs ||
      !Array.isArray(view.segments) || view.segments.length > 128) return fail("invalid_provenance");
  let previousEnd = 0, previousPoint = -1, unitOffset = 0, tokenCount = 0;
  const tokens: AnchorToken[] = [], texts: string[] = [];
  for (const [segmentIndex, segment] of view.segments.entries()) {
    const start = segment?.startMs, end = segment?.endMs;
    if (typeof segment?.text !== "string" || !segment.text || segment.text.length > 8192 ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !(start >= previousEnd && end > start && end <= view.windowEndMs - view.windowStartMs)) return fail("invalid_segments");
    previousEnd = end;
    if (!Array.isArray(segment.dtwTokens) || (tokenCount += segment.dtwTokens.length) > 4096 ||
        segment.dtwTokens.some((w: { text: string }) => typeof w?.text !== "string") ||
        segment.dtwTokens.map((w: { text: string }) => w.text).join("") !== segment.text) return fail("token_text_mismatch");
    texts.push(segment.text);
    if (texts.reduce((sum, text) => sum + text.length, 0) > 8192) return fail("text_budget_exceeded");
    for (const word of segment.dtwTokens) {
      const from = unitOffset;
      unitOffset += indexed(word.text).units.length;
      if (!lexical.test(word.text)) continue;
      if (typeof word.pointMs !== "number" || !Number.isSafeInteger(word.pointMs) || word.pointMs < 0 || word.pointMs < previousPoint ||
          word.pointMs > view.windowEndMs - view.windowStartMs) return fail("invalid_dtw_sequence");
      previousPoint = word.pointMs;
      tokens.push({ from, to: unitOffset, pointMs: word.pointMs + view.windowStartMs, segmentIndex });
    }
  }
  const a = indexed(source.text), b = indexed(texts.join("")), runs = exactRuns(a.units, b.units);
  if (unitOffset !== b.units.length) return fail("token_grapheme_mismatch");
  if (!runs) return fail("comparison_budget_exceeded");
  const { edges, starts } = wordOffsets(source.text, a), boundaries: LocalAnchorBoundary[] = [];
  const context = source.contextText === undefined ? a : indexed(source.contextText);
  const candidateEdges = wordOffsets(texts.join(""), b).edges;
  for (const run of runs) {
    const runText = a.units.slice(run.sourceStart, run.sourceStart + run.length);
    if (occurrences(context.units, runText) !== 1 || occurrences(b.units, runText) !== 1) continue;
    const map = (position: number) => position - run.candidateStart + run.sourceStart;
    for (let i = 1; i < tokens.length; i++) {
      const left = tokens[i - 1], right = tokens[i], at = map(right.from);
      if (left.to !== right.from || !starts.has(at) || right.from <= run.candidateStart ||
          right.to > run.candidateStart + run.length) continue;
      const between = b.original.slice(b.positions[left.to - 1] + 1, b.positions[right.from]).join("");
      if (left.segmentIndex === right.segmentIndex && !/[。！？!?]/u.test(between)) continue;
      const leftEdge = tokens.findIndex((t, j) => j < i - 1 && t.from >= run.candidateStart &&
        (at - map(t.from) >= 3 || /^\p{Script=Han}だ$/u.test(b.units.slice(t.from, right.from).join(""))) &&
        edges.has(map(t.from)) && candidateEdges.has(t.from));
      const rightEdge = tokens.findIndex((t, j) => j > i && t.to <= run.candidateStart + run.length &&
        map(t.to) - at >= 6 && edges.has(map(t.to)) && candidateEdges.has(t.to));
      if (leftEdge < 0 || rightEdge < 0) continue;
      if (tokens[leftEdge].pointMs < source.startMs || tokens[rightEdge].pointMs > source.endMs) continue;
      const anchors = [b.units.slice(tokens[leftEdge].from, right.from), b.units.slice(right.from, tokens[rightEdge].to)];
      if (anchors.some(anchor => occurrences(context.units, anchor) !== 1 || occurrences(b.units, anchor) !== 1)) continue;
      const gap = right.pointMs - left.pointMs;
      if (gap < 80 || gap > 2500 || right.pointMs - source.startMs < 600 || source.endMs - right.pointMs < 600) continue;
      boundaries.push({ offset: a.positions[at], leftPointMs: left.pointMs, rightPointMs: right.pointMs,
        anchorStartMs: tokens[leftEdge].pointMs, anchorEndMs: tokens[rightEdge].pointMs,
        sourceSpan: [a.positions[map(tokens[leftEdge].from)], a.positions[map(tokens[rightEdge].to) - 1] + 1],
        anchors: anchors.map(anchor => anchor.join("")), nativeBoundary: left.segmentIndex !== right.segmentIndex });
    }
  }
  return { id: view.id, reasons: [], boundaries };
}
