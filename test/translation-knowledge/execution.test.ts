import { describe, expect, it, vi } from 'vitest';
import { knowledgeFixture } from './fixtures';
import type { Entry } from '../../src/translation-knowledge/schemas';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { knowledgeSelectionSchema, type KnowledgeCue, type KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';
import { KNOWLEDGE_EXECUTION_LIMITS, checkRequiredTerms, compileKnowledge, resolveEnvironment, selectBatchKnowledge } from '../../src/translation-knowledge/execution';

type Term = Extract<Entry, { kind: 'term' }>;
type Rule = Extract<Entry, { kind: 'rule' }>;
type Context = Extract<Entry, { kind: 'context' }>;
const id = (number: number) => `90000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const example = knowledgeFixture();
const collectionId = example.collections[0].id;
const topicId = example.subjects[0].id;
const personId = example.subjects[1].id;
const secondPersonId = id(1000);
const pair = { source: 'en', target: 'zh-Hans' };
const cues: KnowledgeCue[] = [
  { id: 'cue-a', text: 'The checkpoint is here.', sourceLanguage: 'en' },
  { id: 'cue-b', text: 'Find the checkpoint.', sourceLanguage: 'en' },
];
const selection = (patch: Partial<KnowledgeSelection> = {}): KnowledgeSelection => ({
  version: 1, languagePair: { ...pair }, collectionIds: [collectionId],
  bindings: [], confirmations: [], disabledEntryIds: [], ...patch,
});
function term(number = 1, target = '存档点', strength: Term['payload']['strength'] = 'required'): Term {
  const template = structuredClone(example.entries.find(entry => entry.kind === 'term')!) as Term;
  return {
    ...template, id: id(number), state: 'ready', aboutSubjectIds: [],
    scope: { languagePair: { ...pair }, requiredSubjects: [], condition: { mode: 'none' } },
    payload: { ...template.payload, target, strength },
  };
}
function rule(number = 2, text = 'Use natural speech.', strength: Rule['payload']['strength'] = 'required'): Rule {
  return { ...term(number), kind: 'rule', payload: { dimension: 'register', text, strength } };
}
function context(number = 3, core = true): Context {
  return { ...term(number), kind: 'context', payload: { text: 'This game uses save points.', assertion: 'fact', core } };
}
function library(entries: Entry[] = [term()]): LibrarySnapshot {
  const data = knowledgeFixture();
  data.entries = entries;
  data.styles = [];
  data.recipes = [];
  data.subjects.push({ ...structuredClone(data.subjects[1]), id: secondPersonId, name: 'Another person' });
  const result = { generation: 7, data, approvals: {}, imports: [] } satisfies LibrarySnapshot;
  approve(result);
  return result;
}
function approve(snapshot: LibrarySnapshot): void {
  snapshot.approvals = Object.fromEntries(snapshot.data.entries.map(entry => [entry.id, {
    revision: entry.revision, digest: sha256Canonical(entry), method: 'human', approvedAt: '2026-09-14T00:00:00Z',
  }]));
}
const binding = (subjectId: string, role: KnowledgeSelection['bindings'][number]['role'], cueIds = cues.map(cue => cue.id)) => ({ subjectId, role, cueIds });

describe('knowledge environment resolution', () => {
  it('supports an empty selection and uses no saved knowledge implicitly', () => {
    const environment = resolveEnvironment(library(), selection({ collectionIds: [] }), cues);
    expect(environment.items).toEqual([]);
    expect(environment.issues).toEqual([]);
    expect(environment.instructions).toBe('');
    expect(environment.context).toBe('');
  });

  it.each(['absent', 'stale_revision', 'stale_digest', 'candidate', 'needs_review', 'rejected', 'archived'] as const)(
    'excludes %s local approval/state from trusted execution', mode => {
      const snapshot = library();
      const entry = snapshot.data.entries[0];
      if (mode === 'absent') delete snapshot.approvals[entry.id];
      else if (mode === 'stale_revision') snapshot.approvals[entry.id].revision++;
      else if (mode === 'stale_digest') snapshot.approvals[entry.id].digest = '0'.repeat(64);
      else { entry.state = mode; approve(snapshot); }
      const environment = resolveEnvironment(snapshot, selection(), cues);
      expect(environment.items).toEqual([]);
      expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'untrusted', entryIds: [entry.id] }));
    },
  );

  it('uses only explicitly selected collections and permits local approved content', () => {
    const other = term(2, '检查站');
    other.collectionId = id(2000);
    const snapshot = library([term(), other]);
    snapshot.data.collections.push({ ...structuredClone(snapshot.data.collections[0]), id: other.collectionId });
    const environment = resolveEnvironment(snapshot, selection(), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([id(1)]);
    expect(environment.items[0].digest).toBe(sha256Canonical(snapshot.data.entries[0]));
  });

  it('treats display-only subject associations as metadata rather than scope', () => {
    const entry = term();
    entry.aboutSubjectIds = [personId];
    const snapshot = library([entry]);
    snapshot.data.subjects.find(subject => subject.id === personId)!.archived = true;
    expect(resolveEnvironment(snapshot, selection(), cues).items).toHaveLength(1);
  });

  it('requires every subject role in the same cue and never widens a speaker scope', () => {
    const entry = term();
    entry.scope.requiredSubjects = [
      { subjectId: topicId, role: 'topic' }, { subjectId: personId, role: 'speaker' },
    ];
    const environment = resolveEnvironment(library([entry]), selection({ bindings: [
      binding(topicId, 'topic'), binding(personId, 'speaker', ['cue-a']), binding(personId, 'mentioned', ['cue-b']),
    ] }), cues);
    expect(environment.items[0].applicableCueIds).toEqual(['cue-a']);
    expect(environment.items[0].matches.map(match => match.cueId)).toEqual(['cue-a']);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'subject_unbound', cueIds: ['cue-b'] }));
  });

  it('allows present for a mentioned person without activating that person’s speaker rule', () => {
    const name = term();
    name.scope.requiredSubjects = [{ subjectId: personId, role: 'present' }];
    const voice = rule();
    voice.scope.requiredSubjects = [{ subjectId: personId, role: 'speaker' }];
    const environment = resolveEnvironment(library([name, voice]), selection({ bindings: [binding(personId, 'mentioned')] }), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([name.id]);
  });

  it('blocks overlapping confirmed speakers instead of choosing the last binding', () => {
    const voice = rule();
    voice.scope.requiredSubjects = [{ subjectId: personId, role: 'speaker' }];
    const environment = resolveEnvironment(library([voice]), selection({ bindings: [
      binding(personId, 'speaker'), binding(secondPersonId, 'speaker', ['cue-a']),
    ] }), cues);
    expect(environment.items[0].applicableCueIds).toEqual(['cue-b']);
    expect(environment.issues).toContainEqual({ code: 'speaker_conflict', severity: 'error', entryIds: [voice.id], cueIds: ['cue-a'] });
  });

  it('requires explicit cue-scoped confirmation and preserves advisory text as a reminder', () => {
    const required = term();
    required.scope.condition = { mode: 'requires_confirmation', text: 'The game is version 2.' };
    const advisory = context(2, false);
    advisory.scope.condition = { mode: 'advisory', text: 'The mode may matter.' };
    const environment = resolveEnvironment(library([required, advisory]), selection({
      confirmations: [{ entryId: required.id, cueIds: ['cue-a'] }],
    }), cues);
    expect(environment.items.find(item => item.entryId === required.id)?.applicableCueIds).toEqual(['cue-a']);
    expect(environment.items.find(item => item.entryId === advisory.id)?.condition).toBe('The mode may matter.');
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'condition_unconfirmed', entryIds: [required.id], cueIds: ['cue-b'] }));
  });

  it('rejects unknown cue confirmations and invalid speaker subject kinds', () => {
    const entry = term();
    entry.scope.condition = { mode: 'requires_confirmation', text: 'Confirm this mode.' };
    const environment = resolveEnvironment(library([entry]), selection({
      confirmations: [{ entryId: entry.id, cueIds: ['unknown-cue'] }],
      bindings: [binding(topicId, 'speaker')],
    }), cues);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'selection_invalid', severity: 'error' }));
    const invalidConfirmation = resolveEnvironment(library([entry]), selection({
      confirmations: [{ entryId: entry.id, cueIds: ['unknown-cue'] }],
    }), cues);
    const invalidSpeaker = resolveEnvironment(library([entry]), selection({ bindings: [binding(topicId, 'speaker')] }), cues);
    for (const result of [invalidConfirmation, invalidSpeaker]) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'selection_invalid', severity: 'error' }));
    }
  });

  it('keeps global configuration errors visible when batching another cue', () => {
    const entry = term();
    entry.scope.condition = { mode: 'requires_confirmation', text: 'Confirm this mode.' };
    const environment = resolveEnvironment(library([entry]), selection({
      confirmations: [{ entryId: entry.id, cueIds: ['unknown-cue'] }],
      bindings: [binding(topicId, 'speaker', ['cue-a'])],
    }), cues);
    expect(selectBatchKnowledge(environment, ['cue-b']).issues)
      .toContainEqual(expect.objectContaining({ code: 'selection_invalid', severity: 'error' }));
  });

  it.each(['zh', 'ZH', 'auto', 'und', 'mul', 'zh-hans', 'zh-CN', 'zh-TW', 'zh-SG', 'zh-Latn', 'zh-u-ca-chinese', 'und-Latn', 'mul-Latn', 'auto-US'])('requires explicit canonical language labels instead of %s', language => {
    expect(knowledgeSelectionSchema.safeParse(selection({ languagePair: { source: 'en', target: language } })).success).toBe(false);
    expect(knowledgeSelectionSchema.safeParse(selection({ languagePair: { source: language, target: 'en' } })).success).toBe(false);
  });

  it.each(['zh-Hans', 'zh-Hant', 'zh-Hans-CN', 'zh-Hant-TW', 'en-US', 'ja'])('accepts the explicit canonical language label %s', language => {
    expect(knowledgeSelectionSchema.safeParse(selection({ languagePair: { source: 'en', target: language } })).success).toBe(true);
    expect(knowledgeSelectionSchema.safeParse(selection({ languagePair: { source: language, target: 'en' } })).success).toBe(true);
  });

  it('does not reverse language pairs, cross Chinese variants or apply English knowledge to another cue language', () => {
    const right = term();
    const traditional = term(2);
    traditional.scope.languagePair.target = 'zh-Hant';
    const reverse = term(3);
    reverse.scope.languagePair = { source: 'zh-Hans', target: 'en' };
    const multilingual = [cues[0], { ...cues[1], sourceLanguage: 'ja' }];
    const environment = resolveEnvironment(library([right, traditional, reverse]), selection(), multilingual);
    expect(environment.items.map(item => item.entryId)).toEqual([right.id]);
    expect(environment.items[0].applicableCueIds).toEqual(['cue-a']);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'language_mismatch', entryIds: [right.id], cueIds: ['cue-b'] }));
  });

  it('does not materialize recipe subject suggestions as facts or silently apply global preferences', () => {
    const entry = term();
    entry.scope.requiredSubjects = [{ subjectId: topicId, role: 'topic' }];
    const snapshot = library([entry]);
    const recipe = structuredClone(example.recipes[0]);
    delete recipe.baseStyleId;
    recipe.instructions = 'Recipe instructions.';
    recipe.context = 'Recipe context.';
    snapshot.data.recipes.push(recipe);
    const environment = resolveEnvironment(snapshot, selection({ collectionIds: [], recipeId: recipe.id }), cues);
    expect(environment.items).toEqual([]);
    expect(environment.instructions).toBe(recipe.instructions);
    expect(environment.context).toBe(recipe.context);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'preferences_not_applied' }));
    const overridden = resolveEnvironment(snapshot, selection({ recipeId: recipe.id, instructions: '', context: 'Current context.' }), cues);
    expect(overridden.instructions).toBe('');
    expect(overridden.context).toBe('Current context.');
  });

  it('reports unsupported expression and memory records without dropping them from the library', () => {
    const entries = structuredClone(example.entries.filter(entry => entry.kind === 'expression' || entry.kind === 'memory'));
    for (const entry of entries) entry.state = 'ready';
    const snapshot = library(entries);
    const before = structuredClone(snapshot);
    const environment = resolveEnvironment(snapshot, selection(), cues);
    expect(environment.items).toEqual([]);
    expect(environment.issues.filter(issue => issue.code === 'unsupported_kind').map(issue => issue.entryIds[0]).sort())
      .toEqual(entries.map(entry => entry.id).sort());
    expect(snapshot).toEqual(before);
  });

  it('blocks archived or missing selected resources and incomplete evidence', () => {
    const snapshot = library();
    snapshot.data.collections[0].archived = true;
    expect(resolveEnvironment(snapshot, selection(), cues).issues).toContainEqual(expect.objectContaining({ code: 'resource_archived', severity: 'error' }));
    snapshot.data.collections[0].archived = false;
    snapshot.data.sources = [];
    const environment = resolveEnvironment(snapshot, selection(), cues);
    expect(environment.items).toEqual([]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'resource_missing', severity: 'error' }));
    expect(resolveEnvironment(library(), selection({ collectionIds: [id(2222)] }), cues).issues)
      .toContainEqual(expect.objectContaining({ code: 'resource_missing', severity: 'error' }));
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
    const entries = Array.from({ length: 110 }, (_, index) => rule(index + 1, `Different required instruction ${index}.`));
    const environment = resolveEnvironment(library(entries), selection(), cues);
    expect(environment.items).toEqual([]);
    expect(environment.issues.length).toBeLessThanOrEqual(KNOWLEDGE_EXECUTION_LIMITS.diagnostics + 1);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'resource_limit', severity: 'error' }));
  });

  it('blocks competing required translations only where their source matches and scopes overlap', () => {
    const first = term(1, '存档点');
    const second = term(2, '检查站');
    second.scope.requiredSubjects = [{ subjectId: personId, role: 'speaker' }];
    const environment = resolveEnvironment(library([second, first]), selection({ bindings: [binding(personId, 'speaker', ['cue-a'])] }), cues);
    expect(environment.issues).toContainEqual({ code: 'term_conflict', severity: 'error', entryIds: [first.id, second.id], cueIds: ['cue-a'] });
    expect(selectBatchKnowledge(environment, ['cue-b']).issues.some(issue => issue.code === 'term_conflict')).toBe(false);
  });

  it('keeps long and short overlapping required matches for conflict detection', () => {
    const first = term(1, '月亮');
    first.payload.source = 'moon';
    first.payload.match.mode = 'literal_phrase';
    const second = term(2, '太空基地');
    second.payload.source = 'moonbase';
    const environment = resolveEnvironment(library([first, second]), selection(), [{ id: 'cue-a', text: 'moonbase', sourceLanguage: 'en' }]);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'term_conflict', severity: 'error' }));
    expect(environment.items.map(item => item.matches[0].text)).toEqual(['moon', 'moonbase']);
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
    approve(snapshot);
    const environment = resolveEnvironment(snapshot, selection({ disabledEntryIds: [second.id] }), cues);
    expect(environment.items.map(item => item.entryId)).toEqual([id(1)]);
    expect(environment.issues.some(issue => issue.code === 'term_conflict')).toBe(false);
  });

  it('reports same-dimension incompatible required rules and omits optional rule conflicts', () => {
    const environment = resolveEnvironment(library([rule(1, 'Speak formally.'), rule(2, 'Use slang.')]), selection(), cues);
    expect(environment.issues).toContainEqual(expect.objectContaining({ code: 'rule_conflict', severity: 'error' }));
    const optional = resolveEnvironment(library([rule(1, 'Speak formally.', 'preferred'), rule(2, 'Use slang.', 'preferred')]), selection(), cues);
    expect(optional.items).toEqual([]);
    expect(optional.issues).toContainEqual(expect.objectContaining({ code: 'rule_conflict', severity: 'warning' }));
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

  it('keeps required terms, required rules and core context when optional budget is zero', () => {
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
    snapshot.data.sources[0].excerpt = 'Changed evidence';
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
    batch.required[0].evidence[0].excerpt = 'Edited evidence';
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
