/** Offline, insertion-only evidence review. This never authorizes production timing. */
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const units = text => Array.from(graphemes.segment(text), item => item.segment);
const INSERTABLE = /^[。！？!?、，,；;：:「」『』]$/u;
const DISPLAY_PUNCTUATION = /^[。！？!?、，,；;：:]$/u;
const LEXICAL = /[\p{L}\p{N}]/u;
const DEPENDENT_JA = /^(?:だ|です|ます|を|は|が|に|で|と|て|た|ない|か)$/u;
const ms = value => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) : NaN;

/** Match the entire candidate to a contiguous source span; never LCS or rewrite. */
export function findInsertionOnlySpans(sourceText, candidateText) {
  if (typeof sourceText !== "string" || typeof candidateText !== "string" ||
      sourceText.length > 8192 || candidateText.length > 16384) throw new Error("invalid_text");
  const source = units(sourceText), candidate = units(candidateText), matches = [];
  if (!source.length || !candidate.some(unit => LEXICAL.test(unit))) return matches;
  for (let start = 0; start < source.length; start++) {
    let cursor = start;
    const offsets = [cursor], insertions = [];
    let valid = true;
    for (const unit of candidate) {
      if (unit === source[cursor]) cursor++;
      else if (INSERTABLE.test(unit)) insertions.push({ offset: cursor, insert: unit });
      else { valid = false; break; }
      offsets.push(cursor);
    }
    if (valid && cursor > start) matches.push({ start, end: cursor, offsets, insertions });
  }
  return matches;
}

function lexicalBoundaries(text, language) {
  const graphemeOffsets = new Map([[0, 0]]);
  let utf16 = 0, count = 0;
  for (const unit of units(text)) { utf16 += unit.length; graphemeOffsets.set(utf16, ++count); }
  const boundaries = new Map();
  for (const word of new Intl.Segmenter(language, { granularity: "word" }).segment(text)) {
    const offset = graphemeOffsets.get(word.index);
    if (offset !== undefined) boundaries.set(offset, word.segment);
  }
  return boundaries;
}

function usableWord(word, segment, windowStartMs) {
  if (!word) return false;
  const start = ms(word.start), end = ms(word.end);
  return start >= ms(segment.start) && end <= ms(segment.end) && start < end &&
    end - start <= 2000 && start + windowStartMs >= 0;
}

function edgeWords(segment) {
  if (!Array.isArray(segment.words) || segment.words.some(word => typeof word?.word !== "string") ||
      segment.words.map(word => word.word).join("") !== segment.text) return null;
  const lexical = segment.words.filter(word => LEXICAL.test(word.word));
  return { first: lexical[0], last: lexical.at(-1) };
}

function nativeAnchor(left, right, observation, source) {
  const reasons = [], leftWords = edgeWords(left), rightWords = edgeWords(right);
  const leftWord = leftWords?.last, rightWord = rightWords?.first;
  const atMs = observation.windowStartMs + ms(right.start);
  if (!leftWords || !rightWords) reasons.push("word_text_coverage_mismatch");
  if (!usableWord(leftWord, left, observation.windowStartMs) ||
      !usableWord(rightWord, right, observation.windowStartMs)) reasons.push("invalid_adjacent_word");
  if (atMs <= source.startMs || atMs >= source.endMs) reasons.push("outside_source");
  if (leftWord && rightWord) {
    const gap = ms(rightWord.start) - ms(leftWord.end);
    if (gap < 0 || gap > 1000) reasons.push("unsupported_word_gap");
    if (Math.abs(ms(right.start) - ms(rightWord.start)) > 300 ||
        Math.abs(ms(right.start) - ms(leftWord.end)) > 300) reasons.push("word_segment_disagreement");
  }
  return { atMs, reasons };
}

function inspectObservation(source, observation, textBoundaries, language) {
  if (observation?.mode !== "uncompressed_non_vad" ||
      observation.mediaSha256 !== source.mediaSha256 || typeof observation.id !== "string" || !observation.id ||
      !Number.isSafeInteger(observation.windowStartMs) || observation.windowStartMs < 0 ||
      !Number.isSafeInteger(observation.windowEndMs) || observation.windowEndMs <= observation.windowStartMs ||
      !Array.isArray(observation.segments) || observation.segments.length > 128) {
    return { id: observation?.id, reason: "invalid_provenance", boundaries: [] };
  }
  const segments = observation.segments;
  let previousEnd = 0;
  for (const segment of segments) {
    const start = ms(segment?.start), end = ms(segment?.end);
    if (typeof segment?.text !== "string" || !segment.text || segment.text.length > 4096 ||
        start < previousEnd || !(start < end) || end + observation.windowStartMs > observation.windowEndMs) {
      return { id: observation.id, reason: "invalid_segments", boundaries: [] };
    }
    previousEnd = end;
  }
  const covered = [];
  for (let first = 0; first < segments.length; first++) {
    let text = "";
    for (let last = first; last < segments.length; last++) {
      text += segments[last].text;
      if (text.length > source.contextText.length * 2 + 16) break;
      if (observation.windowStartMs + ms(segments[first].start) > source.endMs ||
          observation.windowStartMs + ms(segments[last].end) < source.startMs) continue;
      for (const match of findInsertionOnlySpans(source.contextText, text)) {
        if (match.start <= source.contextStart && match.end >= source.contextEnd) {
          covered.push({ first, last, match, text });
        }
      }
    }
  }
  // Extra context is permitted only when ALL its candidate text also maps exactly.
  covered.sort((a, b) => (a.match.end - a.match.start) - (b.match.end - b.match.start));
  const best = covered[0];
  if (!best) return { id: observation.id, reason: "source_not_fully_covered", boundaries: [] };
  if (covered.some((item, index) => index > 0 && item.match.end - item.match.start === best.match.end - best.match.start)) {
    return { id: observation.id, reason: "ambiguous_source_match", boundaries: [] };
  }
  const boundaries = new Map();
  const add = (offset, evidence) => {
    if (offset <= source.contextStart || offset >= source.contextEnd) return;
    const relative = offset - source.contextStart;
    const nextWord = textBoundaries.get(relative);
    // ICU can split an unknown Japanese word into single kana (e.g. a pronoun).
    // Such a boundary is not lexical evidence, even when two decodes repeat it.
    const lexicalSafe = nextWord !== undefined && LEXICAL.test(nextWord) && !(language === "ja" &&
      (DEPENDENT_JA.test(nextWord) || /^\p{Script=Hiragana}$/u.test(nextWord)));
    const entry = boundaries.get(relative) ?? { offset: relative, lexicalSafe, evidence: [] };
    entry.evidence.push(evidence);
    boundaries.set(relative, entry);
  };
  for (const insertion of best.match.insertions) {
    if (DISPLAY_PUNCTUATION.test(insertion.insert)) add(insertion.offset, { kind: "punctuation", insert: insertion.insert });
  }
  let candidateOffset = 0;
  for (let index = best.first; index <= best.last; index++) {
    candidateOffset += units(segments[index].text).length;
    if (index < best.last) add(best.match.offsets[candidateOffset], {
      kind: "native_segment", ...nativeAnchor(segments[index], segments[index + 1], observation, source),
    });
  }
  return { id: observation.id, reason: null, group: [best.first, best.last], boundaries: [...boundaries.values()] };
}

