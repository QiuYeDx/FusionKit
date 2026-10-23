/**
 * Review flags the user chose to ignore, kept on this computer per document as
 * `cueId:sourceRevision` keys (see `cueReviewIgnoreKey`): once a cue's text changes its
 * flags show again. When storage cannot be read or written, ignores last for the session.
 */
const PREFIX = 'fusionkit-studio-review-ignored:';
/** Ignores kept per document; the oldest go first. */
const LIMIT = 10_000;
const session = new Map<string, Set<string>>();

function stored(documentId: string): Set<string> | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFIX + documentId) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch { return undefined; }
}

export const cueReviewIgnores = {
  read(documentId: string): ReadonlySet<string> {
    return new Set([...(stored(documentId) ?? []), ...(session.get(documentId) ?? [])]);
  },
  add(documentId: string, key: string): ReadonlySet<string> {
    const keys = [...this.read(documentId)].filter(item => item !== key).concat(key).slice(-LIMIT);
    session.set(documentId, new Set(keys));
    try { localStorage.setItem(PREFIX + documentId, JSON.stringify(keys)); } catch { /* Kept for this session only. */ }
    return new Set(keys);
  },
  /** Shows every ignored flag of the document again. */
  clear(documentId: string): ReadonlySet<string> {
    session.set(documentId, new Set());
    try { localStorage.removeItem(PREFIX + documentId); } catch { /* Storage that cannot be written kept nothing to clear. */ }
    return this.read(documentId);
  },
};
