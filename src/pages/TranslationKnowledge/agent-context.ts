import type { AgentPageContext } from '@/agent/page-context';
import type { Entry, LanguagePair } from '@/translation-knowledge/schemas';
import { entrySummary, type LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { entryStatus, needsReview } from './model';
import type { KnowledgeLibraryView } from './KnowledgeSidebar';

export const KNOWLEDGE_ROUTE = '/tools/translation-knowledge';
const VISIBLE_LIMIT = 20;
const SELECTION_LIMIT = 50;

/** Navigation state other screens pass to open the page on one collection. */
export interface KnowledgeFocus { collectionId?: string }

export interface KnowledgePageState {
  snapshot: LibrarySnapshot | null;
  view: KnowledgeLibraryView;
  collectionId: string;
  /** Entries on the current page of the list, in display order. */
  visible: readonly Entry[];
  selectedIds: readonly string[];
}

export const KNOWLEDGE_AGENT_INSTRUCTIONS = [
  'The translation materials page is open. The snapshot lists the selected collection and the entries the user can see, with their ids and revisions.',
  'To edit or archive entries the user points at, call prepare_knowledge_changes with those ids and revisions; the user confirms on the card. Use search_translation_knowledge for entries that are not in the snapshot instead of guessing.',
].join(' ');

const pair = (value: LanguagePair | undefined) => value ? `${value.source}→${value.target}` : undefined;

/** Bounded JSON of what the user sees; no evidence excerpts or source URLs. */
export function knowledgeSnapshot(state: KnowledgePageState) {
  const { snapshot } = state;
  if (!snapshot) return { loading: true };
  const collection = snapshot.data.collections.find(item => item.id === state.collectionId);
  const count = (id: string) => snapshot.data.entries.filter(entry => entry.collectionId === id && entry.state !== 'archived').length;
  return {
    view: state.view,
    collection: collection ? { id: collection.id, name: collection.name.slice(0, 120), languagePair: pair(collection.defaultLanguagePair), entryCount: count(collection.id), archived: collection.archived } : 'all',
    counts: { entries: snapshot.data.entries.length, collections: snapshot.data.collections.filter(item => !item.archived).length,
      needsReview: snapshot.data.entries.filter(entry => needsReview(entry, snapshot)).length },
    visibleEntries: state.visible.slice(0, VISIBLE_LIMIT).map(entry => ({ id: entry.id, revision: entry.revision, kind: entry.kind,
      summary: entrySummary(entry).slice(0, 160), state: entryStatus(entry, snapshot), languagePair: pair(entry.scope.languagePair) })),
    ...(state.visible.length > VISIBLE_LIMIT ? { moreVisible: state.visible.length - VISIBLE_LIMIT } : {}),
    ...(state.selectedIds.length ? { selectedEntryIds: state.selectedIds.slice(0, SELECTION_LIMIT) } : {}),
  };
}

export function knowledgePageContext(read: () => KnowledgePageState): AgentPageContext {
  const state = read();
  const collection = state.snapshot?.data.collections.find(item => item.id === state.collectionId);
  return { route: KNOWLEDGE_ROUTE, titleKey: 'knowledge:title', ...(collection ? { subject: collection.name } : {}),
    instructions: KNOWLEDGE_AGENT_INSTRUCTIONS, describe: () => knowledgeSnapshot(read()) };
}

/** The collection a focus request may open: it must exist and not be archived. */
export function focusedCollection(snapshot: LibrarySnapshot, focus: unknown): string | undefined {
  const id = focus && typeof focus === 'object' && typeof (focus as KnowledgeFocus).collectionId === 'string' ? (focus as KnowledgeFocus).collectionId : undefined;
  return id && snapshot.data.collections.some(item => item.id === id && !item.archived) ? id : undefined;
}
