// ---------------------------------------------------------------------------
// Unsent input per session, shared by the home page and the floating panel.
// Kept in memory only, like the composer draft has always been.
// ---------------------------------------------------------------------------

const drafts = new Map<string, string>();

export function readSessionDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
}

export function writeSessionDraft(sessionId: string, text: string): void {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function forgetSessionDraft(sessionId: string): void {
  drafts.delete(sessionId);
}

export function forgetAllSessionDrafts(): void {
  drafts.clear();
}

const fillListeners = new Set<(sessionId: string, text: string) => void>();

/**
 * Puts text into a session's composer the way a suggestion does, for example an example task
 * from the welcome wizard: a composer on screen shows it at once, a later one reads the draft.
 */
export function fillSessionDraft(sessionId: string, text: string): void {
  writeSessionDraft(sessionId, text);
  for (const listener of fillListeners) listener(sessionId, text);
}

export function onSessionDraftFilled(listener: (sessionId: string, text: string) => void): () => void {
  fillListeners.add(listener);
  return () => { fillListeners.delete(listener); };
}
