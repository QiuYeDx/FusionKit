import { StudioError, validateDocument, type TextSubtitleCue as SubtitleCue, type TextSubtitleDocument, type SubtitleDocument, type SubtitleText } from './domain';
import { bilingualOptionsSchema, type BilingualCandidate, type BilingualOptions, type BilingualPreview } from './bilingual-contract';

type Language = BilingualPreview['sourceLanguage'];
type TextRange = { cue: SubtitleCue; start: number; end: number };
type Pair = { candidate: BilingualCandidate; first: TextRange; second: TextRange; skipped: boolean };
export type BilingualAnalysis = Omit<BilingualPreview, 'offset' | 'candidates'> & { candidates: BilingualCandidate[]; pairs: Pair[] };
const PAGE_SIZE = 20;
const MAX_SPLIT_CHOICES = 64;
const nonempty = (text: string) => /\S/u.test(text);

function language(text: string): Language {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  if (/\p{Script=Latin}/u.test(text)) return 'en';
  return 'und';
}

function sameTime(first: SubtitleCue, second: SubtitleCue, format: SubtitleDocument['origin']['format']) {
  return first.timing.startMs === second.timing.startMs && (format === 'lrc' || first.timing.endMs === second.timing.endMs);
}

function separateSingleLineBodies(first: SubtitleCue, second: SubtitleCue) {
  return first.nodeId !== second.nodeId && nonempty(first.source.plain) && nonempty(second.source.plain)
    && !/[\r\n]/.test(first.source.plain) && !/[\r\n]/.test(second.source.plain);
}

function lineRanges(cue: SubtitleCue): [TextRange, TextRange] | undefined {
  const ranges: TextRange[] = [];
  let start = 0;
  for (let index = 0; index <= cue.source.plain.length; index++) {
    if (index !== cue.source.plain.length && cue.source.plain[index] !== '\n') continue;
    if (nonempty(cue.source.plain.slice(start, index))) ranges.push({ cue, start, end: index });
    if (ranges.length > 2) return;
    start = index + 1;
  }
  return ranges.length === 2 ? ranges as [TextRange, TextRange] : undefined;
}

function inlineChoices(text: string): { offset: number; end: number; label: string }[] {
  if (/[\r\n]/.test(text)) return [];
  const choices: { offset: number; end: number; label: string }[] = [];
  for (const match of text.matchAll(/[^\S\r\n]+/gu)) {
    const offset = match.index!;
    const end = offset + match[0].length;
    if (!nonempty(text.slice(0, offset)) || !nonempty(text.slice(end))) continue;
    // Labels are bounded excerpts; the candidate fields retain the complete original text.
    choices.push({ offset, end, label: `${text.slice(Math.max(0, offset - 24), offset)} | ${text.slice(end, end + 24)}` });
    if (choices.length === MAX_SPLIT_CHOICES) break;
  }
  return choices;
}

function candidatePair(first: TextRange, second: TextRange, kind: BilingualCandidate['kind'], splitAt: number | null, splitChoices: BilingualCandidate['splitChoices'], ambiguous = false): Pair {
  const firstText = first.cue.source.plain.slice(first.start, first.end);
  const secondText = second.cue.source.plain.slice(second.start, second.end);
  const firstLanguage = language(firstText);
  const secondLanguage = language(secondText);
  return {
    first, second, skipped: false,
    candidate: { id: first.cue.id, kind, startMs: first.cue.timing.startMs, first: firstText, second: secondText, splitAt, splitChoices,
      needsReview: ambiguous || firstText.trim() === secondText.trim() || firstLanguage === 'und' || secondLanguage === 'und' || firstLanguage === secondLanguage },
  };
}

