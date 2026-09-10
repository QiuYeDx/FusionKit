import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Columns2, Eraser, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { ToolField } from '../../_shared/ui/ToolField';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { StudioError, type ErrorCode, type SubtitleDocument } from '@/subtitle-studio/domain';
import type { DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import type { BilingualCandidate, BilingualOptions, BilingualPreview } from '@/subtitle-studio/bilingual-contract';
import { formatStudioTime, StudioFileName, StudioIconButton, StudioPagination } from './StudioControls';
import './StudioBilingual.css';

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
const languageKeys = {
  zh: 'studio:translation.languages.zh',
  en: 'studio:translation.languages.en',
  ja: 'studio:translation.languages.ja',
  'zh-Hant': 'studio:translation.languages.zh-Hant',
  ko: 'studio:bilingual.korean',
} as const;
type ChangeProps = {
  page: DocumentPage;
  busy: boolean;
  onChanged: (summary: DocumentSummary) => void;
  onError: (error: ErrorCode) => void;
};
type PreviewState = { identity: string; sourceSide: BilingualOptions['sourceSide']; value: BilingualPreview };
const PAGE_SIZE = 20;

export function StudioBilingual(props: ChangeProps & { autoOpen?: boolean }) {
  return <StudioBilingualDocument key={props.page.summary.id} {...props} />;
}

function StudioBilingualDocument({ page, busy, onChanged, onError, autoOpen = false }: ChangeProps & { autoOpen?: boolean }) {
  const { t } = useTranslation();
  const controlId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const firstControl = useRef<HTMLButtonElement>(null);
  const optionsRegion = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  const [options, setOptions] = useState<BilingualOptions>({ sourceSide: 'first', splitInline: false, overrides: [] });
  const [offset, setOffset] = useState(0);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [selectionLimit, setSelectionLimit] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const operation = useRef(false);
  const requestVersion = useRef(0);
  const overrideKinds = useRef(new Map<string, BilingualCandidate['kind']>());
  const currentDocumentId = useRef(page.summary.id);
  currentDocumentId.current = page.summary.id;
  const eligible = page.summary.bilingualAvailable && !page.summary.bilingualImport && !page.translationTracks.length && !page.tasks.length;
  const identity = JSON.stringify([page.summary.id, page.summary.revision, options, offset, reviewOnly]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const currentPreview = preview?.identity === identity && preview.value.revision === page.summary.revision ? preview.value : null;
  const visiblePreview = preview?.value.revision === page.summary.revision ? preview.value : null;
  const pending = loading || applying || busy;
  const languageName = (language: string) => language in languageKeys
    ? t(languageKeys[language as keyof typeof languageKeys]) : t('studio:language_unknown');
  const report = (failure: unknown) => {
    const code = failure instanceof StudioError ? failure.code : 'document_unavailable';
    setError(code); onError(code);
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestVersion.current += 1; };
  }, []);
  useEffect(() => {
    if (autoOpen && !autoOpened.current && eligible && page.summary.bilingualRecommended && !busy) {
      autoOpened.current = true; setOpen(true);
    }
  }, [autoOpen, eligible, page.summary.bilingualRecommended, busy]);
  useEffect(() => {
    if (!open || !eligible) return;
    const version = ++requestVersion.current;
    const requestIdentity = identity;
    setLoading(true); setError(null);
    void unwrapStudio(window.subtitleStudio.previewBilingual({
      documentId: page.summary.id, revision: page.summary.revision, options, offset, reviewOnly,
    })).then(value => {
      if (!mounted.current || version !== requestVersion.current || currentIdentity.current !== requestIdentity) return;
      if (value.revision !== page.summary.revision) { report(new StudioError('revision_conflict')); return; }
      if (value.offset !== offset) { setOffset(value.offset); return; }
      setPreview({ identity: requestIdentity, sourceSide: options.sourceSide, value });
    }).catch(failure => {
      if (mounted.current && version === requestVersion.current && currentIdentity.current === requestIdentity) report(failure);
    }).finally(() => {
      if (mounted.current && version === requestVersion.current) setLoading(false);
    });
    return () => { requestVersion.current += 1; };
  }, [open, eligible, identity, attempt]);

  const changePage = (value: number) => {
    setOffset(value);
    optionsRegion.current?.closest('[data-slot="scroll-area-viewport"]')?.scrollTo({ top: 0 });
  };
  const configure = (patch: Partial<BilingualOptions>) => {
    setSelectionLimit(false);
    setOptions(value => ({
      ...value, ...patch,
      overrides: patch.splitInline === false ? value.overrides.filter(item => item.splitAt === null && overrideKinds.current.get(item.cueId) !== 'inline') : value.overrides,
    })); changePage(0);
  };
  const choose = (candidate: BilingualCandidate, value: string) => {
    const cueId = candidate.id;
    if (value !== 'suggested' && !options.overrides.some(item => item.cueId === cueId) && options.overrides.length >= 1000) {
      setSelectionLimit(true);
      return;
    }
    setSelectionLimit(false);
    if (value === 'suggested') overrideKinds.current.delete(cueId);
    else overrideKinds.current.set(cueId, candidate.kind);
    setOptions(current => ({
      ...current,
      overrides: [
        ...current.overrides.filter(item => item.cueId !== cueId),
        ...(value === 'suggested' ? [] : [{ cueId, splitAt: value === 'keep' ? null : Number(value.slice('split:'.length)) }]),
      ],
    }));
  };
  const apply = async () => {
    if (operation.current || pending || !eligible || !currentPreview || currentPreview.pairedCount === 0) return;
    operation.current = true; setApplying(true); setError(null);
    const requestIdentity = identity;
    try {
      const summary = await unwrapStudio(window.subtitleStudio.applyBilingual({ documentId: page.summary.id, revision: page.summary.revision, options }));
      if (mounted.current && currentDocumentId.current === summary.id) { setOpen(false); onChanged(summary); }
    } catch (failure) {
      if (mounted.current && currentIdentity.current === requestIdentity) report(failure);
    } finally {
      operation.current = false;
      if (mounted.current) setApplying(false);
    }
  };

  if (!page.summary.bilingualAvailable) return null;
  return <>
    <StudioIconButton ref={trigger} label={t('studio:bilingual.action')} disabled={busy || !eligible || applying} onClick={() => { autoOpened.current = true; setOpen(true); }}><Columns2 /></StudioIconButton>
    <ScrollableDialog open={open} onOpenChange={value => { if (!applying) { autoOpened.current = true; setOpen(value); } }} maxWidth="sm:max-w-[720px]" contentClassName="studio-bilingual-dialog" onOpenAutoFocus={event => { event.preventDefault(); firstControl.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="relative p-3 pr-12">
        <DialogTitle className="flex items-center gap-2 text-base"><Columns2 className="size-4" />{t('studio:bilingual.title')}</DialogTitle>
        <DialogDescription className="text-xs"><StudioFileName name={page.summary.origin.displayName} /></DialogDescription>
      </ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-bilingual-content" fadeMaskHeight={16}>
        <div ref={optionsRegion} className="studio-bilingual-options">
          <ToolField label={t('studio:bilingual.source_order')} htmlFor={`${controlId}-source`}>
            <Select value={options.sourceSide} onValueChange={value => configure({ sourceSide: value as BilingualOptions['sourceSide'] })} disabled={applying || busy}>
              <SelectTrigger ref={firstControl} id={`${controlId}-source`} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="first">{t('studio:bilingual.first_source')}</SelectItem><SelectItem value="second">{t('studio:bilingual.second_source')}</SelectItem></SelectContent>
            </Select>
          </ToolField>
          <div className="studio-bilingual-checks">
            <label className="studio-bilingual-inline" htmlFor={`${controlId}-inline`}>
              <Checkbox id={`${controlId}-inline`} checked={options.splitInline} onCheckedChange={checked => configure({ splitInline: checked === true })} disabled={applying || busy} />
              <span>{t('studio:bilingual.split_inline')}</span>
            </label>
            <label className="studio-bilingual-inline" htmlFor={`${controlId}-review`}>
              <Checkbox id={`${controlId}-review`} checked={reviewOnly} onCheckedChange={checked => { setReviewOnly(checked === true); changePage(0); }} disabled={applying || busy} />
              <span>{t('studio:bilingual.review_only')}</span>
            </label>
          </div>
        </div>
        <p className="studio-bilingual-decision-note">{t('studio:bilingual.decision_note')}</p>
        {selectionLimit && <p className="studio-bilingual-error" role="alert">{t('studio:bilingual.selection_limit')}</p>}
        {error && <div className="studio-bilingual-error" role="alert"><AlertCircle className="size-4" /><span>{t(errorKeys[error])}</span><Button variant="ghost" size="sm" disabled={pending} onClick={() => setAttempt(value => value + 1)}><RefreshCw />{t('studio:retry')}</Button></div>}
        {!eligible && <p className="studio-bilingual-error" role="alert">{t('studio:bilingual.unavailable')}</p>}
        {visiblePreview ? <>
          <dl className="studio-bilingual-summary" aria-live="polite">
            <div><dt>{t('studio:bilingual.paired')}</dt><dd>{visiblePreview.pairedCount.toLocaleString()}</dd></div>
            <div><dt>{t('studio:bilingual.remaining')}</dt><dd>{visiblePreview.remainingCount.toLocaleString()}</dd></div>
            <div><dt>{t('studio:bilingual.review')}</dt><dd>{visiblePreview.reviewCount.toLocaleString()}</dd></div>
            <div><dt>{t('studio:bilingual.result_cues')}</dt><dd>{visiblePreview.cueCount.toLocaleString()}</dd></div>
          </dl>
          {visiblePreview.candidates.length ? <ol className="studio-bilingual-candidates" start={visiblePreview.offset + 1} aria-label={t('studio:bilingual.candidates')} aria-busy={loading}>
            {visiblePreview.candidates.map((candidate, index) => {
              const override = options.overrides.find(item => item.cueId === candidate.id);
              const selected = override ? override.splitAt === null ? 'keep' : `split:${override.splitAt}` : 'suggested';
              const source = options.sourceSide === 'first' ? candidate.first : candidate.second;
              const target = options.sourceSide === 'first' ? candidate.second : candidate.first;
              return <li key={candidate.id} data-review={candidate.needsReview || undefined} data-kept={selected === 'keep' || undefined}>
                <div className="studio-bilingual-candidate-heading">
                  <span className="studio-bilingual-number">{visiblePreview.offset + index + 1}</span>
                  <time>{formatStudioTime(candidate.startMs)}</time>
                  {candidate.needsReview && <span className="studio-bilingual-review"><AlertCircle className="size-3" />{t('studio:bilingual.review')}</span>}
                  <Select value={selected} onValueChange={value => choose(candidate, value)} disabled={pending || !currentPreview}>
                    <SelectTrigger aria-label={t('studio:bilingual.candidate_action', { number: visiblePreview.offset + index + 1 })} className="h-7 w-[148px] min-w-0 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent className="max-w-[min(28rem,calc(100vw-2rem))]">
                      <SelectItem value="suggested">{t('studio:bilingual.use_suggested')}</SelectItem>
                      {candidate.splitChoices.map(choice => <SelectItem key={choice.offset} value={`split:${choice.offset}`} className="whitespace-normal break-all">{choice.label}</SelectItem>)}
                      <SelectItem value="keep">{t('studio:bilingual.keep')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <dl className="studio-bilingual-pair">
                  <div><dt>{t('studio:bilingual.source_label', { language: languageName(preview?.sourceSide === options.sourceSide ? visiblePreview.sourceLanguage : visiblePreview.targetLanguage) })}</dt><dd>{source}</dd></div>
                  <div><dt>{t('studio:bilingual.target_label', { language: languageName(preview?.sourceSide === options.sourceSide ? visiblePreview.targetLanguage : visiblePreview.sourceLanguage) })}</dt><dd>{target}</dd></div>
                </dl>
              </li>;
            })}
          </ol> : <p className="studio-bilingual-empty">{reviewOnly ? t('studio:bilingual.no_review_candidates') : t('studio:bilingual.no_candidates')}</p>}
        </> : !error && eligible && <div className="studio-bilingual-loading" role="status"><LoaderCircle className="size-4 studio-spin" />{t('studio:loading')}</div>}
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="studio-bilingual-footer p-3">
        <div className="studio-bilingual-pagination">
          <StudioPagination offset={visiblePreview?.offset ?? 0} total={visiblePreview?.totalCandidates ?? 0} pageSize={PAGE_SIZE} busy={pending || !currentPreview} onChange={changePage} />
        </div>
        <div className="studio-bilingual-actions"><Button variant="ghost" size="sm" disabled={applying} onClick={() => setOpen(false)}>{t('studio:cancel')}</Button><Button size="sm" disabled={pending || !eligible || !currentPreview || currentPreview.pairedCount === 0} onClick={() => void apply()}>{applying ? <LoaderCircle className="studio-spin" /> : <Check />}{t('studio:bilingual.apply')}</Button></div>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}

export function StudioRemoveTranslation({ page, track, busy, onChanged, onError }: ChangeProps & { track: SubtitleDocument['translationTracks'][number] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const identity = `${page.summary.id}:${page.summary.revision}:${track.id}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const currentDocumentId = useRef(page.summary.id);
  currentDocumentId.current = page.summary.id;
  const hasActiveTask = page.tasks.some(task => task.status === 'queued' || task.status === 'running'
    || (task.trackId === track.id && (task.status === 'interrupted' || task.status === 'needs_configuration')));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setOpen(false); setError(null); }, [identity]);
  const remove = async () => {
    if (operation.current || busy || hasActiveTask) return;
    operation.current = true; setRemoving(true); setError(null);
    const requestIdentity = identity;
    try {
      const summary = await unwrapStudio(window.subtitleStudio.removeTranslationTrack({ documentId: page.summary.id, revision: page.summary.revision, trackId: track.id }));
      if (mounted.current && currentDocumentId.current === summary.id) { setOpen(false); onChanged(summary); }
    } catch (failure) {
      if (mounted.current && currentIdentity.current === requestIdentity) {
        const code = failure instanceof StudioError ? failure.code : 'document_unavailable';
        setError(code); onError(code);
      }
    } finally { operation.current = false; if (mounted.current) setRemoving(false); }
  };
  return <>
    <StudioIconButton ref={trigger} label={t('studio:remove_translation.action')} disabled={busy || removing || hasActiveTask} onClick={() => setOpen(true)}><Eraser /></StudioIconButton>
    <ScrollableDialog open={open} onOpenChange={value => { if (!removing) setOpen(value); }} onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="p-3 pr-12"><DialogTitle className="text-base">{t('studio:remove_translation.action')}</DialogTitle><DialogDescription className="text-xs leading-5">{t('studio:remove_translation.description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-bilingual-content" fadeMaskHeight={16}><StudioFileName name={page.summary.origin.displayName} />{error && <p className="studio-bilingual-error" role="alert">{t(errorKeys[error])}</p>}</ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap justify-end gap-2 p-3"><Button ref={cancel} variant="outline" size="sm" disabled={removing} onClick={() => setOpen(false)}>{t('studio:cancel')}</Button><Button variant="destructive" size="sm" disabled={removing || busy || hasActiveTask} onClick={() => void remove()}>{removing ? <LoaderCircle className="studio-spin" /> : <Eraser />}{t('studio:remove_translation.action')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
  </>;
}
