import { useState, type ReactNode } from "react";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { CheckCircle2, Database, FileText, History, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { MaintenancePreview } from "@/translation-knowledge/maintenance-contract";
import { Pagination } from "./Controls";
import { PAGE_SIZE } from "./model";
import { CollectionActionDialog, CollectionImpactRow } from "./CollectionActionDialog";

export function CollectionDeleteDialog({ preview, snapshot, names, entries, pending, disabled, onClose, onSubmit, tasks, notice }: {
  preview: MaintenancePreview;
  snapshot: LibrarySnapshot;
  names: string;
  entries: number;
  pending: boolean;
  disabled: boolean;
  onClose: () => void;
  onSubmit: () => void;
  tasks: ReactNode;
  notice: ReactNode;
}) {
  const { t, i18n } = useTranslation("knowledge");
  const [page, setPage] = useState(0);
  const affected = preview.items.filter(item => item.effect !== "retain");
  const sample = affected.find(item => item.group === "entries");
  const sources = [...new Map(preview.items.filter(item => item.group === "sources" && item.effect === "retain").map(item => [item.id, item])).values()];
  const tasksKnown = preview.taskTracking === "connected" && !!preview.tasks && preview.tasks.unknownDocuments === 0;
  const hasTasks = !!preview.tasks?.total;
  const tasksClear = tasksKnown && !hasTasks;
  const hasHistory = preview.history.scope === "all";
  return <CollectionActionDialog
    icon={Trash2}
    tone="bg-destructive/8 text-destructive"
    title={t("collection_actions.delete_named", { names })}
    description={t("collection_actions.delete_intro")}
    confirmLabel={t("collection_actions.delete_title")}
    destructive
    pending={pending}
    disabled={disabled}
    onClose={onClose}
    onSubmit={onSubmit}
  >
    <div className="min-w-0 [overflow-wrap:anywhere]">
      {preview.blockers.some(item => item.code === "PURGE_REFERENCED") && <p role="alert" className="pb-3 text-xs leading-5 text-destructive">{t("collection_actions.references_help")}</p>}
      {notice}
      <section className="pb-1" aria-labelledby="collection-delete-removal-heading">
        <h3 id="collection-delete-removal-heading" className="mb-1 text-sm font-semibold">{t("collection_actions.will_delete")}</h3>
        <div className="collection-action-impact-list -mx-2">
          <CollectionImpactRow icon={FileText} tone="bg-violet-500/10 text-violet-600 dark:text-violet-400" title={t("collection_actions.entries_label")}
            description={sample ? t("collection_actions.entry_example", { title: sample.title }) : t("collection_actions.empty_entries")}
            badge={t("collection_actions.entry_count", { count: entries })} testId="knowledge-collection-delete-details" defaultOpen={!preview.canCommit}>
            <DialogTransition transitionKey={page}><ul className="divide-y divide-border/60 rounded-lg border px-3">
              {affected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) => <li key={`${item.group}-${item.id}-${index}`} className="py-2 text-xs leading-5">
                <p className="font-medium">{item.title}</p>
                <p className="text-muted-foreground">{t(`group.${item.group}`)} · {t(`maintenance.effect.${item.effect}`)} · {t(`maintenance.reason.${item.reason}`)}</p>
              </li>)}
            </ul></DialogTransition>
            {affected.length > PAGE_SIZE && <Pagination page={page} total={affected.length} onChange={setPage} />}
          </CollectionImpactRow>
          {hasHistory && <CollectionImpactRow icon={History} tone="bg-destructive/8 text-destructive" title={t("collection_actions.history_label")}
            description={t("collection_actions.history_scope", { count: preview.history.importsLosingUndo })}
            badge={t("collection_actions.snapshot_count", { count: preview.history.snapshots })} testId="knowledge-collection-delete-history">
            <p className="text-xs leading-5 text-muted-foreground">{t("maintenance.purge_help")}</p>
            {preview.history.importsLosingUndo > 0 && <div className="mt-3 space-y-2 text-xs leading-5">
              <p className="font-medium">{t("maintenance.imports_losing_undo")}</p>
              <ul className="space-y-1 text-muted-foreground">{snapshot.imports.filter(item => snapshot.maintenance?.undoableImportIds.includes(item.id)).map(item => <li key={item.id}>{item.packageName} · {new Date(item.createdAt).toLocaleString(i18n.language)}</li>)}</ul>
            </div>}
          </CollectionImpactRow>}
        </div>
      </section>
      <section className="pt-1 pb-1" aria-labelledby="collection-delete-retained-heading">
        <h3 id="collection-delete-retained-heading" className="mb-1 text-sm font-semibold">{t("collection_actions.will_keep")}</h3>
        <div className="collection-action-impact-list -mx-2">
          <CollectionImpactRow icon={Database} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" title={t("collection_actions.sources_label")}
            description={sources.length ? sources.map(item => item.title).join(" · ") : t("collection_actions.no_sources")}
            badge={<span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 aria-hidden="true" className="size-3.5" />{t("collection_actions.retained")}</span>} />
          <CollectionImpactRow icon={CheckCircle2} tone="bg-blue-500/10 text-blue-600 dark:text-blue-400" title={t("collection_actions.tasks_label")}
            description={t(tasksClear ? "collection_actions.tasks_clear" : hasTasks ? "collection_actions.tasks_blocked" : "collection_actions.tasks_unknown")}
            badge={t(tasksClear ? "collection_actions.unaffected" : hasTasks ? "collection_actions.needs_unlink" : "collection_actions.needs_check")} testId="knowledge-collection-delete-tasks" defaultOpen={!tasksClear}>
            {tasksClear ? undefined : tasks}
          </CollectionImpactRow>
        </div>
      </section>

    </div>
  </CollectionActionDialog>;
}
