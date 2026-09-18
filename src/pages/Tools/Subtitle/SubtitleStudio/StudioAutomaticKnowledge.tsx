import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BookOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolSwitchRow } from '../../_shared/ui/ToolSwitchRow';
import { DEFAULT_AUTOMATIC_KNOWLEDGE, type AutomaticKnowledgePreferences } from '@/subtitle-studio/transcription/preferences-contract';
import { automaticKnowledgeTargetLanguage, getAutomaticKnowledgeProblem, type StudioTranscriptionController, type StudioTranscriptionState } from '@/services/subtitle-studio/transcription-controller';

const languages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
const languageKeys = { ja: 'knowledge:languages.ja', en: 'knowledge:languages.en', 'zh-Hans': 'knowledge:languages.zh-Hans', 'zh-Hant': 'knowledge:languages.zh-Hant', ko: 'knowledge:languages.ko', fr: 'knowledge:languages.fr', de: 'knowledge:languages.de', es: 'knowledge:languages.es', ru: 'knowledge:languages.ru', pt: 'knowledge:languages.pt' } as const;
const problemKeys = { library: 'knowledge:automatic.problem_library', source: 'knowledge:automatic.problem_source', resources: 'knowledge:automatic.problem_resources', language: 'knowledge:automatic.problem_language' } as const;
function Choice({ label, value, options, onChange, disabled, testId }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (id: string) => void; disabled?: boolean; testId: string }) {
  const id = useId();
  return <ToolField label={label} htmlFor={id}><Select value={value} disabled={disabled} onValueChange={next => { if (!disabled) onChange(next); }}><SelectTrigger id={id} data-testid={testId} className="h-auto min-h-8 w-full min-w-0 text-left text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:whitespace-normal [&_[data-slot=select-value]]:[overflow-wrap:anywhere]"><SelectValue /></SelectTrigger><SelectContent className="max-w-[calc(100vw-2rem)]">{options.map(option => <SelectItem key={option.id} value={option.id} className="max-w-[min(36rem,80vw)] whitespace-normal [overflow-wrap:anywhere]">{option.name}</SelectItem>)}</SelectContent></Select></ToolField>;
}
function Toggle({ label, checked, onChange, disabled, testId }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; testId: string }) {
  const id = useId();
  return <label htmlFor={id} className="flex min-w-0 items-start gap-2 text-xs leading-5"><Checkbox id={id} data-testid={testId} className="mt-0.5 shrink-0" checked={checked} disabled={disabled} onCheckedChange={value => { if (!disabled) onChange(value === true); }} /><span className="min-w-0 [overflow-wrap:anywhere]">{label}</span></label>;
}
function PagedItems<T>({ items, children, disabled }: { items: readonly T[]; children: (item: T) => ReactNode; disabled: boolean }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(items.length / 10));
  const current = Math.min(page, pages - 1);
  return <div className="min-w-0 space-y-3">{items.slice(current * 10, (current + 1) * 10).map(children)}{pages > 1 && <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground"><span>{t('knowledge:pagination', { count: items.length, page: current + 1, pages })}</span><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={disabled || current === 0} onClick={() => setPage(current - 1)}>{t('knowledge:actions.previous')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled || current + 1 >= pages} onClick={() => setPage(current + 1)}>{t('knowledge:actions.next')}</Button></div></div>}</div>;
}

