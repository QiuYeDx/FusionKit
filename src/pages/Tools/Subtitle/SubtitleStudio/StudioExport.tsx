import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowDownToLine, CheckCheck, ChevronDown, ClipboardCheck, FileCog, FolderOpen, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import { ToolConfigDisclosure } from '../../_shared/ui/ToolConfigDisclosure';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { encodingSchema, StudioError, type Encoding, type ErrorCode } from '@/subtitle-studio/domain';
import { exportOptionsSchema, fileNameSuffixSchema, type ExportDestination, type SourceLocationSummary, type ExportIssue, type ExportIssueCode, type ExportOptions, type ExportPlanSummary } from '@/subtitle-studio/export-contract';
import { subtitleExportFileName } from '@/subtitle-studio/export-filename';
import type { DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { STUDIO_BATCH_LIMIT, type ExportBatchPlan, type ExportBatchResult, type SourceBatchResult } from '@/subtitle-studio/batch-contract';
import { StudioPlanDocuments } from './StudioPlanDocuments';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';
import { StudioIconButton } from './StudioControls';
import { StudioOperationResult, type StudioOperationResultItem } from './StudioOperationResult';
import './StudioExport.css';
import './StudioBatch.css';

const modeKeys = { source: 'studio:export.source', target: 'studio:export.target', bilingual: 'studio:export.bilingual' } as const;
const issueKeys = {
  track_missing: 'studio:export.issues.track_missing',
  translation_missing: 'studio:export.issues.translation_missing',
  translation_stale: 'studio:export.issues.translation_stale',
  missing_end: 'studio:export.issues.missing_end',
  estimated_end: 'studio:export.issues.estimated_end',
  end_times_omitted: 'studio:export.issues.end_times_omitted',
  invalid_time: 'studio:export.issues.invalid_time',
  styles_removed: 'studio:export.issues.styles_removed',
  line_breaks_flattened: 'studio:export.issues.line_breaks_flattened',
  metadata_omitted: 'studio:export.issues.metadata_omitted',
  transcription_evidence_omitted: 'studio:export.issues.transcription_evidence_omitted',
  unsupported_text: 'studio:export.issues.unsupported_text',
  empty_output: 'studio:export.issues.empty_output',
  encoding_unrepresentable: 'studio:export.issues.encoding_unrepresentable',
  skipped_cues: 'studio:export.issues.skipped_cues',
  source_fallback: 'studio:export.issues.source_fallback',
  timing_precision_changed: 'studio:export.issues.timing_precision_changed', positioning_omitted: 'studio:export.issues.positioning_omitted',
  effects_omitted: 'studio:export.issues.effects_omitted', opaque_omitted: 'studio:export.issues.opaque_omitted',
  encoding_not_supported: 'studio:export.issues.encoding_not_supported',
} as const satisfies Record<ExportIssueCode, string>;
const changeKeys = {
  track_missing: 'studio:export.change_types.track_missing',
  translation_missing: 'studio:export.change_types.translation_missing',
  translation_stale: 'studio:export.change_types.translation_stale',
  missing_end: 'studio:export.change_types.missing_end',
  estimated_end: 'studio:export.change_types.estimated_end',
  end_times_omitted: 'studio:export.change_types.end_times_omitted',
  invalid_time: 'studio:export.change_types.invalid_time',
  styles_removed: 'studio:export.change_types.styles_removed',
  line_breaks_flattened: 'studio:export.change_types.line_breaks_flattened',
  metadata_omitted: 'studio:export.change_types.metadata_omitted',
  transcription_evidence_omitted: 'studio:export.change_types.transcription_evidence_omitted',
  unsupported_text: 'studio:export.change_types.unsupported_text',
  empty_output: 'studio:export.change_types.empty_output',
  encoding_unrepresentable: 'studio:export.change_types.encoding_unrepresentable',
  skipped_cues: 'studio:export.change_types.skipped_cues',
  source_fallback: 'studio:export.change_types.source_fallback',
  timing_precision_changed: 'studio:export.change_types.timing_precision_changed',
  positioning_omitted: 'studio:export.change_types.positioning_omitted',
  effects_omitted: 'studio:export.change_types.effects_omitted',
  opaque_omitted: 'studio:export.change_types.opaque_omitted',
  encoding_not_supported: 'studio:export.change_types.encoding_not_supported',
} as const satisfies Record<ExportIssueCode, string>;
const errorKeys = {
  invalid_input: 'studio:errors.invalid_input', unsupported_feature: 'studio:errors.unsupported_feature',
  encoding_required: 'studio:errors.encoding_required', limit_exceeded: 'studio:errors.limit_exceeded',
  revision_conflict: 'studio:errors.revision_conflict', access_denied: 'studio:errors.access_denied',
  document_unavailable: 'studio:errors.document_unavailable', output_write_failed: 'studio:errors.output_write_failed',
  needs_configuration: 'studio:errors.needs_configuration', translation_protocol_invalid: 'studio:errors.translation_protocol_invalid',
  translation_output_limit: 'studio:errors.translation_output_limit', translation_failed: 'studio:errors.translation_failed',
  transcription_failed: 'studio:errors.transcription_failed', resource_busy: 'studio:errors.resource_busy',
  interrupted: 'studio:errors.interrupted',
} as const satisfies Record<ErrorCode, string>;

type StudioExportProps = {
  page?: DocumentPage;
  documents?: DocumentSummary[];
  triggerContainer?: HTMLElement | null;
  trackId?: string;
  busy: boolean;
  onExported: (fileName: string) => void;
  onError: (error: ErrorCode) => void;
};

export function StudioBatchExport(props: Omit<StudioExportProps, 'page' | 'documents' | 'trackId'> & { documents: DocumentSummary[] }) {
  return <StudioExport {...props} />;
}

export function StudioExport({ page, documents, triggerContainer, trackId, busy, onExported, onError }: StudioExportProps) {
  const { t, i18n } = useTranslation();
  const controlId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const [open, setOpen] = useState(false);
  const batch = documents !== undefined;
  const [batchDocuments, setBatchDocuments] = useState<DocumentSummary[]>([]);
  const [batchTracks, setBatchTracks] = useState<Record<string, string>>({});
  const [batchPlan, setBatchPlan] = useState<ExportBatchPlan | null>(null);
  const [step, setStep] = useState<'settings' | 'review' | 'result'>('settings');
  const [resultItems, setResultItems] = useState<StudioOperationResultItem[] | null>(null);
  const [reviewDetailsOpen, setReviewDetailsOpen] = useState(false);
  const stepTitle = useRef<HTMLHeadingElement>(null);
  const [sourceMode, setSourceMode] = useState(false);
  const [destination, setDestination] = useState<ExportDestination>('source-directory');
  const [suffixMode, setSuffixMode] = useState<'none' | 'content-mode' | 'target-language' | 'custom'>('none');
  const [customSuffix, setCustomSuffix] = useState('');
  const [sourceLocations, setSourceLocations] = useState<Record<string, SourceLocationSummary>>({});
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [rebinding, setRebinding] = useState<string | null>(null);
  const locationEpoch = useRef(0);
  const [mode, setMode] = useState<ExportOptions['mode']>('bilingual');
  const [format, setFormat] = useState<ExportOptions['format']>(page?.summary.origin.format && page.summary.origin.format !== 'media' ? page.summary.origin.format : 'srt');
  const [selectedTrackId, setSelectedTrackId] = useState(trackId ?? page?.translationTracks.at(-1)?.id ?? '');
  const [order, setOrder] = useState<ExportOptions['order']>('source-first');
  const [encoding, setEncoding] = useState<Encoding>('utf-8');
  const [bom, setBom] = useState(false);
  const [newline, setNewline] = useState<ExportOptions['newline']>('lf');
  const [incomplete, setIncomplete] = useState<ExportOptions['incomplete']>('source-fallback');
  const [estimateEnd, setEstimateEnd] = useState(false);
  const [finalDuration, setFinalDuration] = useState('2000');
  const [plan, setPlan] = useState<{ identity: string; value: ExportPlanSummary } | null>(null);
  const [activity, setActivity] = useState<'plan' | 'save' | 'source' | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const pending = activity !== null || rebinding !== null;
  const unicode = encoding === 'utf-8' || encoding === 'utf-16le';
  const options = useMemo(() => exportOptionsSchema.safeParse({
    mode, format, ...(mode !== 'source' && selectedTrackId ? { trackId: selectedTrackId } : {}),
    fileNameSuffix: suffixMode === 'custom' ? { mode: 'custom', value: customSuffix } : suffixMode === 'none' ? { mode: 'none' } : { mode: 'preset', preset: suffixMode },
    order, encoding, bom: unicode && bom, newline, incomplete,
    missingEnd: estimateEnd && format !== 'lrc' ? { mode: 'next-start', finalDurationMs: Number(finalDuration) } : { mode: 'block' },
  }), [mode, format, selectedTrackId, order, encoding, unicode, bom, newline, incomplete, estimateEnd, finalDuration, suffixMode, customSuffix]);
  // A checked plan keeps its own revision while newer translation results arrive.
  const identity = JSON.stringify([batch ? batchDocuments.map(item => item.id) : page?.summary.id, options.success ? options.data : null, batch ? batchTracks : null, destination]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const currentDocumentId = useRef(page?.summary.id);
  currentDocumentId.current = page?.summary.id;
  const dialogOpen = useRef(open);
  dialogOpen.current = open;
  const currentPlan = plan?.identity === identity ? plan.value : null;
  const confirmations = currentPlan?.issues.filter(issue => issue.confirmation) ?? [];
  const hasBlocking = currentPlan?.issues.some(issue => issue.blocking) ?? false;
  const batchContentReady = batchPlan?.items.filter(item => item.ok && !item.plan.issues.some(issue => issue.blocking)) ?? [];
  const batchReady = batchContentReady.filter(item => item.ok && (destination !== 'source-directory' || item.plan.sourceLocation?.status === 'ready'));
  const batchConfirmations = batchContentReady.some(item => item.ok && item.plan.issues.some(issue => issue.confirmation));
  const canPlan = !busy && !pending && options.success;
  const canSave = step === 'review' && canPlan && (batch ? batchReady.length > 0 : !!currentPlan?.planId && !hasBlocking
    && (destination !== 'source-directory' || currentPlan.sourceLocation?.status === 'ready'));
  const newerRevision = !!currentPlan && currentPlan.revision !== page?.summary.revision;
  const missingEnds = format !== 'lrc' && (batch ? batchDocuments.some(document => document.origin.format === 'lrc') : page?.summary.origin.format === 'lrc' || page?.cues.some(cue => cue.timing.endMs === null));
  const number = (value: number) => value.toLocaleString(i18n.language);
  const sourceDocuments = batch ? batchDocuments : page ? [page.summary] : [];
  const sourceScope = sourceDocuments.map(document => document.id).join(',');
  const canSaveOriginal = !busy && !pending && (destination !== 'source-directory' || !locationsLoading && sourceDocuments.some(document => sourceLocations[document.id]?.status === 'ready'));
  const suffixValid = suffixMode !== 'custom' || fileNameSuffixSchema.safeParse({ mode: 'custom', value: customSuffix }).success;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const epoch = ++locationEpoch.current;
    if (!open) return;
    setLocationsLoading(true); setSourceLocations({});
    void Promise.all(sourceScope.split(',').filter(Boolean).map(async documentId => {
      let summary: SourceLocationSummary;
      try { summary = await unwrapStudio(window.subtitleStudio.getSourceLocation({ documentId })); }
      catch { summary = { status: 'unavailable' }; }
      return [documentId, summary] as const;
    })).then(entries => { if (mounted.current && locationEpoch.current === epoch) { setSourceLocations(Object.fromEntries(entries)); setLocationsLoading(false); } });
    return () => { locationEpoch.current++; };
  }, [open, sourceScope]);
  useEffect(() => {
    if (activity === 'save' || activity === 'source' || resultItems) return;
    setPlan(null); setBatchPlan(null); setStep('settings'); setError(null);
  }, [identity]);
  useEffect(() => {
    if (!open || step === 'settings') return;
    const frame = requestAnimationFrame(() => stepTitle.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [step, open]);
  useEffect(() => {
    if (batch) return;
    setOpen(false); setMode('bilingual'); setDestination('source-directory'); setFormat(page?.summary.origin.format && page.summary.origin.format !== 'media' ? page.summary.origin.format : 'srt');
    setSelectedTrackId(trackId ?? page?.translationTracks.at(-1)?.id ?? '');
    setEstimateEnd(false); setIncomplete('source-fallback');
    // Reset only on document selection, never for a background revision change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.summary.id]);

  const reportError = (failure: unknown) => {
    const code = failure instanceof StudioError ? failure.code : 'output_write_failed';
    setError(code); onError(code);
  };
  const prepare = async () => {
    if (operation.current || !canPlan || !options.success) return;
    operation.current = true;
    setActivity('plan'); setError(null); setPlan(null); setBatchPlan(null); setResultItems(null); setReviewDetailsOpen(false);
    const requestIdentity = identity;
    try {
      if (batch) {
        const { trackId: _track, ...sharedOptions } = options.data;
        const targets = batchDocuments.map(item => documents?.find(document => document.id === item.id) ?? item);
        const value = await unwrapStudio(window.subtitleStudio.planExportBatch({
          documents: targets.map(item => ({ documentId: item.id, revision: item.revision, ...(mode !== 'source' && batchTracks[item.id] ? { trackId: batchTracks[item.id] } : {}) })), options: sharedOptions,
        }));
        if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) { setBatchDocuments(targets); setBatchPlan(value); setStep('review'); }
      } else if (page) {
        const value = await unwrapStudio(window.subtitleStudio.planExport({
          documentId: page.summary.id, revision: page.summary.revision, options: options.data,
        }));
        if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) { setPlan({ identity: requestIdentity, value }); setStep('review'); }
      }
    } catch (failure) {
      if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) reportError(failure);
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };
  const save = async () => {
    if (operation.current || !canSave || !(batch ? batchPlan : currentPlan?.planId)) return;
    operation.current = true;
    setActivity('save'); setError(null);
    const requestIdentity = identity;
    try {
      if (batch && batchPlan) {
        const result = await unwrapStudio(window.subtitleStudio.exportBatch({ batchId: batchPlan.batchId, destination, acceptedLosses: batchContentReady.flatMap(item => item.ok ? [{ documentId: item.documentId, codes: item.plan.issues.filter(issue => issue.confirmation).map(issue => issue.code) }] : []) }));
        if (result && mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) { setResultItems(toResultItems(result)); setBatchPlan(null); setStep('result'); }
      } else if (currentPlan?.planId) {
        const result = await unwrapStudio(window.subtitleStudio.exportDocument({
          documentId: currentPlan.documentId, revision: currentPlan.revision, planId: currentPlan.planId,
          acceptedLosses: confirmations.map(issue => issue.code),
          destination,
        }));
        if (result && mounted.current && dialogOpen.current && currentDocumentId.current === currentPlan.documentId && currentIdentity.current === requestIdentity) {
          setResultItems([{ id: currentPlan.documentId, name: page?.summary.origin.displayName ?? result.fileName, state: 'success', detail: result.fileName }]);
          setPlan(null); setStep('result'); onExported(result.fileName);
        }
      }
    } catch (failure) {
      if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) {
        if (failure instanceof StudioError && (failure.code === 'revision_conflict' || failure.code === 'access_denied')) { setPlan(null); setBatchPlan(null); setStep('settings'); }
        reportError(failure);
      }
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };
  const changeOpen = (value: boolean) => {
    if (pending) return;
    dialogOpen.current = value;
    if (value) {
      setSourceMode(false); setMode('bilingual'); setDestination('source-directory'); setIncomplete('source-fallback');
      setSelectedTrackId(trackId ?? page?.translationTracks.at(-1)?.id ?? '');
      setBatchDocuments(documents ? [...documents] : []);
      setBatchTracks(Object.fromEntries((documents ?? []).map(item => [item.id, item.translationTracks?.at(-1)?.id ?? ''])));
    }
    setOpen(value); setStep('settings'); setPlan(null); setBatchPlan(null); setResultItems(null); setReviewDetailsOpen(false); setError(null);
  };

  const rebindSource = async (documentId: string) => {
    if (operation.current || pending) return;
    operation.current = true; setRebinding(documentId); setError(null);
    const epoch = locationEpoch.current;
    try {
      const value = await unwrapStudio(window.subtitleStudio.selectSourceDirectory({ documentId }));
      if (value && mounted.current && locationEpoch.current === epoch) {
        setSourceLocations(previous => ({ ...previous, [documentId]: value }));
        setPlan(null); setBatchPlan(null);
      }
    } catch (failure) { if (mounted.current && locationEpoch.current === epoch) reportError(failure); }
    finally { operation.current = false; if (mounted.current) setRebinding(null); }
  };
  const backToSettings = () => {
    if (operation.current || pending) return;
    setPlan(null); setBatchPlan(null); setReviewDetailsOpen(false); setError(null); setStep('settings');
    requestAnimationFrame(() => document.getElementById(`${controlId}-mode`)?.focus({ preventScroll: true }));
  };
  const toResultItems = (result: ExportBatchResult | SourceBatchResult): StudioOperationResultItem[] => result.items.map(item => ({
    id: item.documentId, name: item.displayName, state: item.ok ? 'success' : 'failed',
    detail: item.ok ? 'result' in item ? item.result.fileName : item.fileName : t(errorKeys[item.error]),
  }));
  const openSource = () => { changeOpen(true); setSourceMode(true); };
  const downloadSource = async () => {
    if (operation.current || !canSaveOriginal) return;
    operation.current = true; setActivity('source'); setError(null);
    const selected = batchDocuments;
    const requestIdentity = identity;
    try {
      if (batch) {
        const result = await unwrapStudio(window.subtitleStudio.exportSources({ documents: selected.map(item => ({ documentId: item.id, revision: item.revision })), destination }));
        if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity && result) { setResultItems(toResultItems(result)); setStep('result'); }
      } else if (page) {
        const result = await unwrapStudio(window.subtitleStudio.exportSource({ documentId: page.summary.id, revision: page.summary.revision, destination }));
        if (result && mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) {
          setResultItems([{ id: page.summary.id, name: page.summary.origin.displayName, state: 'success', detail: result.fileName }]);
          setStep('result'); onExported(result.fileName);
        }
      }
    } catch (failure) { if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) reportError(failure); }
    finally { operation.current = false; if (mounted.current) setActivity(null); }
  };

  const checkedPlans = batch ? (batchPlan?.items.flatMap(item => item.ok ? [item.plan] : []) ?? []) : currentPlan ? [currentPlan] : [];
  const mergedIssues = Array.from(checkedPlans.reduce((map, item) => {
    for (const issue of item.issues) {
      const existing = map.get(issue.code);
      map.set(issue.code, existing ? { ...issue, count: existing.count + issue.count, blocking: existing.blocking || issue.blocking, confirmation: existing.confirmation || issue.confirmation } : { ...issue });
    }
    return map;
  }, new Map<ExportIssueCode, ExportIssue>()).values());
  const reviewedOptions = checkedPlans[0]?.options ?? (options.success ? options.data : null);
  const readyCount = batch ? batchReady.length : currentPlan?.planId && !hasBlocking && (destination !== 'source-directory' || currentPlan.sourceLocation?.status === 'ready') ? 1 : 0;
  const outputCueCount = batch ? batchReady.reduce((total, item) => total + (item.ok ? item.plan.cueCount : 0), 0) : readyCount ? currentPlan!.cueCount : 0;
  const needsAcceptance = batch ? batchConfirmations : confirmations.length > 0 && !hasBlocking;

  const triggerControl = <DropdownMenu>
      <Tooltip delayDuration={350}><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button ref={trigger} variant="ghost" size="icon-sm" aria-label={t(batch ? 'studio:batch.download' : 'studio:batch.download_single')} disabled={busy || pending || (batch ? !documents?.length || documents.length > STUDIO_BATCH_LIMIT : !page)}>{activity === 'source' ? <LoaderCircle className="studio-spin" /> : <ArrowDownToLine />}</Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent sideOffset={6}>{t(batch ? 'studio:batch.download' : 'studio:batch.download_single')}</TooltipContent></Tooltip>
      <DropdownMenuContent align="end" data-testid="studio-download-menu" onCloseAutoFocus={event => { if (dialogOpen.current) event.preventDefault(); }}>
        {(batch ? documents?.every(document => document.capabilities.preserveSource) : page?.summary.capabilities.preserveSource) && <DropdownMenuItem onSelect={openSource}><ArrowDownToLine />{t(batch ? 'studio:batch.download_sources' : 'studio:export_source')}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => changeOpen(true)}><ClipboardCheck />{t(batch ? 'studio:batch.export' : 'studio:export.action')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>;

  return <>
    {triggerContainer === null ? null : triggerContainer ? createPortal(triggerControl, triggerContainer) : triggerControl}
    <ScrollableDialog open={open} onOpenChange={changeOpen} maxWidth="sm:max-w-[600px]" contentClassName="studio-export-dialog" onOpenAutoFocus={event => {
      if (!sourceMode) { event.preventDefault(); document.getElementById(`${controlId}-mode`)?.focus({ preventScroll: true }); }
    }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="relative p-3 pr-12">
        <DialogTitle ref={stepTitle} tabIndex={-1} className="studio-export-step-title flex items-center gap-2 text-base"><ArrowDownToLine className="size-4" />{t(step === 'review' ? 'studio:export.review_title' : step === 'result' ? 'studio:export.result_title' : sourceMode ? batch ? 'studio:batch.download_sources' : 'studio:export_source' : batch ? 'studio:batch.export' : 'studio:export.action')}</DialogTitle>
        <DialogDescription className={batch ? 'text-xs' : 'sr-only'}>{batch ? t('studio:batch.document_count', { count: batchDocuments.length }) : page?.summary.origin.displayName}</DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent key={step} className="studio-export-content" fadeMaskHeight={16}>
        <div className="studio-export-form" data-step={step}>
          {step === 'settings' && <>
            <div className="studio-export-fields">
              {!sourceMode && <><ToolField label={t('studio:export.mode')} htmlFor={`${controlId}-mode`}>
              <Select value={mode} onValueChange={value => setMode(value as ExportOptions['mode'])} disabled={pending}>
                <SelectTrigger id={`${controlId}-mode`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(modeKeys) as ExportOptions['mode'][]).map(value => <SelectItem key={value} value={value}>{t(modeKeys[value])}</SelectItem>)}</SelectContent>
              </Select>
            </ToolField><ToolField label={t('studio:export.format')} htmlFor={`${controlId}-format`}>
              <Select value={format} onValueChange={value => setFormat(value as ExportOptions['format'])} disabled={pending}>
                <SelectTrigger id={`${controlId}-format`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{(['srt', 'lrc', 'vtt', 'ass'] as const).map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent>
              </Select>
            </ToolField></>}
              <ToolField label={t('studio:export.destination')} htmlFor={`${controlId}-destination`}>
              <Select value={destination} onValueChange={value => setDestination(value as ExportDestination)} disabled={pending}>
                <SelectTrigger id={`${controlId}-destination`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="choose-location">{t('studio:export.destination_choose')}</SelectItem><SelectItem value="source-directory">{t('studio:export.destination_source')}</SelectItem></SelectContent>
              </Select>
            </ToolField>
              {!sourceMode && <><ToolField label={t('studio:export.suffix')} htmlFor={`${controlId}-suffix`}>
              <Select value={suffixMode} onValueChange={value => setSuffixMode(value as typeof suffixMode)} disabled={pending}>
                <SelectTrigger id={`${controlId}-suffix`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">{t('studio:export.suffix_none')}</SelectItem><SelectItem value="content-mode">{t('studio:export.suffix_content_mode')}</SelectItem><SelectItem value="target-language">{t('studio:export.suffix_target_language')}</SelectItem><SelectItem value="custom">{t('studio:export.suffix_custom')}</SelectItem></SelectContent>
              </Select>
            </ToolField>

                {mode === 'bilingual' && <ToolField label={t('studio:export.order')} htmlFor={`${controlId}-order`}>
              <Select value={order} onValueChange={value => setOrder(value as ExportOptions['order'])} disabled={pending}>
                <SelectTrigger id={`${controlId}-order`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="source-first">{t('studio:export.source_first')}</SelectItem><SelectItem value="target-first">{t('studio:export.target_first')}</SelectItem></SelectContent>
              </Select>
            </ToolField>}
                {mode !== 'source' && <ToolField label={t('studio:export.incomplete')} htmlFor={`${controlId}-incomplete`}>
            <Select value={incomplete} onValueChange={value => setIncomplete(value as ExportOptions['incomplete'])} disabled={pending}>
              <SelectTrigger id={`${controlId}-incomplete`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="block">{t('studio:export.incomplete_block')}</SelectItem><SelectItem value="skip">{t('studio:export.incomplete_skip')}</SelectItem><SelectItem value="source-fallback">{t('studio:export.incomplete_fallback')}</SelectItem></SelectContent>
            </Select>
          </ToolField>}
                {suffixMode === 'custom' && <ToolField label={t('studio:export.suffix_value')} htmlFor={`${controlId}-suffix-value`}>
              <Input id={`${controlId}-suffix-value`} value={customSuffix} onChange={event => setCustomSuffix(event.target.value)} maxLength={40} placeholder={t('studio:export.suffix_placeholder')}
                className="h-8 text-xs" disabled={pending} aria-invalid={!suffixValid} aria-describedby={!suffixValid ? `${controlId}-suffix-error` : undefined} />
            </ToolField>}
              </>}
            </div>
            <p className="studio-export-note">{t(destination === 'source-directory' ? 'studio:export.destination_source_note' : 'studio:export.destination_choose_note')}</p>
            {destination === 'source-directory' && (locationsLoading || sourceDocuments.some(document => sourceLocations[document.id]?.status !== 'ready')) && <p className="studio-export-note" role="status">{locationsLoading ? t('studio:export.source_loading')
              : sourceDocuments.some(document => sourceLocations[document.id]?.status !== 'ready') ? t('studio:export.source_attention', { count: sourceDocuments.filter(document => sourceLocations[document.id]?.status !== 'ready').length }) : null}</p>}
            {!sourceMode && mode !== 'source' && incomplete === 'source-fallback' && sourceDocuments.some(document => !document.translationTracks?.length) && <p className="studio-export-note" role="status">{t('studio:export.no_translation_fallback')}</p>}
          </>}
          {!sourceMode && step === 'settings' && <>
          {missingEnds && <div className="studio-export-estimate">
            <label className="studio-export-check" htmlFor={`${controlId}-estimate`}><Checkbox id={`${controlId}-estimate`} checked={estimateEnd} onCheckedChange={value => setEstimateEnd(value === true)} disabled={pending} /><span>{t('studio:export.estimate_end')}</span></label>
            <p className="studio-export-note">{t('studio:export.estimate_rule')}</p>
            {estimateEnd && <ToolField label={t('studio:export.final_duration')} htmlFor={`${controlId}-duration`} className="studio-export-duration">
              <Input id={`${controlId}-duration`} type="number" min={1} max={3600000} step={1} className="h-8 font-mono text-xs" value={finalDuration} onChange={event => setFinalDuration(event.target.value)} disabled={pending} />
            </ToolField>}
          </div>}
          {!suffixValid && <p id={`${controlId}-suffix-error`} className="studio-export-error" role="alert">{t('studio:export.suffix_invalid')}</p>}
          {!batch && page && options.success && <p className="studio-export-note studio-export-file-name" data-testid="studio-export-file-name">{t('studio:export.file_name_preview', { name: subtitleExportFileName({ origin: page.summary.origin, translationTracks: page.translationTracks }, options.data) })}</p>}
          {!options.success && <p className="studio-export-error" role="alert">{t('studio:export.invalid_options')}</p>}
          </>}
          {step === 'settings' && <StudioPlanDocuments documents={sourceDocuments}
            renderActions={destination === 'source-directory' ? document => <span data-testid="studio-source-location" data-document-id={document.id} data-state={locationsLoading ? 'loading' : sourceLocations[document.id]?.status ?? 'missing'}>
              <StudioIconButton label={t('studio:export.select_source_directory')} onClick={() => void rebindSource(document.id)} disabled={pending || locationsLoading}>
                {rebinding === document.id ? <LoaderCircle className="studio-spin" /> : <FolderOpen />}
              </StudioIconButton>
            </span> : undefined}
            tracks={!sourceMode && mode !== 'source' ? {
              selected: batch ? batchTracks : page ? { [page.summary.id]: selectedTrackId } : {},
              onChange: (documentId, value) => batch ? setBatchTracks(current => ({ ...current, [documentId]: value })) : setSelectedTrackId(value),
              disabled: pending,
              emptyNote: t(incomplete === 'source-fallback' ? 'studio:export.no_translation_fallback' : 'studio:export.no_track'),
            } : undefined}
            renderDetails={document => {
              const location = sourceLocations[document.id];
              const showLocation = destination === 'source-directory' && !locationsLoading && (location?.status !== 'ready' || location.origin === 'user-selected-directory');
              if (!showLocation) return null;
              return <>
                {showLocation && <div className="studio-export-location">
                  {location?.status !== 'ready' && <p className="studio-export-note">{t(location?.status === 'unavailable' ? 'studio:export.source_unavailable' : 'studio:export.source_missing')}</p>}
                  {location?.status === 'ready' && location.origin === 'user-selected-directory' && <p className="studio-export-note">{t('studio:export.source_rebound')}</p>}
                </div>}
              </>;
            }} />}
          {!sourceMode && step === 'settings' && <>
          <ToolConfigDisclosure testId="studio-export-advanced" className="studio-export-advanced border-b-0" icon={FileCog} title={t('studio:export.advanced')}>
            <div className="studio-export-fields">
              <ToolField label={t('studio:encoding')} htmlFor={`${controlId}-encoding`}>
                <Select value={encoding} onValueChange={value => { setEncoding(encodingSchema.parse(value)); if (value !== 'utf-8' && value !== 'utf-16le') setBom(false); }} disabled={pending}>
                  <SelectTrigger id={`${controlId}-encoding`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{encodingSchema.options.map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent>
                </Select>
              </ToolField>
              <ToolField label={t('studio:export.newline')} htmlFor={`${controlId}-newline`}>
                <Select value={newline} onValueChange={value => setNewline(value as ExportOptions['newline'])} disabled={pending}>
                  <SelectTrigger id={`${controlId}-newline`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="lf">LF</SelectItem><SelectItem value="crlf">CRLF</SelectItem></SelectContent>
                </Select>
              </ToolField>
            </div>
            <label className="studio-export-check" htmlFor={`${controlId}-bom`}><Checkbox id={`${controlId}-bom`} checked={unicode && bom} onCheckedChange={value => setBom(value === true)} disabled={pending || !unicode} /><span>{t('studio:export.bom')}</span></label>
          </ToolConfigDisclosure>
          </>}
          {step === 'review' && reviewedOptions && <section className="studio-export-plan studio-export-review" data-testid={batch ? 'studio-batch-plan' : 'studio-export-review'} data-revision={currentPlan?.revision} data-partial={currentPlan?.partial}>
            <p className="studio-export-note">{t('studio:export.review_description')}</p>
            <div className="studio-export-summary"><h3>{t('studio:batch.ready_count', { count: readyCount, total: sourceDocuments.length })}</h3>
              <span>{t('studio:export.output_cues', { count: outputCueCount })}</span>
            </div>
            <section className="studio-export-review-output" aria-label={t('studio:export.review_output')}>
              <h3>{t('studio:export.review_output')}</h3>
              <dl>
                <div><dt>{t('studio:export.mode')}</dt><dd>{t(modeKeys[reviewedOptions.mode])} · {reviewedOptions.format.toUpperCase()}</dd></div>
                <div><dt>{t('studio:export.destination')}</dt><dd>{t(destination === 'source-directory' ? 'studio:export.destination_source' : 'studio:export.destination_choose')}</dd></div>
                {reviewedOptions.mode === 'bilingual' && <div><dt>{t('studio:export.order')}</dt><dd>{t(reviewedOptions.order === 'source-first' ? 'studio:export.source_first' : 'studio:export.target_first')}</dd></div>}
                {reviewedOptions.mode !== 'source' && <div><dt>{t('studio:export.incomplete')}</dt><dd>{t(reviewedOptions.incomplete === 'block' ? 'studio:export.incomplete_block' : reviewedOptions.incomplete === 'skip' ? 'studio:export.incomplete_skip' : 'studio:export.incomplete_fallback')}</dd></div>}
                <div><dt>{t('studio:encoding')}</dt><dd>{reviewedOptions.encoding.toUpperCase()}{reviewedOptions.bom ? ' · BOM' : ''} · {reviewedOptions.newline.toUpperCase()}</dd></div>
                <div><dt>{t('studio:export.suffix')}</dt><dd>{reviewedOptions.fileNameSuffix?.mode === 'custom' ? reviewedOptions.fileNameSuffix.value : t(reviewedOptions.fileNameSuffix?.mode !== 'preset' ? 'studio:export.suffix_none' : reviewedOptions.fileNameSuffix.preset === 'content-mode' ? 'studio:export.suffix_content_mode' : 'studio:export.suffix_target_language')}</dd></div>
              </dl>
            </section>
            {newerRevision && <p className="studio-export-note studio-export-frozen">{t('studio:export.frozen_revision')}</p>}
            {!!mergedIssues.length ? <section className="studio-export-review-changes" aria-label={t('studio:export.review_changes')}>
              <h3>{t('studio:export.review_changes')}</h3>
              <ul className="studio-export-change-types">{mergedIssues.map(issue => <li key={issue.code} data-blocking={issue.blocking} data-issue={issue.code}>
                <Tooltip delayDuration={350}><TooltipTrigger asChild><span tabIndex={0}>{t(changeKeys[issue.code])}<span className="studio-export-change-count">{number(issue.count)}</span></span></TooltipTrigger>
                  <TooltipContent className="max-w-72" sideOffset={6}>{t(issueKeys[issue.code], { count: issue.count })}</TooltipContent></Tooltip>
              </li>)}</ul>
            </section> : readyCount > 0 && <p className="studio-export-ready"><CheckCheck className="size-3.5" />{t('studio:export.ready')}</p>}
            {readyCount < sourceDocuments.length && <p className="studio-export-note" role="status">{t('studio:export.review_not_ready')}</p>}
            {needsAcceptance && <p className="studio-export-note">{t('studio:export.review_accept')}</p>}
            <details className="studio-export-review-details" data-testid="studio-export-review-details" onToggle={event => setReviewDetailsOpen(event.currentTarget.open)}>
              <summary>{t('studio:export.review_details')}<ChevronDown className="size-3.5" /></summary>
              {reviewDetailsOpen && <StudioDocumentList label={t('studio:export.review_details')} maxHeight="min(280px, 42vh)">
                {sourceDocuments.map((document, index) => {
                  const batchItem = batchPlan?.items.find(item => item.documentId === document.id);
                  const checked = batch ? batchItem?.ok ? batchItem.plan : undefined : currentPlan ?? undefined;
                  const ready = batch ? batchReady.some(item => item.documentId === document.id) : readyCount > 0;
                  const locationUnavailable = destination === 'source-directory' && checked?.sourceLocation?.status !== 'ready';
                  return <StudioDocumentRow key={document.id} index={index + 1} name={document.origin.displayName} data-document-id={document.id} data-state={ready ? 'ready' : 'failed'}
                    status={batchItem && !batchItem.ok ? t(errorKeys[batchItem.error]) : locationUnavailable ? t(checked?.sourceLocation?.status === 'missing' ? 'studio:export.source_missing' : 'studio:export.source_unavailable') : t(ready ? 'studio:batch.ready' : 'studio:batch.blocked')}>
                    {checked && <><p className="studio-export-note">{checked.fileName} · {number(checked.byteLength)} B</p>
                      {!!checked.issues.length && <ul className="studio-export-issues">{checked.issues.map(issue => <li key={issue.code} data-blocking={issue.blocking}><span>{t(issueKeys[issue.code], { count: issue.count })}</span></li>)}</ul>}
                      {checked.preview && <details className="studio-export-preview"><summary>{t('studio:export.preview')}<ChevronDown className="size-3.5" /></summary><pre>{checked.preview}</pre></details>}
                    </>}
                  </StudioDocumentRow>;
                })}
              </StudioDocumentList>}
            </details>
          </section>}
          {error && <p className="studio-export-error" role="alert"><AlertCircle className="size-4" />{t(errorKeys[error])}</p>}
          {sourceMode && pending && <p role="status" className="studio-batch-note">{t('studio:loading')}</p>}
          {step === 'result' && resultItems && <StudioOperationResult items={resultItems} testId={batch ? 'studio-batch-result' : 'studio-export-result'} />}
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="studio-export-footer flex flex-wrap items-center justify-end gap-2 p-3">
        <Button id={`${controlId}-close`} variant="ghost" size="sm" onClick={() => changeOpen(false)} disabled={pending}>{t(step === 'result' || sourceMode ? 'studio:batch.close' : 'studio:cancel')}</Button>
        {step === 'settings' && (sourceMode
          ? <Button size="sm" onClick={() => void downloadSource()} disabled={!canSaveOriginal}>{activity === 'source' ? <LoaderCircle className="studio-spin" /> : <ArrowDownToLine />}{t(destination === 'source-directory' ? 'studio:export.save_to_source' : 'studio:export.save_original')}</Button>
          : <Button size="sm" onClick={() => void prepare()} disabled={!canPlan}>{activity === 'plan' ? <LoaderCircle className="studio-spin" /> : <ClipboardCheck />}{t('studio:export.prepare')}</Button>)}
        {step === 'review' && <>
          <Button variant="outline" size="sm" onClick={backToSettings} disabled={pending}>{t('studio:export.review_back')}</Button>
          <Button size="sm" onClick={() => void save()} disabled={!canSave}>{activity === 'save' ? <LoaderCircle className="studio-spin" /> : <ArrowDownToLine />}{t('studio:export.review_confirm', { count: readyCount })}</Button>
        </>}
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
