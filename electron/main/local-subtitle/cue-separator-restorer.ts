import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import { planLocalSubtitleSegmentCue, type LocalSubtitleCueTargets } from "./cue-boundary-planner";

const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const JAPANESE_WORDS = new Intl.Segmenter("ja", { granularity: "word" });
const INSERTABLE = /^[、。！？!?，,；;：:]$/u;
const DEPENDENT = /^(?:だ|です|ます|を|は|が|に|で|と|て|た|ない|か)$/u;
// A closed demonstrative-pronoun class, followed by a particle. ICU can split
// these into single kana; this grants only a word boundary, never a sentence/time.
const DEMONSTRATIVE_WITH_PARTICLE = /^(?:(?:こ|そ|あ|ど)(?:れ|ちら|なた)|(?:こ|そ|ど)こ|あそこ)(?:は|が|を|に|へ|と|も|の|で|から|まで|より)/u;
const units = (text: string) => Array.from(GRAPHEMES.segment(text), item => item.segment);

export function needsLocalSubtitleSeparators(cue: LocalSubtitleSegment): boolean {
  return cue.endMs - cue.startMs >= 6000 && cue.text.length >= 12 &&
    cue.text.length <= 1024 && /\p{Script=Hiragana}/u.test(cue.text) &&
    !/[。！？!?\r\n]/u.test(cue.text);
}

