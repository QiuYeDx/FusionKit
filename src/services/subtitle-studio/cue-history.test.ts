import { describe, expect, it } from 'vitest';
import { CueHistory, type CueHistoryEntry } from './cue-history';

const entry = (cueId: string): CueHistoryEntry => ({ label: 'source', count: 1, operation: { kind: 'delete', cueIds: [cueId] } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('cue edit history', () => {
  it('keeps each document its own history while others are shown', () => {
    const history = new CueHistory();
    history.sync('a', 1);
    history.record('a', 1, 2, entry(id(1)));
    history.sync('b', 7);
    expect(history.peek('undo')).toBeUndefined();
    history.record('b', 7, 8, entry(id(2)));
    expect(history.peek('undo')).toEqual(entry(id(2)));
    // Back to the first document, still at the revision our edit produced.
    history.sync('a', 2);
    expect(history.peek('undo')).toEqual(entry(id(1)));
    history.step('undo', 'a', 2, 3, { kind: 'restore', removed: { cues: [], diagnostics: [] } } as never);
    expect(history.peek('redo')?.label).toBe('source');
    history.sync('b', 8);
    expect(history.peek('undo')).toEqual(entry(id(2)));
  });

  it('drops a document history when the document changed without it, and says when what it shows changed', () => {
    const history = new CueHistory();
    history.record('a', 1, 2, entry(id(1)));
    expect(history.sync('a', 2)).toBe(true);
    expect(history.sync('a', 2)).toBe(false);
    expect(history.sync('a', 5)).toBe(true);
    expect(history.peek('undo')).toBeUndefined();
    history.sync('a', 2);
    expect(history.peek('undo')).toBeUndefined();
  });

  it('keeps the thirty documents shown most recently', () => {
    const history = new CueHistory();
    for (let n = 0; n < 31; n++) history.record(`d${n}`, 1, 2, entry(id(n)));
    history.sync('d0', 2);
    expect(history.peek('undo')).toBeUndefined();
    history.sync('d1', 2);
    expect(history.peek('undo')).toEqual(entry(id(1)));
  });

  it('discards an entry of the shown document only', () => {
    const history = new CueHistory();
    history.record('a', 1, 2, entry(id(1)));
    history.record('b', 1, 2, entry(id(2)));
    history.sync('a', 2);
    history.discard('undo');
    expect(history.peek('undo')).toBeUndefined();
    history.sync('b', 2);
    expect(history.peek('undo')).toEqual(entry(id(2)));
  });
});
