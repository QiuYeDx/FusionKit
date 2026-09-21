import type {
  MaintenancePreview,
  MaintenanceRequest,
} from "@/translation-knowledge/maintenance-contract";
import { HistoryDialog, MaintenanceDialog } from "./Maintenance";
import { languagePairLabel, optionKey } from "./labels";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { ExportDialog, ImportDialog } from "./Exchange";
import { EntryDetails } from "./EntryDetails";
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
  useEffect(() => {
    setPage(0);
  }, [query, view, contentKind]);
  const filtered = useMemo(() => {
    if (!snapshot) return [];
    const archivedCollections = new Set(snapshot.data.collections.filter(item => item.archived).map(item => item.id));
    const base = filterEntries(snapshot, { ...query, kind: view === "materials" ? contentKind : "all" }, view === "review");
    return base.filter(entry => {
      const archived = entry.state === "archived" || archivedCollections.has(entry.collectionId);
      if (view === "archived") return archived;
      if (archived) return false;
      if (view === "stored") return entry.kind === "expression" || entry.kind === "memory";
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
  const reviewCount =
    snapshot?.data.entries.filter((entry) => needsReview(entry, snapshot) && !snapshot.data.collections.find(collection => collection.id === entry.collectionId)?.archived)
      .length ?? 0;
  const currentCollection = snapshot?.data.collections.find(
    (item) => item.id === query.collection,
  );
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
  const workspaceTitle = currentCollection?.name ?? (view === "materials" ? t("workspace.all") : t(view === "plans" ? "views.plans" : view === "review" ? "workspace.review" : view === "archived" ? "workspace.archived" : "workspace.stored"));
  const editableCollection = view === "materials" && currentCollection && !currentCollection.archived ? currentCollection : null;
  const bulkCollection = snapshot?.data.collections.find(item => item.id === bulkCollectionId);
  return (
    <div {...dropProps} data-testid="translation-knowledge">
      <ToolDetailLayout header={header} aside={aside} className="translation-knowledge md:[&>div.grid]:grid-cols-[240px_minmax(0,1fr)] lg:[&>div.grid]:grid-cols-[280px_minmax(0,1fr)]" asideClassName="lg:static lg:w-full">
        {dropError && <p role="alert" className="rounded-md border border-destructive/25 p-3 text-sm text-destructive">{t("drop.invalid")}</p>}
        {blocked && <div role="status" className="space-y-2 rounded-md border p-3"><p className="text-sm">{t("maintenance.cleanup_pending")}</p><Button data-testid="knowledge-cleanup-retry" size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>{t("maintenance.retry_cleanup")}</Button></div>}
        <ErrorNotice error={error} diagnostics={diagnostics} />
        {notice && <div role="status" className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 p-3 text-xs"><p className="break-words leading-5">{notice}</p><Button size="icon-xs" variant="ghost" aria-label={t("actions.dismiss")} onClick={() => setNotice("")}><X /></Button></div>}
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
          {view === "stored" && <p className="text-xs leading-5 text-muted-foreground">{t("guide.storage_only_help")}</p>}
          <ToolPanel id="knowledge-content" title={t(view === "materials" ? `workspace.${contentKind === "term" ? "terms" : contentKind === "context" ? "contexts" : "rules"}` : view === "plans" ? "views.plans" : "views.materials")} badge={<Badge variant="secondary">{view === "plans" ? plans.length : filtered.length}</Badge>} actions={<>
            {view === "materials" && contentKind === "term" && <Button data-testid="knowledge-paste-open" variant="outline" size="sm" disabled={busy || blocked} onClick={() => startEntry("bulk")}><ClipboardPaste />{t("paste.title")}</Button>}
            {(view === "materials" || view === "plans") && <Button data-testid="knowledge-new-entry" size="sm" disabled={busy || blocked} onClick={() => view === "plans" ? addCatalog(planGroup) : startEntry()}><Plus />{t(view === "plans" ? "actions.new_plan_item" : contentKind === "term" ? "workspace.add_term" : contentKind === "context" ? "workspace.add_context" : "workspace.add_rule")}</Button>}
          </>} bodyClassName="min-w-0">
            <div className="space-y-3 border-b p-3"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input aria-label={t("filters.search")} placeholder={t("filters.search")} value={query.search} onChange={event => { change("search", event.target.value); setPlanPage(0); }} className="h-8 pl-8 text-sm" /></div>
              {view === "plans" && <Choice label={t("plans.category")} value={planGroup} onChange={value => { setPlanGroup(value as typeof planGroup); setPlanPage(0); }} options={["recipes", "styles", "preferenceTemplates"].map(value => ({ value, label: t(optionKey(`group.${value}`)) }))} />}
            </div>
            {view === "plans" ? <>
              <div className="space-y-1 p-2">{plans.slice(safePlanPage * PAGE_SIZE, (safePlanPage + 1) * PAGE_SIZE).map(item => <div key={item.id} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted/50"><button data-catalog-id={item.id} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setCatalog({ group: planGroup, record: item })}><p className="break-words text-sm font-medium">{item.name}{item.archived ? ` · ${t("status.archived")}` : ""}</p><p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{"description" in item ? item.description : item.instructions}</p></button><Button size="icon-sm" variant="ghost" aria-label={t("actions.copy")} onClick={() => setCatalog({ group: planGroup, record: { ...item, id: freshId(), revision: 1, name: t("copy_name", { name: item.name }), archived: false } })}><Copy /></Button></div>)}{!plans.length && <Empty title={t("empty.plans")} description={t("empty.plans_help")} />}</div>
              <Pagination page={safePlanPage} total={plans.length} onChange={setPlanPage} />
            </> : <>
              {view === "materials" && contentKind === "term" && filtered.length > 0 && <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] gap-3 border-b px-4 py-2 text-xs text-muted-foreground"><span>{t("fields.source_text")}</span><span>{t("fields.target_text")}</span><span /></div>}
              <div className="space-y-1 p-2">{filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map(entry => <div key={entry.id} className="group flex min-w-0 items-start gap-2 rounded-md p-2 hover:bg-muted/60">
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
              </div>)}{!filtered.length && <Empty title={t(view === "review" ? "empty.review" : "workspace.empty_content")} description={t(query.search ? "empty.filtered" : "workspace.empty_content_help")} />}</div>
              {editableCollection && contentKind === "term" && <InlineTermEditor key={editableCollection.id} collection={editableCollection} snapshot={snapshot} disabled={busy || blocked} onSave={save} onAdvanced={setEntryEditor} />}
              <Pagination page={safePage} total={filtered.length} onChange={setPage} />
            </>}
          </ToolPanel>
        </>}
        {snapshot && destination && <KnowledgeDialog title={t("workspace.choose_collection")} description={t("workspace.choose_collection_help")} footer={null} onClose={() => setDestination(null)}>
          <div className="space-y-2">{activeCollections.map(collection => <Button key={collection.id} variant="outline" className="h-auto w-full justify-between gap-2 whitespace-normal py-3 text-left" onClick={() => beginForCollection(collection.id, destination)}><span className="break-words">{collection.name}</span><ArrowRight className="shrink-0" /></Button>)}</div>
          <Button variant="ghost" size="sm" onClick={() => { continuationKind.current = destination; continueWithEntry.current = true; setDestination(null); addCatalog("collections"); }}><Plus />{t("actions.new_collection")}</Button>
        </KnowledgeDialog>}
        {bulkCollection && <BulkTermPaste collection={bulkCollection} api={api} onSnapshot={setSnapshot} onClose={() => setBulkCollectionId(null)} />}
        {snapshot && entryEditor && (
          <EntryEditor
            key={entryEditor.id}
            initial={entryEditor}
            snapshot={snapshot}
            onSave={save}
            blocked={blocked}
            onClose={() => setEntryEditor(null)}
          />
        )}
        {snapshot && catalog && (
          <CatalogEditor
            key={catalog.record.id}
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
            preview={preview}
            blocked={blocked}
            api={api}
            onClose={() => setPreview(null)}
            onImported={async (message) => {
              setNotice(message);
              await refresh();
            }}
          />
        )}
        {snapshot && exportOpen && (
          <ExportDialog
            snapshot={snapshot}
            api={api}
            initialCollection={currentCollection?.id}
            onClose={() => setExportOpen(false)}
            onExported={setNotice}
          />
        )}
        {snapshot && currentEntry && !entryEditor && (
          <EntryDetails entry={currentEntry} snapshot={snapshot} busy={busy} blocked={blocked}
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
