import { describe, expect, it } from 'vitest';
import type { ConsistencyGroup, ConsistencyResult } from '@/subtitle-studio/consistency-contract';
import { cueKey, defaultChoice, groupChangeCount, planConsistencyEdits, replaceWording, unfixablePlaces, wordingsToKeep, type CueTexts, type GroupChoice } from './consistency-apply';

const SOURCE = 'テイムフィールド家のお嬢様';
const MISHEARD = 'テームフィールド家のお嬢様';
const RIGHT = '泰姆菲尔德家的大小姐';
const WRONG = '时间菲尔德家的大小姐';
const text = (plain: string) => ({ plain, spans: [{ text: plain, marks: [] as ('b' | 'i' | 'u')[] }] });
const place = (documentId: string, index: number) => ({ documentId, cueId: `${documentId}-${index}`, index, source: '', target: '' });
const group: ConsistencyGroup = { id: 'g1', kind: 'translation', source: SOURCE, recommended: RIGHT,
  spellings: [{ text: SOURCE, count: 4, occurrences: [place('a', 0), place('a', 1), place('b', 0), place('b', 1)] }, { text: MISHEARD, count: 1, occurrences: [place('a', 3)] }],
  variants: [{ text: RIGHT, count: 2, occurrences: [place('a', 0), place('b', 0)] }, { text: WRONG, count: 2, occurrences: [place('a', 1), place('b', 1)] }] };
const result: ConsistencyResult = { groups: [group], checkedLines: 6, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  documents: [{ documentId: 'a', revision: 3, name: 'A', trackId: 'ta' }, { documentId: 'b', revision: 5, name: 'B', trackId: 'tb' }] };
const texts = new Map<string, CueTexts>([
  [cueKey('a', 'a-0'), { source: text(`${SOURCE}です`), target: text(`${RIGHT}来了`) }],
  [cueKey('a', 'a-1'), { source: text(`${SOURCE}！`), target: text(`${WRONG}！${WRONG}`) }],
  [cueKey('a', 'a-3'), { source: text(`${MISHEARD}？`), target: text(`${RIGHT}？`) }],
  [cueKey('b', 'b-0'), { source: text(`${SOURCE}ね`), target: text(`${RIGHT}呢`) }],
  [cueKey('b', 'b-1'), { source: text(`${SOURCE}よ`), target: text(`${WRONG}哟`) }],
]);
/** A name only the source writes two ways; the document has no translation. */
const senpai: ConsistencyGroup = { id: 'g2', kind: 'source', source: '先輩', variants: [],
  spellings: [{ text: '先輩', count: 2, occurrences: [place('c', 0), place('c', 1)] }, { text: 'せんぱい', count: 1, occurrences: [place('c', 2)] }] };
const untranslated: ConsistencyResult = { groups: [senpai], checkedLines: 3, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, documents: [{ documentId: 'c', revision: 1, name: 'C' }] };
const senpaiTexts = new Map<string, CueTexts>([
  [cueKey('c', 'c-0'), { source: text('先輩、おはよう') }], [cueKey('c', 'c-1'), { source: text('先輩！') }], [cueKey('c', 'c-2'), { source: text('せんぱい？') }],
]);