/** A draft-only selector: cancel never changes the saved automatic choices. */
export function StudioAutomaticKnowledge({ controller, state }: { controller: StudioTranscriptionController; state: StudioTranscriptionState }) {
  const { t } = useTranslation();
  const formId = useId(), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [saveError, setSaveError] = useState(false);
  const [draft, setDraft] = useState<AutomaticKnowledgePreferences>(structuredClone(DEFAULT_AUTOMATIC_KNOWLEDGE));
  const saved = state.autoTranslation.knowledge ?? DEFAULT_AUTOMATIC_KNOWLEDGE;
  const library = state.autoKnowledgeLibrary, englishOutput = state.config.taskMode === 'translate_to_english';
  const busy = state.submitting || state.autoKnowledgeLoading;
  useEffect(() => { if (saved.enabled) void controller.refreshAutomaticKnowledge(); }, [controller, saved.enabled]);
  const begin = () => {
    if (state.submitting) return;
    setDraft({ ...structuredClone(saved), enabled: true, ...(englishOutput ? { sourceLanguage: 'en' } : {}) });
    setSaveError(false); setOpen(true); void controller.refreshAutomaticKnowledge();
  };
  const update = (patch: Partial<AutomaticKnowledgePreferences>) => { if (!busy) { setSaveError(false); setDraft(value => ({ ...value, ...patch })); } };
  const recipe = library?.data.recipes.find(item => item.id === draft.recipeId);
  const collections = new Set([...draft.collectionIds, ...recipe?.readCollectionIds ?? []]);
  const availableRecipes = library?.data.recipes.filter(item => !item.archived) ?? [];
  const choices = <T extends { id: string; name: string; archived: boolean }>(items: readonly T[], selected: readonly string[]) => {
    const available = items.filter(item => !item.archived).map(item => ({ id: item.id, name: item.name }));
    for (const id of selected) if (!available.some(item => item.id === id)) available.push({ id, name: t('knowledge:automatic.unavailable_item', { name: items.find(item => item.id === id)?.name ?? t('knowledge:automatic.removed_item') }) });
    return available;
  };
  const collectionChoices = choices(library?.data.collections ?? [], [...collections]);
  const topicChoices = choices(library?.data.subjects ?? [], draft.documentTopicIds);
  const scopedEntries = library?.data.entries.filter(entry => collections.has(entry.collectionId)) ?? [];
  const entryChoices = scopedEntries.map(entry => ({ id: entry.id, name: entry.title }));
  for (const id of draft.disabledEntryIds) if (!entryChoices.some(entry => entry.id === id)) entryChoices.push({ id, name: t('knowledge:automatic.unavailable_item', { name: library?.data.entries.find(entry => entry.id === id)?.title ?? t('knowledge:automatic.removed_item') }) });
  const problem = getAutomaticKnowledgeProblem(draft, state.autoTranslation.language, englishOutput, library);
  const savedProblem = getAutomaticKnowledgeProblem(saved, state.autoTranslation.language, englishOutput, library);
  const target = automaticKnowledgeTargetLanguage(state.autoTranslation.language);
  const languageName = (language: string) => { const known = languages.find(item => item === language); return known ? t(languageKeys[known]) : language; };
  const savedNotice = state.autoKnowledgeStale ? t('knowledge:automatic.stale') : savedProblem ? t(problemKeys[savedProblem]) : null;
  const savedRecipe = library?.data.recipes.find(item => item.id === saved.recipeId);
  const savedCollections = new Set([...saved.collectionIds, ...savedRecipe?.readCollectionIds ?? []]);

  return <div className="min-w-0 space-y-2 studio-transcription-wide-field">
    <ToolSwitchRow id="studio-automatic-knowledge-enabled" testId="studio-automatic-knowledge-row" label={t('knowledge:automatic.enable')} hint={t('knowledge:automatic.enable_hint')} checked={saved.enabled} disabled={state.submitting} onCheckedChange={enabled => {
      if (enabled) begin(); else controller.setAutoTranslation({ ...state.autoTranslation, knowledge: { ...saved, enabled: false } });
    }} />
    {!saved.enabled && <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.off')}</p>}
    {saved.enabled && <div className="min-w-0 space-y-2">
      <p data-testid="studio-automatic-knowledge-summary" className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{savedRecipe?.name ? `${savedRecipe.name} · ` : ''}{t('knowledge:automatic.summary', { collections: savedCollections.size, topics: saved.documentTopicIds.length })}</p>
      <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{!library ? t('knowledge:loading') : savedCollections.size ? t('knowledge:selection.summary', { names: [...savedCollections].map(id => library.data.collections.find(item => item.id === id)?.name ?? t('knowledge:automatic.removed_item')).join(' · ') }) : savedRecipe?.name ?? t('knowledge:selection.none')}</p>
      <Button ref={trigger} data-testid="studio-automatic-knowledge-choose" type="button" size="sm" variant="outline" disabled={state.submitting} onClick={begin}><BookOpen />{t('knowledge:automatic.choose')}</Button>
      {state.autoKnowledgeLoading ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('knowledge:loading')}</p> : savedNotice && <p data-testid="studio-automatic-knowledge-notice" role="status" className="text-xs leading-5 text-destructive">{savedNotice}</p>}
    </div>}
    <ScrollableDialog open={open} onOpenChange={setOpen} maxWidth="sm:max-w-3xl" contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden" onCloseAutoFocus={event => { event.preventDefault(); (trigger.current ?? document.getElementById('studio-automatic-knowledge-enabled'))?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="p-3"><DialogTitle className="text-base">{t('knowledge:automatic.title')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('knowledge:automatic.description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:p-3" fadeMaskHeight={16}>
        <div data-testid="automatic-knowledge-content" aria-busy={busy} className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
          {state.autoKnowledgeLoading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('knowledge:loading')}</p>}
          <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.help')}</p>
          <fieldset disabled={busy || !library} className="min-w-0 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Choice testId="automatic-knowledge-source-language" disabled={busy || !library || englishOutput} label={t('knowledge:fields.source_language')} value={englishOutput ? 'en' : draft.sourceLanguage || 'unselected'} options={[{ id: 'unselected', name: t('knowledge:automatic.choose_source') }, ...languages.map(id => ({ id, name: languageName(id) })), ...(draft.sourceLanguage && !languages.includes(draft.sourceLanguage as typeof languages[number]) ? [{ id: draft.sourceLanguage, name: languageName(draft.sourceLanguage) }] : [])]} onChange={sourceLanguage => update({ sourceLanguage: sourceLanguage === 'unselected' ? '' : sourceLanguage })} />
              <ToolField label={t('knowledge:fields.target_language')}><p data-testid="automatic-knowledge-target-language" className="flex min-h-8 items-center text-xs">{languageName(target)}</p></ToolField>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{t(englishOutput ? 'knowledge:automatic.english_source' : 'knowledge:automatic.source_help')}</p>
            {(availableRecipes.length > 0 || !!draft.recipeId) && <Choice testId="automatic-knowledge-recipe" disabled={busy || !library} label={t('knowledge:trial.recipe')} value={draft.recipeId ?? 'none'} options={[{ id: 'none', name: t('knowledge:trial.no_recipe') }, ...availableRecipes, ...(draft.recipeId && !availableRecipes.some(item => item.id === draft.recipeId) ? [{ id: draft.recipeId, name: t('knowledge:batch.unavailable_recipe') }] : [])]} onChange={id => {
              const chosen = library?.data.recipes.find(item => item.id === id);
              const { recipeId: _previous, ...rest } = draft;
              if (!busy) setDraft({ ...rest, ...(chosen ? { recipeId: chosen.id, sourceLanguage: englishOutput ? 'en' : chosen.languagePair.source } : {}) });
            }} />}
            <details data-testid="automatic-knowledge-collections" className="min-w-0 rounded-md border p-3" open={!draft.recipeId}>
              <summary className="cursor-pointer text-sm">{t('knowledge:trial.collections')}</summary>
              <div className="mt-3"><PagedItems items={collectionChoices} disabled={busy}>{item => <Toggle key={item.id} testId={`automatic-knowledge-collection-${item.id}`} label={item.name} checked={collections.has(item.id)} disabled={busy || recipe?.readCollectionIds.includes(item.id)} onChange={checked => update({ collectionIds: checked ? [...new Set([...draft.collectionIds, item.id])] : draft.collectionIds.filter(id => id !== item.id) })} />}</PagedItems></div>
              {library && !collectionChoices.length && <div className="mt-2 space-y-2"><p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.empty')}</p><Button asChild variant="outline" size="sm"><Link to="/tools/translation-knowledge">{t('knowledge:selection.manage')}</Link></Button></div>}
            </details>
            {(topicChoices.length > 0 || draft.documentTopicIds.length > 0) && <details data-testid="automatic-knowledge-topics" className="min-w-0 rounded-md border p-3" open>
              <summary className="cursor-pointer text-sm">{t('knowledge:batch.topics', { count: draft.documentTopicIds.length })}</summary>
              <p className="my-3 text-xs leading-5 text-muted-foreground">{t('knowledge:automatic.topics_help')}</p>
              <PagedItems items={topicChoices} disabled={busy}>{item => <Toggle key={item.id} testId={`automatic-knowledge-topic-${item.id}`} label={item.name} checked={draft.documentTopicIds.includes(item.id)} disabled={busy || draft.documentTopicIds.length >= 20 && !draft.documentTopicIds.includes(item.id)} onChange={checked => update({ documentTopicIds: checked ? [...new Set([...draft.documentTopicIds, item.id])] : draft.documentTopicIds.filter(id => id !== item.id) })} />}</PagedItems>
              {!topicChoices.length && <p className="text-xs text-muted-foreground">{t('knowledge:full.no_topics')}</p>}
            </details>}
            <ToolField label={t('knowledge:trial.requirements')} htmlFor={`${formId}-requirements`}><Textarea id={`${formId}-requirements`} data-testid="automatic-knowledge-instructions" disabled={busy || !library} className="min-h-16 text-xs" value={draft.instructions ?? (state.autoTranslation.instructions || recipe?.instructions || '')} maxLength={4000} onChange={event => update({ instructions: event.target.value })} /></ToolField>
            <ToolField label={t('knowledge:trial.context')} htmlFor={`${formId}-context`}><Textarea id={`${formId}-context`} data-testid="automatic-knowledge-context" disabled={busy || !library} className="min-h-16 text-xs" value={draft.context ?? recipe?.context ?? ''} maxLength={4000} onChange={event => update({ context: event.target.value })} /></ToolField>
            {entryChoices.length > 0 && <details data-testid="automatic-knowledge-exclusions" className="min-w-0 rounded-md border p-3"><summary className="cursor-pointer text-sm">{t('knowledge:trial.disable')}</summary><div className="mt-3"><PagedItems key={[...collections].join(',')} items={entryChoices} disabled={busy}>{item => <Toggle key={item.id} testId={`automatic-knowledge-exclude-${item.id}`} label={item.name} checked={draft.disabledEntryIds.includes(item.id)} disabled={busy} onChange={checked => update({ disabledEntryIds: checked ? [...new Set([...draft.disabledEntryIds, item.id])] : draft.disabledEntryIds.filter(id => id !== item.id) })} />}</PagedItems></div></details>}
          </fieldset>
          {!state.autoKnowledgeLoading && (problem || saveError) && <p data-testid="automatic-knowledge-problem" role="alert" className="text-xs leading-5 text-destructive">{t(problem ? problemKeys[problem] : 'knowledge:automatic.stale')}</p>}
          <p data-testid="automatic-knowledge-scope-help" className="text-xs leading-5 text-muted-foreground">{t('knowledge:automatic.scope_help')}</p>
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
        <Button data-testid="automatic-knowledge-cancel" size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('studio:cancel')}</Button>
        <Button data-testid="automatic-knowledge-refresh" size="sm" variant="outline" disabled={busy} onClick={() => void controller.refreshAutomaticKnowledge()}><RefreshCw />{t('studio:refresh')}</Button>
        <Button data-testid="automatic-knowledge-save" size="sm" disabled={busy || !!problem || !library || (!collections.size && !recipe)} onClick={() => {
          if (!library) return;
          if (controller.setAutomaticKnowledge({ ...draft, ...(englishOutput ? { sourceLanguage: 'en' } : {}) }, library.generation)) setOpen(false); else setSaveError(true);
        }}>{t('knowledge:automatic.save')}</Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </div>;
}
