import { useLayoutEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { CheckCheck, ChevronLeft, ChevronRight, Crosshair, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentDetail, Usage } from '@/long-text/contract';
import { formatTokens } from '@/utils/tokenEstimate';
import { StudioIconButton } from '../../../Subtitle/SubtitleStudio/StudioControls';
import { costRangeText, tokenRange } from '../dialogs/estimate-text';
import type { EstimateView } from '../hooks/useDocumentDetail';
import { RUN_STATUS_LABELS } from '../labels';
import { groupedCount } from '../page-context';
import { PagePicker } from './PagePicker';
import { PageStrip } from './PageStrip';
import { RESULT_PAGE_SIZE, type ReaderView } from './useReaderPage';

/**
 * "待翻译 1,280 段 · 约 52.1K–84.6K Token · 约 $0.031–0.050 · 将使用「DeepSeek V4」" (design §2 F5-6):
 * the idle status line and the tooltip of the run button.
 */
export function estimateText(t: TFunction<'text'>, language: string, estimate: EstimateView, model: string | null): string {
  const { value, cost } = estimate;
  return t('status.idle', { count: groupedCount(value.segments, language), tokens: tokenRange(value) })
    + (cost ? t('status.idle_cost', { cost: costRangeText(cost) }) : '')
    + (model ? t('status.idle_model', { name: model }) : '');
}

/** "1 hr 12 min", "约剩" style: whole minutes, at least one. */
export function formatEta(seconds: number, language: string): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const unit = (value: number, name: 'hour' | 'minute') => new Intl.NumberFormat(language, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
  if (!hours) return unit(minutes, 'minute');
  return rest ? `${unit(hours, 'hour')} ${unit(rest, 'minute')}` : unit(hours, 'hour');
}

const usedTokens = (usage: Usage) => usage.inputTokens + usage.outputTokens;

/** The usage tooltip lines: input and output, and requests whose result is unknown. */
export function usageLines(t: TFunction<'text'>, usage: Usage): string[] {
  const lines = [t('status.usage_detail', { input: formatTokens(usage.inputTokens), output: formatTokens(usage.outputTokens) })];
  if (usage.unknownRequests > 0) lines.push(t('status.usage_unknown', { count: usage.unknownRequests }));
  return lines;
}

export interface StatusLine {
  icon: 'spinner' | 'done' | null;
  /** The whole line. */
  full: string;
  /** What fits a footer under 560px. */
  short: string;
  /** The tooltip's lines: the whole line, then what lies behind it (what is left, usage). */
  tooltip: string[];
  /** Lanes left after the service throttled the run. */
  throttled: number | null;
}

/**
 * The footer status of the document (design §2 F5–F7, §3.3): progress while translating, the waiting
 * requests while pausing, the result once everything is done, how far a run that stopped short got,
 * otherwise the estimate of what is left.
 */
export function statusLine(t: TFunction<'text'>, language: string, detail: DocumentDetail, estimate: EstimateView | null, model: string | null): StatusLine {
  const { counts, run } = detail;
  const count = (value: number) => groupedCount(value, language);
  const used = usedTokens(detail.usage) > 0 ? usageLines(t, detail.usage) : [];
  if (run?.status === 'running') {
    const progress = t('status.running', { done: count(counts.done), total: count(counts.translatable) });
    const parts = [progress];
    if (run.etaSeconds !== null) parts.push(t('status.eta', { time: formatEta(run.etaSeconds, language) }));
    parts.push(t('status.used', { tokens: formatTokens(usedTokens(run.usage)) }));
    const full = parts.join(' · ');
    // Under 560px only "1,204 / 8,312 段" (design §2 F6), in the wording of a segment count.
    const short = t('meta.segments', { count: `${count(counts.done)} / ${count(counts.translatable)}` as unknown as number });
    return { icon: 'spinner', full, short, tooltip: [full, ...usageLines(t, run.usage)], throttled: run.effectiveLanes < run.pace ? run.effectiveLanes : null };
  }
  if (run?.status === 'pausing') {
    const waiting = t('status.waiting', { count: run.inFlight });
    return { icon: 'spinner', full: waiting, short: waiting, tooltip: [waiting, ...usageLines(t, run.usage)], throttled: null };
  }
  if (counts.translatable > 0 && counts.pending + counts.failed === 0) {
    const completed = t('status.completed', { count: count(counts.translatable) });
    const parts = [completed];
    if (counts.attention > 0) parts.push(t('status.attention', { count: count(counts.attention) }));
    if (used.length) parts.push(t('status.usage_total', { tokens: formatTokens(usedTokens(detail.usage)) }));
    const full = parts.join(' · ');
    return { icon: 'done', full, short: completed, tooltip: [full, ...used], throttled: null };
  }
  if (run && (run.status === 'paused' || run.status === 'interrupted' || run.status === 'failed')) {
    const stopped = t(RUN_STATUS_LABELS[run.status], { done: count(counts.done), total: count(counts.translatable) });
    return { icon: null, full: stopped, short: stopped, tooltip: [stopped, ...(estimate ? [estimateText(t, language, estimate, model)] : []), ...used], throttled: null };
  }
  if (estimate) {
    const full = estimateText(t, language, estimate, model);
    return { icon: null, full, short: t('status.idle', { count: count(estimate.value.segments), tokens: tokenRange(estimate.value) }), tooltip: [full], throttled: null };
  }
  const pending = `${t('reader.pending')} · ${t('meta.segments', { count: count(counts.pending + counts.failed) })}`;
  return { icon: null, full: pending, short: pending, tooltip: [pending], throttled: null };
}

function useWidth() {
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  return { element, width };
}

/** Padding of the footer, which the strip runs through to the panel edges. */
const FOOTER_INSET_PX = 24;

/**
 * The reader footer (design §3.3, §4.5–4.6): the page strip, then the status with the follow toggle
 * on the left and page navigation on the right; result views page through their results instead.
 */
export function ReaderFooter({ detail, estimate, model, view, total, follow, onPage, onOffset }: {
  detail: DocumentDetail;
  estimate: EstimateView | null;
  /** The model a run would use, for the estimate. */
  model: string | null;
  view: ReaderView;
  /** Matching segments of a result view. */
  total: number;
  follow: { shown: boolean; on: boolean; toggle: () => void };
  onPage: (page: number, keyboard: boolean) => void;
  onOffset: (offset: number) => void;
}) {
  const { t, i18n } = useTranslation('text');
  const { element, width } = useWidth();
  const status = statusLine(t, i18n.language, detail, estimate, model);
  const pages = detail.pages;
  return <div ref={element} className="lt-footer" data-testid="long-text-footer">
    <PageStrip pages={pages} width={width + FOOTER_INSET_PX} current={view.kind === 'page' ? view.page : null} onJump={page => onPage(page, false)} />
    <div className="lt-footer-row">
      <div className="lt-status">
        {status.icon === 'spinner' && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {status.icon === 'done' && <CheckCheck className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <span className="lt-status-text" tabIndex={0} data-testid="long-text-status">
              <span className="lt-status-full">{status.full}</span>
              <span className="lt-status-short">{status.short}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="max-w-[min(26rem,calc(100vw-2rem))] whitespace-pre-line">{status.tooltip.join('\n')}</TooltipContent>
        </Tooltip>
        {status.throttled !== null && <span className="lt-throttled">{t('status.throttled', { lanes: status.throttled })}</span>}
        {follow.shown && <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="xs" className="lt-follow" data-testid="long-text-follow" aria-pressed={follow.on} aria-label={t('status.follow')} onClick={follow.toggle}>
              <Crosshair /><span className="lt-follow-label">{t('status.follow')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('status.follow')}</TooltipContent>
        </Tooltip>}
      </div>
      {view.kind === 'page'
        ? <div className="lt-pager">
          <StudioIconButton size="icon-xs" label={t('reader.previous_page')} disabled={view.page <= 0} onClick={event => onPage(view.page - 1, event.detail === 0)}><ChevronLeft /></StudioIconButton>
          <PagePicker pages={pages} current={view.page} onJump={onPage} />
          <StudioIconButton size="icon-xs" label={t('reader.following_page')} disabled={view.page >= pages.length - 1} onClick={event => onPage(view.page + 1, event.detail === 0)}><ChevronRight /></StudioIconButton>
        </div>
        : <ResultPager offset={view.offset} total={total} onOffset={onOffset} />}
    </div>
  </div>;
}

function ResultPager({ offset, total, onOffset }: { offset: number; total: number; onOffset: (offset: number) => void }) {
  const { t, i18n } = useTranslation('text');
  const pages = Math.max(1, Math.ceil(total / RESULT_PAGE_SIZE));
  const current = Math.floor(offset / RESULT_PAGE_SIZE) + 1;
  return <div className="lt-pager">
    <StudioIconButton size="icon-xs" label={t('reader.previous_page')} disabled={offset <= 0} onClick={() => onOffset(Math.max(0, offset - RESULT_PAGE_SIZE))}><ChevronLeft /></StudioIconButton>
    <span className="lt-pager-range">{current.toLocaleString(i18n.language)} / {pages.toLocaleString(i18n.language)}</span>
    <StudioIconButton size="icon-xs" label={t('reader.following_page')} disabled={offset + RESULT_PAGE_SIZE >= total} onClick={() => onOffset(offset + RESULT_PAGE_SIZE)}><ChevronRight /></StudioIconButton>
  </div>;
}
