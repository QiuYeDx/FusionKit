import { StudioRevealSource } from './StudioRevealSource';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import useModelStore from '@/store/useModelStore';
import { speechResourceIsBusy } from '@/speech-resources/events';
import type { LocalSubtitleManagedResourceSummary } from '@/subtitle-studio/transcription/ipc-contract';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, AudioLines, Check, CircleHelp, CircleMinus, Copy, Cpu, Download, Ear, Ellipsis, ExternalLink, FolderOpen, Globe, HardDrive, Languages, ListOrdered, LoaderCircle, Music, Play, RefreshCw, RotateCcw, Settings2, SlidersHorizontal, Square, Subtitles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { ToolDetailLayout } from '../../_shared/ui/ToolDetailLayout';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import { TranscriptionEmptyResult } from '../../_shared/ui/TranscriptionEmptyResult';
import { ToolConfigPanel } from '../../_shared/ui/ToolConfigPanel';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolSwitchRow } from '../../_shared/ui/ToolSwitchRow';
import { StudioDisclosure } from './StudioDisclosure';
import { ToolFilePickerSurface } from '../../_shared/ui/ToolFilePickerSurface';
import { useToolFileDropTarget } from '../../_shared/ui/ToolFileDropScope';
import { getStudioTranscriptionController, getTranscriptionReadiness, type TranscriptionRetryChoice } from '@/services/subtitle-studio/transcription-controller';
import type { EnqueueTranscriptionRequest, TranscriptionTaskSummary } from '@/subtitle-studio/transcription/task-contract';
import { LOCAL_SUBTITLE_LIMITS, LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '@/subtitle-studio/transcription/domain';
import { TRANSCRIPTION_AUDIO_TYPES, TRANSCRIPTION_AUDIO_TYPE_KEYS, transcriptionAudioTypeOf, type TranscriptionAudioProfile,
  type TranscriptionAudioType } from '@/subtitle-studio/transcription-audio-profiles';
import { transcriptionModelProfile, transcriptionModelSpeaks } from '@/subtitle-studio/transcription-model-profiles';
import { SUBTITLE_TEXT_FORMATS } from '@/subtitle-studio/domain';
import { StudioFileName, StudioIconButton, StudioNotice } from './StudioControls';
import { StudioScrollFade } from './StudioScrollFade';
import { StudioTaskQueue, StudioTaskQueueRow } from './StudioTaskQueue';
import { StudioAutomaticKnowledge } from './StudioAutomaticKnowledge';
import { StudioLocalPrepare } from './StudioLocalPrepare';
import { isCudaAccelerator, resourceDetailName, resourceDisplayName } from './resource-names';
import { cpuFallbackReason, cudaSuitability, deviceHint, vcRuntimeMayExplain } from './transcription-hints';
import { resourceErrorGuide, studioErrorDiagnostics, transcriptionRetrySuggestion, transcriptionTaskDiagnostics, transcriptionTaskErrorGuide,
  transcriptionTaskRetryable } from './transcription-errors';
import { VcRuntimeNotice } from '@/components/system-setup/VcRuntimeNotice';
import { getSystemSetupStore, useSystemSetup, vcRuntimeNeedsRepair } from '@/services/system-setup/system-setup-store';
import { openExternalPage } from '@/services/ai-error-guide';
import { helpPath } from '@/pages/Help/helpNavigation';
import { NVIDIA_MINIMUM_DRIVER, nvidiaDriverUrl } from '@/system-setup/contract';
import './StudioTranscription.css';

type Config = EnqueueTranscriptionRequest['config'];
const taskStatusKeys = {
  queued: 'studio:transcription.status_queued', preparing_media: 'studio:transcription.status_preparing_media',
  loading_model: 'studio:transcription.status_loading_model', transcribing: 'studio:transcription.status_transcribing',
  post_processing: 'studio:transcription.status_post_processing', completed: 'studio:transcription.status_completed',
  no_content: 'studio:transcription.status_no_content',
  cancelled: 'studio:transcription.status_cancelled', failed: 'studio:transcription.status_failed',
} as const;
const resourceStatusKeys = { ready: 'studio:transcription.resource_ready', not_installed: 'studio:transcription.resource_not_installed', installing: 'studio:transcription.resource_installing', invalid: 'studio:transcription.resource_invalid' } as const;
const readinessKeys = {
  automatic_translation_not_ready: 'knowledge:automatic.configuration',
  busy: 'studio:transcription.readiness_busy', uncertain_submission: 'studio:transcription.readiness_unknown',
  configuration_invalid: 'studio:transcription.readiness_config', runtime_not_ready: 'studio:transcription.readiness_runtime',
  model_not_ready: 'studio:transcription.readiness_model', vad_not_ready: 'studio:transcription.readiness_vad',
  accelerator_not_ready: 'studio:transcription.readiness_accelerator', no_media: 'studio:transcription.readiness_media',
} as const;
/** Languages offered for transcription, and for recognizing a cue again. */
export const TRANSCRIPTION_LANGUAGES = [
  ['auto', 'studio:transcription.language_auto'], ['zh', 'studio:transcription.language_zh'], ['en', 'studio:transcription.language_en'],
  ['ja', 'studio:transcription.language_ja'], ['ko', 'studio:transcription.language_ko'], ['fr', 'studio:transcription.language_fr'],
  ['de', 'studio:transcription.language_de'], ['es', 'studio:transcription.language_es'],
] as const;
const devices = [['auto', 'studio:transcription.device_auto'], ['cpu', 'studio:transcription.device_cpu'], ['metal', 'studio:transcription.device_metal'], ['cuda', 'studio:transcription.device_cuda']] as const;
const terminal = (task: TranscriptionTaskSummary) => ['completed', 'no_content', 'cancelled', 'failed'].includes(task.status);
const activeResource = (status: string) => !['completed', 'failed', 'cancelled'].includes(status);
function bytes(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${Math.round(value / 1024)} KB` : `${value} B`; }
/** "Copy diagnostics" for a failure this version has no words for: the code and the facts around it, for a report. */
function CopyDiagnostics({ text }: { text: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return <Button variant="ghost" size="xs" data-testid="studio-copy-diagnostics" className="text-muted-foreground" onClick={() => void navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed'))}>
    <Copy />{t(state === 'copied' ? 'studio:transcription.diagnostics_copied' : state === 'failed' ? 'studio:copy_failed' : 'studio:transcription.copy_diagnostics')}
  </Button>;
}
/** A failed task's cause and next step, with the buttons that help: retry, the resource manager, the help page, diagnostics. */
function TaskFailure({ task, vcRuntimeMissing, onOpenResources, retry }: { task: TranscriptionTaskSummary; vcRuntimeMissing: boolean; onOpenResources: () => void; retry?: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const guide = transcriptionTaskErrorGuide(task.error?.code, { vcRuntimeMissing, stage: task.error?.stage });
  return <div className="studio-task-failure" data-testid="studio-transcription-task-error" data-code={task.error?.code}>
    <p className="studio-transcription-row-warning">{t(guide.causeKey)}</p>
    {guide.nextKey && <p className="studio-transcription-help">{t(guide.nextKey)}</p>}
    <div className="studio-task-failure-actions">
      {retry}
      {guide.actions.includes('open_resources') && <Button variant="outline" size="xs" data-testid="studio-task-error-resources" onClick={onOpenResources}><HardDrive />{t('studio:transcription.manage_resources')}</Button>}
      {guide.actions.includes('open_help') && <Button variant="outline" size="xs" data-testid="studio-task-error-help" onClick={() => navigate(helpPath(guide.helpSection))}><CircleHelp />{t('common:action.view_help')}</Button>}
      <CopyDiagnostics text={transcriptionTaskDiagnostics(task)} />
    </div>
  </div>;
}
const retryChoices = { plain: {}, quiet: { audioProfile: 'quiet_whisper_v1' }, cpu: { devicePreference: 'cpu' } } as const satisfies Record<string, TranscriptionRetryChoice>;
/**
 * "Retry" and the one suggestion that fits the result, each submitting the same file again in one click. The
 * quiet audio type is experimental and needs voice detection, which its note says.
 */
function TaskRetry({ task, vadReady, busy, onRetry }: { task: TranscriptionTaskSummary; vadReady: boolean; busy: boolean; onRetry: (choice: TranscriptionRetryChoice) => void }) {
  const { t } = useTranslation();
  const suggestion = transcriptionRetrySuggestion(task);
  const [clicked, setClicked] = useState<keyof typeof retryChoices | null>(null);
  const retry = (kind: keyof typeof retryChoices) => { setClicked(kind); onRetry(retryChoices[kind]); };
  const icon = (kind: keyof typeof retryChoices, Icon: typeof RotateCcw) => busy && clicked === kind ? <LoaderCircle className="studio-spin" /> : <Icon />;
  return <>
    <Button variant="outline" size="xs" data-testid="studio-transcription-retry" disabled={busy} onClick={() => retry('plain')}>{icon('plain', RotateCcw)}{t('studio:retry')}</Button>
    {suggestion === 'cpu' && <Button variant="outline" size="xs" data-testid="studio-transcription-retry-cpu" disabled={busy} onClick={() => retry('cpu')}>{icon('cpu', Cpu)}{t('studio:transcription.retry_cpu')}</Button>}
    {suggestion === 'quiet' && <>
      <Button variant="outline" size="xs" data-testid="studio-transcription-retry-quiet" disabled={busy || !vadReady} aria-describedby={`studio-transcription-retry-note-${task.taskId}`} onClick={() => retry('quiet')}>{icon('quiet', Ear)}{t('studio:transcription.retry_quiet')}</Button>
      <span id={`studio-transcription-retry-note-${task.taskId}`} className="studio-task-retry-note">{t(vadReady ? 'studio:transcription.retry_quiet_note' : 'studio:transcription.retry_quiet_needs_vad')}</span>
    </>}
  </>;
}
function duration(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
const numericFields = [
  ['beamSize', 'studio:transcription.beam_size', 1, 10, 1], ['temperature', 'studio:transcription.temperature', 0, 1, 0.1],
  ['vadMinSilenceMs', 'studio:transcription.vad_silence', 100, 5000, 1], ['maxCueDurationMs', 'studio:transcription.cue_duration', 500, LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRawSegmentDurationMs, 1],
  ['maxCueChars', 'studio:transcription.cue_chars', 20, LOCAL_SUBTITLE_LIMITS.maxCueTextChars, 1], ['maxLineChars', 'studio:transcription.line_chars', 10, LOCAL_SUBTITLE_LIMITS.maxLineChars, 1],
] as const;
type NumericKey = typeof numericFields[number][0];
const numericValid = (text: string, min: number, max: number, step: number) => text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= min && Number(text) <= max && (step !== 1 || Number.isInteger(Number(text)));

const automaticLabelKeys = {
  pending: { label: 'studio:transcription.auto_translation_pending_short', description: 'studio:transcription.auto_translation_pending' },
  admitted: { label: 'studio:transcription.auto_translation_admitted_short', description: 'studio:transcription.auto_translation_admitted' },
  needs_configuration: { label: 'studio:transcription.auto_translation_recovery_short', description: 'studio:transcription.auto_translation_recovery' },
} as const;
function AutomaticTranslationLabel({ status }: { status: NonNullable<TranscriptionTaskSummary['automaticTranslation']>['status'] }) {
  const { t } = useTranslation();
  const keys = automaticLabelKeys[status];
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild><span tabIndex={0} className="studio-transcription-auto-label" data-state={status}><Languages aria-hidden="true" />{t(keys.label)}</span></TooltipTrigger>
    <TooltipContent sideOffset={6} className="max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal text-wrap">{t(keys.description)}</TooltipContent>
  </Tooltip>;
}
/** A task's non-standard audio type, short; the tooltip names it in full. */
function AudioTypeLabel({ profile }: { profile: TranscriptionAudioProfile }) {
  const { t } = useTranslation();
  const keys = TRANSCRIPTION_AUDIO_TYPE_KEYS[profile];
  const Icon = profile === 'quiet_whisper_v1' ? Ear : Music;
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild><span tabIndex={0} className="studio-transcription-audio-label" data-testid="studio-transcription-task-audio-type" data-profile={profile}><Icon aria-hidden="true" />{t(keys.short)}</span></TooltipTrigger>
    <TooltipContent sideOffset={6} className="max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal text-wrap">{t('studio:transcription.audio_task_label', { name: t(keys.label) })}</TooltipContent>
  </Tooltip>;
}
/** The model and the device a task used; `reason` says why an automatic choice ended on the CPU. */
function TaskModelLabel({ name, backend, reason }: { name: string; backend: string; reason?: string }) {
  const text = reason ? `${name} · ${backend.toUpperCase()} · ${reason}` : `${name} · ${backend.toUpperCase()}`;
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild><span tabIndex={0} className="studio-task-model" data-cpu-reason={reason ? '' : undefined}>{text}</span></TooltipTrigger>
    <TooltipContent sideOffset={6} className="max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal text-wrap [overflow-wrap:anywhere]">{text}</TooltipContent>
  </Tooltip>;
}

export function StudioTranscription({ header, onOpenDocument, openResources, onResourcesOpened }: { header: ReactNode; onOpenDocument: (id: string) => Promise<void>;
  /** Open the resource manager once (a link asked for it); onResourcesOpened confirms it. */
  openResources?: boolean; onResourcesOpened?: () => void }) {
  const { t, i18n } = useTranslation();
  const driverUrl = nvidiaDriverUrl(i18n.resolvedLanguage ?? i18n.language);
  const navigate = useNavigate();
  const controller = getStudioTranscriptionController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const profiles = useModelStore(value => value.profiles);
  const assignedProfile = useModelStore(value => value.assignment.taskExecution);
  const automaticProfile = profiles.find(profile => profile.id === (state.autoTranslation.profileId || assignedProfile))
    ?? (!state.autoTranslation.profileId ? profiles[0] : undefined);
  useEffect(() => { controller.refreshTranslationConfiguration(); }, [controller, profiles, assignedProfile]);
  const mediaBusy = state.selecting || state.submitting;
  const { dragging, dropProps } = useToolFileDropTarget({
    disabled: mediaBusy,
    label: t('studio:transcription.media_title'),
    onDrop: event => {
      if (!mediaBusy) return controller.dropMedia(Array.from(event.dataTransfer.files));
    },
  });
  const readiness = getTranscriptionReadiness(state);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  // A link (such as the welcome wizard's "prepare") can ask for the resource manager.
  useEffect(() => {
    if (!openResources) return;
    setResourcesOpen(true);
    onResourcesOpened?.();
  }, [openResources, onResourcesOpened]);
  const [deleteTarget, setDeleteTarget] = useState<LocalSubtitleManagedResourceSummary | null>(null);
  // What this computer offers local transcription: the VC++ runtime (Windows) and the graphics card.
  const setup = getSystemSetupStore();
  const system = useSystemSetup({ vc: true, gpu: true });
  const vcMissing = vcRuntimeNeedsRepair(system.vc);
  const nameOf = (resource: LocalSubtitleManagedResourceSummary, variant: 'full' | 'short' = 'full') => resourceDisplayName(key => t(key), resource, variant);
  const platform = state.runtime?.status === 'verified' ? state.runtime.target.platform : undefined;
  const cudaReady = state.resources.some(resource => isCudaAccelerator(resource) && resource.status === 'ready');
  const cuda = cudaSuitability(system.gpu);
  /** A download waiting for the VC++ runtime, or for confirming a pack this computer cannot use. */
  const [runtimeGate, setRuntimeGateState] = useState<LocalSubtitleManagedResourceSummary | null>(null);
  // A repair started from the gate finishes after it may have been cancelled: it reads the gate as it is then.
  const runtimeGateRef = useRef<LocalSubtitleManagedResourceSummary | null>(null);
  const setRuntimeGate = (resource: LocalSubtitleManagedResourceSummary | null) => { runtimeGateRef.current = resource; setRuntimeGateState(resource); };
  const [cudaConfirm, setCudaConfirm] = useState<LocalSubtitleManagedResourceSummary | null>(null);
  const [gating, setGating] = useState<string | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  // Opening the manager reads the runtime again, so its downloads know the current state.
  useEffect(() => { if (resourcesOpen) void setup.checkVcRuntime({ force: true }); }, [setup, resourcesOpen]);
  useEffect(() => {
    if (!resourcesOpen || !window.modelSetup) return;
    let cancelled = false;
    void window.modelSetup.getFreeDiskSpace().then(value => { if (!cancelled) setFreeBytes(value); }, () => undefined);
    return () => { cancelled = true; };
  }, [resourcesOpen, state.resources]);
  // A failure the runtime could explain asks again, so the cause shown is current.
  const runtimeFailures = [...state.resourceJobs.filter(job => job.status === 'failed' && vcRuntimeMayExplain(job.error?.code)).map(job => job.jobId),
    ...state.tasks.filter(task => vcRuntimeMayExplain(task.error?.code)).map(task => task.taskId)].join(',');
  useEffect(() => { if (runtimeFailures) void setup.checkVcRuntime({ force: true }); }, [setup, runtimeFailures]);
  /** Downloads check the runtime first (a model that cannot load is deleted again), and a pack for a missing card asks first. */
  const install = async (resource: LocalSubtitleManagedResourceSummary, confirmed: { gpu?: boolean; runtime?: boolean } = {}) => {
    if (!confirmed.gpu && isCudaAccelerator(resource) && cuda === 'not_applicable') { setCudaConfirm(resource); return; }
    if (!confirmed.runtime) {
      // A state read when the manager opened (or just now) is used as is; otherwise ask Windows first.
      const known = setup.freshVcRuntime(10_000);
      let ready = !vcRuntimeNeedsRepair(known);
      if (!known) {
        setGating(resource.resourceId);
        try { ready = await setup.vcRuntimeReady(); } finally { setGating(null); }
      }
      if (!ready) { setRuntimeGate(resource); return; }
    }
    void controller.installResource(resource.resourceId);
  };
  const continueAfterRuntime = (resource: LocalSubtitleManagedResourceSummary | null) => {
    setRuntimeGate(null);
    if (resource) void install(resource, { gpu: true, runtime: true });
  };
  /** "Check again": the bundled program, the VC++ runtime (a manual install counts) and the graphics card. */
  const checkAgain = () => { void controller.refresh(); void setup.checkVcRuntime({ force: true }); void setup.detectGpu({ refresh: true }); };
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
  // Models that only recognize cues again are installed here but chosen when recognizing.
  const transcriptionModels = models.filter(resource => transcriptionModelProfile(resource.resourceId).role === 'transcribe');
  const model = transcriptionModels.find(resource => resource.resourceId === state.config.modelId);
  // What the chosen model cannot do is disabled in place, with the reason under the field.
  const modelProfile = transcriptionModelProfile(state.config.modelId);
  const lockedLanguages = modelProfile.languages === 'any' ? undefined : new Intl.ListFormat(i18n.resolvedLanguage ?? i18n.language, { type: 'conjunction' })
    .format(modelProfile.languages.map(language => { const known = TRANSCRIPTION_LANGUAGES.find(([value]) => value === language); return known ? t(known[1]) : language; }));
  const availableDevices = devices.filter(([value]) => value === 'auto' || value === 'cpu'
    || (state.runtime?.status === 'verified' && (state.runtime.target.platform === 'win32' ? value === 'cuda' : value === 'metal')));
  const selectedDevice = devices.find(([value]) => value === state.config.devicePreference);
  const deviceHintKey = deviceHint({ platform, gpu: system.gpu, cudaReady, device: state.config.devicePreference });
  // "NVIDIA GPU" on a computer without one: choose another device rather than install the pack.
  const readinessKey = readiness.reason === 'accelerator_not_ready' && cuda === 'not_applicable' ? 'studio:transcription.device_hint_cuda_no_nvidia'
    : readiness.reason ? readinessKeys[readiness.reason] : undefined;
  const setConfig = (patch: Partial<Config>) => controller.setConfig({ ...state.config, ...patch });
  const audioType = transcriptionAudioTypeOf(state.config.advanced);
  // Set when turning voice detection off returned the audio type to standard; a later choice clears it.
  const [audioTypeReset, setAudioTypeReset] = useState(false);
  const showAudioTypeReset = audioTypeReset && audioType === 'standard' && !state.config.vadEnabled;
  const setAdvanced = (key: keyof Config['advanced'], value: number | string) => setConfig({ advanced: { ...state.config.advanced, [key]: value } });
  const setAutoExport = (patch: Partial<typeof state.autoExport>) => controller.setAutoExport({ ...state.autoExport, ...patch });
  const activeCount = state.tasks.filter(task => !terminal(task)).length;
  const completedCount = state.tasks.filter(task => task.status === 'completed').length;
  const emptyCount = state.tasks.filter(task => task.status === 'no_content').length;
  const queueBusy = !!state.queueAction || state.taskActions.length > 0;
  const clearableCompleted = state.tasks.filter(task => (task.status === 'completed' || task.status === 'no_content') && !task.cleanupPending).length;
  const clearableTerminal = state.tasks.filter(task => terminal(task) && !task.cleanupPending).length;
  const cancellableTasks = state.tasks.filter(task => !terminal(task) && !state.cancellingTaskIds.includes(task.taskId));
  const settings = () => { settingsRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); settingsRef.current?.focus({ preventScroll: true }); };
  const taskModelName = (modelId: string) => { const used = models.find(resource => resource.resourceId === modelId); return used ? nameOf(used, 'short') : modelId; };
  const cpuReason = cpuFallbackReason({ platform, gpu: system.gpu, cudaReady });
  const vadReady = state.resources.some(resource => resource.resourceId === LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id && resource.status === 'ready');
  const retryActions = (task: TranscriptionTaskSummary) => <TaskRetry task={task} vadReady={vadReady} busy={!!state.queueAction || state.taskActions.includes(task.taskId)}
    onRetry={choice => void controller.retryTask(task.taskId, choice)} />;
  const openDocument = async (id: string) => {
    if (opening) return;
    setOpening(id); setOpenError(false);
    try { await onOpenDocument(id); } catch { setOpenError(true); } finally { setOpening(null); }
  };
  // The bundled program is verified, but Windows lacks the VC++ runtime it needs: say that instead of "ready".
  const runtimeNeedsVc = state.runtime?.status === 'verified' && vcMissing;
  const runtimeNotice = runtimeNeedsVc ? <div className="studio-transcription-runtime" data-state="vc-runtime"><AlertCircle /><div><p>{t('common:system_setup.vc_runtime.title')}</p></div></div>
    : <div className={state.runtime?.status === 'verified' ? 'studio-transcription-runtime is-ready' : 'studio-transcription-runtime'}>
    {state.runtime?.status === 'verified' ? <Check /> : state.phase === 'loading' && !state.runtime ? <LoaderCircle className="studio-spin" /> : <AlertCircle />}
    <div><p>{t(state.runtime?.status === 'verified' ? 'studio:transcription.runtime_ready' : !state.runtime && state.phase === 'loading' ? 'studio:transcription.runtime_checking' : 'studio:transcription.runtime_unavailable')}</p>
      {state.runtime && state.runtime.status !== 'verified' && <p className="studio-transcription-help">{t('studio:transcription.runtime_missing_hint')}</p>}</div>
  </div>;
  const errorMessage = state.error === 'knowledge_check_failed' ? 'studio:errors.knowledge_check_failed' : state.error === 'revision_conflict' ? 'knowledge:automatic.stale' : state.error === 'resource_busy' ? 'studio:errors.resource_busy' : state.error === 'access_denied' ? 'studio:errors.access_denied' : state.error === 'limit_exceeded' ? 'studio:errors.limit_exceeded' : state.error === 'invalid_input' ? 'studio:errors.invalid_input' : state.error === 'needs_configuration' ? 'studio:errors.needs_configuration' : 'studio:errors.transcription_failed';

  return <>
    <ToolDetailLayout header={header} className="studio-transcription-layout" asideClassName="studio-transcription-aside order-2 lg:order-1" mainClassName="studio-transcription-main order-1 lg:order-2"
      aside={<div ref={settingsRef} tabIndex={-1} data-testid="studio-transcription-config" className="studio-transcription-settings">
        <ToolConfigPanel title={t('studio:transcription.configuration')} icon={Settings2}>
          <div className="studio-transcription-config-fields">
            <ToolField label={t('studio:transcription.model')} htmlFor="studio-transcription-model" className="studio-transcription-wide-field">
              <Select value={model?.resourceId ?? ''} onValueChange={modelId => setConfig({ modelId })} disabled={state.submitting || !transcriptionModels.length}>
                {/* As for audio types: the trigger names the model, the list adds what it suits. */}
                <SelectTrigger id="studio-transcription-model"><SelectValue placeholder={t('studio:transcription.choose_model')}>{model && nameOf(model)}</SelectValue></SelectTrigger>
                <SelectContent className="studio-transcription-model-options">{transcriptionModels.map(resource => {
                  const profile = transcriptionModelProfile(resource.resourceId);
                  return <SelectItem key={resource.resourceId} value={resource.resourceId} textValue={nameOf(resource)}>
                    <span className="studio-transcription-model-option"><span>{nameOf(resource)}{profile.experimental && <Badge variant="outline">{t('studio:transcription.model_experimental')}</Badge>}</span>
                      {profile.scenarioKey && <small>{t(profile.scenarioKey)}</small>}</span>
                  </SelectItem>;
                })}</SelectContent>
              </Select>
              <div className="studio-transcription-model-meta"><span>{model ? `${bytes(model.byteSize)} · ${t(resourceStatusKeys[model.status])}` : t('studio:transcription.no_models')}</span>
                <Button ref={resourceTrigger} data-testid="studio-transcription-manage-resources" variant="ghost" size="sm" onClick={() => setResourcesOpen(true)}><HardDrive />{t('studio:transcription.manage_resources')}</Button></div>
            </ToolField>
            <ToolField label={t('studio:transcription.language')} htmlFor="studio-transcription-language"><Select value={state.config.language} onValueChange={language => setConfig({ language })} disabled={state.submitting}><SelectTrigger id="studio-transcription-language"><SelectValue /></SelectTrigger><SelectContent>{TRANSCRIPTION_LANGUAGES.map(([value, key]) => <SelectItem key={value} value={value} disabled={!transcriptionModelSpeaks(modelProfile, value)}>{t(key)}</SelectItem>)}</SelectContent></Select>
              {lockedLanguages && <p className="studio-transcription-help" data-testid="studio-transcription-language-hint">{t('studio:transcription.model_language_locked', { languages: lockedLanguages })}</p>}</ToolField>
            <ToolField label={t('studio:transcription.device')} htmlFor="studio-transcription-device"><Select value={state.config.devicePreference} onValueChange={devicePreference => setConfig({ devicePreference: devicePreference as Config['devicePreference'] })} disabled={state.submitting}><SelectTrigger id="studio-transcription-device"><SelectValue /></SelectTrigger><SelectContent>{availableDevices.map(([value, key]) => <SelectItem key={value} value={value}>{t(key)}</SelectItem>)}{selectedDevice && !availableDevices.some(([value]) => value === selectedDevice[0]) && <SelectItem value={selectedDevice[0]} disabled>{t(selectedDevice[1])}</SelectItem>}</SelectContent></Select>{deviceHintKey && <p className="studio-transcription-help" data-testid="studio-transcription-device-hint">{t(deviceHintKey)}</p>}</ToolField>
            <ToolField label={t('studio:transcription.audio_type')} htmlFor="studio-transcription-audio-type" className="studio-transcription-wide-field">
              <Select value={audioType} onValueChange={type => { setAudioTypeReset(false); controller.setAudioType(type as TranscriptionAudioType); }} disabled={state.submitting}>
                {/* The trigger names the choice; the list adds what each one is for. */}
                <SelectTrigger id="studio-transcription-audio-type"><SelectValue>{t(TRANSCRIPTION_AUDIO_TYPE_KEYS[audioType].label)}</SelectValue></SelectTrigger>
                <SelectContent className="studio-transcription-audio-options">{TRANSCRIPTION_AUDIO_TYPES.map(type => <SelectItem key={type} value={type} textValue={t(TRANSCRIPTION_AUDIO_TYPE_KEYS[type].label)}>
                  <span className="studio-transcription-audio-option"><span>{t(TRANSCRIPTION_AUDIO_TYPE_KEYS[type].label)}{type !== 'standard' && <Badge variant="outline" data-testid="studio-transcription-audio-experimental">{t('studio:transcription.model_experimental')}</Badge>}</span><small>{t(TRANSCRIPTION_AUDIO_TYPE_KEYS[type].description)}</small></span>
                </SelectItem>)}</SelectContent>
              </Select>
              {showAudioTypeReset ? <p role="status" className="studio-transcription-row-warning" data-testid="studio-transcription-audio-reset">{t('studio:transcription.audio_reset')}</p>
                : <p className="studio-transcription-help" data-testid="studio-transcription-audio-hint">{t(TRANSCRIPTION_AUDIO_TYPE_KEYS[audioType].hint)}</p>}
            </ToolField>
            <ToolField label={t('studio:transcription.task_mode')} htmlFor="studio-transcription-task-mode" className="studio-transcription-wide-field"><Select value={state.config.taskMode} onValueChange={taskMode => setConfig({ taskMode: taskMode as Config['taskMode'] })} disabled={state.submitting}><SelectTrigger id="studio-transcription-task-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="transcribe">{t('studio:transcription.mode_transcribe')}</SelectItem><SelectItem value="translate_to_english" disabled={!modelProfile.translate}>{t('studio:transcription.mode_english')}</SelectItem></SelectContent></Select>
              {!modelProfile.translate && <p className="studio-transcription-help" data-testid="studio-transcription-task-mode-hint">{t('studio:transcription.model_no_translate')}</p>}</ToolField>
          </div>
          <ToolSwitchRow id="studio-transcription-vad" label={t('studio:transcription.vad')} hint={t('studio:transcription.vad_hint')} checked={state.config.vadEnabled} disabled={state.submitting} onCheckedChange={vadEnabled => setAudioTypeReset(controller.setVadEnabled(vadEnabled))} />
          <StudioDisclosure triggerTestId="studio-transcription-advanced" className="-mx-3 border-y" contentClassName="space-y-3 px-3 pb-3 pt-2" title={<span className="flex min-w-0 items-center gap-2"><SlidersHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{t('studio:transcription.advanced')}</span>}>
            <p className="studio-transcription-help" data-testid="studio-transcription-advanced-hint">{t('studio:transcription.advanced_hint')}</p>
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
              <ToolField label={t('studio:transcription.initial_prompt')} htmlFor="studio-transcription-prompt" className="studio-transcription-wide-field"><Textarea id="studio-transcription-prompt" value={state.config.advanced.initialPrompt ?? ''} maxLength={LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars} placeholder={t('studio:transcription.initial_prompt_hint')} disabled={state.submitting || modelProfile.prompt === 'forbid'} onChange={event => setAdvanced('initialPrompt', event.target.value)} />
                {modelProfile.prompt === 'forbid' && <p className="studio-transcription-help" data-testid="studio-transcription-prompt-hint">{t('studio:transcription.model_prompt_forbidden')}</p>}</ToolField>
            </div>
          </StudioDisclosure>
          <ToolSwitchRow id="studio-transcription-auto-translation" testId="studio-transcription-auto-translation-row" label={t('studio:transcription.auto_translation')} hint={t('studio:transcription.auto_translation_hint')} checked={state.autoTranslation.enabled} disabled={state.submitting} onCheckedChange={enabled => controller.setAutoTranslation({ ...state.autoTranslation, enabled })} />
          {state.autoTranslation.enabled && <div className="studio-transcription-config-fields" data-testid="studio-transcription-auto-configuration">
            <ToolField label={t('studio:transcription.auto_translation_model')} htmlFor="studio-transcription-translation-model"><Select value={automaticProfile?.id ?? ''} onValueChange={profileId => controller.setAutoTranslation({ ...state.autoTranslation, profileId })} disabled={state.submitting || !profiles.length}><SelectTrigger id="studio-transcription-translation-model"><SelectValue placeholder={t('studio:transcription.auto_translation_configuration')} /></SelectTrigger><SelectContent>{profiles.map(profile => <SelectItem key={profile.id} value={profile.id}>{profile.name || profile.modelKey}</SelectItem>)}</SelectContent></Select></ToolField>
            <ToolField label={t('studio:transcription.auto_translation_language')} htmlFor="studio-transcription-translation-language"><Select value={state.autoTranslation.language} onValueChange={language => controller.setAutoTranslation({ ...state.autoTranslation, language })} disabled={state.submitting}><SelectTrigger id="studio-transcription-translation-language"><SelectValue /></SelectTrigger><SelectContent>{TRANSCRIPTION_LANGUAGES.filter(([value]) => value !== 'auto').map(([value, key]) => <SelectItem key={value} value={value}>{t(key)}</SelectItem>)}{!TRANSCRIPTION_LANGUAGES.some(([value]) => value === state.autoTranslation.language) && <SelectItem value={state.autoTranslation.language}>{state.autoTranslation.language}</SelectItem>}</SelectContent></Select></ToolField>
            <StudioAutomaticKnowledge controller={controller} state={state} />
            {!state.autoTranslationReady && <p role="status" className="studio-transcription-row-warning studio-transcription-wide-field">{t('knowledge:automatic.configuration')}</p>}
          </div>}
          <ToolSwitchRow id="studio-transcription-auto-export" testId="studio-transcription-auto-export-row" label={t('studio:transcription.auto_export')} hint={t('studio:transcription.auto_export_hint')} checked={state.autoExport.enabled} disabled={state.submitting} onCheckedChange={enabled => setAutoExport({ enabled })} />
          {state.autoExport.enabled && <div className="studio-transcription-config-fields" data-testid="studio-transcription-auto-export-configuration">
            <ToolField label={t('studio:export.format')} htmlFor="studio-transcription-export-format"><Select value={state.autoExport.format} onValueChange={format => setAutoExport({ format: format as typeof state.autoExport.format })} disabled={state.submitting}><SelectTrigger id="studio-transcription-export-format"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">{t('studio:transcription.auto_export_format_auto')}</SelectItem>{SUBTITLE_TEXT_FORMATS.map(format => <SelectItem key={format} value={format}>{format.toUpperCase()}</SelectItem>)}</SelectContent></Select></ToolField>
            {/* Without a translation there is only the original to write. */}
            <ToolField label={t('studio:export.mode')} htmlFor="studio-transcription-export-mode"><Select value={state.autoTranslation.enabled ? state.autoExport.mode : 'source'} onValueChange={mode => setAutoExport({ mode: mode as typeof state.autoExport.mode })} disabled={state.submitting || !state.autoTranslation.enabled}><SelectTrigger id="studio-transcription-export-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bilingual">{t('studio:export.bilingual')}</SelectItem><SelectItem value="target">{t('studio:export.target')}</SelectItem><SelectItem value="source">{t('studio:export.source')}</SelectItem></SelectContent></Select></ToolField>
            {state.autoTranslation.enabled && state.autoExport.mode === 'bilingual' && <ToolField label={t('studio:export.order')} htmlFor="studio-transcription-export-order"><Select value={state.autoExport.order} onValueChange={order => setAutoExport({ order: order as typeof state.autoExport.order })} disabled={state.submitting}><SelectTrigger id="studio-transcription-export-order"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="source-first">{t('studio:export.source_first')}</SelectItem><SelectItem value="target-first">{t('studio:export.target_first')}</SelectItem></SelectContent></Select></ToolField>}
            <ToolField label={t('studio:export.conflict_policy')} htmlFor="studio-transcription-export-conflict"><Select value={state.autoExport.conflictPolicy} onValueChange={conflictPolicy => setAutoExport({ conflictPolicy: conflictPolicy as typeof state.autoExport.conflictPolicy })} disabled={state.submitting}><SelectTrigger id="studio-transcription-export-conflict"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="indexed">{t('studio:export.conflict_indexed')}</SelectItem><SelectItem value="overwrite">{t('studio:export.conflict_overwrite')}</SelectItem></SelectContent></Select></ToolField>
            <ToolSwitchRow id="studio-transcription-export-remove" testId="studio-transcription-export-remove-row" className="studio-transcription-wide-field" label={t('studio:transcription.auto_export_remove')} hint={t('studio:transcription.auto_export_remove_hint')} checked={!!state.autoExport.removeAfterExport} disabled={state.submitting} onCheckedChange={removeAfterExport => setAutoExport({ removeAfterExport })} />
            {!state.autoTranslation.enabled && <p className="studio-transcription-help studio-transcription-wide-field">{t('studio:transcription.auto_export_source_only')}</p>}
          </div>}
          <div className="studio-transcription-runtime-row" data-testid="studio-transcription-runtime-row">{runtimeNotice}<Button variant="ghost" size="sm" data-testid="studio-transcription-check-again" disabled={state.refreshing} onClick={checkAgain}><RefreshCw className={state.refreshing ? 'studio-spin' : undefined} />{t('studio:transcription.check_again')}</Button></div>
        </ToolConfigPanel>
      </div>}>
      <div {...dropProps} data-testid="studio-transcription" className="studio-transcription-workspace">
        <ToolFilePickerSurface data-testid="studio-transcription-picker" dragging={dragging} title={t('studio:transcription.media_title')} description={t(dragging ? mediaBusy ? 'studio:transcription.media_drop_busy' : 'studio:transcription.media_drop_hint' : 'studio:transcription.media_hint')} actionLabel={t('studio:transcription.choose_media')} icon={state.selecting ? <LoaderCircle className="size-5 studio-spin" /> : <AudioLines className="size-5" />} disabled={mediaBusy} onSelect={() => void controller.selectMedia()} />
        {(state.error || openError) && <StudioNotice role="alert" className="text-destructive border-destructive/20 bg-destructive/5"><AlertCircle /><span>{t(openError ? 'studio:errors.document_unavailable' : errorMessage)}</span><StudioIconButton label={t('studio:dismiss')} onClick={() => { controller.clearError(); setOpenError(false); }}><X /></StudioIconButton></StudioNotice>}
        <VcRuntimeNotice testId="studio-transcription-vc-runtime" onHelp={() => undefined} />
        {state.cleanupPendingCount > 0 && <StudioNotice role="status"><AlertCircle /><span>{t('studio:transcription.cleanup_pending')}</span><Button variant="ghost" size="sm" onClick={() => void controller.retryCleanup()}>{t('studio:transcription.retry_cleanup')}</Button></StudioNotice>}
        <ToolPanel title={t('studio:transcription.selected_media')} icon={AudioLines} badge={<Badge variant="secondary" className="font-mono text-[11px]">{state.drafts.length}</Badge>}
          actions={state.drafts.length ? <Button variant="ghost" size="sm" disabled={state.submitting} onClick={() => void controller.clearDrafts()}><X />{t('studio:transcription.clear_media')}</Button> : undefined}
          className="studio-transcription-media-panel"
          footer={<div className="studio-transcription-start-bar"><div className="studio-transcription-start-meta"><span>{model ? nameOf(model) : t('studio:transcription.choose_model')}</span><span id="studio-transcription-readiness">{invalidNumeric ? t('studio:transcription.readiness_config') : readinessKey ? t(readinessKey) : t('studio:transcription.ready_count', { count: readiness.readyCount })}</span></div><Button variant="ghost" size="sm" className="lg:hidden" onClick={settings}><Settings2 />{t('studio:transcription.settings')}</Button><Button data-testid="studio-transcription-start" size="sm" disabled={!readiness.canEnqueue || invalidNumeric} aria-describedby="studio-transcription-readiness" onClick={() => void controller.enqueue()}>{state.submitting ? <LoaderCircle className="studio-spin" /> : <Play />}{t(state.submitting ? 'studio:transcription.starting' : 'studio:transcription.start')}</Button></div>}>
          {!!state.drafts.length && <StudioScrollFade maxHeight={290}><ul className="studio-transcription-media-list">{state.drafts.map(draft => <li key={draft.id} data-testid="studio-transcription-media-row" data-draft-id={draft.id} data-state={draft.status}>
            <AudioLines className="studio-transcription-row-icon" /><div className="studio-transcription-row-content"><StudioFileName name={draft.displayName} focusable /><div className="studio-transcription-row-meta">{draft.media && <span>{bytes(draft.media.byteSize)}</span>}{draft.probe && <span>{duration(draft.probe.durationMs)}</span>}{draft.status === 'probing' && <span><LoaderCircle className="size-3 studio-spin" />{t('studio:transcription.checking_media')}</span>}</div>
              {draft.status === 'expired' && <p className="studio-transcription-row-warning">{t('studio:transcription.expired_media')}</p>}
              {draft.status === 'submission_unknown' && <p className="studio-transcription-row-warning">{t('studio:transcription.unknown_submission')}</p>}
              {draft.error && draft.status === 'error' && <p className="studio-transcription-row-warning">{t(draft.error === 'needs_configuration' ? 'studio:errors.needs_configuration' : draft.error === 'access_denied' ? 'studio:errors.access_denied' : 'studio:errors.transcription_failed')}</p>}
            </div>
            {draft.probe && draft.probe.audioTracks.length > 1 && <Select value={draft.audioStreamId ?? draft.probe.autoSelectedStreamId} disabled={state.submitting} onValueChange={streamId => controller.setAudioStream(draft.id, streamId)}><SelectTrigger aria-label={`${t('studio:transcription.audio_track')} · ${draft.displayName}`} className="studio-transcription-track"><SelectValue /></SelectTrigger><SelectContent>{draft.probe.audioTracks.map(track => <SelectItem key={track.streamId} value={track.streamId}>{t('studio:transcription.track_number', { number: track.ordinal })}{track.language ? ` · ${track.language}` : ''}{track.title ? ` · ${track.title}` : ''}</SelectItem>)}</SelectContent></Select>}
            <div className="studio-transcription-row-actions">{draft.media && draft.status === 'error' && <StudioIconButton label={`${t('studio:transcription.retry_probe')} · ${draft.displayName}`} disabled={state.submitting} onClick={() => void controller.retryProbe(draft.id)}><RefreshCw /></StudioIconButton>}<StudioIconButton label={`${t('studio:transcription.remove_media')} · ${draft.displayName}`} disabled={state.submitting || draft.status === 'submitting'} onClick={() => void controller.removeDraft(draft.id)}><X /></StudioIconButton></div>
          </li>)}</ul></StudioScrollFade>}
        </ToolPanel>
        <ToolPanel title={t('studio:transcription.queue')} icon={ListOrdered} badge={state.tasks.length ? <Badge variant="secondary" className="font-mono text-[11px]">{state.tasks.length}</Badge> : undefined} className="studio-transcription-queue"
          actions={<div className="studio-transcription-queue-actions"><Button variant="ghost" size="sm" title={t('studio:transcription.clear_completed_hint')} data-testid="studio-queue-clear-completed" disabled={queueBusy || !clearableCompleted} onClick={() => void controller.clearCompleted()}>{state.queueAction === 'clear_completed' ? <LoaderCircle className="studio-spin" /> : <Trash2 />}{t('studio:transcription.clear_completed')}</Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={t('studio:transcription.queue_actions')} disabled={queueBusy || !state.tasks.length}><Ellipsis className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={!clearableTerminal} onSelect={() => void controller.clearTerminal()}><Trash2 /><span className="studio-queue-menu-label">{t('studio:transcription.clear_terminal')}<small>{t('studio:transcription.clear_terminal_hint')}</small></span></DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={!cancellableTasks.length} onSelect={() => setCancelTargets(cancellableTasks.map(task => task.taskId))}><Square />{t('studio:transcription.cancel_all')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            <StudioIconButton label={t('studio:refresh')} disabled={state.refreshing || queueBusy} onClick={() => void controller.refresh()}><RefreshCw className={state.refreshing ? 'studio-spin' : undefined} /></StudioIconButton></div>}>
          <span className="sr-only" role="status">{t('studio:transcription.active_count', { active: activeCount, completed: completedCount, empty: emptyCount })}</span>
          {state.queueResult && <p className="studio-transcription-queue-result" role="status" data-testid="studio-queue-result">{t(state.queueResult.action === 'cancel_active' ? 'studio:transcription.cancel_result' : 'studio:transcription.clear_result', { count: state.queueResult.succeeded, failed: state.queueResult.failed, skipped: state.queueResult.skipped })}</p>}
          {state.tasks.length ? <><StudioScrollFade maxHeight={460}><StudioTaskQueue className="studio-transcription-task-list">{state.tasks.map(task => <StudioTaskQueueRow key={task.taskId} data-testid="studio-transcription-task-row" data-task-id={task.taskId} data-state={task.status}
            name={task.displayName}
            icon={task.status === 'completed' ? <Check className="text-emerald-600 dark:text-emerald-400" /> : task.status === 'no_content' ? <CircleMinus className="text-muted-foreground" /> : task.status === 'failed' ? <AlertCircle className="text-destructive" /> : terminal(task) ? <Square className="text-muted-foreground" /> : <LoaderCircle className={task.status === 'queued' ? 'text-muted-foreground' : 'studio-spin text-muted-foreground'} />}
            actions={<><StudioRevealSource kind="transcription" id={task.taskId} />{task.documentId && <StudioIconButton label={t('studio:transcription.open_document')} disabled={opening !== null} onClick={() => void openDocument(task.documentId!)}>{opening === task.documentId ? <LoaderCircle className="studio-spin" /> : <Subtitles />}</StudioIconButton>}{terminal(task) ? <StudioIconButton label={t('studio:transcription.remove_task')} disabled={!!state.queueAction || state.taskActions.includes(task.taskId) || !!task.cleanupPending} onClick={() => void controller.removeTask(task.taskId)}><Trash2 /></StudioIconButton>  : <StudioIconButton className="studio-transcription-stop" label={t('studio:transcription.cancel_task')} disabled={!!state.queueAction || state.taskActions.includes(task.taskId) || state.cancellingTaskIds.includes(task.taskId)} onClick={() => void controller.cancelTask(task.taskId)}>{state.cancellingTaskIds.includes(task.taskId) ? <LoaderCircle className="studio-spin" /> : <Square />}</StudioIconButton>}</>}
            metadata={<><span>{state.cancellingTaskIds.includes(task.taskId) ? t('studio:transcription.cancelling') : t(taskStatusKeys[task.status])}</span><TaskModelLabel name={taskModelName(task.modelId)} backend={task.resolvedBackend}
              reason={!task.error && cpuReason && task.resolvedBackend === 'cpu' && state.autoDeviceTaskIds.includes(task.taskId) ? t(cpuReason) : undefined} />{task.audioProfile && <AudioTypeLabel profile={task.audioProfile} />}{task.durationMs !== undefined && <span>{duration(task.durationMs)}</span>}{task.automaticTranslation && <AutomaticTranslationLabel status={task.automaticTranslation.status} />}{!terminal(task) && <span className="studio-task-percentage">{Math.round(task.progress)}%</span>}</>}
            progress={!terminal(task) ? { max: 100, value: task.progress, label: `${t(taskStatusKeys[task.status])} · ${task.displayName}` } : undefined}>
            {task.status === 'no_content' && <TranscriptionEmptyResult help={transcriptionRetrySuggestion(task) === 'quiet' ? t('studio:transcription.empty_retry_help') : undefined}>
              {transcriptionTaskRetryable(task) && <div className="studio-task-failure-actions">{retryActions(task)}</div>}
            </TranscriptionEmptyResult>}
            {task.error && <TaskFailure task={task} vcRuntimeMissing={vcMissing} onOpenResources={() => setResourcesOpen(true)} retry={transcriptionTaskRetryable(task) ? retryActions(task) : undefined} />}
            {state.sourceChangedTaskIds.includes(task.taskId) && <p role="status" className="studio-transcription-row-warning" data-testid="studio-transcription-retry-source-changed">{t('studio:transcription.retry_source_changed')}</p>}{task.cleanupPending && <p className="studio-transcription-row-warning">{t('studio:transcription.task_cleanup_pending')}</p>}{task.documentDurability === 'uncertain' && <p className="studio-transcription-row-warning">{t('studio:transcription.durability_uncertain')}</p>}
          </StudioTaskQueueRow>)}</StudioTaskQueue></StudioScrollFade></> : <div className="studio-transcription-empty"><ListOrdered /><p>{t('studio:transcription.queue_empty')}</p><span>{t('studio:transcription.queue_hint')}</span></div>}
        </ToolPanel>
      </div>
    </ToolDetailLayout>
    <ScrollableDialog animateSize open={cancelTargets !== null} onOpenChange={open => { if (!open && !state.queueAction) setCancelTargets(null); }} maxWidth="sm:max-w-[480px]">
      <ScrollableDialogHeader><DialogTitle className="text-sm">{t('studio:transcription.cancel_all')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:transcription.cancel_all_confirmation', { count: cancelTargets?.length ?? 0 })}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogFooter className="p-3"><Button variant="outline" size="sm" disabled={!!state.queueAction} onClick={() => setCancelTargets(null)}>{t('studio:cancel')}</Button><Button variant="destructive" size="sm" data-testid="studio-queue-confirm-cancel" disabled={queueBusy || !cancelTargets?.length} onClick={() => { if (cancelTargets) { void controller.cancelTasks(cancelTargets); setCancelTargets(null); } }}><Square />{t('studio:transcription.confirm_cancel_all')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog animateSize open={resourcesOpen} onOpenChange={setResourcesOpen} maxWidth="sm:max-w-[640px]" contentClassName="studio-transcription-resource-dialog" onCloseAutoFocus={event => { event.preventDefault(); resourceTrigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="studio-resources-header"><DialogTitle className="flex min-w-0 items-center gap-2 text-sm"><HardDrive className="size-4 shrink-0" />{t('studio:transcription.resources')}</DialogTitle></ScrollableDialogHeader>
      <ScrollableDialogContent fadeMaskHeight={20}><div data-testid="studio-transcription-resources" className="studio-resources-content">
        <div className="studio-resources-overview">
          <DialogDescription className="text-xs leading-5">{t('studio:transcription.resource_description')}</DialogDescription>
          {!runtimeNeedsVc && runtimeNotice}
          <VcRuntimeNotice className="studio-resources-vc-runtime" testId="studio-resources-vc-runtime" onHelp={() => setResourcesOpen(false)} />
          {state.sharedResources && <p className="studio-transcription-help" data-testid="studio-shared-resource-hint">{t('studio:transcription.shared_hint')}</p>}
          <DialogTransition transitionKey="resource-notices" stageClassName="studio-resources-notices">
            {!!state.sharedResources?.migrationIssues.length && <p role="status" className="studio-transcription-row-warning">{t('studio:transcription.migration_issues')}</p>}
            {state.sharedResources?.cleanupPending && <p role="status" className="studio-transcription-row-warning">{t('studio:transcription.shared_cleanup_pending')}</p>}
            {state.error && <p role="alert" className="studio-transcription-row-warning">{t(errorMessage)}</p>}
          </DialogTransition>
        </div>
        <StudioLocalPrepare state={state} freeBytes={freeBytes} />
        {state.resources.length ? <ul className="studio-resources-list">{state.resources.map(resource => {
        const job = [...state.resourceJobs].reverse().find(item => item.resourceId === resource.resourceId);
        const running = !!job && activeResource(job.status);
        const pending = gating === resource.resourceId || state.resourceActions.includes(resource.resourceId) || (!!job && state.resourceActions.includes(job.jobId));
        const busy = speechResourceIsBusy(state.sharedResources, resource.resourceId);
        const failure = job?.error ? resourceErrorGuide(job.error.code, { imported: state.importJobIds.includes(job.jobId), vad: resource.resourceType === 'vad', vcRuntimeMissing: vcMissing }) : undefined;
        const detail = resourceDetailName(resource);
        const packFit = isCudaAccelerator(resource) ? cuda : undefined;
        const oldDriver = packFit === 'recommended' && !!system.gpu?.driverVersion && !system.gpu.driverOk;
        const profile = resource.resourceType === 'model' ? transcriptionModelProfile(resource.resourceId) : undefined;
        return <li key={resource.resourceId} data-resource-id={resource.resourceId} data-state={resource.status} className="studio-resource-row">
          <div className="studio-resource-heading">
            <div className="studio-resource-identity">
              <p className="studio-resource-name">{nameOf(resource)}</p>
              <div className="studio-resource-meta">
                <span>{t(resource.resourceType === 'model' ? 'studio:transcription.resource_model' : resource.resourceType === 'vad' ? 'studio:transcription.resource_vad' : 'studio:transcription.resource_accelerator')}</span>
                {detail && <span className="studio-resource-detail" data-testid="studio-resource-detail">{detail}</span>}
                <span>{bytes(resource.byteSize)}</span>
                <Badge variant={resource.status === 'ready' ? 'secondary' : 'outline'}>{t(resourceStatusKeys[resource.status])}</Badge>
                {packFit === 'recommended' && <Badge variant="secondary" className="studio-resource-recommended" data-testid="studio-resource-recommended">{t('studio:transcription.recommended')}</Badge>}
                {packFit === 'not_applicable' && <Badge variant="outline" data-testid="studio-resource-not-applicable">{t('studio:transcription.not_applicable')}</Badge>}
                {profile?.role === 'recognize' && <Badge variant="outline" data-testid="studio-resource-recognize-only">{t('studio:transcription.model_recognize_only')}</Badge>}
                {profile?.experimental && <Badge variant="outline" data-testid="studio-resource-experimental">{t('studio:transcription.model_experimental')}</Badge>}
                {running && <span className="studio-resource-percentage">{Math.round(job.progress)}%</span>}
              </div>
            </div>
            <div className="studio-resource-actions">
              {running ? <Button variant="outline" size="sm" disabled={pending} onClick={() => void controller.cancelResourceJob(job.jobId)}><Square />{t('studio:transcription.cancel_download')}</Button>
                : resource.status !== 'ready' ? <>
                  <Button variant="outline" size="sm" disabled={pending || busy} onClick={() => void install(resource)}>{pending ? <LoaderCircle className="studio-spin" /> : <Download />}{t('studio:transcription.download')}</Button>
                  {resource.resourceType === 'model' && <Button variant="ghost" size="sm" disabled={pending || busy} onClick={() => void controller.importModel(resource.resourceId)}><FolderOpen />{t('studio:transcription.import_model')}</Button>}
                </> : <StudioIconButton className="studio-resource-delete" label={t('studio:transcription.delete_resource')} disabled={pending || busy} onClick={() => { controller.clearError(); setDeleteTarget(resource); }}>{pending ? <LoaderCircle className="studio-spin" /> : <Trash2 />}</StudioIconButton>}
            </div>
          </div>
          {/* What the model suits (and how to use one only for recognizing), then any licence limit of its training data; the row's full width, as its feedback. */}
          {(profile?.scenarioKey || profile?.licenseKey) && <div className="studio-resource-notes">
            {profile?.scenarioKey && <p className="studio-resource-note" data-testid="studio-resource-scenario">{t(profile.scenarioKey)}</p>}
            {profile?.licenseKey && <p className="studio-resource-note" data-testid="studio-resource-license">{t(profile.licenseKey)}</p>}
          </div>}
          <DialogTransition transitionKey="resource-feedback" stageClassName="studio-resource-feedback">
            {running && <progress max={100} value={job.progress} aria-label={nameOf(resource)} className="studio-transcription-progress" />}
            {failure && job?.error && !running && resource.status !== 'ready' && <div className="studio-resource-failure" data-testid="studio-resource-failure" data-code={job.error.code}>
              <p className="studio-transcription-row-warning">{t(failure.key)}</p>
              {failure.network && <Button variant="outline" size="xs" onClick={() => { setResourcesOpen(false); navigate('/setting?tab=proxy'); }}><Globe />{t('studio:transcription.open_network_settings')}</Button>}
              {failure.help && <Button variant="outline" size="xs" data-testid="studio-resource-failure-help" onClick={() => { setResourcesOpen(false); navigate(helpPath(failure.help)); }}><CircleHelp />{t('common:action.view_help')}</Button>}
              {failure.generic && <CopyDiagnostics text={studioErrorDiagnostics({ code: job.error.code, resource: resource.resourceId, imported: state.importJobIds.includes(job.jobId) ? 'yes' : undefined })} />}
            </div>}
            {busy && <p className="studio-transcription-help">{t('studio:transcription.shared_busy')}</p>}
            {packFit === 'not_applicable' && resource.status !== 'ready' && <p className="studio-transcription-help" data-testid="studio-resource-not-applicable-hint">{t('studio:transcription.cuda_not_applicable_hint')}</p>}
            {oldDriver && <div className="studio-resource-failure" data-testid="studio-resource-driver-old">
              <p className="studio-transcription-row-warning">{t('studio:transcription.cuda_driver_old', { version: system.gpu!.driverVersion, minimum: NVIDIA_MINIMUM_DRIVER })}</p>
              <Button variant="outline" size="xs" data-href={driverUrl} onClick={() => openExternalPage(driverUrl)}><ExternalLink />{t('studio:transcription.cuda_driver_update')}</Button>
            </div>}
          </DialogTransition>
        </li>;
      })}</ul> : <p className="studio-transcription-help">{t('studio:transcription.resource_empty')}</p>}</div></ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap justify-between gap-2 p-3"><Button variant="ghost" size="sm" disabled={state.refreshing} onClick={checkAgain}><RefreshCw className={state.refreshing ? 'studio-spin' : undefined} />{t('studio:transcription.check_again')}</Button><Button variant="outline" size="sm" onClick={() => setResourcesOpen(false)}>{t('studio:transcription.close')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog animateSize open={!!runtimeGate} onOpenChange={open => { if (!open) setRuntimeGate(null); }} maxWidth="sm:max-w-[480px]" contentClassName="studio-runtime-gate-dialog">
      <ScrollableDialogHeader><DialogTitle className="text-sm">{t('studio:transcription.vc_runtime_download_title')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:transcription.vc_runtime_download_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent><VcRuntimeNotice testId="studio-runtime-gate-notice" onRepaired={() => continueAfterRuntime(runtimeGateRef.current)} /></ScrollableDialogContent>
      <ScrollableDialogFooter className="p-3"><Button variant="outline" size="sm" onClick={() => setRuntimeGate(null)}>{t('studio:cancel')}</Button><Button variant="ghost" size="sm" data-testid="studio-runtime-gate-anyway" disabled={system.repairing} onClick={() => continueAfterRuntime(runtimeGate)}><Download />{t('studio:transcription.vc_runtime_download_anyway')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog animateSize open={!!cudaConfirm} onOpenChange={open => { if (!open) setCudaConfirm(null); }} maxWidth="sm:max-w-[480px]" contentClassName="studio-cuda-confirm-dialog">
      <ScrollableDialogHeader><DialogTitle className="text-sm">{t('studio:transcription.cuda_confirm_title')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:transcription.cuda_confirm_description', { size: cudaConfirm ? bytes(cudaConfirm.byteSize) : '' })}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogFooter className="p-3"><Button variant="outline" size="sm" onClick={() => setCudaConfirm(null)}>{t('studio:cancel')}</Button><Button variant="outline" size="sm" data-testid="studio-cuda-confirm-download" onClick={() => { const resource = cudaConfirm; setCudaConfirm(null); if (resource) void install(resource, { gpu: true }); }}><Download />{t('studio:transcription.prepare_download_anyway')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog animateSize open={!!deleteTarget} onOpenChange={open => { if (!open && (!deleteTarget || !state.resourceActions.includes(deleteTarget.resourceId))) setDeleteTarget(null); }} maxWidth="sm:max-w-[480px]">
      <ScrollableDialogHeader><DialogTitle className="text-sm">{t('studio:transcription.delete_resource')}</DialogTitle><DialogDescription className="text-xs leading-5 break-words">{t('studio:transcription.delete_shared_confirmation', { name: deleteTarget ? nameOf(deleteTarget) : '' })}</DialogDescription></ScrollableDialogHeader>
      {state.error && <ScrollableDialogContent><p role="alert" className="studio-transcription-row-warning">{t(errorMessage)}</p></ScrollableDialogContent>}
      <ScrollableDialogFooter className="p-3"><Button variant="outline" size="sm" disabled={!!deleteTarget && state.resourceActions.includes(deleteTarget.resourceId)} onClick={() => setDeleteTarget(null)}>{t('studio:cancel')}</Button><Button variant="destructive" size="sm" data-testid="studio-confirm-delete-resource" disabled={!deleteTarget || state.resourceActions.includes(deleteTarget.resourceId) || speechResourceIsBusy(state.sharedResources, deleteTarget.resourceId)} onClick={async () => { if (deleteTarget && await controller.deleteResource(deleteTarget.resourceId)) setDeleteTarget(null); }}><Trash2 />{t('studio:transcription.delete_resource')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
