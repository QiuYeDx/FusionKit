import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, BookOpen, Check, ChevronDown, FolderOpen, Layers3, LockKeyhole, Plus, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DialogMotionRegion, DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { KnowledgeDisclosure } from '@/pages/TranslationKnowledge/KnowledgeDisclosure';
import { ToolField } from '../../_shared/ui/ToolField';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { emptySelection, hasMaterials } from '@/services/subtitle-studio/translation-draft';
import './StudioMaterialsFields.css';

export const materialLanguages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
const materialLanguageKeys = { ja: 'knowledge:languages.ja', en: 'knowledge:languages.en', 'zh-Hans': 'knowledge:languages.zh-Hans', 'zh-Hant': 'knowledge:languages.zh-Hant', ko: 'knowledge:languages.ko', fr: 'knowledge:languages.fr', de: 'knowledge:languages.de', es: 'knowledge:languages.es', ru: 'knowledge:languages.ru', pt: 'knowledge:languages.pt' } as const;
export function MaterialToggle({ label, checked, disabled, onChange, testId }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; testId?: string }) {
  const id = useId();
  return <label htmlFor={id} className="flex min-w-0 items-start gap-2 text-xs leading-5"><Checkbox id={id} data-testid={testId} className="mt-0.5 shrink-0" checked={checked} disabled={disabled} onCheckedChange={next => onChange(next === true)} /><span className="min-w-0 [overflow-wrap:anywhere]">{label}</span></label>;
}
export function materialProblem(selection: KnowledgeSelection, library: LibrarySnapshot | null, topics: string[]): 'source' | 'target' | 'recipe' | 'resources' | 'library' | null {
  if (!hasMaterials(selection)) return null;
  if (!library || library.maintenance?.cleanupPending) return 'library';
  if (!knowledgeSelectionSchema.shape.languagePair.shape.source.safeParse(selection.languagePair.source).success) return 'source';
  if (!knowledgeSelectionSchema.shape.languagePair.shape.target.safeParse(selection.languagePair.target).success) return 'target';
  const recipe = library.data.recipes.find(item => item.id === selection.recipeId);
  if (recipe && (recipe.languagePair.source !== selection.languagePair.source || recipe.languagePair.target !== selection.languagePair.target)) return 'recipe';
  const ids = new Set([...selection.collectionIds, ...recipe?.readCollectionIds ?? []]);
  if (selection.recipeId && (!recipe || recipe.archived)
    || [...ids].some(id => !library.data.collections.some(item => item.id === id && !item.archived))
    || topics.some(id => !library.data.subjects.some(item => item.id === id && !item.archived))
    || selection.disabledEntryIds.some(id => !library.data.entries.some(item => item.id === id && ids.has(item.collectionId)))) return 'resources';
  return null;
}

type Props = {
  value: KnowledgeSelection; library: LibrarySnapshot | null; disabled: boolean; loading?: boolean;
  onChange: (value: KnowledgeSelection) => void; topics: string[]; onTopicsChange: (topics: string[]) => void;
  onRefresh: () => void; onAddTerm?: () => void; mode: 'single' | 'batch' | 'automatic'; sourceLocked?: boolean;
};

