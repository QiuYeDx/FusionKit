import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateDocument, type SubtitleCue } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { bilingualOptionsSchema, bilingualPreviewSchema, type BilingualOptions } from '../../src/subtitle-studio/bilingual-contract';
import { analyzeBilingual, applyBilingual, hasBilingualCandidates, isBilingualRecommended, previewBilingual } from '../../src/subtitle-studio/bilingual';

const options = (changes: Partial<BilingualOptions> = {}): BilingualOptions => ({ sourceSide: 'first', splitInline: false, overrides: [], ...changes });
const parse = (text: string, format: 'srt' | 'lrc' = 'lrc') => importSubtitleText(text, { format, displayName: `fixture.${format}`, encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
const digest = (cue: SubtitleCue) => createHash('sha256').update(JSON.stringify(cue.source)).digest('hex');
const split = (text: string) => parse(`7\r\n00:00:01,000 --> 00:00:03,000\r\n${text}\r\n`, 'srt');
const japanese = '\u304a\u306f\u3088\u3046';
const chinese = '\u65e9\u4e0a\u597d';

describe('local bilingual subtitle analysis', () => {
  it('requires strict bounded, unique overrides', () => {
    expect(bilingualOptionsSchema.parse(options())).toEqual(options());
    for (const input of [
      { ...options(), extra: true }, { ...options(), sourceSide: 'guess' }, { ...options(), splitInline: 1 },
      options({ overrides: [{ cueId: randomUUID(), splitAt: -1 }] }),
      options({ overrides: Array.from({ length: 1001 }, () => ({ cueId: randomUUID(), splitAt: null })) }),
    ]) expect(bilingualOptionsSchema.safeParse(input).success).toBe(false);
    const repeated = { cueId: randomUUID(), splitAt: null };
    expect(bilingualOptionsSchema.safeParse(options({ overrides: [repeated, repeated] })).success).toBe(false);
  });

  it('pairs only adjacent complete runs of exactly two matching time events without sorting', () => {
    const doc = parse(`[00:02]${japanese}\n[00:02]${chinese}\n[00:01]alpha\n[00:01]beta\n[00:01]gamma\n[00:00]one\n[00:03]two\n[00:00]three`);
    const before = structuredClone(doc);
    const preview = previewBilingual(doc, options());
    expect(preview).toMatchObject({ originalCueCount: 8, cueCount: 7, totalCandidates: 1, pairedCount: 1, remainingCount: 6, reviewCount: 0, recommended: false, sourceLanguage: 'ja', targetLanguage: 'zh' });
    expect(preview.candidates[0]).toMatchObject({ id: doc.cues[0].id, kind: 'same_time', startMs: 2000, first: japanese, second: chinese, splitAt: null, splitChoices: [] });
    expect(doc).toEqual(before);
    expect(bilingualPreviewSchema.safeParse(preview).success).toBe(true);
  });

  it('requires both start and end times to match for SRT pairs', () => {
    const raw = `1\n00:00:01,000 --> 00:00:02,000\n${japanese}\n\n2\n00:00:01,000 --> 00:00:03,000\n${chinese}`;
    expect(previewBilingual(parse(raw, 'srt'), options()).totalCandidates).toBe(0);
    expect(previewBilingual(parse(raw.replace('00:00:03,000', '00:00:02,000'), 'srt'), options()).totalCandidates).toBe(1);
  });

  it('keeps same-node repeated LRC timestamps separate without blocking valid later pairs', () => {
    const duplicateOnly = parse(`[00:01][00:01]${japanese}`);
    expect(hasBilingualCandidates(duplicateOnly)).toBe(false);
    expect(previewBilingual(duplicateOnly, options()).totalCandidates).toBe(0);
    const doc = parse(`[00:01][00:01]${japanese}\n[00:03]${japanese}\n[00:03]${chinese}`);
    expect(previewBilingual(doc, options())).toMatchObject({ totalCandidates: 1, pairedCount: 1, cueCount: 3, remainingCount: 2 });
    const converted = applyBilingual(doc, options(), randomUUID, digest);
    expect(converted.cues.slice(0, 2)).toEqual(doc.cues.slice(0, 2));
    expect(converted.preservation.nodes[0].cueIds).toEqual(doc.preservation.nodes[0].cueIds);
    expect(converted.cues[2].importedPair?.source.nodeId).not.toBe(converted.cues[2].importedPair?.target.nodeId);
    expect(Object.keys(converted.translationTracks[0].entries)).toEqual([doc.cues[2].id]);
  });

  it('prefers independent line pairs over merging already multiline SRT cues sharing an interval', () => {
    const doc = parse(`1\n00:00:01,000 --> 00:00:02,000\n${japanese}\n${chinese}\n\n2\n00:00:01,000 --> 00:00:02,000\n${japanese}!\n${chinese}!`, 'srt');
    expect(previewBilingual(doc, options())).toMatchObject({ totalCandidates: 2, pairedCount: 2, cueCount: 2, candidates: [{ kind: 'lines' }, { kind: 'lines' }] });
    const converted = applyBilingual(doc, options(), randomUUID, digest);
    expect(converted.cues.map(cue => cue.id)).toEqual(doc.cues.map(cue => cue.id));
    expect(converted.cues.map(cue => cue.source.plain)).toEqual([japanese, `${japanese}!`]);
    expect(converted.preservation).toEqual(doc.preservation);
    const mixed = parse(`1\n00:00:01,000 --> 00:00:02,000\n${japanese}\n${chinese}\n\n2\n00:00:01,000 --> 00:00:02,000\nsingle`, 'srt');
    expect(previewBilingual(mixed, options())).toMatchObject({ totalCandidates: 1, pairedCount: 1, cueCount: 2, remainingCount: 1, candidates: [{ kind: 'lines' }] });
    expect(applyBilingual(mixed, options(), randomUUID, digest).cues[1]).toEqual(mixed.cues[1]);
  });

  it('marks ordinary multiline, identical and ambiguous all-Han text for review', () => {
    for (const text of ['An ordinary\ncontinued sentence', `${japanese}\n${japanese}`, '\u4eca\u65e5\n\u5929\u6c23']) {
      const preview = previewBilingual(split(text), options());
      expect(preview).toMatchObject({ pairedCount: 1, reviewCount: 1, recommended: false, sourceLanguage: 'und', targetLanguage: 'und' });
      expect(preview.candidates[0]).toMatchObject({ kind: 'lines', needsReview: true });
    }
    expect(previewBilingual(split('first\nsecond\nthird'), options()).totalCandidates).toBe(0);
  });

  it('recommends only a stable whole-document order with at least three and 80 percent agreement', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => `[00:${String(index).padStart(2, '0')}]${japanese}\n[00:${String(index).padStart(2, '0')}]${chinese}`);
    expect(previewBilingual(parse(rows(2).join('\n')), options()).recommended).toBe(false);
    expect(previewBilingual(parse(rows(3).join('\n')), options()).recommended).toBe(true);
    const mixed = parse([...rows(4), `[00:09]${chinese}\n[00:09]${japanese}`].join('\n'));
    expect(previewBilingual(mixed, options())).toMatchObject({ recommended: true, sourceLanguage: 'ja', targetLanguage: 'zh', reviewCount: 1 });
    expect(previewBilingual(mixed, options({ sourceSide: 'second' }))).toMatchObject({ recommended: true, sourceLanguage: 'zh', targetLanguage: 'ja' });
    expect(previewBilingual(mixed, options(), 0, true)).toMatchObject({ totalCandidates: 1, recommended: true, reviewCount: 1, candidates: [{ id: mixed.cues[8].id, first: chinese, second: japanese, needsReview: true }] });
    expect(previewBilingual(parse([...rows(3), '[00:09]same\n[00:09]same'].join('\n')), options()).recommended).toBe(false);
  });

  it('flags other known language orders in the minority without promoting them to semantic matches', () => {
    const majority = Array.from({ length: 4 }, (_, index) => `[${index}:00]${japanese}\n[${index}:00]${chinese}`).join('\n');
    const doc = parse(`${majority}\n[09:00]English dialogue\n[09:00]${chinese}`);
    const preview = previewBilingual(doc, options(), 0, true);
    expect(preview).toMatchObject({ recommended: true, reviewCount: 1, totalCandidates: 1, candidates: [{ first: 'English dialogue', second: chinese, needsReview: true }] });
  });

  it('keeps skipped candidates visible and rejects unknown or incompatible override IDs', () => {
    const doc = parse(`[00:01]${japanese}\n[00:01]${chinese}`);
    const skip = options({ overrides: [{ cueId: doc.cues[0].id, splitAt: null }] });
    expect(previewBilingual(doc, skip)).toMatchObject({ totalCandidates: 1, pairedCount: 0, remainingCount: 2, cueCount: 2, candidates: [{ id: doc.cues[0].id, splitAt: null }] });
    expect(() => analyzeBilingual(doc, options({ overrides: [{ cueId: doc.cues[1].id, splitAt: null }] }))).toThrow('invalid_input');
    expect(() => analyzeBilingual(doc, options({ overrides: [{ cueId: doc.cues[0].id, splitAt: 2 }] }))).toThrow('invalid_input');
    expect(() => applyBilingual(doc, skip, randomUUID, digest)).toThrow('invalid_input');
  });

  it('requires inline opt-in, offers bounded whitespace splits and suggests the kana-to-Han boundary', () => {
    const text = `${japanese} \u3054\u3056\u3044\u307e\u3059 ${chinese}`;
    const doc = parse(`[00:01]${text}`);
    expect(hasBilingualCandidates(doc)).toBe(true);
    expect(previewBilingual(doc, options()).totalCandidates).toBe(0);
    const preview = previewBilingual(doc, options({ splitInline: true }));
    const candidate = preview.candidates[0];
    expect(candidate).toMatchObject({ kind: 'inline', first: `${japanese} \u3054\u3056\u3044\u307e\u3059`, second: chinese, needsReview: true, splitAt: text.lastIndexOf(' ') });
    expect(candidate.splitChoices.map(choice => choice.offset)).toEqual([text.indexOf(' '), text.lastIndexOf(' ')]);
    const selected = options({ splitInline: true, overrides: [{ cueId: candidate.id, splitAt: text.indexOf(' ') }] });
    expect(previewBilingual(doc, selected).candidates[0]).toMatchObject({ first: japanese, second: `\u3054\u3056\u3044\u307e\u3059 ${chinese}`, needsReview: true });
    const skipped = options({ splitInline: true, overrides: [{ cueId: candidate.id, splitAt: null }] });
    expect(previewBilingual(doc, skipped)).toMatchObject({ totalCandidates: 1, pairedCount: 0, candidates: [{ splitAt: null }] });
  });

  it('marks ambiguous inline choices and preserves offsets around repeated, wide and surrogate text', () => {
    const text = `\ud83d\ude80${japanese}\t  ${chinese}\u3000\u4e16\u754c`;
    const doc = parse(`[00:01]${text}`);
    const candidate = previewBilingual(doc, options({ splitInline: true })).candidates[0];
    expect(candidate.needsReview).toBe(true);
    expect(candidate.splitChoices.map(choice => choice.offset)).toEqual([text.indexOf('\t'), text.indexOf('\u3000')]);
    const chosen = options({ splitInline: true, overrides: [{ cueId: candidate.id, splitAt: text.indexOf('\u3000') }] });
    const converted = applyBilingual(doc, chosen, randomUUID, digest);
    expect(converted.cues[0].source.plain).toBe(text.slice(0, text.indexOf('\u3000')));
    expect(converted.translationTracks[0].entries[converted.cues[0].id].text.plain).toBe('\u4e16\u754c');
    expect(previewBilingual(parse(`[00:01]${'a '.repeat(100)}z`), options({ splitInline: true })).candidates[0].splitChoices).toHaveLength(64);
  });

  it('pages candidates while reporting complete-document counts and bounds offsets', () => {
    const doc = parse(Array.from({ length: 65 }, (_, index) => `[${index}:00]${japanese}\n[${index}:00]${chinese}`).join('\n'));
    const preview = previewBilingual(doc, options(), 40);
    expect(preview).toMatchObject({ totalCandidates: 65, pairedCount: 65, cueCount: 65, remainingCount: 0, offset: 40, recommended: true });
    expect(preview.candidates).toHaveLength(20);
    expect(preview.candidates[0].id).toBe(doc.cues[80].id);
    expect(previewBilingual(doc, options(), 60).candidates).toHaveLength(5);
    expect(previewBilingual(doc, options(), 131).offset).toBe(60);
    for (const offset of [-1, 0.5, NaN, Infinity]) expect(() => previewBilingual(doc, options(), offset)).toThrow('invalid_input');
  });

  it('filters review candidates while keeping full analysis counts and clamping obsolete pages', () => {
    const doc = parse(Array.from({ length: 45 }, (_, index) => `[${index}:00]${japanese}\n[${index}:00]${index < 24 ? japanese : chinese}`).join('\n'));
    const preview = previewBilingual(doc, options(), 40, true);
    expect(preview).toMatchObject({ totalCandidates: 24, pairedCount: 45, remainingCount: 0, reviewCount: 24, offset: 20 });
    expect(preview.candidates).toHaveLength(4);
    expect(preview.candidates.every(candidate => candidate.needsReview)).toBe(true);
    const noReview = parse(`[00:01]${japanese}\n[00:01]${chinese}`);
    expect(previewBilingual(noReview, options(), 20, true)).toMatchObject({ totalCandidates: 0, offset: 0, candidates: [], pairedCount: 1 });
  });

  it('does not recommend inline heuristics or ordinary multiline subtitles for automatic prompting', () => {
    const inline = parse(Array.from({ length: 4 }, (_, index) => `[${index}:00]${japanese} ${chinese}`).join('\n'));
    expect(isBilingualRecommended(inline)).toBe(false);
    expect(previewBilingual(inline, options({ splitInline: true }))).toMatchObject({ recommended: false, reviewCount: 4, sourceLanguage: 'ja', targetLanguage: 'zh' });
    const normal = parse(Array.from({ length: 4 }, (_, index) => `${index}\n00:00:${String(index).padStart(2, '0')},000 --> 00:00:${String(index + 1).padStart(2, '0')},000\nFirst line\nSecond line`).join('\n\n'), 'srt');
    expect(isBilingualRecommended(normal)).toBe(false);
    const bilingual = parse(Array.from({ length: 3 }, (_, index) => `[${index}:00]${japanese}\n[${index}:00]${chinese}`).join('\n'));
    expect(isBilingualRecommended(bilingual)).toBe(true);
  });
});

