import type { AgentPageContext } from '@/agent/page-context';
import type { Entry } from '@/translation-knowledge/schemas';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { entrySummary } from '@/translation-knowledge/summary';
import type { ContentView } from './model';

export const KNOWLEDGE_ROUTE = '/tools/translation-knowledge';
const VISIBLE_LIMIT = 20;
const SELECTION_LIMIT = 50;

/** Navigation state other screens pass to open the page on one collection. */
export interface KnowledgeFocus { collectionId?: string }

export interface KnowledgePageState {
  snapshot: LibrarySnapshot | null;
  collectionId: string | undefined;
  view: ContentView;
  /** Entries on the current page of the open tab, in display order. */
  visible: readonly Entry[];
  selectedIds: readonly string[];
}

export const KNOWLEDGE_AGENT_INSTRUCTIONS = [
  'The translation materials page is open on one collection. The snapshot lists it, the entries the user can see and the ones they selected, with ids and revisions.',
  'To change entries the user points at (edit, set required, disable or enable), call prepare_knowledge_changes with those ids and revisions; the user confirms on the card. Use search_translation_knowledge for entries not in the snapshot instead of guessing.',
].join(' ');

const brief = (entry: Entry) => ({ id: entry.id, revision: entry.revision, kind: entry.kind, enabled: entry.enabled,
  summary: entrySummary(entry).slice(0, 160), ...(entry.kind === 'term' ? { strength: entry.payload.strength } : { required: entry.payload.required }) });

/** Bounded JSON of what the user sees; no origin notes or source URLs. */
export function knowledgeSnapshot(state: KnowledgePageState) {
  const { snapshot } = state;
  if (!snapshot) return { loading: true };
  const collection = snapshot.data.collections.find(item => item.id === state.collectionId);
  const selected = state.selectedIds.slice(0, SELECTION_LIMIT).flatMap(id => snapshot.data.entries.filter(entry => entry.id === id)).map(brief);
  return {
    collection: collection ? { id: collection.id, name: collection.name.slice(0, 120), languagePair: `${collection.languagePair.source}→${collection.languagePair.target}`,
      entryCount: snapshot.data.entries.filter(entry => entry.collectionId === collection.id).length, archived: collection.archived } : null,
    view: state.view,
    counts: { collections: snapshot.data.collections.filter(item => !item.archived).length, entries: snapshot.data.entries.length },
    visibleEntries: state.visible.slice(0, VISIBLE_LIMIT).map(brief),
    ...(state.visible.length > VISIBLE_LIMIT ? { moreVisible: state.visible.length - VISIBLE_LIMIT } : {}),
    ...(selected.length ? { selectedEntries: selected } : {}),
  };
}

export function knowledgePageContext(read: () => KnowledgePageState): AgentPageContext {
  const state = read();
  const collection = state.snapshot?.data.collections.find(item => item.id === state.collectionId);
  return { route: KNOWLEDGE_ROUTE, titleKey: 'knowledge:title', ...(collection ? { subject: collection.name } : {}),
    instructions: KNOWLEDGE_AGENT_INSTRUCTIONS, describe: () => knowledgeSnapshot(read()) };
}

/** The collection a focus request may open: it must exist. */
export function focusedCollection(snapshot: LibrarySnapshot, focus: unknown): string | undefined {
  const id = focus && typeof focus === 'object' && typeof (focus as KnowledgeFocus).collectionId === 'string' ? (focus as KnowledgeFocus).collectionId : undefined;
  return id && snapshot.data.collections.some(item => item.id === id) ? id : undefined;
}