/** The picker edits the current selection immediately; execution stays with its parent. */
export function StudioMaterialsFields({ value, library, disabled, loading, onChange, topics, onTopicsChange, onRefresh, onAddTerm, mode, sourceLocked }: Props) {
  const { t } = useTranslation();
  const formId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [choosing, setChoosing] = useState(false), [search, setSearch] = useState('');
  const recipe = library?.data.recipes.find(item => item.id === value.recipeId);
  const selected = new Set([...value.collectionIds, ...recipe?.readCollectionIds ?? []]);
  const active = hasMaterials(value);
  const availableCollections = library?.data.collections.filter(item => !item.archived) ?? [];
  const collections = availableCollections.filter(item => !search.trim() || item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const recipes = library?.data.recipes.filter(item => !item.archived || item.id === value.recipeId) ?? [];
  const entries = library?.data.entries.filter(item => selected.has(item.collectionId)) ?? [];
  const requiredIds = new Set(entries.flatMap(item => item.scope.requiredSubjects.map(subject => subject.subjectId)));
  const subjects = library?.data.subjects.filter(item => !item.archived && (requiredIds.has(item.id) || topics.includes(item.id))) ?? [];
  const unavailableTopics = topics.filter(id => !subjects.some(item => item.id === id));
  const unavailableExclusions = value.disabledEntryIds.filter(id => !entries.some(item => item.id === id));
  const collectionInfo = useMemo(() => {
    const result = new Map<string, { count: number; pairs: Map<string, { source: string; target: string }> }>();
    for (const entry of library?.data.entries ?? []) {
      const info = result.get(entry.collectionId) ?? { count: 0, pairs: new Map() };
      info.count++;
      info.pairs.set(`${entry.scope.languagePair.source}:${entry.scope.languagePair.target}`, entry.scope.languagePair);
      result.set(entry.collectionId, info);
    }
    return result;
  }, [library]);
  const languageName = (language: string) => language in materialLanguageKeys ? t(materialLanguageKeys[language as keyof typeof materialLanguageKeys]) : language;
  const pairName = (pair: { source: string; target: string }) => t('materials:selection.language_pair', { source: languageName(pair.source), target: languageName(pair.target) });
  const update = (patch: Partial<KnowledgeSelection>) => onChange({ ...value, ...patch });
  const detachRecipe = () => {
    const { recipeId: _id, ...rest } = value;
    return { ...rest, collectionIds: [...selected], instructions: value.instructions ?? recipe?.instructions ?? '', context: value.context ?? recipe?.context ?? '' };
  };
  const removeCollection = (id: string) => {
    // A missing preset-owned collection is removable by detaching that preset.
    const next = recipe?.readCollectionIds.includes(id) ? detachRecipe() : value;
    onChange({ ...next, collectionIds: next.collectionIds.filter(item => item !== id), disabledEntryIds: next.disabledEntryIds.filter(entryId => library?.data.entries.find(entry => entry.id === entryId)?.collectionId !== id), bindings: [], confirmations: [] });
  };
  const problem = materialProblem(value, library, topics);
  const problemKeys = { source: 'knowledge:selection.source_required', target: 'knowledge:selection.target_required', recipe: 'knowledge:selection.recipe_language', resources: 'knowledge:recovery.selection_unavailable', library: 'knowledge:batch.library_error' } as const;
  const unavailableLibrary = !loading && (!library || library.maintenance?.cleanupPending);

  return <section data-testid="studio-materials" className="studio-materials-card">
    <div data-testid="studio-materials-heading" className="studio-materials-heading">
      <div className="studio-materials-heading-content">
        <div className="studio-materials-title"><BookOpen aria-hidden="true" /><h3 data-testid="studio-materials-heading-title">{t('studio:materials.title')}</h3>{selected.size > 0 && <span className="studio-materials-count">{selected.size}</span>}</div>
        <div data-testid="studio-materials-summary" className="studio-materials-summary">
          {!active && <p className="studio-materials-empty-summary">{t('studio:materials.none')}<span>{t('materials:selection.empty_hint')}</span></p>}
          {value.recipeId && <span className="studio-materials-chip" data-invalid={!recipe || recipe.archived}>
            <Layers3 className="size-3.5" aria-hidden="true" /><span className="studio-materials-chip-name"><span className="studio-materials-chip-prefix">{t('materials:selection.preset')}</span>{recipe?.name ?? t('knowledge:automatic.removed_item')}{(!recipe || recipe.archived) && <span className="studio-materials-chip-state">{t('materials:selection.unavailable')}</span>}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={t('studio:materials.remove', { name: recipe?.name ?? t('knowledge:automatic.removed_item') })} disabled={disabled} onClick={() => onChange(detachRecipe())}><X /></Button>
          </span>}
          {[...selected].map(id => {
            const collection = library?.data.collections.find(item => item.id === id);
            const name = collection?.name ?? t('knowledge:automatic.removed_item');
            const inherited = !!recipe?.readCollectionIds.includes(id);
            const unavailable = !collection || collection.archived;
            return <span key={id} className="studio-materials-chip" data-invalid={unavailable}>
              {inherited && <LockKeyhole className="size-3" aria-label={t('materials:selection.from_preset')} />}
              <span className="studio-materials-chip-name">{name}{unavailable && <span className="studio-materials-chip-state">{t('materials:selection.unavailable')}</span>}</span>
              {(!inherited || unavailable) && <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={t('studio:materials.remove', { name })} onClick={() => removeCollection(id)}><X /></Button>}
            </span>;
          })}
        </div>
      </div>
      <div className="studio-materials-heading-actions">
        {active && <Button data-testid="studio-materials-clear" type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => onChange({ ...emptySelection(value.languagePair.target), languagePair: value.languagePair, ...(value.instructions !== undefined ? { instructions: value.instructions } : {}) })}>{t('studio:materials.clear')}</Button>}
        <Popover open={choosing} onOpenChange={next => { if (!disabled || !next) setChoosing(next); }} modal={false}>
          <PopoverTrigger asChild><Button data-testid="studio-materials-choose" type="button" variant="outline" size="sm" disabled={disabled} aria-expanded={choosing} aria-controls={`${formId}-picker`}>{t(active ? 'materials:selection.change' : 'studio:materials.choose')}<ChevronDown className="size-3.5" aria-hidden="true" /></Button></PopoverTrigger>
          <PopoverContent id={`${formId}-picker`} data-testid="studio-materials-picker" aria-labelledby={`${formId}-picker-title`} className="studio-materials-picker" align="end" sideOffset={8} collisionPadding={16} onEscapeKeyDown={event => { event.stopPropagation(); }} onOpenAutoFocus={event => { if (searchRef.current && !searchRef.current.disabled) { event.preventDefault(); searchRef.current.focus(); } }}>
            <div className="studio-materials-picker-heading"><span id={`${formId}-picker-title`}>{t('studio:materials.choose')}</span><span>{t('materials:selection.selected_count', { count: selected.size })}</span></div>
            <div className="studio-materials-picker-body">
              {(recipes.length > 0 || value.recipeId) && <div className="studio-materials-preset">
                <ToolField label={t('materials:selection.preset')} htmlFor={`${formId}-recipe`}><Select value={value.recipeId ?? 'none'} disabled={disabled || unavailableLibrary || loading} onValueChange={id => {
                  const chosen = library?.data.recipes.find(item => item.id === id);
                  const { recipeId: _previous, ...rest } = value;
                  onChange({ ...rest, ...(chosen ? { recipeId: chosen.id, languagePair: { source: sourceLocked ? value.languagePair.source : chosen.languagePair.source, target: value.languagePair.target }, instructions: value.instructions ?? chosen.instructions, context: value.context ?? chosen.context } : {}), bindings: [], confirmations: [] });
                }}><SelectTrigger id={`${formId}-recipe`} data-testid="studio-materials-recipe" className="h-auto min-h-8 w-full text-xs [&_[data-slot=select-value]]:whitespace-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('knowledge:trial.no_recipe')}</SelectItem>{recipes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}{value.recipeId && !recipe && <SelectItem value={value.recipeId}>{t('knowledge:automatic.removed_item')}</SelectItem>}</SelectContent></Select></ToolField>
                <p>{recipe ? t('materials:selection.preset_includes', { count: recipe.readCollectionIds.length, pair: pairName(recipe.languagePair) }) : t('materials:selection.preset_help')}</p>
              </div>}
              <div className="studio-materials-collection-heading"><FolderOpen className="size-3.5" aria-hidden="true" /><span>{t('materials:selection.collections')}</span></div>
              <div className="studio-materials-search"><Search className="size-3.5" aria-hidden="true" /><Input ref={searchRef} data-testid="studio-materials-search" aria-label={t('studio:materials.search')} placeholder={t('studio:materials.search')} className="h-8 pl-8 text-xs" value={search} disabled={disabled || unavailableLibrary || loading} onChange={event => setSearch(event.target.value)} /></div>
              <div className="studio-materials-collection-list">
                <DialogMotionRegion><DialogTransition transitionKey={loading ? 'loading' : unavailableLibrary ? 'unavailable' : collections.map(item => item.id).join(':') || 'empty'} stageClassName="grid gap-1">
                {loading ? <div className="studio-materials-picker-empty" role="status"><RefreshCw className="size-4 animate-spin" aria-hidden="true" /><p>{t('knowledge:loading')}</p></div>
                  : unavailableLibrary ? <div className="studio-materials-picker-empty" role="status"><AlertCircle className="size-4" aria-hidden="true" /><p>{t('materials:selection.library_unavailable')}</p><Button type="button" variant="outline" size="xs" disabled={disabled} onClick={onRefresh}>{t('materials:selection.retry')}</Button></div>
                    : availableCollections.length === 0 ? <div className="studio-materials-picker-empty"><FolderOpen className="size-5" aria-hidden="true" /><p>{t('materials:selection.empty_library')}</p><span>{t('materials:selection.empty_library_help')}</span></div>
                      : collections.length === 0 ? <div data-testid="studio-materials-search-empty" className="studio-materials-picker-empty" role="status"><Search className="size-4" aria-hidden="true" /><p>{t('materials:selection.no_results')}</p><Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => setSearch('')}>{t('materials:selection.clear_search')}</Button></div>
                        : collections.map(item => {
                          const inherited = !!recipe?.readCollectionIds.includes(item.id);
                          const info = collectionInfo.get(item.id);
                          const pair = item.defaultLanguagePair ?? (info?.pairs.size === 1 ? [...info.pairs.values()][0] : undefined);
                          return <label key={item.id} htmlFor={`${formId}-collection-${item.id}`} className="studio-materials-collection-row" data-selected={selected.has(item.id)} data-locked={inherited}>
                            <Checkbox id={`${formId}-collection-${item.id}`} data-testid={`studio-materials-collection-${item.id}`} checked={selected.has(item.id)} disabled={disabled || inherited} onCheckedChange={checked => update({ collectionIds: checked === true ? [...new Set([...value.collectionIds, item.id])] : value.collectionIds.filter(id => id !== item.id), bindings: [], confirmations: [], disabledEntryIds: [] })} />
                            <span className="studio-materials-collection-label"><span>{item.name}</span><span className="studio-materials-collection-meta"><span>{pair ? pairName(pair) : t(info?.pairs.size ? 'materials:selection.multiple_languages' : 'materials:selection.language_unspecified')}</span><span>{t('materials:selection.entry_count', { count: info?.count ?? 0 })}</span>{inherited && <span className="studio-materials-preset-source"><LockKeyhole className="size-3" aria-hidden="true" />{t('materials:selection.from_preset')}</span>}</span></span>
                          </label>;
                        })}
                </DialogTransition></DialogMotionRegion>
              </div>
            </div>
            <div className="studio-materials-picker-footer">
              <div className="studio-materials-picker-tools"><Button asChild variant="ghost" size="xs" className={disabled ? 'pointer-events-none opacity-50' : undefined}><Link to="/tools/translation-knowledge" aria-disabled={disabled} tabIndex={disabled ? -1 : undefined} onClick={event => { if (disabled) event.preventDefault(); else setChoosing(false); }}>{t('materials:selection.manage')}<ArrowUpRight className="size-3" aria-hidden="true" /></Link></Button><Button data-testid="studio-materials-refresh" type="button" variant="ghost" size="xs" disabled={disabled || loading} onClick={onRefresh}><RefreshCw className={loading ? 'size-3 animate-spin' : 'size-3'} aria-hidden="true" />{t('studio:refresh')}</Button>{onAddTerm && <Button data-testid="studio-materials-add-term" type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => { setChoosing(false); onAddTerm(); }}><Plus className="size-3" aria-hidden="true" />{t('studio:materials.add_term')}</Button>}</div>
              <Button data-testid="studio-materials-done" type="button" size="sm" onClick={() => setChoosing(false)}><Check className="size-3.5" aria-hidden="true" />{t('materials:selection.done')}</Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
    {loading && !choosing && <p role="status" className="studio-materials-loading"><RefreshCw className="size-3 animate-spin" aria-hidden="true" />{t('knowledge:loading')}</p>}
    <DialogTransition transitionKey="configuration">{active && <div className="studio-materials-configuration">
      <div className="studio-materials-source-row"><label htmlFor={`${formId}-source`}>{t('knowledge:fields.source_language')}</label><Select value={value.languagePair.source || 'none'} disabled={disabled || sourceLocked} onValueChange={source => update({ languagePair: { ...value.languagePair, source: source === 'none' ? '' : source }, bindings: [], confirmations: [] })}><SelectTrigger id={`${formId}-source`} data-testid="studio-materials-source" className="h-8 min-w-0 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('knowledge:automatic.choose_source')}</SelectItem>{materialLanguages.map(language => <SelectItem key={language} value={language}>{t(`knowledge:languages.${language}`)}</SelectItem>)}{value.languagePair.source && !materialLanguages.includes(value.languagePair.source as typeof materialLanguages[number]) && <SelectItem value={value.languagePair.source}>{value.languagePair.source}</SelectItem>}</SelectContent></Select></div>
      {sourceLocked && <p className="studio-materials-help">{t('knowledge:automatic.english_source')}</p>}
      {problem && <div role="status" data-testid="studio-materials-problem" className="studio-materials-problem"><AlertCircle className="size-3.5" aria-hidden="true" /><p>{t(problemKeys[problem])}</p>{problem === 'library' && <Button type="button" variant="outline" size="xs" disabled={disabled || loading} onClick={onRefresh}>{t('materials:selection.retry')}</Button>}</div>}
      <div className="studio-materials-disclosures">
      {(subjects.length > 0 || topics.length > 0) && <KnowledgeDisclosure data-testid="studio-materials-topics" variant="section" title={t('studio:materials.scope')} description={topics.length > 0 ? t('materials:selection.scope_count', { count: topics.length }) : undefined} className="studio-materials-disclosure"><p className="studio-materials-help">{t(mode === 'single' ? 'knowledge:full.topics_help' : mode === 'batch' ? 'knowledge:batch.topics_help' : 'knowledge:automatic.topics_help')}</p><div className="studio-materials-options">{subjects.map(item => <MaterialToggle key={item.id} testId={`studio-materials-topic-${item.id}`} label={item.name} checked={topics.includes(item.id)} disabled={disabled || topics.length >= 20 && !topics.includes(item.id)} onChange={checked => onTopicsChange(checked ? [...topics, item.id] : topics.filter(id => id !== item.id))} />)}{unavailableTopics.map(id => <MaterialToggle key={id} testId={`studio-materials-topic-${id}`} label={t('materials:selection.unavailable_scope')} checked disabled={disabled} onChange={() => onTopicsChange(topics.filter(item => item !== id))} />)}</div></KnowledgeDisclosure>}
      <KnowledgeDisclosure data-testid="studio-materials-more" variant="section" title={t('studio:materials.more')} description={value.disabledEntryIds.length > 0 ? t('materials:selection.exclusion_count', { count: value.disabledEntryIds.length }) : undefined} className="studio-materials-disclosure">
        <ToolField label={t('knowledge:trial.context')} htmlFor={`${formId}-context`}><Textarea id={`${formId}-context`} data-testid="studio-materials-context" className="min-h-16 text-xs" maxLength={4000} disabled={disabled} value={value.context ?? recipe?.context ?? ''} onChange={event => update({ context: event.target.value })} /></ToolField>
        {(entries.length > 0 || unavailableExclusions.length > 0) && <KnowledgeDisclosure data-testid="studio-materials-exclusions" variant="inline" title={t('knowledge:trial.disable')}><div className="studio-materials-options studio-materials-exclusion-list">{entries.map(entry => <MaterialToggle key={entry.id} testId={`studio-materials-exclude-${entry.id}`} label={entry.title} checked={value.disabledEntryIds.includes(entry.id)} disabled={disabled} onChange={checked => update({ disabledEntryIds: checked ? [...new Set([...value.disabledEntryIds, entry.id])] : value.disabledEntryIds.filter(id => id !== entry.id) })} />)}{unavailableExclusions.map(id => <MaterialToggle key={id} testId={`studio-materials-exclude-${id}`} label={t('materials:selection.unavailable_exclusion')} checked disabled={disabled} onChange={() => update({ disabledEntryIds: value.disabledEntryIds.filter(item => item !== id) })} />)}</div></KnowledgeDisclosure>}
      </KnowledgeDisclosure>
      </div>
    </div>}</DialogTransition>
  </section>;
}
