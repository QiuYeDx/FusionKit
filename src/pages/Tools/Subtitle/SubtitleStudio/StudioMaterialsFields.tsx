import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, BookmarkPlus, BookOpen, Check, ChevronDown, Ellipsis, FolderOpen, History, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ClipPathTabs } from '@/components/qiuye-ui/clip-path-tabs';
import { DialogMotionRegion, DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { KnowledgeDisclosure } from '@/pages/TranslationKnowledge/KnowledgeDisclosure';
import { StudioScrollFade } from './StudioScrollFade';
import { ToolField } from '../../_shared/ui/ToolField';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { Collection, LanguagePair, Preset } from '@/translation-knowledge/schemas';
import { entrySummary } from '@/translation-knowledge/summary';
import { announceKnowledgeChange } from '@/translation-knowledge/library-events';
import { emptySelection, hasMaterials } from '@/services/subtitle-studio/translation-draft';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import './StudioMaterialsFields.css';

export const materialLanguages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;
const materialLanguageKeys = { ja: 'knowledge:languages.ja', en: 'knowledge:languages.en', 'zh-Hans': 'knowledge:languages.zh-Hans', 'zh-Hant': 'knowledge:languages.zh-Hant', ko: 'knowledge:languages.ko', fr: 'knowledge:languages.fr', de: 'knowledge:languages.de', es: 'knowledge:languages.es', ru: 'knowledge:languages.ru', pt: 'knowledge:languages.pt' } as const;
export function MaterialToggle({ label, checked, disabled, onChange, testId }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; testId?: string }) {
  const id = useId();
  return <label htmlFor={id} className="flex min-w-0 items-start gap-2 text-xs leading-5"><Checkbox id={id} data-testid={testId} className="mt-0.5 shrink-0" checked={checked} disabled={disabled} onCheckedChange={next => onChange(next === true)} /><span className="min-w-0 [overflow-wrap:anywhere]">{label}</span></label>;
}
/** Whether a collection translates the chosen direction; an unset source accepts any source. */
const fits = (pair: LanguagePair, selection: Pick<KnowledgeSelection, 'languagePair'>) =>
  pair.target === selection.languagePair.target && (!selection.languagePair.source || pair.source === selection.languagePair.source);
export function materialProblem(selection: KnowledgeSelection, library: LibrarySnapshot | null): 'source' | 'target' | 'language' | 'resources' | 'library' | null {
  if (!hasMaterials(selection)) return null;
  if (!library) return 'library';
  if (!knowledgeSelectionSchema.shape.languagePair.shape.source.safeParse(selection.languagePair.source).success) return 'source';
  if (!knowledgeSelectionSchema.shape.languagePair.shape.target.safeParse(selection.languagePair.target).success) return 'target';
  const chosen = selection.collectionIds.map(id => library.data.collections.find(item => item.id === id));
  if (chosen.some(item => !item || item.archived)
    || selection.disabledEntryIds.some(id => !library.data.entries.some(item => item.id === id && selection.collectionIds.includes(item.collectionId)))) return 'resources';
  if (chosen.some(item => !fits(item!.languagePair, selection))) return 'language';
  return null;
}

const GROUP_SEPARATOR = ' · ';
export type NamedGroup<T> = { name: string; items: { item: T; label: string }[] };
export type CollectionGroup = { name: string; items: { collection: Collection; label: string }[] };
/**
 * Collections named "Group · Topic" (绝区零 · 人物与阵营, 共通 01 · 字幕基本要求) read as groups, a trailing
 * number on the group part being ordering only. A handful of collections, or names without a shared
 * prefix, stay one plain list.
 */