function stableLanguageOrder(pairs: Pair[]): string | undefined {
  const structural = pairs.filter(pair => pair.candidate.kind !== 'inline');
  const orders = new Map<string, number>();
  for (const { candidate } of structural) {
    const first = language(candidate.first);
    const second = language(candidate.second);
    if (first === second || first === 'und' || second === 'und') continue;
    const order = `${first}:${second}`;
    orders.set(order, (orders.get(order) ?? 0) + 1);
  }
  const dominant = [...orders].sort((a, b) => b[1] - a[1])[0];
  return dominant && dominant[1] >= 3 && dominant[1] / structural.length >= 0.8 ? dominant[0] : undefined;
}

function withoutRepeatedCounterpart(range: TextRange, counterpart: TextRange, allowHan: boolean): TextRange | undefined {
  const body = range.cue.source.plain.slice(range.start, range.end).trimEnd();
  const repeated = counterpart.cue.source.plain.slice(counterpart.start, counterpart.end).trim();
  if (!repeated || !body.endsWith(repeated)) return;
  const suffixStart = body.length - repeated.length;
  const separator = /[^\S\r\n]+$/u.exec(body.slice(0, suffixStart));
  if (!separator) return;
  const end = suffixStart - separator[0].length;
  const prefix = body.slice(0, end);
  const prefixLanguage = language(prefix);
  const repeatedLanguage = language(repeated);
  if (!nonempty(prefix) || prefixLanguage === 'und' || repeatedLanguage === 'und') return;
  if (prefixLanguage === repeatedLanguage && !(allowHan && prefixLanguage === 'zh')) return;
  return { ...range, end: range.start + end };
}

function repeatedPairChoices(pair: Pair) {
  const first = pair.first.cue.source.plain.slice(pair.first.start, pair.first.end);
  const second = pair.second.cue.source.plain.slice(pair.second.start, pair.second.end);
  if (first !== second) return [];
  return inlineChoices(first).filter(choice => {
    const before = language(first.slice(0, choice.offset));
    const after = language(first.slice(choice.end));
    return before !== 'und' && after !== 'und' && before !== after;
  });
}

function separateRepeatedInlineText(pairs: Pair[], options: BilingualOptions) {
  if (!options.splitInline && !options.overrides.some(item => typeof item.splitAt === 'number')) return;
  const order = options.splitInline ? stableLanguageOrder(pairs) : undefined;
  const allowHan = order === 'ja:zh' || order === 'zh:ja';
  const overrides = new Map(options.overrides.map(item => [item.cueId, item.splitAt]));
  for (const pair of pairs) {
    if (pair.candidate.kind === 'inline') continue;
    const custom = overrides.get(pair.candidate.id);
    if (!options.splitInline && typeof custom !== 'number') continue;
    const choices = repeatedPairChoices(pair);
    const selected = custom === undefined || custom === null ? undefined : choices.find(choice => pair.first.start + choice.offset === custom);
    if (typeof custom === 'number' && !selected && !(pair.candidate.kind === 'lines' && custom === pair.first.end)) throw new StudioError('invalid_input');
    if (!options.splitInline) continue;
    if (choices.length) {
      pair.candidate.splitChoices = choices.map(choice => ({ offset: pair.first.start + choice.offset, label: choice.label }));
      if (pair.skipped) continue;
      const firstText = pair.first.cue.source.plain.slice(pair.first.start, pair.first.end);
      const choice = selected ?? choices.find(item => language(firstText.slice(0, item.offset)) === 'ja' && language(firstText.slice(item.end)) === 'zh') ?? choices[0];
      pair.candidate.splitAt = pair.first.start + choice.offset;
      pair.first = { ...pair.first, end: pair.first.start + choice.offset };
      pair.second = { ...pair.second, start: pair.second.start + choice.end };
      pair.candidate.first = pair.first.cue.source.plain.slice(pair.first.start, pair.first.end);
      pair.candidate.second = pair.second.cue.source.plain.slice(pair.second.start, pair.second.end);
      pair.candidate.needsReview = true;
      continue;
    }
    if (pair.skipped) continue;
    // Structural pairs can still contain a second, inline copy of their counterpart.
    const first = withoutRepeatedCounterpart(pair.first, pair.second, allowHan);
    const second = withoutRepeatedCounterpart(pair.second, pair.first, allowHan);
    if (!first && !second) continue;
    pair.first = first ?? pair.first;
    pair.second = second ?? pair.second;
    pair.candidate.first = pair.first.cue.source.plain.slice(pair.first.start, pair.first.end);
    pair.candidate.second = pair.second.cue.source.plain.slice(pair.second.start, pair.second.end);
    pair.candidate.needsReview = true;
  }
}

