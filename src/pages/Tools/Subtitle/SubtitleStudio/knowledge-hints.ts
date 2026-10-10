import type { CueRevisionHint } from '@/subtitle-studio/cue-revision-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import type { LanguagePair } from '@/translation-knowledge/schemas';
import { normalizeLanguageTag } from '@/translation-knowledge/proposal';
import type { TranslationDraft } from '@/services/subtitle-studio/translation-draft';

const fold = (text: string) => text.normalize('NFKC').trim().toLowerCase();
const key = (hint: Pick<CueRevisionHint, 'source' | 'target'>) => JSON.stringify([fold(hint.source), fold(hint.target)]);

/** Joins the wordings of several revision calls, keeping each once with all its cues. */
export function mergeHints(current: readonly CueRevisionHint[], incoming: readonly CueRevisionHint[] | undefined, limit = 10): CueRevisionHint[] {
  const merged = new Map(current.map(hint => [key(hint), { ...hint, cueIds: [...hint.cueIds] }]));
  for (const hint of incoming ?? []) {
    const existing = merged.get(key(hint));
    if (existing) existing.cueIds = [...new Set([...existing.cueIds, ...hint.cueIds])];
    else if (merged.size < limit) merged.set(key(hint), { ...hint, cueIds: [...hint.cueIds] });
  }
  return [...merged.values()];
}

/** Wordings of the proposals the user actually applied. */
export function appliedHints(hints: readonly CueRevisionHint[] | undefined, applied: ReadonlySet<string>): CueRevisionHint[] {
  return (hints ?? []).filter(hint => hint.cueIds.some(id => applied.has(id)));
}

/**
 * Wordings worth offering: those the library does not already hold with the same translation.
 * Without a known source language any language pair with the same target counts.
 */
export function hintsToOffer(hints: readonly CueRevisionHint[], library: LibrarySnapshot | null, pair: Partial<LanguagePair>): CueRevisionHint[] {
  if (!library) return [...hints];
  const held = new Set(library.data.entries.flatMap(entry => entry.kind === 'term' && entry.state !== 'archived' && entry.state !== 'rejected'
    && (!pair.target || entry.scope.languagePair.target === pair.target) && (!pair.source || entry.scope.languagePair.source === pair.source)
    ? [entry.payload.source, ...entry.payload.aliases].map(source => key({ source, target: entry.payload.target })) : []));
  return hints.filter(hint => !held.has(key(hint)));
}

/** The language pair kept wordings use: the document's materials, else the last translation, and the track's language. */
export function captureLanguagePair(draft: TranslationDraft | undefined, last: TranslationDraft | undefined, trackLanguage: string | undefined): Partial<LanguagePair> {
  const source = draft?.selection.languagePair.source || last?.selection.languagePair.source || '';
  const target = normalizeLanguageTag(trackLanguage) ?? draft?.selection.languagePair.target ?? '';
  return { ...(source ? { source } : {}), ...(target ? { target } : {}) };
}

/** Where kept wordings go by default: the first chosen collection, else the first one the recipe reads. */
export function preferredCollection(selection: KnowledgeSelection | undefined, library: LibrarySnapshot | null): string | undefined {
  if (!selection) return undefined;
  const live = (id: string) => library?.data.collections.some(collection => collection.id === id && !collection.archived) ?? true;
  const direct = selection.collectionIds.find(live);
  if (direct) return direct;
  const recipe = selection.recipeId ? library?.data.recipes.find(item => item.id === selection.recipeId) : undefined;
  return recipe?.readCollectionIds.find(live);
}

/** Names of the materials a selection uses, for a one-line summary. */
export function materialNames(selection: KnowledgeSelection, library: LibrarySnapshot | null): string[] {
  if (!library) return [];
  const recipe = selection.recipeId ? library.data.recipes.find(item => item.id === selection.recipeId) : undefined;
  const collections = selection.collectionIds.flatMap(id => library.data.collections.filter(item => item.id === id).map(item => item.name));
  return [...(recipe ? [recipe.name] : []), ...collections];
}
