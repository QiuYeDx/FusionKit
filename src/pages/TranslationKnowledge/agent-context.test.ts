import { describe, expect, it } from 'vitest';
import type { Entry } from '@/translation-knowledge/schemas';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { newerSnapshot } from '@/translation-knowledge/library-events';
import { focusedCollection, knowledgePageContext, knowledgeSnapshot, type KnowledgePageState } from './agent-context';

const pair = { source: 'ja', target: 'zh-Hans' };
const collectionId = '20000000-0000-4000-8000-000000000001';
const archivedId = '20000000-0000-4000-8000-000000000002';
const sourceId = '20000000-0000-4000-8000-000000000003';
function term(index: number, state: Entry['state'] = 'ready'): Entry {
  return { id: `20000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`, revision: 2, title: `語${index}`, kind: 'term', collectionId, aboutSubjectIds: [], state,
    scope: { languagePair: pair, requiredSubjects: [], condition: { mode: 'none' } }, evidence: [{ sourceId, support: 'direct' }], derivedFrom: [],
    payload: { source: `語${index}`, target: `词${index}`, aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' } };
}
const entries = Array.from({ length: 25 }, (_, index) => term(index, index === 0 ? 'candidate' : 'ready'));
const snapshot = { generation: 7, approvals: Object.fromEntries(entries.slice(2).map(entry => [entry.id, { revision: 2, digest: 'x', method: 'human', approvedAt: '' }])), imports: [],
  data: { collections: [
    { id: collectionId, revision: 1, archived: false, name: '绝区零 · 人物与称谓', description: '', aboutSubjectIds: [], defaultLanguagePair: pair },
    { id: archivedId, revision: 1, archived: true, name: 'Old', description: '', aboutSubjectIds: [] },
  ], entries, sources: [{ id: sourceId, revision: 1, kind: 'web', title: 'Secret page', excerpt: 'private excerpt', url: 'https://example.invalid/private' }], subjects: [], styles: [], recipes: [], preferenceTemplates: [] },
} as unknown as LibrarySnapshot;
const state: KnowledgePageState = { snapshot, view: 'materials', collectionId, visible: entries, selectedIds: [entries[0].id] };

describe('translation materials page context', () => {
  it('describes the selected collection, at most 20 visible entries and the selection, without evidence', () => {
    const described = knowledgeSnapshot(state) as Exclude<ReturnType<typeof knowledgeSnapshot>, { loading: boolean }>;
    expect(described).toMatchObject({ view: 'materials', collection: { id: collectionId, name: '绝区零 · 人物与称谓', languagePair: 'ja→zh-Hans', entryCount: 25 },
      counts: { needsReview: 2 }, moreVisible: 5, selectedEntryIds: [entries[0].id] });
    expect(described.visibleEntries).toHaveLength(20);
    expect(described.visibleEntries[0]).toEqual({ id: entries[0].id, revision: 2, kind: 'term', summary: '語0 → 词0', state: 'candidate', languagePair: 'ja→zh-Hans' });
    expect(described.visibleEntries[1].state).toBe('unconfirmed');
    const text = JSON.stringify(knowledgePageContext(() => state).describe!());
    expect(text).not.toContain('private');
    expect(text.length).toBeLessThan(6000);
    expect(knowledgePageContext(() => state)).toMatchObject({ route: '/tools/translation-knowledge', titleKey: 'knowledge:title', subject: '绝区零 · 人物与称谓' });
    expect(knowledgeSnapshot({ ...state, snapshot: null })).toEqual({ loading: true });
    expect(knowledgeSnapshot({ ...state, collectionId: 'all', selectedIds: [] })).toMatchObject({ collection: 'all' });
  });

  it('opens a focused collection only when it exists and is not archived', () => {
    expect(focusedCollection(snapshot, { collectionId })).toBe(collectionId);
    expect(focusedCollection(snapshot, { collectionId: archivedId })).toBeUndefined();
    expect(focusedCollection(snapshot, { collectionId: '20000000-0000-4000-8000-000000000099' })).toBeUndefined();
    expect(focusedCollection(snapshot, 'nonsense')).toBeUndefined();
  });

  it('never replaces newer data with an older announcement', () => {
    expect(newerSnapshot(snapshot, { ...snapshot, generation: 6 })).toBe(snapshot);
    const next = { ...snapshot, generation: 8 };
    expect(newerSnapshot(snapshot, next)).toBe(next);
    expect(newerSnapshot(null, next)).toBe(next);
  });
});
