import { describe, expect, it } from 'vitest';
import type { SubtitleCue, TranslationEntry } from './domain';
import { consecutive, findAdjacentDuplicates, mergeOperation, mergeProposal, mergeTexts, mergedTiming, parseStudioTime, repeats, revisionOperation, structureKey } from './cue-structure';

const plain = (text: string, marks: ('b' | 'i' | 'u')[] = []) => ({ plain: text, spans: [{ text, marks }] });
const cue = (id: string, text: string, startMs: number, endMs: number | null, sourceRevision = 1): SubtitleCue =>
  ({ id, sourceRevision, timingRevision: 1, timing: { startMs, endMs, provenance: 'lrc_offset' }, source: plain(text), nodeId: `${id}-node` }) as SubtitleCue;
const entry = (text: string, sourceRevision = 1): TranslationEntry => ({ sourceRevision, sourceHash: 'h', text: plain(text), origin: 'imported', reviewStatus: 'unreviewed' });

describe('merging cues', () => {
  it('keeps one copy of a repeated recognition, the fuller one', () => {
    // The user's report: the same sentence recognized twice, once with the reading comma.
    expect(mergeTexts(['先輩みたいに朝から眠そうにしてる方、', '先輩みたいに朝から眠そうにしてる方'])).toBe('先輩みたいに朝から眠そうにしてる方、');
    expect(mergeTexts(['像前辈这样一大早就犯困的', '像前辈这样一大早就犯困的，'])).toBe('像前辈这样一大早就犯困的，');
    expect(mergeTexts(['先輩みたいに', '先輩みたいに朝から眠そうにしてる方'])).toBe('先輩みたいに朝から眠そうにしてる方');
    expect(repeats('Hello there.', 'hello there')).toBe(true);
    // A short word inside a long line is not a repetition of it.
    expect(repeats('方', '先輩みたいに朝から眠そうにしてる方')).toBe(false);
  });

  it('joins different texts directly after CJK and with a space otherwise', () => {
    expect(mergeTexts(['こんにちは。', '元気？'])).toBe('こんにちは。元気？');
    expect(mergeTexts(['Hello', 'world'])).toBe('Hello world');
    expect(mergeTexts(['Hello', '世界'])).toBe('Hello世界');
    expect(mergeTexts(['a', '  ', 'b'])).toBe('a b');
  });

  it('builds the merge of a duplicated pair with its translation and span', () => {
    const cues = [cue('c1', '先輩みたいに朝から眠そうにしてる方、', 26780, null), cue('c2', '先輩みたいに朝から眠そうにしてる方', 27500, null)];
    const track = { id: 't', entries: { c1: entry('像前辈这样一大早就犯困的，'), c2: entry('像前辈这样一大早就犯困的') } };
    expect(mergeOperation(cues, track)).toEqual({ kind: 'merge', cueIds: ['c1', 'c2'], source: plain('先輩みたいに朝から眠そうにしてる方、'), origin: 'human',
      trackId: 't', target: plain('像前辈这样一大早就犯困的，') });
    expect(mergedTiming(cues)).toEqual({ startMs: 26780, endMs: null });
    expect(mergedTiming([cues[0], cue('c3', 'x', 30000, 31000)])).toEqual({ startMs: 26780, endMs: 31000 });
  });

  it('marks a joined translation stale unless every cue had a current one', () => {
    const cues = [cue('c1', 'One', 0, 1000), cue('c2', 'Two', 1000, 2000, 2)];
    expect(mergeOperation(cues, { id: 't', entries: { c1: entry('一'), c2: entry('二', 1) } })).toMatchObject({ target: plain('一二'), targetStale: true });
    expect(mergeOperation(cues, { id: 't', entries: { c1: entry('一') } })).toMatchObject({ target: plain('一'), targetStale: true });
    expect(mergeOperation(cues, { id: 't', entries: {} })).not.toHaveProperty('target');
    // A line styled as a whole keeps its style.
    expect(mergeOperation([{ ...cues[0], source: plain('One', ['i']) }, { ...cues[1], source: plain('Two', ['i']) }]).source).toEqual(plain('One Two', ['i']));
  });

  it('knows which selections are consecutive', () => {
    expect(consecutive(['b', 'c'], ['a', 'b', 'c', 'd'])).toBe(true);
    expect(consecutive(['c', 'b'], ['a', 'b', 'c', 'd'])).toBe(true);
    expect(consecutive(['a', 'c'], ['a', 'b', 'c', 'd'])).toBe(false);
    expect(consecutive(['a', 'x'], ['a', 'b'])).toBe(false);
  });
});

