import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BookOpen, Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToolField } from '../../_shared/ui/ToolField';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { emptySelection, hasMaterials } from '@/services/subtitle-studio/translation-draft';

export const materialLanguages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
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
/** Shared controlled configuration; execution always belongs to the containing panel. */
export function StudioMaterialsFields({ value, library, disabled, loading, onChange, topics, onTopicsChange, onRefresh, onAddTerm, mode, sourceLocked }: Props) {
  const { t } = useTranslation();
  const formId = useId();
  const [choosing, setChoosing] = useState(false), [search, setSearch] = useState('');
  const recipe = library?.data.recipes.find(item => item.id === value.recipeId);
  const selected = new Set([...value.collectionIds, ...recipe?.readCollectionIds ?? []]);
  const active = hasMaterials(value);
  const collections = library?.data.collections.filter(item => !item.archived && (!search.trim() || item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))) ?? [];
  const entries = library?.data.entries.filter(item => selected.has(item.collectionId)) ?? [];
  const requiredIds = new Set(entries.flatMap(item => item.scope.requiredSubjects.map(subject => subject.subjectId)));
  const subjects = library?.data.subjects.filter(item => !item.archived && (requiredIds.has(item.id) || topics.includes(item.id))) ?? [];
  const update = (patch: Partial<KnowledgeSelection>) => onChange({ ...value, ...patch });
  const problem = materialProblem(value, library, topics);
  const problemKeys = { source: 'knowledge:selection.source_required', target: 'knowledge:selection.target_required', recipe: 'knowledge:selection.recipe_language', resources: 'knowledge:recovery.selection_unavailable', library: 'knowledge:batch.library_error' } as const;
  return <section data-testid="studio-materials" className="min-w-0 space-y-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-sm font-medium"><BookOpen className="size-4" />{t('studio:materials.title')}</p>
      <div className="flex flex-wrap gap-1">
        <Button data-testid="studio-materials-choose" type="button" variant="ghost" size="sm" disabled={disabled} aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>{t('studio:materials.choose')}</Button>
        {active && <Button data-testid="studio-materials-clear" type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...emptySelection(value.languagePair.target), languagePair: value.languagePair, ...(value.instructions !== undefined ? { instructions: value.instructions } : {}) })}>{t('studio:materials.clear')}</Button>}
      </div>
    </div>
    <div data-testid="studio-materials-summary" className="flex min-w-0 flex-wrap gap-2">
      {!active && <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.none')}</p>}
      {value.recipeId && <span className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs"><span className="min-w-0 [overflow-wrap:anywhere]">{recipe?.name ?? t('knowledge:automatic.removed_item')}</span><Button type="button" variant="ghost" size="icon-xs" aria-label={t('studio:materials.remove', { name: recipe?.name ?? t('knowledge:automatic.removed_item') })} disabled={disabled} onClick={() => { const { recipeId: _id, ...rest } = value; onChange({ ...rest, collectionIds: [...selected], instructions: value.instructions ?? recipe?.instructions ?? '', context: value.context ?? recipe?.context ?? '' }); }}><X /></Button></span>}
      {[...selected].map(id => {
        const name = library?.data.collections.find(item => item.id === id)?.name ?? t('knowledge:automatic.removed_item');
        return <span key={id} className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs"><span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>{!recipe?.readCollectionIds.includes(id) && <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={t('studio:materials.remove', { name })} onClick={() => update({ collectionIds: value.collectionIds.filter(item => item !== id), disabledEntryIds: value.disabledEntryIds.filter(entryId => library?.data.entries.find(entry => entry.id === entryId)?.collectionId !== id), bindings: [], confirmations: [] })}><X /></Button>}</span>;
      })}
    </div>
    {choosing && <div data-testid="studio-materials-picker" className="min-w-0 space-y-3 border-t pt-3">
      <Input data-testid="studio-materials-search" aria-label={t('studio:materials.search')} placeholder={t('studio:materials.search')} className="h-8 text-xs" value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} />
      <div className="max-h-48 space-y-2 overflow-auto pr-1">{collections.map(item => <MaterialToggle key={item.id} testId={`studio-materials-collection-${item.id}`} label={item.name} checked={selected.has(item.id)} disabled={disabled || !!recipe?.readCollectionIds.includes(item.id)} onChange={checked => update({ collectionIds: checked ? [...new Set([...value.collectionIds, item.id])] : value.collectionIds.filter(id => id !== item.id), bindings: [], confirmations: [], disabledEntryIds: [] })} />)}</div>
      {!!library?.data.recipes.length && <ToolField label={t('studio:materials.recipe')} htmlFor={`${formId}-recipe`}><Select value={value.recipeId ?? 'none'} disabled={disabled} onValueChange={id => {
        const chosen = library.data.recipes.find(item => item.id === id);
        const { recipeId: _previous, ...rest } = value;
        onChange({ ...rest, ...(chosen ? { recipeId: chosen.id, languagePair: { source: sourceLocked ? value.languagePair.source : chosen.languagePair.source, target: value.languagePair.target }, instructions: value.instructions ?? chosen.instructions, context: value.context ?? chosen.context } : {}), bindings: [], confirmations: [] });
      }}><SelectTrigger id={`${formId}-recipe`} data-testid="studio-materials-recipe" className="h-auto min-h-8 w-full text-xs [&_[data-slot=select-value]]:whitespace-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('knowledge:trial.no_recipe')}</SelectItem>{library.data.recipes.filter(item => !item.archived || item.id === value.recipeId).map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></ToolField>}
      {!library?.data.collections.length && <p className="text-xs leading-5 text-muted-foreground">{t('knowledge:selection.empty')}</p>}
      <div className="flex flex-wrap gap-2"><Button asChild variant="ghost" size="sm"><Link to="/tools/translation-knowledge">{t('knowledge:selection.manage')}</Link></Button><Button type="button" variant="ghost" size="sm" disabled={disabled || loading} onClick={onRefresh}><RefreshCw className={loading ? 'animate-spin' : ''} />{t('studio:refresh')}</Button>{onAddTerm && <Button data-testid="studio-materials-add-term" type="button" variant="outline" size="sm" disabled={disabled} onClick={onAddTerm}><Plus />{t('studio:materials.add_term')}</Button>}</div>
    </div>}
    {loading && <p role="status" className="text-xs text-muted-foreground">{t('knowledge:loading')}</p>}
    {active && <>
      <ToolField label={t('knowledge:fields.source_language')} htmlFor={`${formId}-source`}><Select value={value.languagePair.source || 'none'} disabled={disabled || sourceLocked} onValueChange={source => update({ languagePair: { ...value.languagePair, source: source === 'none' ? '' : source }, bindings: [], confirmations: [] })}><SelectTrigger id={`${formId}-source`} data-testid="studio-materials-source" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('knowledge:automatic.choose_source')}</SelectItem>{materialLanguages.map(language => <SelectItem key={language} value={language}>{t(`knowledge:languages.${language}`)}</SelectItem>)}{value.languagePair.source && !materialLanguages.includes(value.languagePair.source as typeof materialLanguages[number]) && <SelectItem value={value.languagePair.source}>{value.languagePair.source}</SelectItem>}</SelectContent></Select></ToolField>
      {sourceLocked && <p className="text-xs text-muted-foreground">{t('knowledge:automatic.english_source')}</p>}
      {problem && <p role="status" data-testid="studio-materials-problem" className="text-xs leading-5 text-destructive">{t(problemKeys[problem])}</p>}
      {(subjects.length > 0 || topics.length > 0) && <details data-testid="studio-materials-topics" className="min-w-0"><summary className="cursor-pointer text-xs">{t('studio:materials.scope')}</summary><div className="mt-3 space-y-2"><p className="text-xs leading-5 text-muted-foreground">{t(mode === 'single' ? 'knowledge:full.topics_help' : mode === 'batch' ? 'knowledge:batch.topics_help' : 'knowledge:automatic.topics_help')}</p>{subjects.map(item => <MaterialToggle key={item.id} testId={`studio-materials-topic-${item.id}`} label={item.name} checked={topics.includes(item.id)} disabled={disabled || topics.length >= 20 && !topics.includes(item.id)} onChange={checked => onTopicsChange(checked ? [...topics, item.id] : topics.filter(id => id !== item.id))} />)}</div></details>}
      <details data-testid="studio-materials-more" className="min-w-0"><summary className="cursor-pointer text-xs">{t('studio:materials.more')}</summary><div className="mt-3 space-y-3">
        <ToolField label={t('knowledge:trial.context')} htmlFor={`${formId}-context`}><Textarea id={`${formId}-context`} data-testid="studio-materials-context" className="min-h-16 text-xs" maxLength={4000} disabled={disabled} value={value.context ?? recipe?.context ?? ''} onChange={event => update({ context: event.target.value })} /></ToolField>
        {!!entries.length && <details><summary className="cursor-pointer text-xs">{t('knowledge:trial.disable')}</summary><div className="mt-3 max-h-56 space-y-2 overflow-auto">{entries.map(entry => <MaterialToggle key={entry.id} testId={`studio-materials-exclude-${entry.id}`} label={entry.title} checked={value.disabledEntryIds.includes(entry.id)} disabled={disabled} onChange={checked => update({ disabledEntryIds: checked ? [...new Set([...value.disabledEntryIds, entry.id])] : value.disabledEntryIds.filter(id => id !== entry.id) })} />)}</div></details>}
      </div></details>
    </>}
  </section>;
}
