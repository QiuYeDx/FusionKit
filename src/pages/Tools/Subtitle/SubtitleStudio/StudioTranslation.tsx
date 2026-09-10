import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Calculator, CheckCheck, ChevronDown, Languages, LoaderCircle, Play, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import useModelStore from '@/store/useModelStore';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { translationConfigSchema, translationModelSchema, type TranslationPlanSummary } from '@/subtitle-studio/translation-contract';
import './StudioTranslation.css';

const errorKeys = {
  invalid_input: 'studio:errors.invalid_input',
  unsupported_feature: 'studio:errors.unsupported_feature',
  encoding_required: 'studio:errors.encoding_required',
  limit_exceeded: 'studio:errors.limit_exceeded',
  revision_conflict: 'studio:errors.revision_conflict',
  access_denied: 'studio:errors.access_denied',
  document_unavailable: 'studio:errors.document_unavailable',
  output_write_failed: 'studio:errors.output_write_failed',
  needs_configuration: 'studio:errors.needs_configuration',
  translation_protocol_invalid: 'studio:errors.translation_protocol_invalid',
  translation_output_limit: 'studio:errors.translation_output_limit',
  translation_failed: 'studio:errors.translation_failed',
  interrupted: 'studio:errors.interrupted',
} as const satisfies Record<ErrorCode, string>;
const statusKeys = {
  queued: 'studio:translation.queued',
  running: 'studio:translation.running',
  interrupted: 'studio:translation.interrupted',
  needs_configuration: 'studio:translation.needs_configuration',
  completed: 'studio:translation.completed',
  failed: 'studio:translation.failed',
  cancelled: 'studio:translation.cancelled',
} as const;
const languageKeys = {
  zh: 'studio:translation.languages.zh',
  en: 'studio:translation.languages.en',
  ja: 'studio:translation.languages.ja',
  'zh-Hant': 'studio:translation.languages.zh-Hant',
} as const;
type LanguageChoice = keyof typeof languageKeys | 'custom';

type StudioTranslationProps = {
  page: DocumentPage;
  busy: boolean;
  onStarted: () => void;
  onError: (error: ErrorCode) => void;
};

