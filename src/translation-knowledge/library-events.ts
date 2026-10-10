import type { LibrarySnapshot } from './ipc-contract';

/**
 * Saves made outside the translation materials page (the assistant, Studio dialogs) announce the
 * new library so an open page shows it without a reload. Data only; it never grants anything.
 */
export const KNOWLEDGE_CHANGED_EVENT = 'fusionkit:translation-knowledge-changed';

export function announceKnowledgeChange(snapshot: LibrarySnapshot): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<LibrarySnapshot>(KNOWLEDGE_CHANGED_EVENT, { detail: snapshot }));
}

/** Keeps the newer of two snapshots; a stale announcement never replaces newer data. */
export function newerSnapshot(current: LibrarySnapshot | null, incoming: LibrarySnapshot): LibrarySnapshot {
  return current && current.generation >= incoming.generation ? current : incoming;
}
