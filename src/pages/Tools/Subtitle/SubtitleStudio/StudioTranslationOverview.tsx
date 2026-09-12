import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Clock3, Languages, LoaderCircle, RefreshCw, Subtitles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { getStudioTranslationOverviewController, getTranslationRoundProgress } from '@/services/subtitle-studio/translation-overview-controller';
import type { TranslationTaskStatus } from '@/subtitle-studio/ipc-contract';
import { StudioIconButton, StudioPagination } from './StudioControls';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import './StudioTranslationOverview.css';

const statusKeys = {
  queued: 'studio:translation.queued', running: 'studio:translation.running',
  completed: 'studio:translation.completed', failed: 'studio:translation.failed',
  cancelled: 'studio:translation.cancelled', interrupted: 'studio:translation.interrupted',
  needs_configuration: 'studio:translation.needs_configuration',
} as const satisfies Record<TranslationTaskStatus, string>;
const statuses = Object.keys(statusKeys) as TranslationTaskStatus[];
const errorKeys = { translation_failed: 'studio:errors.translation_failed', translation_protocol_invalid: 'studio:errors.translation_protocol_invalid',
  translation_output_limit: 'studio:errors.translation_output_limit', needs_configuration: 'studio:errors.needs_configuration',
  limit_exceeded: 'studio:errors.limit_exceeded', revision_conflict: 'studio:errors.revision_conflict', interrupted: 'studio:errors.interrupted' } as const;
const attention = (status: TranslationTaskStatus) => ['failed', 'interrupted', 'needs_configuration'].includes(status);

