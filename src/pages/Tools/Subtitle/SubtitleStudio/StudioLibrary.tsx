import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, ChevronDown, ListFilter, Search, Settings2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToolField } from '../../_shared/ui/ToolField';
import type { DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { STUDIO_BATCH_LIMIT } from '@/subtitle-studio/batch-contract';
import { matchesLibraryQuery } from '@/subtitle-studio/library-query';
import { StudioFileName, StudioIconButton, StudioPagination } from './StudioControls';

export const LIBRARY_PAGE_SIZE = 20;
export type LibraryQuery = {
  query: string;
  format: 'all' | 'srt' | 'lrc';
  status: 'all' | 'untranslated' | 'translated' | 'active' | 'attention';
  sort: 'recent' | 'oldest' | 'name-asc' | 'name-desc' | 'cue-count-asc' | 'cue-count-desc';
};
export const defaultLibraryQuery: LibraryQuery = { query: '', format: 'all', status: 'all', sort: 'recent' };
const sortKeys = { recent: 'studio:library.recent', oldest: 'studio:library.oldest', 'name-asc': 'studio:library.name_asc', 'name-desc': 'studio:library.name_desc', 'cue-count-asc': 'studio:library.cues_asc', 'cue-count-desc': 'studio:library.cues_desc' } as const;
const filterKeys = { all: 'studio:library.all_status', untranslated: 'studio:library.untranslated', translated: 'studio:library.translated', active: 'studio:library.active', attention: 'studio:library.attention' } as const;
const taskKeys = { queued: 'studio:translation.queued', running: 'studio:translation.running', interrupted: 'studio:translation.interrupted', needs_configuration: 'studio:translation.needs_configuration', completed: 'studio:translation.completed', failed: 'studio:translation.failed', cancelled: 'studio:translation.cancelled' } as const;

type Props = {
  documents: DocumentSummary[]; selected: DocumentSummary[]; previewId?: string;
  query: LibraryQuery; onQuery: (value: LibraryQuery) => void;
  total: number; allTotal: number; offset: number; busy: boolean;
  onPage: (offset: number) => void; onPreview: (doc: DocumentSummary) => void;
  onToggle: (doc: DocumentSummary) => void; onSelectPage: () => void;
  onSelectAll: () => void; onClearScope: () => void; onClear: () => void;
  selectionLimit: boolean; onDismissLimit: () => void;
  encoding: ReactNode; actions: ReactNode;
};

export function StudioLibrary(props: Props) {
  const { t } = useTranslation();
  const { documents, selected, query, total, allTotal, offset, busy } = props;
  const selectedIds = new Set(selected.map(doc => doc.id));
  const selectedOnPage = documents.filter(doc => selectedIds.has(doc.id)).length;
  const selectedInScope = selected.filter(doc => matchesLibraryQuery(doc, query)).length;
  const allSelected = total > 0 && selectedInScope === total && selectedOnPage === documents.length;
  const fullSelection = allSelected && selected.length === total;
  const filtered = !!query.query || query.format !== 'all' || query.status !== 'all';
  return <div data-testid="studio-library" className="studio-library-content">
    <div className="studio-library-tools">
      <div className="studio-library-search">
        <Search aria-hidden="true" />
        <Input data-testid="studio-library-search" aria-label={t('studio:library.search')} placeholder={t('studio:library.search')} value={query.query} maxLength={200} onChange={event => props.onQuery({ ...query, query: event.target.value })} />
        {query.query && <StudioIconButton size="icon-xs" label={t('studio:library.clear_search')} onClick={() => props.onQuery({ ...query, query: '' })}><X /></StudioIconButton>}
      </div>
      <Popover>
        <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('studio:library.options')} className={filtered ? 'text-primary bg-accent' : ''}><ListFilter /></Button></PopoverTrigger>
        <PopoverContent align="end" className="w-[280px] space-y-4 p-3">
          <ToolField label={t('studio:library.sort')}><Select value={query.sort} onValueChange={sort => props.onQuery({ ...query, sort: sort as LibraryQuery['sort'] })}><SelectTrigger aria-label={t('studio:library.sort')} className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(sortKeys).map(([value, key]) => <SelectItem key={value} value={value}>{t(key)}</SelectItem>)}</SelectContent></Select></ToolField>
          <ToolField label={t('studio:library.format')}><Select value={query.format} onValueChange={format => props.onQuery({ ...query, format: format as LibraryQuery['format'] })}><SelectTrigger aria-label={t('studio:library.format')} className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('studio:library.all_formats')}</SelectItem><SelectItem value="srt">SRT</SelectItem><SelectItem value="lrc">LRC</SelectItem></SelectContent></Select></ToolField>
          <ToolField label={t('studio:status')}><Select value={query.status} onValueChange={status => props.onQuery({ ...query, status: status as LibraryQuery['status'] })}><SelectTrigger aria-label={t('studio:status')} className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(filterKeys).map(([value, key]) => <SelectItem key={value} value={value}>{t(key)}</SelectItem>)}</SelectContent></Select></ToolField>
          <p className="text-[11px] leading-5 text-muted-foreground">{t('studio:library.selection_rule')}</p>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('studio:import_settings')}><Settings2 /></Button></PopoverTrigger>
        <PopoverContent align="end" className="w-[240px] p-3"><ToolField label={t('studio:encoding')}>{props.encoding}</ToolField></PopoverContent>
      </Popover>
    </div>
    {filtered && <div className="studio-library-filter-summary"><span>{t('studio:library.matches', { count: total, total: allTotal })}</span><Button variant="ghost" size="sm" onClick={() => props.onQuery({ ...defaultLibraryQuery, sort: query.sort })}>{t('studio:library.reset_filters')}</Button></div>}
    <div className="studio-library-selection" data-testid="studio-library-selection">
      <label><Checkbox data-testid="studio-library-select-all" aria-label={t(filtered ? 'studio:library.select_matches' : 'studio:library.select_all')} checked={allSelected ? true : selectedInScope ? 'indeterminate' : false} disabled={busy || !total} onCheckedChange={() => allSelected ? props.onClearScope() : props.onSelectAll()} /><span>{t(filtered ? 'studio:library.select_matches' : 'studio:library.select_all')}</span></label>
      <DropdownMenu>
        <Tooltip delayDuration={350}><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button className="studio-library-selection-menu" variant="ghost" size="icon-xs" aria-label={t('studio:library.selection_options')} disabled={busy}><ChevronDown /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>{t('studio:library.selection_options')}</TooltipContent></Tooltip>
        <DropdownMenuContent align="start" className="w-64" data-testid="studio-library-selection-menu">
          <DropdownMenuItem disabled={busy || !total} onSelect={props.onSelectAll}>{t(filtered ? 'studio:library.select_results' : 'studio:library.select_all')}<span className="ml-auto pl-3 text-muted-foreground tabular-nums">{total}</span></DropdownMenuItem>
          <DropdownMenuItem disabled={busy || !documents.length} onSelect={props.onSelectPage}>{t('studio:library.select_page')}<span className="ml-auto pl-3 text-muted-foreground tabular-nums">{documents.length}</span></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy || !selected.length} onSelect={props.onClear}>{t('studio:library.clear_selection')}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-[11px] leading-5 text-muted-foreground">{t('studio:library.selection_rule')} {t('studio:library.limit_hint', { count: STUDIO_BATCH_LIMIT })}</p>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="studio-library-selection-scope">{t('studio:library.scope_count', { count: total })}</span>
    </div>
    {props.selectionLimit && <div role="status" data-testid="studio-library-selection-limit" className="studio-library-selection-notice"><span>{t('studio:library.limit', { count: STUDIO_BATCH_LIMIT })}</span><StudioIconButton size="icon-xs" label={t('studio:dismiss')} onClick={props.onDismissLimit}><X /></StudioIconButton></div>}
    <div className="studio-library-scroll" aria-busy={busy}>
      {documents.length ? <ul className="studio-document-list studio-library-items">{documents.map(doc => {
        const active = doc.task?.status === 'queued' || doc.task?.status === 'running';
        const attention = doc.task && ['failed', 'interrupted', 'needs_configuration'].includes(doc.task.status);
        return <li key={doc.id} className="studio-library-row" data-testid="studio-library-row" data-document-id={doc.id} data-current={props.previewId === doc.id || undefined} data-selected={selectedIds.has(doc.id) || undefined}>
          <Checkbox className="studio-document-checkbox" checked={selectedIds.has(doc.id)} aria-label={t('studio:library.select_name', { name: doc.origin.displayName })} disabled={busy} onCheckedChange={() => props.onToggle(doc)} />
          <button disabled={busy} aria-current={props.previewId === doc.id ? 'true' : undefined} className="studio-document" onClick={() => props.onPreview(doc)}>
            <span className="min-w-0 flex-1"><StudioFileName name={doc.origin.displayName} /><span className="studio-library-metadata"><Badge variant="outline" className="px-1 py-0 font-mono text-[10px] font-normal">{doc.origin.format.toUpperCase()}</Badge><span>{t('studio:cue_count', { count: doc.cueCount })}</span><span className={attention ? 'text-amber-600 dark:text-amber-400' : ''}>{doc.task && doc.task.status !== 'completed' && doc.task.status !== 'cancelled' ? t(taskKeys[doc.task.status]) : t(doc.translationStatus === 'complete' ? 'studio:library.translated' : doc.translationStatus === 'partial' ? 'studio:library.partial' : 'studio:source_only')}</span></span>{active && doc.task && <span className="studio-library-progress">{t('studio:translation.batch_progress', { completed: doc.task.completedBatches, total: doc.task.totalBatches })}</span>}</span>
            {doc.diagnostics.length ? <AlertCircle className="mt-1 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label={t('studio:document_checks')} /> : props.previewId === doc.id ? <Check className="mt-1 size-3.5 shrink-0" aria-hidden="true" /> : null}
          </button>
        </li>;
      })}</ul> : <p className="studio-library-empty">{t(filtered ? 'studio:library.no_matches' : 'studio:empty')}</p>}
    </div>
    <div className="studio-library-footer" data-has-selection={!!selected.length || undefined}>
      {!!selected.length && <div className="studio-library-batch" data-testid="studio-batch-toolbar">
        <Tooltip delayDuration={350}><TooltipTrigger asChild><span tabIndex={0} className="studio-library-selected-count" aria-label={t(fullSelection ? 'studio:library.selected_all' : 'studio:library.selected', { count: selected.length })}>{t('studio:library.selected', { count: selected.length })}</span></TooltipTrigger><TooltipContent>{t(fullSelection ? 'studio:library.selected_all' : 'studio:library.selected', { count: selected.length })}</TooltipContent></Tooltip>
        <div className="studio-library-batch-actions">{props.actions}</div>
      </div>}
      <div className="studio-library-pagination" data-testid="studio-library-pagination"><StudioPagination offset={offset} total={total} pageSize={LIBRARY_PAGE_SIZE} compact={!!selected.length} busy={busy} onChange={props.onPage} /></div>
    </div>
  </div>;
}