export function reviewLocalBoundaries(source, observations, language = "ja") {
  if (!source || typeof source.text !== "string" || typeof source.contextText !== "string" ||
      source.text.length > 4096 || source.contextText.length > 8192 ||
      !Number.isSafeInteger(source.startMs) || !Number.isSafeInteger(source.endMs) ||
      source.startMs < 0 || source.endMs <= source.startMs ||
      !Number.isSafeInteger(source.contextStart) || !Number.isSafeInteger(source.contextEnd) ||
      !/^[a-f0-9]{64}$/u.test(source.mediaSha256 ?? "") ||
      units(source.contextText).slice(source.contextStart, source.contextEnd).join("") !== source.text ||
      source.contextStart < 0 || source.contextEnd < source.contextStart ||
      source.contextEnd > units(source.contextText).length ||
      !Array.isArray(observations) || observations.length > 4) throw new Error("invalid_source");
  const rejected = reason => ({ reason, automaticAcceptance: false, edits: [], timingCandidates: [], observations: [] });
  if (!source.text.trim()) return rejected("no_accepted_source_text");
  if (new Set(observations.map(item => item.id)).size !== observations.length ||
      new Set(observations.map(item => `${item.windowStartMs}:${item.windowEndMs}`)).size !== observations.length) {
    return rejected("duplicate_observation");
  }
  const lexical = lexicalBoundaries(source.text, language);
  const reviewed = observations.map(item => inspectObservation(source, item, lexical, language));
  const offsets = [...new Set(reviewed.flatMap(item => item.boundaries.map(boundary => boundary.offset)))].sort((a, b) => a - b);
  const edits = [], timingCandidates = [];
  for (const offset of offsets) {
    const boundaries = reviewed.map(item => item.boundaries.find(boundary => boundary.offset === offset));
    // Every supplied view must cover the source and independently support the separator.
    const supported = reviewed.length >= 2 && boundaries.every(boundary => boundary?.lexicalSafe);
    if (!supported) continue;
    const punctuation = boundaries.map(boundary => boundary.evidence.filter(item => item.kind === "punctuation").map(item => item.insert).join(""));
    const agreed = punctuation[0] && punctuation.every(item => item === punctuation[0]) ? punctuation[0] : " ";
    if (agreed.length <= 2) edits.push({ offset, insert: agreed });
    const anchors = boundaries.map(boundary => boundary.evidence.find(item => item.kind === "native_segment"));
    const reasons = [...new Set(anchors.flatMap(anchor => anchor ? anchor.reasons : ["missing_native_anchor"]))];
    if (anchors.every(Boolean) && Math.max(...anchors.map(item => item.atMs)) - Math.min(...anchors.map(item => item.atMs)) > 300) reasons.push("window_disagreement");
    timingCandidates.push({ offset, anchors, reasons, qualifiedForListening: reasons.length === 0 });
  }
  return { reason: null, automaticAcceptance: false, edits, timingCandidates, observations: reviewed };
}

/** Render insertions over exact source positions; preserve both parent timestamps. */
export function renderLocalSeparatorPreview(source, review) {
  const text = units(source.text), edits = new Map();
  for (const edit of review.edits) {
    if (!Number.isSafeInteger(edit.offset) || edit.offset <= 0 || edit.offset >= text.length ||
        edits.has(edit.offset) || !(edit.insert === " " || (units(edit.insert).length <= 2 && units(edit.insert).every(unit => DISPLAY_PUNCTUATION.test(unit))))) {
      throw new Error("invalid_insertion");
    }
    edits.set(edit.offset, edit.insert);
  }
  return {
    startMs: source.startMs, endMs: source.endMs,
    text: text.map((unit, offset) => (edits.get(offset) ?? "") + unit).join(""),
    sourceText: source.text, timing: "unchanged_parent", automaticAcceptance: false,
  };
}
