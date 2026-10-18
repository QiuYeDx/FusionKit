import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Download, LoaderCircle, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { getLocalPreparation, preparationPlan } from '@/services/subtitle-studio/local-preparation';
import type { StudioTranscriptionState } from '@/services/subtitle-studio/transcription-controller';
import { resourceDisplayName } from './resource-names';

function size(value: number) {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

/**
 * "One-click prepare" at the top of the resource manager: the recommended model and voice
 * detection in one go, with the download size, the free space, progress and the outcome. The
 * run itself lives in a shared service, so it continues when this dialog closes.
 */
export function StudioLocalPrepare({ state, freeBytes }: { state: StudioTranscriptionState; freeBytes: number | null }) {
  const { t } = useTranslation();
  const preparation = getLocalPreparation();
  const run = useSyncExternalStore(preparation.subscribe, preparation.getState);
  const plan = preparationPlan(state.resources);
  if (plan.targets.length < 2) return null;
  const busy = run.phase === 'checking' || run.phase === 'installing';
  const lowSpace = freeBytes !== null && plan.missingBytes > 0 && freeBytes < plan.missingBytes;
  const running = run.steps.findIndex(step => step.status === 'running');
  const runningResource = running >= 0 ? state.resources.find(resource => resource.resourceId === run.steps[running]!.resourceId) : undefined;
  const start = (skipRuntimeCheck = false) => { void preparation.start({ origin: 'studio', skipRuntimeCheck }); };
  // Once everything is installed (for example from the rows below), an earlier failure or cancel no longer applies.
  const outcome = plan.ready ? undefined : run.phase === 'failed' ? { key: 'studio:transcription.prepare_failed', tone: 'warning' } as const
      : run.phase === 'cancelled' ? { key: 'studio:transcription.prepare_cancelled', tone: 'help' } as const : undefined;
  return <section className="studio-resources-prepare" data-testid="studio-resources-prepare" data-phase={run.phase} data-ready={plan.ready || undefined} aria-labelledby="studio-resources-prepare-title">
    <div className="studio-resource-heading">
      <div className="studio-resource-identity">
        <p id="studio-resources-prepare-title" className="studio-resource-name">{t('studio:transcription.prepare_title')}</p>
        {plan.ready && run.phase === 'completed'
          ? <p role="status" className="studio-resources-prepare-done" data-testid="studio-resources-prepare-outcome">{t('studio:transcription.prepare_done')}</p>
          : <p className="studio-transcription-help">{t(plan.ready ? 'studio:transcription.prepare_ready_hint' : 'studio:transcription.prepare_description')}</p>}
        {!plan.ready && <div className="studio-resource-meta">
          <span data-testid="studio-resources-prepare-size">{t('studio:transcription.prepare_size', { size: size(plan.missingBytes) })}</span>
          {freeBytes !== null && <span data-testid="studio-resources-prepare-free">{t('studio:transcription.prepare_free_space', { size: size(freeBytes) })}</span>}
        </div>}
      </div>
      <div className="studio-resource-actions">
        {busy ? <Button variant="outline" size="sm" data-testid="studio-resources-prepare-cancel" disabled={run.phase === 'checking'} onClick={() => void preparation.cancel()}>
          {run.phase === 'checking' ? <LoaderCircle className="studio-spin" /> : <Square />}{t(run.phase === 'checking' ? 'studio:transcription.prepare_checking' : 'studio:transcription.prepare_cancel')}</Button>
          : <Button size="sm" data-testid="studio-resources-prepare-start" disabled={plan.ready} onClick={() => start()}>
            {plan.ready ? <Check /> : <Download />}{t(plan.ready ? 'studio:transcription.prepare_ready' : 'studio:transcription.prepare_action')}</Button>}
      </div>
    </div>
    <DialogTransition transitionKey="prepare-feedback" stageClassName="studio-resource-feedback">
      {lowSpace && !busy && <p role="status" className="studio-transcription-row-warning" data-testid="studio-resources-prepare-low-space">{t('studio:transcription.prepare_low_space', { size: size(plan.missingBytes), free: size(freeBytes ?? 0) })}</p>}
      {run.phase === 'installing' && <>
        {/* The bar is the whole preparation by size; the line below names the current download and its own progress. */}
        <progress max={100} value={Math.round(run.progress)} aria-label={t('studio:transcription.prepare_title')} className="studio-transcription-progress" data-testid="studio-resources-prepare-progress" />
        <p className="studio-transcription-help" role="status">
          {t('studio:transcription.prepare_running', { name: runningResource ? resourceDisplayName(key => t(key), runningResource, 'short') : '', current: Math.max(1, running + 1), total: run.steps.length })}
          {running >= 0 && <span className="studio-resource-percentage"> · {Math.round(run.steps[running]!.progress)}%</span>}
        </p>
      </>}
      {/* The repair button is the runtime notice above this card; preparing continues by itself once it is fixed. */}
      {run.phase === 'runtime_needed' && !plan.ready && <div className="studio-resource-failure" data-testid="studio-resources-prepare-runtime">
        <p className="studio-transcription-row-warning">{t('studio:transcription.prepare_runtime_needed')}</p>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="xs" data-testid="studio-resources-prepare-anyway" onClick={() => start(true)}>{t('studio:transcription.prepare_download_anyway')}</Button>
          {/* Stops waiting, so a later repair (for another download) does not start preparing. */}
          <Button variant="ghost" size="xs" data-testid="studio-resources-prepare-dismiss" onClick={() => void preparation.cancel()}>{t('studio:transcription.prepare_cancel')}</Button>
        </div>
      </div>}
      {outcome && <p role="status" data-testid="studio-resources-prepare-outcome"
        className={outcome.tone === 'warning' ? 'studio-transcription-row-warning' : 'studio-transcription-help'}>{t(outcome.key)}</p>}
    </DialogTransition>
  </section>;
}