function collectPairs(doc: TextSubtitleDocument, options: BilingualOptions): Pair[] {
  const pairs: Pair[] = [];
  const overrides = new Map(options.overrides.map(item => [item.cueId, item.splitAt]));
  for (let index = 0; index < doc.cues.length;) {
    const cue = doc.cues[index];
    let runEnd = index + 1;
    while (runEnd < doc.cues.length && sameTime(cue, doc.cues[runEnd], doc.origin.format)) runEnd++;
    if (runEnd - index === 2 && separateSingleLineBodies(cue, doc.cues[index + 1])) {
      const second = doc.cues[index + 1];
      const pair = candidatePair({ cue, start: 0, end: cue.source.plain.length }, { cue: second, start: 0, end: second.source.plain.length }, 'same_time', null, []);
      pair.skipped = overrides.get(cue.id) === null;
      overrides.delete(cue.id);
      pairs.push(pair);
    } else {
      for (let cursor = index; cursor < runEnd; cursor++) {
        const current = doc.cues[cursor];
        let pair: Pair | undefined;
        const lines = lineRanges(current);
        const custom = overrides.get(current.id);
        if (lines) {
          pair = candidatePair(lines[0], lines[1], 'lines', lines[0].end, []);
        } else if (options.splitInline) {
          const choices = inlineChoices(current.source.plain);
          if (choices.length) {
            const suggested = choices.filter(choice => language(current.source.plain.slice(0, choice.offset)) === 'ja' && language(current.source.plain.slice(choice.end)) === 'zh');
            const selected = custom === undefined || custom === null ? suggested[0] ?? choices[0] : choices.find(choice => choice.offset === custom);
            if (!selected) throw new StudioError('invalid_input');
            pair = candidatePair({ cue: current, start: 0, end: selected.offset }, { cue: current, start: selected.end, end: current.source.plain.length }, 'inline', selected.offset,
              choices.map(({ offset, label }) => ({ offset, label })), true);
          }
        }
        if (pair) {
          if (custom === null) { pair.skipped = true; pair.candidate.splitAt = null; }
          overrides.delete(current.id);
          pairs.push(pair);
        }
      }
    }
    index = runEnd;
  }
  if (overrides.size) throw new StudioError('invalid_input');
  separateRepeatedInlineText(pairs, options);
  return pairs;
}

export function hasBilingualCandidates(doc: SubtitleDocument): boolean {
  if (doc.schemaVersion === 2 || doc.bilingualImport || doc.translationTracks.length || !doc.capabilities.translate) return false;
  for (let index = 0; index < doc.cues.length;) {
    const cue = doc.cues[index];
    let runEnd = index + 1;
    while (runEnd < doc.cues.length && sameTime(cue, doc.cues[runEnd], doc.origin.format)) runEnd++;
    if (runEnd - index === 2 && separateSingleLineBodies(cue, doc.cues[index + 1])) return true;
    for (let cursor = index; cursor < runEnd; cursor++) {
      const current = doc.cues[cursor];
      if (lineRanges(current)) return true;
      if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(current.source.plain) && /\s\S/u.test(current.source.plain) && /\p{Script=Han}/u.test(current.source.plain)) return true;
    }
    index = runEnd;
  }
  return false;
}

