import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, LoaderCircle, Pause, Play, RotateCcw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentSummary } from '@/long-text/contract';
import { percentDone } from '../DocumentLibrary';
import { MODEL_PROBLEM_LABELS } from '../labels';
import { groupedCount, useLongTextPage, type StartIntent } from '../page-context';
import { estimateText } from './ReaderFooter';

/** What the primary run button does (design §5.2.3). */
export type PrimaryAction =
  | { kind: 'translate_all' | 'continue' }
  | { kind: 'retry_failed'; count: number }
  | { kind: 'export' }
  | { kind: 'pause' }
  | { kind: 'pausing' };

/**
 * The primary button for a document: pause while translating; otherwise translate everything, continue,
 * retry the failed segments, or export once all are done.
 */
export function primaryAction(summary: Pick<DocumentSummary, 'run' | 'counts' | 'fullRunStarted'>): PrimaryAction {
  const status = summary.run?.status;
  if (status === 'running') return { kind: 'pause' };
  if (status === 'pausing') return { kind: 'pausing' };
  const { pending, failed } = summary.counts;
  if (pending > 0) return { kind: summary.fullRunStarted ? 'continue' : 'translate_all' };
  if (failed > 0) return { kind: 'retry_failed', count: failed };
  return { kind: 'export' };
}

/** "试译" is offered while no full run ever started, nothing runs and something is left to translate. */
export function offersSample(summary: Pick<DocumentSummary, 'run' | 'counts' | 'fullRunStarted'>): boolean {
  const status = summary.run?.status;
  return !summary.fullRunStarted && status !== 'running' && status !== 'pausing' && summary.counts.pending > 0;
}

/** A tooltip that also shows on a disabled button, which gets no pointer events itself. */
function Hint({ label, disabled, children }: { label: string | null; disabled?: boolean; children: ReactNode }) {
  if (!label) return <>{children}</>;
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild>{disabled ? <span className="inline-flex" tabIndex={0}>{children}</span> : children}</TooltipTrigger>
    <TooltipContent sideOffset={6} className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-pre-line">{label}</TooltipContent>
  </Tooltip>;
}

/**
 * The toolbar's run controls (design §2 F5–F7): progress while translating, "试译" before the first
 * full run, and the primary button whose job follows the document's state. Every start goes through
 * `page.start`, which checks the encoding, the model and the size of the run first.
 */
export function RunControls({ summary }: { summary: DocumentSummary }) {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const [starting, setStarting] = useState(false);
  const action = primaryAction(summary);
  const problem = 'problem' in page.runModel ? page.runModel.problem : null;
  const modelLabel = 'problem' in page.runModel ? null : page.runModel.model.label;
  const estimate = page.estimate ? estimateText(t, i18n.language, page.estimate, modelLabel) : null;
  const unavailable = problem ? t(MODEL_PROBLEM_LABELS[problem]) : null;
  const run = (intent: StartIntent) => {
    setStarting(true);
    void page.start(intent).finally(() => setStarting(false));
  };

  if (action.kind === 'pause') {
    return <>
      <span className="lt-run-state" data-testid="long-text-run-state">
        <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {summary.run?.kind === 'sample' ? t('run.sampling') : t('run.running_percent', { percent: percentDone(summary) })}
      </span>
      <div className="lt-run-buttons">
        <Button size="sm" variant="outline" data-testid="long-text-primary" onClick={() => void page.pause(false)}><Pause />{t('run.pause')}</Button>
      </div>
    </>;
  }
  if (action.kind === 'pausing') {
    return <div className="lt-run-buttons">
      <Button size="sm" variant="outline" data-testid="long-text-primary" disabled>{t('run.pausing')}</Button>
      <Hint label={t('run.stop_now_tip')}>
        <Button size="sm" variant="ghost" data-testid="long-text-stop-now" onClick={() => void page.pause(true)}><Square />{t('run.stop_now')}</Button>
      </Hint>
    </div>;
  }

  const blocked = !!problem && action.kind !== 'export';
  const primary = action.kind === 'export'
    ? { icon: <Download />, label: t('run.export'), tip: null }
    : action.kind === 'retry_failed'
      ? { icon: <RotateCcw />, label: t('run.retry_failed', { count: groupedCount(action.count, i18n.language) }), tip: unavailable }
      : action.kind === 'continue'
        ? { icon: <Play />, label: t('run.continue'), tip: unavailable ?? [t('run.continue_tip', { count: groupedCount(summary.counts.pending, i18n.language) }), estimate].filter(Boolean).join('\n') }
        : { icon: <Play />, label: t('run.translate_all'), tip: unavailable ?? estimate };
  const choose = () => {
    if (action.kind === 'export') page.openDialog({ kind: 'export' });
    else run({ kind: 'full' });
  };
  return <div className="lt-run-buttons">
    {offersSample(summary) && <Hint label={unavailable ?? t('run.sample_tip')} disabled={blocked}>
      <Button size="sm" variant="ghost" data-testid="long-text-sample" disabled={blocked || starting} onClick={() => run({ kind: 'sample' })}>{t('run.sample')}</Button>
    </Hint>}
    <Hint label={primary.tip} disabled={blocked}>
      <Button size="sm" data-testid="long-text-primary" disabled={blocked || starting} onClick={choose}>{primary.icon}{primary.label}</Button>
    </Hint>
  </div>;
}
