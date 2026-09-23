import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ClipboardList, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { AutomaticKnowledgeReportPage } from '@/subtitle-studio/automatic-knowledge-report-contract';
import type { AutomaticKnowledgeRecheckRequest } from './automatic-knowledge-recheck';
import { StudioFileName } from './StudioControls';

/** Inspect the historical preparation failure without re-running compilation or a model. */
export function StudioAutomaticKnowledgeFailure({ page, taskId, trackId, disabled, onRecheck }: {
  page: DocumentPage; taskId?: string; trackId: string; disabled: boolean;
  onRecheck: (request: AutomaticKnowledgeRecheckRequest) => boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  const [result, setResult] = useState<AutomaticKnowledgeReportPage | null>(null);
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null), dismiss = useRef<HTMLButtonElement>(null);
  const active = useRef(false), epoch = useRef(0), handingOff = useRef(false);
  const identity = `${page.summary.id}:${trackId}:${taskId}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const close = () => { epoch.current++; active.current = false; setOpen(false); setPending(false); };
  useEffect(() => { close(); setResult(null); setFailed(false); setOffset(0); }, [identity]);
  useEffect(() => () => { epoch.current++; active.current = false; }, []);
  useEffect(() => {
    if (!open) return;
    const requestEpoch = ++epoch.current, requestIdentity = identity;
    let cancelled = false;
    setPending(true); setFailed(false); setResult(null);
    const current = () => !cancelled && active.current && epoch.current === requestEpoch && identityRef.current === requestIdentity;
    void window.subtitleStudio.readAutomaticKnowledgeReport({ documentId: page.summary.id, trackId }).then(response => {
      if (!current()) return;
      if (response.ok) { setResult(response.value); setOffset(0); } else setFailed(true);
    }, () => { if (current()) setFailed(true); }).finally(() => { if (current()) setPending(false); });
    return () => { cancelled = true; };
  }, [open, identity, page.summary.revision, refresh]);
  const available = result?.state === 'available' ? result : null;
  const seed = result && 'seed' in result ? result.seed : null;
  const issues = available ? [...available.issues].sort((left, right) => Number(right.severity === 'error') - Number(left.severity === 'error')) : [];
  const pages = Math.max(1, Math.ceil(issues.length / 10)), currentPage = Math.min(offset, pages - 1);
  const recheck = () => {
    if (disabled || pending || !seed || seed.documentId !== page.summary.id || seed.trackId !== trackId || taskId && seed.taskId !== taskId) return;
    const request: AutomaticKnowledgeRecheckRequest = { requestId: crypto.randomUUID(), documentId: page.summary.id, trackId,
      seed: structuredClone(seed), restoreFocus: () => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); } };
    if (onRecheck(request)) { handingOff.current = true; close(); }
  };

  return <>
    <Button ref={trigger} data-testid="studio-automatic-knowledge-report" size="sm" variant="outline" disabled={disabled} onClick={() => {
      if (active.current) return;
      active.current = true; handingOff.current = false; setOpen(true); setFailed(false); setResult(null); setOffset(0);
    }}><ClipboardList />{t('knowledge:recovery.open')}</Button>
    <ScrollableDialog animateSize open={open} onOpenChange={next => { if (!next) close(); }} maxWidth="sm:max-w-3xl" contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden"
      onOpenAutoFocus={event => { event.preventDefault(); dismiss.current?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={event => { event.preventDefault(); if (!handingOff.current && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="p-3"><DialogTitle className="flex items-center gap-2 text-base"><AlertCircle className="size-4 text-destructive" />{t('knowledge:recovery.title')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('knowledge:recovery.description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:p-3" fadeMaskHeight={16}>
        <div data-testid="automatic-knowledge-report-content" data-state={pending ? 'loading' : failed ? 'error' : result?.state} aria-busy={pending} className="min-w-0 space-y-4 text-xs leading-5 [overflow-wrap:anywhere]">
          <DialogTransition transitionKey={pending ? 'loading' : failed ? 'error' : `${result?.state ?? 'empty'}:${currentPage}`} stageClassName="min-w-0 space-y-4">
          <div className="text-sm"><StudioFileName name={page.summary.origin.displayName} focusable /></div>
          {available && <p data-testid="automatic-knowledge-report-time" className="text-muted-foreground">{t('knowledge:recovery.checked_at', { time: new Date(available.createdAt).toLocaleString(i18n.language) })}</p>}
          {pending && <p role="status" className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('knowledge:loading')}</p>}
          {(failed || result?.state === 'unavailable') && <p role="alert" className="text-destructive">{t('knowledge:recovery.unavailable')}</p>}
          {result?.state === 'none' && <p role="status" className="text-muted-foreground">{t('knowledge:recovery.none')}</p>}
          {result?.state === 'legacy' && <p role="status" className="text-muted-foreground">{t('knowledge:recovery.legacy')}</p>}
          {available && <>
            <p data-testid="automatic-knowledge-report-reason" className="text-destructive">{t(`studio:errors.${available.error}`)}</p>
            <div className="space-y-2 text-muted-foreground">
              {available.material.recipeName && <p>{t('knowledge:trial.recipe')} · {available.material.recipeName}</p>}
              <p>{t('knowledge:recovery.materials', { collections: available.material.collectionCount, topics: available.material.documentTopicCount })}</p>
              {available.material.collections.length > 0 && <p>{available.material.collections.join(' / ')}</p>}
              {available.material.documentTopics.length > 0 && <p>{available.material.documentTopics.join(' / ')}</p>}
              <p>{t('knowledge:recovery.issues', { count: available.issueCount })}</p>
            </div>
            {(available.stale || available.sourceChanged) && <p data-testid="automatic-knowledge-report-stale" role="status" className="rounded-md border p-3 text-muted-foreground">{t(available.sourceChanged ? 'knowledge:recovery.source_changed' : 'knowledge:recovery.stale')}</p>}
            {available.issuesTruncated && <p className="text-muted-foreground">{t('knowledge:recovery.limited', { shown: issues.length, count: available.issueCount })}</p>}
            {!issues.length && <p className="text-muted-foreground">{t('knowledge:recovery.no_details')}</p>}
            <div className="min-w-0 space-y-3">{issues.slice(currentPage * 10, (currentPage + 1) * 10).map((issue, index) => <article key={`${currentPage}:${index}`} data-testid="automatic-knowledge-report-issue" data-issue-code={issue.code} className="min-w-0 space-y-2 rounded-md border p-3">
              <p className={issue.severity === 'error' ? 'font-medium text-destructive' : 'font-medium'}>{t(issue.severity === 'error' ? 'knowledge:batch.issue_error' : 'knowledge:batch.issue_warning')} · {t(`knowledge:trial.issue.${issue.code}`)}</p>
              {issue.entries.length > 0 && <ul className="space-y-1">{issue.entries.map(entry => <li key={entry.entryId}>{entry.title}</li>)}</ul>}
              {issue.cues.length > 0 && <div className="space-y-2 border-l pl-3 text-muted-foreground">{issue.cues.map(cue => <p key={cue.cueId} className="whitespace-pre-wrap">{t('knowledge:recovery.cue', { number: cue.number })} · {cue.text}</p>)}</div>}
              {(issue.entryCount > issue.entries.length || issue.cueCount > issue.cues.length) && <p className="text-muted-foreground">{t('knowledge:recovery.issue_limited', { entries: issue.entryCount, cues: issue.cueCount })}</p>}
            </article>)}</div>
            {pages > 1 && <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-muted-foreground"><span>{t('knowledge:pagination', { count: issues.length, page: currentPage + 1, pages })}</span><div className="flex gap-1"><Button size="sm" variant="ghost" disabled={pending || currentPage === 0} onClick={() => setOffset(currentPage - 1)}>{t('knowledge:actions.previous')}</Button><Button size="sm" variant="ghost" disabled={pending || currentPage + 1 >= pages} onClick={() => setOffset(currentPage + 1)}>{t('knowledge:actions.next')}</Button></div></div>}
          </>}
          {!pending && (result?.state === 'available' || result?.state === 'legacy') && <p className="text-muted-foreground">{t(seed ? 'knowledge:recovery.recheck_help' : 'knowledge:recovery.seed_unavailable')}</p>}
          </DialogTransition>
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap justify-end gap-2 p-3">
        <Button ref={dismiss} data-testid="automatic-knowledge-report-close" size="sm" variant="ghost" onClick={close}>{t('knowledge:actions.close')}</Button>
        <Button data-testid="automatic-knowledge-report-refresh" size="sm" variant="outline" disabled={pending} onClick={() => setRefresh(value => value + 1)}><RefreshCw />{t('studio:refresh')}</Button>
        <Button data-testid="automatic-knowledge-report-recheck" size="sm" disabled={disabled || pending || !seed} onClick={recheck}>{t('knowledge:recovery.recheck')}</Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
