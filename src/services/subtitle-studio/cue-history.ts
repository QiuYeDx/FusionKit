import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';

/** What an edit did, for undo/redo labels. */
export type CueEditLabel = 'source' | 'target' | 'clear' | 'review' | 'unreview' | 'delete' | 'revise' | 'unify' | 'merge' | 'timing' | 'recognize' | 'shift' | 'split' | 'insert' | 'replace' | 'agent';
export type CueHistoryEntry = { label: CueEditLabel; count: number; operation: CueEditOperation };
type State = { revision: number; undo: CueHistoryEntry[]; redo: CueHistoryEntry[] };

const LIMIT = 100;
/** Documents whose history is kept; the least recently shown goes first. */
const DOCUMENTS = 30;

/**
 * Undo and redo for cue edits, one history per document for this session.
 * Each step stores the inverse operation returned by the main process. A
 * document's history is valid only while it is still at the revision our last
 * step produced: any other change (a translation commit, a track rename,
 * another window) discards it, so undo never overwrites work it did not see.
 */
export class CueHistory {
  private readonly states = new Map<string, State>();
  /** The document shown, whose history `peek` and `discard` use. */
  private current: string | undefined;
  private listeners = new Set<() => void>();

  /** Called after an edit made outside the studio page (an external agent's) is recorded. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Shows a document's history, dropping it when the document moved on without us.
   * Returns whether what `peek` shows changed.
   */
  sync(documentId: string | undefined, revision: number | undefined): boolean {
    const shown = this.current !== documentId;
    this.current = documentId;
    if (!documentId) return shown;
    const state = this.states.get(documentId);
    if (!state) return shown;
    this.states.delete(documentId);
    if (state.revision === revision) this.states.set(documentId, state);
    return shown || state.revision !== revision;
  }

  /** The next step of the shown document, or of `documentId` while the shown one is still being synced. */
  peek(direction: 'undo' | 'redo', documentId = this.current): CueHistoryEntry | undefined {
    return documentId === undefined ? undefined : this.states.get(documentId)?.[direction].at(-1);
  }

  /** Records a completed edit made at `from`, which produced `to`. */
  record(documentId: string, from: number, to: number, entry: CueHistoryEntry) {
    const state = this.states.get(documentId);
    const kept = state?.revision === from ? state.undo : [];
    this.put(documentId, { revision: to, undo: [...kept, entry].slice(-LIMIT), redo: [] });
    for (const listener of this.listeners) listener();
  }

  /** Moves the top entry to the other stack after it was applied, replacing its operation with the new inverse. */
  step(direction: 'undo' | 'redo', documentId: string, from: number, to: number, inverse: CueEditOperation) {
    const state = this.states.get(documentId);
    if (!state || state.revision !== from) return;
    const entry = state[direction].at(-1);
    if (!entry) return;
    const other = direction === 'undo' ? 'redo' : 'undo';
    this.put(documentId, { ...state, revision: to, [direction]: state[direction].slice(0, -1), [other]: [...state[other], { ...entry, operation: inverse }] });
  }

  /** Forgets an entry of the shown document that could not be applied. */
  discard(direction: 'undo' | 'redo') {
    const state = this.current === undefined ? undefined : this.states.get(this.current);
    if (state) this.put(this.current!, { ...state, [direction]: state[direction].slice(0, -1) });
  }

  clear() { this.states.clear(); }

  private put(documentId: string, state: State) {
    this.states.delete(documentId);
    this.states.set(documentId, state);
    while (this.states.size > DOCUMENTS) this.states.delete(this.states.keys().next().value!);
  }
}

/** The session's history: it outlives the studio page, so leaving and coming back keeps it. */
export const cueHistory = new CueHistory();
