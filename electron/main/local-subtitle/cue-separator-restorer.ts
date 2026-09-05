import type { LocalSubtitleSegment } from "@/type/localSubtitle";
import type { LocalSubtitleServerRawSegment } from "./server-contract";
import { planLocalSubtitleSegmentCue, type LocalSubtitleCueTargets } from "./cue-boundary-planner";

const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const JAPANESE_WORDS = new Intl.Segmenter("ja", { granularity: "word" });
const INSERTABLE = /^[、。！？!?，,；;：:]$/u;
const DEPENDENT = /^(?:だ|です|ます|を|は|が|に|で|と|て|た|ない|か)$/u;
const units = (text: string) => Array.from(GRAPHEMES.segment(text), item => item.segment);

export function needsLocalSubtitleSeparators(cue: LocalSubtitleSegment): boolean {
  return cue.endMs - cue.startMs >= 6000 && cue.text.length >= 12 &&
    cue.text.length <= 1024 && /\p{Script=Hiragana}/u.test(cue.text) &&
    !/[。！？!?\r\n]/u.test(cue.text);
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

/** Text-only enrichment; every accepted character and both parent times survive. */
export function restoreLocalSubtitleCueSeparators(input: {
  cue: LocalSubtitleSegment;
  primary: readonly LocalSubtitleServerRawSegment[];
  candidate: readonly LocalSubtitleServerRawSegment[];
  windowStartMs: number;
  targets: LocalSubtitleCueTargets;
}): LocalSubtitleSegment {
  const { cue, primary, candidate, windowStartMs, targets } = input;
  if (!needsLocalSubtitleSeparators(cue) || primary.length > 128 || candidate.length > 128) return cue;
  const owners = primary.flatMap((segment, index) => segment.text === cue.text &&
    segment.startMs + windowStartMs === cue.startMs && segment.endMs + windowStartMs === cue.endMs ? [index] : []);
  if (owners.length !== 1) return cue;
  const contextText = primary.map(segment => segment.text).join("");
  if (contextText.length > 4096 || candidate.reduce((size, segment) => size + segment.text.length, 0) > 8192) return cue;
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
      if (budget.remaining < 0) return cue;
      // Another occurrence elsewhere in the root context also makes the match ambiguous.
      if (mappings.length !== 1) continue;
      for (const map of mappings) {
        if ((map.start <= sourceStart && map.end >= sourceEnd) ||
            (map.start >= sourceStart && map.end <= sourceEnd && map.end - map.start >= 12)) {
          matches.push({ first, last, map, parts });
        }
      }
      if (budget.remaining < 0 || matches.length > 128) return cue;
    }
  }
  const covering = matches.filter(item => item.map.start <= sourceStart && item.map.end >= sourceEnd);
  // Prefer full parent coverage; otherwise use one unique, longest complete native group.
  // Never extract an exact substring from a native segment containing changed words.
  const eligible = covering.length ? covering : matches;
  eligible.sort((a, b) => (covering.length ? 1 : -1) *
    ((a.map.end - a.map.start) - (b.map.end - b.map.start)));
  const best = eligible[0];
  if (!best || eligible.slice(1).some(item => item.map.end - item.map.start === best.map.end - best.map.start)) return cue;

  const utf16ToGrapheme = new Map<number, number>([[0, 0]]);
  let utf16 = 0;
  source.forEach((unit, index) => { utf16 += unit.length; utf16ToGrapheme.set(utf16, index + 1); });
  const safeOffsets = new Set<number>();
  for (const item of JAPANESE_WORDS.segment(cue.text)) {
    const offset = utf16ToGrapheme.get(item.index);
    // ICU may split an unknown Japanese word into individual kana.
    const honorificPrefix = /^(?:お|ご)$/u.test(item.segment) &&
      /^\p{Script=Han}/u.test(cue.text.slice(item.index + item.segment.length));
    if (offset !== undefined && /[\p{L}\p{N}]/u.test(item.segment) &&
        !DEPENDENT.test(item.segment) && (!/^\p{Script=Hiragana}$/u.test(item.segment) || honorificPrefix)) safeOffsets.add(offset);
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
  if (!insertions.size) return cue;
  const text = source.map((unit, offset) => (insertions.get(offset) ?? "") + unit).join("");
  try {
    const planned = planLocalSubtitleSegmentCue({ timelineDomain: "original_media", startMs: cue.startMs, endMs: cue.endMs, text }, targets);
    return Object.freeze({ ...cue, text: planned.text });
  } catch {
    // A display/resource limit must not make an otherwise valid original fail.
    return cue;
  }
}
