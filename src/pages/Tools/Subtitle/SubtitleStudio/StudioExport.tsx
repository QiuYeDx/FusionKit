import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowDownToLine, CheckCheck, ChevronDown, ClipboardCheck, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { encodingSchema, StudioError, type Encoding, type ErrorCode } from '@/subtitle-studio/domain';
import { exportOptionsSchema, type ExportIssueCode, type ExportOptions, type ExportPlanSummary } from '@/subtitle-studio/export-contract';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import './StudioExport.css';

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
  unsupported_text: 'studio:export.issues.unsupported_text',
  empty_output: 'studio:export.issues.empty_output',
  encoding_unrepresentable: 'studio:export.issues.encoding_unrepresentable',
  skipped_cues: 'studio:export.issues.skipped_cues',
  source_fallback: 'studio:export.issues.source_fallback',
} as const satisfies Record<ExportIssueCode, string>;
const errorKeys = {
  invalid_input: 'studio:errors.invalid_input', unsupported_feature: 'studio:errors.unsupported_feature',
  encoding_required: 'studio:errors.encoding_required', limit_exceeded: 'studio:errors.limit_exceeded',
  revision_conflict: 'studio:errors.revision_conflict', access_denied: 'studio:errors.access_denied',
  document_unavailable: 'studio:errors.document_unavailable', output_write_failed: 'studio:errors.output_write_failed',
  needs_configuration: 'studio:errors.needs_configuration', translation_protocol_invalid: 'studio:errors.translation_protocol_invalid',
  translation_output_limit: 'studio:errors.translation_output_limit', translation_failed: 'studio:errors.translation_failed',
  interrupted: 'studio:errors.interrupted',
} as const satisfies Record<ErrorCode, string>;

type StudioExportProps = {
  page: DocumentPage;
  trackId?: string;
  busy: boolean;
  onExported: (fileName: string) => void;
  onError: (error: ErrorCode) => void;
};

