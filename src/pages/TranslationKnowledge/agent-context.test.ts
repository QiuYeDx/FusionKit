import { describe, expect, it } from 'vitest';
import type { Entry } from '@/translation-knowledge/schemas';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { newerSnapshot } from '@/translation-knowledge/library-events';
import { focusedCollection, knowledgePageContext, knowledgeSnapshot, type KnowledgePageState } from './agent-context';

const pair = { source: 'ja', target: 'zh-Hans' };
const collectionId = '20000000-0000-4000-8000-000000000001';
const archivedId = '20000000-0000-4000-8000-000000000002';
function term(index: number, enabled = true): Entry {
  return { id: `20000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`, revision: 2, kind: 'term', collectionId, enabled,
    origin: { kind: 'web', url: 'https://example.invalid/private', note: 'private excerpt' },
    payload: { source: `語${index}`, target: `词${index}`, aliases: [], note: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' } };
}
const entries = Array.from({ length: 25 }, (_, index) => term(index, index !== 0));
const rule: Entry = { id: '20000000-0000-4000-8000-000000000900', revision: 1, kind: 'rule', collectionId, enabled: true, payload: { text: '保留敬称', required: true } };
const snapshot = { generation: 7,
  data: { collections: [
    { id: collectionId, revision: 1, archived: false, name: '绝区零 · 人物与称谓', description: '', languagePair: pair },
    { id: archivedId, revision: 1, archived: true, name: 'Old', description: '', languagePair: pair },
  ], entries: [...entries, rule], presets: [] },
} as unknown as LibrarySnapshot;
const state: KnowledgePageState = { snapshot, view: 'terms', collectionId, visible: entries, selectedIds: [entries[0].id, rule.id] };

describe('translation materials page context', () => {
  it('describes the open collection, at most 20 visible entries and the selection with ids and revisions, without origins', () => {
    const described = knowledgeSnapshot(state) as Exclude<ReturnType<typeof knowledgeSnapshot>, { loading: boolean }>;
    expect(described).toMatchObject({ view: 'terms', collection: { id: collectionId, name: '绝区零 · 人物与称谓', languagePair: 'ja→zh-Hans', entryCount: 26, archived: false },
      counts: { collections: 1, entries: 26 }, moreVisible: 5 });
    expect(described.visibleEntries).toHaveLength(20);
    expect(described.visibleEntries[0]).toEqual({ id: entries[0].id, revision: 2, kind: 'term', enabled: false, summary: '語0 → 词0', strength: 'preferred' });
    // "Make the selected ones required" needs exactly these.
    expect(described.selectedEntries).toEqual([
      expect.objectContaining({ id: entries[0].id, revision: 2 }), { id: rule.id, revision: 1, kind: 'rule', enabled: true, summary: '保留敬称', required: true }]);
    const text = JSON.stringify(knowledgePageContext(() => state).describe!());
    expect(text).not.toContain('private');
    expect(text.length).toBeLessThan(6000);
    expect(knowledgePageContext(() => state)).toMatchObject({ route: '/tools/translation-knowledge', titleKey: 'knowledge:title', subject: '绝区零 · 人物与称谓' });
    expect(knowledgeSnapshot({ ...state, snapshot: null })).toEqual({ loading: true });
    expect(knowledgeSnapshot({ ...state, collectionId: undefined, selectedIds: [] })).toMatchObject({ collection: null });
  });

  it('opens a focused collection only when it exists', () => {
    expect(focusedCollection(snapshot, { collectionId })).toBe(collectionId);
    expect(focusedCollection(snapshot, { collectionId: archivedId })).toBe(archivedId);
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
