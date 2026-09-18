import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Calculator, CheckCheck, BookOpen, ChevronDown, Languages, LoaderCircle, Play, Settings, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolSwitchRow } from '../../_shared/ui/ToolSwitchRow';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolConfigDisclosure } from '../../_shared/ui/ToolConfigDisclosure';
import { ToolStatBar } from '../../_shared/ui/ToolStatBar';
import useModelStore from '@/store/useModelStore';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { getStudioTranslationOverviewController } from '@/services/subtitle-studio/translation-overview-controller';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { StudioIconButton } from './StudioControls';
import { StudioSelectedDocuments } from './StudioSelectedDocuments';
import { StudioBatchItems } from './StudioBatchItems';
import { StudioDocumentRow } from './StudioDocumentList';
import { STUDIO_RESULT_DIALOG_CLASS, STUDIO_RESULT_DIALOG_WIDTH, StudioOperationResult } from './StudioOperationResult';
import { normalizeTranslationModel, translationConfigSchema, translationModelSchema, type TranslationPlanSummary } from '@/subtitle-studio/translation-contract';
import { STUDIO_BATCH_LIMIT, type TranslationBatchPlan, type TranslationBatchResult } from '@/subtitle-studio/batch-contract';
import './StudioTranslation.css';
import './StudioBatch.css';
import { StudioKnowledgeTrial } from './StudioKnowledgeTrial';
import { StudioKnowledgeBatch } from './StudioKnowledgeBatch';
import { StudioExecutionRecord, hasExecutionRecordEntry } from './StudioExecutionRecord';
import { StudioAutomaticKnowledgeFailure } from './StudioAutomaticKnowledgeFailure';
import type { AutomaticKnowledgeRecheckRequest } from './automatic-knowledge-recheck';

const errorKeys = {
  invalid_input: 'studio:errors.invalid_input',
  unsupported_feature: 'studio:errors.unsupported_feature',
  encoding_required: 'studio:errors.encoding_required',
  limit_exceeded: 'studio:errors.limit_exceeded',
  revision_conflict: 'studio:errors.revision_conflict',
  access_denied: 'studio:errors.access_denied',
  document_unavailable: 'studio:errors.document_unavailable',
  output_write_failed: 'studio:errors.output_write_failed',
  knowledge_check_failed: 'studio:errors.knowledge_check_failed', needs_configuration: 'studio:errors.needs_configuration',
  translation_protocol_invalid: 'studio:errors.translation_protocol_invalid',
  translation_record_unavailable: 'studio:errors.translation_record_unavailable',
  translation_output_limit: 'studio:errors.translation_output_limit',
  translation_failed: 'studio:errors.translation_failed',
  transcription_failed: 'studio:errors.transcription_failed', resource_busy: 'studio:errors.resource_busy',
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
  page?: DocumentPage;
  documents?: DocumentSummary[];
  triggerContainer?: HTMLElement | null;
  openRequest?: import('./StudioLibraryContextMenu').LibraryDialogRequest;
  onRequestClosed?: () => void;
  busy: boolean;
  onStarted: () => void;
  onError: (error: ErrorCode) => void;
  recheckRequest?: AutomaticKnowledgeRecheckRequest;
  onRecheckClosed?: (requestId: string) => void;
};

export function StudioBatchTranslation(props: Omit<StudioTranslationProps, 'page' | 'documents'> & { documents: DocumentSummary[] }) {
  return <StudioTranslation {...props} />;
}

