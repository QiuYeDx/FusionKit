import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';

/** What an edit did, for undo/redo labels. */
export type CueEditLabel = 'source' | 'target' | 'clear' | 'review' | 'unreview' | 'delete';
export type CueHistoryEntry = { label: CueEditLabel; count: number; operation: CueEditOperation };
type State = { documentId: string; revision: number; undo: CueHistoryEntry[]; redo: CueHistoryEntry[] };

const LIMIT = 100;

/**
 * Undo and redo for cue edits of one document. Each step stores the inverse
 * operation returned by the main process. The history is valid only while the
 * document is still at the revision our last step produced: any other change
 * (a translation commit, a track rename, another window) discards it, so undo
 * never overwrites work it did not see.
 */
export class CueHistory {
  private state: State | null = null;

  /** Drops the history when the document moved on without us. */
  sync(documentId: string | undefined, revision: number | undefined) {
    if (this.state && (this.state.documentId !== documentId || this.state.revision !== revision)) this.state = null;
  }

  peek(direction: 'undo' | 'redo'): CueHistoryEntry | undefined {
    return this.state?.[direction].at(-1);
  }

  /** Records a completed edit made at `from`, which produced `to`. */
  record(documentId: string, from: number, to: number, entry: CueHistoryEntry) {
    const kept = this.state?.documentId === documentId && this.state.revision === from ? this.state.undo : [];
    this.state = { documentId, revision: to, undo: [...kept, entry].slice(-LIMIT), redo: [] };
  }

  /** Moves the top entry to the other stack after it was applied, replacing its operation with the new inverse. */
  step(direction: 'undo' | 'redo', documentId: string, from: number, to: number, inverse: CueEditOperation) {
    const state = this.state;
    if (!state || state.documentId !== documentId || state.revision !== from) return;
    const entry = state[direction].at(-1);
    if (!entry) return;
    const other = direction === 'undo' ? 'redo' : 'undo';
    this.state = { ...state, revision: to, [direction]: state[direction].slice(0, -1), [other]: [...state[other], { ...entry, operation: inverse }] };
  }

  /** Forgets an entry that could not be applied. */
  discard(direction: 'undo' | 'redo') {
    if (this.state) this.state = { ...this.state, [direction]: this.state[direction].slice(0, -1) };
  }

  clear() { this.state = null; }
}
