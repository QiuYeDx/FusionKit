import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateDocument, type SubtitleCue, type SubtitleDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { BilingualOptions } from '../../src/subtitle-studio/bilingual-contract';
import { applyBilingual, previewBilingual } from '../../src/subtitle-studio/bilingual';

const ja = '\u3053\u3093\u306b\u3061\u306f';
const zh = '\u4f60\u597d';
const han = '\u4e16\u754c';
const options = (changes: Partial<BilingualOptions> = {}): BilingualOptions => ({ sourceSide: 'first', splitInline: true, overrides: [], ...changes });
const parse = (text: string, format: 'lrc' | 'srt' = 'lrc') => importSubtitleText(text, { format, displayName: `synthetic-mixed.${format}`, encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
const digest = (cue: SubtitleCue) => createHash('sha256').update(JSON.stringify(cue.source)).digest('hex');
const srtBlock = (label: number, second: number, text: string) => `${label}\r\n00:00:${String(second).padStart(2, '0')},000 --> 00:00:${String(second + 1).padStart(2, '0')},000\r\n${text}\r\n`;
const paired = (kind: 'same_time' | 'lines', first: string, second: string) => kind === 'same_time'
  ? parse(`[00:01]${first}\r\n[00:01]${second}\r\n`)
  : parse(srtBlock(7, 1, `${first}\r\n${second}`), 'srt');
const ranges = (doc: SubtitleDocument, cue: SubtitleCue) => {
  const pair = cue.importedPair!;
  return {
    source: doc.preservation.rawText.slice(pair.source.start, pair.source.end),
    target: doc.preservation.rawText.slice(pair.target.start, pair.target.end),
  };
};
const nodeRanges = (doc: SubtitleDocument) => doc.preservation.nodes.map(node => ({ id: node.id, start: node.start, end: node.end }));

describe('mixed text inside structurally paired bilingual subtitles', () => {
  it.each((['same_time', 'lines'] as const).flatMap(kind => (['first', 'second'] as const).map(sourceSide => ({ kind, sourceSide }))))('separates identical complete bilingual strings for $kind / source $sourceSide without losing source identity', ({ kind, sourceSide }) => {
    const first = `<b>${ja}</b>\t  <i>${zh}</i>`;
    const second = `<u>${ja}</u>\t  <u>${zh}</u>`;
    const doc = paired(kind, first, second);
    const before = structuredClone(doc);
    const preview = previewBilingual(doc, options({ sourceSide }));
    expect(preview).toMatchObject({ totalCandidates: 1, pairedCount: 1, reviewCount: 1, candidates: [{ kind, id: doc.cues[0].id, first: ja, second: zh, needsReview: true, splitAt: ja.length, splitChoices: [{ offset: ja.length }] }] });
    const converted = applyBilingual(doc, options({ sourceSide }), randomUUID, digest);
    const selected = doc.cues[kind === 'same_time' && sourceSide === 'second' ? 1 : 0];
    const cue = converted.cues[0];
    const entry = converted.translationTracks[0].entries[cue.id];
    expect(cue).toMatchObject({ id: selected.id, nodeId: selected.nodeId, sourceRevision: selected.sourceRevision + 1, timing: selected.timing, timingRevision: selected.timingRevision });
    expect(cue.source).toEqual(sourceSide === 'first' ? { plain: ja, spans: [{ text: ja, marks: ['b'] }] } : { plain: zh, spans: [{ text: zh, marks: ['u'] }] });
    expect(entry.text).toEqual(sourceSide === 'first' ? { plain: zh, spans: [{ text: zh, marks: ['u'] }] } : { plain: ja, spans: [{ text: ja, marks: ['b'] }] });
    expect(entry.sourceHash).toBe(digest(cue));
    expect(ranges(converted, cue)).toEqual(sourceSide === 'first' ? { source: `<b>${ja}</b>`, target: `<u>${zh}</u>` } : { source: `<u>${zh}</u>`, target: `<b>${ja}</b>` });
    expect(cue.importedPair?.source.nodeId).toBe(selected.nodeId);
    expect(cue.importedPair?.target.nodeId).toBe(doc.cues[kind === 'same_time' && sourceSide === 'first' ? 1 : 0].nodeId);
    expect(converted.preservation.rawText).toBe(doc.preservation.rawText);
    expect(nodeRanges(converted)).toEqual(nodeRanges(doc));
    expect(validateDocument(converted)).toEqual(converted);
    expect(doc).toEqual(before);
  });

  it.each(['same_time', 'lines'] as const)('supports explicit alternative whitespace boundaries for repeated %s text and disables them with inline mode', kind => {
    const body = `${ja} ${zh}\u3000${han}`;
    const doc = paired(kind, body, body);
    const defaultPreview = previewBilingual(doc, options());
    expect(defaultPreview.candidates[0]).toMatchObject({ first: ja, second: `${zh}\u3000${han}`, splitAt: ja.length });
    expect(defaultPreview.candidates[0].splitChoices.map(item => item.offset)).toEqual([ja.length, body.indexOf('\u3000')]);
    const custom = options({ overrides: [{ cueId: doc.cues[0].id, splitAt: body.indexOf('\u3000') }] });
    const preview = previewBilingual(doc, custom);
    expect(preview.candidates[0]).toMatchObject({ kind, first: `${ja} ${zh}`, second: han, splitAt: body.indexOf('\u3000'), needsReview: true });
    const converted = applyBilingual(doc, custom, randomUUID, digest);
    expect(converted.cues[0].source.plain).toBe(preview.candidates[0].first);
    expect(converted.translationTracks[0].entries[converted.cues[0].id].text.plain).toBe(preview.candidates[0].second);
    const disabled = options({ ...custom, splitInline: false });
    expect(previewBilingual(doc, disabled).candidates[0]).toMatchObject({ first: body, second: body, splitChoices: [] });
    const unchanged = applyBilingual(doc, disabled, randomUUID, digest);
    expect(unchanged.cues[0].source.plain).toBe(body);
    expect(unchanged.translationTracks[0].entries[unchanged.cues[0].id].text.plain).toBe(body);
    expect(() => previewBilingual(doc, options({ overrides: [{ cueId: doc.cues[0].id, splitAt: ja.length + 1 }] }))).toThrow('invalid_input');
  });

  it('keeps line-relative text ranges aligned when the first nonempty source line begins later in the cue', () => {
    const body = `\ud83d\ude80${ja} ${zh}\u3000${han}`;
    const doc = parse(srtBlock(7, 1, `<b></b>\r\n${body}\r\n${body}`), 'srt');
    expect(doc.cues[0].source.plain).toBe(`\n${body}\n${body}`);
    const offset = 1 + body.indexOf('\u3000');
    const config = options({ sourceSide: 'second', overrides: [{ cueId: doc.cues[0].id, splitAt: offset }] });
    const preview = previewBilingual(doc, config);
    expect(preview.candidates[0]).toMatchObject({ first: `\ud83d\ude80${ja} ${zh}`, second: han, splitAt: offset });
    expect(preview.candidates[0].splitChoices.map(choice => choice.offset)).toEqual([1 + body.indexOf(' '), offset]);
    const converted = applyBilingual(doc, config, randomUUID, digest);
    const cue = converted.cues[0];
    expect(cue.source.plain).toBe(han);
    expect(converted.translationTracks[0].entries[cue.id].text.plain).toBe(`\ud83d\ude80${ja} ${zh}`);
    expect(ranges(converted, cue)).toEqual({ source: han, target: `\ud83d\ude80${ja} ${zh}` });
  });

  it.each(['same_time', 'lines'] as const)('keeps skipped complete duplicates visible and leaves their original events unchanged for %s', kind => {
    const body = `${ja} ${zh}`;
    const doc = kind === 'same_time'
      ? parse(`[00:01]${body}\n[00:01]${body}\n[00:03]${ja}\n[00:03]${zh}`)
      : parse([srtBlock(1, 1, `${body}\r\n${body}`), srtBlock(2, 3, `${ja}\r\n${zh}`)].join('\r\n'), 'srt');
    const config = options({ overrides: [{ cueId: doc.cues[0].id, splitAt: null }] });
    const candidate = previewBilingual(doc, config).candidates[0];
    expect(candidate).toMatchObject({ kind, first: body, second: body, splitAt: null, needsReview: true, splitChoices: [{ offset: ja.length }] });
    const converted = applyBilingual(doc, config, randomUUID, digest);
    const unchangedCount = kind === 'same_time' ? 2 : 1;
    expect(converted.cues.slice(0, unchangedCount)).toEqual(doc.cues.slice(0, unchangedCount));
    for (const cue of doc.cues.slice(0, unchangedCount)) expect(converted.translationTracks[0].entries[cue.id]).toBeUndefined();
  });

  it.each(['ordinary English text', `${ja} ${ja}`, `${han} ${zh}`, `${ja} !!!`, `1234 ${zh}`, `${ja}${zh}`])('does not guess a split in identical text without a distinct recognized-language boundary: %s', body => {
    const evidence = Array.from({ length: 4 }, (_, index) => `[${index}:00]${ja}\n[${index}:00]${zh}`).join('\n');
    const doc = parse(`${evidence}\n[09:00]${body}\n[09:00]${body}`);
    const candidate = previewBilingual(doc, options()).candidates.at(-1)!;
    expect(candidate).toMatchObject({ first: body, second: body, splitAt: null, splitChoices: [], needsReview: true });
    const converted = applyBilingual(doc, options(), randomUUID, digest);
    expect(converted.cues.at(-1)?.source.plain).toBe(body);
    expect(converted.translationTracks[0].entries[converted.cues.at(-1)!.id].text.plain).toBe(body);
  });

  it('prefers a Japanese-to-Chinese split while offering other recognized distinct-language boundaries', () => {
    const body = `English ${ja} ${zh}`;
    const doc = paired('same_time', body, body);
    const candidate = previewBilingual(doc, options()).candidates[0];
    expect(candidate.splitChoices.map(choice => choice.offset)).toEqual([body.indexOf(' '), body.lastIndexOf(' ')]);
    expect(candidate).toMatchObject({ first: `English ${ja}`, second: zh, splitAt: body.lastIndexOf(' '), needsReview: true });
    const config = options({ overrides: [{ cueId: candidate.id, splitAt: body.indexOf(' ') }] });
    expect(previewBilingual(doc, config).candidates[0]).toMatchObject({ first: 'English', second: `${ja} ${zh}` });
    expect(previewBilingual(paired('lines', ja, zh), options()).candidates[0].splitChoices).toEqual([]);
  });

  it.each((['same_time', 'lines'] as const).flatMap(kind => (['first', 'second'] as const).flatMap(sourceSide => (['first', 'second'] as const).map(mixedSide => ({ kind, sourceSide, mixedSide })))))('shrinks only the duplicated side for $kind / source $sourceSide / mixed $mixedSide', ({ kind, sourceSide, mixedSide }) => {
    const firstRaw = mixedSide === 'first' ? `<b>${ja}</b>\t  <i>${zh}</i>` : `<u>${ja}</u>`;
    const secondRaw = mixedSide === 'first' ? `<u>${zh}</u>` : `<b>${zh}</b>\u3000<i>${ja}</i>`;
    const doc = paired(kind, firstRaw, secondRaw);
    const before = structuredClone(doc);
    const config = options({ sourceSide });
    const preview = previewBilingual(doc, config);
    expect(preview).toMatchObject({ totalCandidates: 1, pairedCount: 1, remainingCount: 0, reviewCount: 1,
      candidates: [{ id: doc.cues[0].id, kind, first: ja, second: zh, needsReview: true }] });
    const converted = applyBilingual(doc, config, randomUUID, digest);
    const selected = doc.cues[kind === 'same_time' && sourceSide === 'second' ? 1 : 0];
    const cue = converted.cues[0];
    const target = converted.translationTracks[0].entries[cue.id];
    expect(cue).toMatchObject({ id: selected.id, nodeId: selected.nodeId, sourceRevision: selected.sourceRevision + 1, timingRevision: selected.timingRevision, timing: selected.timing });
    const sourceText = sourceSide === 'first' ? ja : zh;
    const targetText = sourceSide === 'first' ? zh : ja;
    const sourceMark = sourceSide === mixedSide ? 'b' : 'u';
    const targetMark = sourceSide === mixedSide ? 'u' : 'b';
    expect(cue.source).toEqual({ plain: sourceText, spans: [{ text: sourceText, marks: [sourceMark] }] });
    expect(target.text).toEqual({ plain: targetText, spans: [{ text: targetText, marks: [targetMark] }] });
    expect(target).toMatchObject({ sourceRevision: cue.sourceRevision, sourceHash: digest(cue), origin: 'imported', reviewStatus: 'unreviewed' });
    expect(ranges(converted, cue)).toEqual({ source: `<${sourceMark}>${sourceText}</${sourceMark}>`, target: `<${targetMark}>${targetText}</${targetMark}>` });
    expect(cue.importedPair?.source.nodeId).toBe(selected.nodeId);
    expect(converted.preservation.rawText).toBe(doc.preservation.rawText);
    expect(nodeRanges(converted)).toEqual(nodeRanges(doc));
    expect(doc).toEqual(before);
    expect(validateDocument(converted)).toEqual(converted);
  });

  it.each(['same_time', 'lines'] as const)('keeps the entire mixed side when inline splitting is disabled for %s', kind => {
    const first = `${ja} ${zh}`;
    const doc = paired(kind, first, zh);
    const config = options({ splitInline: false });
    expect(previewBilingual(doc, config).candidates[0]).toMatchObject({ kind, first, second: zh });
    const converted = applyBilingual(doc, config, randomUUID, digest);
    expect(converted.cues[0].source.plain).toBe(first);
    expect(converted.translationTracks[0].entries[converted.cues[0].id].text.plain).toBe(zh);
    expect(ranges(converted, converted.cues[0]).source).toBe(first);
  });

  it.each(['same_time', 'lines'] as const)('retains a skipped mixed candidate and all of its original events for %s', kind => {
    const doc = kind === 'same_time'
      ? parse(`[00:01]${ja} ${zh}\n[00:01]${zh}\n[00:03]${ja}\n[00:03]${zh}`)
      : parse([srtBlock(1, 1, `${ja} ${zh}\r\n${zh}`), srtBlock(2, 3, `${ja}\r\n${zh}`)].join('\r\n'), 'srt');
    const before = structuredClone(doc);
    const config = options({ overrides: [{ cueId: doc.cues[0].id, splitAt: null }] });
    const preview = previewBilingual(doc, config);
    expect(preview).toMatchObject({ totalCandidates: 2, pairedCount: 1 });
    expect(preview.candidates[0]).toMatchObject({ id: doc.cues[0].id, first: `${ja} ${zh}`, second: zh, splitAt: null });
    const converted = applyBilingual(doc, config, randomUUID, digest);
    const unchangedCount = kind === 'same_time' ? 2 : 1;
    expect(converted.cues.slice(0, unchangedCount)).toEqual(doc.cues.slice(0, unchangedCount));
    for (const cue of doc.cues.slice(0, unchangedCount)) expect(converted.translationTracks[0].entries[cue.id]).toBeUndefined();
    expect(converted.preservation.rawText).toBe(doc.preservation.rawText);
    expect(doc).toEqual(before);
  });

  it.each([
    { first: 'The whole world', second: 'world', reason: 'ordinary English suffix' },
    { first: `${ja} ${ja}`, second: ja, reason: 'same-language Japanese repetition' },
    { first: `${ja} !!!`, second: '!!!', reason: 'punctuation-only counterpart' },
    { first: `${ja} 1234`, second: '1234', reason: 'unknown-language counterpart' },
    { first: `1234 ${zh}`, second: zh, reason: 'unknown-language prefix' },
    { first: `${ja} ${zh}!`, second: zh, reason: 'nonexact trailing punctuation' },
    { first: `${ja} ${zh}`, second: `${zh}${han}`, reason: 'only partial counterpart present' },
    { first: `${ja}${zh}`, second: zh, reason: 'missing whitespace boundary' },
    { first: zh, second: `${ja}${zh}`, reason: 'symmetric missing whitespace boundary' },
  ])('does not strip $reason', ({ first, second }) => {
    const doc = paired('same_time', first, second);
    expect(previewBilingual(doc, options()).candidates[0]).toMatchObject({ first, second });
    for (const sourceSide of ['first', 'second'] as const) {
      const converted = applyBilingual(doc, options({ sourceSide }), randomUUID, digest);
      const cue = converted.cues[0];
      expect(cue.source.plain).toBe(sourceSide === 'first' ? first : second);
      expect(converted.translationTracks[0].entries[cue.id].text.plain).toBe(sourceSide === 'first' ? second : first);
    }
  });

  it.each([
    { count: 2, direction: 'ja:zh', allowed: false },
    { count: 3, direction: 'ja:zh', allowed: false },
    { count: 4, direction: 'ja:zh', allowed: true },
    { count: 3, direction: 'zh:ja', allowed: false },
    { count: 4, direction: 'zh:ja', allowed: true },
    { count: 4, direction: 'en:zh', allowed: false },
  ] as const)('gates all-Han shrinking on original whole-file structural evidence: $count / $direction', ({ count, direction, allowed }) => {
    const evidenceFirst = direction === 'ja:zh' ? ja : direction === 'zh:ja' ? zh : 'English dialogue';
    const evidenceSecond = direction === 'zh:ja' ? ja : zh;
    const evidence = Array.from({ length: count }, (_, index) => `[${index}:00]${evidenceFirst}\n[${index}:00]${evidenceSecond}`).join('\n');
    const first = direction === 'zh:ja' ? zh : `${han} ${zh}`;
    const second = direction === 'zh:ja' ? `${han} ${zh}` : zh;
    const doc = parse(`${evidence}\n[09:00]${first}\n[09:00]${second}`);
    const mixedId = doc.cues[count * 2].id;
    const candidate = previewBilingual(doc, options()).candidates.find(item => item.id === mixedId)!;
    expect(candidate).toMatchObject({ needsReview: true, first: direction === 'zh:ja' ? zh : allowed ? han : first, second: direction === 'zh:ja' && allowed ? han : second });
    for (const sourceSide of ['first', 'second'] as const) {
      const converted = applyBilingual(doc, options({ sourceSide }), randomUUID, digest);
      const cueId = doc.cues[count * 2 + (sourceSide === 'second' ? 1 : 0)].id;
      const cue = converted.cues.find(item => item.id === cueId)!;
      expect(cue.source.plain).toBe(sourceSide === 'first' ? candidate.first : candidate.second);
      expect(converted.translationTracks[0].entries[cueId].text.plain).toBe(sourceSide === 'first' ? candidate.second : candidate.first);
    }
  });

  it('does not use optional standalone inline guesses to establish all-Han structural evidence', () => {
    const evidence = Array.from({ length: 8 }, (_, index) => `[${index}:00]${ja} ${zh}`).join('\n');
    const doc = parse(`${evidence}\n[09:00]${han} ${zh}\n[09:00]${zh}`);
    expect(previewBilingual(doc, options()).candidates.at(-1)).toMatchObject({ kind: 'same_time', first: `${han} ${zh}`, second: zh, needsReview: true });
  });

  it('does not raise 75 percent whole-file evidence above the Han threshold by skipping a reversed pair', () => {
    const evidence = Array.from({ length: 6 }, (_, index) => `[${index}:00]${ja}\n[${index}:00]${zh}`).join('\n');
    const doc = parse(`${evidence}\n[07:00]${zh}\n[07:00]${ja}\n[09:00]${han} ${zh}\n[09:00]${zh}`);
    const reverseId = doc.cues[12].id;
    const mixedId = doc.cues[14].id;
    expect(previewBilingual(doc, options()).candidates.find(candidate => candidate.id === mixedId)).toMatchObject({ first: `${han} ${zh}`, second: zh });
    const config = options({ overrides: [{ cueId: reverseId, splitAt: null }] });
    const preview = previewBilingual(doc, config);
    expect(preview).toMatchObject({ totalCandidates: 8, pairedCount: 7 });
    expect(preview.candidates.find(candidate => candidate.id === mixedId)).toMatchObject({ first: `${han} ${zh}`, second: zh, needsReview: true });
    const converted = applyBilingual(doc, config, randomUUID, digest);
    expect(converted.cues.find(cue => cue.id === mixedId)?.source.plain).toBe(`${han} ${zh}`);
    expect(converted.translationTracks[0].entries[mixedId].text.plain).toBe(zh);
    expect(converted.cues.find(cue => cue.id === reverseId)).toEqual(doc.cues[12]);
    expect(converted.cues.find(cue => cue.id === doc.cues[13].id)).toEqual(doc.cues[13]);
  });

  it('handles normal line pairs, standalone inline pairs and mixed structural pairs in one document', () => {
    const doc = parse([
      srtBlock(1, 1, `<b>${ja}</b> ${zh}`), srtBlock(2, 1, zh),
      srtBlock(3, 3, `${ja}\r\n${zh}`),
      srtBlock(4, 5, `${ja} ${zh}`),
      srtBlock(5, 7, `${ja} ${zh}\r\n${zh}`),
      srtBlock(6, 9, han),
    ].join('\r\n'), 'srt');
    const before = structuredClone(doc);
    const preview = previewBilingual(doc, options());
    expect(preview).toMatchObject({ originalCueCount: 6, cueCount: 5, totalCandidates: 4, pairedCount: 4, remainingCount: 1 });
    expect(preview.candidates.map(item => ({ kind: item.kind, first: item.first, second: item.second }))).toEqual([
      { kind: 'same_time', first: ja, second: zh }, { kind: 'lines', first: ja, second: zh },
      { kind: 'inline', first: ja, second: zh }, { kind: 'lines', first: ja, second: zh },
    ]);
    const converted = applyBilingual(doc, options(), randomUUID, digest);
    expect(converted.cues.map(cue => cue.source.plain)).toEqual([ja, ja, ja, ja, han]);
    expect(converted.cues.at(-1)).toEqual(doc.cues.at(-1));
    expect(Object.values(converted.translationTracks[0].entries).map(entry => entry.text.plain)).toEqual([zh, zh, zh, zh]);
    expect(converted.preservation.rawText).toBe(doc.preservation.rawText);
    expect(nodeRanges(converted)).toEqual(nodeRanges(doc));
    expect(doc).toEqual(before);
  });
});