export function groupByName<T extends { name: string }>(items: readonly T[]): NamedGroup<T>[] {
  const groups = new Map<string, NamedGroup<T>['items']>();
  for (const item of items) {
    const at = item.name.indexOf(GROUP_SEPARATOR);
    const grouped = at > 0 && at + GROUP_SEPARATOR.length < item.name.length;
    const name = grouped ? item.name.slice(0, at).replace(/\s+\d+$/u, '') : '';
    groups.set(name, [...(groups.get(name) ?? []), { item, label: grouped ? item.name.slice(at + GROUP_SEPARATOR.length) : item.name }]);
  }
  if (items.length <= 6 || groups.size <= 1) return [{ name: '', items: items.map(item => ({ item, label: item.name })) }];
  // Unprefixed names come last, under no heading.
  return [...groups].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1)).map(([name, list]) => ({ name, items: list }));
}
export const groupCollections = (items: readonly Collection[]): CollectionGroup[] =>
  groupByName(items).map(group => ({ name: group.name, items: group.items.map(({ item, label }) => ({ collection: item, label })) }));
type PickerTab = 'collections' | 'presets';

type Props = {
  value: KnowledgeSelection; library: LibrarySnapshot | null; disabled: boolean; loading?: boolean;
  onChange: (value: KnowledgeSelection) => void; onLibraryChange: (library: LibrarySnapshot) => void;
  onRefresh: () => void; onAddTerm?: () => void; sourceLocked?: boolean;
};
type PresetEdit = { kind: 'save' } | { kind: 'rename'; preset: Preset } | { kind: 'delete'; preset: Preset };

