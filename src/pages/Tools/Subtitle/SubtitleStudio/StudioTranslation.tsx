import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Calculator, CheckCheck, FileText, Files, Languages, LoaderCircle, Play, Settings, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { ToolField } from '../../_shared/ui/ToolField';
import { StudioDisclosure } from './StudioDisclosure';
import useModelStore from '@/store/useModelStore';
import { getStudioTranslationOverviewController } from '@/services/subtitle-studio/translation-overview-controller';
import { StudioError, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { StudioFileName, StudioIconButton } from './StudioControls';
import { StudioTranslationSettings } from './StudioTranslationSettings';
import { StudioTranslationReview } from './StudioTranslationReview';
import { StudioSelectedDocuments } from './StudioSelectedDocuments';
import { STUDIO_RESULT_DIALOG_CLASS, STUDIO_RESULT_DIALOG_WIDTH, StudioOperationResult } from './StudioOperationResult';
import { normalizeTranslationModel, translationConfigSchema, translationModelSchema, type TranslationConfig } from '@/subtitle-studio/translation-contract';
import { STUDIO_BATCH_LIMIT, type TranslationBatchResult } from '@/subtitle-studio/batch-contract';
import './StudioTranslation.css';
import './StudioBatch.css';
import { StudioKnowledgeScope } from './StudioKnowledgeTrial';
import { StudioExecutionRecord, hasExecutionRecordEntry } from './StudioExecutionRecord';
import { StudioAutomaticKnowledgeFailure } from './StudioAutomaticKnowledgeFailure';
import type { AutomaticKnowledgeRecheckRequest } from './automatic-knowledge-recheck';

import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { KnowledgeTrialResult } from '@/subtitle-studio/knowledge-trial-contract';
import { QuickTermDialog } from '@/pages/TranslationKnowledge/QuickTermDialog';
import { StudioMaterialsFields, materialProblem } from './StudioMaterialsFields';
import { emptySelection, hasMaterials, knowledgeTarget, reusableTranslationDraft, translationDraftMemory, type TranslationDraft } from '@/services/subtitle-studio/translation-draft';
import { TranslationSession, readyCount, partialCheck, type TranslationCheck, type TranslationSessionInput } from '@/services/subtitle-studio/translation-session';
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
  const batch = documents !== undefined;
  const defaultDraft = (): TranslationDraft => {
    const language = i18n.resolvedLanguage && i18n.resolvedLanguage in languageKeys ? i18n.resolvedLanguage : 'zh';
    return { profileId: assignment ?? profiles[0]?.id ?? '', language, instructions: '', contextWindow: '32768', maxOutputTokens: '4096', maxBatchCues: '32', selection: emptySelection(language), documentTopicIds: [], cueIds: [] };
  };
  const [draft, setDraft] = useState<TranslationDraft>(() => page ? translationDraftMemory.read(page.summary.id, page.summary.revision) ?? defaultDraft() : defaultDraft());
  const [open, setOpen] = useState(false), [batchDocuments, setBatchDocuments] = useState<DocumentSummary[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false), [reviewPurpose, setReviewPurpose] = useState<'check' | 'trial'>('check');
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null), [libraryLoading, setLibraryLoading] = useState(false);
  const [check, setCheck] = useState<TranslationCheck | null>(null), [trialResult, setTrialResult] = useState<KnowledgeTrialResult | null>(null);
  const [batchResult, setBatchResult] = useState<TranslationBatchResult | null>(null);
  const [activity, setActivity] = useState<'check' | 'start' | 'trial' | 'save' | null>(null), [error, setError] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState(''), [recipeName, setRecipeName] = useState(''), [savingRecipe, setSavingRecipe] = useState(false);
  const [quickTermOpen, setQuickTermOpen] = useState(false), [addedCollection, setAddedCollection] = useState<string | null>(null);
  const [recheckSession, setRecheckSession] = useState<AutomaticKnowledgeRecheckRequest>();
  const [modelApproved, setModelApproved] = useState(false);
  const mounted = useRef(true), operation = useRef(false), opened = useRef(false), revision = useRef(0), libraryReadEpoch = useRef(0);
  const trialCancelled = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null), handingOffToOverview = useRef(false);
  const session = useMemo(() => new TranslationSession(window.subtitleStudio), []);
  const documentOwner = useRef([page?.summary.id, page?.summary.revision] as const);
  const selected = profiles.find(profile => profile.id === draft.profileId);
  const model = useMemo(() => translationModelSchema.safeParse(selected ? { profileId: selected.id, modelKey: selected.modelKey, endpoint: selected.baseUrl, apiFormat: selected.apiFormat, outputTokenParameter: selected.outputTokenParameter } : null), [selected]);
  const config = useMemo(() => translationConfigSchema.safeParse({ model: model.success ? model.data : recheckSession?.seed.config.model,
    language: draft.language, instructions: draft.instructions, contextWindow: Number(draft.contextWindow), maxOutputTokens: Number(draft.maxOutputTokens), maxBatchCues: Number(draft.maxBatchCues) }), [draft, model, recheckSession]);
  const selection = { ...draft.selection, languagePair: { ...draft.selection.languagePair, target: knowledgeTarget(draft.language) } };
  const usingMaterials = hasMaterials(selection);
  const targets = batch ? batchDocuments.map(item => documents?.find(document => document.id === item.id) ?? item) : page ? [page.summary] : [];
  const identity = JSON.stringify([targets.map(item => [item.id, item.revision]), draft, config.success ? config.data : null, selected?.apiKey, usingMaterials ? library?.generation : null]);
  const checkedIdentity = useRef('');
  const currentCheck = checkedIdentity.current === identity ? check : null;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const currentDocumentId = useRef(page?.summary.id); currentDocumentId.current = page?.summary.id;
  const pending = activity !== null;
  const activeTask = page?.tasks.some(task => task.status === 'queued' || task.status === 'running') ?? false;
  const unavailable = batch ? !targets.length || targets.length > (usingMaterials ? 20 : STUDIO_BATCH_LIMIT) : !page?.summary.capabilities.translate || page.summary.cueCount === 0;
  const modelMatches = !recheckSession || modelApproved || model.success && JSON.stringify(normalizeTranslationModel(model.data)) === JSON.stringify(normalizeTranslationModel(recheckSession.seed.config.model));
  const needsConfiguration = !model.success || !selected?.apiKey.trim() || !modelMatches;
  const materialError = materialProblem(selection, library, draft.documentTopicIds);
  const canAct = !busy && !pending && !activeTask && !unavailable && !needsConfiguration && config.success && (!usingMaterials || !libraryLoading && !materialError);
  const lastDraft = translationDraftMemory.last();
  const invalidate = () => { revision.current++; session.invalidate(); setCheck(null); setTrialResult(null); setError(null); };
  const changeDraft = (next: TranslationDraft) => {
    if (operation.current) return;
    invalidate(); setNotice(''); setDraft(next);
    translationDraftMemory.remember(documentOwner.current[0], documentOwner.current[1], next, false);
  };
  const patch = (value: Partial<TranslationDraft>) => changeDraft({ ...draft, ...value });
  const changeSelection = (value: TranslationDraft['selection']) => changeDraft({ ...draft, selection: value,
    documentTopicIds: hasMaterials(value) ? draft.documentTopicIds : [],
    instructions: value.instructions !== undefined ? value.instructions : draft.instructions });
  const readLibrary = async () => {
    const result = await window.translationKnowledge.read();
    if (!result.ok) throw new StudioError('knowledge_check_failed');
    return result.value;
  };
  const refreshLibrary = async () => {
    if (operation.current) return;
    invalidate(); setLibraryLoading(true);
    const token = ++libraryReadEpoch.current;
    try {
      const snapshot = await readLibrary();
      if (!mounted.current || token !== libraryReadEpoch.current) return;
      if (library && library.generation !== snapshot.generation) {
        setDraft(value => ({ ...value, selection: { ...value.selection, confirmations: [] } }));
        setNotice(t('knowledge:trial.materials_changed'));
      }
      setLibrary(snapshot);
    } catch { if (mounted.current && token === libraryReadEpoch.current) { setLibrary(null); setError('knowledge_check_failed'); } }
    finally { if (mounted.current && token === libraryReadEpoch.current) setLibraryLoading(false); }
  };
  const close = () => {
    if (operation.current && activity === 'trial') {
      revision.current++; libraryReadEpoch.current++; opened.current = false; setOpen(false); setCheck(null); setReviewOpen(false);
      void session.cancelTrial();
      return;
    }
    if (operation.current) return;
    invalidate(); libraryReadEpoch.current++; opened.current = false; setOpen(false); setQuickTermOpen(false); setReviewOpen(false);
    translationDraftMemory.remember(documentOwner.current[0], documentOwner.current[1], draft);
  };
  const begin = () => {
    if (operation.current) return;
    handingOffToOverview.current = false; opened.current = true; setOpen(true); setBatchDocuments(documents ? [...documents] : []);
    setBatchResult(null); setError(null); setNotice(''); setCheck(null); setTrialResult(null); setReviewOpen(false);
    void refreshLibrary();
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; opened.current = false; revision.current++; session.dispose(); }; }, [session]);
  useEffect(() => {
    if (!draft.profileId && profiles.length) setDraft(value => ({ ...value, profileId: assignment ?? profiles[0].id }));
  }, [assignment, profiles, draft.profileId]);
  useEffect(() => {
    const previous = documentOwner.current;
    if (previous[0] === page?.summary.id && previous[1] === page?.summary.revision) return;
    if (operation.current) return;
    documentOwner.current = [page?.summary.id, page?.summary.revision];
    invalidate();
    if (previous[0] !== page?.summary.id) {
      opened.current = false; setOpen(false); setRecheckSession(undefined); setReviewOpen(false);
      setDraft(page ? translationDraftMemory.read(page.summary.id, page.summary.revision) ?? defaultDraft() : defaultDraft());
    } else {
      setDraft(value => reusableTranslationDraft(value));
      setNotice(t('studio:materials.source_changed'));
    }
  }, [page?.summary.id, page?.summary.revision, pending]);
  const consumedRequest = useRef(openRequest);
  useEffect(() => { if (openRequest && consumedRequest.current !== openRequest) { consumedRequest.current = openRequest; begin(); } }, [openRequest]);
  const consumedRecheck = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!recheckRequest || consumedRecheck.current === recheckRequest.requestId || batch || recheckRequest.documentId !== page?.summary.id || open || operation.current) return;
    consumedRecheck.current = recheckRequest.requestId;
    const seed = recheckRequest.seed;
    setDraft({ profileId: seed.config.model.profileId, language: seed.config.language, instructions: seed.selection.instructions ?? seed.config.instructions,
      contextWindow: String(seed.config.contextWindow), maxOutputTokens: String(seed.config.maxOutputTokens), maxBatchCues: String(seed.config.maxBatchCues),
      selection: { ...structuredClone(seed.selection), bindings: [], confirmations: [] }, documentTopicIds: [...seed.documentTopicIds], cueIds: [] });
    setRecheckSession(recheckRequest); setModelApproved(false); begin();
  }, [recheckRequest, page?.summary.id, open]);

  const cancelTrial = () => {
    trialCancelled.current = true;
    setCheck(null);
    if (activity === 'check') { revision.current++; session.invalidate(); }
    void session.cancelTrial();
  };
  const closeReview = () => {
    setReviewOpen(false);
    if (reviewPurpose === 'trial' && operation.current) cancelTrial();
  };
  const showReview = (purpose: 'check' | 'trial') => {
    if (!reviewOpen) reviewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReviewPurpose(purpose); setReviewOpen(true);
  };
  const execute = async (intent: 'check' | 'trial-check' | 'start' | 'trial', useCheckedPlan = false) => {
    if (!canAct || operation.current || !config.success || !selected || (intent === 'trial' || intent === 'trial-check') && (!usingMaterials || batch)) return;
    trialCancelled.current = false;
    if (intent !== 'start') showReview(intent === 'check' ? 'check' : 'trial');
    const requestIdentity = identity, token = revision.current;
    const input: TranslationSessionInput = { documents: targets.map(item => ({ documentId: item.id, revision: item.revision })), batch, config: config.data,
      ...(usingMaterials ? { knowledge: { ...structuredClone(selection), instructions: draft.instructions }, generation: library!.generation } : {}), documentTopicIds: [...draft.documentTopicIds], cueIds: [...(draft.cueIds.length ? draft.cueIds : page?.cues.filter(cue => /\S/u.test(cue.source.plain)).slice(0, 20).map(cue => cue.id) ?? [])] };
    const isCurrent = () => mounted.current && opened.current && token === revision.current && currentIdentity.current === requestIdentity;
    operation.current = true; setActivity(intent === 'trial' ? 'trial' : 'check'); setError(null); setNotice(''); setTrialResult(null);
    try {
      const checked = useCheckedPlan && currentCheck ? currentCheck : await session.check(input, intent === 'trial' || intent === 'trial-check');
      if (!checked || !isCurrent()) return;
      if (intent === 'trial' && trialCancelled.current) return;
      checkedIdentity.current = requestIdentity; setCheck(checked);
      if (intent === 'check' || intent === 'trial-check') return;
      if (!readyCount(checked)) { if (intent === 'start') showReview('check'); return; }
      if (partialCheck(checked) && !useCheckedPlan) { setNotice(t('studio:materials.partial')); showReview('check'); return; }
      setActivity(intent === 'trial' ? 'trial' : 'start');
      const result = await session.submit(checked, input, selected.apiKey, readLibrary, () => isCurrent() && !(intent === 'trial' && trialCancelled.current));
      if (!result) return;
      if (result.kind === 'trial') { if (isCurrent()) { setTrialResult(result.value); setCheck(null); } return; }
      // An admitted task belongs to the overview even after a source update/unmount.
      getStudioTranslationOverviewController().trackStarted(result.kind === 'single' ? [result.taskId] : result.value.items.flatMap(item => item.ok ? [item.taskId] : []));
      onStarted();
      translationDraftMemory.remember(input.batch ? undefined : input.documents[0].documentId, input.batch ? undefined : input.documents[0].revision, draft);
      if (mounted.current) {
        setCheck(null); setReviewOpen(false);
        if (result.kind === 'batch') setBatchResult(result.value);
        else if (currentDocumentId.current === input.documents[0].documentId) { opened.current = false; setOpen(false); }
      }
    } catch (failure) {
      if (mounted.current && token === revision.current && !(intent === 'trial' && trialCancelled.current)) {
        const code = failure instanceof StudioError ? failure.code : 'translation_failed';
        setCheck(null); setError(code);
        if (intent === 'start' && !reviewOpen) onError(code);
        if (code === 'revision_conflict' && usingMaterials) {
          const updated = await readLibrary().catch(() => null);
          if (mounted.current && updated) { setNotice(t('knowledge:trial.materials_changed')); setLibrary(updated); setDraft(value => ({ ...value, selection: { ...value.selection, confirmations: [] } })); }
        }
      }
    } finally { operation.current = false; if (!opened.current) session.invalidate(); if (mounted.current) setActivity(null); }
  };
  const saveRecipe = async () => {
    if (!library || !recipeName.trim() || !usingMaterials || materialError || operation.current) return;
    operation.current = true; setActivity('save'); setError(null);
    const selectedRecipe = library.data.recipes.find(item => item.id === selection.recipeId);
    const collectionIds = [...new Set([...selection.collectionIds, ...selectedRecipe?.readCollectionIds ?? []])];
    try {
      const result = await window.translationKnowledge.saveRecord({ generation: library.generation, group: 'recipes', record: {
        id: crypto.randomUUID(), revision: 1, archived: false, name: recipeName.trim(), description: '', languagePair: selection.languagePair,
        readCollectionIds: collectionIds, subjectSuggestions: [], modifierStyleIds: selectedRecipe?.modifierStyleIds ?? [],
        ...(selectedRecipe?.baseStyleId ? { baseStyleId: selectedRecipe.baseStyleId } : {}), instructions: draft.instructions, context: selection.context ?? selectedRecipe?.context ?? '', inheritGlobalPreferences: false, learningSuggestion: 'off',
      } });
      if (!result.ok) throw new StudioError(result.error === 'revision_conflict' ? 'revision_conflict' : 'knowledge_check_failed');
      if (mounted.current) { invalidate(); setLibrary(result.value); setSavingRecipe(false); setRecipeName(''); setNotice(t('studio:materials.saved')); }
    } catch (failure) { if (mounted.current) setError(failure instanceof StudioError ? failure.code : 'knowledge_check_failed'); }
    finally { operation.current = false; if (mounted.current) setActivity(null); }
  };
  const partialReady = !!currentCheck && partialCheck(currentCheck) && readyCount(currentCheck) > 0;
  const triggerControl = <StudioIconButton ref={trigger} label={t(batch ? 'studio:batch.translation' : 'studio:translation.action')} disabled={busy || activeTask || (!batch && !page?.summary.capabilities.translate) || pending} onClick={begin}><Languages /></StudioIconButton>;
  const fixedLanguages = Object.keys(languageKeys);
  const languageChoice = fixedLanguages.includes(draft.language) ? draft.language : 'custom';

  return <>
    {triggerContainer === null ? null : triggerContainer ? createPortal(triggerControl, triggerContainer) : triggerControl}
    <ScrollableDialog animateSize transitionKey={batchResult ? 'result' : 'configuration'} open={open} onOpenChange={value => { if (!value) close(); }} maxWidth={batchResult ? STUDIO_RESULT_DIALOG_WIDTH : 'sm:max-w-[720px]'} contentClassName={batchResult ? STUDIO_RESULT_DIALOG_CLASS : 'studio-translation-dialog'} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById(`${controlId}-model`)?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => {
      event.preventDefault(); if (!mounted.current) return;
      if (recheckSession) { onRecheckClosed?.(recheckSession.requestId); recheckSession.restoreFocus(); setRecheckSession(undefined); return; }
      onRequestClosed?.();
      if (handingOffToOverview.current) { handingOffToOverview.current = false; document.querySelector<HTMLElement>('.studio-translation-overview-dialog')?.focus({ preventScroll: true }); return; }
      if (openRequest) openRequest.restoreFocus(); else trigger.current?.focus({ preventScroll: true });
    }}>
      {batchResult ? <StudioOperationResult operation="translation" testId="studio-batch-result" closeButtonId={`${controlId}-close`} onClose={close} items={batchResult.items.map(item => ({ id: item.documentId, name: item.displayName, state: item.ok ? 'success' : 'failed', detail: item.ok ? t('studio:batch.queued') : t(errorKeys[item.error]) }))} primaryAction={batchResult.items.some(item => item.ok) ? { label: t('studio:overview.view_progress'), onClick: () => { handingOffToOverview.current = true; close(); getStudioTranslationOverviewController().setDetailsOpen(true); } } : undefined} /> : <>
        <ScrollableDialogHeader className="studio-translation-compact-header">
          <div data-testid="studio-translation-header">
            <DialogTitle className="flex min-h-7 items-center gap-2 text-sm leading-6"><Languages className="size-4 shrink-0" />{t(batch ? 'studio:batch.translation' : 'studio:translation.title')}</DialogTitle>
            <DialogDescription className="sr-only">{batch ? t('studio:batch.document_count', { count: targets.length }) : page?.summary.origin.displayName}</DialogDescription>
          </div>
        </ScrollableDialogHeader>
        <ScrollableDialogContent className="studio-translation-content" fadeMaskHeight={16}><div className="studio-translation-form" data-testid="studio-translation-form">
          <div className="studio-translation-context" data-testid="studio-translation-context">
            <div className="studio-translation-source">{batch ? <><Files aria-hidden="true" /><span>{t('studio:batch.document_count', { count: targets.length })}</span></> : <><FileText aria-hidden="true" /><StudioFileName name={page?.summary.origin.displayName ?? ''} focusable /></>}</div>
            <StudioTranslationSettings previous={lastDraft}
              previousModel={profiles.find(profile => profile.id === lastDraft?.profileId)?.name || profiles.find(profile => profile.id === lastDraft?.profileId)?.modelKey || t('studio:translation.select_model')}
              previousLanguage={lastDraft?.language && lastDraft.language in languageKeys ? t(languageKeys[lastDraft.language as keyof typeof languageKeys]) : lastDraft?.language ?? ''}
              library={library} disabled={pending} canSave={usingMaterials && !materialError && !libraryLoading}
              saving={savingRecipe} name={recipeName} error={error ? t(errorKeys[error]) : undefined}
              onNameChange={setRecipeName} onSavingChange={setSavingRecipe} onSave={() => void saveRecipe()}
              onReuse={() => { if (lastDraft) { changeDraft(reusableTranslationDraft(lastDraft)); setNotice(t('studio:materials.reused')); } }} />
          </div>
          {batch && <StudioSelectedDocuments documents={targets} />}
          <div><div className="studio-translation-fields">
            <ToolField label={t('studio:translation.model')} htmlFor={`${controlId}-model`}><Select value={selected?.id ?? ''} disabled={pending || !profiles.length} onValueChange={profileId => { patch({ profileId }); setModelApproved(true); }}><SelectTrigger id={`${controlId}-model`} data-testid="studio-translation-model" className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder={t('studio:translation.select_model')} /></SelectTrigger><SelectContent>{profiles.map(profile => <SelectItem key={profile.id} value={profile.id}>{profile.name || profile.modelKey}</SelectItem>)}</SelectContent></Select></ToolField>
            <ToolField label={t('studio:translation.language')} htmlFor={`${controlId}-language`}><Select value={languageChoice} disabled={pending} onValueChange={value => patch({ language: value === 'custom' ? '' : value })}><SelectTrigger id={`${controlId}-language`} data-testid="studio-translation-language" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger><SelectContent>{(Object.keys(languageKeys) as (keyof typeof languageKeys)[]).map(value => <SelectItem key={value} value={value}>{t(languageKeys[value])}</SelectItem>)}<SelectItem value="custom">{t('studio:translation.custom_language')}</SelectItem></SelectContent></Select></ToolField>
          </div>
          <DialogTransition transitionKey="custom-language" stageClassName="pt-3">{languageChoice === 'custom' && <ToolField label={t('studio:translation.custom_language_name')} htmlFor={`${controlId}-custom-language`}><Input id={`${controlId}-custom-language`} className="h-8 text-xs" value={draft.language} maxLength={100} disabled={pending} onChange={event => patch({ language: event.target.value })} /></ToolField>}</DialogTransition>
          <DialogTransition transitionKey="model-required" stageClassName="pt-3">{(!model.success || !selected?.apiKey.trim()) && <div className="studio-translation-configuration"><p><AlertCircle className="size-4 shrink-0" />{t('studio:translation.model_required')}</p><Button variant="outline" size="sm" disabled={pending} onClick={() => { close(); navigate('/setting?tab=model'); }}><Settings />{t('studio:translation.model_settings')}</Button></div>}</DialogTransition>
          <DialogTransition transitionKey="model-changed" stageClassName="pt-3">{!modelMatches && <div className="studio-translation-configuration"><p>{t('knowledge:recovery.model_changed')}</p><Button data-testid="knowledge-recheck-use-current-model" size="sm" variant="outline" disabled={pending || !model.success} onClick={() => setModelApproved(true)}>{t('knowledge:recovery.use_current_model')}</Button></div>}</DialogTransition>
          <DialogTransition transitionKey="recheck-help" stageClassName="pt-3">{recheckSession && <p data-testid="knowledge-recheck-configuration-help" className="text-xs leading-5 text-muted-foreground">{t('knowledge:recovery.form_help')}</p>}</DialogTransition></div>
          <div>
          <StudioMaterialsFields value={selection} library={library} disabled={pending} loading={libraryLoading} onChange={changeSelection} topics={draft.documentTopicIds} onTopicsChange={documentTopicIds => patch({ documentTopicIds })} onRefresh={() => void refreshLibrary()} onAddTerm={() => setQuickTermOpen(true)} mode={batch ? 'batch' : 'single'} />
          <DialogTransition transitionKey="added-collection" stageClassName="pt-3">{addedCollection && <div data-testid="studio-materials-added" className="flex flex-wrap items-center gap-2 text-xs"><span>{t('studio:materials.added')}</span><Button data-testid="studio-materials-use-added" variant="outline" size="sm" disabled={pending} onClick={() => { changeSelection({ ...selection, collectionIds: [...new Set([...selection.collectionIds, addedCollection])] }); setAddedCollection(null); }}>{t('studio:materials.use_added')}</Button></div>}</DialogTransition></div>
          <div>
          <ToolField label={t('studio:translation.instructions')} htmlFor={`${controlId}-instructions`}><Textarea id={`${controlId}-instructions`} data-testid="studio-translation-instructions" className="studio-translation-instructions text-xs" value={draft.instructions} maxLength={4000} disabled={pending} onChange={event => patch({ instructions: event.target.value, selection: { ...draft.selection, instructions: event.target.value } })} /></ToolField>
          <DialogTransition transitionKey="knowledge-scope" stageClassName="pt-3">{usingMaterials && !batch && page && <StudioKnowledgeScope page={page} selection={selection} library={library} cueIds={draft.cueIds} disabled={pending} onChange={changeSelection} onCueIdsChange={cueIds => patch({ cueIds })} onCheck={() => void execute('trial-check')} canCheck={canAct} />}</DialogTransition></div>
          <div>
          <div>
          <StudioDisclosure triggerTestId="studio-translation-advanced" className="studio-translation-advanced -mx-3 border-y border-b-0" contentClassName="space-y-3 px-3 pb-3 pt-2" title={<span className="flex min-w-0 items-center gap-2"><SlidersHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{t('studio:translation.advanced')}</span>}><div className="studio-translation-budget-fields">{(['contextWindow', 'maxOutputTokens', 'maxBatchCues'] as const).map((key, index) => <ToolField key={key} label={t(index === 0 ? 'studio:translation.context_window' : index === 1 ? 'studio:translation.max_output' : 'studio:translation.batch_cues')} htmlFor={`${controlId}-${key}`}><Input id={`${controlId}-${key}`} type="number" className="h-8 font-mono text-xs" value={draft[key]} disabled={pending} onChange={event => patch({ [key]: event.target.value })} /></ToolField>)}</div></StudioDisclosure>
          </div>
          <DialogTransition transitionKey={`${!needsConfiguration && !config.success}:${unavailable && batch && usingMaterials && targets.length > 20}:${notice}:${!reviewOpen && error}`} stageClassName="space-y-3 pt-6">
            {!needsConfiguration && !config.success && <p role="alert" className="studio-translation-error">{t('studio:translation.invalid_options')}</p>}
            {unavailable && batch && usingMaterials && targets.length > 20 && <p role="alert" className="studio-translation-error">{t('knowledge:batch.limit', { count: targets.length, max: 20 })}</p>}
            {notice && <p role="status" data-testid="studio-translation-notice" className="text-xs leading-5 text-muted-foreground">{notice}</p>}
            {error && !reviewOpen && <p role="alert" className="studio-translation-error"><AlertCircle className="size-4" />{t(errorKeys[error])}</p>}
          </DialogTransition></div>

        </div></ScrollableDialogContent>
        <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3">
          <Button data-testid="studio-translation-close" variant="ghost" size="sm" disabled={pending && activity !== 'trial'} onClick={close}>{t('studio:cancel')}</Button>
          {activity === 'trial' ? <Button data-testid="studio-translation-cancel-trial" variant="outline" size="sm" onClick={cancelTrial}><LoaderCircle className="animate-spin" />{t('knowledge:trial.cancel')}</Button> : <>
            <Button data-testid="studio-translation-check" variant="outline" size="sm" disabled={!canAct} onClick={() => void execute('check')}>{activity === 'check' ? <LoaderCircle className="animate-spin" /> : <Calculator />}{t('studio:materials.check')}</Button>
            {usingMaterials && !batch && <Button data-testid="studio-translation-trial" variant="outline" size="sm" disabled={trialResult ? pending : !canAct} onClick={() => { if (trialResult) showReview('trial'); else void execute('trial'); }}>{t(trialResult ? 'studio:materials.review_trial_result' : 'studio:materials.trial')}</Button>}
            <Button data-testid="studio-translation-start" size="sm" disabled={!canAct} onClick={() => void execute('start', partialReady)}>{pending ? <LoaderCircle className="animate-spin" /> : <Play />}{partialReady ? t('studio:batch.start_ready', { count: readyCount(currentCheck!) }) : t('studio:translation.start')}</Button>
          </>}
        </ScrollableDialogFooter>
      </>}
    </ScrollableDialog>
    <StudioTranslationReview open={open && reviewOpen && !batchResult} purpose={reviewPurpose} activity={activity} check={currentCheck} result={trialResult}
      library={library} page={page} error={error} errorLabel={code => t(errorKeys[code])} notice={notice} canAct={canAct}
      onClose={closeReview} onRestoreFocus={() => {
        if (!opened.current || !mounted.current || batchResult) return;
        const target = reviewTrigger.current;
        if (target?.isConnected && !target.matches(':disabled')) target.focus({ preventScroll: true });
        else document.querySelector<HTMLElement>('.studio-translation-dialog')?.focus({ preventScroll: true });
      }}
      onRetry={() => void execute(reviewPurpose === 'trial' ? 'trial-check' : 'check')}
      onStart={() => void execute(currentCheck?.kind === 'trial' ? 'trial' : 'start', true)}
      onRerunTrial={() => void execute('trial')} onCancelTrial={cancelTrial} />
    <QuickTermDialog open={quickTermOpen} onOpenChange={setQuickTermOpen} initialLanguagePair={selection.languagePair.source ? selection.languagePair : undefined} preferredCollectionId={selection.collectionIds.length === 1 ? selection.collectionIds[0] : undefined} onSaved={(snapshot, collectionId) => { invalidate(); setLibrary(snapshot); setAddedCollection(collectionId); }} />
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
