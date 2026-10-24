import { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Languages, Search, X } from 'lucide-react';
import { ClipPathTabs } from '@/components/qiuye-ui/clip-path-tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LONG_TEXT_LIMITS, type DocumentDetail } from '@/long-text/contract';
import { labelKey } from '@/long-text/languages';
import type { RunModel, RunModelProblem } from '@/services/long-text/model';
import { StudioIconButton } from '../../../Subtitle/SubtitleStudio/StudioControls';
import { FILTER_LABELS, MODEL_PROBLEM_LABELS, PACE_LABELS, STYLE_LABELS, type ReaderFilter } from '../labels';
import { groupedCount, useLongTextPage } from '../page-context';
import { RunControls } from './RunControls';

const FILTERS = ['all', 'attention', 'untranslated', 'edited'] as const satisfies readonly ReaderFilter[];

/** The count on each filter tab (design §4.6): "未翻译" is pending plus failed, "已修改" is the user's own. */
export function filterCounts(counts: DocumentDetail['counts']): Record<ReaderFilter, number> {
  return { all: counts.translatable, attention: counts.attention, untranslated: counts.pending + counts.failed, edited: counts.edited };
}

/** "日语 → 简体中文 · 文学" and the tooltip with the model and the pace (design §2 F4-1). */
export function settingsSummary(t: TFunction<'text'>, detail: DocumentDetail, runModel: RunModel | { problem: RunModelProblem }): { text: string; tooltip: string } {
  const direction = t('meta.direction', { source: t(labelKey(detail.languages.source)), target: t(labelKey(detail.languages.target)) });
  const style = t(STYLE_LABELS[detail.style]);
  const model = 'problem' in runModel ? t(MODEL_PROBLEM_LABELS[runModel.problem]) : runModel.model.label;
  return {
    text: t('settings_summary.value', { direction, style }),
    tooltip: t('settings_summary.tooltip', { direction, style, model, pace: t(PACE_LABELS[detail.settings.pace]) }),
  };
}

/**
 * The reader toolbar (design §3.3, U5): filter tabs with counts, attention navigation and search on
 * the left; the settings summary and the run controls on the right, which move to a second line only
 * once the summary is as short as it gets.
 */
export function ReaderToolbar({ detail, filter, search, onFilter, onSearch, onAttention }: {
  detail: DocumentDetail;
  filter: ReaderFilter;
  /** The text of the search on screen, if any. */
  search: string | null;
  onFilter: (filter: ReaderFilter) => void;
  /** A search, or `null` to leave the results. */
  onSearch: (text: string | null) => void;
  onAttention: (direction: 'next' | 'previous') => void;
}) {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const counts = filterCounts(detail.counts);
  const summary = settingsSummary(t, detail, page.runModel);
  const [open, setOpen] = useState(search !== null);
  const [draft, setDraft] = useState(search ?? '');
  const input = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd+F: open the box and select what is in it.
  const request = page.searchRequest;
  const handled = useRef(request);
  useEffect(() => {
    if (request === handled.current) return;
    handled.current = request;
    setOpen(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [request]);

  const close = () => {
    setOpen(false);
    page.focusReader();
  };
  const clear = () => {
    setDraft('');
    if (search !== null) onSearch(null);
    input.current?.focus();
  };

  return <div className="lt-toolbar" data-testid="long-text-toolbar">
    <div className="lt-toolbar-view">
      <ClipPathTabs data-testid="long-text-filter" value={filter} onValueChange={value => onFilter(value as ReaderFilter)} ariaLabel={t('filter.label')}
        shape="rounded" smoothCorners size="sm" transitionDuration={200} transitionEasing="ease-out"
        items={FILTERS.map(value => {
          const count = groupedCount(counts[value], i18n.language);
          return {
            value,
            ariaLabel: `${t(FILTER_LABELS[value])} ${count}`,
            label: <span className="lt-filter-label">{t(FILTER_LABELS[value])}<span className="lt-filter-count">{count}</span></span>,
          };
        })} />
      {counts.attention > 0 && <>
        <StudioIconButton data-testid="long-text-attention-prev" label={t('filter.previous')} onClick={() => onAttention('previous')}><ChevronUp /></StudioIconButton>
        <StudioIconButton data-testid="long-text-attention-next" label={t('filter.next')} onClick={() => onAttention('next')}><ChevronDown /></StudioIconButton>
      </>}
      {open
        ? <div className="lt-search">
          <Search aria-hidden="true" />
          <Input ref={input} data-testid="long-text-search" value={draft} maxLength={LONG_TEXT_LIMITS.searchChars}
            aria-label={t('search.placeholder')} placeholder={t('search.placeholder')}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => { if (!draft.trim() && search === null) setOpen(false); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                onSearch(draft.trim() || null);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                if (draft || search !== null) clear();
                else close();
              }
            }} />
          {draft && <StudioIconButton size="icon-xs" label={t('search.clear')} onClick={clear}><X /></StudioIconButton>}
        </div>
        : <StudioIconButton data-testid="long-text-search-open" label={t('search.open')}
          onClick={() => { setOpen(true); requestAnimationFrame(() => input.current?.focus()); }}>
          <Search />
        </StudioIconButton>}
    </div>
    <div className="lt-toolbar-run">
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" className="lt-settings-summary" data-testid="long-text-settings-summary"
            aria-label={`${t('settings_summary.label')}: ${summary.tooltip}`} onClick={() => page.openDialog({ kind: 'settings', intent: 'edit' })}>
            <Languages /><span>{summary.text}</span><ChevronDown />
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6} className="max-w-[min(22rem,calc(100vw-2rem))]">{summary.tooltip}</TooltipContent>
      </Tooltip>
      <RunControls summary={detail} />
    </div>
  </div>;
}
