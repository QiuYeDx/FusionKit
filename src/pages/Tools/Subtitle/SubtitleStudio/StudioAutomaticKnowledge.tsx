import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ToolField } from '../../_shared/ui/ToolField';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import { DEFAULT_AUTOMATIC_KNOWLEDGE } from '@/subtitle-studio/transcription/preferences-contract';
import type { StudioTranscriptionController, StudioTranscriptionState } from '@/services/subtitle-studio/transcription-controller';
import { activeAutomaticMaterials, hasMaterials, knowledgeTarget } from '@/services/subtitle-studio/translation-draft';
import { StudioMaterialsFields } from './StudioMaterialsFields';

/** Inline choices share the manual selector; transcription still freezes them at admission. */
export function StudioAutomaticKnowledge({ controller, state }: { controller: StudioTranscriptionController; state: StudioTranscriptionState }) {
  const { t } = useTranslation();
  const id = useId();
  const [saveError, setSaveError] = useState(false);
  const saved = state.autoTranslation.knowledge ?? DEFAULT_AUTOMATIC_KNOWLEDGE;
  const englishOutput = state.config.taskMode === 'translate_to_english';
  const value = activeAutomaticMaterials(saved, state.autoTranslation.language);
  if (englishOutput) value.languagePair.source = 'en';
  const topics = saved.enabled ? saved.documentTopicIds : [];
  const instructions = saved.enabled && saved.instructions !== undefined ? saved.instructions : state.autoTranslation.instructions;
  const active = hasMaterials(value);
  useEffect(() => { void controller.refreshAutomaticKnowledge(); }, [controller]);
  const update = (selection: KnowledgeSelection, documentTopicIds = topics) => {
    if (state.submitting) return;
    const enabled = hasMaterials(selection);
    const next = { enabled, sourceLanguage: englishOutput ? 'en' : selection.languagePair.source,
      collectionIds: selection.collectionIds, disabledEntryIds: selection.disabledEntryIds, documentTopicIds: enabled ? documentTopicIds : [],
      ...(selection.recipeId ? { recipeId: selection.recipeId } : {}),
      instructions: selection.instructions ?? instructions, ...(selection.context !== undefined ? { context: selection.context } : {}) };
    // Incomplete inline edits are real drafts and disable admission; they do not
    // silently revert to the previous saved setup while the user is editing.
    controller.setAutoTranslation({ ...state.autoTranslation, instructions: next.instructions, knowledge: next });
    const generation = state.autoKnowledgeLibrary?.generation;
    if (generation !== undefined && enabled) controller.setAutomaticKnowledge(next, generation);
    setSaveError(false);
  };
  const refresh = async () => {
    const library = await controller.refreshAutomaticKnowledge();
    if (!library || !hasMaterials(value)) return;
    const next = { ...saved, enabled: true, sourceLanguage: englishOutput ? 'en' : value.languagePair.source };
    setSaveError(!controller.setAutomaticKnowledge(next, library.generation));
  };
  return <div data-testid="studio-automatic-materials" className="studio-transcription-wide-field min-w-0 space-y-3">
    <StudioMaterialsFields value={value} library={state.autoKnowledgeLibrary} disabled={state.submitting} loading={state.autoKnowledgeLoading}
      onChange={update} topics={topics} onTopicsChange={next => update(value, next)} onRefresh={() => void refresh()} mode="automatic" sourceLocked={englishOutput} />
    <ToolField label={t('studio:translation.instructions')} htmlFor={`${id}-instructions`}><Textarea id={`${id}-instructions`} data-testid="studio-automatic-instructions" className="min-h-16 text-xs" maxLength={4000} disabled={state.submitting} value={instructions} onChange={event => {
      if (active) update({ ...value, instructions: event.target.value });
      else controller.setAutoTranslation({ ...state.autoTranslation, instructions: event.target.value });
    }} /></ToolField>
    {active && <p data-testid="studio-automatic-materials-help" className="text-xs leading-5 text-muted-foreground">{t('studio:materials.automatic_help')}</p>}
    {active && (state.autoKnowledgeStale || saveError) && <div role="status" data-testid="studio-automatic-knowledge-notice" className="space-y-2 text-xs leading-5 text-destructive"><p>{t('knowledge:automatic.stale')}</p><Button data-testid="studio-automatic-materials-refresh" variant="outline" size="sm" disabled={state.submitting || state.autoKnowledgeLoading} onClick={() => void refresh()}>{t('studio:refresh')}</Button></div>}
    <span className="sr-only" data-testid="automatic-knowledge-target-language">{knowledgeTarget(state.autoTranslation.language)}</span>
  </div>;
}
