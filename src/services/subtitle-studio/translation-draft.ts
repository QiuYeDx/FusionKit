import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import type { AutomaticKnowledgePreferences } from '@/subtitle-studio/transcription/preferences-contract';

export type TranslationDraft = {
  profileId: string;
  language: string;
  instructions: string;
  contextWindow: string;
  maxOutputTokens: string;
  maxBatchCues: string;
  selection: KnowledgeSelection;
  documentTopicIds: string[];
  cueIds: string[];
};
export const knowledgeTarget = (language: string) => language === 'zh' ? 'zh-Hans' : language;
export const emptySelection = (target: string): KnowledgeSelection => ({ version: 1, languagePair: { source: '', target: knowledgeTarget(target) }, collectionIds: [], bindings: [], confirmations: [], disabledEntryIds: [] });
export const hasMaterials = (selection: Pick<KnowledgeSelection, 'recipeId' | 'collectionIds'>) => !!selection.recipeId || selection.collectionIds.length > 0;
export function reusableTranslationDraft(draft: TranslationDraft): TranslationDraft {
  return { ...structuredClone(draft), documentTopicIds: [], cueIds: [], selection: { ...structuredClone(draft.selection), bindings: [], confirmations: [], disabledEntryIds: [] } };
}
/** Deliberately in memory: no credentials, plans or file-specific authority are persisted. */
export class TranslationDraftMemory {
  private documents = new Map<string, { revision: number; draft: TranslationDraft }>();
  private previous: TranslationDraft | undefined;
  remember(documentId: string | undefined, revision: number | undefined, draft: TranslationDraft, promote = true) {
    if (promote) this.previous = reusableTranslationDraft(draft);
    if (!documentId || !revision) return;
    this.documents.delete(documentId);
    this.documents.set(documentId, { revision, draft: structuredClone(draft) });
    while (this.documents.size > 50) this.documents.delete(this.documents.keys().next().value!);
  }
  read(documentId: string, revision: number): TranslationDraft | undefined {
    const saved = this.documents.get(documentId);
    if (!saved) return;
    return saved.revision === revision ? structuredClone(saved.draft) : reusableTranslationDraft(saved.draft);
  }
  last(): TranslationDraft | undefined { return this.previous && reusableTranslationDraft(this.previous); }
}
export const translationDraftMemory = new TranslationDraftMemory();

/** Old disabled preferences can contain former choices; they must remain off. */
export function activeAutomaticMaterials(saved: AutomaticKnowledgePreferences | undefined, target: string): KnowledgeSelection {
  if (!saved?.enabled) return emptySelection(target);
  return { ...emptySelection(target), languagePair: { source: saved.sourceLanguage, target: knowledgeTarget(target) },
    collectionIds: [...saved.collectionIds], disabledEntryIds: [...saved.disabledEntryIds],
    ...(saved.recipeId ? { recipeId: saved.recipeId } : {}),
    ...(saved.instructions !== undefined ? { instructions: saved.instructions } : {}),
    ...(saved.context !== undefined ? { context: saved.context } : {}) };
}