describe('typed times', () => {
  it('reads hours, minutes and seconds with a dot or comma fraction', () => {
    expect(parseStudioTime('00:00:26.780')).toBe(26780);
    expect(parseStudioTime('1:02:03,5')).toBe(3723500);
    expect(parseStudioTime('02:03.25')).toBe(123250);
    expect(parseStudioTime('75.5')).toBe(75500);
    expect(parseStudioTime(' 3 ')).toBe(3000);
  });

  it('refuses what is not a time', () => {
    for (const value of ['', 'abc', '1:75', '1:60:00', '-1', '00:00:01.2345', '1::2']) expect(parseStudioTime(value), value).toBeNull();
  });
});

describe('finding repeated recognition', () => {
  const at = (index: number, text: string, startMs: number) => ({ ...cue(`c${index}`, text, startMs, null), index });
  it('finds the reported repetition among its neighbours and proposes one merge', () => {
    const cues = [at(7, '私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、', 22770), at(8, '先輩みたいに朝から眠そうにしてる方、', 26780),
      at(9, '先輩みたいに朝から眠そうにしてる方', 27500), at(10, 'いますもん', 29860)];
    const track = { id: 't', entries: { c8: entry('像前辈这样一大早就犯困的，'), c9: entry('像前辈这样一大早就犯困的') } };
    const [found, ...rest] = findAdjacentDuplicates(cues, track);
    expect(rest).toEqual([]);
    expect(found).toMatchObject({ kind: 'merge', cueIds: ['c8', 'c9'], indexes: [8, 9], source: '先輩みたいに朝から眠そうにしてる方、', target: '像前辈这样一大早就犯困的，',
      timing: { startMs: 26780, endMs: null }, origin: 'human' });
    expect(found.targetStale).toBeUndefined();
    expect(structureKey(found)).toBe('merge:c8');
  });

  it('joins a run of three, and leaves distant or merely similar lines alone', () => {
    expect(findAdjacentDuplicates([at(0, 'はい', 0), at(1, 'はい。', 500), at(2, 'はい', 900), at(3, 'いいえ', 1200)]).map(item => item.cueIds)).toEqual([['c0', 'c1', 'c2']]);
    // More than ten seconds apart: a line said again, not recognized twice.
    expect(findAdjacentDuplicates([at(0, 'もう一回', 0), at(1, 'もう一回', 11000)])).toEqual([]);
    expect(findAdjacentDuplicates([at(0, '方', 0), at(1, '先輩みたいに朝から眠そうにしてる方', 500)])).toEqual([]);
    // Not neighbours in the document.
    expect(findAdjacentDuplicates([at(0, 'はい', 0), at(2, 'はい', 500)])).toEqual([]);
  });
});

describe('applying a revision with structure', () => {
  const cues = [{ ...cue('a', 'One', 0, 1000), index: 0 }, { ...cue('b', 'One', 1000, 2000), index: 1 }, { ...cue('c', 'Noise', 2000, 3000), index: 2 }];
  const merge = mergeProposal(cues.slice(0, 2));
  it('stays one revise for text only, and becomes one batch with merges, deletions and times', () => {
    const texts = { kind: 'revise' as const, sources: { c: plain('Fixed') } };
    expect(revisionOperation(texts, [])).toEqual(texts);
    expect(revisionOperation({ kind: 'revise', sources: {} }, [])).toBeNull();
    const operation = revisionOperation(texts, [merge,
      { kind: 'delete', cueId: 'c', index: 2, current: { source: plain('Noise') }, timing: { startMs: 2000, endMs: 3000 } },
      { kind: 'timing', cueId: 'a', index: 0, current: { source: plain('One') }, before: { startMs: 0, endMs: 1000 }, timing: { startMs: 100, endMs: 900 } }]);
    expect(operation).toEqual({ kind: 'batch', operations: [texts, { kind: 'merge', cueIds: ['a', 'b'], source: plain('One'), origin: 'human' },
      { kind: 'delete', cueIds: ['c'] }, { kind: 'timing', changes: { a: { startMs: 100, endMs: 900 } } }] });
    expect(revisionOperation(null, [merge])).toEqual({ kind: 'merge', cueIds: ['a', 'b'], source: plain('One'), origin: 'human' });
  });
});