export function StudioTranslation({ page, documents, triggerContainer, openRequest, onRequestClosed, busy, onStarted, onError, recheckRequest, onRecheckClosed }: StudioTranslationProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const controlId = useId();
  const profiles = useModelStore(state => state.profiles);
  const assignment = useModelStore(state => state.assignment.taskExecution);
  const [open, setOpen] = useState(false);
  const batch = documents !== undefined;
  const [batchDocuments, setBatchDocuments] = useState<DocumentSummary[]>([]);
  const [batchPlan, setBatchPlan] = useState<TranslationBatchPlan | null>(null);
  const [batchResult, setBatchResult] = useState<TranslationBatchResult | null>(null);
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
  const [knowledgeStarting, setKnowledgeStarting] = useState(false);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  const [knowledgeOpenRequest, setKnowledgeOpenRequest] = useState(0);
  const changeOpen = (value: boolean) => { if (!value) setKnowledgeOpenRequest(0); setOpen(value); };
  const [error, setError] = useState<ErrorCode | null>(null);
  const [recheckSession, setRecheckSession] = useState<AutomaticKnowledgeRecheckRequest | undefined>();
  const [recheckModelApproved, setRecheckModelApproved] = useState(false);
  const consumedRecheck = useRef<string | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const handingOffToOverview = useRef(false);
  const selected = profiles.find(profile => profile.id === profileId);
  const model = useMemo(() => translationModelSchema.safeParse(selected ? {
    profileId: selected.id,
    modelKey: selected.modelKey,
    endpoint: selected.baseUrl,
    apiFormat: selected.apiFormat,
    outputTokenParameter: selected.outputTokenParameter,
  } : null), [selected]);
  const configDraft = useMemo(() => ({
    model: model.success ? model.data : recheckSession?.seed.config.model ?? null,
    language: language === 'custom' ? customLanguage : language,
    instructions,
    contextWindow: Number(contextWindow),
    maxOutputTokens: Number(maxOutputTokens),
    maxBatchCues: Number(maxBatchCues),
  }), [model, language, customLanguage, instructions, contextWindow, maxOutputTokens, maxBatchCues, recheckSession]);
  const config = useMemo(() => translationConfigSchema.safeParse(configDraft), [configDraft]);
  // Keep material choices mounted while a language/budget field is temporarily
  // empty. The draft invalidates old plans; validation still gates every action.
  const knowledgeConfig = config.success ? config.data : configDraft.model ? { ...configDraft, model: configDraft.model } : null;
  const identity = JSON.stringify([batch ? batchDocuments.map(item => item.id) : [page?.summary.id, page?.summary.revision], config.success ? config.data : null]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const currentDocumentId = useRef(page?.summary.id);
  currentDocumentId.current = page?.summary.id;
  const currentPlan = plan?.identity === identity ? plan.value : null;
  const estimate = batchPlan ? {
    estimatedInputTokens: batchPlan.totalEstimatedInputTokens,
    batchCount: batchPlan.items.reduce((sum, item) => sum + (item.ok ? item.plan.batchCount : 0), 0),
    outputTokenReserve: batchPlan.totalOutputTokenReserve,
  } : currentPlan;
  const activeTask = page?.tasks.some(task => task.status === 'queued' || task.status === 'running') ?? false;
  const unavailable = batch ? !documents?.length || documents.length > STUDIO_BATCH_LIMIT : !page?.summary.capabilities.translate || page.summary.cueCount === 0;
  const pending = activity !== null || knowledgeStarting;
  const recheckModelMatches = !recheckSession || recheckModelApproved || model.success && (() => {
    const current = normalizeTranslationModel(model.data), previous = normalizeTranslationModel(recheckSession.seed.config.model);
    return current.profileId === previous.profileId && current.modelKey === previous.modelKey && current.endpoint === previous.endpoint
      && current.apiFormat === previous.apiFormat && current.outputTokenParameter === previous.outputTokenParameter && current.thinkingEnabled === previous.thinkingEnabled;
  })();
  const needsConfiguration = !model.success || !selected?.apiKey.trim() || !recheckModelMatches;
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
  useEffect(() => {
    // A submitted batch owns its result even if an external model setting changes.
    if (batch && (activity === 'start' || knowledgeStarting || batchResult)) return;
    setPlan(null); setBatchPlan(null); setBatchResult(null); setError(null);
  }, [identity]);
  useEffect(() => {
    if (!profileId && profiles.length) setProfileId(assignment ?? profiles[0].id);
  }, [assignment, profileId, profiles]);
  useEffect(() => { setKnowledgeEnabled(false); setKnowledgeOpenRequest(0); }, [page?.summary.id]);
  useEffect(() => {
    if (!recheckRequest || consumedRecheck.current === recheckRequest.requestId || batch || recheckRequest.documentId !== page?.summary.id) return;
    // A one-shot click initializes the draft. Polling and new object identities
    // cannot replace edits made inside an already open form.
    consumedRecheck.current = recheckRequest.requestId;
    if (open || pending) return;
    const saved = recheckRequest.seed.config;
    setProfileId(saved.model.profileId); setRecheckModelApproved(false);
    setLanguage(saved.language in languageKeys ? saved.language as LanguageChoice : 'custom');
    setCustomLanguage(saved.language); setInstructions(saved.instructions);
    setContextWindow(String(saved.contextWindow)); setMaxOutputTokens(String(saved.maxOutputTokens)); setMaxBatchCues(String(saved.maxBatchCues));
    setPlan(null); setError(null); setKnowledgeEnabled(true); setRecheckSession(recheckRequest); setOpen(true);
  }, [recheckRequest]);
  useEffect(() => {
    if (recheckSession && (recheckSession.documentId !== page?.summary.id || recheckRequest?.requestId !== recheckSession.requestId)) {
      changeOpen(false); setRecheckSession(undefined); setPlan(null);
    }
  }, [page?.summary.id, recheckRequest?.requestId]);

  const prepare = async () => {
    if (knowledgeEnabled || recheckSession || operation.current || !canPlan || !config.success) return;
    operation.current = true;
    setActivity('plan'); setError(null); setPlan(null); setBatchPlan(null); setBatchResult(null);
    const requestIdentity = identity;
    try {
      if (batch) {
        const targets = batchDocuments.map(item => documents?.find(document => document.id === item.id) ?? item);
        const value = await unwrapStudio(window.subtitleStudio.planTranslationBatch({
          documents: targets.map(item => ({ documentId: item.id, revision: item.revision })), config: config.data,
        }));
        if (mounted.current && currentIdentity.current === requestIdentity) { setBatchDocuments(targets); setBatchPlan(value); }
      } else if (page) {
        const value = await unwrapStudio(window.subtitleStudio.planTranslation({
          documentId: page.summary.id, revision: page.summary.revision, config: config.data,
        }));
        if (mounted.current && currentIdentity.current === requestIdentity) setPlan({ identity: requestIdentity, value });
      }
    } catch (failure) {
      if (mounted.current && currentIdentity.current === requestIdentity) reportError(failure);
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };
  const start = async () => {
    if (knowledgeEnabled || recheckSession || operation.current || !canPlan || !(batch ? batchPlan?.items.some(item => item.ok) : currentPlan) || !selected) return;
    operation.current = true;
    setActivity('start'); setError(null);
    const requestIdentity = identity;
    try {
      if (batch && batchPlan) {
        const value = await unwrapStudio(window.subtitleStudio.createTranslationBatch({ batchId: batchPlan.batchId, apiKey: selected.apiKey }));
        getStudioTranslationOverviewController().trackStarted(value.items.flatMap(item => item.ok ? [item.taskId] : []));
        if (mounted.current) { setBatchResult(value); setBatchPlan(null); onStarted(); }
      } else if (page && currentPlan) {
        const value = await unwrapStudio(window.subtitleStudio.createTranslation({
          documentId: page.summary.id, revision: page.summary.revision,
          planId: currentPlan.planId, apiKey: selected.apiKey,
        }));
        getStudioTranslationOverviewController().trackStarted([value.taskId]);
        if (mounted.current && currentDocumentId.current === page.summary.id) { changeOpen(false); setPlan(null); onStarted(); }
      }
    } catch (failure) {
      if (mounted.current && currentIdentity.current === requestIdentity) { setPlan(null); setBatchPlan(null); reportError(failure); }
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };

  const begin = () => { handingOffToOverview.current = false; setBatchDocuments(documents ? [...documents] : []); setBatchResult(null); setBatchPlan(null); setError(null); setOpen(true); };
  const consumedRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest && consumedRequest.current !== openRequest) { consumedRequest.current = openRequest; begin(); }
  }, [openRequest]);
  const triggerControl = <StudioIconButton ref={trigger} label={t(batch ? 'studio:batch.translation' : 'studio:translation.action')} disabled={busy || activeTask || unavailable || pending} onClick={begin}><Languages /></StudioIconButton>;

  return <>
    {triggerContainer === null ? null : triggerContainer ? createPortal(triggerControl, triggerContainer) : triggerControl}
    <ScrollableDialog open={open} onOpenChange={value => { if (!pending) changeOpen(value); }} maxWidth={batchResult ? STUDIO_RESULT_DIALOG_WIDTH : 'sm:max-w-[560px]'} contentClassName={batchResult ? STUDIO_RESULT_DIALOG_CLASS : 'studio-translation-dialog'} onOpenAutoFocus={event => {
      event.preventDefault(); if (!batchResult) document.getElementById(`${controlId}-${profiles.length ? 'model' : 'language'}`)?.focus({ preventScroll: true });
    }} onCloseAutoFocus={event => {
      event.preventDefault();
      if (!mounted.current) return;
      if (recheckSession) {
        onRecheckClosed?.(recheckSession.requestId);
        recheckSession.restoreFocus(); setRecheckSession(undefined);
        return;
      }
      onRequestClosed?.();
      if (handingOffToOverview.current) {
        handingOffToOverview.current = false;
        // The user may already have dismissed the next dialog during this exit.
        if (getStudioTranslationOverviewController().getState().detailsOpen) {
          const nextDialog = document.querySelector<HTMLElement>('.studio-translation-overview-dialog');
          if (nextDialog?.isConnected && nextDialog.getClientRects().length) nextDialog.focus({ preventScroll: true });
        }
        return;
      }
      if (openRequest) openRequest.restoreFocus(); else trigger.current?.focus({ preventScroll: true });
    }}>
      {batchResult ? <StudioOperationResult operation="translation" testId="studio-batch-result" closeButtonId={`${controlId}-close`} onClose={() => changeOpen(false)} items={batchResult.items.map(item => ({ id: item.documentId, name: item.displayName, state: item.ok ? 'success' : 'failed', detail: item.ok ? t('studio:batch.queued') : 'reason' in item && item.reason === 'knowledge_check_failed' ? t('knowledge:batch.not_started') : t(errorKeys[item.error]) }))} primaryAction={batchResult.items.some(item => item.ok) ? { label: t('studio:overview.view_progress'), onClick: () => { handingOffToOverview.current = true; changeOpen(false); getStudioTranslationOverviewController().setDetailsOpen(true); } } : undefined} /> : <>
      <ScrollableDialogHeader className="relative p-3 pr-12">
        <DialogTitle className="flex items-center gap-2 text-base"><Languages className="size-4" />{t(batch ? 'studio:batch.translation' : 'studio:translation.title')}</DialogTitle>
        <DialogDescription className={batch ? 'text-xs' : 'sr-only'}>{batch ? t('studio:batch.document_count', { count: batchDocuments.length }) : page?.summary.origin.displayName}</DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-translation-content" fadeMaskHeight={16}>
        <div className="studio-translation-form">
          {batch && !batchPlan && <StudioSelectedDocuments documents={batchDocuments} />}
          <div className="studio-translation-fields">
            <ToolField label={t('studio:translation.model')} htmlFor={`${controlId}-model`}>
              <Select value={selected?.id ?? ''} onValueChange={value => { setProfileId(value); setRecheckModelApproved(true); }} disabled={pending || !profiles.length}>
                <SelectTrigger id={`${controlId}-model`} data-testid="studio-translation-model" className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder={t('studio:translation.select_model')} /></SelectTrigger>
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
          {recheckSession && <p data-testid="knowledge-recheck-configuration-help" className="text-xs leading-5 text-muted-foreground">{t('knowledge:recovery.form_help')}</p>}
          {!recheckModelMatches && <div className="studio-translation-configuration"><p>{t('knowledge:recovery.model_changed')}</p>{model.success && <Button data-testid="knowledge-recheck-use-current-model" size="sm" variant="outline" disabled={pending} onClick={() => setRecheckModelApproved(true)}>{t('knowledge:recovery.use_current_model')}</Button>}</div>}
          {(!model.success || !selected?.apiKey.trim()) && <div className="studio-translation-configuration">
            <p><AlertCircle className="size-4 shrink-0" />{t('studio:translation.model_required')}</p>
            <Button variant="outline" size="sm" onClick={() => { changeOpen(false); navigate('/setting?tab=model'); }} disabled={pending}><Settings />{t('studio:translation.model_settings')}</Button>
          </div>}
          {!knowledgeEnabled && <ToolField label={t('studio:translation.instructions')} htmlFor={`${controlId}-instructions`}>
            <Textarea id={`${controlId}-instructions`} className="studio-translation-instructions text-xs" value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={4000} disabled={pending} />
          </ToolField>}
          <div className="min-w-0 space-y-2">
            <ToolSwitchRow id={`${controlId}-knowledge`} testId="studio-translation-knowledge-enabled" label={t('knowledge:automatic.enable')} checked={knowledgeEnabled} disabled={pending || !!recheckSession} onCheckedChange={enabled => { setKnowledgeEnabled(enabled); setKnowledgeOpenRequest(0); setPlan(null); setBatchPlan(null); setError(null); }} />
            <p data-testid="studio-translation-knowledge-state" className="text-xs leading-5 text-muted-foreground">{t(knowledgeEnabled ? 'knowledge:selection.help' : 'knowledge:selection.off')}</p>
          </div>
          {knowledgeEnabled && !batch && page && knowledgeConfig && <StudioKnowledgeTrial key={page.summary.id} page={page} config={knowledgeConfig} openRequest={knowledgeOpenRequest} recheckRequest={recheckSession} modelNeedsAttention={needsConfiguration} apiKey={recheckModelMatches ? selected?.apiKey ?? '' : ''} disabled={pending || busy || activeTask || unavailable || !config.success} onAdmissionChange={value => { if (mounted.current) setKnowledgeStarting(value); }} onStarted={taskId => {
            getStudioTranslationOverviewController().trackStarted([taskId]);
            if (mounted.current && currentDocumentId.current === page.summary.id) { changeOpen(false); setPlan(null); onStarted(); }
          }} />}
          {knowledgeEnabled && batch && knowledgeConfig && <StudioKnowledgeBatch documents={batchDocuments.map(item => documents?.find(document => document.id === item.id) ?? item)} config={knowledgeConfig} openRequest={knowledgeOpenRequest} apiKey={selected?.apiKey ?? ''} disabled={pending || busy || unavailable || !config.success} onAdmissionChange={value => { if (mounted.current) setKnowledgeStarting(value); }} onStarted={value => {
            getStudioTranslationOverviewController().trackStarted(value.items.flatMap(item => item.ok ? [item.taskId] : []));
            if (mounted.current) { setBatchResult(value); setBatchPlan(null); setPlan(null); onStarted(); }
          }} />}
          <ToolConfigDisclosure testId="studio-translation-advanced" className="studio-translation-advanced border-b-0" icon={SlidersHorizontal} title={t('studio:translation.advanced')}>
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
          </ToolConfigDisclosure>
          {!needsConfiguration && !config.success && <p className="studio-translation-error" role="alert">{t('studio:translation.invalid_options')}</p>}
          {error && <p className="studio-translation-error" role="alert"><AlertCircle className="size-4" />{t(errorKeys[error])}</p>}
          {!knowledgeEnabled && estimate && <section className="studio-translation-plan" aria-live="polite" data-testid={batchPlan ? 'studio-batch-plan' : undefined}>
            <ToolStatBar columns={3} className="studio-translation-estimate shadow-none" gridClassName="studio-translation-estimate-grid"
              title={batchPlan ? t('studio:batch.ready_count', { count: batchPlan.items.filter(item => item.ok).length, total: batchPlan.items.length }) : t('studio:translation.estimate')}
              icon={batchPlan ? batchPlan.items.some(item => !item.ok) ? <AlertCircle className="text-amber-600 dark:text-amber-400" /> : <CheckCheck className="text-emerald-600 dark:text-emerald-400" /> : <Calculator />}
              items={[
                { label: t('studio:translation.estimated_input'), value: estimate.estimatedInputTokens.toLocaleString(i18n.language) },
                { label: t('studio:translation.batch_count'), value: estimate.batchCount.toLocaleString(i18n.language) },
                { label: t('studio:translation.output_reserve'), value: estimate.outputTokenReserve.toLocaleString(i18n.language) },
              ]} />
            {batchPlan && <>
            <p className="studio-batch-note">{t('studio:batch.translation_queue_note')}</p>
            <details key={batchPlan.batchId} className="studio-translation-plan-details"><summary>{t('studio:operation_result.details')}<ChevronDown aria-hidden="true" /></summary><StudioBatchItems>{batchPlan.items.map(item => <StudioDocumentRow key={item.documentId} data-document-id={item.documentId} data-state={item.ok ? 'ready' : 'failed'} name={item.displayName} status={item.ok ? t('studio:batch.ready') : t(errorKeys[item.error])} />)}</StudioBatchItems></details>
            </>}
          </section>}
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
        <Button id={`${controlId}-close`} variant="ghost" size="sm" onClick={() => changeOpen(false)} disabled={pending}>{t('studio:cancel')}</Button>
        {!knowledgeEnabled && batchPlan && <Button variant="outline" size="sm" disabled={!canPlan} onClick={() => void prepare()}>{t('studio:translation.prepare')}</Button>}
        {knowledgeEnabled && !recheckSession && <Button data-testid="studio-translation-knowledge-open" size="sm" disabled={pending || busy || activeTask || unavailable || !config.success} onClick={() => setKnowledgeOpenRequest(value => value + 1)}><BookOpen />{t('knowledge:selection.open')}</Button>}
        {!knowledgeEnabled && !recheckSession && (currentPlan || batchPlan ? <Button size="sm" disabled={!canPlan || !!batchPlan && !batchPlan.items.some(item => item.ok)} onClick={() => void start()}>{activity === 'start' ? <LoaderCircle className="studio-spin" /> : <Play />}{batchPlan ? t('studio:batch.start_ready', { count: batchPlan.items.filter(item => item.ok).length }) : t('studio:translation.start')}</Button> : <Button size="sm" disabled={!canPlan} onClick={() => void prepare()}>{activity === 'plan' ? <LoaderCircle className="studio-spin" /> : <Calculator />}{t('studio:translation.prepare')}</Button>)}
      </ScrollableDialogFooter>
      </>}
    </ScrollableDialog>
  </>;
}

