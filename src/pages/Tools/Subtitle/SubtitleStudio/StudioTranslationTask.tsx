import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Clock3, LoaderCircle, Play, Settings, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import useModelStore from '@/store/useModelStore';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { normalizeTranslationModel, translationModelSchema } from '@/subtitle-studio/translation-contract';
import { StudioIconButton } from './StudioControls';
import './StudioTranslation.css';

const errorKeys = {
  invalid_input: 'studio:errors.invalid_input', unsupported_feature: 'studio:errors.unsupported_feature',
  encoding_required: 'studio:errors.encoding_required', limit_exceeded: 'studio:errors.limit_exceeded',
  revision_conflict: 'studio:errors.revision_conflict', access_denied: 'studio:errors.access_denied',
  document_unavailable: 'studio:errors.document_unavailable', output_write_failed: 'studio:errors.output_write_failed',
  needs_configuration: 'studio:errors.needs_configuration', translation_protocol_invalid: 'studio:errors.translation_protocol_invalid',
  translation_output_limit: 'studio:errors.translation_output_limit', translation_failed: 'studio:errors.translation_failed',
  transcription_failed: 'studio:errors.transcription_failed',
  interrupted: 'studio:errors.interrupted',
} as const satisfies Record<ErrorCode, string>;
type Props = {
  page: DocumentPage;
  trackId?: string;
  busy: boolean;
  onChanged: () => void;
  onError: (error: ErrorCode) => void;
};
type Task = DocumentPage['tasks'][number];

export function StudioTranslationTask(props: Props) {
  const tasks = props.trackId ? props.page.tasks.filter(task => task.trackId === props.trackId) : props.page.tasks;
  const task = tasks.find(item => item.translation && (item.status === 'queued' || item.status === 'running'))
    ?? [...tasks].reverse().find(item => item.translation);
  return task?.translation ? <TranslationTaskControls key={`${props.page.summary.id}:${task.id}`} {...props} task={task} /> : null;
}

