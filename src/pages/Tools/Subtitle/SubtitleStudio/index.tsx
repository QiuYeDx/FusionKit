import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowRight, Check, CheckCheck, ChevronDown, Code2, Copy, Ellipsis, FolderOpen, Library, List, LoaderCircle, RefreshCw, Subtitles, Trash2, X, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ClipPathTabs, ClipPathTabsContent } from '@/components/qiuye-ui/clip-path-tabs';
import ToolPageHeader from '../../_shared/ToolPageHeader';
import { TOOL_META } from '../../_shared/toolMeta';
import { ToolDetailLayout } from '../../_shared/ui/ToolDetailLayout';
import { ToolPanel } from '../../_shared/ui/ToolPanel';
import { ToolFilePickerSurface } from '../../_shared/ui/ToolFilePickerSurface';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { StudioObservations } from '@/services/subtitle-studio/observations';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { encodingSchema, StudioError, type Diagnostic, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { STUDIO_BATCH_LIMIT, type UnavailableDocument } from '@/subtitle-studio/batch-contract';
import { matchesLibraryQuery } from '@/subtitle-studio/library-query';
import useModelStore from '@/store/useModelStore';
import { translationModelSchema, normalizeTranslationModel } from '@/subtitle-studio/translation-contract';
import { formatStudioTime, StudioFileName, StudioIconButton, StudioPagination } from './StudioControls';
import { StudioTranslation, StudioTranslationStatus, StudioBatchTranslation } from './StudioTranslation';
import { StudioTranslationTask } from './StudioTranslationTask';
import { StudioExport, StudioBatchExport } from './StudioExport';
import { StudioLibrary, LIBRARY_PAGE_SIZE, defaultLibraryQuery, type LibraryQuery } from './StudioLibrary';
import { StudioRecovery } from './StudioRecovery';
import { StudioSelectedDocuments } from './StudioSelectedDocuments';
import { StudioBilingual, StudioRemoveTranslation } from './StudioBilingual';
import './studio.css';

const errorKeys: Record<ErrorCode, string> = {
  translation_output_limit: 'studio:errors.translation_output_limit',
  needs_configuration: 'studio:errors.needs_configuration', translation_protocol_invalid: 'studio:errors.translation_protocol_invalid', translation_failed: 'studio:errors.translation_failed', interrupted: 'studio:errors.interrupted',
  invalid_input: 'studio:errors.invalid_input', unsupported_feature: 'studio:errors.unsupported_feature', encoding_required: 'studio:errors.encoding_required', limit_exceeded: 'studio:errors.limit_exceeded', revision_conflict: 'studio:errors.revision_conflict', access_denied: 'studio:errors.access_denied', document_unavailable: 'studio:errors.document_unavailable', output_write_failed: 'studio:errors.output_write_failed',
};
const diagnosticKeys: Record<Diagnostic['code'], string> = {
  empty_document: 'studio:diagnostics.empty_document', unsupported_markup: 'studio:diagnostics.unsupported_markup', enhanced_lrc: 'studio:diagnostics.enhanced_lrc', negative_time: 'studio:diagnostics.negative_time', zero_duration: 'studio:diagnostics.zero_duration', untimed_text: 'studio:diagnostics.untimed_text',
};
type Activity = 'load' | 'import' | 'select' | 'export' | 'delete' | 'batch';
type OperationResult = { name: string; error?: ErrorCode; documentId?: string; skipped?: 'studio:library.no_cancel_task' | 'studio:library.no_resume_task' };

export default function SubtitleStudio() {
  const { t } = useTranslation();
  const { encoding, setEncoding, dismissedRecoveryKey, dismissRecovery } = useStudioPreferences();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [allTotal, setAllTotal] = useState(0);
  const [unavailable, setUnavailable] = useState<UnavailableDocument[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const recoveryKey = unavailable.map(item => `${item.id}:${item.token}`).sort().join('|');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [query, setQuery] = useState<LibraryQuery>(defaultLibraryQuery);
  const [loadedQuery, setLoadedQuery] = useState<LibraryQuery>(defaultLibraryQuery);
  const queryRef = useRef(query);
  const [selected, setSelected] = useState<DocumentSummary[]>([]);
  const [translationSlot, setTranslationSlot] = useState<HTMLSpanElement | null>(null);
  const [exportSlot, setExportSlot] = useState<HTMLSpanElement | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [results, setResults] = useState<{ title: string; items: OperationResult[] } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<'delete' | 'resume' | null>(null);
  const [selectionLimit, setSelectionLimit] = useState(false);
  const observedRevisions = useRef(new Map<string, number>());
  const [listOffset, setListOffset] = useState(0);
  const [page, setPage] = useState<DocumentPage | null>(null);
  const [activity, setActivity] = useState<Activity | null>('load');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [exported, setExported] = useState('');
  const [view, setView] = useState('preview');
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [deleting, setDeleting] = useState<DocumentSummary | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [trackId, setTrackId] = useState('');
  const [importedId, setImportedId] = useState('');
  const track = page?.translationTracks.find(item => item.id === trackId) ?? page?.translationTracks.at(-1);
  const observations = useRef(new StudioObservations());
  const currentPage = useRef<DocumentPage | null>(null);
  const currentOffset = useRef(0);
  const dirty = useRef(false);
  const refreshPending = useRef<() => void>(() => {});
  const showPage = (value: DocumentPage | null) => { currentPage.current = value; setPage(value); if (value && !value.summary.capabilities.preserveSource) setView('preview'); };
  const mounted = useRef(true);
  const operation = useRef(false);
  const retry = useRef<(() => void) | null>(null);
  const reader = useRef<HTMLDivElement>(null);
  const busy = activity !== null || query !== loadedQuery;
  const diagnostics = useMemo(() => {
    const counts = new Map<Diagnostic['code'], number>();
    for (const diagnostic of page?.summary.diagnostics ?? []) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
    return [...counts];
  }, [page?.summary]);
  const flaggedNodes = useMemo(() => new Set(page?.summary.diagnostics.map(item => item.nodeId).filter(Boolean)), [page?.summary]);

  const run = async (kind: Activity, action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setActivity(kind); setError(null); setExported('');
    retry.current = () => void run(kind, action);
    try { await action(); }
    catch (failure) { if (mounted.current) setError(failure instanceof StudioError ? failure.code : 'document_unavailable'); }
    finally { operation.current = false; if (mounted.current) { setActivity(null); if (dirty.current) queueMicrotask(() => refreshPending.current()); } }
  };
  const select = async (doc: DocumentSummary, offset = 0, nodeOffset = 0) => {
    const previous = currentPage.current;
    const result = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset, nodeOffset }));
    if (mounted.current && observations.current.acceptsDocument(result.summary)) {
      showPage(result); setCopied(null); setCopyFailed(false);
      if (previous?.summary.id !== doc.id || previous.offset !== offset || previous.nodeOffset !== nodeOffset) reader.current?.scrollTo({ top: 0 });
    }
  };
  const load = async (offset: number, openFirst = false): Promise<void> => {
    const requestedQuery = queryRef.current;
    const request = { ...requestedQuery, offset, pageSize: LIBRARY_PAGE_SIZE };
    let result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
    for (let attempt = 0; !observations.current.acceptSnapshot(result); attempt++) {
      if (!mounted.current) return;
      if (attempt >= 3) throw new StudioError('revision_conflict');
      result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
    }
    if (!mounted.current) return;
    if (requestedQuery !== queryRef.current) { dirty.current = true; return; }
    if (offset > 0 && offset >= result.total) return load(Math.max(0, Math.floor((result.total - 1) / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE), openFirst);
    currentOffset.current = offset;
    setLoadedQuery(requestedQuery);
    setDocuments(result.documents); setTotal(result.total); setListOffset(offset);
    setAllTotal(result.allTotal ?? result.total); setUnavailable(result.unavailable ?? []);
    const refreshedSelection = new Map(result.documents.map(doc => [doc.id, doc]));
    for (const item of selectedRef.current) {
      const revision = observedRevisions.current.get(item.id);
      if (refreshedSelection.has(item.id) || !revision || revision <= item.revision) continue;
      try {
        const updated = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: item.id, revision, offset: 0 }));
        if (observations.current.acceptsDocument(updated.summary)) refreshedSelection.set(item.id, updated.summary);
      } catch (failure) {
        if (!(failure instanceof StudioError) || !['revision_conflict', 'document_unavailable', 'access_denied'].includes(failure.code)) throw failure;
        // An event racing this read schedules the next refresh; deleted items are removed by the subscription.
      }
    }
    setSelected(items => items.map(item => refreshedSelection.get(item.id) ?? item));
    const preview = currentPage.current;
    if (preview) {
      const refreshed = result.documents.find(doc => doc.id === preview.summary.id);
      const revision = observedRevisions.current.get(preview.summary.id);
      if (refreshed) await select(refreshed, preview.offset, preview.nodeOffset);
      else if (revision && revision > preview.summary.revision) await select({ ...preview.summary, revision }, preview.offset, preview.nodeOffset);
    } else if (openFirst && result.documents[0]) {
      await select(result.documents[0]);
    }
  };
  refreshPending.current = () => {
    if (!mounted.current || operation.current || !dirty.current) return;
    dirty.current = false;
    void run('load', () => load(currentOffset.current, !currentPage.current));
  };
  const deleteDocument = () => {
    if (!deleting) return;
    const document = deleting;
    setDeleting(null);
    void run('delete', async () => {
      const result = await unwrapStudio(window.subtitleStudio.deleteDocument({ documentId: document.id, revision: document.revision }));
      if (!mounted.current) return;
      setCleanupPending(result.cleanupPending);
      if (currentPage.current?.summary.id === document.id) showPage(null);
      await load(currentOffset.current, true);
    });
  };
  const importDocument = () => void run('import', async () => {
    const result = await unwrapStudio(window.subtitleStudio.importSubtitles({ encoding }));
    if (!result || !mounted.current) return;
    const onlyItem = result.items.length === 1 ? result.items[0] : undefined;
    if (onlyItem && !onlyItem.ok) throw new StudioError(onlyItem.error);
    const added = result.items.flatMap(item => item.ok ? [item.document] : []);
    changeQuery(defaultLibraryQuery); setSelected([]);
    await load(0);
    if (added[0]) { await select(added[0]); setView('preview'); setImportedId(result.items.length === 1 ? added[0].id : ''); }
    if (result.items.length > 1 || result.items.some(item => !item.ok)) setResults({ title: t('studio:library.import_result'), items: result.items.map(item => ({ name: item.fileName, ...(item.ok ? { documentId: item.document.id } : { error: item.error }) })) });
  });
  const chooseDocument = (doc: DocumentSummary) => void run('select', async () => { await select(doc); if (mounted.current) { setView('preview'); setLibraryOpen(false); } });
  const copyCue = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); if (mounted.current) { setCopied(id); setCopyFailed(false); } }
    catch { if (mounted.current) setCopyFailed(true); }
  };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.subtitleStudio.subscribe(event => {
      if (!mounted.current || !observations.current.observe(event)) return;
      observedRevisions.current.set(event.documentId, event.revision);
      if (event.deleted) setSelected(items => items.filter(item => item.id !== event.documentId));
      if (event.deleted) {
        setDocuments(items => items.filter(item => item.id !== event.documentId));
        if (currentPage.current?.summary.id === event.documentId) showPage(null);
        setDeleting(value => value?.id === event.documentId ? null : value);
      }
      dirty.current = true;
      refreshPending.current();
    });
    void run('load', () => load(0, true));
    return () => { mounted.current = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timeout);
  }, [copied]);
  useEffect(() => { reader.current?.scrollTo({ top: 0 }); }, [view]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const change = () => { setWide(media.matches); if (media.matches) setLibraryOpen(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const changeQuery = (next: LibraryQuery) => {
    if (next.query !== queryRef.current.query || next.format !== queryRef.current.format || next.status !== queryRef.current.status) setSelected([]);
    queryRef.current = next; setQuery(next); currentOffset.current = 0;
    dirty.current = true;
  };
  useEffect(() => {
    const timer = window.setTimeout(() => refreshPending.current(), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const toggleDocument = (doc: DocumentSummary) => {
    if (selected.some(item => item.id === doc.id)) setSelected(items => items.filter(item => item.id !== doc.id));
    else if (selected.length >= STUDIO_BATCH_LIMIT) setSelectionLimit(true);
    else setSelected(items => [...items, doc]);
  };
  const selectPage = () => {
    const additions = documents.filter(doc => !selected.some(item => item.id === doc.id));
    if (selected.length + additions.length > STUDIO_BATCH_LIMIT) setSelectionLimit(true);
    else setSelected(items => [...items, ...additions]);
  };
  const selectAll = () => {
    if (total > STUDIO_BATCH_LIMIT) { setSelectionLimit(true); return; }
    void run('select', async () => {
      const requested = queryRef.current;
      const request = { ...requested, offset: 0, pageSize: STUDIO_BATCH_LIMIT };
      let result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
      for (let attempt = 0; !observations.current.acceptSnapshot(result); attempt++) {
        if (!mounted.current) return;
        if (attempt >= 3) throw new StudioError('revision_conflict');
        result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
      }
      if (!mounted.current) return;
      if (requested !== queryRef.current) { dirty.current = true; return; }
      if (result.total > STUDIO_BATCH_LIMIT) { setSelectionLimit(true); return; }
      const merged = new Map(selectedRef.current.map(doc => [doc.id, doc]));
      for (const doc of result.documents) merged.set(doc.id, doc);
      if (merged.size > STUDIO_BATCH_LIMIT) { setSelectionLimit(true); return; }
      setSelected([...merged.values()]);
    });
  };
  const processSelected = (kind: 'delete' | 'cancel' | 'resume') => {
    const targets = [...selected];
    setBatchConfirm(null);
    void run('batch', async () => {
      const items: OperationResult[] = [];
      for (const target of targets) {
        if (!mounted.current) break;
        try {
          // Resolve the current revision and task at execution; selection itself never starts work.
          const revision = Math.max(observedRevisions.current.get(target.id) ?? 0, target.revision);
          const current = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: target.id, revision, offset: 0 }));
          if (kind === 'delete') {
            const result = await unwrapStudio(window.subtitleStudio.deleteDocument({ documentId: target.id, revision: current.summary.revision }));
            if (result.cleanupPending) setCleanupPending(true);
            if (currentPage.current?.summary.id === target.id) showPage(null);
          } else {
            const task = [...current.tasks].reverse().find(item => item.translation && (kind === 'cancel' ? ['queued', 'running', 'failed', 'interrupted', 'needs_configuration'].includes(item.status) : ['failed', 'interrupted', 'needs_configuration'].includes(item.status)));
            if (!task) { items.push({ name: target.origin.displayName, documentId: target.id, skipped: kind === 'cancel' ? 'studio:library.no_cancel_task' : 'studio:library.no_resume_task' }); continue; }
            const request = { documentId: target.id, revision: current.summary.revision, taskId: task.id };
            if (kind === 'cancel') await unwrapStudio(window.subtitleStudio.cancelTask(request));
            else {
              const profile = useModelStore.getState().profiles.find(item => item.id === task.translation!.config.model.profileId);
              const model = translationModelSchema.safeParse(profile ? { profileId: profile.id, modelKey: profile.modelKey, endpoint: profile.baseUrl, apiFormat: profile.apiFormat, outputTokenParameter: profile.outputTokenParameter } : null);
              if (!model.success || !profile?.apiKey.trim() || JSON.stringify(normalizeTranslationModel(model.data)) !== JSON.stringify(normalizeTranslationModel(task.translation!.config.model))) throw new StudioError('needs_configuration');
              await unwrapStudio(window.subtitleStudio.resumeTask({ ...request, model: model.data, apiKey: profile.apiKey }));
            }
          }
          items.push({ name: target.origin.displayName, documentId: target.id });
        } catch (failure) { items.push({ name: target.origin.displayName, documentId: target.id, error: failure instanceof StudioError ? failure.code : 'document_unavailable' }); }
      }
      if (!mounted.current) return;
      if (kind === 'delete') setSelected(values => values.filter(value => !items.some(item => item.documentId === value.id && !item.error)));
      setResults({ title: t(kind === 'delete' ? 'studio:library.delete_result' : kind === 'resume' ? 'studio:library.resume_result' : 'studio:library.cancel_result'), items });
      await load(currentOffset.current, true);
    });
  };

  const encodingField = <Select value={encoding} onValueChange={value => setEncoding(encodingSchema.parse(value))} disabled={busy}>
    <SelectTrigger aria-label={t('studio:encoding')} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
    <SelectContent>{encodingSchema.options.map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent>
  </Select>;
  const documentPicker = <Select value={documents.some(doc => doc.id === page?.summary.id) ? page?.summary.id : ''} onValueChange={id => { const doc = documents.find(item => item.id === id); if (doc) chooseDocument(doc); }} disabled={busy || !documents.length}>
    <SelectTrigger aria-label={t('studio:select_document')} className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder={t('studio:select_document')}>{page && documents.some(doc => doc.id === page.summary.id) ? <StudioFileName name={page.summary.origin.displayName} /> : undefined}</SelectValue></SelectTrigger>
    <SelectContent className="max-w-[calc(100vw-2rem)]">{documents.map(doc => <SelectItem key={doc.id} value={doc.id} className="whitespace-normal break-all">{doc.origin.displayName}</SelectItem>)}</SelectContent>
  </Select>;
  const refresh = <StudioIconButton label={t('studio:refresh')} disabled={busy} onClick={() => void run('load', () => load(listOffset, !page))}><RefreshCw className={activity === 'load' ? 'studio-spin' : ''} /></StudioIconButton>;
  const onBatchChanged = () => { dirty.current = true; refreshPending.current(); };
  const batchActions = <>
    <span ref={setTranslationSlot} />
    <span ref={setExportSlot} />
    <DropdownMenu>
      <Tooltip delayDuration={350}><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button id="studio-library-batch-actions" variant="ghost" size="icon-sm" aria-label={t('studio:library.batch_actions')} disabled={busy || !selected.length}><Ellipsis /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>{t('studio:library.batch_actions')}</TooltipContent></Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-48" onCloseAutoFocus={event => { if (batchConfirm) event.preventDefault(); }}>
        <DropdownMenuItem disabled={busy || !selected.some(doc => doc.task && ['failed', 'interrupted', 'needs_configuration'].includes(doc.task.status))} onSelect={() => setBatchConfirm('resume')}><Play />{t('studio:library.resume_selected')}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !selected.some(doc => doc.task && ['queued', 'running', 'failed', 'interrupted', 'needs_configuration'].includes(doc.task.status))} onSelect={() => processSelected('cancel')}><Square />{t('studio:library.cancel_selected')}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !selected.length} onSelect={() => setBatchConfirm('delete')}><Trash2 />{t('studio:library.delete_selected')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy || !selected.length} onSelect={() => setSelected([])}><X />{t('studio:library.clear_selection')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
  const recoveryButton = unavailable.length > 0 ? <Button data-testid="studio-recovery-manage" variant="ghost" size="sm" onClick={() => setRecoveryOpen(true)}><AlertCircle className="text-amber-600 dark:text-amber-400" />{t('studio:recovery.count', { count: unavailable.length })}</Button> : null;
  const library = <StudioLibrary documents={documents} selected={selected} previewId={page?.summary.id} query={query} onQuery={changeQuery} total={total} allTotal={allTotal} offset={listOffset} busy={busy} onPage={offset => void run('load', () => load(offset))} onPreview={chooseDocument} onToggle={toggleDocument} onSelectPage={selectPage} onSelectAll={selectAll} onClearScope={() => setSelected(items => items.filter(doc => !matchesLibraryQuery(doc, queryRef.current)))} onClear={() => setSelected([])} selectionLimit={selectionLimit} onDismissLimit={() => setSelectionLimit(false)} encoding={encodingField} actions={batchActions} />;

  return <div data-testid="subtitle-studio" className={page ? 'studio studio-has-document' : 'studio'}>
    <ToolDetailLayout
      className="studio-layout"
      header={<ToolPageHeader meta={TOOL_META.subtitleStudio} title={t('studio:title')} right={<Badge variant="secondary" className="font-mono text-[11px] font-normal">SRT / LRC</Badge>} />}
      asideClassName="hidden lg:block"
      mainClassName="studio-main"
      aside={wide ? <div className="studio-library"><ToolPanel className="studio-library-panel" title={t('studio:documents')} icon={Library} badge={<Badge variant="secondary" className="font-mono text-[11px]">{allTotal}</Badge>} actions={refresh}>{recoveryButton}{library}</ToolPanel></div> : undefined}
    >
      <ToolFilePickerSurface title={t('studio:import')} description={t('studio:library.import_hint')} actionLabel={t('studio:open_file')} disabled={busy} onSelect={importDocument} icon={activity === 'import' ? <LoaderCircle className="h-5 w-5 studio-spin" /> : undefined} className="studio-import" />
      <div className="studio-mobile-controls lg:hidden">
        <StudioIconButton id="studio-library-trigger" label={t('studio:library.open')} onClick={() => setLibraryOpen(true)}><Library /></StudioIconButton>
        <div className="min-w-0 flex-1 studio-mobile-picker">{documentPicker}</div>
        <div className="w-[116px] shrink-0">{encodingField}</div>
        {page && <StudioIconButton label={t('studio:open_file')} disabled={busy} onClick={importDocument}>{activity === 'import' ? <LoaderCircle className="studio-spin" /> : <FolderOpen />}</StudioIconButton>}
        {refresh}{recoveryButton}
      </div>
      {error && <div role="alert" className="studio-notice text-destructive border-destructive/20 bg-destructive/5"><AlertCircle /><span>{t(errorKeys[error])}</span>{retry.current && <Button size="sm" variant="ghost" disabled={busy} onClick={() => retry.current?.()}>{t('studio:retry')}</Button>}<StudioIconButton label={t('studio:dismiss')} onClick={() => setError(null)}><X /></StudioIconButton></div>}
      {unavailable.length > 0 && recoveryKey !== dismissedRecoveryKey && <div role="status" data-testid="studio-recovery-warning" className="studio-notice"><AlertCircle className="text-amber-600 dark:text-amber-400" /><span>{t('studio:unavailable_documents', { count: unavailable.length })}</span><Button variant="ghost" size="sm" onClick={() => setRecoveryOpen(true)}>{t('studio:recovery.view')}</Button><StudioIconButton label={t('studio:dismiss')} onClick={() => dismissRecovery(recoveryKey)}><X /></StudioIconButton></div>}
      {exported && <div role="status" className="studio-notice"><CheckCheck className="text-emerald-600 dark:text-emerald-400" /><span>{t('studio:exported', { name: exported })}</span><StudioIconButton label={t('studio:dismiss')} onClick={() => setExported('')}><X /></StudioIconButton></div>}
      {cleanupPending && <div role="status" className="studio-notice"><AlertCircle /><span>{t('studio:cleanup_pending')}</span><StudioIconButton label={t('studio:dismiss')} onClick={() => setCleanupPending(false)}><X /></StudioIconButton></div>}
      <span className="sr-only" role="status">{busy ? t('studio:loading') : copied ? t('studio:copied') : ''}</span>
      {copyFailed && <div role="alert" className="studio-notice text-destructive"><AlertCircle /><span>{t('studio:copy_failed')}</span><StudioIconButton label={t('studio:dismiss')} onClick={() => setCopyFailed(false)}><X /></StudioIconButton></div>}
      <div aria-busy={busy} className="studio-preview-region">
        <ToolPanel
          title={t('studio:preview')}
          icon={Subtitles}
          badge={page ? <Badge variant="secondary" className="font-mono text-[11px]">{page.summary.cueCount}</Badge> : undefined}
          actions={page ? <><StudioBilingual page={page} busy={busy} autoOpen={importedId === page.summary.id} onError={code => { retry.current = null; setError(code); }} onChanged={doc => { setImportedId(''); void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} /><StudioTranslation page={page} busy={busy} onError={code => { retry.current = null; setError(code); }} onStarted={onBatchChanged} /><StudioExport page={page} trackId={track?.id} busy={busy} onError={code => { retry.current = null; setError(code); }} onExported={setExported} /><StudioIconButton id="studio-delete-trigger" label={t('studio:delete_document')} disabled={busy} onClick={() => setDeleting(page.summary)}><Trash2 /></StudioIconButton></> : undefined}
          className="studio-preview-panel"
          footer={page ? <div className="studio-reader-footer"><span className="flex items-center gap-1.5 text-[11px] text-muted-foreground studio-footer-status">{busy ? <LoaderCircle className="h-3.5 w-3.5 studio-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}{busy ? t('studio:loading') : t(page.summary.capabilities.preserveSource ? 'studio:source_preserved' : 'studio:transcription_preserved')}</span><StudioPagination offset={view === 'raw' ? page.nodeOffset : page.offset} total={view === 'raw' ? page.nodeCount : page.summary.cueCount} busy={busy} onChange={offset => void run('select', () => select(page.summary, view === 'raw' ? page.offset : offset, view === 'raw' ? offset : page.nodeOffset))} /></div> : undefined}
        >
          {page ? <>
            {track && <div className="studio-translation-toolbar">
              <Select value={track.id} onValueChange={setTrackId}><SelectTrigger aria-label={t('studio:translation_track')} className="h-7 w-[160px] shrink-0 text-xs"><SelectValue /></SelectTrigger><SelectContent>{page.translationTracks.map((item, index) => <SelectItem key={item.id} value={item.id}>{item.language === 'und' ? t('studio:language_unknown') : item.language} · {index + 1}</SelectItem>)}</SelectContent></Select>
              <StudioRemoveTranslation page={page} track={track} busy={busy} onError={code => { retry.current = null; setError(code); }} onChanged={doc => { setTrackId(''); void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} />
            <StudioTranslationStatus page={page} trackId={track.id} />
            <StudioTranslationTask page={page} trackId={track.id} busy={busy} onError={code => { retry.current = null; setError(code); }} onChanged={() => { dirty.current = true; refreshPending.current(); }} />
            </div>}
            <ClipPathTabs value={view} onValueChange={setView} ariaLabel={t('studio:document_view')} shape="rounded" smoothCorners size="sm" className="studio-tabs w-full gap-0" transitionDuration={200} transitionEasing="ease-out" items={[
              { value: 'preview', label: t('studio:preview'), icon: <List /> },
              ...(page.summary.capabilities.preserveSource ? [{ value: 'raw', label: t('studio:original_nodes'), icon: <Code2 /> }] : []),
            ]}>
              <div className="studio-document-heading">
                <h2 className="text-sm font-medium"><StudioFileName name={page.summary.origin.displayName} focusable /></h2>
                <div className="studio-document-meta text-[11px] text-muted-foreground">
                  <Badge variant="outline" className="font-mono text-[10px] font-normal">{page.summary.origin.format.toUpperCase()}</Badge>
                  {'encoding' in page.summary.origin && <span>{page.summary.origin.encoding.toUpperCase()}</span>}
                  <span>{track ? t(track.origin === 'imported' ? 'studio:translation_imported' : 'studio:translation_unreviewed') : t('studio:source_only')}</span>
                </div>
              </div>
              {diagnostics.length > 0 && <details className="studio-diagnostics border-t bg-muted/30" key={page.summary.id}><summary><AlertCircle className="text-amber-600 dark:text-amber-400" /><span>{t('studio:document_checks')}</span><Badge variant="secondary" className="font-mono text-[10px]">{page.summary.diagnostics.length}</Badge><ChevronDown className="studio-disclosure" /></summary><ul>{diagnostics.map(([code, count]) => <li key={code}><span>{t(diagnosticKeys[code])}</span><span className="shrink-0 font-mono text-[10px]">{count}</span></li>)}</ul></details>}
              <div className="studio-reader border-t" ref={reader}>
                <ClipPathTabsContent value="preview">
                  {page.cues.length ? <table aria-label={t('studio:preview')} className={track ? 'studio-cue-table studio-translated-table' : 'studio-cue-table'}><thead><tr><th scope="col">#</th><th scope="col">{t('studio:time')}</th><th scope="col">{track ? <div className="studio-parallel-text"><span>{t('studio:source')}</span><span>{t('studio:target')}</span></div> : t('studio:source')}</th><th scope="col"><span className="sr-only">{t('studio:copy')}</span></th></tr></thead><tbody>{page.cues.map((cue, index) => <tr key={cue.id} data-warning={flaggedNodes.has(cue.nodeId) || undefined}>
                    <td className="studio-cue-number">{page.offset + index + 1}</td>
                    <td className="studio-cue-time"><div className="studio-time-range"><span>{formatStudioTime(cue.timing.startMs)}</span><ArrowRight aria-hidden="true" /><span className="text-muted-foreground/70">{cue.timing.endMs === null ? t('studio:unknown_end') : formatStudioTime(cue.timing.endMs)}</span></div></td>
                    <td className="studio-cue-text"><div className={track ? 'studio-parallel-text' : undefined}><div>{cue.source.spans.map((span, i) => <span key={i} style={{ fontWeight: span.marks.includes('b') ? 650 : undefined, fontStyle: span.marks.includes('i') ? 'italic' : undefined, textDecoration: span.marks.includes('u') ? 'underline' : undefined }}>{span.text}</span>)}</div>{track && <div className="studio-target-text">{track.entries[cue.id] ? <>{track.entries[cue.id].sourceRevision !== cue.sourceRevision && <span className="block text-xs text-amber-600">{t('studio:translation_stale')}</span>}{track.entries[cue.id].text.spans.map((span, i) => <span key={i} style={{ fontWeight: span.marks.includes('b') ? 650 : undefined, fontStyle: span.marks.includes('i') ? 'italic' : undefined, textDecoration: span.marks.includes('u') ? 'underline' : undefined }}>{span.text}</span>)}</> : <span className="text-xs text-muted-foreground">{cue.source.plain.trim() ? t('studio:translation_missing') : ''}</span>}</div>}</div></td>
                    <td className="studio-cue-action"><StudioIconButton size="icon-xs" className={copied === cue.id ? 'studio-copy text-emerald-600 dark:text-emerald-400 is-copied' : 'studio-copy text-muted-foreground'} label={copied === cue.id ? t('studio:copied') : t('studio:copy')} onClick={() => void copyCue(cue.id, cue.source.plain)}>{copied === cue.id ? <Check /> : <Copy />}</StudioIconButton></td>
                  </tr>)}</tbody></table> : <div className="studio-content-empty"><Subtitles /><p>{t('studio:diagnostics.empty_document')}</p></div>}
                </ClipPathTabsContent>
                <ClipPathTabsContent value="raw" className="studio-raw"><ol start={page.nodeOffset + 1}>{page.rawNodes.map((node, index) => <li key={node.id}><span aria-hidden="true">{page.nodeOffset + index + 1}</span><pre>{node.text}</pre></li>)}</ol>{!page.rawNodes.length && <div className="studio-content-empty"><Code2 /><p>{t('studio:no_source_content')}</p></div>}</ClipPathTabsContent>
              </div>
            </ClipPathTabs>
          </> : <div className="studio-content-empty py-14">{busy ? <LoaderCircle className="studio-spin" /> : <Subtitles />}<p>{busy ? t('studio:loading') : t('studio:empty')}</p></div>}
        </ToolPanel>
      </div>
    </ToolDetailLayout>
    <StudioBatchTranslation triggerContainer={translationSlot} documents={selected} busy={busy} onError={code => { retry.current = null; setError(code); }} onStarted={onBatchChanged} />
    <StudioBatchExport triggerContainer={exportSlot} documents={selected} busy={busy} onError={code => { retry.current = null; setError(code); }} onExported={setExported} />
    {!wide && <ScrollableDialog open={libraryOpen} onOpenChange={setLibraryOpen} maxWidth="sm:max-w-[540px]" contentClassName="studio-library-dialog" onOpenAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLInputElement>('[data-testid=studio-library-search]')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); document.getElementById('studio-library-trigger')?.focus(); }}><ScrollableDialogHeader><DialogTitle>{t('studio:documents')} · {allTotal}</DialogTitle><DialogDescription className="sr-only">{t('studio:library.selection_rule')}</DialogDescription></ScrollableDialogHeader><ScrollableDialogContent>{library}</ScrollableDialogContent></ScrollableDialog>}
    <StudioRecovery open={recoveryOpen} onOpenChange={setRecoveryOpen} documents={unavailable} onChanged={pending => { if (pending) setCleanupPending(true); dirty.current = true; refreshPending.current(); }} onError={code => { retry.current = null; setError(code); }} />
    <ScrollableDialog open={!!batchConfirm} maxWidth="sm:max-w-[560px]" contentClassName="studio-batch-confirm-dialog" onOpenChange={open => { if (!open) setBatchConfirm(null); }} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-batch-cancel')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); (document.getElementById('studio-library-batch-actions') ?? document.querySelector<HTMLElement>('[data-testid=studio-library-select-all]'))?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="relative p-3 pr-12"><DialogTitle className="flex items-center gap-2 text-sm">{batchConfirm === 'delete' ? <Trash2 className="size-4" /> : <Play className="size-4" />}{t(batchConfirm === 'delete' ? 'studio:library.delete_selected' : 'studio:library.resume_selected')}</DialogTitle><DialogDescription className="text-xs leading-5">{t(batchConfirm === 'delete' ? 'studio:delete_description' : 'studio:library.resume_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-batch-confirm-content"><div className="space-y-3"><StudioSelectedDocuments documents={selected} collapsible={false} />{batchConfirm === 'resume' && <p className="text-xs leading-5 text-amber-600 dark:text-amber-400">{t('studio:library.resume_uncertain')}</p>}</div></ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3"><Button id="studio-batch-cancel" variant="ghost" size="sm" onClick={() => setBatchConfirm(null)}>{t('studio:cancel')}</Button><Button size="sm" variant={batchConfirm === 'delete' ? 'destructive' : 'default'} disabled={busy} onClick={() => batchConfirm && processSelected(batchConfirm)}>{t(batchConfirm === 'delete' ? 'studio:library.confirm_delete' : 'studio:library.confirm_resume')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog open={!!results} onOpenChange={open => { if (!open) setResults(null); }} maxWidth="sm:max-w-[600px]" onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-result-close')?.focus(); }}>
      <ScrollableDialogHeader><DialogTitle>{results?.title}</DialogTitle><DialogDescription>{t('studio:library.result_summary', { success: results?.items.filter(item => !item.error && !item.skipped).length ?? 0, skipped: results?.items.filter(item => item.skipped).length ?? 0, failed: results?.items.filter(item => item.error).length ?? 0 })}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent><ul data-testid="studio-library-result" className="studio-operation-results">{results?.items.map((item, index) => <li key={`${item.name}:${index}`}><span className="break-all">{item.name}</span><span className={item.error ? 'text-destructive' : 'text-muted-foreground'}>{item.error ? t(errorKeys[item.error]) : item.skipped ? t(item.skipped) : t('studio:library.succeeded')}</span></li>)}</ul></ScrollableDialogContent>
      <ScrollableDialogFooter className="flex justify-end"><Button id="studio-result-close" variant="outline" size="sm" onClick={() => setResults(null)}>{t('studio:recovery.close')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-delete-cancel')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); document.getElementById('studio-delete-trigger')?.focus(); }}>
      <ScrollableDialogHeader><DialogTitle className="pr-6">{t('studio:delete_document')}</DialogTitle><DialogDescription>{t('studio:delete_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent><p className="break-all text-sm">{deleting?.origin.displayName}</p></ScrollableDialogContent>
      <ScrollableDialogFooter><div className="flex justify-end gap-2"><Button id="studio-delete-cancel" variant="outline" onClick={() => setDeleting(null)}>{t('studio:cancel')}</Button><Button variant="destructive" disabled={busy} onClick={deleteDocument}><Trash2 />{t('studio:delete_document')}</Button></div></ScrollableDialogFooter>
    </ScrollableDialog>
  </div>;
}
