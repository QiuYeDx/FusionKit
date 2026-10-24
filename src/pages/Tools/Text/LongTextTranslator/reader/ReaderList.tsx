import type { KeyboardEvent, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowDown, ArrowRight, CheckCheck, LoaderCircle, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LONG_TEXT_LIMITS, type DocumentDetail } from '@/long-text/contract';
import { labelKey } from '@/long-text/languages';
import { FILTER_EMPTY_LABELS } from '../labels';
import { groupedCount, useSettledFlag } from '../page-context';
import { ReaderRow, type RowHandlers } from './ReaderRow';
import { needsAttention, viewKey, type ReaderLoad, type ReaderRows, type ReaderView } from './useReaderPage';

/**
 * The rows (design §3.3, §4.6–4.7): sticky column titles, the search result line, a `role=list` of
 * rows with a roving tab stop, "继续阅读" at the end of a page, empty and failed states, the card
 * shown while a page reads, and the "回到当前进度" pill over it all.
 */
export function ReaderList({ detail, view, data, load, targetOnly, tabStop, editing, flash, overlayIndex, expanded, handlers,
  viewportRef, focusRef, onKeyDown, onNextPage, onClearSearch, onRetry, pill }: {
  detail: DocumentDetail;
  /** The view asked for; `data.view` is the one on screen until it is read. */
  view: ReaderView;
  data: ReaderRows;
  load: ReaderLoad;
  targetOnly: boolean;
  tabStop: number | null;
  editing: number | null;
  flash: number | null;
  /** The row whose menu or retranslate popover is open. */
  overlayIndex: number | null;
  expanded: ReadonlySet<number>;
  handlers: RowHandlers;
  viewportRef: RefObject<HTMLDivElement | null>;
  focusRef: (element: HTMLElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onNextPage: (keyboard: boolean) => void;
  onClearSearch: () => void;
  onRetry: () => void;
  pill: { shown: boolean; onClick: () => void };
}) {
  const { t, i18n } = useTranslation('text');
  const shown = data.view;
  const loading = useSettledFlag(load.status === 'loading');
  const failed = load.status === 'failed';
  const search = shown.kind === 'search' ? shown.text : undefined;
  const nothing = load.status === 'ready' && viewKey(shown) === viewKey(view) && !data.rows.length;
  const nextPage = view.kind === 'page' && shown.kind === 'page' ? detail.pages[shown.page + 1] : undefined;
  const attentionView = shown.kind === 'filter' && shown.filter === 'attention';

  const empty = !nothing ? null
    : shown.kind === 'filter' ? <div className="lt-empty" data-testid="long-text-empty"><CheckCheck /><p>{t(FILTER_EMPTY_LABELS[shown.filter])}</p></div>
      : shown.kind === 'search' ? <div className="lt-empty" data-testid="long-text-empty"><SearchX />
        <p>{t('search.empty', { text: shown.text })}</p>
        <Button size="sm" variant="ghost" onClick={onClearSearch}>{t('search.clear')}</Button>
      </div> : null;

  return <div className="lt-reader-wrap" data-pending={(loading || failed) || undefined}>
    <ScrollArea className="lt-reader-area" viewportRef={viewportRef}
      viewportProps={{ className: 'lt-reader', 'aria-busy': load.status === 'loading' }}>
      <div ref={focusRef} className="lt-reader-focus" tabIndex={-1} data-testid="long-text-reader" onKeyDown={onKeyDown}>
        <div className="lt-reader-content" data-target-only={targetOnly || undefined} inert={loading || failed}>
          {!targetOnly && <div className="lt-columns" aria-hidden="true">
            <span>{t('reader.source_column', { language: t(labelKey(detail.languages.source)) })}</span>
            <span>{t('reader.target_column', { language: t(labelKey(detail.languages.target)) })}</span>
          </div>}
          {shown.kind === 'search' && data.rows.length > 0 && <p className="lt-result-bar" data-testid="long-text-search-result">
            <span>{t('search.result', { count: groupedCount(data.total, i18n.language), text: shown.text })}</span>
            {data.truncated && <span>{t('search.truncated', { count: groupedCount(LONG_TEXT_LIMITS.searchResults, i18n.language) })}</span>}
            <Button size="xs" variant="ghost" onClick={onClearSearch}>{t('search.clear')}</Button>
          </p>}
          {empty ?? <div role="list" aria-label={t('reader.list_label')} className="lt-list">
            {data.rows.map(row => <ReaderRow key={row.index} row={row} format={detail.format} tabbable={row.index === tabStop} editing={row.index === editing}
              filled={data.filled.has(row.index)} flash={row.index === flash}
              handled={attentionView && (data.dropped.has(row.index) || !needsAttention(row))}
              inList={shown.kind !== 'page'} search={search} targetOnly={targetOnly} overlayOpen={row.index === overlayIndex}
              expanded={expanded.has(row.index)} handlers={handlers} />)}
          </div>}
          {nextPage && <div className="lt-next-page">
            <Button variant="outline" size="sm" data-testid="long-text-next-page" onClick={event => onNextPage(event.detail === 0)}>
              <span>{nextPage.title
                ? t('reader.next_page', { page: nextPage.index + 1, title: nextPage.title })
                : t('reader.next_page_untitled', { page: nextPage.index + 1 })}</span>
              <ArrowRight />
            </Button>
          </div>}
        </div>
      </div>
    </ScrollArea>
    {(loading || failed) && <div className="lt-reader-state">
      {failed
        ? <div role="alert" data-testid="long-text-page-failed">
          <AlertCircle className="text-destructive" />
          <span>{t('status.page_failed')}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>{t('status.retry')}</Button>
        </div>
        : <div role="status"><LoaderCircle className="animate-spin motion-reduce:animate-none" /><span>{t('status.loading')}</span></div>}
    </div>}
    {pill.shown && <button type="button" className="lt-follow-pill" data-testid="long-text-follow-pill" onClick={pill.onClick}>
      <ArrowDown aria-hidden="true" />{t('status.back_to_progress')}
    </button>}
  </div>;
}
