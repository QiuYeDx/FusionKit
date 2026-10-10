import { StudioRevealSource } from './StudioRevealSource';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AnimatePresence } from 'motion/react';
import { StudioDisclosure } from './StudioDisclosure';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { readStudioNavigationView } from './navigation';
import { AlertCircle, AudioLines, BookOpen, CheckCheck, Code2, Ellipsis, FolderOpen, Library, List, LoaderCircle, RefreshCw, Subtitles, Trash2, X, Play, Square, Undo2, ScanText, Columns2 } from 'lucide-react';
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
import { useToolFileDropTarget } from '../../_shared/ui/ToolFileDropScope';
import { useStudioPreferences } from '@/store/tools/subtitle-studio/preferences';
import { unwrapStudio } from '@/services/subtitle-studio/client';
import { StudioObservations } from '@/services/subtitle-studio/observations';
import { StudioRefreshCoordinator } from '@/services/subtitle-studio/refresh-coordinator';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import { encodingSchema, LIMITS, StudioError, type Diagnostic, type ErrorCode } from '@/subtitle-studio/domain';
import type { CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { CueHistory, type CueEditLabel } from '@/services/subtitle-studio/cue-history';
import { StudioCueTable } from './StudioCueTable';
import { StudioPreviewExpandControls, useStudioPreviewExpansion } from './StudioPreviewExpansion';
import { StudioCueRevision, type CueRevisionRequestState } from './StudioCueRevision';
import { useAgentPageContext } from '@/agent/page-context';
import { createStudioAgentTools, studioPageContext, type StudioAgentDeps } from './agent-context';
import type { DocumentListSnapshot, DocumentPage, DocumentSummary } from '@/subtitle-studio/ipc-contract';
import { STUDIO_BATCH_LIMIT, type UnavailableDocument, type BatchImportResult } from '@/subtitle-studio/batch-contract';
import { matchesLibraryQuery } from '@/subtitle-studio/library-query';
import useModelStore from '@/store/useModelStore';
import { translationModelSchema, normalizeTranslationModel } from '@/subtitle-studio/translation-contract';
import { formatStudioTrackName, StudioFileName, StudioIconButton, StudioPagination } from './StudioControls';
import { StudioTranslation, StudioTranslationStatus, StudioBatchTranslation } from './StudioTranslation';
import { StudioTranslationTask } from './StudioTranslationTask';
import type { AutomaticKnowledgeRecheckRequest } from './automatic-knowledge-recheck';
import { StudioTranslationOverview } from './StudioTranslationOverview';
import { StudioExport, StudioBatchExport } from './StudioExport';
import { restoreLibraryFocus, type LibraryContextAction, type LibraryContextScope, type LibraryDialogRequest } from './StudioLibraryContextMenu';
import { StudioLibrary, LIBRARY_PAGE_SIZE, defaultLibraryQuery, type LibraryQuery } from './StudioLibrary';
import { StudioRecovery } from './StudioRecovery';
import { StudioSelectedDocuments } from './StudioSelectedDocuments';
import { StudioDocumentList, StudioDocumentRow } from './StudioDocumentList';
import { bilingualDirection, revertBilingualImport, StudioBilingual, StudioRemoveTranslation, StudioRevertBilingual } from './StudioBilingual';
import { StudioRenameTranslation } from './StudioRenameTranslation';
import { StudioTranscription } from './StudioTranscription';
import { QuickTermDialog } from '@/pages/TranslationKnowledge/QuickTermDialog';
import { KnowledgeCaptureDialog } from '@/pages/TranslationKnowledge/KnowledgeCaptureDialog';
import { translationDraftMemory } from '@/services/subtitle-studio/translation-draft';
import type { CueRevisionHint } from '@/subtitle-studio/cue-revision-contract';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import type { LanguagePair } from '@/translation-knowledge/schemas';
import { captureLanguagePair, hintsToOffer, preferredCollection } from './knowledge-hints';
import { StudioConsistencyCheck, type ConsistencyRequestState, type ConsistencyTarget } from './StudioConsistencyCheck';
import { STUDIO_RESULT_DIALOG_CLASS, STUDIO_RESULT_DIALOG_WIDTH, StudioOperationResult } from './StudioOperationResult';
import './studio.css';

const focusCueList = () => document.querySelector<HTMLElement>('[data-testid=studio-cue-list]')?.focus({ preventScroll: true });

const errorKeys: Record<ErrorCode, string> = {
  resource_busy: 'studio:errors.resource_busy',
  translation_output_limit: 'studio:errors.translation_output_limit',
  knowledge_check_failed: 'studio:errors.knowledge_check_failed', needs_configuration: 'studio:errors.needs_configuration', translation_protocol_invalid: 'studio:errors.translation_protocol_invalid', translation_record_unavailable: 'studio:errors.translation_record_unavailable', translation_failed: 'studio:errors.translation_failed', interrupted: 'studio:errors.interrupted',
  transcription_failed: 'studio:errors.transcription_failed',
  invalid_input: 'studio:errors.invalid_input', unsupported_feature: 'studio:errors.unsupported_feature', encoding_required: 'studio:errors.encoding_required', limit_exceeded: 'studio:errors.limit_exceeded', revision_conflict: 'studio:errors.revision_conflict', access_denied: 'studio:errors.access_denied', document_unavailable: 'studio:errors.document_unavailable', output_write_failed: 'studio:errors.output_write_failed',
};
const diagnosticKeys: Record<Diagnostic['code'], string> = {
  opaque_structure: 'studio:diagnostics.opaque_structure', ass_drawing: 'studio:diagnostics.ass_drawing', ass_karaoke: 'studio:diagnostics.ass_karaoke', vtt_payload_unsupported: 'studio:diagnostics.vtt_payload_unsupported',
  empty_document: 'studio:diagnostics.empty_document', unsupported_markup: 'studio:diagnostics.unsupported_markup', enhanced_lrc: 'studio:diagnostics.enhanced_lrc', negative_time: 'studio:diagnostics.negative_time', zero_duration: 'studio:diagnostics.zero_duration', untimed_text: 'studio:diagnostics.untimed_text',
};
type Activity = 'load' | 'import' | 'select' | 'export' | 'delete' | 'batch';
type OperationResult = { name: string; error?: ErrorCode; documentId?: string; skipped?: 'studio:library.no_cancel_task' | 'studio:library.no_resume_task'; bilingual?: string };
type WorkspaceView = 'documents' | 'transcription';
let lastWorkspaceView: WorkspaceView = 'documents';

export default function SubtitleStudio() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(() => readStudioNavigationView(searchParams.toString()) ?? lastWorkspaceView);
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
    lastWorkspaceView = value; setWorkspaceView(value);
  };
  useLayoutEffect(resetWorkspaceScroll, [workspaceView]);
  useEffect(() => {
    const hint = readStudioNavigationView(searchParams.toString());
    if (!hint) return;
    changeWorkspaceView(hint);
    lastWorkspaceView = hint;
    const next = new URLSearchParams(searchParams); next.delete('view');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
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
  const [contextDialog, setContextDialog] = useState<{ kind: 'translate' | 'export' | 'source'; documents: DocumentSummary[]; request: LibraryDialogRequest } | null>(null);
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
  const resultReturnAction = useRef<(() => void) | undefined>(undefined);
  const captureResultFocus = (origin: 'import' | 'batch', restore?: () => void) => {
    resultReturnAction.current = restore;
    resultOrigin.current = origin;
    resultReturnTarget.current = origin === 'batch' ? document.getElementById('studio-library-batch-actions') : document.activeElement instanceof HTMLElement && document.activeElement !== document.body && document.activeElement !== document.documentElement ? document.activeElement : null;
  };
  const restoreResultFocus = () => {
    if (!mounted.current) return;
    if (resultReturnAction.current) { resultReturnAction.current(); return; }
    const fallbackSelectors = resultOrigin.current === 'batch'
      ? ['#studio-library-batch-actions', '[data-testid=studio-library-select-all]', '#studio-library-trigger']
      : ['#studio-import-trigger', '.studio-import button'];
    const candidates = [resultReturnTarget.current, ...fallbackSelectors.map(selector => document.querySelector<HTMLElement>(selector)), workspaceRoot.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')];
    const target = candidates.find(candidate => candidate?.isConnected && candidate.getClientRects().length && !candidate.matches(':disabled, [aria-disabled=true]'));
    target?.focus({ preventScroll: true });
  };
  const [batchConfirm, setBatchConfirm] = useState<{ kind: 'delete' | 'resume'; documents: DocumentSummary[]; restore?: () => void } | null>(null);
  const confirmationReceipt = useRef<NonNullable<typeof batchConfirm> | null>(null);
  if (batchConfirm) confirmationReceipt.current = batchConfirm;
  const displayedConfirmation = batchConfirm ?? confirmationReceipt.current;
  const confirmReturnAction = useRef<(() => void) | undefined>(undefined);
  const confirmBatch = (kind: 'delete' | 'resume', targets = selected, restore?: () => void) => {
    confirmReturnAction.current = restore; setBatchConfirm({ kind, documents: [...targets], restore });
  };
  const [selectionLimit, setSelectionLimit] = useState(false);
  const observedRevisions = useRef(new Map<string, number>());
  const [listOffset, setListOffset] = useState(0);
  const [page, setPage] = useState<DocumentPage | null>(null);
  const [previewRequest, setPreviewRequest] = useState<{ document: DocumentSummary; error?: ErrorCode } | null>(null);
  const previewReceipt = useRef<typeof previewRequest>(null);
  if (previewRequest) previewReceipt.current = previewRequest;
  const displayedPreviewRequest = previewRequest ?? previewReceipt.current;
  const previewGeneration = useRef(0);
  const previewTarget = useRef<string | null>(null);
  const invalidatePreview = () => { previewGeneration.current++; previewTarget.current = null; setPreviewRequest(null); };
  const [activity, setActivity] = useState<Activity | null>('load');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [exported, setExported] = useState('');
  const [view, setView] = useState('preview');
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [deleting, setDeleting] = useState<DocumentSummary | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [trackId, setTrackId] = useState('');
  const [rememberTerm, setRememberTerm] = useState<{ source: string; target: string; targetLanguage: string } | null>(null);
  const [knowledgeRecheck, setKnowledgeRecheck] = useState<AutomaticKnowledgeRecheckRequest | undefined>();
  /** The document just imported and separated as bilingual, until the notice is dismissed. */
  const [bilingualNotice, setBilingualNotice] = useState('');
  const track = page?.translationTracks.find(item => item.id === trackId) ?? page?.translationTracks.at(-1);
  const cueHistory = useRef(new CueHistory());
  // Undo only covers edits made at the revision on screen; any other change ends it.
  // Synced when the page changes, not on every render: an edit records its new
  // revision before the page reloads, and renders in between still show the old one.
  useEffect(() => { cueHistory.current.sync(page?.summary.id, page?.summary.revision); }, [page?.summary.id, page?.summary.revision]);
  const [cueNotice, setCueNotice] = useState<{ deleted: number; stopped: number } | null>(null);
  /** Wordings an applied AI revision settled, offered for keeping until the document changes again. */
  const [knowledgeOffer, setKnowledgeOffer] = useState<{ documentId: string; revision: number; hints: CueRevisionHint[]; pair: Partial<LanguagePair>; preferredCollectionId?: string; instructions: string } | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  /** Wordings to keep from the consistency check, independent of the revision offer. */
  const [checkCapture, setCheckCapture] = useState<{ wordings: { source: string; target: string }[]; pair: Partial<LanguagePair>; preferredCollectionId?: string; saved: () => void } | null>(null);
  const [consistency, setConsistency] = useState<ConsistencyRequestState | null>(null);
  const consistencySerial = useRef(0);
  const consistencyOpenRef = useRef(false);
  consistencyOpenRef.current = !!consistency;
  const openConsistencyRef = useRef<(focus: string | undefined, onSettled: NonNullable<ConsistencyRequestState['onSettled']>) => boolean>(() => false);
  const [cueTranslation, setCueTranslation] = useState<{ cueIds: string[]; trackId?: string; request: LibraryDialogRequest } | null>(null);
  const [cueRevision, setCueRevision] = useState<CueRevisionRequestState | null>(null);
  const cueRevisionSerial = useRef(0);
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
  // The assistant reads the page through these at call time, so its tools always see the current state.
  const cueSelection = useRef<string[]>([]);
  const agentState = useRef({ page, track, busy, cueRevision, t });
  agentState.current = { page, track, busy, cueRevision, t };
  const agentDeps = useMemo<StudioAgentDeps>(() => ({
    page: () => agentState.current.page,
    track: () => agentState.current.track,
    selection: () => cueSelection.current,
    editBlocked: () => {
      const state = agentState.current;
      if (state.page?.tasks.some(task => task.status === 'queued' || task.status === 'running')) return state.t('studio:cue_edit.blocked_translation');
      return state.busy ? state.t('studio:cue_edit.blocked_busy') : undefined;
    },
    revisionOpen: () => !!agentState.current.cueRevision,
    openRevision: (cueIds, preset, onSettled) => setCueRevision({ cueIds, serial: ++cueRevisionSerial.current, preset, onSettled }),
    consistencyOpen: () => consistencyOpenRef.current,
    openConsistency: (focus, onSettled) => openConsistencyRef.current(focus, onSettled),
    api: () => window.subtitleStudio,
  }), []);
  const agentTools = useMemo(() => createStudioAgentTools(agentDeps), [agentDeps]);
  useAgentPageContext(() => typeof window !== 'undefined' && window.subtitleStudio ? studioPageContext(agentDeps, agentTools) : null);
  const requestKnowledgeRecheck = (request: AutomaticKnowledgeRecheckRequest): boolean => {
    if (!mounted.current || busy || operation.current || currentPage.current?.summary.id !== request.documentId || track?.id !== request.trackId
      || !currentPage.current.translationTracks.some(item => item.id === request.trackId)) return false;
    setKnowledgeRecheck(request); return true;
  };
  useEffect(() => {
    setKnowledgeRecheck(current => current && (current.documentId !== page?.summary.id || current.trackId !== track?.id) ? undefined : current);
  }, [page?.summary.id, track?.id]);
  const readerIsCurrent = (value: StudioRefreshCoordinator | null): value is StudioRefreshCoordinator => !!value && !value.disposed && mounted.current && coordinator.current === value;
  const diagnostics = useMemo(() => {
    const counts = new Map<Diagnostic['code'], number>();
    for (const diagnostic of page?.summary.diagnostics ?? []) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
    return [...counts];
  }, [page?.summary]);
  const flaggedNodes = useMemo(() => new Set(page?.summary.diagnostics.map(item => item.nodeId).filter(Boolean)), [page?.summary]);

  const run = async (kind: Activity, action: () => Promise<unknown>, retryable = true) => {
    const owner = coordinator.current;
    if (operation.current || !readerIsCurrent(owner)) return;
    invalidatePreview();
    operation.current = true;
    let settle!: () => void;
    operationSettled.current = new Promise<void>(resolve => { settle = resolve; });
    setActivity(kind); setError(null); setExported('');
    retry.current = retryable ? () => void run(kind, action) : null;
    try { await owner.runForeground(action); }
    catch (failure) { if (readerIsCurrent(owner)) setError(failure instanceof StudioError ? failure.code : 'document_unavailable'); }
    finally { settle(); if (readerIsCurrent(owner)) { operation.current = false; setActivity(null); if (dirty.current) queueMicrotask(() => refreshPending.current()); } }
  };
  const select = async (doc: DocumentSummary, offset = 0, nodeOffset = 0, options: { silent?: boolean; query?: LibraryQuery; navigation?: number } = {}) => {
    const owner = coordinator.current;
    const generation = options.navigation ?? previewGeneration.current;
    const previous = currentPage.current;
    const revision = Math.max(doc.revision, observedRevisions.current.get(doc.id) ?? 0);
    const result = await unwrapStudio(window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision, offset, nodeOffset }));
    if (options.query && options.query !== queryRef.current) { dirty.current = true; return; }
    if (generation !== previewGeneration.current || (previewTarget.current && options.navigation === undefined)) return;
    if (readerIsCurrent(owner) && observations.current.acceptsDocument(result.summary)) {
      showPage(result);
      if (!options.silent) { setCopied(null); setCopyFailed(false); }
      if (previous?.summary.id !== doc.id || previous.offset !== offset || previous.nodeOffset !== nodeOffset) reader.current?.scrollTo({ top: 0 });
      return true;
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
    if (added[0]) { await select(added[0]); setView('preview'); setBilingualNotice(added[0].bilingualImport ? added[0].id : ''); }
    if (result.items.length > 1 || result.items.some(item => !item.ok)) setResults({ kind: 'import', items: result.items.map(item => ({ name: item.fileName,
      ...(item.ok ? { documentId: item.document.id, ...(item.document.bilingualImport ? { bilingual: bilingualDirection(t, item.document.bilingualImport) } : {}) } : { error: item.error }) })) });
  };
  const importDocument = () => { captureResultFocus('import'); void run('import', async () => acceptImportResult(await unwrapStudio(window.subtitleStudio.importSubtitles({ encoding })))); };
  const canDrop = (event: DragEvent) => workspaceView === 'documents' && !((event.target as HTMLElement).closest?.('[role=dialog]'));
  const dropFiles = (event: DragEvent<HTMLElement>) => {
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
  const { dragging, dropProps } = useToolFileDropTarget({
    onDrop: dropFiles,
    enabled: workspaceView === 'documents',
    disabled: busy,
    label: t('studio:import'),
  });
  const chooseDocument = (doc: DocumentSummary) => {
    const owner = coordinator.current;
    if (busy || operation.current || !readerIsCurrent(owner)) return;
    const generation = ++previewGeneration.current;
    previewTarget.current = doc.id;
    setPreviewRequest({ document: doc }); setLibraryOpen(false);
    setCopied(null); setCopyFailed(false);
    const isCurrent = () => readerIsCurrent(owner) && generation === previewGeneration.current;
    // Keep one reader, but skip superseded queued clicks and never acquire global busy state.
    void owner.runForeground(async () => {
      if (!isCurrent()) return;
      for (let attempt = 0; ; attempt++) {
        try {
          if (await select(doc, 0, 0, { navigation: generation })) break;
          if (!isCurrent()) return;
          throw new StudioError('revision_conflict');
        } catch (failure) {
          if (!isCurrent()) return;
          if (attempt >= 2 || !(failure instanceof StudioError) || failure.code !== 'revision_conflict') throw failure;
        }
      }
      if (!isCurrent()) return;
      if (currentPage.current?.summary.id !== doc.id) throw new StudioError('document_unavailable');
      setView('preview'); setTrackId('');
      previewTarget.current = null; setPreviewRequest(null);
    }).catch(failure => {
      if (isCurrent()) setPreviewRequest({ document: doc, error: failure instanceof StudioError ? failure.code : 'document_unavailable' });
    });
  };
  const openTranscriptionDocument = async (documentId: string, preferredTrackId?: string): Promise<void> => {
    // Completion can coincide with the document-created refresh; join it before taking the reader.
    while (operation.current) await operationSettled.current;
    const owner = coordinator.current;
    if (!readerIsCurrent(owner)) return;
    operation.current = true; setActivity('select');
    invalidatePreview();
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
        if (previewTarget.current === event.documentId) invalidatePreview();
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
  const processSelected = (kind: 'delete' | 'cancel' | 'resume', scope = selected, restore?: () => void) => {
    const targets = [...scope];
    captureResultFocus('batch', restore);
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
  const activeDocument = previewRequest?.document ?? page?.summary;
  const expansion = useStudioPreviewExpansion(workspaceRoot, '.studio-main', !!page && workspaceView === 'documents');
  const activeIndex = documents.findIndex(doc => doc.id === activeDocument?.id);
  const previousDocument = activeIndex > 0 && !busy ? documents[activeIndex - 1] : undefined;
  const nextDocument = activeIndex >= 0 && !busy ? documents[activeIndex + 1] : undefined;
  const documentPicker = <Select value={documents.some(doc => doc.id === activeDocument?.id) ? activeDocument?.id : ''} onValueChange={id => { const doc = documents.find(item => item.id === id); if (doc) chooseDocument(doc); }} disabled={busy || !documents.length}>
    <SelectTrigger aria-label={t('studio:select_document')} className="h-8 w-full min-w-0 text-xs"><SelectValue placeholder={t('studio:select_document')}>{activeDocument && documents.some(doc => doc.id === activeDocument.id) ? <StudioFileName name={activeDocument.origin.displayName} /> : undefined}</SelectValue></SelectTrigger>
    <SelectContent className="max-w-[calc(100vw-2rem)]">{documents.map(doc => <SelectItem key={doc.id} value={doc.id} className="whitespace-normal break-all">{doc.origin.displayName}</SelectItem>)}</SelectContent>
  </Select>;
  const refresh = <StudioIconButton label={t('studio:refresh')} disabled={busy} onClick={() => void run('load', () => load(listOffset, !page))}><RefreshCw className={activity === 'load' ? 'studio-spin' : ''} /></StudioIconButton>;
  const onBatchChanged = () => { dirty.current = true; refreshPending.current(); };
  /** Applies a cue edit, records its inverse and reloads the page; resolves whether it was applied. */
  const applyCueEdit = (operation: CueEditOperation, mode: 'do' | 'undo' | 'redo', label: CueEditLabel = 'source', count = 1) => new Promise<boolean>(resolve => {
    const current = currentPage.current;
    if (!current || busy) { resolve(false); return; }
    let applied = false;
    void run('select', async () => {
      const history = cueHistory.current;
      let result;
      try { result = await unwrapStudio(window.subtitleStudio.editCues({ documentId: current.summary.id, revision: current.summary.revision, operation })); }
      catch (failure) { if (mode !== 'do') history.discard(mode); throw failure; }
      // Record before the page reloads at the new revision, which the history checks against.
      if (mode === 'do') { if (result.changed) history.record(current.summary.id, current.summary.revision, result.summary.revision, { label, count, operation: result.undo }); }
      else history.step(mode, current.summary.id, current.summary.revision, result.summary.revision, result.undo);
      applied = true;
      setCueNotice(operation.kind === 'delete' || result.stoppedTasks ? { deleted: operation.kind === 'delete' ? result.changed : 0, stopped: result.stoppedTasks } : null);
      const lastPage = Math.max(0, Math.floor((result.summary.cueCount - 1) / LIMITS.pageSize) * LIMITS.pageSize);
      await select(result.summary, Math.min(current.offset, lastPage), current.nodeOffset);
      await load(currentOffset.current);
    }, false).then(() => resolve(applied));
  });
  /** Opens the consistency check for documents; the shown track is used for the open one, the latest elsewhere. */
  const openConsistency = (targets: DocumentSummary[], extra: Partial<ConsistencyRequestState> = {}) => {
    const documents: ConsistencyTarget[] = targets.filter(doc => doc.cueCount > 0).map(doc => ({ documentId: doc.id, revision: doc.revision, name: doc.origin.displayName, cueCount: doc.cueCount,
      ...(doc.id === currentPage.current?.summary.id && track ? { trackId: track.id } : doc.translationTracks?.length ? { trackId: doc.translationTracks.at(-1)!.id } : {}) }));
    if (!documents.length) return false;
    setConsistency({ serial: ++consistencySerial.current, documents, ...extra });
    return true;
  };
  openConsistencyRef.current = (focus, onSettled) => openConsistency(currentPage.current ? [currentPage.current.summary] : [], { autoStart: true, onSettled, ...(focus ? { focus } : {}) });
  /** Undoes the consistency check's edit of the open document while it is still the latest edit. */
  const undoUnify = () => new Promise<boolean>(resolve => {
    cueHistory.current.sync(currentPage.current?.summary.id, currentPage.current?.summary.revision);
    const entry = cueHistory.current.peek('undo');
    if (!entry || entry.label !== 'unify') { resolve(false); return; }
    void applyCueEdit(entry.operation, 'undo').then(resolve);
  });
  /** Wordings the consistency check settled, offered for keeping in translation materials. */
  const keepCheckedWordings = async (wordings: { source: string; target: string }[], saved: () => void) => {
    const current = currentPage.current;
    const draft = current ? translationDraftMemory.read(current.summary.id, current.summary.revision) : undefined;
    let library: LibrarySnapshot | null = null;
    try { const response = await window.translationKnowledge.read(); if (response.ok) library = response.value; } catch { /* The dialog reads it again. */ }
    const pair = captureLanguagePair(draft, translationDraftMemory.last(), track?.language);
    const preferred = preferredCollection(draft?.selection, library);
    if (mounted.current) setCheckCapture({ wordings, pair, saved, ...(preferred ? { preferredCollectionId: preferred } : {}) });
  };
  /** After a revision is applied: offer the wordings it settled that the library does not already hold. */
  const offerKnowledge = async (hints: CueRevisionHint[], instructions: string) => {
    const current = currentPage.current;
    if (!current) return;
    const draft = translationDraftMemory.read(current.summary.id, current.summary.revision);
    const pair = captureLanguagePair(draft, translationDraftMemory.last(), track?.language);
    let library: LibrarySnapshot | null = null;
    try { const response = await window.translationKnowledge.read(); if (response.ok) library = response.value; } catch { /* Offer them all. */ }
    const offered = hintsToOffer(hints, library, pair);
    const now = currentPage.current;
    if (!offered.length || !mounted.current || now?.summary.id !== current.summary.id) return;
    setKnowledgeOffer({ documentId: now.summary.id, revision: now.summary.revision, hints: offered, pair, instructions,
      ...(preferredCollection(draft?.selection, library) ? { preferredCollectionId: preferredCollection(draft?.selection, library) } : {}) });
  };
  // Another edit, an undo or another document ends the offer.
  useEffect(() => {
    if (knowledgeOffer && (page?.summary.id !== knowledgeOffer.documentId || page.summary.revision !== knowledgeOffer.revision)) { setKnowledgeOffer(null); setCaptureOpen(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.summary.id, page?.summary.revision]);
  const stepCueHistory = (direction: 'undo' | 'redo') => {
    cueHistory.current.sync(currentPage.current?.summary.id, currentPage.current?.summary.revision);
    const entry = cueHistory.current.peek(direction);
    if (entry) void applyCueEdit(entry.operation, direction).then(applied => { if (applied) focusCueList(); });
  };
  const batchActions = <>
    <span ref={setTranslationSlot} />
    <span ref={setExportSlot} />
    <DropdownMenu>
      <Tooltip delayDuration={350}><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button id="studio-library-batch-actions" variant="ghost" size="icon-sm" aria-label={t('studio:library.batch_actions')} disabled={busy || !selected.length}><Ellipsis /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>{t('studio:library.batch_actions')}</TooltipContent></Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-48" onCloseAutoFocus={event => { if (batchConfirm) event.preventDefault(); }}>
        <DropdownMenuItem disabled={busy || !selected.some(doc => doc.task && ['failed', 'interrupted', 'needs_configuration'].includes(doc.task.status))} onSelect={() => confirmBatch('resume')}><Play />{t('studio:library.resume_selected')}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !selected.some(doc => doc.task && ['queued', 'running', 'failed', 'interrupted', 'needs_configuration'].includes(doc.task.status))} onSelect={() => processSelected('cancel')}><Square />{t('studio:library.cancel_selected')}</DropdownMenuItem>
        <DropdownMenuItem data-testid="studio-library-batch-consistency" disabled={busy || !selected.some(doc => doc.cueCount > 0)} onSelect={() => openConsistency(latestScope(selected))}><ScanText />{t('studio:consistency.open_documents')}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !selected.length} onSelect={() => confirmBatch('delete')}><Trash2 />{t('studio:library.delete_selected')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy || !selected.length} onSelect={clearSelection}><X />{t('studio:library.clear_selection')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
  const recoveryButton = unavailable.length > 0 ? <Button data-testid="studio-recovery-manage" variant="ghost" size="sm" onClick={() => setRecoveryOpen(true)}><AlertCircle className="text-amber-600 dark:text-amber-400" />{t('studio:recovery.count', { count: unavailable.length })}</Button> : null;
  const latestScope = (targets: DocumentSummary[]) => targets.map(target => [...selected, ...documents].filter(doc => doc.id === target.id && doc.revision >= target.revision).sort((a, b) => b.revision - a.revision)[0] ?? target);
  const contextAction = (action: LibraryContextAction, scope: LibraryContextScope) => {
    if (busy || selectionPending) return;
    const targets = latestScope(scope.documents);
    const restore = () => restoreLibraryFocus(scope.origin);
    if (action === 'consistency') openConsistency(targets);
    else if (action === 'translate' || action === 'export' || action === 'source') setContextDialog({ kind: action, documents: targets, request: { original: action === 'source', restoreFocus: restore } });
    else if (action === 'cancel') processSelected(action, targets, restore);
    else confirmBatch(action, targets, restore);
  };
  const library = <StudioLibrary documents={documents} selected={selected} previewId={activeDocument?.id} query={query} onQuery={changeQuery} total={total} allTotal={allTotal} offset={listOffset} busy={busy} onPage={offset => void run('load', () => load(offset))} onPreview={chooseDocument} onToggle={toggleDocument} onSelectPage={selectPage} onSelectAll={selectAll} onClearScope={() => { invalidateSelectionRequest(); updateSelection(items => items.filter(doc => !matchesLibraryQuery(doc, queryRef.current))); }} onClear={clearSelection} selectionPending={selectionPending} selectionLimit={selectionLimit} onDismissLimit={() => setSelectionLimit(false)} encoding={encodingField} actions={batchActions} onContextAction={contextAction} />;

  return <div ref={workspaceRoot} data-testid="subtitle-studio" data-workspace-view={workspaceView} className={page && workspaceView === 'documents' ? 'studio studio-has-document' : 'studio'}>
    <ClipPathTabs value={workspaceView} onValueChange={changeWorkspaceView} ariaLabel={t('studio:workspace_view')} shape="rounded" smoothCorners size="sm" transitionDuration={200} transitionEasing="ease-out" className="studio-workspace-tabs w-full" items={[
      { value: 'documents', label: t('studio:workspace_documents'), icon: <Library /> },
      { value: 'transcription', label: t('studio:workspace_transcription'), icon: <AudioLines /> },
    ]}>
    <div className="studio-workspace-header"><ToolPageHeader meta={TOOL_META.subtitleStudio} title={t('studio:title')} description={<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"><span>{t('tools:field_desc.subtitle_studio')}</span><Link to="/tools/translation-knowledge" className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">{t('knowledge:title')}</Link></span>} /></div>
    <ClipPathTabsContent {...dropProps} value="documents" forceMount hidden={workspaceView !== 'documents'} className="studio-workspace-content">
    <ToolDetailLayout
      className="studio-layout"
      header={null}
      asideClassName="hidden lg:block"
      mainClassName={expansion.expanded ? 'studio-main studio-main-expanded' : 'studio-main'}
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
      {cueNotice && page && <div role="status" data-testid="studio-cue-notice" className="studio-notice">
        {cueNotice.deleted ? <Trash2 className="text-muted-foreground" /> : <AlertCircle className="text-amber-600 dark:text-amber-400" />}
        <span>{[cueNotice.deleted ? t('studio:cue_notice.deleted', { count: cueNotice.deleted }) : '', cueNotice.stopped ? t('studio:cue_notice.stopped', { count: cueNotice.stopped }) : ''].filter(Boolean).join(' ')}</span>
        {cueNotice.deleted > 0 && cueHistory.current.peek('undo')?.label === 'delete' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setCueNotice(null); stepCueHistory('undo'); }}><Undo2 />{t('studio:cue_history.undo_short')}</Button>}
        <StudioIconButton label={t('studio:dismiss')} onClick={() => setCueNotice(null)}><X /></StudioIconButton>
      </div>}
      {page && bilingualNotice === page.summary.id && page.summary.bilingualImport && <div role="status" data-testid="studio-bilingual-notice" className="studio-notice">
        <Columns2 className="text-muted-foreground" />
        <span>{t('studio:bilingual_import.notice', { direction: bilingualDirection(t, page.summary.bilingualImport), count: page.summary.cueCount })}</span>
        {page.summary.bilingualRevertible && <Button size="sm" variant="ghost" disabled={busy} data-testid="studio-bilingual-notice-revert" onClick={() => {
          const summary = page.summary;
          setBilingualNotice('');
          void run('select', async () => { const reverted = await revertBilingualImport(summary); await select(reverted); await load(currentOffset.current); });
        }}><Undo2 />{t('studio:bilingual_import.revert')}</Button>}
        <StudioIconButton label={t('studio:dismiss')} onClick={() => setBilingualNotice('')}><X /></StudioIconButton>
      </div>}
      {knowledgeOffer && page && <div role="status" data-testid="studio-knowledge-offer" className="studio-notice">
        <BookOpen className="text-muted-foreground" />
        <span>{t('studio:knowledge_offer.text', { count: knowledgeOffer.hints.length })}</span>
        <Button size="sm" variant="ghost" data-testid="studio-knowledge-offer-open" onClick={() => setCaptureOpen(true)}>{t('studio:knowledge_offer.action')}</Button>
        <StudioIconButton label={t('studio:dismiss')} onClick={() => setKnowledgeOffer(null)}><X /></StudioIconButton>
      </div>}
      <div aria-busy={busy || (!!previewRequest && !previewRequest.error)} className="studio-preview-region" data-preview-pending={!!previewRequest || undefined} data-reader-size={expansion.expanded ? expansion.readerSize : undefined}>
        <div className="studio-preview-surface" inert={!!previewRequest} aria-hidden={previewRequest ? true : undefined}>
        <ToolPanel
          title={t('studio:preview')}
          icon={Subtitles}
          badge={page ? <Badge variant="secondary" className="font-mono text-[11px]">{page.summary.cueCount}</Badge> : undefined}
          actions={page ? <><StudioBilingual page={page} busy={busy} onError={code => { retry.current = null; setError(code); }} onChanged={doc => { void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} /><StudioRevertBilingual page={page} busy={busy} onError={code => { retry.current = null; setError(code); }} onChanged={doc => { setBilingualNotice(''); void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} /><StudioTranslation page={page} recheckRequest={knowledgeRecheck} onRecheckClosed={requestId => setKnowledgeRecheck(current => current?.requestId === requestId ? undefined : current)} busy={busy} onError={code => { retry.current = null; setError(code); }} onStarted={onBatchChanged} /><StudioExport page={page} trackId={track?.id} busy={busy} onError={code => { retry.current = null; setError(code); }} onExported={setExported} /><StudioRevealSource key={page.summary.id} kind="document" id={page.summary.id} /><StudioIconButton id="studio-delete-trigger" label={t('studio:delete_document')} disabled={busy} onClick={() => setDeleting(page.summary)}><Trash2 /></StudioIconButton><StudioPreviewExpandControls expansion={expansion} onPreviousDocument={previousDocument && (() => chooseDocument(previousDocument))} onNextDocument={nextDocument && (() => chooseDocument(nextDocument))} /></> : undefined}
          className="studio-preview-panel"
          footer={page ? <div className="studio-reader-footer"><span className="flex items-center gap-1.5 text-[11px] text-muted-foreground studio-footer-status">{busy ? <LoaderCircle className="h-3.5 w-3.5 studio-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}{busy ? t('studio:loading') : t(page.summary.capabilities.preserveSource ? 'studio:source_preserved' : 'studio:transcription_preserved')}</span><StudioPagination offset={view === 'raw' ? page.nodeOffset : page.offset} total={view === 'raw' ? page.nodeCount : page.summary.cueCount} busy={busy} onChange={offset => void run('select', () => select(page.summary, view === 'raw' ? page.offset : offset, view === 'raw' ? offset : page.nodeOffset))} /></div> : undefined}
        >
          {page ? <>
            {track && <div className="studio-translation-toolbar">
              <div className="studio-translation-track-controls">
              <Select value={track.id} onValueChange={setTrackId}><SelectTrigger aria-label={t('studio:translation_track')} title={formatStudioTrackName(track.language, page.translationTracks.findIndex(item => item.id === track.id), t('studio:language_unknown'), track.name)} className="h-7 w-[160px] shrink-0 text-xs"><SelectValue /></SelectTrigger><SelectContent className="studio-track-options">{page.translationTracks.map((item, index) => <SelectItem key={item.id} value={item.id}>{formatStudioTrackName(item.language, index, t('studio:language_unknown'), item.name)}</SelectItem>)}</SelectContent></Select>
              <StudioRenameTranslation key={`${page.summary.id}:${track.id}`} page={page} track={track} busy={busy} onChanged={doc => { void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} />
              <StudioRemoveTranslation page={page} track={track} busy={busy} onError={code => { retry.current = null; setError(code); }} onChanged={doc => { setTrackId(''); void run('select', async () => { await select(doc); await load(currentOffset.current); }); }} />
              </div>
              <div className="studio-translation-progress-controls">
                <StudioTranslationStatus page={page} trackId={track.id} busy={busy} onRecheck={requestKnowledgeRecheck} />
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
                  {page.summary.bilingualImport && <span data-testid="studio-bilingual-label">{t('studio:bilingual_import.label', { direction: bilingualDirection(t, page.summary.bilingualImport) })}</span>}
                  <span>{t(track?.origin === 'imported' ? 'studio:translation_imported' : track && page.summary.translationStatus !== 'none' ? 'studio:translation_unreviewed' : 'studio:source_only')}</span>
                </div>
              </div>
              {diagnostics.length > 0 && <StudioDisclosure className="studio-diagnostics border-t bg-muted/30" key={page.summary.id} title={<span className="flex min-w-0 items-center gap-2"><AlertCircle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" /><span>{t('studio:document_checks')}</span><Badge variant="secondary" className="font-mono text-[10px]">{page.summary.diagnostics.length}</Badge></span>}><ul>{diagnostics.map(([code, count]) => <li key={code}><span>{t(diagnosticKeys[code])}</span><span className="shrink-0 font-mono text-[10px]">{count}</span></li>)}</ul></StudioDisclosure>}
              <div className="studio-reader border-t" ref={reader}>
                <ClipPathTabsContent value="preview">
                  {page.cues.length ? <StudioCueTable page={page} track={track} flaggedNodes={flaggedNodes} busy={busy} copied={copied} scrollRef={reader}
                    history={{ undo: cueHistory.current.peek('undo'), redo: cueHistory.current.peek('redo') }}
                    onOperation={(operation, label, count) => applyCueEdit(operation, 'do', label, count)} onUndo={() => stepCueHistory('undo')} onRedo={() => stepCueHistory('redo')}
                    onTranslate={cueIds => setCueTranslation({ cueIds, ...(track ? { trackId: track.id } : {}), request: { restoreFocus: focusCueList } })}
                    onRevise={cueIds => setCueRevision({ cueIds, serial: ++cueRevisionSerial.current })} onCheckConsistency={() => openConsistency(page ? [page.summary] : [])}
                    onSelectionChange={cueIds => { cueSelection.current = cueIds; }}
                    onCopy={copyCue}
                    onRemember={cue => setRememberTerm({ source: cue.source.plain, target: track?.entries[cue.id]?.sourceRevision === cue.sourceRevision ? track.entries[cue.id].text.plain : '', targetLanguage: track?.language === 'zh' ? 'zh-Hans' : track?.language ?? '' })} /> : <div className="studio-content-empty"><Subtitles /><p>{t('studio:diagnostics.empty_document')}</p></div>}
                </ClipPathTabsContent>
                <ClipPathTabsContent value="raw" className="studio-raw"><ol start={page.nodeOffset + 1}>{page.rawNodes.map((node, index) => <li key={node.id}><span aria-hidden="true">{page.nodeOffset + index + 1}</span><pre>{node.text}</pre></li>)}</ol>{!page.rawNodes.length && <div className="studio-content-empty"><Code2 /><p>{t('studio:no_source_content')}</p></div>}</ClipPathTabsContent>
              </div>
            </ClipPathTabs>
          </> : <div className="studio-content-empty py-14">{busy ? <LoaderCircle className="studio-spin" /> : <Subtitles />}<p>{busy ? t('studio:loading') : t('studio:empty')}</p></div>}
        </ToolPanel>
        </div>
        <div className="studio-preview-loading" data-testid="studio-preview-loading" data-visible={!!previewRequest} aria-hidden={!previewRequest} inert={!previewRequest}>
          {displayedPreviewRequest && <div role={displayedPreviewRequest.error ? 'alert' : 'status'}>
            {displayedPreviewRequest.error ? <AlertCircle className="text-destructive" /> : <LoaderCircle className="studio-spin" />}
            <strong><StudioFileName name={displayedPreviewRequest.document.origin.displayName} /></strong>
            <span>{t(displayedPreviewRequest.error ? errorKeys[displayedPreviewRequest.error] : 'studio:loading')}</span>
            {displayedPreviewRequest.error && <Button size="sm" variant="outline" onClick={() => chooseDocument(displayedPreviewRequest.document)}>{t('studio:retry')}</Button>}
          </div>}
        </div>
      </div>
    </ToolDetailLayout>
    </ClipPathTabsContent>
    <ClipPathTabsContent value="transcription" className="studio-workspace-content">
      {workspaceView === 'transcription' && <StudioTranscription header={null} onOpenDocument={openTranscriptionDocument} />}
    </ClipPathTabsContent>
    </ClipPathTabs>
    {page && <StudioCueRevision page={page} track={track} request={cueRevision} editBlocked={page.tasks.some(task => task.status === 'queued' || task.status === 'running') ? t('studio:cue_edit.blocked_translation') : undefined}
      onClose={() => setCueRevision(null)} onApply={(operation, count, applied) => applyCueEdit(operation, 'do', 'revise', count).then(ok => {
        if (ok && applied.knowledgeHints.length) void offerKnowledge(applied.knowledgeHints, applied.instructions);
        return ok;
      })} />}
    {page && <StudioTranslation page={page} scope={cueTranslation ?? undefined} triggerContainer={null} openRequest={cueTranslation?.request} onRequestClosed={() => setCueTranslation(null)} busy={busy} onError={code => { retry.current = null; setError(code); }} onStarted={onBatchChanged} />}
    <StudioConsistencyCheck request={consistency} currentDocumentId={page?.summary.id} editBlocked={page?.tasks.some(task => task.status === 'queued' || task.status === 'running') ? t('studio:cue_edit.blocked_translation') : undefined}
      onClose={() => setConsistency(null)} onApplyCurrent={(operation, count) => applyCueEdit(operation, 'do', 'unify', count)} onUndoCurrent={undoUnify} onChangedOther={onBatchChanged}
      onKeep={(wordings, saved) => void keepCheckedWordings(wordings, saved)}
      onReviseLines={(lines, instructions) => { setConsistency(null); setCueRevision({ cueIds: [], serial: ++cueRevisionSerial.current, preset: { instructions, scope: 'document', fields: 'target', search: { lines } } }); }} />
    <KnowledgeCaptureDialog open={!!checkCapture} onOpenChange={open => { if (!open) setCheckCapture(null); }} wordings={checkCapture?.wordings ?? []}
      languagePair={checkCapture?.pair} preferredCollectionId={checkCapture?.preferredCollectionId} onSaved={() => checkCapture?.saved()} />
    <KnowledgeCaptureDialog open={captureOpen && !!knowledgeOffer} onOpenChange={open => { if (!open) setCaptureOpen(false); }} wordings={knowledgeOffer?.hints ?? []}
      languagePair={knowledgeOffer?.pair} preferredCollectionId={knowledgeOffer?.preferredCollectionId} evidence={knowledgeOffer?.instructions} onSaved={() => setKnowledgeOffer(null)} />
    <QuickTermDialog open={!!rememberTerm} onOpenChange={open => { if (!open) setRememberTerm(null); }} initialSource={rememberTerm?.source} initialTarget={rememberTerm?.target} initialLanguagePair={rememberTerm?.targetLanguage ? { source: '', target: rememberTerm.targetLanguage } : undefined} />
    <StudioBatchTranslation triggerContainer={translationSlot} documents={contextDialog?.kind === 'translate' ? latestScope(contextDialog.documents) : selected} openRequest={contextDialog?.kind === 'translate' ? contextDialog.request : undefined} onRequestClosed={() => setContextDialog(current => current?.kind === 'translate' ? null : current)} busy={busy} onError={code => { retry.current = null; setError(code); }} onStarted={onBatchChanged} />
    <StudioBatchExport triggerContainer={exportSlot} documents={contextDialog && contextDialog.kind !== 'translate' ? latestScope(contextDialog.documents) : selected} openRequest={contextDialog && contextDialog.kind !== 'translate' ? contextDialog.request : undefined} onRequestClosed={() => setContextDialog(current => current?.kind !== 'translate' ? null : current)} busy={busy} onError={code => { retry.current = null; setError(code); }} onExported={setExported} />
    <AnimatePresence>{!wide && <ScrollableDialog key="library" animateSize open={libraryOpen} onOpenChange={setLibraryOpen} maxWidth="sm:max-w-[540px]" contentClassName="studio-library-dialog" onOpenAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLInputElement>('[data-testid=studio-library-search]')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); document.getElementById('studio-library-trigger')?.focus(); }}><ScrollableDialogHeader><DialogTitle>{t('studio:documents')} · {allTotal}</DialogTitle><DialogDescription className="sr-only">{t('studio:library.selection_rule')}</DialogDescription></ScrollableDialogHeader><ScrollableDialogContent>{library}</ScrollableDialogContent></ScrollableDialog>}</AnimatePresence>
    <StudioRecovery open={recoveryOpen} onOpenChange={setRecoveryOpen} documents={unavailable} onChanged={pending => { if (pending) setCleanupPending(true); dirty.current = true; refreshPending.current(); }} onError={code => { retry.current = null; setError(code); }} />
    <ScrollableDialog animateSize open={!!batchConfirm} maxWidth="sm:max-w-[560px]" contentClassName="studio-batch-confirm-dialog" onOpenChange={open => { if (!open) setBatchConfirm(null); }} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-batch-cancel')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); if (operation.current || results) return; if (confirmReturnAction.current) { confirmReturnAction.current(); return; } (document.getElementById('studio-library-batch-actions') ?? document.querySelector<HTMLElement>('[data-testid=studio-library-select-all]'))?.focus({ preventScroll: true }); }}>
      <ScrollableDialogHeader className="relative p-3 pr-12"><DialogTitle className="flex items-center gap-2 text-sm">{displayedConfirmation?.kind === 'delete' ? <Trash2 className="size-4" /> : <Play className="size-4" />}{t(displayedConfirmation?.kind === 'delete' ? 'studio:library.delete_selected' : 'studio:library.resume_selected')}</DialogTitle><DialogDescription className="text-xs leading-5">{t(displayedConfirmation?.kind === 'delete' ? 'studio:delete_description' : 'studio:library.resume_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent className="studio-batch-confirm-content"><div className="space-y-3"><StudioSelectedDocuments documents={displayedConfirmation?.documents ?? []} collapsible={false} />{displayedConfirmation?.kind === 'resume' && <p className="text-xs leading-5 text-amber-600 dark:text-amber-400">{t('studio:library.resume_uncertain')}</p>}</div></ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2 p-3"><Button id="studio-batch-cancel" variant="ghost" size="sm" onClick={() => setBatchConfirm(null)}>{t('studio:cancel')}</Button><Button size="sm" variant={displayedConfirmation?.kind === 'delete' ? 'destructive' : 'default'} disabled={busy} onClick={() => batchConfirm && processSelected(batchConfirm.kind, batchConfirm.documents, batchConfirm.restore)}>{t(displayedConfirmation?.kind === 'delete' ? 'studio:library.confirm_delete' : 'studio:library.confirm_resume')}</Button></ScrollableDialogFooter>
    </ScrollableDialog>
    <ScrollableDialog animateSize open={!!results} onOpenChange={open => { if (!open) setResults(null); }} maxWidth={STUDIO_RESULT_DIALOG_WIDTH} contentClassName={STUDIO_RESULT_DIALOG_CLASS} onCloseAutoFocus={event => { event.preventDefault(); restoreResultFocus(); }}>
      {displayedResults && <StudioOperationResult operation={displayedResults.kind} testId="studio-library-result" closeButtonId="studio-result-close" onClose={() => setResults(null)} items={displayedResults.items.map((item, index) => ({ id: `${item.documentId ?? item.name}:${index}`, name: item.name, state: item.error ? 'failed' : item.skipped ? 'skipped' : 'success', ...(item.bilingual ? { note: t('studio:bilingual_import.result', { direction: item.bilingual }) } : {}), detail: item.error ? t(errorKeys[item.error]) : item.skipped ? t(item.skipped) : t(displayedResults.kind === 'resume' ? 'studio:library.resume_requested' : displayedResults.kind === 'cancel' ? 'studio:library.cancel_requested' : 'studio:library.succeeded') }))} />}
    </ScrollableDialog>
    <ScrollableDialog animateSize open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }} onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('studio-delete-cancel')?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); document.getElementById('studio-delete-trigger')?.focus(); }}>
      <ScrollableDialogHeader><DialogTitle className="pr-6">{t('studio:delete_document')}</DialogTitle><DialogDescription>{t('studio:delete_description')}</DialogDescription></ScrollableDialogHeader>
      <ScrollableDialogContent><StudioDocumentList scroll={false}>{deleting && <StudioDocumentRow name={deleting.origin.displayName} />}</StudioDocumentList></ScrollableDialogContent>
      <ScrollableDialogFooter><div className="flex justify-end gap-2"><Button id="studio-delete-cancel" variant="outline" onClick={() => setDeleting(null)}>{t('studio:cancel')}</Button><Button variant="destructive" disabled={busy} onClick={deleteDocument}><Trash2 />{t('studio:delete_document')}</Button></div></ScrollableDialogFooter>
    </ScrollableDialog>
  </div>;
}