export function analyzeBilingual(doc: SubtitleDocument, input: BilingualOptions): BilingualAnalysis {
  if (doc.schemaVersion === 2) throw new StudioError('unsupported_feature');
  const parsed = bilingualOptionsSchema.safeParse(input);
  if (!parsed.success || doc.translationTracks.length || doc.bilingualImport) throw new StudioError('invalid_input');
  if (!doc.capabilities.translate) throw new StudioError('unsupported_feature');
  const options = parsed.data;
  const pairs = collectPairs(doc, options);
  const selected = pairs.filter(pair => !pair.skipped);
  const languageOrders = new Map<string, number>();
  const recommendationOrders = new Map<string, number>();
  for (const pair of selected) {
    const first = language(pair.candidate.first);
    const second = language(pair.candidate.second);
    if (first === 'und' || second === 'und' || first === second) continue;
    const key = `${first}:${second}`;
    languageOrders.set(key, (languageOrders.get(key) ?? 0) + 1);
    if (!pair.candidate.needsReview && pair.candidate.kind !== 'inline') recommendationOrders.set(key, (recommendationOrders.get(key) ?? 0) + 1);
  }
  const dominant = [...languageOrders].sort((first, second) => second[1] - first[1])[0];
  const recommendation = [...recommendationOrders.values()].sort((first, second) => second - first)[0] ?? 0;
  const [firstLanguage, secondLanguage] = (dominant?.[0].split(':') ?? ['und', 'und']) as [Language, Language];
  if (dominant) {
    for (const pair of pairs) {
      if (`${language(pair.candidate.first)}:${language(pair.candidate.second)}` !== dominant[0]) pair.candidate.needsReview = true;
    }
  }
  const collapsed = selected.filter(pair => pair.first.cue.id !== pair.second.cue.id).length;
  const cueCount = doc.cues.length - collapsed;
  return {
    revision: doc.revision, originalCueCount: doc.cues.length, cueCount, totalCandidates: pairs.length,
    pairedCount: selected.length, remainingCount: cueCount - selected.length, reviewCount: selected.filter(pair => pair.candidate.needsReview).length,
    recommended: recommendation >= 3 && recommendation / pairs.length >= 0.8,
    sourceLanguage: options.sourceSide === 'first' ? firstLanguage : secondLanguage,
    targetLanguage: options.sourceSide === 'first' ? secondLanguage : firstLanguage,
    candidates: pairs.map(pair => pair.candidate), pairs,
  };
}

export function isBilingualRecommended(doc: SubtitleDocument): boolean {
  if (doc.cues.length < 3 || !hasBilingualCandidates(doc)) return false;
  return analyzeBilingual(doc, { sourceSide: 'first', splitInline: false, overrides: [] }).recommended;
}

export function previewBilingual(doc: SubtitleDocument, options: BilingualOptions, offset = 0, reviewOnly = false): BilingualPreview {
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof reviewOnly !== 'boolean') throw new StudioError('invalid_input');
  const { pairs: _pairs, candidates, ...summary } = analyzeBilingual(doc, options);
  const filtered = reviewOnly ? candidates.filter(candidate => candidate.needsReview) : candidates;
  if (offset >= filtered.length) offset = Math.max(0, Math.floor((filtered.length - 1) / PAGE_SIZE) * PAGE_SIZE);
  return { ...summary, totalCandidates: filtered.length, offset, candidates: filtered.slice(offset, offset + PAGE_SIZE) };
}

function sliceText(range: TextRange): SubtitleText {
  const spans: SubtitleText['spans'] = [];
  let offset = 0;
  for (const span of range.cue.source.spans) {
    const start = Math.max(range.start - offset, 0);
    const end = Math.min(range.end - offset, span.text.length);
    if (end > start) spans.push({ text: span.text.slice(start, end), marks: [...span.marks] });
    offset += span.text.length;
    if (offset >= range.end) break;
  }
  return { plain: range.cue.source.plain.slice(range.start, range.end), spans };
}