function TranslationTaskControls({ page, busy, onChanged, onError, task }: Props & { task: Task }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const profiles = useModelStore(state => state.profiles);
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<'resume' | 'cancel' | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [now, setNow] = useState(Date.now);
  const trigger = useRef<HTMLButtonElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const latest = useRef({ page, task });
  latest.current = { page, task };
  const progress = task.translation!;
  const running = task.status === 'queued' || task.status === 'running';
  const stopped = task.status === 'failed' || task.status === 'interrupted' || task.status === 'needs_configuration';
  const recoverable = stopped && !!progress.checkpoint;
  const canCancel = running || stopped;
  const waiting = (progress.notBefore ?? 0) > now;
  const seconds = Math.max(0, Math.ceil(((progress.notBefore ?? 0) - now) / 1000));
  const uncertain = progress.uncertainAttempts ?? task.uncertainBatchIds.length;
  const otherRunning = page.tasks.some(item => item.id !== task.id && (item.status === 'queued' || item.status === 'running'));
  const pending = activity !== null;
  const profile = profiles.find(item => item.id === progress.config.model.profileId);
  const resolved = useMemo(() => {
    const parsed = translationModelSchema.safeParse(profile ? {
      profileId: profile.id, modelKey: profile.modelKey, endpoint: profile.baseUrl,
      apiFormat: profile.apiFormat, outputTokenParameter: profile.outputTokenParameter,
    } : null);
    if (!parsed.success) return null;
    const model = normalizeTranslationModel(parsed.data);
    const frozen = normalizeTranslationModel(progress.config.model);
    return model.profileId === frozen.profileId && model.modelKey === frozen.modelKey
      && model.endpoint === frozen.endpoint && model.apiFormat === frozen.apiFormat
      && model.outputTokenParameter === frozen.outputTokenParameter && model.thinkingEnabled === frozen.thinkingEnabled ? model : null;
  }, [profile, progress.config.model]);
  const configured = !!resolved && !!profile?.apiKey.trim();
  const canResume = recoverable && configured && !waiting && !otherRunning && !busy && !pending;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!progress.notBefore || progress.notBefore <= Date.now()) { setNow(Date.now()); return; }
    const timer = window.setInterval(() => {
      const time = Date.now(); setNow(time);
      if (time >= progress.notBefore!) window.clearInterval(timer);
    }, 1000);
    setNow(Date.now());
    return () => window.clearInterval(timer);
  }, [progress.notBefore]);
  useEffect(() => { if (!recoverable && !pending) setOpen(false); }, [recoverable, pending]);

  const run = async (kind: 'resume' | 'cancel') => {
    if (operation.current || busy || (kind === 'resume' ? !canResume : !canCancel)) return;
    const current = latest.current;
    const request = { documentId: current.page.summary.id, revision: current.page.summary.revision, taskId: current.task.id };
    operation.current = true; setActivity(kind); setError(null);
    try {
      if (kind === 'cancel') await unwrapStudio(window.subtitleStudio.cancelTask(request));
      else await unwrapStudio(window.subtitleStudio.resumeTask({ ...request, model: resolved, apiKey: profile!.apiKey }));
      if (mounted.current && latest.current.page.summary.id === request.documentId && latest.current.task.id === request.taskId) {
        setOpen(false); onChanged();
      }
    } catch (failure) {
      if (mounted.current && latest.current.page.summary.id === request.documentId && latest.current.task.id === request.taskId) {
        const code = failure instanceof StudioError ? failure.code : 'translation_failed';
        setError(code); onError(code);
      }
    } finally { operation.current = false; if (mounted.current) setActivity(null); }
  };

  return <div className="studio-translation-task-controls">
    {stopped && !progress.checkpoint && <span className="studio-translation-task-note">{t('studio:translation.legacy_restart')}</span>}
    {waiting && (running || recoverable) && <span className="studio-translation-task-note"><Clock3 className="size-3.5" />{t('studio:translation.provider_wait', { seconds: seconds.toLocaleString(i18n.language) })}</span>}
    {task.status === 'cancelled' && <span className="studio-translation-task-note">{t('studio:translation.cancelled_preserved')}</span>}
    {recoverable && <Button ref={trigger} variant="outline" size="sm" disabled={busy || pending || otherRunning} onClick={() => { setError(null); setOpen(true); }}><Play />{t('studio:translation.resume')}</Button>}
    {canCancel && <StudioIconButton label={t('studio:translation.cancel_task')} disabled={busy || pending} onClick={() => void run('cancel')}>{activity === 'cancel' ? <LoaderCircle className="studio-spin" /> : <Square />}</StudioIconButton>}
    <ScrollableDialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }} maxWidth="sm:max-w-[520px]" contentClassName="studio-translation-dialog" onOpenAutoFocus={event => { event.preventDefault(); dismiss.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="p-3 pr-12"><DialogTitle className="text-base">{t('studio:translation.resume')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:translation.resume_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-translation-content" fadeMaskHeight={16}>
        <div className="studio-translation-recovery">
          <dl className="studio-translation-frozen">
            <div><dt>{t('studio:translation.original_model')}</dt><dd>{progress.config.model.modelKey}</dd></div>
            <div><dt>{t('studio:translation.completed_batches')}</dt><dd>{task.completedBatchIds.length} / {progress.totalBatches}</dd></div>
          </dl>
          {uncertain > 0 && <p className="studio-translation-recovery-note" role="note"><AlertCircle className="size-4" /><span>{t('studio:translation.uncertain_resume', { count: uncertain })}</span></p>}
          {waiting && <p className="studio-translation-recovery-note"><Clock3 className="size-4" /><span>{t('studio:translation.provider_wait', { seconds: seconds.toLocaleString(i18n.language) })}</span></p>}
          {!configured && <div className="studio-translation-configuration"><p><AlertCircle className="size-4 shrink-0" />{t('studio:translation.repair_model')}</p><Button variant="outline" size="sm" disabled={pending} onClick={() => { setOpen(false); navigate('/setting?tab=model'); }}><Settings />{t('studio:translation.model_settings')}</Button></div>}
          {error && <p className="studio-translation-error" role="alert"><AlertCircle className="size-4" />{t(errorKeys[error])}</p>}
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap justify-end gap-2 p-3"><Button ref={dismiss} variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>{t('studio:cancel')}</Button><Button size="sm" disabled={!canResume} onClick={() => void run('resume')}>{activity === 'resume' ? <LoaderCircle className="studio-spin" /> : <Play />}{t('studio:translation.resume')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
  </div>;
}
