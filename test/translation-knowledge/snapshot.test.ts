import { describe, expect, it } from 'vitest';
import { knowledgeFixture } from './fixtures';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import { compileKnowledge, resolveEnvironment, selectBatchKnowledge } from '../../src/translation-knowledge/execution';
import { buildFrozenKnowledgeSnapshot, knowledgeResourceReferences, validateFrozenKnowledgeSnapshot, type FrozenKnowledgeSnapshot } from '../../src/translation-knowledge/snapshot-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { KnowledgeSelection } from '../../src/translation-knowledge/execution-contract';

const cueId = '90000000-0000-4000-8000-000000000001';
const unrelated = '90000000-0000-4000-8000-000000000002';
function fixture() {
  const data = knowledgeFixture();
  const term = data.entries.find(entry => entry.kind === 'term')!;
  term.scope = { languagePair: { source: 'en', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } };
  term.state = 'ready';
  const library: LibrarySnapshot = { generation: 7, data, imports: [], approvals: { [term.id]: { revision: term.revision, digest: sha256Canonical(term), method: 'human', approvedAt: '2026-09-14T00:00:00Z' } } };
  const selection: KnowledgeSelection = { version: 1, languagePair: term.scope.languagePair, collectionIds: [term.collectionId], bindings: [], confirmations: [], disabledEntryIds: [] };
  return { library, selection, term };
}
function capture({ library, selection }: ReturnType<typeof fixture>) {
  const environment = resolveEnvironment(library, selection, [{ id: cueId, text: 'We reached the checkpoint.', sourceLanguage: 'en' }]);
  return buildFrozenKnowledgeSnapshot(library, selection, [], { b1: compileKnowledge(selectBatchKnowledge(environment, [cueId])) });
}
function rehash(snapshot: FrozenKnowledgeSnapshot) {
  const { digest: _digest, ...base } = snapshot;
  snapshot.digest = sha256Canonical(base);
  return snapshot;
}
describe('frozen execution knowledge', () => {
  it('captures excluded candidates and full provenance, preserves entity metadata and isolates later library edits', () => {
    const input = fixture();
    input.library.data.collections.push({ ...input.library.data.collections[0], id: unrelated, name: 'Unrelated' });
    input.library.data.extensions = { 'example.private': { unrelated: true } };
    const snapshot = capture(input);
    expect(snapshot.data.entries).toEqual(input.library.data.entries);
    expect(snapshot.data.sources).toEqual(input.library.data.sources);
    expect(snapshot.data.collections.some(item => item.id === unrelated)).toBe(false);
    expect(snapshot.data.preferenceTemplates).toEqual([]);
    expect(snapshot.data.extensions).toBeUndefined();
    expect(snapshot.data.package).toEqual(input.library.data.package);
    expect(snapshot.batches.b1.items.map(item => item.entryId)).toEqual([input.term.id]);
    expect(snapshot.batches.b1.issues.length).toBeGreaterThan(0);
    const digest = snapshot.digest;
    input.term.title = 'Changed later'; input.library.approvals = {};
    expect(validateFrozenKnowledgeSnapshot(snapshot).digest).toBe(digest);
    expect(snapshot.data.entries.find(item => item.id === input.term.id)?.title).not.toBe('Changed later');
    expect(knowledgeResourceReferences(snapshot)).toContainEqual({ group: 'entries', id: input.term.id, revision: input.term.revision, digest: snapshot.approvals[input.term.id].digest });
  });
  it('keeps recipe styles, destination metadata and suggested subjects without adopting suggestions', () => {
    const input = fixture(); input.selection.recipeId = input.library.data.recipes[0].id;
    const snapshot = capture(input);
    expect(snapshot.data.recipes).toEqual(input.library.data.recipes);
    expect(snapshot.data.styles).toEqual(input.library.data.styles);
    expect(snapshot.selection.bindings).toEqual([]);
    expect(snapshot.documentTopicIds).toEqual([]);
    expect(validateFrozenKnowledgeSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });
  it.each(['entry', 'payload', 'evidence', 'approval', 'revision', 'condition', 'required', 'unknown_cue', 'policy'] as const)('rejects inconsistent %s even with a recomputed container digest', field => {
    const input = fixture(), snapshot = capture(input), item = snapshot.batches.b1.items[0];
    if (field === 'entry') snapshot.data.entries.find(entry => entry.id === item.entryId)!.title = 'tampered';
    if (field === 'payload') item.payload = { text: 'Invented', assertion: 'fact', core: true };
    if (field === 'evidence') item.evidence[0].excerpt = 'Invented source';
    if (field === 'approval') delete snapshot.approvals[item.entryId];
    if (field === 'revision') item.revision++;
    if (field === 'condition') item.condition = 'Invented condition';
    if (field === 'required') item.required = !item.required;
    if (field === 'unknown_cue') item.matches[0].cueId = unrelated;
    if (field === 'policy') snapshot.batches.b1.policyVersion = 'unknown';
    expect(() => validateFrozenKnowledgeSnapshot(rehash(snapshot))).toThrow();
  });
  it('rejects omitted dependency bodies and unknown structure without rebuilding from the live library', () => {
    const snapshot = capture(fixture()); snapshot.data.sources = [];
    expect(() => validateFrozenKnowledgeSnapshot(rehash(snapshot))).toThrow();
    expect(() => validateFrozenKnowledgeSnapshot({ ...capture(fixture()), apiKey: 'secret' })).toThrow();
  });
  it.each(['disabled', 'language', 'collection', 'subject', 'confirmation', 'instructions', 'context', 'match_target'] as const)('rejects a compiled selection contradiction: %s', field => {
    const input = fixture(), snapshot = capture(input), item = snapshot.batches.b1.items[0];
    const entry = snapshot.data.entries.find(entry => entry.id === item.entryId)!;
    if (field === 'disabled') snapshot.selection.disabledEntryIds.push(entry.id);
    if (field === 'language') snapshot.selection.languagePair.target = 'ja';
    if (field === 'collection') snapshot.selection.collectionIds = [];
    if (field === 'subject') entry.scope.requiredSubjects = [{ subjectId: snapshot.data.subjects[0].id, role: 'speaker' }];
    if (field === 'confirmation') { entry.scope.condition = { mode: 'requires_confirmation', text: 'Confirm this' }; item.condition = 'Confirm this'; }
    if (field === 'instructions') snapshot.batches.b1.instructions = 'Invented requirements';
    if (field === 'context') snapshot.batches.b1.context = 'Invented background';
    if (field === 'match_target') item.matches[0].target = 'Invented target';
    item.digest = sha256Canonical(entry); snapshot.approvals[entry.id].digest = item.digest;
    expect(() => validateFrozenKnowledgeSnapshot(rehash(snapshot))).toThrow();
  });
});
