import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, Calculator, CheckCheck, ChevronDown, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolStatBar } from '../../_shared/ui/ToolStatBar';
import type { ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { KnowledgeTrialResult } from '@/subtitle-studio/knowledge-trial-contract';
import { partialCheck, readyCount, type TranslationCheck } from '@/services/subtitle-studio/translation-session';
import { StudioBatchItems } from './StudioBatchItems';
import { StudioDocumentRow } from './StudioDocumentList';
import { StudioKnowledgeTrial } from './StudioKnowledgeTrial';
import { StudioKnowledgeBatch } from './StudioKnowledgeBatch';

type Props = {
  open: boolean;
  purpose: 'check' | 'trial';
  activity: 'check' | 'start' | 'trial' | 'save' | null;
  check: TranslationCheck | null;
  result: KnowledgeTrialResult | null;
  library: LibrarySnapshot | null;
  page?: DocumentPage;
  error: ErrorCode | null;
  errorLabel: (error: ErrorCode) => string;
  notice: string;
  canAct: boolean;
  onClose: () => void;
  onRestoreFocus: () => void;
  onRetry: () => void;
  onStart: () => void;
  onRerunTrial: () => void;
  onCancelTrial: () => void;
};

/** Inspection is a separate step; the parent keeps the editable draft and plan authority. */
export function StudioTranslationReview(props: Props) {
  const { t, i18n } = useTranslation();
  const back = useRef<HTMLButtonElement>(null);
  // Radix retains the closing surface for its exit animation. Keep its last
  // presentation while only current props may authorize an action.
  const lastOpen = useRef(props);
  if (props.open) lastOpen.current = props;
  const view = props.open ? props : lastOpen.current;
  const { check, result, activity, purpose, error, errorLabel, notice, library, page } = view;
  const pending = activity !== null;
  const plain = check?.kind === 'plain' ? check.value : null;
  const batch = check?.kind === 'plain-batch' ? check.value : null;
  const estimate = plain ?? (batch ? { estimatedInputTokens: batch.totalEstimatedInputTokens, outputTokenReserve: batch.totalOutputTokenReserve,
    batchCount: batch.items.reduce((count, item) => count + (item.ok ? item.plan.batchCount : 0), 0) } : null);
  const canStart = props.open && props.canAct && !!props.check && readyCount(props.check) > 0 && !props.result;
  const partial = !!check && partialCheck(check) && readyCount(check) > 0;
  return <ScrollableDialog open={props.open} onOpenChange={value => { if (!value && activity !== 'start') props.onClose(); }}
    maxWidth="sm:max-w-[560px]" contentClassName="studio-translation-review-dialog"
    onOpenAutoFocus={event => { event.preventDefault(); back.current?.focus({ preventScroll: true }); }}
    onCloseAutoFocus={event => { event.preventDefault(); props.onRestoreFocus(); }}>
    <ScrollableDialogHeader className="studio-translation-compact-header">
      <DialogTitle className="flex min-h-7 items-center gap-2 text-sm leading-6"><Calculator className="size-4 shrink-0" />{t(purpose === 'trial' ? 'studio:materials.trial' : 'studio:materials.check')}</DialogTitle>
      <DialogDescription className="sr-only">{t('studio:materials.review_description')}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="studio-translation-content" fadeMaskHeight={16}>
      <div data-testid="studio-translation-review-dialog" className="studio-translation-review-body" aria-busy={pending}>
        {pending ? <div data-testid="studio-translation-review-loading" className="studio-translation-review-loading" role="status">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
          <p>{t(activity === 'trial' ? 'studio:materials.review_trial_running' : activity === 'start' ? 'studio:materials.review_starting' : 'studio:materials.review_checking')}</p>
          {activity === 'check' && <span>{t('studio:materials.review_checking_help')}</span>}
        </div> : <>
          {error && <div data-testid="studio-translation-review-error" className="studio-translation-review-error" role="alert"><AlertCircle className="size-4 shrink-0" /><p>{errorLabel(error)}</p></div>}
          {notice && <p role="status" className="text-xs leading-5 text-muted-foreground">{notice}</p>}
          {estimate && <section data-testid={batch ? 'studio-batch-plan' : 'studio-translation-plan'} className="studio-translation-plan" aria-live="polite">
            <ToolStatBar columns={3} className="studio-translation-estimate shadow-none" gridClassName="studio-translation-estimate-grid"
              title={batch ? t('studio:batch.ready_count', { count: batch.items.filter(item => item.ok).length, total: batch.items.length }) : t('studio:translation.estimate')}
              icon={batch ? batch.items.some(item => !item.ok) ? <AlertCircle className="text-amber-600 dark:text-amber-400" /> : <CheckCheck className="text-emerald-600 dark:text-emerald-400" /> : <Calculator />}
              items={[
                { label: t('studio:translation.estimated_input'), value: estimate.estimatedInputTokens.toLocaleString(i18n.language) },
                { label: t('studio:translation.batch_count'), value: estimate.batchCount.toLocaleString(i18n.language) },
                { label: t('studio:translation.output_reserve'), value: estimate.outputTokenReserve.toLocaleString(i18n.language) },
              ]} />
            {batch && <>
              <p className="studio-batch-note">{t('studio:batch.translation_queue_note')}</p>
              <details key={batch.batchId} className="studio-translation-plan-details">
                <summary>{t('studio:operation_result.details')}<ChevronDown aria-hidden="true" /></summary>
                <StudioBatchItems>{batch.items.map(item => <StudioDocumentRow key={item.documentId} data-document-id={item.documentId} data-state={item.ok ? 'ready' : 'failed'} name={item.displayName} status={item.ok ? t('studio:batch.ready') : errorLabel(item.error)} />)}</StudioBatchItems>
              </details>
            </>}
          </section>}
          <StudioKnowledgeTrial library={library} page={page} preview={check?.kind === 'trial' ? check.value : null} documentPreview={check?.kind === 'knowledge' ? check.value : null} result={result} />
          {check?.kind === 'knowledge-batch' && <StudioKnowledgeBatch preview={check.value} library={library} />}
          {!error && !check && !result && <p role="status" className="text-xs leading-5 text-muted-foreground">{t('studio:materials.review_stale')}</p>}
        </>}
      </div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="studio-translation-review-footer">
      <Button ref={back} data-testid="studio-translation-review-close" variant="ghost" size="sm" disabled={activity === 'start'} onClick={props.onClose}><ArrowLeft />{t('studio:materials.review_back')}</Button>
      {result ? <Button data-testid="studio-translation-review-rerun-trial" variant="outline" size="sm" disabled={!props.canAct} onClick={props.onRerunTrial}><RefreshCw />{t('studio:materials.review_rerun_trial')}</Button>
        : activity === 'trial' ? <Button data-testid="studio-translation-review-cancel-trial" variant="outline" size="sm" onClick={props.onCancelTrial}>{t('knowledge:trial.cancel')}</Button>
        : !pending && (error || !check && !result) ? <Button data-testid="studio-translation-review-retry" variant="outline" size="sm" disabled={!props.canAct} onClick={props.onRetry}><RefreshCw />{t('studio:materials.review_retry')}</Button>
          : !result && <Button data-testid="studio-translation-review-start" size="sm" disabled={!canStart} onClick={props.onStart}>{pending ? <LoaderCircle className="animate-spin" /> : <Play />}{t(purpose === 'trial' ? 'studio:materials.trial' : partial ? 'studio:batch.start_ready' : 'studio:translation.start', { count: check ? readyCount(check) : 0 })}</Button>}
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