describe('unifying wordings', () => {
  it('replaces every case of a wording, but not inside the new wording', () => {
    expect(replaceWording('DeepSeek and deepseek', 'deepseek', 'DeepSeek')).toBe('DeepSeek and DeepSeek');
    expect(replaceWording('a.b a-b', 'a.b', 'x')).toBe('x a-b');
    expect(replaceWording('same', 'same', 'same')).toBe('same');
    expect(replaceWording('シロバトさんとバトさん', 'バトさん', 'シロバトさん')).toBe('シロバトさんとシロバトさん');
    expect(replaceWording('菲尔德和泰姆菲尔德', '菲尔德', '泰姆菲尔德')).toBe('泰姆菲尔德和泰姆菲尔德');
  });

  it('starts from the recommendation, leaves sources alone and counts the changes', () => {
    const choice = defaultChoice(group);
    expect(choice).toEqual({ apply: true, standard: RIGHT, fixSource: false, sourceStandard: SOURCE, keep: true });
    expect(groupChangeCount(group, choice)).toBe(2);
    expect(groupChangeCount(group, { ...choice, fixSource: true })).toBe(3);
    expect(groupChangeCount(group, { ...choice, apply: false })).toBe(0);
    expect(defaultChoice({ ...group, knowledgeTarget: RIGHT }).keep).toBe(false);
  });

  it('unifies a source-only group once chosen, in the direction chosen', () => {
    // Off until the user picks it; then it counts, so the unify button is enabled.
    const choice = defaultChoice(senpai);
    expect(choice).toEqual({ apply: false, standard: '', fixSource: true, sourceStandard: '先輩', keep: false });
    expect(groupChangeCount(senpai, choice)).toBe(0);
    expect(groupChangeCount(senpai, { ...choice, apply: true })).toBe(1);
    const towardsMost = planConsistencyEdits(untranslated, new Map([['g2', { ...choice, apply: true }]]), senpaiTexts);
    expect(towardsMost.edits.map(edit => edit.operation)).toEqual([{ kind: 'revise', sources: { 'c-2': text('先輩？') } }]);
    // The other direction: every other spelling, the most common one included, becomes the chosen one.
    const towardsKana = planConsistencyEdits(untranslated, new Map([['g2', { ...choice, apply: true, sourceStandard: 'せんぱい' }]]), senpaiTexts);
    expect(towardsKana.changedCues).toBe(2);
    expect(towardsKana.edits[0].operation).toEqual({ kind: 'revise', sources: { 'c-0': text('せんぱい、おはよう'), 'c-1': text('せんぱい！') } });
    // Nothing to keep in translation materials without a translation.
    expect(wordingsToKeep(untranslated, new Map([['g2', { ...choice, apply: true, keep: true }]]))).toEqual([]);
  });

  it('makes one revise edit per document with only the changed cues', () => {
    const choices = new Map<string, GroupChoice>([['g1', defaultChoice(group)]]);
    const plan = planConsistencyEdits(result, choices, texts);
    expect(plan.changedCues).toBe(2);
    expect(plan.edits.map(edit => [edit.document.documentId, edit.count])).toEqual([['a', 1], ['b', 1]]);
    expect(plan.edits[0].operation).toEqual({ kind: 'revise', sources: {}, trackId: 'ta', targets: { 'a-1': text(`${RIGHT}！${RIGHT}`) } });
    expect(plan.edits[1].operation).toMatchObject({ trackId: 'tb', targets: { 'b-1': text(`${RIGHT}哟`) } });
  });

  it('corrects source spellings only when asked and keeps their translations current', () => {
    const plan = planConsistencyEdits(result, new Map([['g1', { ...defaultChoice(group), fixSource: true }]]), texts);
    const first = plan.edits[0].operation as { sources: Record<string, unknown>; targets: Record<string, unknown> };
    expect(first.sources).toEqual({ 'a-3': text(`${SOURCE}？`) });
    // The kept translation is the same object, so applying keeps it current.
    expect(first.targets['a-3']).toBe(texts.get(cueKey('a', 'a-3'))!.target);
    // Kept under the spelling the source is unified to.
    expect(wordingsToKeep(result, new Map([['g1', { ...defaultChoice(group), fixSource: true, sourceStandard: MISHEARD }]]))).toEqual([{ source: MISHEARD, target: RIGHT }]);
  });

  it('uses a custom standard, skips cues it could not read, and limits documents', () => {
    const choice = { ...defaultChoice(group), standard: '泰姆菲尔德小姐' };
    const partial = new Map([...texts].filter(([key]) => !key.startsWith('b')));
    const plan = planConsistencyEdits(result, new Map([['g1', choice]]), partial);
    expect(plan.edits.map(edit => edit.document.documentId)).toEqual(['a']);
    expect((plan.edits[0].operation as { targets: Record<string, { plain: string }> }).targets['a-0'].plain).toBe('泰姆菲尔德小姐来了');
    expect(planConsistencyEdits(result, new Map([['g1', { ...choice, standard: '  ' }]]), texts).edits).toEqual([]);
    // A blank translation standard still lets an asked-for source fix through.
    expect(planConsistencyEdits(result, new Map([['g1', { ...choice, standard: '  ', fixSource: true }]]), texts).changedCues).toBe(1);
  });

  it('lists places no replacement can fix and the wordings to keep', () => {
    const knowledge: ConsistencyGroup = { id: 'g2', kind: 'knowledge', source: 'ホロウ', knowledgeTarget: '空洞', recommended: '空洞',
      spellings: [{ text: 'ホロウ', count: 3, occurrences: [place('a', 4), place('a', 5), place('b', 2)] }],
      variants: [{ text: '空洞', count: 1, occurrences: [place('a', 4)] }, { text: '', count: 2, occurrences: [place('a', 5), place('b', 2)] }] };
    expect(unfixablePlaces(knowledge).map(item => item.cueId)).toEqual(['a-5', 'b-2']);
    const withKnowledge = { ...result, groups: [group, knowledge] };
    expect(wordingsToKeep(withKnowledge, new Map([['g1', defaultChoice(group)], ['g2', defaultChoice(knowledge)]]))).toEqual([{ source: SOURCE, target: RIGHT }]);
    expect(wordingsToKeep(withKnowledge, new Map([['g1', { ...defaultChoice(group), keep: false }]]))).toEqual([]);
  });
});