type RawMapping = { bodyStart: number; bodyEnd: number; starts: number[]; ends: number[]; plain: string };
function mapRawBody(doc: TextSubtitleDocument, node: TextSubtitleDocument['preservation']['nodes'][number]): RawMapping {
  const raw = doc.preservation.rawText.slice(node.start, node.end);
  let bodyStart = 0;
  let bodyEnd = raw.length;
  if (doc.origin.format === 'srt') {
    const firstBreak = raw.indexOf('\n');
    const secondBreak = raw.indexOf('\n', firstBreak + 1);
    if (firstBreak < 0 || secondBreak < 0) throw new StudioError('invalid_input');
    bodyStart = secondBreak + 1;
    bodyEnd = raw.replace(/(?:\r?\n[ \t]*)+$/, '').length;
  } else {
    bodyEnd = raw.replace(/\r?\n$/, '').length;
    while (true) {
      const match = /^\[\d+:[0-5]\d(?:\.\d{1,3})?\]/.exec(raw.slice(bodyStart));
      if (!match) break;
      bodyStart += match[0].length;
    }
  }
  const starts: number[] = [];
  const ends: number[] = [];
  const plain: string[] = [];
  for (let offset = bodyStart; offset < bodyEnd;) {
    if (raw[offset] === '<') {
      const tag = /^<\/?[biu]>/.exec(raw.slice(offset));
      if (tag) { offset += tag[0].length; continue; }
    }
    starts.push(node.start + offset);
    if (raw[offset] === '\r' && raw[offset + 1] === '\n') { plain.push('\n'); offset += 2; }
    else { plain.push(raw[offset]); offset++; }
    ends.push(node.start + offset);
  }
  return { bodyStart: node.start + bodyStart, bodyEnd: node.start + bodyEnd, starts, ends, plain: plain.join('') };
}

export function applyBilingual(doc: SubtitleDocument, options: BilingualOptions, newId: () => string, sourceDigest: (cue: SubtitleCue) => string): SubtitleDocument {
  const validated = validateDocument(doc);
  if (validated.schemaVersion === 2) throw new StudioError('unsupported_feature');
  const analysis = analyzeBilingual(validated, options);
  if (!analysis.pairedCount) throw new StudioError('invalid_input');
  const nodes = new Map(validated.preservation.nodes.map(node => [node.id, node]));
  const mappings = new Map<string, RawMapping>();
  const originalRange = (range: TextRange) => {
    let mapping = mappings.get(range.cue.nodeId);
    if (!mapping) { mapping = mapRawBody(validated, nodes.get(range.cue.nodeId)!); mappings.set(range.cue.nodeId, mapping); }
    if (mapping.plain !== range.cue.source.plain) throw new StudioError('invalid_input');
    return { nodeId: range.cue.nodeId, start: range.start === 0 ? mapping.bodyStart : mapping.ends[range.start - 1], end: range.end === mapping.plain.length ? mapping.bodyEnd : mapping.starts[range.end] };
  };
  const track: SubtitleDocument['translationTracks'][number] = { id: newId(), revision: 1, origin: 'imported', language: analysis.targetLanguage, entries: {} };
  const changed = new Map<string, SubtitleCue>();
  const removed = new Set<string>();
  for (const pair of analysis.pairs) {
    if (pair.skipped) continue;
    const source = options.sourceSide === 'first' ? pair.first : pair.second;
    const target = options.sourceSide === 'first' ? pair.second : pair.first;
    const cue: SubtitleCue = { ...source.cue, source: sliceText(source), sourceRevision: source.cue.sourceRevision + 1, importedPair: { source: originalRange(source), target: originalRange(target) } };
    changed.set(cue.id, cue);
    if (target.cue.id !== cue.id) removed.add(target.cue.id);
    track.entries[cue.id] = { sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue), text: sliceText(target), origin: 'imported', reviewStatus: 'unreviewed' };
  }
  validated.cues = validated.cues.filter(cue => !removed.has(cue.id)).map(cue => changed.get(cue.id) ?? cue);
  validated.preservation.nodes = validated.preservation.nodes.map(node => ({ ...node, cueIds: node.cueIds.filter(id => !removed.has(id)) }));
  validated.translationTracks = [track];
  validated.bilingualImport = { sourceSide: options.sourceSide, sourceLanguage: analysis.sourceLanguage, targetLanguage: analysis.targetLanguage };
  return validateDocument(validated);
}