/** The picker edits the current selection immediately; execution stays with its parent. */
export function StudioMaterialsFields({ value, library, disabled, loading, onChange, onLibraryChange, onRefresh, onAddTerm, sourceLocked }: Props) {
  const { t } = useTranslation();
  const formId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [choosing, setChoosing] = useState(false), [search, setSearch] = useState('');
  const [tab, setTab] = useState<PickerTab>('collections'), [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [edit, setEdit] = useState<PresetEdit | null>(null), [presetName, setPresetName] = useState('');
  const [presetPending, setPresetPending] = useState(false), [presetError, setPresetError] = useState(false), [skipped, setSkipped] = useState(0);
  const recentSets = useStudioPreferences(state => state.recentKnowledgeSets);
  const selected = new Set(value.collectionIds);
  const active = hasMaterials(value);
  const collectionsById = useMemo(() => new Map((library?.data.collections ?? []).map(item => [item.id, item])), [library]);
  const usable = (id: string) => { const item = collectionsById.get(id); return !!item && !item.archived && fits(item.languagePair, value); };
  const availableCollections = library?.data.collections.filter(item => !item.archived) ?? [];
  const collections = availableCollections.filter(item => !search.trim() || item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const presets = library?.data.presets ?? [];
  const groups = useMemo(() => groupCollections(collections), [collections]);
  const presetGroups = useMemo(() => groupByName(presets).map(group => ({ name: group.name, items: group.items.map(({ item, label }) => ({ preset: item, label })) })), [presets]);
  const mixedDirections = new Set(availableCollections.map(item => `${item.languagePair.source}>${item.languagePair.target}`)).size > 1;
  const recent = recentSets.filter(item => fits(item.languagePair, value) && item.collectionIds.some(usable));
  const entries = library?.data.entries.filter(item => selected.has(item.collectionId)) ?? [];
  const unavailableExclusions = value.disabledEntryIds.filter(id => !entries.some(item => item.id === id));
  const entryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of library?.data.entries ?? []) counts.set(entry.collectionId, (counts.get(entry.collectionId) ?? 0) + 1);
    return counts;
  }, [library]);
  const languageName = (language: string) => language in materialLanguageKeys ? t(materialLanguageKeys[language as keyof typeof materialLanguageKeys]) : language;
  const pairName = (pair: LanguagePair) => t('materials:selection.language_pair', { source: languageName(pair.source), target: languageName(pair.target) });
  const update = (patch: Partial<KnowledgeSelection>) => onChange({ ...value, ...patch });
  const toggleCollection = (collection: Collection, checked: boolean) => {
    const collectionIds = checked ? [...new Set([...value.collectionIds, collection.id])] : value.collectionIds.filter(id => id !== collection.id);
    // The first collection settles an unset source language.
    const source = value.languagePair.source || (checked ? collection.languagePair.source : '');
    onChange({ ...value, languagePair: { ...value.languagePair, source }, collectionIds,
      disabledEntryIds: value.disabledEntryIds.filter(id => library?.data.entries.find(entry => entry.id === id)?.collectionId !== collection.id || checked) });
    setSkipped(0);
  };
  /** Ticks every allowed collection of a group, or clears the whole group. */
  const toggleGroup = (items: Collection[], checked: boolean) => {
    if (!checked) {
      const removed = new Set(items.map(item => item.id));
      onChange({ ...value, collectionIds: value.collectionIds.filter(id => !removed.has(id)),
        disabledEntryIds: value.disabledEntryIds.filter(id => !removed.has(library?.data.entries.find(entry => entry.id === id)?.collectionId ?? '')) });
    } else {
      // The first collection settles an unset source language, as a single tick does.
      const first = items.find(item => fits(item.languagePair, value));
      const pair = { ...value.languagePair, source: value.languagePair.source || first?.languagePair.source || '' };
      const added = items.filter(item => fits(item.languagePair, { languagePair: pair })).map(item => item.id);
      onChange({ ...value, languagePair: pair, collectionIds: [...new Set([...value.collectionIds, ...added])] });
    }
    setSkipped(0);
  };
  const applySet = (source: string, collectionIds: string[], extra: Pick<KnowledgeSelection, 'instructions' | 'context'> = {}) => {
    const pair = { source: sourceLocked ? value.languagePair.source : source, target: value.languagePair.target };
    const kept = collectionIds.filter(id => { const item = collectionsById.get(id); return !!item && !item.archived && fits(item.languagePair, { languagePair: pair }); });
    onChange({ ...value, languagePair: pair, collectionIds: kept, disabledEntryIds: [], ...extra });
    setSkipped(collectionIds.length - kept.length);
  };
  const setNames = (ids: string[]) => ids.map(id => collectionsById.get(id)?.name ?? t('knowledge:automatic.removed_item')).join(' · ');
  const canSavePreset = active && !materialProblem(value, library) && !!library;
  const persist = async (operation: () => Promise<{ ok: true; value: LibrarySnapshot } | { ok: false }>) => {
    setPresetPending(true); setPresetError(false);
    try {
      const result = await operation();
      if (!result.ok) { setPresetError(true); return; }
      onLibraryChange(result.value); announceKnowledgeChange(result.value);
      setEdit(null); setPresetName('');
    } catch { setPresetError(true); }
    finally { setPresetPending(false); }
  };
  const submitPreset = (event: FormEvent) => {
    event.preventDefault();
    const name = presetName.trim();
    if (!library || !name || presetPending || !edit) return;
    if (edit.kind === 'save') {
      const record: Preset = { id: crypto.randomUUID(), revision: 1, name, languagePair: value.languagePair, collectionIds: [...value.collectionIds],
        instructions: value.instructions ?? '', context: value.context ?? '' };
      void persist(() => window.translationKnowledge.saveRecords({ generation: library.generation, items: [{ group: 'presets', record }] }));
    } else if (edit.kind === 'rename') {
      void persist(() => window.translationKnowledge.saveRecords({ generation: library.generation, items: [{ group: 'presets', record: { ...edit.preset, name } }] }));
    }
  };
  const deletePreset = (preset: Preset) => {
    if (!library || presetPending) return;
    void persist(async () => {
      const result = await window.translationKnowledge.deleteRecords({ generation: library.generation, items: [{ group: 'presets', id: preset.id }] });
      return result.ok ? { ok: true as const, value: result.value.snapshot } : { ok: false as const };
    });
  };
  const startEdit = (next: PresetEdit | null) => { setEdit(next); setPresetError(false); setPresetName(next?.kind === 'rename' ? next.preset.name : ''); };
  const problem = materialProblem(value, library);
  const problemKeys = { source: 'knowledge:selection.source_required', target: 'knowledge:selection.target_required', language: 'materials:selection.language_mismatch', resources: 'knowledge:recovery.selection_unavailable', library: 'knowledge:batch.library_error' } as const;
  const unavailableLibrary = !loading && !library;
  const busy = disabled || unavailableLibrary || !!loading;
  const presetForm = (label: string) => <form className="studio-materials-preset-form" onSubmit={submitPreset}>
    <Input data-testid="studio-materials-preset-name" aria-label={label} placeholder={label} value={presetName} maxLength={160} className="h-8 text-xs" disabled={presetPending} autoFocus onChange={event => setPresetName(event.target.value)} />
    <Button data-testid="studio-materials-preset-confirm" type="submit" size="xs" disabled={presetPending || !presetName.trim()}>{presetPending ? <RefreshCw className="size-3 animate-spin" aria-hidden="true" /> : <Check className="size-3" aria-hidden="true" />}{t('materials:selection.preset_save')}</Button>
    <Button type="button" size="xs" variant="ghost" disabled={presetPending} onClick={() => startEdit(null)}>{t('materials:selection.cancel')}</Button>
  </form>;

  return <section data-testid="studio-materials" className="studio-materials-card">
    <div data-testid="studio-materials-heading" className="studio-materials-heading">
      <div className="studio-materials-heading-content">
        <div className="studio-materials-title"><BookOpen aria-hidden="true" /><h3 data-testid="studio-materials-heading-title">{t('studio:materials.title')}</h3>{selected.size > 0 && <span className="studio-materials-count">{selected.size}</span>}</div>
        <div data-testid="studio-materials-summary" className="studio-materials-summary">
          {!active && <p className="studio-materials-empty-summary">{t('studio:materials.none')}<span>{t('materials:selection.empty_hint')}</span></p>}
          {value.collectionIds.map(id => {
            const collection = collectionsById.get(id);
            const name = collection?.name ?? t('knowledge:automatic.removed_item');
            const unavailable = !collection || collection.archived;
            return <span key={id} className="studio-materials-chip" data-invalid={unavailable || !usable(id)}>
              <span className="studio-materials-chip-name">{name}{unavailable && <span className="studio-materials-chip-state">{t('materials:selection.unavailable')}</span>}</span>
              <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={t('studio:materials.remove', { name })} onClick={() => update({ collectionIds: value.collectionIds.filter(item => item !== id), disabledEntryIds: value.disabledEntryIds.filter(entryId => library?.data.entries.find(entry => entry.id === entryId)?.collectionId !== id) })}><X /></Button>
            </span>;
          })}
        </div>
      </div>
      <div className="studio-materials-heading-actions">
        {active && <Button data-testid="studio-materials-clear" type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => onChange({ ...emptySelection(value.languagePair.target), languagePair: value.languagePair, ...(value.instructions !== undefined ? { instructions: value.instructions } : {}) })}>{t('studio:materials.clear')}</Button>}
        {/* A centred panel rather than a popover: anchored to this button it only got the height
            left above or below it, a few rows of a real library. */}
        <DialogPrimitive.Root open={choosing} onOpenChange={next => { if (!disabled || !next) { setChoosing(next); if (!next) startEdit(null); } }}>
          <DialogPrimitive.Trigger asChild><Button data-testid="studio-materials-choose" type="button" variant="outline" size="sm" disabled={disabled} aria-expanded={choosing} aria-controls={`${formId}-picker`}>{t(active ? 'materials:selection.change' : 'studio:materials.choose')}<ChevronDown className="size-3.5" aria-hidden="true" /></Button></DialogPrimitive.Trigger>
          <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="studio-materials-picker-overlay" />
          <DialogPrimitive.Content id={`${formId}-picker`} data-testid="studio-materials-picker" aria-labelledby={`${formId}-picker-title`} aria-describedby={undefined} className="studio-materials-picker" onEscapeKeyDown={event => { event.stopPropagation(); }} onOpenAutoFocus={event => { if (searchRef.current && !searchRef.current.disabled) { event.preventDefault(); searchRef.current.focus(); } }}>
            <div className="studio-materials-picker-heading"><DialogPrimitive.Title id={`${formId}-picker-title`}>{t('studio:materials.choose')}</DialogPrimitive.Title><span>{t('materials:selection.selected_count', { count: selected.size })}</span></div>
            <div className="studio-materials-picker-tabs">
              <ClipPathTabs data-testid="studio-materials-tabs" size="sm" shape="rounded" smoothCorners value={tab} ariaLabel={t('studio:materials.choose')}
                onValueChange={next => { setTab(next as PickerTab); startEdit(null); }}
                items={[{ value: 'collections', label: `${t('materials:selection.collections')} ${availableCollections.length}` }, { value: 'presets', label: `${t('materials:selection.presets')} ${presets.length}` }]} />
              {tab === 'collections' && <div className="studio-materials-search"><Search className="size-3.5" aria-hidden="true" /><Input ref={searchRef} data-testid="studio-materials-search" aria-label={t('studio:materials.search')} placeholder={t('studio:materials.search')} className="h-8 pl-8 text-xs" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} /></div>}
            </div>
            <StudioScrollFade fill className="studio-materials-picker-scroll" viewportClassName="studio-materials-picker-body" contentClassName="studio-materials-picker-content">
              {skipped > 0 && <p role="status" data-testid="studio-materials-skipped" className="studio-materials-problem"><AlertCircle className="size-3.5" aria-hidden="true" />{t('materials:selection.preset_missing', { count: skipped })}</p>}
              {tab === 'presets' ? <>
                {library && <section data-testid="studio-materials-presets" className="studio-materials-section" aria-label={t('materials:selection.presets')}>
                  {edit?.kind === 'save' ? presetForm(t('materials:selection.preset_name'))
                    : <div className="studio-materials-section-actions"><p className="studio-materials-section-help">{t(presets.length ? 'materials:selection.presets_help' : 'materials:selection.presets_empty_help')}</p>
                      <Button data-testid="studio-materials-save-preset" type="button" variant="outline" size="xs" disabled={busy || !canSavePreset || !!edit} title={canSavePreset ? undefined : t('materials:selection.save_preset_requires')} onClick={() => startEdit({ kind: 'save' })}><BookmarkPlus className="size-3" aria-hidden="true" />{t('materials:selection.save_preset')}</Button></div>}
                  {presetError && <p role="alert" className="studio-materials-section-help text-destructive">{t('materials:selection.preset_failed')}</p>}
                  {presetGroups.map(group => <div key={group.name || 'all'} className="studio-materials-group" data-testid="studio-materials-preset-group">
                  {group.name && <p className="studio-materials-group-caption">{group.name}</p>}
                  <div className="studio-materials-compact-list">{group.items.map(({ preset, label }) => {
                    const presetUsable = preset.languagePair.target === value.languagePair.target && (!sourceLocked || preset.languagePair.source === value.languagePair.source);
                    if (edit?.kind === 'rename' && edit.preset.id === preset.id) return <div key={preset.id}>{presetForm(t('materials:selection.preset_name'))}</div>;
                    if (edit?.kind === 'delete' && edit.preset.id === preset.id) return <div key={preset.id} role="group" className="studio-materials-preset-confirm">
                      <p>{t('materials:selection.preset_delete_confirm', { name: preset.name })}</p>
                      <Button data-testid="studio-materials-preset-delete-confirm" type="button" size="xs" variant="destructive" disabled={presetPending} onClick={() => deletePreset(preset)}>{t('materials:selection.preset_delete_action')}</Button>
                      <Button type="button" size="xs" variant="ghost" disabled={presetPending} onClick={() => startEdit(null)}>{t('materials:selection.cancel')}</Button>
                    </div>;
                    return <div key={preset.id} className="studio-materials-preset-row" data-disabled={!presetUsable}>
                      <button type="button" data-testid={`studio-materials-preset-${preset.id}`} className="studio-materials-preset-apply" disabled={busy || !presetUsable || !!edit}
                        title={setNames(preset.collectionIds)}
                        onClick={() => { applySet(preset.languagePair.source, preset.collectionIds, { instructions: preset.instructions, context: preset.context }); setTab('collections'); }}>
                        <span className="studio-materials-preset-name">{label}</span>
                        <span className="studio-materials-row-meta">{mixedDirections && <span>{pairName(preset.languagePair)}</span>}<span>{t('materials:selection.preset_collections', { count: preset.collectionIds.length })}</span>{!presetUsable && <span>{t('materials:selection.other_direction')}</span>}</span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button type="button" size="icon-xs" variant="ghost" data-testid={`studio-materials-preset-more-${preset.id}`} aria-label={t('materials:selection.preset_more', { name: preset.name })} disabled={busy || !!edit}><Ellipsis /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem data-testid="studio-materials-preset-rename" onSelect={() => startEdit({ kind: 'rename', preset })}><Pencil />{t('materials:selection.preset_rename_action')}</DropdownMenuItem>
                          <DropdownMenuItem data-testid="studio-materials-preset-delete" variant="destructive" onSelect={() => startEdit({ kind: 'delete', preset })}><Trash2 />{t('materials:selection.preset_delete_menu')}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>;
                  })}</div></div>)}
                </section>}
                {library && recent.length > 0 && <section data-testid="studio-materials-recent" className="studio-materials-section" aria-labelledby={`${formId}-recent`}>
                  <div className="studio-materials-collection-heading"><History className="size-3.5" aria-hidden="true" /><span id={`${formId}-recent`}>{t('materials:selection.recent')}</span></div>
                  <div className="studio-materials-compact-list">{recent.map((item, index) => <button key={`${item.usedAt}-${index}`} type="button" data-testid="studio-materials-recent-item" className="studio-materials-recent-row" disabled={busy}
                    onClick={() => { applySet(item.languagePair.source, item.collectionIds); setTab('collections'); }}>{setNames(item.collectionIds)}</button>)}</div>
                </section>}
              </> : <div className="studio-materials-collection-list">
                {!mixedDirections && availableCollections.length > 0 && !loading && (fits(availableCollections[0].languagePair, value)
                  ? <p className="studio-materials-section-help">{t('materials:selection.direction_all', { pair: pairName(availableCollections[0].languagePair) })}</p>
                  : <p data-testid="studio-materials-direction-other" className="studio-materials-section-help studio-materials-direction-other">{t('materials:selection.direction_all_other', { pair: pairName(availableCollections[0].languagePair) })}</p>)}
                <DialogMotionRegion><DialogTransition transitionKey={loading ? 'loading' : unavailableLibrary ? 'unavailable' : collections.length ? 'list' : availableCollections.length ? 'no-results' : 'empty'} stageClassName="grid gap-2">
                {loading ? <div className="studio-materials-picker-empty" role="status"><RefreshCw className="size-4 animate-spin" aria-hidden="true" /><p>{t('knowledge:loading')}</p></div>
                  : unavailableLibrary ? <div className="studio-materials-picker-empty" role="status"><AlertCircle className="size-4" aria-hidden="true" /><p>{t('materials:selection.library_unavailable')}</p><Button type="button" variant="outline" size="xs" disabled={disabled} onClick={onRefresh}>{t('materials:selection.retry')}</Button></div>
                    : availableCollections.length === 0 ? <div className="studio-materials-picker-empty"><FolderOpen className="size-5" aria-hidden="true" /><p>{t('materials:selection.empty_library')}</p><span>{t('materials:selection.empty_library_help')}</span><Button asChild size="sm" variant="outline" className="mt-1"><Link data-testid="studio-materials-empty-open" to="/tools/translation-knowledge" onClick={() => setChoosing(false)}>{t('materials:selection.empty_open')}<ArrowUpRight className="size-3" aria-hidden="true" /></Link></Button></div>
                      : collections.length === 0 ? <div data-testid="studio-materials-search-empty" className="studio-materials-picker-empty" role="status"><Search className="size-4" aria-hidden="true" /><p>{t('materials:selection.no_results')}</p><Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => setSearch('')}>{t('materials:selection.clear_search')}</Button></div>
                        : groups.map(group => {
                          const members = group.items.map(member => member.collection);
                          const allowed = members.filter(item => fits(item.languagePair, value) || selected.has(item.id));
                          const chosen = members.filter(item => selected.has(item.id)).length;
                          const open = !group.name || !!search.trim() || !collapsed.has(group.name);
                          return <section key={group.name || 'all'} className="studio-materials-group" data-testid="studio-materials-group" aria-label={group.name || t('materials:selection.collections')}>
                            {group.name && <div className="studio-materials-group-heading">
                              <Checkbox data-testid="studio-materials-group-toggle" aria-label={t('materials:selection.group_select', { name: group.name })} disabled={disabled || !allowed.length}
                                checked={chosen === 0 ? false : chosen === group.items.length ? true : 'indeterminate'} onCheckedChange={checked => toggleGroup(members, checked === true)} />
                              <button type="button" className="studio-materials-group-name" aria-expanded={open} disabled={!!search.trim()}
                                onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(group.name)) next.delete(group.name); else next.add(group.name); return next; })}>
                                <span className="studio-materials-group-label">{group.name}</span><span className="studio-materials-group-count">{chosen > 0 ? `${chosen}/${group.items.length}` : group.items.length}</span>
                                <ChevronDown className="studio-materials-group-chevron size-3.5" data-open={open} aria-hidden="true" />
                              </button>
                            </div>}
                            {open && <div className="studio-materials-compact-list" data-grouped={!!group.name}>{group.items.map(({ collection: item, label }) => {
                              const usableHere = fits(item.languagePair, value) || selected.has(item.id);
                              return <label key={item.id} htmlFor={`${formId}-collection-${item.id}`} className="studio-materials-collection-row" data-selected={selected.has(item.id)} data-disabled={!usableHere} title={item.description || item.name}>
                                <Checkbox id={`${formId}-collection-${item.id}`} data-testid={`studio-materials-collection-${item.id}`} checked={selected.has(item.id)} disabled={disabled || !usableHere} onCheckedChange={checked => toggleCollection(item, checked === true)} />
                                <span className="studio-materials-collection-name">{label}</span>
                                <span className="studio-materials-row-meta">{mixedDirections && <span>{pairName(item.languagePair)}</span>}{!fits(item.languagePair, value) && <span>{t('materials:selection.other_direction')}</span>}<span>{t('materials:selection.entry_count', { count: entryCounts.get(item.id) ?? 0 })}</span></span>
                              </label>;
                            })}</div>}
                          </section>;
                        })}
                </DialogTransition></DialogMotionRegion>
              </div>}
            </StudioScrollFade>
            <div className="studio-materials-picker-footer">
              <div className="studio-materials-picker-tools"><Button asChild variant="ghost" size="xs" className={disabled ? 'pointer-events-none opacity-50' : undefined}><Link to="/tools/translation-knowledge" aria-disabled={disabled} tabIndex={disabled ? -1 : undefined} onClick={event => { if (disabled) event.preventDefault(); else setChoosing(false); }}>{t('materials:selection.manage')}<ArrowUpRight className="size-3" aria-hidden="true" /></Link></Button><Button data-testid="studio-materials-refresh" type="button" variant="ghost" size="xs" disabled={disabled || loading} onClick={onRefresh}><RefreshCw className={loading ? 'size-3 animate-spin' : 'size-3'} aria-hidden="true" />{t('studio:refresh')}</Button>{onAddTerm && <Button data-testid="studio-materials-add-term" type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => { setChoosing(false); onAddTerm(); }}><Plus className="size-3" aria-hidden="true" />{t('studio:materials.add_term')}</Button>}</div>
              <Button data-testid="studio-materials-done" type="button" size="sm" onClick={() => { setChoosing(false); startEdit(null); }}><Check className="size-3.5" aria-hidden="true" />{t('materials:selection.done')}</Button>
            </div>
          </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </div>
    </div>
    {loading && !choosing && <p role="status" className="studio-materials-loading"><RefreshCw className="size-3 animate-spin" aria-hidden="true" />{t('knowledge:loading')}</p>}
    <DialogTransition transitionKey="configuration">{active && <div className="studio-materials-configuration">
      <div className="studio-materials-source-row"><label htmlFor={`${formId}-source`}>{t('knowledge:fields.source_language')}</label><Select value={value.languagePair.source || 'none'} disabled={disabled || sourceLocked} onValueChange={next => {
        const source = next === 'none' ? '' : next;
        const pair = { ...value.languagePair, source };
        // Changing the source drops collections of another direction rather than leaving them invalid.
        const collectionIds = value.collectionIds.filter(id => { const item = collectionsById.get(id); return !item || fits(item.languagePair, { languagePair: pair }); });
        update({ languagePair: pair, collectionIds, disabledEntryIds: value.disabledEntryIds.filter(id => collectionIds.includes(library?.data.entries.find(entry => entry.id === id)?.collectionId ?? '')) });
      }}><SelectTrigger id={`${formId}-source`} data-testid="studio-materials-source" className="h-8 min-w-0 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('knowledge:automatic.choose_source')}</SelectItem>{materialLanguages.map(language => <SelectItem key={language} value={language}>{t(`knowledge:languages.${language}`)}</SelectItem>)}{value.languagePair.source && !materialLanguages.includes(value.languagePair.source as typeof materialLanguages[number]) && <SelectItem value={value.languagePair.source}>{value.languagePair.source}</SelectItem>}</SelectContent></Select></div>
      {sourceLocked && <p className="studio-materials-help">{t('knowledge:automatic.english_source')}</p>}
      {problem && <div role="status" data-testid="studio-materials-problem" className="studio-materials-problem"><AlertCircle className="size-3.5" aria-hidden="true" /><p>{t(problemKeys[problem])}</p>{problem === 'library' && <Button type="button" variant="outline" size="xs" disabled={disabled || loading} onClick={onRefresh}>{t('materials:selection.retry')}</Button>}</div>}
      <div className="studio-materials-disclosures">
      <KnowledgeDisclosure data-testid="studio-materials-more" variant="section" title={t('studio:materials.more')} description={value.disabledEntryIds.length > 0 ? t('materials:selection.exclusion_count', { count: value.disabledEntryIds.length }) : undefined} className="studio-materials-disclosure">
        <ToolField label={t('knowledge:trial.context')} htmlFor={`${formId}-context`}><Textarea id={`${formId}-context`} data-testid="studio-materials-context" className="min-h-16 text-xs" maxLength={4000} disabled={disabled} value={value.context ?? ''} onChange={event => update({ context: event.target.value })} /></ToolField>
        {(entries.length > 0 || unavailableExclusions.length > 0) && <KnowledgeDisclosure data-testid="studio-materials-exclusions" variant="inline" title={t('knowledge:trial.disable')}><StudioScrollFade className="studio-materials-exclusion-list" maxHeight={224} contentClassName="studio-materials-options">{entries.map(entry => <MaterialToggle key={entry.id} testId={`studio-materials-exclude-${entry.id}`} label={entrySummary(entry)} checked={value.disabledEntryIds.includes(entry.id)} disabled={disabled} onChange={checked => update({ disabledEntryIds: checked ? [...new Set([...value.disabledEntryIds, entry.id])] : value.disabledEntryIds.filter(id => id !== entry.id) })} />)}{unavailableExclusions.map(id => <MaterialToggle key={id} testId={`studio-materials-exclude-${id}`} label={t('materials:selection.unavailable_exclusion')} checked disabled={disabled} onChange={() => update({ disabledEntryIds: value.disabledEntryIds.filter(item => item !== id) })} />)}</StudioScrollFade></KnowledgeDisclosure>}
      </KnowledgeDisclosure>
      </div>
    </div>}</DialogTransition>
  </section>;
}
