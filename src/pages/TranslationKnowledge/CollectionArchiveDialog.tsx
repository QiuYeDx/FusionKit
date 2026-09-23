import { useState, type ReactNode } from "react";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { Archive, CheckCircle2, Database, FileText, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MaintenancePreview } from "@/translation-knowledge/maintenance-contract";
import { CollectionActionDialog, CollectionImpactRow, type CollectionActionState } from "./CollectionActionDialog";
import { Pagination } from "./Controls";
import { PAGE_SIZE } from "./model";

export function CollectionArchiveDialog({ preview, names, entries, tasks, notice, ...action }: CollectionActionState & {
  preview: MaintenancePreview;
  names: string;
  entries: number;
  tasks: ReactNode;
  notice: ReactNode;
}) {
  const { t } = useTranslation("knowledge");
  const [page, setPage] = useState(0);
  const tasksKnown = preview.taskTracking === "connected" && !!preview.tasks && preview.tasks.unknownDocuments === 0;
  const showTasks = !tasksKnown || !!preview.tasks?.total;

  return <CollectionActionDialog
    icon={Archive}
    tone="bg-amber-500/10 text-amber-700 dark:text-amber-400"
    title={t("collection_actions.archive_named", { names })}
    description={t("collection_actions.archive_intro")}
    confirmLabel={t("collection_actions.archive")}
    {...action}
  >
    <div className="min-w-0 [overflow-wrap:anywhere]">
      {notice}
      <section className="pb-1" aria-labelledby="collection-archive-impact-heading">
        <h3 id="collection-archive-impact-heading" className="mb-1 text-sm font-semibold">{t("collection_actions.will_archive")}</h3>
        <div className="collection-action-impact-list -mx-2">
          <CollectionImpactRow icon={FileText} tone="bg-violet-500/10 text-violet-600 dark:text-violet-400"
            title={t("collection_actions.archive_contents")}
            description={t("collection_actions.archive_contents_help")}
            badge={t("collection_actions.entry_count", { count: entries })}
            testId="knowledge-collection-archive-details" defaultOpen={!preview.canCommit}>
            <DialogTransition transitionKey={page}><ul className="divide-y divide-border/60 rounded-lg border px-3">
              {preview.items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) => <li key={`${item.group}-${item.id}-${index}`} className="py-2 text-xs leading-5">
                <p className="font-medium">{item.title}</p>
                <p className="text-muted-foreground">{t(`group.${item.group}`)} · {t(`maintenance.effect.${item.effect}`)} · {t(`maintenance.reason.${item.reason}`)}</p>
              </li>)}
            </ul></DialogTransition>
            {preview.items.length > PAGE_SIZE && <Pagination page={page} total={preview.items.length} onChange={setPage} />}
          </CollectionImpactRow>
        </div>
      </section>
      <section className="pt-1 pb-1" aria-labelledby="collection-archive-retained-heading">
        <h3 id="collection-archive-retained-heading" className="mb-1 text-sm font-semibold">{t("collection_actions.will_keep")}</h3>
        <div className="collection-action-impact-list -mx-2">
          <CollectionImpactRow icon={Database} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            title={t("collection_actions.archive_retained")}
            description={t("collection_actions.archive_retained_help")}
            badge={<span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 aria-hidden="true" className="size-3.5" />{t("collection_actions.retained")}</span>} />
          <CollectionImpactRow icon={CheckCircle2} tone="bg-blue-500/10 text-blue-600 dark:text-blue-400"
            title={t("collection_actions.archive_tasks")}
            description={t("collection_actions.archive_tasks_help")}
            badge={t("collection_actions.unaffected")} testId="knowledge-collection-archive-tasks">
            {showTasks ? tasks : undefined}
          </CollectionImpactRow>
        </div>
      </section>
      <div data-testid="knowledge-collection-archive-restore-hint" className="mb-3 mt-1 flex items-start gap-2 rounded-xl bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
        <RotateCcw aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>{t("collection_actions.archive_restore_help")}</p>
      </div>
    </div>
  </CollectionActionDialog>;
}