export function StudioExport({ page, trackId, busy, onExported, onError }: StudioExportProps) {
  const { t, i18n } = useTranslation();
  const controlId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ExportOptions['mode']>('source');
  const [format, setFormat] = useState<ExportOptions['format']>(page.summary.origin.format);
  const [selectedTrackId, setSelectedTrackId] = useState(trackId ?? page.translationTracks.at(-1)?.id ?? '');
  const [order, setOrder] = useState<ExportOptions['order']>('source-first');
  const [encoding, setEncoding] = useState<Encoding>('utf-8');
  const [bom, setBom] = useState(false);
  const [newline, setNewline] = useState<ExportOptions['newline']>('lf');
  const [incomplete, setIncomplete] = useState<ExportOptions['incomplete']>('block');
  const [estimateEnd, setEstimateEnd] = useState(false);
  const [finalDuration, setFinalDuration] = useState('2000');
  const [plan, setPlan] = useState<{ identity: string; value: ExportPlanSummary } | null>(null);
  const [acceptedIdentity, setAcceptedIdentity] = useState<string | null>(null);
  const [activity, setActivity] = useState<'plan' | 'save' | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const pending = activity !== null;
  const unicode = encoding === 'utf-8' || encoding === 'utf-16le';
  const options = useMemo(() => exportOptionsSchema.safeParse({
    mode, format, ...(mode !== 'source' && selectedTrackId ? { trackId: selectedTrackId } : {}),
    order, encoding, bom: unicode && bom, newline, incomplete,
    missingEnd: estimateEnd && format === 'srt' ? { mode: 'next-start', finalDurationMs: Number(finalDuration) } : { mode: 'block' },
  }), [mode, format, selectedTrackId, order, encoding, unicode, bom, newline, incomplete, estimateEnd, finalDuration]);
  // A checked plan keeps its own revision while newer translation results arrive.
  const identity = JSON.stringify([page.summary.id, options.success ? options.data : null]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const currentDocumentId = useRef(page.summary.id);
  currentDocumentId.current = page.summary.id;
  const dialogOpen = useRef(open);
  dialogOpen.current = open;
  const currentPlan = plan?.identity === identity ? plan.value : null;
  const confirmations = currentPlan?.issues.filter(issue => issue.confirmation) ?? [];
  const lossesAccepted = !!currentPlan?.planId && acceptedIdentity === currentPlan.planId;
  const hasBlocking = currentPlan?.issues.some(issue => issue.blocking) ?? false;
  const canPlan = !busy && !pending && options.success;
  const canSave = canPlan && !!currentPlan?.planId && !hasBlocking && (!confirmations.length || lossesAccepted);
  const newerRevision = !!currentPlan && currentPlan.revision !== page.summary.revision;
  const missingEnds = format === 'srt' && (page.summary.origin.format === 'lrc' || page.cues.some(cue => cue.timing.endMs === null));
  const number = (value: number) => value.toLocaleString(i18n.language);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { setPlan(null); setAcceptedIdentity(null); setError(null); }, [identity]);
  useEffect(() => {
    setOpen(false); setMode('source'); setFormat(page.summary.origin.format);
    setSelectedTrackId(trackId ?? page.translationTracks.at(-1)?.id ?? '');
    setEstimateEnd(false); setIncomplete('block');
    // Reset only on document selection, never for a background revision change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.summary.id]);

  const reportError = (failure: unknown) => {
    const code = failure instanceof StudioError ? failure.code : 'output_write_failed';
    setError(code); onError(code);
  };
  const prepare = async () => {
    if (operation.current || !canPlan || !options.success) return;
    operation.current = true;
    setActivity('plan'); setError(null); setPlan(null); setAcceptedIdentity(null);
    const requestIdentity = identity;
    try {
      const value = await unwrapStudio(window.subtitleStudio.planExport({
        documentId: page.summary.id, revision: page.summary.revision, options: options.data,
      }));
      if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) setPlan({ identity: requestIdentity, value });
    } catch (failure) {
      if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) reportError(failure);
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };
  const save = async () => {
    if (operation.current || !canSave || !currentPlan?.planId) return;
    operation.current = true;
    setActivity('save'); setError(null);
    const requestIdentity = identity;
    try {
      const result = await unwrapStudio(window.subtitleStudio.exportDocument({
        documentId: currentPlan.documentId, revision: currentPlan.revision, planId: currentPlan.planId,
        acceptedLosses: confirmations.map(issue => issue.code),
      }));
      if (result && mounted.current && currentDocumentId.current === currentPlan.documentId) {
        setOpen(false); setPlan(null); setAcceptedIdentity(null); onExported(result.fileName);
      }
    } catch (failure) {
      if (mounted.current && dialogOpen.current && currentIdentity.current === requestIdentity) {
        if (failure instanceof StudioError && (failure.code === 'revision_conflict' || failure.code === 'access_denied')) setPlan(null);
        reportError(failure);
      }
    } finally {
      operation.current = false;
      if (mounted.current) setActivity(null);
    }
  };
  const changeOpen = (value: boolean) => {
    if (pending) return;
    if (value) setSelectedTrackId(trackId ?? page.translationTracks.at(-1)?.id ?? '');
    setOpen(value); setPlan(null); setAcceptedIdentity(null); setError(null);
  };

  return <>
    <Button ref={trigger} variant="outline" size="sm" disabled={busy || pending} onClick={() => changeOpen(true)}><ArrowDownToLine />{t('studio:export.action')}</Button>
    <ScrollableDialog open={open} onOpenChange={changeOpen} maxWidth="sm:max-w-[600px]" contentClassName="studio-export-dialog" onOpenAutoFocus={event => {
      event.preventDefault(); document.getElementById(`${controlId}-mode`)?.focus({ preventScroll: true });
    }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="relative p-3 pr-12">
        <DialogTitle className="flex items-center gap-2 text-base"><ArrowDownToLine className="size-4" />{t('studio:export.action')}</DialogTitle>
        <DialogDescription className="sr-only">{page.summary.origin.displayName}</DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-export-content" fadeMaskHeight={16}>
        <div className="studio-export-form">
          <div className="studio-export-fields">
            <ToolField label={t('studio:export.mode')} htmlFor={`${controlId}-mode`}>
              <Select value={mode} onValueChange={value => setMode(value as ExportOptions['mode'])} disabled={pending}>
                <SelectTrigger id={`${controlId}-mode`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(modeKeys) as ExportOptions['mode'][]).map(value => <SelectItem key={value} value={value}>{t(modeKeys[value])}</SelectItem>)}</SelectContent>
              </Select>
            </ToolField>
            <ToolField label={t('studio:export.format')} htmlFor={`${controlId}-format`}>
              <Select value={format} onValueChange={value => setFormat(value as ExportOptions['format'])} disabled={pending}>
                <SelectTrigger id={`${controlId}-format`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="srt">SRT</SelectItem><SelectItem value="lrc">LRC</SelectItem></SelectContent>
              </Select>
            </ToolField>
            {mode !== 'source' && <ToolField label={t('studio:translation_track')} htmlFor={`${controlId}-track`}>
              <Select value={selectedTrackId} onValueChange={setSelectedTrackId} disabled={pending || !page.translationTracks.length}>
                <SelectTrigger id={`${controlId}-track`} className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder={t('studio:export.no_track')} /></SelectTrigger>
                <SelectContent>{page.translationTracks.map((track, index) => <SelectItem key={track.id} value={track.id}>{track.language === 'und' ? t('studio:language_unknown') : track.language} · {index + 1}</SelectItem>)}</SelectContent>
              </Select>
            </ToolField>}
            {mode === 'bilingual' && <ToolField label={t('studio:export.order')} htmlFor={`${controlId}-order`}>
              <Select value={order} onValueChange={value => setOrder(value as ExportOptions['order'])} disabled={pending}>
                <SelectTrigger id={`${controlId}-order`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="source-first">{t('studio:export.source_first')}</SelectItem><SelectItem value="target-first">{t('studio:export.target_first')}</SelectItem></SelectContent>
              </Select>
            </ToolField>}
          </div>
          {mode !== 'source' && <ToolField label={t('studio:export.incomplete')} htmlFor={`${controlId}-incomplete`}>
            <Select value={incomplete} onValueChange={value => setIncomplete(value as ExportOptions['incomplete'])} disabled={pending}>
              <SelectTrigger id={`${controlId}-incomplete`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="block">{t('studio:export.incomplete_block')}</SelectItem><SelectItem value="skip">{t('studio:export.incomplete_skip')}</SelectItem><SelectItem value="source-fallback">{t('studio:export.incomplete_fallback')}</SelectItem></SelectContent>
            </Select>
          </ToolField>}
          {missingEnds && <div className="studio-export-estimate">
            <label className="studio-export-check" htmlFor={`${controlId}-estimate`}><Checkbox id={`${controlId}-estimate`} checked={estimateEnd} onCheckedChange={value => setEstimateEnd(value === true)} disabled={pending} /><span>{t('studio:export.estimate_end')}</span></label>
            <p className="studio-export-note">{t('studio:export.estimate_rule')}</p>
            {estimateEnd && <ToolField label={t('studio:export.final_duration')} htmlFor={`${controlId}-duration`} className="studio-export-duration">
              <Input id={`${controlId}-duration`} type="number" min={1} max={3600000} step={1} className="h-8 font-mono text-xs" value={finalDuration} onChange={event => setFinalDuration(event.target.value)} disabled={pending} />
            </ToolField>}
          </div>}
          <details className="studio-export-advanced">
            <summary>{t('studio:export.advanced')}<ChevronDown className="size-3.5" /></summary>
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
            <label className="studio-export-check studio-export-bom" htmlFor={`${controlId}-bom`}><Checkbox id={`${controlId}-bom`} checked={unicode && bom} onCheckedChange={value => setBom(value === true)} disabled={pending || !unicode} /><span>{t('studio:export.bom')}</span></label>
          </details>
          {!options.success && <p className="studio-export-error" role="alert">{t('studio:export.invalid_options')}</p>}
          {error && <p className="studio-export-error" role="alert"><AlertCircle className="size-4" />{t(errorKeys[error])}</p>}
          {currentPlan && <section className="studio-export-plan" aria-live="polite" data-revision={currentPlan.revision} data-partial={currentPlan.partial}>
            <div className="studio-export-summary"><h3>{t(currentPlan.partial ? 'studio:export.partial_result' : 'studio:export.result')}</h3><span>{t('studio:export.output_cues', { count: currentPlan.cueCount })} · {number(currentPlan.byteLength)} B</span></div>
            {newerRevision && <p className="studio-export-note studio-export-frozen">{t('studio:export.frozen_revision')}</p>}
            {!!currentPlan.issues.length && <ul className="studio-export-issues">{currentPlan.issues.map(issue => <li key={issue.code} data-blocking={issue.blocking} data-issue={issue.code}>
              {issue.blocking ? <AlertCircle className="size-3.5" /> : <span className="studio-export-issue-dot" aria-hidden="true" />}<span>{t(issueKeys[issue.code], { count: issue.count })}</span>
            </li>)}</ul>}
            {!!confirmations.length && !hasBlocking && <label className="studio-export-check" htmlFor={`${controlId}-accept`}><Checkbox id={`${controlId}-accept`} checked={lossesAccepted} onCheckedChange={value => setAcceptedIdentity(value === true ? currentPlan.planId : null)} disabled={pending} /><span>{t('studio:export.accept_losses')}</span></label>}
            {currentPlan.preview && <details className="studio-export-preview"><summary>{t('studio:export.preview')}<ChevronDown className="size-3.5" /></summary><pre>{currentPlan.preview}</pre></details>}
            {!currentPlan.issues.length && <p className="studio-export-ready"><CheckCheck className="size-3.5" />{t('studio:export.ready')}</p>}
          </section>}
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="studio-export-footer flex flex-wrap items-center justify-end gap-2 p-3">
        <Button variant="ghost" size="sm" onClick={() => changeOpen(false)} disabled={pending}>{t('studio:cancel')}</Button>
        {currentPlan?.planId && <Button variant="outline" size="sm" onClick={() => void prepare()} disabled={!canPlan}>{t('studio:export.recheck')}</Button>}
        {currentPlan?.planId ? <Button size="sm" onClick={() => void save()} disabled={!canSave}>{activity === 'save' ? <LoaderCircle className="studio-spin" /> : <ArrowDownToLine />}{t('studio:export.save')}</Button> : <Button size="sm" onClick={() => void prepare()} disabled={!canPlan}>{activity === 'plan' ? <LoaderCircle className="studio-spin" /> : <ClipboardCheck />}{t('studio:export.prepare')}</Button>}
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