export function StudioTranslation({ page, busy, onStarted, onError }: StudioTranslationProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const controlId = useId();
  const profiles = useModelStore(state => state.profiles);
  const assignment = useModelStore(state => state.assignment.taskExecution);
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState(() => assignment ?? profiles[0]?.id ?? '');
  const [language, setLanguage] = useState<LanguageChoice>(() => {
    const current = i18n.resolvedLanguage;
    return current && current in languageKeys ? current as keyof typeof languageKeys : 'zh';
  });
  const [customLanguage, setCustomLanguage] = useState('');
  const [instructions, setInstructions] = useState('');
  const [contextWindow, setContextWindow] = useState('32768');
  const [maxOutputTokens, setMaxOutputTokens] = useState('4096');
  const [maxBatchCues, setMaxBatchCues] = useState('32');
  const [plan, setPlan] = useState<{ identity: string; value: TranslationPlanSummary } | null>(null);
  const [activity, setActivity] = useState<'plan' | 'start' | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = profiles.find(profile => profile.id === profileId);
  const model = useMemo(() => translationModelSchema.safeParse(selected ? {
    profileId: selected.id,
    modelKey: selected.modelKey,
    endpoint: selected.baseUrl,
    apiFormat: selected.apiFormat,
    outputTokenParameter: selected.outputTokenParameter,
  } : null), [selected]);
  const config = useMemo(() => translationConfigSchema.safeParse({
    model: model.success ? model.data : null,
    language: language === 'custom' ? customLanguage : language,
    instructions,
    contextWindow: Number(contextWindow),
    maxOutputTokens: Number(maxOutputTokens),
    maxBatchCues: Number(maxBatchCues),
  }), [model, language, customLanguage, instructions, contextWindow, maxOutputTokens, maxBatchCues]);
  const identity = JSON.stringify([page.summary.id, page.summary.revision, config.success ? config.data : null]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const currentDocumentId = useRef(page.summary.id);
  currentDocumentId.current = page.summary.id;
  const currentPlan = plan?.identity === identity ? plan.value : null;
  const activeTask = page.tasks.some(task => task.status === 'queued' || task.status === 'running');
  const unavailable = !page.summary.capabilities.translate || page.summary.cueCount === 0;
  const pending = activity !== null;
  const needsConfiguration = !model.success || !selected?.apiKey.trim();
  const canPlan = !busy && !pending && !activeTask && !unavailable && !needsConfiguration && config.success;
  const reportError = (failure: unknown) => {
    const code = failure instanceof StudioError ? failure.code : 'translation_failed';
    setError(code);
    onError(code);
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { setPlan(null); setError(null); }, [identity]);
  useEffect(() => {
    if (!profileId && profiles.length) setProfileId(assignment ?? profiles[0].id);
  }, [assignment, profileId, profiles]);

  const prepare = async () => {
    if (operation.current || !canPlan || !config.success) return;
    operation.current = true;
    setActivity('plan'); setError(null); setPlan(null);
    const requestIdentity = identity;
    try {
      const value = await unwrapStudio(window.subtitleStudio.planTranslation({
        documentId: page.summary.id, revision: page.summary.revision, config: config.data,
      }));
      if (mounted.current && currentIdentity.current === requestIdentity) setPlan({ identity: requestIdentity, value });
    } catch (failure) {
      if (mounted.current && currentIdentity.current === requestIdentity) reportError(failure);
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };
  const start = async () => {
    if (operation.current || !canPlan || !currentPlan || !selected) return;
    operation.current = true;
    setActivity('start'); setError(null);
    const requestIdentity = identity;
    try {
      await unwrapStudio(window.subtitleStudio.createTranslation({
        documentId: page.summary.id, revision: page.summary.revision,
        planId: currentPlan.planId, apiKey: selected.apiKey,
      }));
      if (mounted.current && currentDocumentId.current === page.summary.id) { setOpen(false); setPlan(null); onStarted(); }
    } catch (failure) {
      if (mounted.current && currentIdentity.current === requestIdentity) { setPlan(null); reportError(failure); }
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };

  return <>
    <Button ref={trigger} variant="outline" size="sm" disabled={busy || activeTask || unavailable || pending} onClick={() => { setError(null); setOpen(true); }}>
      <Languages />{t('studio:translation.action')}
    </Button>
    <ScrollableDialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }} maxWidth="sm:max-w-[560px]" contentClassName="studio-translation-dialog" onOpenAutoFocus={event => {
      event.preventDefault(); document.getElementById(`${controlId}-${profiles.length ? 'model' : 'language'}`)?.focus({ preventScroll: true });
    }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="relative p-3 pr-12">
        <DialogTitle className="flex items-center gap-2 text-base"><Languages className="size-4" />{t('studio:translation.title')}</DialogTitle>
        <DialogDescription className="sr-only">{page.summary.origin.displayName}</DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-translation-content" fadeMaskHeight={16}>
        <div className="studio-translation-form">
          <div className="studio-translation-fields">
            <ToolField label={t('studio:translation.model')} htmlFor={`${controlId}-model`}>
              <Select value={selected?.id ?? ''} onValueChange={setProfileId} disabled={pending || !profiles.length}>
                <SelectTrigger id={`${controlId}-model`} className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder={t('studio:translation.select_model')} /></SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">{profiles.map(profile => <SelectItem key={profile.id} value={profile.id} className="whitespace-normal break-all">{profile.name || profile.modelKey}</SelectItem>)}</SelectContent>
              </Select>
            </ToolField>
            <ToolField label={t('studio:translation.language')} htmlFor={`${controlId}-language`}>
              <Select value={language} onValueChange={value => setLanguage(value as LanguageChoice)} disabled={pending}>
                <SelectTrigger id={`${controlId}-language`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(languageKeys) as (keyof typeof languageKeys)[]).map(value => <SelectItem key={value} value={value}>{t(languageKeys[value])}</SelectItem>)}<SelectItem value="custom">{t('studio:translation.custom_language')}</SelectItem></SelectContent>
              </Select>
            </ToolField>
          </div>
          {language === 'custom' && <ToolField label={t('studio:translation.custom_language_name')} htmlFor={`${controlId}-custom-language`}>
            <Input id={`${controlId}-custom-language`} className="h-8 text-xs" value={customLanguage} onChange={event => setCustomLanguage(event.target.value)} maxLength={100} disabled={pending} />
          </ToolField>}
          {needsConfiguration && <div className="studio-translation-configuration">
            <p><AlertCircle className="size-4 shrink-0" />{t('studio:translation.model_required')}</p>
            <Button variant="outline" size="sm" onClick={() => { setOpen(false); navigate('/setting?tab=model'); }} disabled={pending}><Settings />{t('studio:translation.model_settings')}</Button>
          </div>}
          <ToolField label={t('studio:translation.instructions')} htmlFor={`${controlId}-instructions`}>
            <Textarea id={`${controlId}-instructions`} className="studio-translation-instructions text-xs" value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={4000} disabled={pending} />
          </ToolField>
          <details className="studio-translation-advanced">
            <summary>{t('studio:translation.advanced')}<ChevronDown className="size-3.5" /></summary>
            <div className="studio-translation-budget-fields">
              <ToolField label={t('studio:translation.context_window')} htmlFor={`${controlId}-context`}>
                <Input id={`${controlId}-context`} type="number" min={2048} max={1000000} step={1} className="h-8 font-mono text-xs" value={contextWindow} onChange={event => setContextWindow(event.target.value)} disabled={pending} />
              </ToolField>
              <ToolField label={t('studio:translation.max_output')} htmlFor={`${controlId}-output`}>
                <Input id={`${controlId}-output`} type="number" min={256} max={32768} step={1} className="h-8 font-mono text-xs" value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.value)} disabled={pending} />
              </ToolField>
              <ToolField label={t('studio:translation.batch_cues')} htmlFor={`${controlId}-batch`}>
                <Input id={`${controlId}-batch`} type="number" min={1} max={100} step={1} className="h-8 font-mono text-xs" value={maxBatchCues} onChange={event => setMaxBatchCues(event.target.value)} disabled={pending} />
              </ToolField>
            </div>
          </details>
          {!needsConfiguration && !config.success && <p className="studio-translation-error" role="alert">{t('studio:translation.invalid_options')}</p>}
          {error && <p className="studio-translation-error" role="alert"><AlertCircle className="size-4" />{t(errorKeys[error])}</p>}
          {currentPlan && <div className="studio-translation-plan" aria-live="polite">
            <h3>{t('studio:translation.estimate')}</h3>
            <dl>
              <div><dt>{t('studio:translation.estimated_input')}</dt><dd>{currentPlan.estimatedInputTokens.toLocaleString(i18n.language)}</dd></div>
              <div><dt>{t('studio:translation.batch_count')}</dt><dd>{currentPlan.batchCount.toLocaleString(i18n.language)}</dd></div>
              <div><dt>{t('studio:translation.output_reserve')}</dt><dd>{currentPlan.outputTokenReserve.toLocaleString(i18n.language)}</dd></div>
            </dl>
          </div>}
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>{t('studio:cancel')}</Button>
        {currentPlan ? <Button size="sm" disabled={!canPlan} onClick={() => void start()}>{activity === 'start' ? <LoaderCircle className="studio-spin" /> : <Play />}{t('studio:translation.start')}</Button> : <Button size="sm" disabled={!canPlan} onClick={() => void prepare()}>{activity === 'plan' ? <LoaderCircle className="studio-spin" /> : <Calculator />}{t('studio:translation.prepare')}</Button>}
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}

