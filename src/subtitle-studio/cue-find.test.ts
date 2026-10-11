import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findRanges, replaceText, searchDocument } from './cue-find';
import { importSubtitleText } from './formats/import';

const text = (spans: [string, ('b' | 'i' | 'u')[]][]) => ({ plain: spans.map(([value]) => value).join(''), spans: spans.map(([value, marks]) => ({ text: value, marks })) });

describe('finding text in cues', () => {
  it('finds every literal match left to right, with or without case', () => {
    expect(findRanges('Paris, paris and PARIS', 'paris', true)).toEqual([[7, 12]]);
    expect(findRanges('Paris, paris and PARIS', 'paris', false)).toEqual([[0, 5], [7, 12], [17, 22]]);
    expect(findRanges('aaaa', 'aa', true)).toEqual([[0, 2], [2, 4]]);
    expect(findRanges('法尔童说法尔童', '法尔童', true)).toEqual([[0, 3], [4, 7]]);
    expect(findRanges('short', 'longer text', true)).toEqual([]);
  });

  it('searches every cue of a document, in sources, translations or both', () => {
    const lines = Array.from({ length: 250 }, (_, index) => `${index + 1}\n00:00:${String(index % 60).padStart(2, '0')},000 --> 00:00:${String(index % 60).padStart(2, '0')},500\n${[2, 119, 239].includes(index) ? (index === 119 ? '法尔童和法尔童' : '这是法尔童') : `第 ${index + 1} 句`}\n`);
    const doc = importSubtitleText(lines.join('\n'), { format: 'srt', displayName: 'a.srt', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);
    const found = searchDocument(doc, { query: '法尔童', field: 'source', matchCase: true });
    expect(found.cues.map(cue => [cue.index, cue.source])).toEqual([[2, 1], [119, 2], [239, 1]]);
    expect(found).toMatchObject({ occurrences: 4, truncated: false });
    const trackId = randomUUID();
    doc.translationTracks.push({ id: trackId, language: 'en', revision: 1, entries: { [doc.cues[5].id]: { sourceRevision: 1, sourceHash: '', text: text([['Phaethon', []]]), origin: 'ai', reviewStatus: 'unreviewed' } } });
    expect(searchDocument(doc, { query: 'phaethon', field: 'target', trackId, matchCase: false }).cues).toEqual([{ cueId: doc.cues[5].id, index: 5, source: 0, target: 1 }]);
    expect(searchDocument(doc, { query: 'phaethon', field: 'source', trackId, matchCase: false }).cues).toEqual([]);
    expect(searchDocument(doc, { query: '句', field: 'both', trackId, matchCase: true }, 10)).toMatchObject({ truncated: true, occurrences: 10 });
  });
});

describe('replacing text', () => {
  it('keeps the style of a span that holds the match, and rebuilds a line when a match crosses spans', () => {
    expect(replaceText(text([['法尔童来了', ['i']]]), '法尔童', '法厄同', true)).toEqual(text([['法厄同来了', ['i']]]));
    expect(replaceText(text([['Hello ', []], ['Paris', ['b']], [' now', []]]), 'paris', 'Rome', false)).toEqual(text([['Hello ', []], ['Rome', ['b']], [' now', []]]));
    // "lo P" crosses the plain and bold spans: the mixed style goes, as in an inline edit.
    expect(replaceText(text([['Hello ', []], ['Paris', ['b']]]), 'lo P', 'lo, p', true)).toEqual(text([['Hello, paris', []]]));
    expect(replaceText(text([['nothing here', []]]), 'x', 'y', true)).toBeNull();
    expect(replaceText(text([['only', []]]), 'only', '', true)).toEqual({ plain: '', spans: [] });
  });
});
