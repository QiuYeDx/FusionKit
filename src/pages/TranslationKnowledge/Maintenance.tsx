import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, History, LoaderCircle, RotateCcw, Upload, X } from "lucide-react";
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from "@/components/qiuye-ui/scrollable-dialog";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type {
  LibrarySnapshot,
  KnowledgeErrorCode,
  TranslationKnowledgeApi,
} from "@/translation-knowledge/ipc-contract";
import type {
  MaintenancePreview,
  MaintenanceRequest,
} from "@/translation-knowledge/maintenance-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { Check, ErrorNotice, KnowledgeDialog, Pagination } from "./Controls";
import { PAGE_SIZE, isSourceUnreferenced, maintenanceCommitFor } from "./model";
import { diagnosticKey } from './labels';
import { knowledgeReferenceKey } from '@/translation-knowledge/task-reference-contract';

export function MaintenanceDialog({
  preview,
  snapshot,
  api,
  onClose,
  onCompleted,
}: {
  preview: MaintenancePreview;
  snapshot: LibrarySnapshot;
  api: TranslationKnowledgeApi;
  onClose: () => void;
  onCompleted: (message: string) => Promise<void>;
}) {
  const { t } = useTranslation("knowledge");
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [page, setPage] = useState(0);
  const [taskPage, setTaskPage] = useState(0);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(
    null,
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const operation = useRef(false);
  const stale = snapshot.generation !== preview.generation;
  const cleaning = snapshot.maintenance?.cleanupPending === true;
  const collectionIds = new Set(preview.items.filter(item => item.group === "collections" && item.effect !== "retain").map(item => item.id));
  const collectionDelete = preview.action === "purge" && collectionIds.size > 0;
  const collectionNames = snapshot.data.collections.filter(item => collectionIds.has(item.id)).map(item => item.name).join(" · ");
  const collectionEntries = snapshot.data.entries.filter(item => collectionIds.has(item.collectionId)).length;
  const submit = async () => {
    if (operation.current || pending || stale || cleaning || !preview.canCommit || preview.history.scope === "all" && !confirmed) return;
    operation.current = true;
    setPending(true);
    setError(null);
    setDiagnostics([]);
    try {
      const result = await api.commitMaintenance(maintenanceCommitFor(preview, confirmed));
      if (!result.ok) {
        setError(result.error);
        setDiagnostics(result.diagnostics ?? []);
        return;
      }
      await onCompleted(
        t(
          result.value.cleanupPending
            ? "maintenance.cleanup_pending"
            : "maintenance.success",
          { count: result.value.changed },
        ),
      );
      onClose();
    } catch {
      setError("unexpected");
    } finally {
      operation.current = false;
      setPending(false);
    }
  };
  const impacts = <>
      <div className="space-y-1">
        {preview.items
          .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
          .map((item, index) => (
            <div
              key={`${item.group}-${item.id}-${index}`}
              className="rounded-md border p-3"
            >
              <p className="break-words text-sm font-medium">{item.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(`group.${item.group}`)} ·{" "}
                {t(`maintenance.effect.${item.effect}`)} ·{" "}
                {t(`maintenance.reason.${item.reason}`)}
              </p>
            </div>
          ))}
      </div>
      {(!collectionDelete || preview.items.length > PAGE_SIZE) && <Pagination page={page} total={preview.items.length} onChange={setPage} />}
  </>;
  return (
    <KnowledgeDialog
      title={t(collectionDelete ? "collection_actions.delete_title" : `maintenance.action.${preview.action}`)}
      description={t("maintenance.preview_help")}
      wide
      pending={pending}
      onClose={onClose}
      footer={
        <Button
          data-testid="knowledge-maintenance-confirm"
          size="sm"
          variant={preview.action === "purge" ? "destructive" : "default"}
          disabled={
            pending ||
            stale ||
            cleaning ||
            !preview.canCommit ||
            (preview.history.scope === "all" && !confirmed)
          }
          onClick={() => void submit()}
        >
          {t(
            pending
              ? "maintenance.working"
              : collectionDelete ? "collection_actions.confirm_delete" : `maintenance.confirm.${preview.action}`,
          )}
        </Button>
      }
    >
      {collectionDelete && <section data-testid="collection-maintenance-summary" className="space-y-2">
        <p className="break-words text-sm font-medium">{t("collection_actions.delete_summary", { names: collectionNames, entries: collectionEntries })}</p>
        <p className="text-xs leading-5 text-muted-foreground">{t("collection_actions.delete_help")}</p>
        {preview.blockers.some(item => item.code === "PURGE_REFERENCED") && <p role="alert" className="text-xs leading-5 text-destructive">{t("collection_actions.references_help")}</p>}
      </section>}
      {preview.action !== "purge" && <p className="text-xs text-muted-foreground">
        {t(
          preview.action === "restore"
            ? collectionIds.size ? "collection_actions.archived_help" : "maintenance.restore_help"
            : preview.action === "undo_import"
              ? "maintenance.undo_help"
              : collectionIds.size ? "collection_actions.archive_help" : "maintenance.archive_help",
        )}
      </p>}
      {preview.action === 'purge' && preview.blockers.some(item => item.code.startsWith('PURGE_TASK_')) && <div role="alert" data-testid="knowledge-maintenance-reference-blocker" className="space-y-2 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
        {preview.blockers.filter(item => item.code.startsWith('PURGE_TASK_')).map(item => <p key={item.code}>{t(diagnosticKey(`diagnostic.${item.code}`))}</p>)}
      </div>}
      {collectionDelete ? <details data-testid="knowledge-collection-delete-details" open={!preview.canCommit} className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm">{t("collection_actions.details", { count: preview.items.length })}</summary>
        <div className="mt-3">{impacts}</div>
      </details> : impacts}
      {preview.history.scope === "all" && (
        <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm font-medium">
            {t("maintenance.history_warning", {
              snapshots: preview.history.snapshots,
              count: preview.history.importsLosingUndo,
            })}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("maintenance.purge_help")}
          </p>
          {preview.history.importsLosingUndo > 0 && (
            <details>
              <summary className="cursor-pointer text-xs">
                {t("maintenance.imports_losing_undo")}
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {snapshot.imports
                  .filter((item) =>
                    snapshot.maintenance?.undoableImportIds.includes(item.id),
                  )
                  .map((item) => (
                    <li key={item.id} className="break-words">
                      {item.packageName} ·{" "}
                      {new Date(item.createdAt).toLocaleString()}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          <Check
            label={t("maintenance.confirm_history")}
            checked={confirmed}
            disabled={pending || !preview.canCommit}
            onChange={setConfirmed}
          />
        </div>
      )}
      {preview.taskTracking === "connected" && preview.tasks ? <section data-testid="knowledge-maintenance-tasks" className="min-w-0 space-y-3 border-t pt-3">
        <h3 className="text-sm font-medium">{t("maintenance.related_records", { count: preview.tasks.total })}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{t("maintenance.task_references_help")}</p>
        {preview.tasks.unknownDocuments > 0 && <p role="status" className="text-xs leading-5 text-destructive">{t("maintenance.task_references_unknown", { count: preview.tasks.unknownDocuments })}</p>}
        {preview.tasks.items.slice(taskPage * PAGE_SIZE, (taskPage + 1) * PAGE_SIZE).map(task => <details key={knowledgeReferenceKey(task)} className="min-w-0 rounded-md border p-3">
          <summary className="cursor-pointer text-xs [overflow-wrap:anywhere]">{task.displayName || t('maintenance.automatic_queue')} · {t(task.kind === 'automatic_preparation' ? 'maintenance.automatic_preparation' : task.status === "active" ? "maintenance.record_active" : "maintenance.record_retained")}</summary>
          <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{task.kind === 'automatic_preparation' ? t('maintenance.automatic_preparation_help') : t("maintenance.record_id", { id: task.recordId })}</p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {task.resources.map(resource => {
              const record = snapshot.data[resource.group].find(item => item.id === resource.id);
              const title = record ? "title" in record ? record.title : record.name : resource.id;
              return <li key={`${resource.group}:${resource.id}:${resource.revision}`} className="[overflow-wrap:anywhere]">{t("maintenance.record_resource", { group: t(`group.${resource.group}`), title, revision: resource.revision })}</li>;
            })}
          </ul>
        </details>)}
        {!preview.tasks.total && !preview.tasks.unknownDocuments && <p className="text-xs text-muted-foreground">{t("maintenance.no_related_records")}</p>}
        <Pagination page={taskPage} total={preview.tasks.items.length} onChange={setTaskPage} />
        {preview.tasks.total > preview.tasks.items.length && <p className="text-xs text-muted-foreground">{t("maintenance.records_limited", { count: preview.tasks.items.length, total: preview.tasks.total })}</p>}
      </section> : <p className="text-xs text-muted-foreground">{t("maintenance.tasks_not_connected")}</p>}
      <ErrorNotice
        error={
          stale
            ? "plan_expired"
            : preview.blockers.length
              ? "invalid_input"
              : error
        }
        diagnostics={preview.blockers.length ? preview.blockers : diagnostics}
      />
    </KnowledgeDialog>
  );
}
export function HistoryDialog({
  snapshot, pending, onClose, onImport, onPlan, error, diagnostics,
}: {
  snapshot: LibrarySnapshot;
  pending: boolean;
  error: KnowledgeErrorCode | "unexpected" | null;
  diagnostics: Diagnostic[];
  onClose: () => void;
  onImport: () => void;
  onPlan: (request: MaintenanceRequest) => void;
}) {
  const { t, i18n } = useTranslation("knowledge");
  const closeButton = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState(0);
  const [sourcePage, setSourcePage] = useState(0);
  const imports = [...snapshot.imports].reverse();
  const sources = snapshot.data.sources.filter(source => isSourceUnreferenced(source.id, snapshot.data));
  const pages = Math.max(1, Math.ceil(imports.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const currentSourcePage = Math.min(sourcePage, Math.max(0, Math.ceil(sources.length / PAGE_SIZE) - 1));
  const cleaning = snapshot.maintenance?.cleanupPending === true;
  return (
    <ScrollableDialog
      open
      onOpenChange={open => { if (!open && !pending) onClose(); }}
      maxWidth="sm:max-w-3xl"
      contentClassName="max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] [&>button]:hidden"
      onOpenAutoFocus={event => { event.preventDefault(); closeButton.current?.focus({ preventScroll: true }); }}
    >
      <ScrollableDialogHeader className="relative border-b-0 p-4 pr-16">
        <div className="flex items-start gap-3 text-left">
          <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"><History className="size-5" /></span>
          <div className="min-w-0 space-y-1 pt-0.5">
            <DialogTitle className="text-lg leading-6">{t("maintenance.history_title")}</DialogTitle>
            <DialogDescription className="text-xs leading-5">{t("maintenance.history_help")}</DialogDescription>
          </div>
        </div>
        <Button ref={closeButton} data-testid="knowledge-history-dismiss" variant="ghost" size="icon-sm" className="absolute right-4 top-4 text-muted-foreground" aria-label={t("actions.close")} disabled={pending} onClick={onClose}><X /></Button>
      </ScrollableDialogHeader>
      <ScrollableDialogContent fadeMaskHeight={16} className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:px-4 [&>[data-slot=scroll-area-viewport]>div>div]:pt-1 [&>[data-slot=scroll-area-viewport]>div>div]:pb-4">
        <div data-testid="knowledge-history-content" aria-busy={pending} className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
          <ErrorNotice error={error} diagnostics={diagnostics} />
          {imports.length ? <ul data-testid="knowledge-history-list" className="min-w-0 divide-y rounded-xl border">
            {imports.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(receipt => {
              const undone = snapshot.maintenance?.undoneImportIds.includes(receipt.id);
              const undoable = snapshot.maintenance?.undoableImportIds.includes(receipt.id);
              return <li key={receipt.id} className="flex flex-wrap items-start gap-3 p-3">
                <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-4" /></span>
                <div className="min-w-0 flex-1 basis-48 space-y-1.5">
                  <p className="text-sm font-medium leading-5">{receipt.packageName}</p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <time dateTime={receipt.createdAt}>{new Date(receipt.createdAt).toLocaleString(i18n.language)}</time>
                    <span className="rounded-md bg-muted px-1.5 py-0.5">{t(undone ? "maintenance.undone" : undoable ? "maintenance.undoable" : "maintenance.legacy")}</span>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">{t("import.success", { ...receipt })}</p>
                </div>
                <Button data-testid="knowledge-undo-import" variant="outline" size="sm" disabled={pending || cleaning || undone || !undoable} onClick={() => onPlan({ generation: snapshot.generation, action: "undo_import", importId: receipt.id })}><RotateCcw />{t("maintenance.preview_undo")}</Button>
              </li>;
            })}
          </ul> : <section data-testid="knowledge-history-empty" className="flex min-h-64 flex-col items-center justify-center rounded-xl border bg-muted/20 px-5 py-8 text-center sm:min-h-72">
            <span aria-hidden="true" className="mb-4 flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"><FileText className="size-6" /></span>
            <h3 className="text-base font-semibold">{t("maintenance.no_imports")}</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t("maintenance.no_imports_help")}</p>
            <Button data-testid="knowledge-history-import" className="mt-5 max-w-full whitespace-normal" disabled={pending || cleaning} onClick={onImport}>{pending ? <LoaderCircle className="animate-spin" /> : <Upload />}{t("maintenance.import_now")}</Button>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("maintenance.import_file_hint")}</p>
          </section>}
          <details data-testid="knowledge-history-cleanup" className="group min-w-0 rounded-xl border">
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl p-3 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">{t("maintenance.cleanup_title")}<span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{sources.length.toLocaleString(i18n.language)}</span></div>
                <p className="text-xs font-normal leading-5 text-muted-foreground">{t("maintenance.cleanup_summary", { count: sources.length })}</p>
              </div>
            </summary>
            <div className="space-y-3 border-t p-3">
              <p className="text-xs leading-5 text-muted-foreground">{t("maintenance.unused_sources_help")}</p>
              {sources.length ? <>
                <div className="space-y-2">{sources.slice(currentSourcePage * PAGE_SIZE, (currentSourcePage + 1) * PAGE_SIZE).map(source => <div key={source.id} className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">{source.title}</p>
                  <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{source.excerpt}</p>
                  <Button data-testid="knowledge-purge-source" variant="outline" size="sm" disabled={pending || cleaning} onClick={() => onPlan({ generation: snapshot.generation, action: "purge", targets: [{ group: "sources", id: source.id }] })}>{t("maintenance.preview_purge")}</Button>
                </div>)}</div>
                {sources.length > PAGE_SIZE && <Pagination page={currentSourcePage} total={sources.length} onChange={setSourcePage} />}
              </> : <p data-testid="knowledge-history-no-sources" className="rounded-lg bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">{t("maintenance.no_unused_sources")}</p>}
            </div>
          </details>
        </div>
      </ScrollableDialogContent>
      <ScrollableDialogFooter className="flex flex-wrap items-center justify-between gap-3 p-4">
        <span data-testid="knowledge-history-page-summary" aria-live="polite" className="text-xs tabular-nums text-muted-foreground">{t("pagination", { count: imports.length, page: currentPage + 1, pages })}</span>
        <div className="ml-auto flex items-center gap-4">
          <div className="flex gap-1.5">
            <Button variant="outline" size="icon-sm" data-testid="knowledge-history-previous" disabled={pending || currentPage === 0} aria-label={t("actions.previous")} onClick={() => setPage(currentPage - 1)}><ChevronLeft /></Button>
            <Button variant="outline" size="icon-sm" data-testid="knowledge-history-next" disabled={pending || currentPage + 1 >= pages} aria-label={t("actions.next")} onClick={() => setPage(currentPage + 1)}><ChevronRight /></Button>
          </div>
          <Button data-testid="knowledge-history-close" size="sm" variant="outline" className="min-w-20" disabled={pending} onClick={onClose}>{t("actions.close")}</Button>
        </div>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}