export function StudioTranslationOverview({ onOpenDocument, compact = false }: { onOpenDocument: (documentId: string, trackId?: string) => void | Promise<void>; compact?: boolean }) {
  const { t } = useTranslation();
  const controller = getStudioTranslationOverviewController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const { snapshot, round } = state;
  const percent = getTranslationRoundProgress(state);
  const [now, setNow] = useState(Date.now);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
    return () => { lifetime.current++; controller.setDetailsOpen(false); };
  }, [controller]);
  const waiting = state.detailsOpen && snapshot?.items.some(task => (task.status === 'queued' || task.status === 'running' || task.canResume) && (task.notBefore ?? 0) > now);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const open = async (documentId: string, trackId: string) => {
    if (opening) return;
    const instance = lifetime.current;
    setOpening(documentId); setOpenError(false);
    try { await onOpenDocument(documentId, trackId); if (instance === lifetime.current) controller.setDetailsOpen(false); }
    catch { if (instance === lifetime.current) setOpenError(true); }
    finally { if (instance === lifetime.current) setOpening(null); }
  };
  const roundActive = !!round && round.counts.running + round.counts.queued > 0;
  const roundAttention = round ? round.counts.failed + round.counts.interrupted + round.counts.needs_configuration : 0;
  const activeCount = snapshot ? snapshot.counts.running + snapshot.counts.queued : 0;
  const attentionCount = snapshot ? snapshot.counts.failed + snapshot.counts.interrupted + snapshot.counts.needs_configuration : 0;
  const summary = snapshot?.total ? statuses.filter(status => snapshot.counts[status] > 0).map(status => `${t(statusKeys[status])} ${snapshot.counts[status]}`).join(' · ') : t(snapshot ? 'studio:overview.empty' : 'studio:overview.loading');
  const showDetails = () => { setOpenError(false); controller.setDetailsOpen(true); };
  return <>
    {compact ? <Tooltip><TooltipTrigger asChild><Button ref={trigger} variant="ghost" size="sm" className="studio-translation-overview-compact" data-testid="studio-translation-overview-details" aria-label={t('studio:overview.title')} onClick={showDetails}><Languages />{activeCount + attentionCount > 0 && <span className={attentionCount ? 'text-destructive' : undefined}>{activeCount + attentionCount}</span>}{(state.error || !!snapshot?.unavailableDocuments) && <AlertCircle className="text-destructive" />}</Button></TooltipTrigger><TooltipContent><span>{t('studio:overview.title')} · {summary}</span></TooltipContent></Tooltip> : <section className="studio-translation-overview" data-testid="studio-translation-overview" aria-label={t('studio:overview.title')}>
      <ToolPanel title={t('studio:overview.title')} icon={Languages} actions={<Button ref={trigger} variant="ghost" size="sm" data-testid="studio-translation-overview-details" onClick={showDetails}>{t('studio:overview.details')}</Button>}>
      <div className="studio-translation-overview-counts" role="status">{snapshot?.total ? statuses.filter(status => snapshot.counts[status] > 0).map(status => <span key={status} className={attention(status) ? 'text-destructive' : undefined}>{t(statusKeys[status])}<b>{snapshot.counts[status]}</b></span>) : <span>{t(snapshot ? 'studio:overview.empty' : 'studio:overview.loading')}</span>}</div>
      {!!state.roundTaskIds.length && <div className="studio-translation-overview-round" data-testid="studio-translation-round" role="status">
        {roundActive ? <LoaderCircle className="size-3 studio-spin" /> : round?.counts.completed === state.roundTaskIds.length ? <Check className="size-3" /> : <Clock3 className="size-3" />}
        <span>{t('studio:overview.round_submitted', { count: state.roundTaskIds.length })}</span>
        {percent !== null && round ? <><progress max={100} value={percent} aria-label={t('studio:overview.confirmed_progress')} /><span className="studio-translation-overview-percent">{percent}%</span><span>{t('studio:translation.batch_progress', { completed: round.completedBatches, total: round.totalBatches })}</span></> : <span>{t(round ? 'studio:overview.round_unavailable' : 'studio:overview.loading')}</span>}
        {round && <span>{t('studio:overview.round_counts', { completed: round.counts.completed, active: round.counts.running + round.counts.queued, attention: roundAttention, cancelled: round.counts.cancelled })}</span>}
      </div>}
      {(state.error || !!snapshot?.unavailableDocuments) && <p className="studio-translation-overview-warning" role="status"><AlertCircle className="size-3.5" />{state.error ? t('studio:overview.read_error') : t('studio:overview.unavailable', { count: snapshot?.unavailableDocuments })}</p>}
      </ToolPanel>
    </section>}
    <ScrollableDialog open={state.detailsOpen} onOpenChange={controller.setDetailsOpen} maxWidth="sm:max-w-[720px]" contentClassName="studio-translation-overview-dialog" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader><DialogTitle className="flex items-center gap-2 text-sm"><Languages className="size-4" />{t('studio:overview.title')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:overview.description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent fadeMaskHeight={16}><div className="studio-translation-overview-content">
        {(state.error || openError) && <p role="alert" className="studio-translation-overview-warning"><AlertCircle className="size-4" />{t(openError ? 'studio:overview.open_error' : 'studio:overview.read_error')}</p>}
        {!!snapshot?.unavailableDocuments && <p role="status" className="studio-translation-overview-warning">{t('studio:overview.unavailable', { count: snapshot.unavailableDocuments })}</p>}
        {snapshot?.items.length ? <StudioDocumentList scroll={false} className="studio-translation-overview-list" data-testid="studio-translation-overview-list">{snapshot.items.map(task => <StudioDocumentRow key={task.taskId} data-task-id={task.taskId} data-state={task.status} name={task.displayName} density="detail"
          actions={<Button variant="outline" size="sm" disabled={opening !== null} onClick={() => void open(task.documentId, task.trackId)}>{opening === task.documentId ? <LoaderCircle className="studio-spin" /> : <Subtitles />}{t('studio:overview.open_document')}</Button>}>
          <div className="studio-translation-overview-task-meta"><span className={attention(task.status) ? 'text-destructive' : undefined}>{t(statusKeys[task.status])}</span><span>{task.language} · {task.modelKey}</span><span>{t('studio:translation.batch_progress', { completed: task.completedBatches, total: task.totalBatches })}</span>{task.canResume && <span>{t('studio:overview.can_resume')}</span>}</div>
          <progress max={Math.max(1, task.totalBatches)} value={task.completedBatches} aria-label={`${t('studio:overview.confirmed_progress')} · ${task.displayName}`} />
          {(task.status === 'queued' || task.status === 'running' || task.canResume) && (task.notBefore ?? 0) > now && <p className="studio-translation-overview-task-note"><Clock3 className="size-3" />{t('studio:translation.provider_wait', { seconds: Math.max(0, Math.ceil((task.notBefore! - now) / 1000)) })}</p>}
          {task.error && <p className="studio-translation-overview-warning">{t(errorKeys[task.error])}</p>}
        </StudioDocumentRow>)}</StudioDocumentList> : <p className="studio-translation-overview-empty">{t(state.refreshing && !snapshot ? 'studio:overview.loading' : 'studio:overview.empty')}</p>}
      </div></ScrollableDialogContent>
      <ScrollableDialogFooter className="studio-translation-overview-footer"><StudioIconButton label={t('studio:refresh')} disabled={state.refreshing} onClick={() => void controller.refresh()}><RefreshCw className={state.refreshing ? 'studio-spin' : undefined} /></StudioIconButton><StudioPagination offset={state.offset} pageSize={state.pageSize} total={snapshot?.total ?? 0} busy={state.refreshing} onChange={controller.setOffset} /><Button variant="outline" size="sm" onClick={() => controller.setDetailsOpen(false)}>{t('studio:batch.close')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
