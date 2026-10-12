import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { BookOpen, CircleHelp, ClipboardPaste, Download, Ellipsis, FolderPlus, LoaderCircle, Search, Subtitles, Upload, X } from "lucide-react";
import { useAgentPageContext } from "@/agent/page-context";
import { ClipPathTabs } from "@/components/qiuye-ui/clip-path-tabs";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { ToolDetailLayout } from "@/pages/Tools/_shared/ui/ToolDetailLayout";
import { useToolFileDropTarget } from "@/pages/Tools/_shared/ui/ToolFileDropScope";
import { ToolPanel } from "@/pages/Tools/_shared/ui/ToolPanel";
import type { Collection, Entry, NoteEntry, TermEntry } from "@/translation-knowledge/schemas";
import type { ImportPreview, KnowledgeResult } from "@/translation-knowledge/ipc-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { focusedCollection, knowledgePageContext, type KnowledgePageState } from "./agent-context";
import { BulkTermPaste } from "./BulkTermPaste";
import { CollectionDeleteDialog } from "./CollectionDeleteDialog";
import { CollectionDialog } from "./CollectionDialog";
import { CollectionHeader } from "./CollectionHeader";
import { ErrorNotice, Pagination } from "./Controls";
import { EntryDrawer } from "./EntryDrawer";
import { ExportDialog, ImportDialog } from "./Exchange";
import { GlobalSearch } from "./GlobalSearch";
import { KnowledgeSidebar } from "./KnowledgeSidebar";
import { KnowledgeTour, useKnowledgeTour } from "./KnowledgeTour";
import { acceptsKnowledgeDrop, defaultCollectionId, lastLanguagePair, moveTargets, notesOf, orderedCollections, PAGE_SIZE, presetsUsing, rememberLanguagePair, termsOf, type ContentView } from "./model";
import { NoteSection } from "./NoteList";
import { SelectionBar } from "./SelectionBar";
import { AddTermRow, TermHeader, TermRow } from "./TermTable";
import { useLibrary, type LibraryError } from "./use-library";
import "./knowledge-page.css";

const HIGHLIGHT_MS = 2400;
type ImportFailure = { error: LibraryError; diagnostics: Diagnostic[] } | null;

