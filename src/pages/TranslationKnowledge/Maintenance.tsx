import { useState } from "react";
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
  const stale = snapshot.generation !== preview.generation;
  const cleaning = snapshot.maintenance?.cleanupPending === true;
  const submit = async () => {
    if (pending || stale || cleaning) return;
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
      setPending(false);
    }
  };
  return (
    <KnowledgeDialog
      title={t(`maintenance.action.${preview.action}`)}
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
              : `maintenance.confirm.${preview.action}`,
          )}
        </Button>
      }
    >
      {preview.action !== "purge" && <p className="text-xs text-muted-foreground">
        {t(
          preview.action === "restore"
            ? "maintenance.restore_help"
            : preview.action === "undo_import"
              ? "maintenance.undo_help"
              : "maintenance.archive_help",
        )}
      </p>}
      {preview.action === 'purge' && preview.blockers.some(item => item.code.startsWith('PURGE_TASK_')) && <div role="alert" data-testid="knowledge-maintenance-reference-blocker" className="space-y-2 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
        {preview.blockers.filter(item => item.code.startsWith('PURGE_TASK_')).map(item => <p key={item.code}>{t(diagnosticKey(`diagnostic.${item.code}`))}</p>)}
      </div>}
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
      <Pagination page={page} total={preview.items.length} onChange={setPage} />
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
        {preview.tasks.items.slice(taskPage * PAGE_SIZE, (taskPage + 1) * PAGE_SIZE).map(task => <details key={`${task.documentId}:${task.recordId}`} className="min-w-0 rounded-md border p-3">
          <summary className="cursor-pointer text-xs [overflow-wrap:anywhere]">{task.displayName} · {t(task.status === "active" ? "maintenance.record_active" : "maintenance.record_retained")}</summary>
          <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("maintenance.record_id", { id: task.recordId })}</p>
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
  snapshot,
  pending,
  onClose,
  onPlan,
  error,
  diagnostics,
}: {
  snapshot: LibrarySnapshot;
  pending: boolean;
  error: KnowledgeErrorCode | "unexpected" | null;
  diagnostics: Diagnostic[];
  onClose: () => void;
  onPlan: (request: MaintenanceRequest) => void;
}) {
  const { t } = useTranslation("knowledge");
  const [page, setPage] = useState(0);
  const [sourcePage, setSourcePage] = useState(0);
  const imports = [...snapshot.imports].reverse();
  const sources = snapshot.data.sources.filter((source) =>
    isSourceUnreferenced(source.id, snapshot.data),
  );
  const cleaning = snapshot.maintenance?.cleanupPending === true;
  return (
    <KnowledgeDialog
      title={t("maintenance.history_title")}
      description={t("maintenance.history_help")}
      wide
      onClose={onClose}
      pending={pending}
      footer={null}
    >
      <ErrorNotice error={error} diagnostics={diagnostics} />
      <div className="space-y-2">
        {imports
          .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
          .map((receipt) => {
            const undone = snapshot.maintenance?.undoneImportIds.includes(
              receipt.id,
            );
            const undoable = snapshot.maintenance?.undoableImportIds.includes(
              receipt.id,
            );
            return (
              <div
                key={receipt.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">
                    {receipt.packageName}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(receipt.createdAt).toLocaleString()} ·{" "}
                    {t(
                      undone
                        ? "maintenance.undone"
                        : undoable
                          ? "maintenance.undoable"
                          : "maintenance.legacy",
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("import.success", { ...receipt })}
                  </p>
                </div>
                <Button
                  data-testid="knowledge-undo-import"
                  variant="outline"
                  size="sm"
                  disabled={pending || cleaning || undone || !undoable}
                  onClick={() =>
                    onPlan({
                      generation: snapshot.generation,
                      action: "undo_import",
                      importId: receipt.id,
                    })
                  }
                >
                  {t("maintenance.preview_undo")}
                </Button>
              </div>
            );
          })}
        {!imports.length && (
          <p className="py-4 text-sm text-muted-foreground">
            {t("maintenance.no_imports")}
          </p>
        )}
      </div>
      <Pagination page={page} total={imports.length} onChange={setPage} />
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t("maintenance.unused_sources", { count: sources.length })}
        </summary>
        <p className="my-3 text-xs text-muted-foreground">
          {t("maintenance.unused_sources_help")}
        </p>
        <div className="space-y-2">
          {sources
            .slice(sourcePage * PAGE_SIZE, (sourcePage + 1) * PAGE_SIZE)
            .map((source) => (
              <div key={source.id} className="rounded-md border p-3">
                <p className="text-sm font-medium break-words">
                  {source.title}
                </p>
                <p className="my-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {source.excerpt}
                </p>
                <Button
                  data-testid="knowledge-purge-source"
                  variant="outline"
                  size="sm"
                  disabled={pending || cleaning}
                  onClick={() =>
                    onPlan({
                      generation: snapshot.generation,
                      action: "purge",
                      targets: [{ group: "sources", id: source.id }],
                    })
                  }
                >
                  {t("maintenance.preview_purge")}
                </Button>
              </div>
            ))}
        </div>
        <Pagination
          page={sourcePage}
          total={sources.length}
          onChange={setSourcePage}
        />
      </details>
    </KnowledgeDialog>
  );
}
