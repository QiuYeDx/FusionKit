import type {
  MaintenancePreview,
  MaintenanceRequest,
} from "@/translation-knowledge/maintenance-contract";
import { HistoryDialog, MaintenanceDialog } from "./Maintenance";
import { languagePairLabel } from "./labels";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useAgentPageContext } from "@/agent/page-context";
import { KNOWLEDGE_CHANGED_EVENT, newerSnapshot } from "@/translation-knowledge/library-events";
import { focusedCollection, knowledgePageContext, type KnowledgePageState } from "./agent-context";
import { AnimatePresence } from "motion/react";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import {
  Archive,
  ArrowRight,
  BookOpen,
  CircleHelp,
  Copy,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Search,
  ClipboardPaste,
  Ellipsis,
  X,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ClipPathTabs } from "@/components/qiuye-ui/clip-path-tabs";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { ToolDetailLayout } from "@/pages/Tools/_shared/ui/ToolDetailLayout";
import { useToolFileDropTarget } from "@/pages/Tools/_shared/ui/ToolFileDropScope";
import { ToolPanel } from "@/pages/Tools/_shared/ui/ToolPanel";
import type { Entry } from "@/translation-knowledge/schemas";
import type {
  ImportPreview,
  KnowledgeErrorCode,
  LibrarySnapshot,
  SaveRecordRequest,
  KnowledgeResult,
} from "@/translation-knowledge/ipc-contract";
import { entrySummary } from "@/translation-knowledge/ipc-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { Choice, ErrorNotice, KnowledgeDialog, Pagination } from "./Controls";
import {
  CatalogEditor,
  newCatalog,
  type CatalogGroup,
  type CatalogRecord,
} from "./CatalogEditor";
import { EntryEditor } from "./EntryEditor";
import { InlineTermEditor } from "./InlineTermEditor";
import { BulkTermPaste } from "./BulkTermPaste";
import { KnowledgeTour, useKnowledgeTour } from "./KnowledgeTour";
import { KnowledgeSidebar, type KnowledgeLibraryView } from "./KnowledgeSidebar";
import { KnowledgeScrollList } from "./KnowledgeScrollList";
import { ExportDialog, ImportDialog } from "./Exchange";
import { EntryDetails } from "./EntryDetails";
import { BatchReviewDialog } from "./BatchReviewDialog";
import { type BatchReviewAction } from "./batch-review";
import {
  entryStatus,
  newEntry,
  filterEntries,
  freshId,
  initialQuery,
  needsReview,
  PAGE_SIZE,
  acceptsKnowledgeDrop,
  withEntryKind,
} from "./model";

