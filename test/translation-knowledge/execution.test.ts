import { describe, expect, it, vi } from 'vitest';
import { knowledgeFixture } from './fixtures';
import type { Entry, TermEntry } from '../../src/translation-knowledge/schemas';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { knowledgeSelectionSchema, type KnowledgeCue, type KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';
import { KNOWLEDGE_EXECUTION_LIMITS, KNOWLEDGE_EXECUTION_POLICY, checkRequiredTerms, compileKnowledge, resolveEnvironment, selectBatchKnowledge } from '../../src/translation-knowledge/execution';

type Term = TermEntry;
const id = (number: number) => `90000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const example = knowledgeFixture();
const [game, common, archived] = example.collections;
const collectionId = game.id;
const pair = { source: 'en', target: 'zh-Hans' };
const cues: KnowledgeCue[] = [
  { id: 'cue-a', text: 'The checkpoint is here.', sourceLanguage: 'en' },
  { id: 'cue-b', text: 'Find the checkpoint.', sourceLanguage: 'en' },
];
const selection = (patch: Partial<KnowledgeSelection> = {}): KnowledgeSelection => ({
  version: 2, languagePair: { ...pair }, collectionIds: [collectionId], disabledEntryIds: [], ...patch,
});
function term(number = 1, target = '存档点', strength: Term['payload']['strength'] = 'required'): Term {
  return { id: id(number), revision: 1, collectionId, enabled: true, kind: 'term',
    payload: { source: 'checkpoint', target, aliases: [], note: '', strength, match: { mode: 'whole_term', caseSensitive: false } } };
}
function rule(number = 2, text = 'Use natural speech.', required = true): Entry {
  return { id: id(number), revision: 1, collectionId, enabled: true, kind: 'rule', payload: { text, required } };
}
function context(number = 3, required = true): Entry {
  return { id: id(number), revision: 1, collectionId, enabled: true, kind: 'context', payload: { text: 'This game uses save points.', required } };
}
function library(entries: Entry[] = [term()]): LibrarySnapshot {
  const data = knowledgeFixture();
  data.entries = entries;
  return { generation: 7, data };
}

describe('knowledge environment resolution', () => {
  it('supports an empty selection and uses no saved knowledge implicitly', () => {
    const environment = resolveEnvironment(library([term(), rule(), context()]), selection({ collectionIds: [] }), cues);
    expect(environment).toMatchObject({ policyVersion: KNOWLEDGE_EXECUTION_POLICY, generation: 7, items: [], issues: [], collections: [], instructions: '', context: '' });
    expect(knowledgeSelectionSchema.safeParse({ ...selection(), bindings: [] }).success).toBe(false);
    expect(knowledgeSelectionSchema.safeParse({ ...selection(), recipeId: id(9) }).success).toBe(false);
    expect(knowledgeSelectionSchema.safeParse({ ...selection(), version: 1 }).success).toBe(false);
  });

  it('includes enabled, matching entries of the selected collections and skips disabled ones silently', () => {
    const disabled = { ...rule(4, 'Hidden rule.'), enabled: false };
    const other: Entry = { ...term(5, '首领'), collectionId: common.id, payload: { ...term().payload, source: 'boss', target: '首领' } };
    const environment = resolveEnvironment(library([term(1), rule(2), context(3, false), disabled, other]), selection({ instructions: 'Be brief.', context: 'A game.' }), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([id(1), id(2), id(3)]);
    expect(environment.items.find(item => item.entryId === id(3))!.required).toBe(false);
    expect(environment.issues).toEqual([]);
    expect(environment.collections).toEqual([{ id: game.id, name: game.name }]);
    expect(environment).toMatchObject({ instructions: 'Be brief.', context: 'A game.' });
  });

  it('reports entries excluded for this run and unknown exclusions', () => {
    const environment = resolveEnvironment(library([term(1), rule(2)]), selection({ disabledEntryIds: [id(2)] }), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([id(1)]);
    expect(environment.issues).toEqual([{ code: 'disabled', severity: 'warning', entryIds: [id(2)], cueIds: [] }]);
    expect(resolveEnvironment(library(), selection({ disabledEntryIds: [id(99)] }), cues).issues)
      .toContainEqual({ code: 'selection_invalid', severity: 'error', entryIds: [id(99)], cueIds: [] });
  });

  it('applies terms only where they match the cue text', () => {
    const absent: Entry = { ...term(2), payload: { ...term().payload, source: 'absent' } };
    const environment = resolveEnvironment(library([term(1), absent]), selection(), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([id(1)]);
    expect(environment.items[0].applicableCueIds).toEqual(['cue-a', 'cue-b']);
    expect(environment.issues).toContainEqual({ code: 'no_match', severity: 'warning', entryIds: [id(2)], cueIds: ['cue-a', 'cue-b'] });
  });

  it('blocks missing, archived and wrong-direction collections and other-language cues', () => {
    const missing = resolveEnvironment(library(), selection({ collectionIds: [id(50)] }), cues);
    expect(missing.issues).toContainEqual(expect.objectContaining({ code: 'resource_missing', severity: 'error' }));
    const archivedResult = resolveEnvironment(library([{ ...term(), collectionId: archived.id }]), selection({ collectionIds: [archived.id] }), cues);
    expect(archivedResult.items).toEqual([]);
    expect(archivedResult.issues).toContainEqual(expect.objectContaining({ code: 'resource_archived', severity: 'error' }));
    const reversed = resolveEnvironment(library(), selection({ languagePair: { source: 'zh-Hans', target: 'en' } }), cues.map(cue => ({ ...cue, sourceLanguage: 'zh-Hans' })));
    expect(reversed.items).toEqual([]);
    expect(reversed.issues).toContainEqual(expect.objectContaining({ code: 'language_mismatch', severity: 'error' }));
    const otherCue = resolveEnvironment(library(), selection(), [cues[0], { ...cues[1], sourceLanguage: 'ja' }]);
    expect(otherCue.items[0].applicableCueIds).toEqual(['cue-a']);
    expect(otherCue.issues).toContainEqual({ code: 'language_mismatch', severity: 'error', entryIds: [], cueIds: ['cue-b'] });
  });

  it('keeps global configuration errors visible when batching another cue', () => {
    const environment = resolveEnvironment(library(), selection({ collectionIds: [collectionId, id(50)] }), cues);
    const batch = selectBatchKnowledge(environment, ['cue-b']);
    expect(batch.issues).toContainEqual(expect.objectContaining({ code: 'resource_missing', severity: 'error', cueIds: [] }));
  });

  it('carries entry origins to the model input', () => {
    const sourced: Entry = { ...term(), origin: { kind: 'web', url: 'https://example.com/a', title: 'Example' } };
    expect(resolveEnvironment(library([sourced]), selection(), cues).items[0].origin).toEqual(sourced.origin);
  });
});

describe('knowledge conflict and compilation semantics', () => {
  it('blocks excessive dense matches before exposing a partially checked required environment', () => {
    const dense = term(2);
    dense.payload.source = 'a'; dense.payload.match.mode = 'literal_phrase';
    const environment = resolveEnvironment(library([context(1), dense]), selection(), [
      { id: 'cue-a', text: 'a'.repeat(KNOWLEDGE_EXECUTION_LIMITS.matches + 1), sourceLanguage: 'en' },
      { id: 'cue-b', text: 'unrelated', sourceLanguage: 'en' },
    ]);
    expect(environment.items).toEqual([]);
    expect(environment.issues).toContainEqual({ code: 'resource_limit', severity: 'error', entryIds: [dense.id], cueIds: [] });
    expect(compileKnowledge(selectBatchKnowledge(environment, ['cue-b'])).issues)
      .toContainEqual(expect.objectContaining({ code: 'resource_limit', severity: 'error' }));
  });

  it('permits the exact match limit and deduplicates overlapping alias results before charging it', () => {
    const dense = term(); dense.payload.source = 'a'; dense.payload.match.mode = 'literal_phrase';
    dense.payload.aliases = ['A', 'a'];
    const environment = resolveEnvironment(library([dense]), selection(), [{ id: 'cue-a', text: 'a'.repeat(KNOWLEDGE_EXECUTION_LIMITS.matches), sourceLanguage: 'en' }]);
    expect(environment.issues.some(issue => issue.code === 'resource_limit')).toBe(false);
    expect(environment.items[0].matches).toHaveLength(KNOWLEDGE_EXECUTION_LIMITS.matches);
  });

  it('bounds cumulative input scanning even when every alias produces zero matches', () => {
    const entry = term(); entry.payload.source = 'absent0';
    entry.payload.aliases = Array.from({ length: KNOWLEDGE_EXECUTION_LIMITS.termVariants - 1 }, (_, index) => `absent${index + 1}`);
    const environment = resolveEnvironment(library([entry]), selection(), [{ id: 'cue-a', text: 'x'.repeat(65536), sourceLanguage: 'en' }]);
    expect(environment.items).toEqual([]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'resource_limit', severity: 'error' }));
  });

  it('blocks an oversized alias set before hashing or matching it as trusted content', () => {
    const entry = term(); entry.payload.aliases = Array.from({ length: KNOWLEDGE_EXECUTION_LIMITS.termVariants }, (_, index) => `alias${index}`);
    const environment = resolveEnvironment(library([entry]), selection(), cues);
    expect(environment.items).toEqual([]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'resource_limit', severity: 'error' }));
  });

  it('bounds dense non-overlapping term comparisons instead of completing a quadratic scan', () => {
    const first = term(1), second = term(2);
    first.payload.source = 'a'; second.payload.source = 'b';
    first.payload.match.mode = second.payload.match.mode = 'literal_phrase';
    const repetitions = Math.ceil(Math.sqrt(KNOWLEDGE_EXECUTION_LIMITS.conflictComparisons));
    const environment = resolveEnvironment(library([first, second]), selection(), [{ id: 'cue-a', text: `${'a'.repeat(repetitions)} ${'b'.repeat(repetitions)}`, sourceLanguage: 'en' }]);
    expect(environment.items).toEqual([]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'resource_limit', severity: 'error' }));
    expect(environment.issues.some(issue => issue.code === 'term_conflict')).toBe(false);
  });

  it('bounds conflict diagnostic accumulation before building a large preview', () => {
    const entries = Array.from({ length: 110 }, (_, index) => term(index + 1, `Different required target ${index}.`));
    const environment = resolveEnvironment(library(entries), selection(), cues);
    expect(environment.items).toEqual([]);
    expect(environment.issues.length).toBeLessThanOrEqual(KNOWLEDGE_EXECUTION_LIMITS.diagnostics + 1);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'resource_limit', severity: 'error' }));
  });

  it('blocks competing required translations only where their matches overlap', () => {
    const first = term(1, '存档点');
    const second = term(2, '检查站');
    // Partly overlapping ("point is" crosses the end of "checkpoint"); a match nested inside a longer one is not a conflict.
    second.payload.source = 'point is'; second.payload.match.mode = 'literal_phrase';
    const environment = resolveEnvironment(library([second, first]), selection(), cues);
    expect(environment.issues).toContainEqual({ code: 'term_conflict', severity: 'error', entryIds: [first.id, second.id], cueIds: ['cue-a'] });
    expect(selectBatchKnowledge(environment, ['cue-b']).issues.some(issue => issue.code === 'term_conflict')).toBe(false);
  });

  it('gives a match inside a longer term to the longer term, without a conflict', () => {
    const first = term(1, '月亮');
    first.payload.source = 'moon';
    first.payload.match.mode = 'literal_phrase';
    const second = term(2, '太空基地');
    second.payload.source = 'moonbase';
    const environment = resolveEnvironment(library([first, second]), selection(), [{ id: 'cue-a', text: 'moonbase', sourceLanguage: 'en' }]);
    expect(environment.issues.some(issue => issue.code === 'term_conflict')).toBe(false);
    expect(environment.items.map(item => [item.entryId, item.matches.map(match => match.text)])).toEqual([[second.id, ['moonbase']]]);
    // The shorter term still applies where it also stands on its own, and only there.
    const both = resolveEnvironment(library([first, second]), selection(), [
      { id: 'cue-a', text: 'moonbase under the moon', sourceLanguage: 'en' }, { id: 'cue-b', text: 'moonbase', sourceLanguage: 'en' }]);
    const short = both.items.find(item => item.entryId === first.id)!;
    expect(short.applicableCueIds).toEqual(['cue-a']);
    expect(short.matches.map(match => [match.start, match.text])).toEqual([[19, 'moon']]);
    expect(both.items.find(item => item.entryId === second.id)!.applicableCueIds).toEqual(['cue-a', 'cue-b']);
  });

  it('still treats partly overlapping terms with different translations as a conflict', () => {
    const first = term(1, '月亮基地');
    first.payload.source = 'moonbase';
    first.payload.match.mode = 'literal_phrase';
    const second = term(2, '基地营');
    second.payload.source = 'basecamp';
    second.payload.match.mode = 'literal_phrase';
    const environment = resolveEnvironment(library([first, second]), selection(), [{ id: 'cue-a', text: 'moonbasecamp', sourceLanguage: 'en' }]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'term_conflict', severity: 'error', cueIds: ['cue-a'] }));
  });

  it('removes both incompatible optional mappings from the overlapping scope', () => {
    const first = term(1, '存档点', 'preferred');
    const second = term(2, '检查站', 'preferred');
    const environment = resolveEnvironment(library([first, second]), selection(), cues);
    expect(environment.items).toEqual([]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'term_conflict', severity: 'warning' }));
  });

  it('retains required terminology over an incompatible preferred mapping and warns', () => {
    const first = term(1, '存档点', 'required');
    const second = term(2, '检查站', 'preferred');
    const environment = resolveEnvironment(library([first, second]), selection(), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([first.id]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'term_conflict', severity: 'warning' }));
  });

  it('allows identical required targets and explicit per-plan exclusion', () => {
    const snapshot = library([term(1), term(2)]);
    expect(resolveEnvironment(snapshot, selection(), cues).issues.some(issue => issue.code === 'term_conflict')).toBe(false);
    const second = snapshot.data.entries[1] as Term;
    second.payload.target = '检查站';
    const environment = resolveEnvironment(snapshot, selection({ disabledEntryIds: [second.id] }), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([id(1)]);
    expect(environment.issues.some(issue => issue.code === 'term_conflict')).toBe(false);
  });

  it.each([
    ['required', 'required'], ['preferred', 'preferred'], ['required', 'preferred'],
  ] as const)('includes %s/%s requirements together without inferring conflicts from free text', (left, right) => {
    const entries = [rule(1, 'Speak formally.', left === 'required'), rule(2, 'Use slang.', right === 'required')];
    const environment = resolveEnvironment(library(entries), selection(), cues);
    expect(environment.policyVersion).toBe(KNOWLEDGE_EXECUTION_POLICY);
    expect(environment.issues).toEqual([]);
    const compiled = compileKnowledge(selectBatchKnowledge(environment, ['cue-a']));
    expect(compiled.items.map(item => item.entryId).sort()).toEqual(entries.map(entry => entry.id));
    expect(compiled.items.every(item => item.applicableCueIds.length === 1 && item.applicableCueIds[0] === 'cue-a')).toBe(true);
  });

  it('preserves the actual original spelling for keep-source hits and reports only applicable output doubts', () => {
    const preserve = term(1, 'ignored configured target', 'keep_source');
    const environment = resolveEnvironment(library([preserve]), selection(), [{ id: 'cue-a', text: 'CHECKPOINT checkpoint', sourceLanguage: 'en' }]);
    expect(environment.items[0].matches.map(match => match.target)).toEqual(['CHECKPOINT', 'checkpoint']);
    const compiled = compileKnowledge(selectBatchKnowledge(environment, ['cue-a']));
    expect(checkRequiredTerms(compiled, [{ cueId: 'cue-a', text: 'CHECKPOINT checkpoint' }])).toEqual([]);
    expect(checkRequiredTerms(compiled, [{ cueId: 'unrelated', text: 'bad translation' }])).toEqual([]);
    const outputs = [{ cueId: 'cue-a', text: '存档点' }];
    expect(checkRequiredTerms(compiled, outputs)).toEqual([{ code: 'required_term_suspect', severity: 'warning', entryIds: [preserve.id], cueIds: ['cue-a'] }]);
    expect(outputs[0].text).toBe('存档点');
  });

  it('deduplicates equivalent alias hits and preserves NFC match coordinates', () => {
    const entry = term();
    entry.payload.source = 'Café';
    entry.payload.aliases = ['CAFÉ', 'Cafe\u0301'];
    const environment = resolveEnvironment(library([entry]), selection(), [{ id: 'cue-a', text: '😀 Cafe\u0301', sourceLanguage: 'en' }]);
    expect(environment.items[0].matches).toEqual([{ cueId: 'cue-a', start: 3, end: 7, text: 'Café', target: '存档点' }]);
  });

  it('freezes required target conflict and output checks to the same NFC policy as matching', () => {
    const entries = [term(1, 'Café\u0378'), term(2, 'Cafe\u0301\u0378')];
    const nativeNormalize = String.prototype.normalize;
    const normalize = vi.spyOn(String.prototype, 'normalize').mockImplementation(function (this: string, form?: string) {
      if (String(this).includes('\u0378')) throw new Error('Future normalization behavior');
      return nativeNormalize.call(this, form);
    });
    try {
      const environment = resolveEnvironment(library(entries), selection(), cues);
      expect(environment.issues.some(issue => issue.code === 'term_conflict')).toBe(false);
      const compiled = compileKnowledge(selectBatchKnowledge(environment, ['cue-a']));
      expect(checkRequiredTerms(compiled, [{ cueId: 'cue-a', text: 'Café\u0378' }])).toEqual([]);
    } finally {
      normalize.mockRestore();
    }
  });

  it('keeps required terms and required notes when optional budget is zero', () => {
    const entries = [term(1), rule(2), context(3), term(4, '存档点', 'preferred'), context(5, false)];
    const environment = resolveEnvironment(library(entries), selection(), cues);
    const batch = selectBatchKnowledge(environment, ['cue-a']);
    const compiled = compileKnowledge(batch, 0);
    expect(compiled.items.map(item => item.entryId)).toEqual([id(1), id(2), id(3)]);
    expect(compiled.issues.filter(issue => issue.code === 'budget_excluded').map(issue => issue.entryIds[0]))
      .toEqual([id(4), id(5)]);
    expect(compiled.items.every(item => item.applicableCueIds.join() === 'cue-a')).toBe(true);
    expect(() => compileKnowledge(batch, -1)).toThrow();
    expect(() => compileKnowledge(batch, batch.optional.length + 1)).toThrow();
    expect(() => compileKnowledge(batch, 0.5)).toThrow();
  });

  it('retains a stable environment after library and selection changes', () => {
    const snapshot = library();
    const input = selection({ context: 'Original context.' });
    const inputCues = structuredClone(cues);
    const environment = resolveEnvironment(snapshot, input, inputCues);
    const before = structuredClone(environment);
    (snapshot.data.entries[0] as Term).payload.target = 'New target';
    snapshot.generation++;
    input.context = 'Changed context';
    inputCues[0].text = 'Changed source';
    expect(environment).toEqual(before);
    expect(resolveEnvironment(library(), selection({ context: 'Original context.' }), cues).digest).toBe(environment.digest);
  });

  it('isolates batch matches from the immutable resolved environment', () => {
    const environment = resolveEnvironment(library(), selection(), cues);
    const before = structuredClone(environment);
    const batch = selectBatchKnowledge(environment, ['cue-a']);
    batch.required[0].matches[0].target = 'Edited batch';
    expect(environment).toEqual(before);
  });

  it('isolates compiled diagnostics and items from the selected batch', () => {
    const environment = resolveEnvironment(library([term(1), context(2, false)]), selection(), cues);
    const batch = selectBatchKnowledge(environment, ['cue-a']);
    const before = structuredClone(batch);
    const compiled = compileKnowledge(batch, 0);
    compiled.items[0].matches[0].target = 'Edited compiled target';
    compiled.issues.find(issue => issue.code === 'budget_excluded')!.cueIds.push('outside');
    expect(batch).toEqual(before);
  });

  it('rejects duplicate or unknown batch cue IDs', () => {
    const environment = resolveEnvironment(library(), selection(), cues);
    expect(() => selectBatchKnowledge(environment, [])).toThrow();
    expect(() => selectBatchKnowledge(environment, ['cue-a', 'cue-a'])).toThrow();
    expect(() => selectBatchKnowledge(environment, ['unknown'])).toThrow();
  });
});