export default function TranslationKnowledge() {
  const { t, i18n } = useTranslation("knowledge");
  const library = useLibrary();
  const { snapshot, save, remove, api } = library;
  const [collectionId, setCollectionId] = useState<string | undefined>();
  const [view, setView] = useState<ContentView>("terms");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<{ scope: string; ids: string[] }>({ scope: "", ids: [] });
  const anchor = useRef<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [collectionDialog, setCollectionDialog] = useState<{ open: boolean; initial: Collection | null }>({ open: false, initial: null });
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const [drawer, setDrawer] = useState<{ id: string; trigger: HTMLElement | null } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importFailure, setImportFailure] = useState<ImportFailure>(null);
  const [exportIds, setExportIds] = useState<string[] | null>(null);
  const [dropRejected, setDropRejected] = useState(false);

  const collections = snapshot ? orderedCollections(snapshot) : [];
  const collection = snapshot?.data.collections.find(item => item.id === collectionId);
  // First the requested or first live collection; a deleted one falls back the same way.
  useEffect(() => {
    if (snapshot && !collection) setCollectionId(defaultCollectionId(snapshot));
  }, [snapshot, collection]);
  // Opened from a saved card: show that collection once, then forget the request.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const focus = (location.state as { knowledgeFocus?: unknown } | null)?.knowledgeFocus;
    if (!snapshot || !focus) return;
    const id = focusedCollection(snapshot, focus);
    if (id) open(id);
    navigate(location.pathname, { replace: true, state: null });
  }, [snapshot, location.state]);
  useEffect(() => { if (!highlightId) return; const timer = setTimeout(() => setHighlightId(undefined), HIGHLIGHT_MS); return () => clearTimeout(timer); }, [highlightId]);

  const terms = useMemo(() => snapshot && collection ? termsOf(snapshot, collection.id, query) : [], [snapshot, collection, query]);
  const rules = useMemo(() => snapshot && collection ? notesOf(snapshot, collection.id, "rule", query) : [], [snapshot, collection, query]);
  const contexts = useMemo(() => snapshot && collection ? notesOf(snapshot, collection.id, "context", query) : [], [snapshot, collection, query]);
  const allCounts = useMemo(() => snapshot && collection ? { terms: termsOf(snapshot, collection.id).length, notes: snapshot.data.entries.filter(entry => entry.collectionId === collection.id && entry.kind !== "term").length } : { terms: 0, notes: 0 }, [snapshot, collection]);
  const pages = Math.max(1, Math.ceil(terms.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const pageTerms = terms.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const visible: Entry[] = view === "terms" ? pageTerms : [...rules, ...contexts];
  const scope = `${collectionId}:${view}`;
  const selectedIds = selection.scope === scope ? selection.ids.filter(id => visible.some(entry => entry.id === id)) : [];
  const selectedSet = new Set(selectedIds);
  const setSelected = (ids: string[]) => setSelection({ scope, ids });
  const select = (id: string, event: MouseEvent, checked: boolean) => {
    const order = visible.map(entry => entry.id);
    if (event.shiftKey && anchor.current && order.includes(anchor.current)) {
      const [from, to] = [order.indexOf(anchor.current), order.indexOf(id)].sort((a, b) => a - b);
      const range = order.slice(from, to + 1);
      setSelected(checked ? [...new Set([...selectedIds, ...range])] : selectedIds.filter(item => !range.includes(item)));
    } else setSelected(checked ? [...selectedIds, id] : selectedIds.filter(item => item !== id));
    anchor.current = id;
  };
  const open = (id: string) => { setCollectionId(id); setQuery(""); setPage(0); setSelection({ scope: "", ids: [] }); };
  const openEntry = (targetCollection: string, entryId: string) => {
    const entry = snapshot?.data.entries.find(item => item.id === entryId);
    if (!snapshot || !entry) return;
    open(targetCollection);
    setView(entry.kind === "term" ? "terms" : "notes");
    if (entry.kind === "term") setPage(Math.floor(termsOf(snapshot, targetCollection).findIndex(item => item.id === entryId) / PAGE_SIZE));
    setHighlightId(entryId);
  };

  const agentState = useRef<KnowledgePageState>({ snapshot: null, collectionId, view, visible: [], selectedIds: [] });
  agentState.current = { snapshot, collectionId, view, visible, selectedIds };
  useAgentPageContext(() => knowledgePageContext(() => agentState.current));

  const saveEntry = (record: Entry) => save(record, "entries");
  const toggleSelected = async (enabled: boolean) => {
    const changed = visible.filter(entry => selectedSet.has(entry.id) && entry.enabled !== enabled);
    if (!changed.length) { setSelected([]); return; }
    const failure = await save(changed.map(entry => ({ group: "entries" as const, record: { ...entry, enabled } })));
    if (failure) toast.error(t(failure === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${failure}`));
    else { toast.success(t(enabled ? "selection.enabled_done" : "selection.disabled_done", { count: changed.length })); setSelected([]); }
  };
  const moveSelected = async (target: string) => {
    const moving = visible.filter(entry => selectedSet.has(entry.id));
    const name = snapshot?.data.collections.find(item => item.id === target)?.name ?? "";
    const failure = await save(moving.map(entry => ({ group: "entries" as const, record: { ...entry, collectionId: target } })));
    if (failure) toast.error(t(failure === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${failure}`));
    else { toast.success(t("selection.moved", { count: moving.length, name })); setSelected([]); }
  };
  const deleteEntries = async (ids: string[]) => {
    const failure = await remove(ids.map(id => ({ group: "entries" as const, id })), t("undo.deleted", { count: ids.length }));
    if (failure) toast.error(t(failure === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${failure}`));
    else setSelected(selectedIds.filter(id => !ids.includes(id)));
  };
  const saveCollection = async (record: Collection) => {
    const creating = !snapshot?.data.collections.some(item => item.id === record.id);
    const failure = await save(record, "collections");
    if (!failure) {
      rememberLanguagePair(record.languagePair);
      if (creating) { open(record.id); setView("terms"); toast.success(t("collection.created", { name: record.name })); }
    }
    return failure;
  };
  const archive = async (target: Collection, archived: boolean) => {
    const failure = await save({ ...target, archived }, "collections");
    if (failure) toast.error(t(`errors.${failure}`)); else toast.success(t(archived ? "collection.archived_done" : "collection.restored_done", { name: target.name }));
  };
  const deleteCollection = async () => deleting ? remove([{ group: "collections", id: deleting.id }], t("undo.collection_deleted", { name: deleting.name })) : null;

  const showImport = (result: KnowledgeResult<ImportPreview | null>) => {
    if (result.ok) { if (result.value) { setImportFailure(null); setImportPreview(result.value); } return; }
    setImportFailure({ error: result.error, diagnostics: result.diagnostics ?? [] });
  };
  const beginImport = async () => {
    setBusy(true); setDropRejected(false);
    try { showImport(await api.selectImport()); } catch { setImportFailure({ error: "unexpected", diagnostics: [] }); }
    finally { setBusy(false); }
  };
  const drop = async (event: DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer.files);
    setDropRejected(!acceptsKnowledgeDrop(files));
    if (!acceptsKnowledgeDrop(files)) return;
    setBusy(true);
    try { showImport(await api.importDroppedFile(files[0])); } catch { setImportFailure({ error: "unexpected", diagnostics: [] }); }
    finally { setBusy(false); }
  };
  const { dragging, dropProps } = useToolFileDropTarget({ onDrop: drop, disabled: busy || !snapshot, label: t("sidebar.import") });
  const unsupported = importFailure?.diagnostics.some(item => item.code === "UNSUPPORTED_SCHEMA_VERSION");

  const drawerEntry = drawer ? snapshot?.data.entries.find((entry): entry is TermEntry => entry.id === drawer.id && entry.kind === "term") ?? null : null;
  const dialogsOpen = collectionDialog.open || !!deleting || !!drawer || pasteOpen || !!importPreview || !!exportIds;
  const tourReady = !!snapshot && !library.loading && !busy && !dialogsOpen && !dragging && collections.length > 0;
  const { tourOpen, setTourOpen } = useKnowledgeTour(tourReady);
  const newCollectionDialog = () => setCollectionDialog({ open: true, initial: null });
  const readOnly = !!collection?.archived;

  const header = <ToolPageHeader meta={TOOL_META.translationKnowledge} title={t("title")} description={t("description")} right={
    <Button data-testid="knowledge-tour-trigger" variant="ghost" size="icon-sm" aria-label={t("tour.trigger")} title={t("tour.trigger")} disabled={!tourReady} onClick={() => setTourOpen(true)}><CircleHelp /></Button>
  } />;
  const aside = <KnowledgeSidebar snapshot={snapshot} selectedId={collectionId} busy={busy} onSelect={open} onSelectEntry={openEntry}
    onCreate={newCollectionDialog} onImport={() => void beginImport()} onExport={() => setExportIds(collectionId ? [collectionId] : [])} />;
  const narrowBar = snapshot && collections.length > 0 && <div data-testid="knowledge-narrow-bar" className="space-y-2 md:hidden">
    <div className="flex items-center gap-2">
      <Select value={collectionId} onValueChange={open}>
        <SelectTrigger size="sm" aria-label={t("sidebar.collections")} data-testid="knowledge-collection-select" className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
        <SelectContent>{collections.map(item => <SelectItem key={item.id} value={item.id}>{item.name}{item.archived ? ` · ${t("collection.archived")}` : ""}</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="outline" size="icon-sm" aria-label={t("collection.new")} onClick={newCollectionDialog}><FolderPlus /></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" size="icon-sm" aria-label={t("sidebar.more")}><Ellipsis /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void beginImport()}><Download />{t("sidebar.import")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setExportIds(collectionId ? [collectionId] : [])}><Upload />{t("sidebar.export")}</DropdownMenuItem>
          <DropdownMenuItem asChild><Link to="/tools/subtitle/studio"><Subtitles />{t("sidebar.studio")}</Link></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <GlobalSearch snapshot={snapshot} onSelect={openEntry} testId="knowledge-global-search-narrow" />
  </div>;

  return <div {...dropProps} data-testid="translation-knowledge">
    <ToolDetailLayout header={header} aside={aside} className="translation-knowledge md:[&>div.grid]:grid-cols-[240px_minmax(0,1fr)] lg:[&>div.grid]:grid-cols-[280px_minmax(0,1fr)]" asideClassName="hidden md:block md:sticky md:top-10 lg:w-full">
      <DialogTransition transitionKey={dropRejected ? "drop" : "none"} stageClassName="pb-0">{dropRejected && <p role="alert" className="rounded-md border border-destructive/25 p-3 text-sm text-destructive">{t("import.drop_invalid")}</p>}</DialogTransition>
      <DialogTransition transitionKey={importFailure ? `import-${importFailure.error}` : "none"}>{importFailure && <div role="alert" data-testid="knowledge-import-error" className="flex items-start justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
        <p className="min-w-0 [overflow-wrap:anywhere]">{unsupported ? t("import.unsupported_version") : t("import.failed")}</p>
        <Button variant="ghost" size="icon-xs" aria-label={t("actions.dismiss")} onClick={() => setImportFailure(null)}><X /></Button>
      </div>}</DialogTransition>
      {!unsupported && importFailure && <ErrorNotice error={importFailure.error} diagnostics={importFailure.diagnostics} />}
      <ErrorNotice error={library.error} diagnostics={library.diagnostics} />
      {narrowBar}
      {library.loading && !snapshot ? <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t("loading")}</div>
        : snapshot && !collections.length ? <EmptyLibrary onCreate={newCollectionDialog} onImport={() => void beginImport()} busy={busy} />
        : snapshot && collection && <>
          <CollectionHeader collection={collection} busy={busy} onEdit={() => setCollectionDialog({ open: true, initial: collection })}
            onExport={() => setExportIds([collection.id])} onArchive={archived => void archive(collection, archived)} onDelete={() => setDeleting(collection)} />
          {readOnly && <p data-testid="knowledge-archived-help" className="text-xs leading-5 text-muted-foreground">{t("collection.archived_help")}</p>}
          <ToolPanel id="knowledge-content" title={<ClipPathTabs data-testid="knowledge-views" size="sm" shape="rounded" smoothCorners value={view} ariaLabel={t("views.label")}
            onValueChange={value => { setView(value as ContentView); setPage(0); }}
            items={[{ value: "terms", label: `${t("views.terms")} ${allCounts.terms}` }, { value: "notes", label: `${t("views.notes")} ${allCounts.notes}` }]} />}
            actions={<>
              <div className="relative w-40 sm:w-52">
                <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input data-testid="knowledge-collection-search" aria-label={t("search.collection")} placeholder={t("search.collection")} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} className="h-8 pl-8 text-sm" />
              </div>
              {view === "terms" && !readOnly && <Button data-testid="knowledge-paste-open" variant="outline" size="sm" onClick={() => setPasteOpen(true)}><ClipboardPaste />{t("paste.open")}</Button>}
            </>} bodyClassName="min-w-0">
            <DialogTransition transitionKey={selectedIds.length ? "selection" : "none"}>{selectedIds.length > 0 && <SelectionBar count={selectedIds.length} busy={busy}
              targets={moveTargets(snapshot, collection)} onEnable={value => void toggleSelected(value)} onMove={id => void moveSelected(id)}
              onDelete={() => void deleteEntries(selectedIds)} onClear={() => setSelected([])} />}</DialogTransition>
            {view === "terms" ? <div role="table" aria-label={t("views.terms")} data-testid="knowledge-term-table" className="@container/terms">
              <TermHeader disabled={!pageTerms.length} onSelectPage={checked => setSelected(checked ? pageTerms.map(entry => entry.id) : [])}
                pageState={!selectedIds.length ? false : selectedIds.length === pageTerms.length ? true : "indeterminate"} />
              {pageTerms.length > 0 ? <div role="rowgroup" className="space-y-0.5 p-2">{pageTerms.map(entry => <TermRow key={entry.id} entry={entry} selected={selectedSet.has(entry.id)}
                highlighted={entry.id === highlightId} disabled={busy} onSelect={(event, checked) => select(entry.id, event, checked)} onSave={saveEntry}
                onMore={trigger => setDrawer({ id: entry.id, trigger })} />)}</div>
                : <p className="px-4 py-6 text-center text-xs leading-5 text-muted-foreground">{t(query ? "terms.no_match" : readOnly ? "terms.empty_archived" : "terms.empty")}</p>}
              {!readOnly && !query && <AddTermRow collection={collection} snapshot={snapshot} disabled={busy} onSave={saveEntry} />}
              {pages > 1 && <Pagination page={safePage} total={terms.length} onChange={setPage} />}
            </div> : <div data-testid="knowledge-notes" className="divide-y">
              {([["rule", rules], ["context", contexts]] as const).map(([kind, notes]) => <NoteSection key={kind} kind={kind} collectionId={collection.id} notes={notes as NoteEntry[]}
                selected={selectedSet} highlightId={highlightId} disabled={busy} readOnly={readOnly} onSelect={select} onSave={saveEntry}
                onDelete={entry => void deleteEntries([entry.id])} />)}
            </div>}
          </ToolPanel>
        </>}
    </ToolDetailLayout>
    <CollectionDialog open={collectionDialog.open} initial={collectionDialog.initial} entryCount={collectionDialog.initial ? snapshot?.data.entries.filter(entry => entry.collectionId === collectionDialog.initial!.id).length ?? 0 : 0}
      defaultPair={lastLanguagePair(i18n.resolvedLanguage === "zh-Hant" ? "zh-Hant" : "zh-Hans")} onSave={saveCollection} onClose={() => setCollectionDialog({ open: false, initial: null })} />
    <CollectionDeleteDialog collection={deleting} entryCount={deleting ? snapshot?.data.entries.filter(entry => entry.collectionId === deleting.id).length ?? 0 : 0}
      presets={deleting && snapshot ? presetsUsing(snapshot, deleting.id) : []} onConfirm={deleteCollection} onClose={() => setDeleting(null)} />
    <EntryDrawer entry={drawerEntry} trigger={drawer?.trigger ?? null} onSave={saveEntry} onClose={() => setDrawer(null)}
      onDelete={entry => { setDrawer(null); void deleteEntries([entry.id]); }} />
    <BulkTermPaste collection={pasteOpen ? collection ?? null : null} snapshot={snapshot} onSave={async items => {
      const failure = await save(items);
      if (!failure) toast.success(t("paste.saved", { count: items.length }));
      return failure;
    }} onClose={() => setPasteOpen(false)} />
    {importPreview && <ImportDialog key={importPreview.planId} preview={importPreview} api={api} onClose={() => setImportPreview(null)} onImported={async receipt => {
      setImportPreview(null);
      await library.refresh();
      if (receipt.collectionIds[0]) open(receipt.collectionIds[0]);
      toast.success(t("import.done", { added: receipt.added, updated: receipt.updated, skipped: receipt.skipped }));
    }} />}
    {snapshot && exportIds && <ExportDialog snapshot={snapshot} api={api} initialCollectionIds={exportIds} onClose={() => setExportIds(null)}
      onExported={receipt => { setExportIds(null); toast.success(t("export.done", { fileName: receipt.fileName, count: receipt.entries })); }} />}
    <KnowledgeTour open={tourOpen && tourReady} onOpenChange={setTourOpen} />
  </div>;
}

function EmptyLibrary({ onCreate, onImport, busy }: { onCreate: () => void; onImport: () => void; busy: boolean }) {
  const { t } = useTranslation("knowledge");
  return <div data-testid="knowledge-empty-library" className="space-y-4 rounded-[16px] border border-dashed px-6 py-12 text-center">
    <BookOpen aria-hidden className="mx-auto size-7 text-muted-foreground/70" />
    <div className="space-y-1.5">
      <p className="text-base font-medium">{t("empty.title")}</p>
      <p className="mx-auto max-w-md text-xs leading-5 text-muted-foreground">{t("empty.help")}</p>
    </div>
    <div className="flex flex-wrap justify-center gap-2">
      <Button data-testid="knowledge-empty-create" size="sm" onClick={onCreate}><FolderPlus />{t("empty.create")}</Button>
      <Button data-testid="knowledge-empty-import" size="sm" variant="outline" disabled={busy} onClick={onImport}><Download />{t("empty.import")}</Button>
    </div>
  </div>;
}

