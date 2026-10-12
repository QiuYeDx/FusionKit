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
