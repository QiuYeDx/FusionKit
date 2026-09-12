import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { speechResourceIsBusy } from '@/speech-resources/events';
import type { LocalSubtitleManagedResourceSummary } from '@/subtitle-studio/transcription/ipc-contract';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AudioLines, Check, Download, Ellipsis, FolderOpen, HardDrive, ListOrdered, LoaderCircle, Play, RefreshCw, Settings2, SlidersHorizontal, Square, Subtitles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolDetailLayout } from '../../_shared/ui/ToolDetailLayout';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import { ToolConfigPanel } from '../../_shared/ui/ToolConfigPanel';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolSwitchRow } from '../../_shared/ui/ToolSwitchRow';
import { ToolConfigDisclosure } from '../../_shared/ui/ToolConfigDisclosure';
import { ToolFilePickerSurface } from '../../_shared/ui/ToolFilePickerSurface';
import { getStudioTranscriptionController, getTranscriptionReadiness } from '@/services/subtitle-studio/transcription-controller';
import type { EnqueueTranscriptionRequest, TranscriptionTaskSummary } from '@/subtitle-studio/transcription/task-contract';
import { LOCAL_SUBTITLE_LIMITS, LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '@/subtitle-studio/transcription/domain';
import { StudioFileName, StudioIconButton } from './StudioControls';
import './StudioTranscription.css';

type Config = EnqueueTranscriptionRequest['config'];
const taskStatusKeys = {
  queued: 'studio:transcription.status_queued', preparing_media: 'studio:transcription.status_preparing_media',
  loading_model: 'studio:transcription.status_loading_model', transcribing: 'studio:transcription.status_transcribing',
  post_processing: 'studio:transcription.status_post_processing', completed: 'studio:transcription.status_completed',
  cancelled: 'studio:transcription.status_cancelled', failed: 'studio:transcription.status_failed',
} as const;
const resourceStatusKeys = { ready: 'studio:transcription.resource_ready', not_installed: 'studio:transcription.resource_not_installed', installing: 'studio:transcription.resource_installing', invalid: 'studio:transcription.resource_invalid' } as const;
const readinessKeys = {
  busy: 'studio:transcription.readiness_busy', uncertain_submission: 'studio:transcription.readiness_unknown',
  configuration_invalid: 'studio:transcription.readiness_config', runtime_not_ready: 'studio:transcription.readiness_runtime',
  model_not_ready: 'studio:transcription.readiness_model', vad_not_ready: 'studio:transcription.readiness_vad',
  accelerator_not_ready: 'studio:transcription.readiness_accelerator', no_media: 'studio:transcription.readiness_media',
} as const;
const languages = [
  ['auto', 'studio:transcription.language_auto'], ['zh', 'studio:transcription.language_zh'], ['en', 'studio:transcription.language_en'],
  ['ja', 'studio:transcription.language_ja'], ['ko', 'studio:transcription.language_ko'], ['fr', 'studio:transcription.language_fr'],
  ['de', 'studio:transcription.language_de'], ['es', 'studio:transcription.language_es'],
] as const;
const devices = [['auto', 'studio:transcription.device_auto'], ['cpu', 'studio:transcription.device_cpu'], ['metal', 'studio:transcription.device_metal'], ['cuda', 'studio:transcription.device_cuda']] as const;
const terminal = (task: TranscriptionTaskSummary) => ['completed', 'cancelled', 'failed'].includes(task.status);
const activeResource = (status: string) => !['completed', 'failed', 'cancelled'].includes(status);
function bytes(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${Math.round(value / 1024)} KB` : `${value} B`; }
function duration(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
const numericFields = [
  ['beamSize', 'studio:transcription.beam_size', 1, 10, 1], ['temperature', 'studio:transcription.temperature', 0, 1, 0.1],
  ['vadMinSilenceMs', 'studio:transcription.vad_silence', 100, 5000, 1], ['maxCueDurationMs', 'studio:transcription.cue_duration', 500, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs, 1],
  ['maxCueChars', 'studio:transcription.cue_chars', 20, LOCAL_SUBTITLE_LIMITS.maxCueTextChars, 1], ['maxLineChars', 'studio:transcription.line_chars', 10, LOCAL_SUBTITLE_LIMITS.maxLineChars, 1],
] as const;
type NumericKey = typeof numericFields[number][0];
const numericValid = (text: string, min: number, max: number, step: number) => text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= min && Number(text) <= max && (step !== 1 || Number.isInteger(Number(text)));

export function StudioTranscription({ header, onOpenDocument }: { header: ReactNode; onOpenDocument: (id: string) => Promise<void> }) {
  const { t } = useTranslation();
  const controller = getStudioTranscriptionController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const readiness = getTranscriptionReadiness(state);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocalSubtitleManagedResourceSummary | null>(null);
  const [cancelTargets, setCancelTargets] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (!resourcesOpen) return;
    void controller.refreshSharedStatus();
    const timer = setInterval(() => void controller.refreshSharedStatus(), 2000);
    return () => clearInterval(timer);
  }, [controller, resourcesOpen]);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState(false);
  const [numericDrafts, setNumericDrafts] = useState(() => Object.fromEntries(numericFields.map(([key]) => [key, String(state.config.advanced[key])])) as Record<NumericKey, string>);
  const invalidNumeric = numericFields.some(([key, , min, max, step]) => !numericValid(numericDrafts[key], min, max, step));
  const resourceTrigger = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const models = state.resources.filter(resource => resource.resourceType === 'model');
  const model = models.find(resource => resource.resourceId === state.config.modelId);
  const availableDevices = devices.filter(([value]) => value === 'auto' || value === 'cpu'
    || (state.runtime?.status === 'verified' && (state.runtime.target.platform === 'win32' ? value === 'cuda' : value === 'metal')));
  const selectedDevice = devices.find(([value]) => value === state.config.devicePreference);
  const setConfig = (patch: Partial<Config>) => controller.setConfig({ ...state.config, ...patch });
  const setAdvanced = (key: keyof Config['advanced'], value: number | string) => setConfig({ advanced: { ...state.config.advanced, [key]: value } });
  const activeCount = state.tasks.filter(task => !terminal(task)).length;
  const completedCount = state.tasks.filter(task => task.status === 'completed').length;
  const queueBusy = !!state.queueAction || state.taskActions.length > 0;
  const clearableCompleted = state.tasks.filter(task => task.status === 'completed' && !task.cleanupPending).length;
  const clearableTerminal = state.tasks.filter(task => terminal(task) && !task.cleanupPending).length;
  const cancellableTasks = state.tasks.filter(task => !terminal(task) && !state.cancellingTaskIds.includes(task.taskId));
  const settings = () => { settingsRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); settingsRef.current?.focus({ preventScroll: true }); };
  const openDocument = async (id: string) => {
    if (opening) return;
    setOpening(id); setOpenError(false);
    try { await onOpenDocument(id); } catch { setOpenError(true); } finally { setOpening(null); }
  };
  const runtimeNotice = <div className={state.runtime?.status === 'verified' ? 'studio-transcription-runtime is-ready' : 'studio-transcription-runtime'}>
    {state.runtime?.status === 'verified' ? <Check /> : state.phase === 'loading' && !state.runtime ? <LoaderCircle className="studio-spin" /> : <AlertCircle />}
    <div><p>{t(state.runtime?.status === 'verified' ? 'studio:transcription.runtime_ready' : !state.runtime && state.phase === 'loading' ? 'studio:transcription.runtime_checking' : 'studio:transcription.runtime_unavailable')}</p>
      {state.runtime && state.runtime.status !== 'verified' && <p className="studio-transcription-help">{t('studio:transcription.runtime_missing_hint')}</p>}</div>
  </div>;
  const errorMessage = state.error === 'resource_busy' ? 'studio:errors.resource_busy' : state.error === 'access_denied' ? 'studio:errors.access_denied' : state.error === 'limit_exceeded' ? 'studio:errors.limit_exceeded' : state.error === 'invalid_input' ? 'studio:errors.invalid_input' : state.error === 'needs_configuration' ? 'studio:errors.needs_configuration' : 'studio:errors.transcription_failed';

  return <>
    <ToolDetailLayout header={header} className="studio-transcription-layout" asideClassName="studio-transcription-aside order-2 lg:order-1" mainClassName="studio-transcription-main order-1 lg:order-2"
      aside={<div ref={settingsRef} tabIndex={-1} data-testid="studio-transcription-config" className="studio-transcription-settings">
        <ToolConfigPanel title={t('studio:transcription.configuration')} icon={Settings2}>
          <div className="studio-transcription-config-fields">
            <ToolField label={t('studio:transcription.model')} htmlFor="studio-transcription-model" className="studio-transcription-wide-field">
              <Select value={model?.resourceId ?? ''} onValueChange={modelId => setConfig({ modelId })} disabled={state.submitting || !models.length}>
                <SelectTrigger id="studio-transcription-model"><SelectValue placeholder={t('studio:transcription.choose_model')} /></SelectTrigger>
                <SelectContent>{models.map(resource => <SelectItem key={resource.resourceId} value={resource.resourceId}>{resource.displayName}</SelectItem>)}</SelectContent>
              </Select>
              <div className="studio-transcription-model-meta"><span>{model ? `${bytes(model.byteSize)} · ${t(resourceStatusKeys[model.status])}` : t('studio:transcription.no_models')}</span>
                <Button ref={resourceTrigger} data-testid="studio-transcription-manage-resources" variant="ghost" size="sm" onClick={() => setResourcesOpen(true)}><HardDrive />{t('studio:transcription.manage_resources')}</Button></div>
            </ToolField>
            <ToolField label={t('studio:transcription.language')} htmlFor="studio-transcription-language"><Select value={state.config.language} onValueChange={language => setConfig({ language })} disabled={state.submitting}><SelectTrigger id="studio-transcription-language"><SelectValue /></SelectTrigger><SelectContent>{languages.map(([value, key]) => <SelectItem key={value} value={value}>{t(key)}</SelectItem>)}</SelectContent></Select></ToolField>
            <ToolField label={t('studio:transcription.device')} htmlFor="studio-transcription-device"><Select value={state.config.devicePreference} onValueChange={devicePreference => setConfig({ devicePreference: devicePreference as Config['devicePreference'] })} disabled={state.submitting}><SelectTrigger id="studio-transcription-device"><SelectValue /></SelectTrigger><SelectContent>{availableDevices.map(([value, key]) => <SelectItem key={value} value={value}>{t(key)}</SelectItem>)}{selectedDevice && !availableDevices.some(([value]) => value === selectedDevice[0]) && <SelectItem value={selectedDevice[0]} disabled>{t(selectedDevice[1])}</SelectItem>}</SelectContent></Select></ToolField>
            <ToolField label={t('studio:transcription.task_mode')} htmlFor="studio-transcription-task-mode" className="studio-transcription-wide-field"><Select value={state.config.taskMode} onValueChange={taskMode => setConfig({ taskMode: taskMode as Config['taskMode'] })} disabled={state.submitting}><SelectTrigger id="studio-transcription-task-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="transcribe">{t('studio:transcription.mode_transcribe')}</SelectItem><SelectItem value="translate_to_english">{t('studio:transcription.mode_english')}</SelectItem></SelectContent></Select></ToolField>
          </div>
          <ToolSwitchRow id="studio-transcription-vad" label={t('studio:transcription.vad')} hint={t('studio:transcription.vad_hint')} checked={state.config.vadEnabled} disabled={state.submitting} onCheckedChange={vadEnabled => setConfig({ vadEnabled, ...(!vadEnabled ? { windowStrategy: 'fixed_v1' } : {}) })} />
          <ToolConfigDisclosure title={t('studio:transcription.advanced')} icon={SlidersHorizontal} testId="studio-transcription-advanced">
            <div className="studio-transcription-advanced-fields">
              {numericFields.map(([key, label, min, max, step]) => {
                const valid = numericValid(numericDrafts[key], min, max, step);
                return <ToolField key={key} label={t(label)} htmlFor={`studio-transcription-${key}`}><Input id={`studio-transcription-${key}`} type="number" value={numericDrafts[key]} min={min} max={max} step={step} disabled={state.submitting} aria-invalid={!valid} aria-describedby={!valid ? `studio-transcription-${key}-error` : undefined} onChange={event => {
                  const value = event.target.value;
                  setNumericDrafts(previous => ({ ...previous, [key]: value }));
                  if (numericValid(value, min, max, step)) setAdvanced(key, Number(value));
                }} />{!valid && <p id={`studio-transcription-${key}-error`} className="studio-transcription-field-error">{t('studio:transcription.readiness_config')} ({min}–{max})</p>}</ToolField>;
              })}
              <ToolField label={t('studio:transcription.window_strategy')} htmlFor="studio-transcription-window" className="studio-transcription-wide-field"><Select value={state.config.windowStrategy ?? 'fixed_v1'} onValueChange={windowStrategy => setConfig({ windowStrategy: windowStrategy as Config['windowStrategy'] })} disabled={state.submitting}><SelectTrigger id="studio-transcription-window"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fixed_v1">{t('studio:transcription.window_fixed')}</SelectItem><SelectItem value="acoustic_quiet_v1" disabled={!state.config.vadEnabled}>{t('studio:transcription.window_quiet')}</SelectItem></SelectContent></Select></ToolField>
              <ToolField label={t('studio:transcription.initial_prompt')} htmlFor="studio-transcription-prompt" className="studio-transcription-wide-field"><Textarea id="studio-transcription-prompt" value={state.config.advanced.initialPrompt ?? ''} maxLength={LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars} placeholder={t('studio:transcription.initial_prompt_hint')} disabled={state.submitting} onChange={event => setAdvanced('initialPrompt', event.target.value)} /></ToolField>
            </div>
          </ToolConfigDisclosure>
          <div>{runtimeNotice}<Button variant="ghost" size="sm" disabled={state.refreshing} onClick={() => void controller.refresh()}><RefreshCw className={state.refreshing ? 'studio-spin' : undefined} />{t('studio:transcription.check_again')}</Button></div>
        </ToolConfigPanel>
      </div>}>
      <div data-testid="studio-transcription" className="studio-transcription-workspace">
        <ToolFilePickerSurface data-testid="studio-transcription-picker" title={t('studio:transcription.media_title')} description={t('studio:transcription.media_hint')} actionLabel={t('studio:transcription.choose_media')} icon={state.selecting ? <LoaderCircle className="size-5 studio-spin" /> : <AudioLines className="size-5" />} disabled={state.selecting || state.submitting} onSelect={() => void controller.selectMedia()} />
        {(state.error || openError) && <div role="alert" className="studio-notice text-destructive border-destructive/20 bg-destructive/5"><AlertCircle /><span>{t(openError ? 'studio:errors.document_unavailable' : errorMessage)}</span><StudioIconButton label={t('studio:dismiss')} onClick={() => { controller.clearError(); setOpenError(false); }}><X /></StudioIconButton></div>}
        {state.cleanupPendingCount > 0 && <div role="status" className="studio-notice"><AlertCircle /><span>{t('studio:transcription.cleanup_pending')}</span><Button variant="ghost" size="sm" onClick={() => void controller.retryCleanup()}>{t('studio:transcription.retry_cleanup')}</Button></div>}
        <ToolPanel title={t('studio:transcription.selected_media')} icon={AudioLines} badge={<Badge variant="secondary" className="font-mono text-[11px]">{state.drafts.length} / 20</Badge>}
          actions={state.drafts.length ? <Button variant="ghost" size="sm" disabled={state.submitting} onClick={() => void controller.clearDrafts()}><X />{t('studio:transcription.clear_media')}</Button> : undefined}
          className="studio-transcription-media-panel"
          footer={<div className="studio-transcription-start-bar"><div className="studio-transcription-start-meta"><span>{model?.displayName ?? t('studio:transcription.choose_model')}</span><span id="studio-transcription-readiness">{invalidNumeric ? t('studio:transcription.readiness_config') : readiness.reason ? t(readinessKeys[readiness.reason]) : t('studio:transcription.ready_count', { count: readiness.readyCount })}</span></div><Button variant="ghost" size="sm" className="lg:hidden" onClick={settings}><Settings2 />{t('studio:transcription.settings')}</Button><Button data-testid="studio-transcription-start" size="sm" disabled={!readiness.canEnqueue || invalidNumeric} aria-describedby="studio-transcription-readiness" onClick={() => void controller.enqueue()}>{state.submitting ? <LoaderCircle className="studio-spin" /> : <Play />}{t(state.submitting ? 'studio:transcription.starting' : 'studio:transcription.start')}</Button></div>}>
          {!!state.drafts.length && <ul className="studio-transcription-media-list">{state.drafts.map(draft => <li key={draft.id} data-testid="studio-transcription-media-row" data-draft-id={draft.id} data-state={draft.status}>
            <AudioLines className="studio-transcription-row-icon" /><div className="studio-transcription-row-content"><StudioFileName name={draft.displayName} focusable /><div className="studio-transcription-row-meta">{draft.media && <span>{bytes(draft.media.byteSize)}</span>}{draft.probe && <span>{duration(draft.probe.durationMs)}</span>}{draft.status === 'probing' && <span><LoaderCircle className="size-3 studio-spin" />{t('studio:transcription.checking_media')}</span>}</div>
              {draft.status === 'expired' && <p className="studio-transcription-row-warning">{t('studio:transcription.expired_media')}</p>}
              {draft.status === 'submission_unknown' && <p className="studio-transcription-row-warning">{t('studio:transcription.unknown_submission')}</p>}
              {draft.error && draft.status === 'error' && <p className="studio-transcription-row-warning">{t(draft.error === 'needs_configuration' ? 'studio:errors.needs_configuration' : draft.error === 'access_denied' ? 'studio:errors.access_denied' : 'studio:errors.transcription_failed')}</p>}
            </div>
            {draft.probe && draft.probe.audioTracks.length > 1 && <Select value={draft.audioStreamId ?? draft.probe.autoSelectedStreamId} disabled={state.submitting} onValueChange={streamId => controller.setAudioStream(draft.id, streamId)}><SelectTrigger aria-label={`${t('studio:transcription.audio_track')} · ${draft.displayName}`} className="studio-transcription-track"><SelectValue /></SelectTrigger><SelectContent>{draft.probe.audioTracks.map(track => <SelectItem key={track.streamId} value={track.streamId}>{t('studio:transcription.track_number', { number: track.ordinal })}{track.language ? ` · ${track.language}` : ''}{track.title ? ` · ${track.title}` : ''}</SelectItem>)}</SelectContent></Select>}
            <div className="studio-transcription-row-actions">{draft.media && draft.status === 'error' && <StudioIconButton label={`${t('studio:transcription.retry_probe')} · ${draft.displayName}`} disabled={state.submitting} onClick={() => void controller.retryProbe(draft.id)}><RefreshCw /></StudioIconButton>}<StudioIconButton label={`${t('studio:transcription.remove_media')} · ${draft.displayName}`} disabled={state.submitting || draft.status === 'submitting'} onClick={() => void controller.removeDraft(draft.id)}><X /></StudioIconButton></div>
          </li>)}</ul>}
        </ToolPanel>
        <ToolPanel title={t('studio:transcription.queue')} icon={ListOrdered} badge={state.tasks.length ? <Badge variant="secondary" className="font-mono text-[11px]">{state.tasks.length}</Badge> : undefined} className="studio-transcription-queue"
          actions={<div className="studio-transcription-queue-actions"><Button variant="ghost" size="sm" data-testid="studio-queue-clear-completed" disabled={queueBusy || !clearableCompleted} onClick={() => void controller.clearCompleted()}>{state.queueAction === 'clear_completed' ? <LoaderCircle className="studio-spin" /> : <Trash2 />}{t('studio:transcription.clear_completed')}</Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={t('studio:transcription.queue_actions')} disabled={queueBusy || !state.tasks.length}><Ellipsis className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={!clearableTerminal} onSelect={() => void controller.clearTerminal()}><Trash2 />{t('studio:transcription.clear_terminal')}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={!cancellableTasks.length} onSelect={() => setCancelTargets(cancellableTasks.map(task => task.taskId))}><Square />{t('studio:transcription.cancel_all')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            <StudioIconButton label={t('studio:refresh')} disabled={state.refreshing || queueBusy} onClick={() => void controller.refresh()}><RefreshCw className={state.refreshing ? 'studio-spin' : undefined} /></StudioIconButton></div>}>
          <span className="sr-only" role="status">{t('studio:transcription.active_count', { active: activeCount, completed: completedCount })}</span>
          {state.queueResult && <p className="studio-transcription-queue-result" role="status" data-testid="studio-queue-result">{t(state.queueResult.action === 'cancel_active' ? 'studio:transcription.cancel_result' : 'studio:transcription.clear_result', { count: state.queueResult.succeeded, failed: state.queueResult.failed, skipped: state.queueResult.skipped })}</p>}
          {state.tasks.length ? <><ul className="studio-transcription-task-list">{state.tasks.map(task => <li key={task.taskId} data-testid="studio-transcription-task-row" data-task-id={task.taskId} data-state={task.status}>
            <div className="studio-transcription-task-heading"><div className="studio-transcription-task-name">{task.status === 'completed' ? <Check className="text-emerald-600 dark:text-emerald-400" /> : task.status === 'failed' ? <AlertCircle className="text-destructive" /> : terminal(task) ? <Square className="text-muted-foreground" /> : <LoaderCircle className={task.status === 'queued' ? 'text-muted-foreground' : 'studio-spin text-muted-foreground'} />}<StudioFileName name={task.displayName} focusable /></div>
              <div className="studio-transcription-row-actions">{task.documentId && <Button variant="outline" size="sm" disabled={opening !== null} onClick={() => void openDocument(task.documentId!)}>{opening === task.documentId ? <LoaderCircle className="studio-spin" /> : <Subtitles />}{t('studio:transcription.open_document')}</Button>}{terminal(task) ? <StudioIconButton label={`${t('studio:transcription.remove_task')} · ${task.displayName}`} disabled={!!state.queueAction || state.taskActions.includes(task.taskId) || !!task.cleanupPending} onClick={() => void controller.removeTask(task.taskId)}><Trash2 /></StudioIconButton> : <StudioIconButton label={`${t('studio:transcription.cancel_task')} · ${task.displayName}`} disabled={!!state.queueAction || state.taskActions.includes(task.taskId) || state.cancellingTaskIds.includes(task.taskId)} onClick={() => void controller.cancelTask(task.taskId)}>{state.cancellingTaskIds.includes(task.taskId) ? <LoaderCircle className="studio-spin" /> : <Square />}</StudioIconButton>}</div>
            </div>
            <div className="studio-transcription-task-meta"><span>{state.cancellingTaskIds.includes(task.taskId) ? t('studio:transcription.cancelling') : t(taskStatusKeys[task.status])}</span><span>{models.find(resource => resource.resourceId === task.modelId)?.displayName ?? task.modelId} · {task.resolvedBackend.toUpperCase()}</span>{task.durationMs !== undefined && <span>{duration(task.durationMs)}</span>}{!terminal(task) && <span className="studio-transcription-task-percentage">{Math.round(task.progress)}%</span>}</div>
            {!terminal(task) && <progress max={100} value={task.progress} aria-label={`${t(taskStatusKeys[task.status])} · ${task.displayName}`} className="studio-transcription-progress" />}
            {task.error && <p className="studio-transcription-row-warning">{t('studio:transcription.task_failed')}</p>}{task.cleanupPending && <p className="studio-transcription-row-warning">{t('studio:transcription.task_cleanup_pending')}</p>}{task.documentDurability === 'uncertain' && <p className="studio-transcription-row-warning">{t('studio:transcription.durability_uncertain')}</p>}
          </li>)}</ul><p className="studio-transcription-session-note">{t('studio:transcription.session_only')}</p></> : <div className="studio-transcription-empty"><ListOrdered /><p>{t('studio:transcription.queue_empty')}</p><span>{t('studio:transcription.queue_hint')}</span></div>}
        </ToolPanel>
      </div>
    </ToolDetailLayout>
    <ScrollableDialog open={cancelTargets !== null} onOpenChange={open => { if (!open && !state.queueAction) setCancelTargets(null); }} maxWidth="sm:max-w-[480px]">
      <ScrollableDialogHeader><DialogTitle className="text-sm">{t('studio:transcription.cancel_all')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:transcription.cancel_all_confirmation', { count: cancelTargets?.length ?? 0 })}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogFooter className="p-3"><Button variant="outline" size="sm" disabled={!!state.queueAction} onClick={() => setCancelTargets(null)}>{t('studio:cancel')}</Button><Button variant="destructive" size="sm" data-testid="studio-queue-confirm-cancel" disabled={queueBusy || !cancelTargets?.length} onClick={() => { if (cancelTargets) { void controller.cancelTasks(cancelTargets); setCancelTargets(null); } }}><Square />{t('studio:transcription.confirm_cancel_all')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog open={resourcesOpen} onOpenChange={setResourcesOpen} maxWidth="sm:max-w-[640px]" contentClassName="studio-transcription-resource-dialog" onCloseAutoFocus={event => { event.preventDefault(); resourceTrigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader><DialogTitle className="flex items-center gap-2 text-sm"><HardDrive className="size-4" />{t('studio:transcription.resources')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:transcription.resource_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent><div data-testid="studio-transcription-resources" className="studio-transcription-resource-content">{runtimeNotice}
        {state.sharedResources && <p className="studio-transcription-help" data-testid="studio-shared-resource-hint">{t('studio:transcription.shared_hint')}</p>}
        {!!state.sharedResources?.migrationIssues.length && <p role="status" className="studio-transcription-row-warning">{t('studio:transcription.migration_issues')}</p>}
        {state.sharedResources?.cleanupPending && <p role="status" className="studio-transcription-row-warning">{t('studio:transcription.shared_cleanup_pending')}</p>}
        {state.error && <p role="alert" className="studio-transcription-row-warning">{t(errorMessage)}</p>}
        {state.resources.length ? <ul className="studio-transcription-resource-list">{state.resources.map(resource => {
        const job = [...state.resourceJobs].reverse().find(item => item.resourceId === resource.resourceId);
        const running = !!job && activeResource(job.status);
        const pending = state.resourceActions.includes(resource.resourceId) || (!!job && state.resourceActions.includes(job.jobId));
        const busy = speechResourceIsBusy(state.sharedResources, resource.resourceId);
        return <li key={resource.resourceId} data-resource-id={resource.resourceId} data-state={resource.status}><div className="studio-transcription-resource-heading"><div><p>{resource.displayName}</p><span>{bytes(resource.byteSize)} · {t(resource.resourceType === 'model' ? 'studio:transcription.resource_model' : resource.resourceType === 'vad' ? 'studio:transcription.resource_vad' : 'studio:transcription.resource_accelerator')}</span></div><Badge variant={resource.status === 'ready' ? 'secondary' : 'outline'}>{t(resourceStatusKeys[resource.status])}</Badge></div>
          {running && <progress max={100} value={job.progress} aria-label={resource.displayName} className="studio-transcription-progress" />}
          {job?.error && !running && resource.status !== 'ready' && <p className="studio-transcription-row-warning">{t('studio:transcription.resource_failed')}</p>}
          {busy && <p className="studio-transcription-help">{t('studio:transcription.shared_busy')}</p>}
          <div className="studio-transcription-resource-actions">{running ? <Button variant="outline" size="sm" disabled={pending} onClick={() => void controller.cancelResourceJob(job.jobId)}><Square />{t('studio:transcription.cancel_download')}</Button> : resource.status !== 'ready' ? <><Button variant="outline" size="sm" disabled={pending || busy} onClick={() => void controller.installResource(resource.resourceId)}>{pending ? <LoaderCircle className="studio-spin" /> : <Download />}{t('studio:transcription.download')}</Button>{resource.resourceType === 'model' && <Button variant="ghost" size="sm" disabled={pending || busy} onClick={() => void controller.importModel(resource.resourceId)}><FolderOpen />{t('studio:transcription.import_model')}</Button>}</> : <Button variant="ghost" size="sm" disabled={pending || busy} onClick={() => { controller.clearError(); setDeleteTarget(resource); }}><Trash2 />{t('studio:transcription.delete_resource')}</Button>}</div>
        </li>;
      })}</ul> : <p className="studio-transcription-help">{t('studio:transcription.resource_empty')}</p>}</div></ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap justify-between gap-2 p-3"><Button variant="ghost" size="sm" disabled={state.refreshing} onClick={() => void controller.refresh()}><RefreshCw className={state.refreshing ? 'studio-spin' : undefined} />{t('studio:transcription.check_again')}</Button><Button variant="outline" size="sm" onClick={() => setResourcesOpen(false)}>{t('studio:transcription.close')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog open={!!deleteTarget} onOpenChange={open => { if (!open && (!deleteTarget || !state.resourceActions.includes(deleteTarget.resourceId))) setDeleteTarget(null); }} maxWidth="sm:max-w-[480px]">
      <ScrollableDialogHeader><DialogTitle className="text-sm">{t('studio:transcription.delete_resource')}</DialogTitle><DialogDescription className="text-xs leading-5 break-words">{t('studio:transcription.delete_shared_confirmation', { name: deleteTarget?.displayName ?? '' })}</DialogDescription></ScrollableDialogHeader>
      {state.error && <ScrollableDialogContent><p role="alert" className="studio-transcription-row-warning">{t(errorMessage)}</p></ScrollableDialogContent>}
      <ScrollableDialogFooter className="p-3"><Button variant="outline" size="sm" disabled={!!deleteTarget && state.resourceActions.includes(deleteTarget.resourceId)} onClick={() => setDeleteTarget(null)}>{t('studio:cancel')}</Button><Button variant="destructive" size="sm" data-testid="studio-confirm-delete-resource" disabled={!deleteTarget || state.resourceActions.includes(deleteTarget.resourceId) || speechResourceIsBusy(state.sharedResources, deleteTarget.resourceId)} onClick={async () => { if (deleteTarget && await controller.deleteResource(deleteTarget.resourceId)) setDeleteTarget(null); }}><Trash2 />{t('studio:transcription.delete_resource')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