describe('bilingual conversion and preservation', () => {
  it.each(['first', 'second'] as const)('keeps the selected %s source identity and node ownership when collapsing LRC events', sourceSide => {
    const raw = `[ar:metadata]\r\n[offset:-500]\r\n[00:01]${japanese}\r\n[00:01]${chinese}\r\n[00:03]unmatched\r\n`;
    const doc = parse(raw);
    const before = structuredClone(doc);
    const source = doc.cues[sourceSide === 'first' ? 0 : 1];
    const target = doc.cues[sourceSide === 'first' ? 1 : 0];
    const converted = applyBilingual(doc, options({ sourceSide }), randomUUID, digest);
    expect(doc).toEqual(before);
    expect(converted.id).toBe(doc.id);
    expect(converted.revision).toBe(doc.revision);
    expect(converted.cues.map(cue => cue.id)).toEqual([source.id, doc.cues[2].id]);
    expect(converted.cues[0]).toMatchObject({ nodeId: source.nodeId, sourceRevision: source.sourceRevision + 1, timingRevision: source.timingRevision, timing: source.timing, source: source.source });
    expect(converted.preservation.rawText).toBe(raw);
    expect(converted.preservation.nodes.map(node => ({ id: node.id, start: node.start, end: node.end }))).toEqual(doc.preservation.nodes.map(node => ({ id: node.id, start: node.start, end: node.end })));
    expect(converted.preservation.nodes.find(node => node.id === target.nodeId)?.cueIds).toEqual([]);
    expect(converted.preservation.nodes.find(node => node.id === source.nodeId)?.cueIds).toEqual([source.id]);
    expect(converted.translationTracks[0]).toMatchObject({ origin: 'imported', revision: 1, entries: { [source.id]: { text: target.source, sourceRevision: source.sourceRevision + 1, sourceHash: digest(converted.cues[0]), origin: 'imported', reviewStatus: 'unreviewed' } } });
    const pair = converted.cues[0].importedPair!;
    expect(raw.slice(pair.source.start, pair.source.end)).toBe(source.source.plain);
    expect(raw.slice(pair.target.start, pair.target.end)).toBe(target.source.plain);
    expect(converted.cues[1]).toEqual(doc.cues[2]);
    expect(validateDocument(converted)).toEqual(converted);
  });

  it.each(['first', 'second'] as const)('splits styled SRT lines for %s source and retains absolute raw ranges', sourceSide => {
    const doc = split(`<b>${japanese}</b>\r\n<i>${chinese}</i>`);
    const converted = applyBilingual(doc, options({ sourceSide }), randomUUID, digest);
    const sourceText = sourceSide === 'first' ? japanese : chinese;
    const targetText = sourceSide === 'first' ? chinese : japanese;
    const cue = converted.cues[0];
    expect(cue.id).toBe(doc.cues[0].id);
    expect(cue.source).toEqual({ plain: sourceText, spans: [{ text: sourceText, marks: [sourceSide === 'first' ? 'b' : 'i'] }] });
    expect(converted.translationTracks[0].entries[cue.id].text).toEqual({ plain: targetText, spans: [{ text: targetText, marks: [sourceSide === 'first' ? 'i' : 'b'] }] });
    const raw = converted.preservation.rawText;
    const pair = cue.importedPair!;
    expect(raw.slice(pair.source.start, pair.source.end)).toBe(sourceSide === 'first' ? `<b>${japanese}</b>` : `<i>${chinese}</i>`);
    expect(raw.slice(pair.target.start, pair.target.end)).toBe(sourceSide === 'first' ? `<i>${chinese}</i>` : `<b>${japanese}</b>`);
    expect(pair.source.nodeId).toBe(pair.target.nodeId);
    expect(converted.preservation).toEqual(doc.preservation);
  });

  it('retains nested styling crossing a line break and source evidence after clearing tracks', () => {
    const doc = split(`<b><i>${japanese}\r\n${chinese}</i></b>`);
    const converted = applyBilingual(doc, options(), randomUUID, digest);
    expect(converted.cues[0].source.spans[0].marks).toEqual(['b', 'i']);
    expect(converted.translationTracks[0].entries[doc.cues[0].id].text.spans[0].marks).toEqual(['b', 'i']);
    converted.translationTracks = [];
    expect(validateDocument(converted).cues[0].importedPair).toEqual(converted.cues[0].importedPair);
    expect(hasBilingualCandidates(converted)).toBe(false);
    expect(() => applyBilingual(converted, options(), randomUUID, digest)).toThrow('invalid_input');
  });

  it('retains same-node multi-label membership for unmerged playback events', () => {
    const doc = parse(`[00:01][00:02]${japanese}\n[00:02]${chinese}`);
    const converted = applyBilingual(doc, options({ sourceSide: 'second' }), randomUUID, digest);
    expect(converted.cues.map(cue => cue.id)).toEqual([doc.cues[0].id, doc.cues[2].id]);
    expect(converted.preservation.nodes[0].cueIds).toEqual([doc.cues[0].id]);
    expect(converted.preservation.nodes[1].cueIds).toEqual([doc.cues[2].id]);
    expect(converted.cues[0]).toEqual(doc.cues[0]);
  });

  it('rejects existing tracks, unsupported markup and conversion without a valid pair', () => {
    const plain = parse('[00:01]single');
    expect(hasBilingualCandidates(plain)).toBe(false);
    expect(() => applyBilingual(plain, options(), randomUUID, digest)).toThrow('invalid_input');
    const doc = split(`${japanese}\n${chinese}`);
    doc.translationTracks.push({ id: randomUUID(), language: 'en', revision: 1, entries: {} });
    expect(hasBilingualCandidates(doc)).toBe(false);
    expect(() => applyBilingual(doc, options(), randomUUID, digest)).toThrow('invalid_input');
    expect(() => applyBilingual(split('<font>unsupported</font>\nsecond'), options(), randomUUID, digest)).toThrow('unsupported_feature');
  });

  it('rejects forged provenance references, bounds and overlapping source/target ranges', () => {
    const doc = applyBilingual(split(`${japanese}\n${chinese}`), options(), randomUUID, digest);
    for (const mutate of [
      (copy: typeof doc) => { copy.cues[0].importedPair!.source.nodeId = randomUUID(); },
      (copy: typeof doc) => { copy.cues[0].importedPair!.target.nodeId = randomUUID(); },
      (copy: typeof doc) => { copy.cues[0].importedPair!.target.end = copy.preservation.rawText.length + 1; },
      (copy: typeof doc) => { copy.cues[0].importedPair!.target = { ...copy.cues[0].importedPair!.source }; },
      (copy: typeof doc) => { delete copy.bilingualImport; },
      (copy: typeof doc) => { delete copy.cues[0].importedPair; },
    ]) {
      const copy = structuredClone(doc); mutate(copy);
      expect(() => validateDocument(copy)).toThrow('invalid_input');
    }
  });

  it('handles a large input through linear candidate scans and bounded previews', () => {
    const doc = parse(Array.from({ length: 7615 }, (_, index) => `[${index}:00]${japanese} ${chinese}`).join('\n'));
    const preview = previewBilingual(doc, options({ splitInline: true }), 7600);
    expect(preview).toMatchObject({ totalCandidates: 7615, pairedCount: 7615, originalCueCount: 7615, cueCount: 7615, recommended: false, reviewCount: 7615 });
    expect(preview.candidates).toHaveLength(15);
    expect(hasBilingualCandidates(doc)).toBe(true);
  });
});