export function StudioTranslationStatus({ page, trackId }: { page: DocumentPage; trackId?: string }) {
  const { t, i18n } = useTranslation();
  const tasks = trackId ? page.tasks.filter(item => item.trackId === trackId) : page.tasks;
  const task = tasks.find(item => item.translation && (item.status === 'queued' || item.status === 'running'))
    ?? [...tasks].reverse().find(item => item.translation);
  if (!task?.translation) return null;
  const running = task.status === 'queued' || task.status === 'running';
  const failed = task.status === 'failed' || task.status === 'interrupted' || task.status === 'needs_configuration';
  const count = (value: number | null) => value === null ? t('studio:translation.unknown_usage') : value.toLocaleString(i18n.language);
  return <div className="studio-translation-status" role="status" data-state={task.status}>
    <span className={failed ? 'text-destructive' : ''}>{running ? <LoaderCircle className="size-3.5 studio-spin" /> : failed ? <AlertCircle className="size-3.5" /> : <CheckCheck className="size-3.5" />}{t(statusKeys[task.status])}</span>
    <span>{t('studio:translation.batch_progress', { completed: task.completedBatchIds.length, total: task.translation.totalBatches })}</span>
    <span>{t('studio:translation.actual_usage', { input: count(task.translation.usage.inputTokens), output: count(task.translation.usage.outputTokens) })}</span>
    {(task.translation.uncertainAttempts ?? task.uncertainBatchIds.length) > 0 && <span>{t('studio:translation.uncertain_usage', { count: task.translation.uncertainAttempts ?? task.uncertainBatchIds.length })}</span>}
    {task.translation.error && <span className="text-destructive">{t(errorKeys[task.translation.error])}</span>}
  </div>;
}
