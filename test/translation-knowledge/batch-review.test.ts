import { describe, expect, it } from 'vitest';
import { knowledgeFixture } from './fixtures';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import { batchReviewReason, selectedReviewEntries } from '../../src/pages/TranslationKnowledge/batch-review';

const snapshot = (): LibrarySnapshot => ({ generation: 1, data: knowledgeFixture(), approvals: {}, imports: [] });
describe('bulk material review eligibility and frozen selection', () => {
  it('accepts ordinary AI candidates and keeps strong entries visible with individual-review reasons', () => {
    const state = snapshot();
    const term = state.data.entries.find(e => e.kind === 'term')!;
    term.state = 'candidate';
    expect(batchReviewReason(term, state, 'adopt')).toBeUndefined();
    if (term.kind === 'term') term.payload.strength = 'required';
    expect(batchReviewReason(term, state, 'adopt')).toBe('individual');
    expect(batchReviewReason(term, state, 'reject')).toBeUndefined();
    const context = state.data.entries.find(e => e.kind === 'context')!;
    if (context.kind === 'context') context.payload.core = true;
    expect(batchReviewReason(context, state, 'adopt')).toBe('individual');
    state.data.collections[0].archived = true;
    expect(batchReviewReason(term, state, 'adopt')).toBe('dependency');
  });
  it('refreshes only original identities and excludes entries already accepted, removed or archived', () => {
    const state = snapshot(), original = state.data.entries[0];
    const ids = [original.id, state.data.entries[1].id];
    const extra = { ...structuredClone(original), id: '50000000-0000-4000-8000-000000000099' };
    state.data.entries.push(extra);
    state.data.entries[1].state = 'archived';
    expect(selectedReviewEntries(state, ids).map(e => e.id)).toEqual([original.id]);
    original.state = 'ready';
    state.approvals[original.id] = { revision: original.revision, digest: '', method: 'human', approvedAt: new Date().toISOString() };
    expect(selectedReviewEntries(state, ids)).toEqual([]);
    expect(batchReviewReason(original, state, 'adopt')).toBe('unavailable');
    state.data.entries = [extra];
    expect(selectedReviewEntries(state, ids)).toEqual([]);
  });
});