type View = KnowledgeLibraryView;
type ContentKind = "term" | "context" | "rule";
export default function TranslationKnowledge() {
  const { t } = useTranslation("knowledge");
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<View>("materials");
  const [query, setQuery] = useState(initialQuery);
  const [contentKind, setContentKind] = useState<ContentKind>("term");
  const [destination, setDestination] = useState<ContentKind | "bulk" | null>(null);
  const [bulkCollectionId, setBulkCollectionId] = useState<string | null>(null);
  const continuationKind = useRef<ContentKind | "bulk">("term");
  const [page, setPage] = useState(0);
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelection, setBatchSelection] = useState<{ scope: string; generation: number; ids: string[] }>({ scope: '', generation: -1, ids: [] });
  const [batchReview, setBatchReview] = useState<{ snapshot: LibrarySnapshot; ids: string[]; action: BatchReviewAction } | null>(null);
  const [planPage, setPlanPage] = useState(0);
  const [planGroup, setPlanGroup] = useState<
    "recipes" | "styles" | "preferenceTemplates"
  >("recipes");
  const [catalog, setCatalog] = useState<{
    group: CatalogGroup;
    record: CatalogRecord;
  } | null>(null);
  const [entryEditor, setEntryEditor] = useState<Entry | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [detailError, setDetailError] = useState<
    KnowledgeErrorCode | "unexpected" | null
  >(null);
  const [detailDiagnostics, setDetailDiagnostics] = useState<Diagnostic[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [maintenancePreview, setMaintenancePreview] =
    useState<MaintenancePreview | null>(null);
  const [dropError, setDropError] = useState(false);
  const maintenanceFocusTarget = useRef<HTMLElement | null>(null);
  const continueWithEntry = useRef(false);
  const blocked = snapshot?.maintenance?.cleanupPending === true;
  const api = window.translationKnowledge;
  const refresh = async () => {
    setLoading(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await api.read();
      if (result.ok) setSnapshot(result.value);
      else {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setError("unexpected");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  // The assistant and Studio dialogs save without this page; show their result as it lands.
  useEffect(() => {
    const changed = (event: Event) => {
      const incoming = (event as CustomEvent<LibrarySnapshot>).detail;
      if (incoming) setSnapshot(current => newerSnapshot(current, incoming));
    };
    window.addEventListener(KNOWLEDGE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(KNOWLEDGE_CHANGED_EVENT, changed);
  }, []);
  // Opened from a saved card: show that collection once, then forget the request.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const focus = (location.state as { knowledgeFocus?: unknown } | null)?.knowledgeFocus;
    if (!snapshot || !focus) return;
    const collectionId = focusedCollection(snapshot, focus);
    if (collectionId) { setView("materials"); setQuery({ ...initialQuery, collection: collectionId }); setSelected(null); }
    navigate(location.pathname, { replace: true, state: null });
  }, [snapshot, location.state]);
  useEffect(() => {
    setPage(0);
  }, [query, view, contentKind]);
  const filtered = useMemo(() => {
    if (!snapshot) return [];
    const archivedCollections = new Set(snapshot.data.collections.filter(item => item.archived).map(item => item.id));
    const base = filterEntries(snapshot, { ...query, kind: view === "materials" ? contentKind : query.kind }, view === "review");
    return base.filter(entry => {
      const archived = entry.state === "archived" || archivedCollections.has(entry.collectionId);
      if (view === "archived") return archived;
      if (archived) return false;
      return true;
    });
  }, [snapshot, query, view, contentKind]);
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const currentEntry = snapshot?.data.entries.find(
    (item) => item.id === selected,
  );
  const batchVisible = (batchMode || view === 'review') && !['plans', 'archived'].includes(view);
  const selectionScope = JSON.stringify([view, query, contentKind]);
  const reviewable = snapshot ? filtered.filter(entry => needsReview(entry, snapshot)) : [];
  const reviewableIds = new Set(reviewable.map(entry => entry.id));
  const selectedIds = batchSelection.scope === selectionScope && batchSelection.generation === snapshot?.generation
    ? batchSelection.ids.filter(id => reviewableIds.has(id)) : [];
  const pageReviewable = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).filter(entry => reviewableIds.has(entry.id));
  const pageSelected = pageReviewable.filter(entry => selectedIds.includes(entry.id)).length;
  const setBatchIds = (ids: string[]) => setBatchSelection({ scope: selectionScope, generation: snapshot?.generation ?? -1, ids });
  const openBatchReview = (action: BatchReviewAction) => {
    if (!snapshot || !selectedIds.length || busy || blocked) return;
    setBatchReview({ snapshot, ids: [...selectedIds], action });
  };
  const reviewCount =
    snapshot?.data.entries.filter((entry) => needsReview(entry, snapshot) && !snapshot.data.collections.find(collection => collection.id === entry.collectionId)?.archived)
      .length ?? 0;
  const currentCollection = snapshot?.data.collections.find(
    (item) => item.id === query.collection,
  );
  const agentState = useRef<KnowledgePageState>({ snapshot: null, view, collectionId: query.collection, visible: [], selectedIds: [] });
  agentState.current = { snapshot, view, collectionId: query.collection, selectedIds,
    visible: view === "plans" ? [] : filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE) };
  useAgentPageContext(() => knowledgePageContext(() => agentState.current));
  const save = async (
    request: SaveRecordRequest,
  ): Promise<KnowledgeResult<LibrarySnapshot>> => {
    if (blocked) return { ok: false, error: "storage_unavailable" };
    const result = await api.saveRecord(request);
    if (result.ok) {
      setSnapshot(result.value);
      setNotice(t(request.group === "entries" && !("state" in request.record && request.record.state === "archived") ? request.adopt ? "guide.saved_adopted" : "guide.saved_candidate" : "saved"));
      if (request.group === "collections") {
        const collection = result.value.data.collections.find(item => item.id === request.record.id);
        if (collection) {
          setQuery({ ...initialQuery, collection: collection.id });
          setView(collection.archived ? "archived" : "materials");
          if (continueWithEntry.current) {
            continueWithEntry.current = false;
            if (continuationKind.current === "bulk") { setContentKind("term"); setBulkCollectionId(collection.id); }
            else { setContentKind(continuationKind.current); setEntryEditor(withEntryKind(newEntry(collection), continuationKind.current)); }
          }
        }
      }
      return result;
    }
    if (result.error === "revision_conflict") void refresh();
    return result;
  };
  const beginImport = async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await api.selectImport();
      if (result.ok) {
        if (result.value) { setHistoryOpen(false); setPreview(result.value); }
      } else {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setError("unexpected");
    } finally {
      setBusy(false);
    }
  };
  const review = async (action: "adopt" | "reject") => {
    if (!snapshot || !currentEntry || blocked) return;
    setBusy(true);
    setDetailError(null);
    setDetailDiagnostics([]);
    try {
      const result = await api.reviewEntries({
        generation: snapshot.generation,
        ids: [currentEntry.id],
        action,
      });
      if (result.ok) {
        setSnapshot(result.value);
        setSelected(null);
        setNotice(t(`review.success.${action}`));
      } else {
        setDetailError(result.error);
        setDetailDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setDetailError("unexpected");
    } finally {
      setBusy(false);
    }
  };
  const planMaintenance = async (
    request: MaintenanceRequest,
  ): Promise<KnowledgeResult<MaintenancePreview>> => {
    if (blocked || busy) return { ok: false, error: "storage_unavailable" };
    const target = 'targets' in request ? request.targets[0] : undefined;
    maintenanceFocusTarget.current = target?.group === 'entries'
      ? document.querySelector(`[data-testid="knowledge-entry-details-${target.id}"]`)
      : target?.group === 'collections' ? document.querySelector('[data-testid="knowledge-collection-actions"]')
        : target ? document.querySelector(`[data-catalog-id="${target.id}"]`)
          : document.querySelector('[data-testid="knowledge-history"]');
    setBusy(true);
    setError(null);
    setDiagnostics([]);
    setDetailError(null);
    setDetailDiagnostics([]);
    try {
      const result = await api.planMaintenance(request);
      if (result.ok) {
        setMaintenancePreview(result.value);
        setCatalog(null);
        setSelected(null);
        setHistoryOpen(false);
      } else {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
        setDetailError(result.error);
        setDetailDiagnostics(result.diagnostics ?? []);
      }
      return result;
    } catch {
      setError("unexpected");
      setDetailError("unexpected");
      return { ok: false, error: "storage_unavailable" };
    } finally {
      setBusy(false);
    }
  };
  const drop = async (event: DragEvent<HTMLElement>) => {
    if (blocked || busy) return;
    const files = Array.from(event.dataTransfer.files);
    setDropError(false);
    if (!acceptsKnowledgeDrop(files)) {
      setDropError(true);
      return;
    }
    setBusy(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await api.importDroppedFile(files[0]);
      if (result.ok) setPreview(result.value);
      else {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
      }
    } catch {
      setError("unexpected");
    } finally {
      setBusy(false);
    }
  };
  const { dragging, dropProps } = useToolFileDropTarget({
    onDrop: drop,
    disabled: blocked || busy,
    label: t("actions.import"),
  });
  const tourReady = Boolean(snapshot) && !loading && !busy && !blocked &&
    !catalog && !entryEditor && !selected && !preview && !exportOpen &&
    !historyOpen && !maintenancePreview && !dragging && !destination && !bulkCollectionId;
  const { tourOpen, setTourOpen } = useKnowledgeTour(tourReady);
  const beginForCollection = (collectionId: string, kind: ContentKind | "bulk") => {
    const collection = snapshot?.data.collections.find(item => item.id === collectionId && !item.archived);
    if (!collection) return;
    setDestination(null);
    setQuery({ ...initialQuery, collection: collection.id });
    setView("materials");
    if (kind === "bulk") { setContentKind("term"); setBulkCollectionId(collection.id); }
    else { setContentKind(kind); setEntryEditor(withEntryKind(newEntry(collection), kind)); }
  };
  const startEntry = (kind: ContentKind | "bulk" = contentKind) => {
    if (!snapshot || blocked) return;
    if (currentCollection && !currentCollection.archived) { beginForCollection(currentCollection.id, kind); return; }
    if (!snapshot.data.collections.some(item => !item.archived)) {
      continueWithEntry.current = true;
      continuationKind.current = kind;
      setCatalog({ group: "collections", record: newCatalog("collections") });
      return;
    }
    setDestination(kind);
  };
  const addCatalog = (group: CatalogGroup) => setCatalog({ group, record: newCatalog(group) });
  const selectCollection = (id: string, archived = false) => {
    setView(archived ? "archived" : "materials");
    setQuery({ ...initialQuery, collection: id });
    setPage(0);
  };
  const setLibraryView = (next: View) => { setView(next); setQuery(initialQuery); setPage(0); };
  const change = (key: keyof typeof query, value: string) => setQuery({ ...query, [key]: value });
  const header = <ToolPageHeader meta={TOOL_META.translationKnowledge} title={t("title")} description={t("description")} right={
    <Button data-testid="knowledge-tour-trigger" variant="ghost" size="icon-sm" aria-label={t("tour.trigger")} title={t("tour.trigger")} disabled={!tourReady} onClick={() => setTourOpen(true)}><CircleHelp /></Button>
  } />;
  const activeCollections = snapshot?.data.collections.filter(item => !item.archived) ?? [];
  const aside = <KnowledgeSidebar
    snapshot={snapshot}
    view={view}
    selectedCollectionId={query.collection}
    reviewCount={reviewCount}
    busy={busy}
    blocked={blocked}
    onSelectCollection={selectCollection}
    onSelectView={setLibraryView}
    onCreateCollection={() => addCatalog("collections")}
    onCreateSubject={() => addCatalog("subjects")}
    onEditSubject={subject => setCatalog({ group: "subjects", record: subject })}
    onImport={() => void beginImport()}
    onExport={() => setExportOpen(true)}
    onHistory={() => setHistoryOpen(true)}
  />;
  const plans =
    snapshot?.data[planGroup].filter(
      (item) =>
        !query.search.trim() ||
        `${item.name} ${"description" in item ? item.description : item.instructions}`
          .toLocaleLowerCase()
          .includes(query.search.trim().toLocaleLowerCase()),
    ) ?? [];
  const safePlanPage = Math.min(
    planPage,
    Math.max(0, Math.ceil(plans.length / PAGE_SIZE) - 1),
  );
  const workspaceTitle = currentCollection?.name ?? (view === "materials" ? t("workspace.all") : t(view === "plans" ? "views.plans" : view === "review" ? "workspace.review" : "workspace.archived"));
  const editableCollection = view === "materials" && currentCollection && !currentCollection.archived ? currentCollection : null;
  const bulkCollection = snapshot?.data.collections.find(item => item.id === bulkCollectionId);
  return (
    <div {...dropProps} data-testid="translation-knowledge">
      <ToolDetailLayout header={header} aside={aside} className="translation-knowledge md:[&>div.grid]:grid-cols-[240px_minmax(0,1fr)] lg:[&>div.grid]:grid-cols-[280px_minmax(0,1fr)]" asideClassName="lg:static lg:w-full">
        <div>
        <DialogTransition transitionKey="drop-error" stageClassName="pb-3">{dropError && <p role="alert" className="rounded-md border border-destructive/25 p-3 text-sm text-destructive">{t("drop.invalid")}</p>}</DialogTransition>
        <DialogTransition transitionKey="cleanup-pending" stageClassName="pb-3">{blocked && <div role="status" className="space-y-2 rounded-md border p-3"><p className="text-sm">{t("maintenance.cleanup_pending")}</p><Button data-testid="knowledge-cleanup-retry" size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>{t("maintenance.retry_cleanup")}</Button></div>}</DialogTransition>
        <ErrorNotice error={error} diagnostics={diagnostics} stageClassName="pb-3" />
        <DialogTransition transitionKey="notice" stageClassName="pb-3">{notice && <div role="status" className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 p-3 text-xs"><p className="break-words leading-5">{notice}</p><Button size="icon-xs" variant="ghost" aria-label={t("actions.dismiss")} onClick={() => setNotice("")}><X /></Button></div>}</DialogTransition>
        <div className="flex min-w-0 flex-col gap-3">
        {loading && !snapshot ? <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("loading")}</div> : snapshot && <>
          <div id="knowledge-content-heading" className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 space-y-1"><h2 className="break-words text-lg font-semibold">{workspaceTitle}</h2>{currentCollection && <p className="break-words text-xs leading-5 text-muted-foreground">{currentCollection.defaultLanguagePair ? languagePairLabel(t, currentCollection.defaultLanguagePair) : t("workspace.mixed_languages")}{currentCollection.description ? ` · ${currentCollection.description}` : ""}</p>}</div>
            <div className="flex shrink-0 items-center gap-1">{currentCollection && <>
              <Button variant="ghost" size="icon-sm" data-testid="knowledge-edit-collection" aria-label={t("workspace.edit_collection")} disabled={busy || blocked} onClick={() => setCatalog({ group: "collections", record: currentCollection })}><Pencil /></Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" data-testid="knowledge-collection-actions" aria-label={t("collection_actions.more")} disabled={busy || blocked}><Ellipsis /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem data-testid={currentCollection.archived ? "knowledge-collection-restore" : "knowledge-collection-archive"} onSelect={() => void planMaintenance({ generation: snapshot.generation, action: currentCollection.archived ? "restore" : "archive", targets: [{ group: "collections", id: currentCollection.id }] })}>
                    {currentCollection.archived ? <RotateCcw /> : <Archive />}{t(currentCollection.archived ? "collection_actions.restore" : "collection_actions.archive")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem data-testid="knowledge-collection-delete" variant="destructive" onSelect={() => void planMaintenance({ generation: snapshot.generation, action: "purge", targets: [{ group: "collections", id: currentCollection.id }], includeCollectionContents: true })}><Trash2 />{t("collection_actions.delete")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>}<Button variant="ghost" size="icon-sm" aria-label={t("actions.refresh")} disabled={loading || busy} onClick={() => void refresh()}><RefreshCw className={loading ? "animate-spin" : ""} /></Button></div>
          </div>
          {view === "archived" && <p data-testid="knowledge-archive-help" className="text-xs leading-5 text-muted-foreground">{t("collection_actions.archived_help")}</p>}
          {view === "materials" && <ClipPathTabs data-testid="knowledge-views" size="sm" shape="rounded" smoothCorners value={contentKind} onValueChange={value => setContentKind(value as ContentKind)} ariaLabel={t("workspace.content_types")} items={[
            { value: "term", label: t("workspace.terms") }, { value: "context", label: t("workspace.contexts") }, { value: "rule", label: t("workspace.rules") },
          ]} />}
          <ToolPanel id="knowledge-content" title={view === "plans" ? <ClipPathTabs data-testid="knowledge-plan-tabs" size="sm" shape="rounded" smoothCorners value={planGroup} onValueChange={value => { setPlanGroup(value as typeof planGroup); setPlanPage(0); }} ariaLabel={t("plans.category")} items={[{ value: "recipes", label: t("plans.recipes") }, { value: "styles", label: t("plans.styles") }, { value: "preferenceTemplates", label: t("plans.preferenceTemplates") }]} /> : t(view === "materials" ? `workspace.${contentKind === "term" ? "terms" : contentKind === "context" ? "contexts" : "rules"}` : "views.materials")} badge={<Badge variant="secondary">{view === "plans" ? plans.length : filtered.length}</Badge>} actions={<>
            {!['plans', 'archived', 'review'].includes(view) && reviewable.length > 0 && <Button data-testid="knowledge-batch-toggle" size="sm" variant="outline" disabled={busy || blocked} onClick={() => { setBatchMode(value => !value); setBatchIds([]); }}><Check />{t(batchVisible ? 'bulk_review.exit' : 'bulk_review.title')}</Button>}
            {view === "materials" && contentKind === "term" && <Button data-testid="knowledge-paste-open" variant="outline" size="sm" disabled={busy || blocked} onClick={() => startEntry("bulk")}><ClipboardPaste />{t("paste.title")}</Button>}
            {(view === "materials" || view === "plans") && <Button data-testid="knowledge-new-entry" size="sm" disabled={busy || blocked} onClick={() => view === "plans" ? addCatalog(planGroup) : startEntry()}><Plus />{t(view === "plans" ? "actions.new_plan_item" : contentKind === "term" ? "workspace.add_term" : contentKind === "context" ? "workspace.add_context" : "workspace.add_rule")}</Button>}
          </>} bodyClassName="min-w-0">
            <div className="space-y-3 border-b p-3"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input aria-label={t("filters.search")} placeholder={t("filters.search")} value={query.search} onChange={event => { change("search", event.target.value); setPlanPage(0); }} className="h-8 pl-8 text-sm" /></div>
              {view === 'review' && <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <Choice label={t('bulk_review.collection')} value={query.collection} disabled={busy || blocked} onChange={value => change('collection', value)} options={[{ value: 'all', label: t('workspace.all') }, ...activeCollections.map(c => ({ value: c.id, label: c.name }))]} />
                <Choice label={t('bulk_review.kind')} value={query.kind} disabled={busy || blocked} onChange={value => change('kind', value)} options={[{ value: 'all', label: t('bulk_review.all_kinds') }, ...(['term', 'context', 'rule', 'expression', 'memory'] as const).map(value => ({ value, label: t(`kind.${value}`) }))]} />
              </div>}
            </div>
            {view === "plans" ? <>
              <KnowledgeScrollList key={`plans:${planGroup}:${safePlanPage}:${query.search}`} testId="knowledge-results-scroll">{plans.slice(safePlanPage * PAGE_SIZE, (safePlanPage + 1) * PAGE_SIZE).map(item => <div key={item.id} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted/50"><button data-catalog-id={item.id} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setCatalog({ group: planGroup, record: item })}><p className="break-words text-sm font-medium">{item.name}{item.archived ? ` · ${t("status.archived")}` : ""}</p><p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{"description" in item ? item.description : item.instructions}</p></button><Button size="icon-sm" variant="ghost" aria-label={t("actions.copy")} onClick={() => setCatalog({ group: planGroup, record: { ...item, id: freshId(), revision: 1, name: t("copy_name", { name: item.name }), archived: false } })}><Copy /></Button></div>)}{!plans.length && <Empty title={t("empty.plans")} description={t("empty.plans_help")} />}</KnowledgeScrollList>
              <Pagination page={safePlanPage} total={plans.length} onChange={setPlanPage} />
            </> : <>
              {batchVisible && <div data-testid="knowledge-batch-toolbar" className="space-y-2 border-b p-3">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <label className="flex items-center gap-2 text-xs"><Checkbox data-testid="knowledge-select-page" aria-label={t('bulk_review.select_page')} disabled={!pageReviewable.length || busy || blocked} checked={pageSelected === 0 ? false : pageSelected === pageReviewable.length ? true : 'indeterminate'} onCheckedChange={checked => setBatchIds(checked ? [...new Set([...selectedIds, ...pageReviewable.map(e => e.id)])] : selectedIds.filter(id => !pageReviewable.some(e => e.id === id)))} />{t('bulk_review.select_page')}</label>
                  <span className="text-xs tabular-nums text-muted-foreground" data-testid="knowledge-selection-count">{t('bulk_review.selected', { count: selectedIds.length })}</span>
                  <Button size="sm" variant="ghost" data-testid="knowledge-select-filtered" disabled={!reviewable.length || busy || blocked || selectedIds.length === reviewable.length} onClick={() => setBatchIds(reviewable.map(e => e.id))}>{t('bulk_review.select_filtered', { count: reviewable.length })}</Button>
                  {selectedIds.length > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBatchIds([])}>{t('bulk_review.clear')}</Button>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" data-testid="knowledge-batch-adopt" disabled={!selectedIds.length || busy || blocked} onClick={() => openBatchReview('adopt')}><Check />{t('bulk_review.adopt')}</Button>
                  <Button size="sm" variant="outline" data-testid="knowledge-batch-reject" disabled={!selectedIds.length || busy || blocked} onClick={() => openBatchReview('reject')}>{t('bulk_review.reject')}</Button>
                  <span className="text-xs leading-5 text-muted-foreground">{t('bulk_review.scope_help')}</span>
                </div>
              </div>}
              {view === "materials" && contentKind === "term" && filtered.length > 0 && <div className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] gap-3 border-b py-2 pr-4 text-xs text-muted-foreground ${batchVisible ? 'pl-10' : 'pl-4'}`}><span>{t("fields.source_text")}</span><span>{t("fields.target_text")}</span><span /></div>}
              <KnowledgeScrollList key={`${selectionScope}:${safePage}`} testId="knowledge-results-scroll">{filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map(entry => <div key={entry.id} className={`group flex min-w-0 items-start gap-2 rounded-md p-2 hover:bg-muted/60 ${batchVisible && selectedIds.includes(entry.id) ? 'bg-muted/60' : ''}`}>
                {batchVisible && <Checkbox className="mt-1 shrink-0" data-testid={`knowledge-select-entry-${entry.id}`} aria-label={t('bulk_review.select_entry', { title: entry.title })} disabled={!needsReview(entry, snapshot) || busy || blocked} checked={selectedIds.includes(entry.id)} onCheckedChange={checked => setBatchIds(checked ? [...selectedIds, entry.id] : selectedIds.filter(id => id !== entry.id))} />}
                <button data-entry-id={entry.id} onClick={() => setEntryEditor(entry)} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {entry.kind === "term" ? <div className="grid grid-cols-2 gap-3 text-sm"><span className="break-words font-medium">{entry.payload.source}</span><span className="break-words">{entry.payload.target}</span></div> : <p className="whitespace-pre-wrap break-words text-sm leading-6">{entrySummary(entry)}</p>}
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] leading-5 text-muted-foreground">
                    {query.collection === "all" && <span>{snapshot.data.collections.find(item => item.id === entry.collectionId)?.name}</span>}
                    {entryStatus(entry, snapshot) !== "ready" && <span>{t(`status.${entryStatus(entry, snapshot)}`)}</span>}
                    {(entry.scope.requiredSubjects.length > 0 || entry.scope.condition.mode !== "none") && <span>{t("workspace.limited")}</span>}
                    {entry.kind === "term" && entry.payload.sense && <span className="break-words">{entry.payload.sense}</span>}
                    {(entry.kind === "expression" || entry.kind === "memory") && <span>{t("guide.storage_only")}</span>}
                  </div>
                </button>
                <Button size="icon-sm" variant="ghost" data-testid={`knowledge-entry-details-${entry.id}`} aria-label={t("workspace.entry_details")} onClick={() => { setSelected(entry.id); setDetailError(null); }}><Ellipsis /></Button>
              </div>)}{!filtered.length && <Empty title={t(view === "review" ? "empty.review" : "workspace.empty_content")} description={t(query.search ? "empty.filtered" : "workspace.empty_content_help")} />}</KnowledgeScrollList>
              {editableCollection && contentKind === "term" && <InlineTermEditor key={editableCollection.id} collection={editableCollection} snapshot={snapshot} disabled={busy || blocked} onSave={save} onAdvanced={setEntryEditor} />}
              <Pagination page={safePage} total={filtered.length} onChange={setPage} />
            </>}
          </ToolPanel>
        </>}
        </div>
        </div>
        <AnimatePresence>
        {batchReview && <BatchReviewDialog key="batch-review" initial={batchReview.snapshot} ids={batchReview.ids} action={batchReview.action} api={api} blocked={blocked} onSnapshot={setSnapshot} onClose={() => setBatchReview(null)}
          onComplete={(next, count, remainingIds) => { setSnapshot(next); setBatchSelection({ scope: selectionScope, generation: next.generation, ids: remainingIds }); setNotice(t(batchReview.action === 'adopt' ? 'bulk_review.adopted' : 'bulk_review.rejected', { count })); setBatchReview(null); }} />}
        {snapshot && destination && <KnowledgeDialog key="destination" title={t("workspace.choose_collection")} description={t("workspace.choose_collection_help")} footer={null} onClose={() => setDestination(null)}>
          <div className="space-y-2">{activeCollections.map(collection => <Button key={collection.id} variant="outline" className="h-auto w-full justify-between gap-2 whitespace-normal py-3 text-left" onClick={() => beginForCollection(collection.id, destination)}><span className="break-words">{collection.name}</span><ArrowRight className="shrink-0" /></Button>)}</div>
          <Button variant="ghost" size="sm" onClick={() => { continuationKind.current = destination; continueWithEntry.current = true; setDestination(null); addCatalog("collections"); }}><Plus />{t("actions.new_collection")}</Button>
        </KnowledgeDialog>}
        {bulkCollection && <BulkTermPaste key={`paste:${bulkCollection.id}`} collection={bulkCollection} api={api} onSnapshot={setSnapshot} onClose={() => setBulkCollectionId(null)} />}
        {snapshot && entryEditor && (
          <EntryEditor
            key={`entry:${entryEditor.id}`}
            initial={entryEditor}
            snapshot={snapshot}
            onSave={save}
            blocked={blocked}
            onClose={() => setEntryEditor(null)}
          />
        )}
        {snapshot && catalog && (
          <CatalogEditor
            key={`catalog:${catalog.record.id}`}
            group={catalog.group}
            initial={catalog.record}
            snapshot={snapshot}
            onSave={save}
            blocked={blocked}
            onMaintenance={(action) =>
              planMaintenance({
                generation: snapshot.generation,
                action,
                targets: [{ group: catalog.group, id: catalog.record.id }],
                ...(action === "purge" && catalog.group === "collections" ? { includeCollectionContents: true } : {}),
              })
            }
            onClose={() => { continueWithEntry.current = false; setCatalog(null); }}
          />
        )}
        {preview && (
          <ImportDialog
            key="import"
            preview={preview}
            blocked={blocked}
            api={api}
            onClose={() => setPreview(null)}
            onImported={async (message) => {
              setNotice(message);
              await refresh();
              setLibraryView('review');
            }}
          />
        )}
        {snapshot && exportOpen && (
          <ExportDialog
            key="export"
            snapshot={snapshot}
            api={api}
            initialCollection={currentCollection?.id}
            onClose={() => setExportOpen(false)}
            onExported={setNotice}
          />
        )}
        {snapshot && currentEntry && !entryEditor && (
          <EntryDetails key={`details:${currentEntry.id}`} entry={currentEntry} snapshot={snapshot} busy={busy} blocked={blocked}
            error={detailError} diagnostics={detailDiagnostics} onClose={() => setSelected(null)}
            onEdit={() => setEntryEditor(currentEntry)}
            onCopy={() => {
              setSelected(null);
              setEntryEditor({ ...currentEntry, id: freshId(), revision: 1, state: "candidate", title: t("copy_name", { name: currentEntry.title }) });
            }}
            onReview={action => void review(action)}
            onMaintain={action => void planMaintenance({ generation: snapshot.generation, action, targets: [{ group: "entries", id: currentEntry.id }] })}
          />
        )}
        {snapshot && historyOpen && (
          <HistoryDialog
            key="history"
            snapshot={snapshot}
            pending={busy}
            error={error}
            diagnostics={diagnostics}
            onClose={() => setHistoryOpen(false)}
            onImport={() => void beginImport()}
            onPlan={(request) => void planMaintenance(request)}
          />
        )}
        {snapshot && maintenancePreview && (
          <MaintenanceDialog
            key="maintenance"
            restoreFocusTo={() => maintenanceFocusTarget.current}
            preview={maintenancePreview}
            snapshot={snapshot}
            api={api}
            onClose={() => setMaintenancePreview(null)}
            onCompleted={async (message) => {
              setNotice(message);
              if (currentCollection && maintenancePreview.items.some(item => item.group === "collections" && item.id === currentCollection.id && item.effect === maintenancePreview.action)) {
                if (maintenancePreview.action === "purge") setLibraryView("materials");
                else if (maintenancePreview.action === "archive" || maintenancePreview.action === "restore") selectCollection(currentCollection.id, maintenancePreview.action === "archive");
              }
              await refresh();
            }}
          />
        )}
        </AnimatePresence>
      </ToolDetailLayout>
      <KnowledgeTour open={tourOpen && tourReady} onOpenChange={setTourOpen} />
    </div>
  );
}
function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-2 px-3 py-10 text-center">
      <BookOpen className="mx-auto size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto max-w-sm text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
