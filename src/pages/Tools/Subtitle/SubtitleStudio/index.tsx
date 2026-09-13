import { StudioRevealSource } from './StudioRevealSource';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowRight, AudioLines, CheckCheck, ChevronDown, Code2, Ellipsis, FolderOpen, Library, List, LoaderCircle, RefreshCw, Subtitles, Trash2, X, Play, Square } from 'lucide-react';
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
import { StudioRefreshCoordinator } from '@/services/subtitle-studio/refresh-coordinator';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { encodingSchema, StudioError, type Diagnostic, type ErrorCode } from '@/subtitle-studio/domain';
import type { DocumentListSnapshot, DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { STUDIO_BATCH_LIMIT, type UnavailableDocument, type BatchImportResult } from '@/subtitle-studio/batch-contract';
import { matchesLibraryQuery } from '@/subtitle-studio/library-query';
import useModelStore from '@/store/useModelStore';
import { translationModelSchema, normalizeTranslationModel } from '@/subtitle-studio/translation-contract';
import { formatStudioTime, StudioFileName, StudioIconButton, StudioPagination } from './StudioControls';
import { StudioTranslation, StudioTranslationStatus, StudioBatchTranslation } from './StudioTranslation';
import { StudioTranslationTask } from './StudioTranslationTask';
import { StudioTranslationOverview } from './StudioTranslationOverview';
import { StudioExport, StudioBatchExport } from './StudioExport';
import { StudioLibrary, LIBRARY_PAGE_SIZE, defaultLibraryQuery, type LibraryQuery } from './StudioLibrary';
import { StudioRecovery } from './StudioRecovery';
import { StudioSelectedDocuments } from './StudioSelectedDocuments';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';
import { StudioBilingual, StudioRemoveTranslation } from './StudioBilingual';
import { StudioTranscription } from './StudioTranscription';
import { StudioCueCopy } from './StudioCueCopy';
import { STUDIO_RESULT_DIALOG_CLASS, STUDIO_RESULT_DIALOG_WIDTH, StudioOperationResult } from './StudioOperationResult';
import './studio.css';

const errorKeys: Record<ErrorCode, string> = {
  resource_busy: 'studio:errors.resource_busy',
  translation_output_limit: 'studio:errors.translation_output_limit',
  needs_configuration: 'studio:errors.needs_configuration', translation_protocol_invalid: 'studio:errors.translation_protocol_invalid', translation_failed: 'studio:errors.translation_failed', interrupted: 'studio:errors.interrupted',
  transcription_failed: 'studio:errors.transcription_failed',
  invalid_input: 'studio:errors.invalid_input', unsupported_feature: 'studio:errors.unsupported_feature', encoding_required: 'studio:errors.encoding_required', limit_exceeded: 'studio:errors.limit_exceeded', revision_conflict: 'studio:errors.revision_conflict', access_denied: 'studio:errors.access_denied', document_unavailable: 'studio:errors.document_unavailable', output_write_failed: 'studio:errors.output_write_failed',
};
const diagnosticKeys: Record<Diagnostic['code'], string> = {
  opaque_structure: 'studio:diagnostics.opaque_structure', ass_drawing: 'studio:diagnostics.ass_drawing', ass_karaoke: 'studio:diagnostics.ass_karaoke', vtt_payload_unsupported: 'studio:diagnostics.vtt_payload_unsupported',
  empty_document: 'studio:diagnostics.empty_document', unsupported_markup: 'studio:diagnostics.unsupported_markup', enhanced_lrc: 'studio:diagnostics.enhanced_lrc', negative_time: 'studio:diagnostics.negative_time', zero_duration: 'studio:diagnostics.zero_duration', untimed_text: 'studio:diagnostics.untimed_text',
};
type Activity = 'load' | 'import' | 'select' | 'export' | 'delete' | 'batch';
type OperationResult = { name: string; error?: ErrorCode; documentId?: string; skipped?: 'studio:library.no_cancel_task' | 'studio:library.no_resume_task' };
type WorkspaceView = 'documents' | 'transcription';
let lastWorkspaceView: WorkspaceView = 'documents';

export default function SubtitleStudio() {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(lastWorkspaceView);
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const resetWorkspaceScroll = () => {
    const viewport = workspaceRoot.current?.closest('[data-radix-scroll-area-viewport]');
    if (viewport) viewport.scrollTop = 0;
  };
  const changeWorkspaceView = (value: string) => {
    if (value !== 'documents' && value !== 'transcription') return;
    if (value === workspaceView) return;
    invalidateSelectionRequest();
    resetWorkspaceScroll();
    lastWorkspaceView = value; setWorkspaceView(value); dragDepth.current = 0; setDragging(false);
  };
  useLayoutEffect(resetWorkspaceScroll, [workspaceView]);
  const { encoding, setEncoding, dismissedRecoveryKey, dismissRecovery } = useStudioPreferences();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const librarySnapshot = useRef<DocumentListSnapshot | null>(null);
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
  const selectionGeneration = useRef(0);
  const selectionRequest = useRef<{ generation: number; query: LibraryQuery } | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const invalidateSelectionRequest = () => {
    selectionGeneration.current++; selectionRequest.current = null;
    if (mounted.current) setSelectionPending(false);
  };
  const updateSelection = (update: (items: DocumentSummary[]) => DocumentSummary[]) => {
    const next = update(selectedRef.current);
    selectedRef.current = next; setSelected(next);
  };
  const clearSelection = () => { invalidateSelectionRequest(); updateSelection(() => []); };
  const [results, setResults] = useState<{ kind: 'import' | 'delete' | 'cancel' | 'resume'; items: OperationResult[] } | null>(null);
  const resultReceipt = useRef<NonNullable<typeof results> | null>(null);
  // Radix keeps the dialog mounted during its exit animation. Retain only its
  // receipt; open state still requires a new result, which replaces this snapshot.
  if (results) resultReceipt.current = results;
  const displayedResults = results ?? resultReceipt.current;
  const resultReturnTarget = useRef<HTMLElement | null>(null);
  const resultOrigin = useRef<'import' | 'batch'>('import');
  const captureResultFocus = (origin: 'import' | 'batch') => {
    resultOrigin.current = origin;
    resultReturnTarget.current = origin === 'batch' ? document.getElementById('studio-library-batch-actions') : document.activeElement instanceof HTMLElement && document.activeElement !== document.body && document.activeElement !== document.documentElement ? document.activeElement : null;
  };
  const restoreResultFocus = () => {
    if (!mounted.current) return;
    const fallbackSelectors = resultOrigin.current === 'batch'
      ? ['#studio-library-batch-actions', '[data-testid=studio-library-select-all]', '#studio-library-trigger']
      : ['#studio-import-trigger', '.studio-import button'];
    const candidates = [resultReturnTarget.current, ...fallbackSelectors.map(selector => document.querySelector<HTMLElement>(selector)), workspaceRoot.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')];
    const target = candidates.find(candidate => candidate?.isConnected && candidate.getClientRects().length && !candidate.matches(':disabled, [aria-disabled=true]'));
    target?.focus({ preventScroll: true });
  };
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
  const coordinator = useRef<StudioRefreshCoordinator | null>(null);
  const backgroundRead = useRef<() => Promise<void>>(async () => {});
  const refreshPending = useRef<() => void>(() => {});
  const showPage = (value: DocumentPage | null) => { currentPage.current = value; setPage(value); if (value && !value.summary.capabilities.preserveSource) setView('preview'); };
  const mounted = useRef(true);
  const operation = useRef(false);
  const operationSettled = useRef<Promise<void>>(Promise.resolve());
  const retry = useRef<(() => void) | null>(null);
  const reader = useRef<HTMLDivElement>(null);
  const busy = activity !== null || query !== loadedQuery;
  const readerIsCurrent = (value: StudioRefreshCoordinator | null): value is StudioRefreshCoordinator => !!value && !value.disposed && mounted.current && coordinator.current === value;
  const diagnostics = useMemo(() => {
    const counts = new Map<Diagnostic['code'], number>();
    for (const diagnostic of page?.summary.diagnostics ?? []) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
    return [...counts];
  }, [page?.summary]);
  const flaggedNodes = useMemo(() => new Set(page?.summary.diagnostics.map(item => item.nodeId).filter(Boolean)), [page?.summary]);

  const run = async (kind: Activity, action: () => Promise<void>, retryable = true) => {
    const owner = coordinator.current;
    if (operation.current || !readerIsCurrent(owner)) return;
    operation.current = true;
    let settle!: () => void;
    operationSettled.current = new Promise<void>(resolve => { settle = resolve; });
    setActivity(kind); setError(null); setExported('');
    retry.current = retryable ? () => void run(kind, action) : null;
    try { await owner.runForeground(action); }
    catch (failure) { if (readerIsCurrent(owner)) setError(failure instanceof StudioError ? failure.code : 'document_unavailable'); }
    finally { settle(); if (readerIsCurrent(owner)) { operation.current = false; setActivity(null); if (dirty.current) queueMicrotask(() => refreshPending.current()); } }
  };
  const select = async (doc: DocumentSummary, offset = 0, nodeOffset = 0, options: { silent?: boolean; query?: LibraryQuery } = {}) => {
    const owner = coordinator.current;
    const previous = currentPage.current;
    const revision = Math.max(doc.revision, observedRevisions.current.get(doc.id) ?? 0);
    const result = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision, offset, nodeOffset }));
    if (options.query && options.query !== queryRef.current) { dirty.current = true; return; }
    if (readerIsCurrent(owner) && observations.current.acceptsDocument(result.summary)) {
      showPage(result);
      if (!options.silent) { setCopied(null); setCopyFailed(false); }
      if (previous?.summary.id !== doc.id || previous.offset !== offset || previous.nodeOffset !== nodeOffset) reader.current?.scrollTo({ top: 0 });
    }
  };
  const load = async (offset: number, openFirst = false, silent = false): Promise<void> => {
    const owner = coordinator.current;
    const requestedQuery = queryRef.current;
    const request = { ...requestedQuery, offset, pageSize: LIBRARY_PAGE_SIZE };
    let result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
    for (let attempt = 0; !observations.current.acceptSnapshot(result); attempt++) {
      if (!readerIsCurrent(owner)) return;
      if (attempt >= 3) throw new StudioError('revision_conflict');
      result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
    }
    if (!readerIsCurrent(owner)) return;
    if (requestedQuery !== queryRef.current) { dirty.current = true; return; }
    if (offset > 0 && offset >= result.total) return load(Math.max(0, Math.floor((result.total - 1) / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE), openFirst, silent);
    currentOffset.current = offset;
    librarySnapshot.current = result;
    setLoadedQuery(requestedQuery);
    setDocuments(result.documents); setTotal(result.total); setListOffset(offset);
    setAllTotal(result.allTotal ?? result.total); setUnavailable(result.unavailable ?? []);
    const refreshedSelection = new Map(result.documents.map(doc => [doc.id, doc]));
    for (const item of selectedRef.current) {
      const revision = observedRevisions.current.get(item.id);
      if (refreshedSelection.has(item.id) || !revision || revision <= item.revision) continue;
      try {
        const updated = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: item.id, revision, offset: 0 }));
        if (!readerIsCurrent(owner)) return;
        if (observations.current.acceptsDocument(updated.summary)) refreshedSelection.set(item.id, updated.summary);
      } catch (failure) {
        if (!(failure instanceof StudioError) || !['revision_conflict', 'document_unavailable', 'access_denied'].includes(failure.code)) throw failure;
        // An event racing this read schedules the next refresh; deleted items are removed by the subscription.
      }
    }
    if (!readerIsCurrent(owner)) return;
    if (requestedQuery !== queryRef.current) { dirty.current = true; return; }
    updateSelection(items => items.map(item => refreshedSelection.get(item.id) ?? item));
    const preview = currentPage.current;
    if (preview) {
      const refreshed = result.documents.find(doc => doc.id === preview.summary.id);
      const revision = observedRevisions.current.get(preview.summary.id);
      if (refreshed && refreshed.revision > preview.summary.revision) await select(refreshed, preview.offset, preview.nodeOffset, { silent, query: requestedQuery });
      else if (revision && revision > preview.summary.revision) await select({ ...preview.summary, revision }, preview.offset, preview.nodeOffset, { silent, query: requestedQuery });
    } else if (openFirst && result.documents[0]) {
      await select(result.documents[0], 0, 0, { silent, query: requestedQuery });
    }
  };
  backgroundRead.current = async () => {
    if (!mounted.current || !dirty.current) return;
    dirty.current = false;
    await load(currentOffset.current, !currentPage.current, true);
  };
  refreshPending.current = () => {
    if (!mounted.current || !dirty.current) return;
    coordinator.current?.requestRefresh();
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
  const acceptImportResult = async (result: BatchImportResult | null) => {
    if (!result || !mounted.current) return;
    const onlyItem = result.items.length === 1 ? result.items[0] : undefined;
    if (onlyItem && !onlyItem.ok) throw new StudioError(onlyItem.error);
    const added = result.items.flatMap(item => item.ok ? [item.document] : []);
    changeQuery(defaultLibraryQuery); clearSelection();
    await load(0);
    if (added[0]) { await select(added[0]); setView('preview'); setImportedId(result.items.length === 1 ? added[0].id : ''); }
    if (result.items.length > 1 || result.items.some(item => !item.ok)) setResults({ kind: 'import', items: result.items.map(item => ({ name: item.fileName, ...(item.ok ? { documentId: item.document.id } : { error: item.error }) })) });
  };
  const importDocument = () => { captureResultFocus('import'); void run('import', async () => acceptImportResult(await unwrapStudio(window.subtitleStudio.importSubtitles({ encoding })))); };
  const fileDrag = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const canDrop = (event: DragEvent) => workspaceView === 'documents' && !((event.target as HTMLElement).closest?.('[role=dialog]'));
  const dropFiles = (event: DragEvent) => {
    if (!fileDrag(event)) return;
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (!canDrop(event) || busy || operation.current) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) { retry.current = null; setError('invalid_input'); return; }
    captureResultFocus('import');
    // Capture native File paths inside this event, before a queued reader action can yield.
    let submitted: ReturnType<typeof window.subtitleStudio.importDroppedSubtitles>;
    try { submitted = window.subtitleStudio.importDroppedSubtitles(files, { encoding }); }
    catch (failure) { retry.current = null; setError(failure instanceof StudioError ? failure.code : 'document_unavailable'); return; }
    // A rejection can arrive while the background reader is still settling; observe it immediately.
    const captured = submitted.then(value => ({ ok: true as const, value }), failure => ({ ok: false as const, failure }));
    void run('import', async () => {
      const result = await captured;
      if (!result.ok) throw result.failure;
      await acceptImportResult(await unwrapStudio(Promise.resolve(result.value)));
    }, false);
  };
  const chooseDocument = (doc: DocumentSummary) => void run('select', async () => { await select(doc); if (mounted.current) { setView('preview'); setLibraryOpen(false); } });
  const openTranscriptionDocument = async (documentId: string, preferredTrackId?: string): Promise<void> => {
    // Completion can coincide with the document-created refresh; join it before taking the reader.
    while (operation.current) await operationSettled.current;
    const owner = coordinator.current;
    if (!readerIsCurrent(owner)) return;
    operation.current = true; setActivity('select');
    let settle!: () => void;
    operationSettled.current = new Promise<void>(resolve => { settle = resolve; });
    try {
      await owner.runForeground(async () => {
      // Task IDs grant no document authority: discover the exact result through the library first.
      const nextQuery: LibraryQuery = { ...defaultLibraryQuery, sort: 'recent' };
      for (let offset = 0; offset <= 100_000; offset += LIBRARY_PAGE_SIZE) {
        const snapshot = await unwrapStudio(window.subtitleStudio.listDocuments({ ...nextQuery, offset, pageSize: LIBRARY_PAGE_SIZE }));
        if (!mounted.current) return;
        const document = snapshot.documents.find(item => item.id === documentId);
        if (document) {
          changeQuery(nextQuery);
          await load(offset);
          await select(document);
          if (mounted.current && preferredTrackId) setTrackId(preferredTrackId);
          if (mounted.current) { setError(null); setView('preview'); setLibraryOpen(false); changeWorkspaceView('documents'); }
          return;
        }
        if (offset + LIBRARY_PAGE_SIZE >= snapshot.total || snapshot.documents.length === 0) break;
      }
      throw new StudioError('document_unavailable');
      });
    } finally {
      settle();
      if (readerIsCurrent(owner)) { operation.current = false; setActivity(null); if (dirty.current) queueMicrotask(() => refreshPending.current()); }
    }
  };
  const copyCue = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); if (mounted.current) { setCopied(id); setCopyFailed(false); } }
    catch { if (mounted.current) setCopyFailed(true); }
  };
  useEffect(() => {
    mounted.current = true;
    const owner = new StudioRefreshCoordinator(() => backgroundRead.current(), failure => {
      if (!readerIsCurrent(owner)) return;
      // A newer observed revision already requests another read; do not flash a stale-read error.
      if (failure instanceof StudioError && failure.code === 'revision_conflict' && dirty.current) return;
      setError(failure instanceof StudioError ? failure.code : 'document_unavailable');
      retry.current = () => void run('load', () => load(currentOffset.current, !currentPage.current));
    });
    coordinator.current = owner;
    operation.current = false;
    const unsubscribe = window.subtitleStudio.subscribe(event => {
      if (!mounted.current || !observations.current.observe(event)) return;
      observedRevisions.current.set(event.documentId, event.revision);
      if (event.deleted) updateSelection(items => items.filter(item => item.id !== event.documentId));
      if (event.deleted) {
        setDocuments(items => items.filter(item => item.id !== event.documentId));
        if (currentPage.current?.summary.id === event.documentId) showPage(null);
        setDeleting(value => value?.id === event.documentId ? null : value);
      }
      dirty.current = true;
      refreshPending.current();
    });
    void run('load', () => load(0, true));
    return () => { mounted.current = false; invalidateSelectionRequest(); owner.dispose(); unsubscribe(); if (coordinator.current === owner) coordinator.current = null; };
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
    invalidateSelectionRequest();
    if (next.query !== queryRef.current.query || next.format !== queryRef.current.format || next.status !== queryRef.current.status) updateSelection(() => []);
    queryRef.current = next; setQuery(next); currentOffset.current = 0;
    dirty.current = true;
  };
  useEffect(() => {
    const timer = window.setTimeout(() => refreshPending.current(), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const toggleDocument = (doc: DocumentSummary) => {
    invalidateSelectionRequest();
    if (selectedRef.current.some(item => item.id === doc.id)) updateSelection(items => items.filter(item => item.id !== doc.id));
    else if (selectedRef.current.length >= STUDIO_BATCH_LIMIT) setSelectionLimit(true);
    else updateSelection(items => [...items, doc]);
  };
  const selectPage = () => {
    invalidateSelectionRequest();
    const additions = documents.filter(doc => !selectedRef.current.some(item => item.id === doc.id) && observations.current.acceptsDocument(doc));
    if (selectedRef.current.length + additions.length > STUDIO_BATCH_LIMIT) setSelectionLimit(true);
    else updateSelection(items => [...items, ...additions]);
  };
  const selectAll = () => {
    const owner = coordinator.current;
    if (busy || !readerIsCurrent(owner)) return;
    if (total > STUDIO_BATCH_LIMIT) { setSelectionLimit(true); return; }
    const requested = queryRef.current;
    if (selectionRequest.current?.query === requested) return;
    const generation = ++selectionGeneration.current;
    const isCurrent = () => readerIsCurrent(owner) && requested === queryRef.current && selectionGeneration.current === generation;
    const apply = (matches: DocumentSummary[]) => {
      if (!isCurrent()) return;
      // The subscription already removes deletions. A newer revision alone must not clear selection.
      const merged = new Map(selectedRef.current.map(doc => [doc.id, doc]));
      for (const doc of matches) if (observations.current.acceptsDocument(doc)) merged.set(doc.id, doc);
      if (merged.size > STUDIO_BATCH_LIMIT) { setSelectionLimit(true); return; }
      updateSelection(() => [...merged.values()]);
    };
    // A complete, current page already has the bounded selection summaries.
    if (listOffset === 0 && documents.length === total && librarySnapshot.current && observations.current.acceptSnapshot(librarySnapshot.current)) {
      apply(documents); return;
    }
    selectionRequest.current = { generation, query: requested };
    setSelectionPending(true);
    void (async () => {
      const request = { ...requested, offset: 0, pageSize: STUDIO_BATCH_LIMIT };
      let result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
      for (let attempt = 0; isCurrent() && !observations.current.acceptSnapshot(result); attempt++) {
        if (!isCurrent()) return;
        if (attempt >= 3) throw new StudioError('revision_conflict');
        result = await unwrapStudio(window.subtitleStudio.listDocuments(request));
      }
      if (!isCurrent()) return;
      if (result.total > STUDIO_BATCH_LIMIT) { setSelectionLimit(true); return; }
      apply(result.documents);
    })().catch(failure => {
      if (isCurrent()) { retry.current = null; setError(failure instanceof StudioError ? failure.code : 'document_unavailable'); }
    }).finally(() => {
      if (selectionRequest.current?.generation === generation) {
        selectionRequest.current = null;
        if (readerIsCurrent(owner)) setSelectionPending(false);
      }
    });
  };
  const processSelected = (kind: 'delete' | 'cancel' | 'resume') => {
    const targets = [...selected];
    captureResultFocus('batch');
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
      if (kind === 'delete') updateSelection(values => values.filter(value => !items.some(item => item.documentId === value.id && !item.error)));
      setResults({ kind, items });
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
        <DropdownMenuItem disabled={busy || !selected.length} onSelect={clearSelection}><X />{t('studio:library.clear_selection')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
  const recoveryButton = unavailable.length > 0 ? <Button data-testid="studio-recovery-manage" variant="ghost" size="sm" onClick={() => setRecoveryOpen(true)}><AlertCircle className="text-amber-600 dark:text-amber-400" />{t('studio:recovery.count', { count: unavailable.length })}</Button> : null;
  const library = <StudioLibrary documents={documents} selected={selected} previewId={page?.summary.id} query={query} onQuery={changeQuery} total={total} allTotal={allTotal} offset={listOffset} busy={busy} onPage={offset => void run('load', () => load(offset))} onPreview={chooseDocument} onToggle={toggleDocument} onSelectPage={selectPage} onSelectAll={selectAll} onClearScope={() => { invalidateSelectionRequest(); updateSelection(items => items.filter(doc => !matchesLibraryQuery(doc, queryRef.current))); }} onClear={clearSelection} selectionPending={selectionPending} selectionLimit={selectionLimit} onDismissLimit={() => setSelectionLimit(false)} encoding={encodingField} actions={batchActions} />;

  return <div ref={workspaceRoot} data-testid="subtitle-studio" data-workspace-view={workspaceView} className={page && workspaceView === 'documents' ? 'studio studio-has-document' : 'studio'}
    onDragEnter={event => { if (!fileDrag(event) || !canDrop(event)) return; event.preventDefault(); dragDepth.current++; setDragging(true); }}
    onDragOver={event => { if (!fileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = canDrop(event) && !busy ? 'copy' : 'none'; }}
    onDragLeave={event => { if (!fileDrag(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={dropFiles}>
    {dragging && <div className="studio-drop-overlay" role="status" data-testid="studio-drop-overlay"><Subtitles className="size-7" /><strong>{t(busy ? 'studio:library.drop_busy' : 'studio:library.drop_hint')}</strong><span>SRT · LRC · VTT · ASS</span></div>}
    <ClipPathTabs value={workspaceView} onValueChange={changeWorkspaceView} ariaLabel={t('studio:workspace_view')} shape="rounded" smoothCorners size="sm" transitionDuration={200} transitionEasing="ease-out" className="studio-workspace-tabs w-full" items={[
      { value: 'documents', label: t('studio:workspace_documents'), icon: <Library /> },
      { value: 'transcription', label: t('studio:workspace_transcription'), icon: <AudioLines /> },
    ]}>
    <div className="studio-workspace-header"><ToolPageHeader meta={TOOL_META.subtitleStudio} title={t('studio:title')} /></div>
    <ClipPathTabsContent value="documents" forceMount hidden={workspaceView !== 'documents'} className="studio-workspace-content">
    <ToolDetailLayout
      className="studio-layout"
      header={null}
      asideClassName="hidden lg:block"
      mainClassName="studio-main"
      aside={wide ? <div className="studio-library">{workspaceView === 'documents' && <StudioTranslationOverview onOpenDocument={openTranscriptionDocument} />}<ToolPanel className="studio-library-panel" title={t('studio:documents')} icon={Library} badge={<Badge variant="secondary" className="font-mono text-[11px]">{allTotal}</Badge>} actions={refresh}>{recoveryButton}{library}</ToolPanel></div> : undefined}
    >
      <ToolFilePickerSurface title={t('studio:import')} description={t('studio:library.import_hint')} dragging={dragging && !busy} actionLabel={t('studio:open_file')} disabled={busy} onSelect={importDocument} icon={activity === 'import' ? <LoaderCircle className="h-5 w-5 studio-spin" /> : undefined} className="studio-import" />
      <div className="studio-mobile-controls lg:hidden">
        <StudioIconButton id="studio-library-trigger" label={t('studio:library.open')} onClick={() => setLibraryOpen(true)}><Library /></StudioIconButton>
        {!wide && workspaceView === 'documents' && <StudioTranslationOverview compact onOpenDocument={openTranscriptionDocument} />}
        <div className="min-w-0 flex-1 studio-mobile-picker">{documentPicker}</div>
        <div className="w-[116px] shrink-0">{encodingField}</div>
        {page && <StudioIconButton id="studio-import-trigger" label={t('studio:open_file')} disabled={busy} onClick={importDocument}>{activity === 'import' ? <LoaderCircle className="studio-spin" /> : <FolderOpen />}</StudioIconButton>}
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
          actions={page ? <><StudioBilingual page={page} busy={busy} autoOpen={importedId === page.summary.id} onError={code => { retry.current = null; setError(code); }} onChanged={doc => { setImportedId(''); void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} /><StudioTranslation page={page} busy={busy} onError={code => { retry.current = null; setError(code); }} onStarted={onBatchChanged} /><StudioExport page={page} trackId={track?.id} busy={busy} onError={code => { retry.current = null; setError(code); }} onExported={setExported} /><StudioRevealSource key={page.summary.id} kind="document" id={page.summary.id} /><StudioIconButton id="studio-delete-trigger" label={t('studio:delete_document')} disabled={busy} onClick={() => setDeleting(page.summary)}><Trash2 /></StudioIconButton></> : undefined}
          className="studio-preview-panel"
          footer={page ? <div className="studio-reader-footer"><span className="flex items-center gap-1.5 text-[11px] text-muted-foreground studio-footer-status">{busy ? <LoaderCircle className="h-3.5 w-3.5 studio-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}{busy ? t('studio:loading') : t(page.summary.capabilities.preserveSource ? 'studio:source_preserved' : 'studio:transcription_preserved')}</span><StudioPagination offset={view === 'raw' ? page.nodeOffset : page.offset} total={view === 'raw' ? page.nodeCount : page.summary.cueCount} busy={busy} onChange={offset => void run('select', () => select(page.summary, view === 'raw' ? page.offset : offset, view === 'raw' ? offset : page.nodeOffset))} /></div> : undefined}
        >
          {page ? <>
            {track && <div className="studio-translation-toolbar">
              <div className="studio-translation-track-controls">
              <Select value={track.id} onValueChange={setTrackId}><SelectTrigger aria-label={t('studio:translation_track')} className="h-7 w-[160px] shrink-0 text-xs"><SelectValue /></SelectTrigger><SelectContent>{page.translationTracks.map((item, index) => <SelectItem key={item.id} value={item.id}>{item.language === 'und' ? t('studio:language_unknown') : item.language} · {index + 1}</SelectItem>)}</SelectContent></Select>
              <StudioRemoveTranslation page={page} track={track} busy={busy} onError={code => { retry.current = null; setError(code); }} onChanged={doc => { setTrackId(''); void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} />
              </div>
              <div className="studio-translation-progress-controls">
                <StudioTranslationStatus page={page} trackId={track.id} />
                <StudioTranslationTask page={page} trackId={track.id} busy={busy} onError={code => { retry.current = null; setError(code); }} onChanged={() => { dirty.current = true; refreshPending.current(); }} />
              </div>
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
                    <td className="studio-cue-action"><StudioCueCopy cue={cue} translation={track?.entries[cue.id]} copied={copied === cue.id} onCopy={text => copyCue(cue.id, text)} /></td>
                  </tr>)}</tbody></table> : <div className="studio-content-empty"><Subtitles /><p>{t('studio:diagnostics.empty_document')}</p></div>}
                </ClipPathTabsContent>
                <ClipPathTabsContent value="raw" className="studio-raw"><ol start={page.nodeOffset + 1}>{page.rawNodes.map((node, index) => <li key={node.id}><span aria-hidden="true">{page.nodeOffset + index + 1}</span><pre>{node.text}</pre></li>)}</ol>{!page.rawNodes.length && <div className="studio-content-empty"><Code2 /><p>{t('studio:no_source_content')}</p></div>}</ClipPathTabsContent>
              </div>
            </ClipPathTabs>
          </> : <div className="studio-content-empty py-14">{busy ? <LoaderCircle className="studio-spin" /> : <Subtitles />}<p>{busy ? t('studio:loading') : t('studio:empty')}</p></div>}
        </ToolPanel>
      </div>
    </ToolDetailLayout>
    </ClipPathTabsContent>
    <ClipPathTabsContent value="transcription" className="studio-workspace-content">
      {workspaceView === 'transcription' && <StudioTranscription header={null} onOpenDocument={openTranscriptionDocument} />}
    </ClipPathTabsContent>
    </ClipPathTabs>
    <StudioBatchTranslation triggerContainer={translationSlot} documents={selected} busy={busy} onError={code => { retry.current = null; setError(code); }} onStarted={onBatchChanged} />
    <StudioBatchExport triggerContainer={exportSlot} documents={selected} busy={busy} onError={code => { retry.current = null; setError(code); }} onExported={setExported} />
    {!wide && <ScrollableDialog open={libraryOpen} onOpenChange={setLibraryOpen} maxWidth="sm:max-w-[540px]" contentClassName="studio-library-dialog" onOpenAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLInputElement>('[data-testid=studio-library-search]')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); document.getElementById('studio-library-trigger')?.focus(); }}><ScrollableDialogHeader><DialogTitle>{t('studio:documents')} · {allTotal}</DialogTitle><DialogDescription className="sr-only">{t('studio:library.selection_rule')}</DialogDescription></ScrollableDialogHeader><ScrollableDialogContent>{library}</ScrollableDialogContent></ScrollableDialog>}
    <StudioRecovery open={recoveryOpen} onOpenChange={setRecoveryOpen} documents={unavailable} onChanged={pending => { if (pending) setCleanupPending(true); dirty.current = true; refreshPending.current(); }} onError={code => { retry.current = null; setError(code); }} />
    <ScrollableDialog open={!!batchConfirm} maxWidth="sm:max-w-[560px]" contentClassName="studio-batch-confirm-dialog" onOpenChange={open => { if (!open) setBatchConfirm(null); }} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-batch-cancel')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); (document.getElementById('studio-library-batch-actions') ?? document.querySelector<HTMLElement>('[data-testid=studio-library-select-all]'))?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="relative p-3 pr-12"><DialogTitle className="flex items-center gap-2 text-sm">{batchConfirm === 'delete' ? <Trash2 className="size-4" /> : <Play className="size-4" />}{t(batchConfirm === 'delete' ? 'studio:library.delete_selected' : 'studio:library.resume_selected')}</DialogTitle><DialogDescription className="text-xs leading-5">{t(batchConfirm === 'delete' ? 'studio:delete_description' : 'studio:library.resume_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-batch-confirm-content"><div className="space-y-3"><StudioSelectedDocuments documents={selected} collapsible={false} />{batchConfirm === 'resume' && <p className="text-xs leading-5 text-amber-600 dark:text-amber-400">{t('studio:library.resume_uncertain')}</p>}</div></ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3"><Button id="studio-batch-cancel" variant="ghost" size="sm" onClick={() => setBatchConfirm(null)}>{t('studio:cancel')}</Button><Button size="sm" variant={batchConfirm === 'delete' ? 'destructive' : 'default'} disabled={busy} onClick={() => batchConfirm && processSelected(batchConfirm)}>{t(batchConfirm === 'delete' ? 'studio:library.confirm_delete' : 'studio:library.confirm_resume')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog open={!!results} onOpenChange={open => { if (!open) setResults(null); }} maxWidth={STUDIO_RESULT_DIALOG_WIDTH} contentClassName={STUDIO_RESULT_DIALOG_CLASS} onCloseAutoFocus={event => { event.preventDefault(); restoreResultFocus(); }}>
      {displayedResults && <StudioOperationResult operation={displayedResults.kind} testId="studio-library-result" closeButtonId="studio-result-close" onClose={() => setResults(null)} items={displayedResults.items.map((item, index) => ({ id: `${item.documentId ?? item.name}:${index}`, name: item.name, state: item.error ? 'failed' : item.skipped ? 'skipped' : 'success', detail: item.error ? t(errorKeys[item.error]) : item.skipped ? t(item.skipped) : t(displayedResults.kind === 'resume' ? 'studio:library.resume_requested' : displayedResults.kind === 'cancel' ? 'studio:library.cancel_requested' : 'studio:library.succeeded') }))} />}
    </ScrollableDialog>
    <ScrollableDialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-delete-cancel')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); document.getElementById('studio-delete-trigger')?.focus(); }}>
      <ScrollableDialogHeader><DialogTitle className="pr-6">{t('studio:delete_document')}</DialogTitle><DialogDescription>{t('studio:delete_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent><StudioDocumentList scroll={false}>{deleting && <StudioDocumentRow name={deleting.origin.displayName} />}</StudioDocumentList></ScrollableDialogContent>
      <ScrollableDialogFooter><div className="flex justify-end gap-2"><Button id="studio-delete-cancel" variant="outline" onClick={() => setDeleting(null)}>{t('studio:cancel')}</Button><Button variant="destructive" disabled={busy} onClick={deleteDocument}><Trash2 />{t('studio:delete_document')}</Button></div></ScrollableDialogFooter>
    </ScrollableDialog>
  </div>;
}