/** Existing punctuation can supply sentence evidence without supplying its time. */
export function needsLocalSubtitleDtwRefinement(cue: LocalSubtitleSegment): boolean {
  if (needsLocalSubtitleSeparators(cue)) return true;
  return cue.endMs - cue.startMs >= 6000 && cue.text.length >= 12 &&
    cue.text.length <= 1024 && /\p{Script=Hiragana}/u.test(cue.text) &&
    /[。！？!?]/u.test(cue.text) && !/[\r\n「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u.test(cue.text);
}

interface Mapping {
  start: number;
  end: number;
  offsets: number[];
  insertions: { offset: number; insert: string }[];
}

function matchEntireCandidate(source: string[], candidate: string[], budget: { remaining: number }): Mapping[] {
  const matches: Mapping[] = [];
  for (let start = 0; start < source.length; start++) {
    let cursor = start;
    const offsets = [start], insertions: Mapping["insertions"] = [];
    let valid = true;
    for (const unit of candidate) {
      if (--budget.remaining < 0) return [];
      if (unit === source[cursor]) cursor++;
      else if (INSERTABLE.test(unit)) insertions.push({ offset: cursor, insert: unit });
      else { valid = false; break; }
      offsets.push(cursor);
    }
    if (valid && cursor > start) matches.push({ start, end: cursor, offsets, insertions });
  }
  return matches;
}

interface CueEnhancementInput {
  cue: LocalSubtitleSegment;
  primary: readonly LocalSubtitleServerRawSegment[];
  candidate: readonly LocalSubtitleServerRawSegment[];
  windowStartMs: number;
  targets: LocalSubtitleCueTargets;
  windowDurationMs?: number;
}

/** One source-position plan for text separators and optional DTW cue activation. */
function enhance(input: CueEnhancementInput, allowTiming: boolean): readonly LocalSubtitleSegment[] {
  const { cue, primary, candidate, windowStartMs, targets } = input;
  if (!(allowTiming ? needsLocalSubtitleDtwRefinement(cue) : needsLocalSubtitleSeparators(cue)) ||
      primary.length > 128 || candidate.length > 128) return [cue];
  const owners = primary.flatMap((segment, index) => segment.text === cue.text &&
    segment.startMs + windowStartMs === cue.startMs && segment.endMs + windowStartMs === cue.endMs ? [index] : []);
  if (owners.length !== 1) return [cue];
  const contextText = primary.map(segment => segment.text).join("");
  if (contextText.length > 4096 || candidate.reduce((size, segment) => size + segment.text.length, 0) > 8192) return [cue];
  const context = units(contextText);
  const sourceStart = units(primary.slice(0, owners[0]).map(segment => segment.text).join("")).length;
  const source = units(cue.text), sourceEnd = sourceStart + source.length;
  const matches: { first: number; last: number; map: Mapping; parts: number[] }[] = [];
  const budget = { remaining: 200_000 };
  for (let first = 0; first < candidate.length; first++) {
    let text: string[] = [], parts: number[] = [];
    for (let last = first; last < candidate.length; last++) {
      text = text.concat(units(candidate[last]!.text));
      parts = [...parts, text.length];
      if (text.length > context.length * 2 + 16) break;
      if (candidate[first]!.startMs + windowStartMs > cue.endMs ||
          candidate[last]!.endMs + windowStartMs < cue.startMs) continue;
      const mappings = matchEntireCandidate(context, text, budget);
      if (budget.remaining < 0) return [cue];
      // Another occurrence elsewhere in the root context also makes the match ambiguous.
      if (mappings.length !== 1) continue;
      for (const map of mappings) {
        if ((map.start <= sourceStart && map.end >= sourceEnd) ||
            (map.start >= sourceStart && map.end <= sourceEnd && map.end - map.start >= 12)) {
          matches.push({ first, last, map, parts });
        }
      }
      if (budget.remaining < 0 || matches.length > 128) return [cue];
    }
  }
  const covering = matches.filter(item => item.map.start <= sourceStart && item.map.end >= sourceEnd);
  // Prefer full parent coverage; otherwise use one unique, longest complete native group.
  // Never extract an exact substring from a native segment containing changed words.
  const eligible = covering.length ? covering : matches;
  eligible.sort((a, b) => (covering.length ? 1 : -1) *
    ((a.map.end - a.map.start) - (b.map.end - b.map.start)));
  const best = eligible[0];
  if (!best || eligible.slice(1).some(item => item.map.end - item.map.start === best.map.end - best.map.start)) return [cue];

  const utf16ToGrapheme = new Map<number, number>([[0, 0]]);
  let utf16 = 0;
  source.forEach((unit, index) => { utf16 += unit.length; utf16ToGrapheme.set(utf16, index + 1); });
  const safeOffsets = new Set<number>();
  for (const item of JAPANESE_WORDS.segment(cue.text)) {
    const offset = utf16ToGrapheme.get(item.index);
    // ICU may split an unknown Japanese word into individual kana.
    const honorificPrefix = /^(?:お|ご)$/u.test(item.segment) &&
      /^\p{Script=Han}/u.test(cue.text.slice(item.index + item.segment.length));
    const demonstrative = DEMONSTRATIVE_WITH_PARTICLE.test(cue.text.slice(item.index));
    if (offset !== undefined && /[\p{L}\p{N}]/u.test(item.segment) &&
        !DEPENDENT.test(item.segment) && (!/^\p{Script=Hiragana}$/u.test(item.segment) || honorificPrefix || demonstrative)) safeOffsets.add(offset);
  }
  const insertions = new Map<number, string>();
  const insert = (contextOffset: number, value: string) => {
    if (contextOffset <= best.map.start || contextOffset >= best.map.end) return;
    const offset = contextOffset - sourceStart;
    if (offset <= 0 || offset >= source.length || !safeOffsets.has(offset)) return;
    if (/\s/u.test(source[offset - 1]! + source[offset]!)) return;
    // Prefer explicit punctuation to a neutral native-segment separator.
    if (value === " " && insertions.has(offset)) return;
    const previous = insertions.get(offset);
    const combined = previous && previous !== " " && value !== " " ? previous + value : value;
    if (combined.length <= 2) insertions.set(offset, combined);
  };
  for (const item of best.map.insertions) insert(item.offset, item.insert);
  for (const end of best.parts.slice(0, -1)) insert(best.map.offsets[end]!, " ");
  const cuts = new Map<number, number>();
  if (allowTiming) {
    const words: { from: number; to: number; pointMs: number }[] = [];
    let candidateOffset = 0, previous = -1, valid = true;
    for (let index = best.first; index <= best.last; index++) {
      const segment = candidate[index]!, tokens = segment.dtwTokens;
      if (!tokens || tokens.length > 4096 || tokens.map(token => token.text).join("") !== segment.text) { valid = false; break; }
      for (const token of tokens) {
        const from = best.map.offsets[candidateOffset]! - sourceStart;
        candidateOffset += units(token.text).length;
        const to = best.map.offsets[candidateOffset]! - sourceStart;
        if (!/[\p{L}\p{N}]/u.test(token.text)) continue;
        const point = token.pointMs;
        if (point === null || !Number.isSafeInteger(point) || point < previous || point < 0 ||
            point > input.windowDurationMs!) { valid = false; break; }
        previous = point;
        words.push({ from, to, pointMs: point + windowStartMs });
      }
      if (!valid) break;
    }
    const semanticOffsets = new Set(best.parts.slice(0, -1).map(end => best.map.offsets[end]! - sourceStart));
    for (const item of best.map.insertions) if (/^[。！？!?]$/u.test(item.insert)) semanticOffsets.add(item.offset - sourceStart);
    // Existing sentence punctuation is evidence too, but never a timing source.
    source.forEach((unit, index) => { if (/^[。！？!?]$/u.test(unit)) semanticOffsets.add(index + 1); });
    if (valid && Number.isSafeInteger(input.windowDurationMs) && input.windowDurationMs! > 0) {
      let previousCutMs = cue.startMs;
      for (const offset of [...semanticOffsets].sort((a, b) => a - b)) {
        if (!safeOffsets.has(offset) || offset <= 0 || offset >= source.length ||
            /\s/u.test(source[offset - 1]! + source[offset]!) ||
            offset + sourceStart <= best.map.start || offset + sourceStart >= best.map.end ||
            words.some(word => word.from < offset && offset < word.to)) continue;
        // Source punctuation can occupy positions between the adjacent lexical tokens.
        const left = words.findLast(word => word.to <= offset), right = words.find(word => word.from === offset);
        if (!left || !right || /[\p{L}\p{N}]/u.test(source.slice(left.to, offset).join(""))) continue;
        const gap = right.pointMs - left.pointMs;
        if (gap < 80 || gap > 2500 || right.pointMs - previousCutMs < 600 ||
            cue.endMs - right.pointMs < 600) continue;
        cuts.set(offset, right.pointMs);
        previousCutMs = right.pointMs;
        if (cuts.size === 8) break;
      }
    }
  }
  if (!insertions.size && !cuts.size) return [cue];
  const text = source.map((unit, offset) => (insertions.get(offset) ?? "") + unit).join("");
  try {
    const planned = planLocalSubtitleSegmentCue({ timelineDomain: "original_media", startMs: cue.startMs, endMs: cue.endMs, text }, targets);
    if (!cuts.size) return [Object.freeze({ ...cue, text: planned.text })];
    const offsets = [0, ...cuts.keys(), source.length];
    const times = [cue.startMs, ...cuts.values(), cue.endMs];
    return Object.freeze(offsets.slice(0, -1).map((start, index) => {
      const end = offsets[index + 1]!;
      // An inserted separator at a new cue boundary belongs to the preceding cue.
      const text = source.slice(start, end).map((unit, local) =>
        (local === 0 ? "" : insertions.get(start + local) ?? "") + unit).join("") +
        (end === source.length || insertions.get(end) === " " ? "" : insertions.get(end) ?? "");
      const part = planLocalSubtitleSegmentCue({ timelineDomain: "original_media", startMs: times[index]!, endMs: times[index + 1]!, text }, targets);
      return Object.freeze({ ...cue, id: `${cue.id}.dtw${index + 1}`, startMs: times[index]!, endMs: times[index + 1]!, text: part.text });
    }));
  } catch {
    // A display/resource limit must not make an otherwise valid original fail.
    return [cue];
  }
}

/** Text-only caller: preserve original parent timings and identity. */
export function restoreLocalSubtitleCueSeparators(input: CueEnhancementInput): LocalSubtitleSegment {
  return enhance(input, false)[0]!;
}

export function refineLocalSubtitleCueWithDtw(input: CueEnhancementInput & { windowDurationMs: number }): readonly LocalSubtitleSegment[] {
  return enhance(input, true);
}
