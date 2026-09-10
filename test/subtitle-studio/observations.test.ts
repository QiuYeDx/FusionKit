import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { StudioObservations } from '../../src/services/subtitle-studio/observations';
import type { DocumentSummary } from '../../src/subtitle-studio/ipc-contract';

describe('document snapshot/event reconciliation', () => {
  it('retains off-page observations and tombstones across snapshots; rejects old pages and events', () => {
    const state = new StudioObservations();
    const a = randomUUID(); const b = randomUUID();
    const document = (id: string, revision: number) => ({ id, revision }) as DocumentSummary;
    expect(state.observe({ documentId: a, revision: 3, sequence: 5, deleted: false })).toBe(true);
    expect(state.acceptSnapshot({ documents: [document(b, 1)], total: 2, unavailableDocuments: 0, sequence: 4 })).toBe(false);
    expect(state.acceptSnapshot({ documents: [document(b, 1)], total: 2, unavailableDocuments: 0, sequence: 5 })).toBe(true);
    expect(state.acceptSnapshot({ documents: [document(b, 3)], total: 2, unavailableDocuments: 0, sequence: 5 })).toBe(true);
    expect(state.acceptsDocument(document(b, 2))).toBe(false);
    expect(state.observe({ documentId: b, revision: 2, sequence: 3, deleted: false })).toBe(false);
    expect(state.acceptsDocument(document(a, 2))).toBe(false);
    state.observe({ documentId: a, revision: 4, sequence: 6, deleted: true });
    expect(state.acceptSnapshot({ documents: [document(b, 3)], total: 1, unavailableDocuments: 0, sequence: 6 })).toBe(true);
    expect(state.observe({ documentId: a, revision: 3, sequence: 5, deleted: false })).toBe(false);
    expect(state.observe({ documentId: a, revision: 5, sequence: 7, deleted: false })).toBe(false);
    expect(state.acceptsDocument(document(a, 4))).toBe(false);
    expect(state.acceptSnapshot({ documents: [document(a, 4)], total: 2, unavailableDocuments: 0, sequence: 6 })).toBe(false);
    expect(state.acceptSnapshot({ documents: [], total: 0, unavailableDocuments: 0, sequence: 5 })).toBe(false);
  });
});