export function StudioTranslationStatus({ page, trackId, busy = false, onRecheck }: { page: DocumentPage; trackId?: string; busy?: boolean; onRecheck?: (request: AutomaticKnowledgeRecheckRequest) => boolean }) {
  const { t, i18n } = useTranslation();
  const tasks = trackId ? page.tasks.filter(item => item.trackId === trackId) : page.tasks;
  const task = tasks.find(item => item.translation && (item.status === 'queued' || item.status === 'running'))
    ?? [...tasks].reverse().find(item => item.translation);
  const track = page.translationTracks.find(item => item.id === (trackId ?? task?.trackId));
  const hasAutomaticReport = !!track && !!page.automaticKnowledgeReportTrackIds?.includes(track.id);
  const execution = hasAutomaticReport && onRecheck && track
    ? <StudioAutomaticKnowledgeFailure key={`${page.summary.id}:${track.id}`} page={page} taskId={task?.id} trackId={track.id} disabled={busy} onRecheck={onRecheck} />
    : track && hasExecutionRecordEntry(track) ? <StudioExecutionRecord key={`${page.summary.id}:${track.id}`} page={page} track={track} /> : null;
  if (!task?.translation) return execution ? <div className="studio-translation-status">{execution}</div> : null;
  const running = task.status === 'queued' || task.status === 'running';
  const failed = task.status === 'failed' || task.status === 'interrupted' || task.status === 'needs_configuration';
  const count = (value: number | null) => value === null ? t('studio:translation.unknown_usage') : value.toLocaleString(i18n.language);
  return <div className="studio-translation-status" role="status" data-state={task.status}>
    <span className={failed ? 'text-destructive' : ''}>{running ? <LoaderCircle className="size-3.5 studio-spin" /> : failed ? <AlertCircle className="size-3.5" /> : <CheckCheck className="size-3.5" />}{t(statusKeys[task.status])}</span>
    <span>{t('studio:translation.batch_progress', { completed: task.completedBatchIds.length, total: task.translation.totalBatches })}</span>
    <span>{t('studio:translation.actual_usage', { input: count(task.translation.usage.inputTokens), output: count(task.translation.usage.outputTokens) })}</span>
    {(task.translation.uncertainAttempts ?? task.uncertainBatchIds.length) > 0 && <span>{t('studio:translation.uncertain_usage', { count: task.translation.uncertainAttempts ?? task.uncertainBatchIds.length })}</span>}
    {task.translation.error && <span className="text-destructive">{t(errorKeys[task.translation.error])}</span>}
    {execution}
  </div>;
}
