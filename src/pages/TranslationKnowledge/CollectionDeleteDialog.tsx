import { useRef, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronRight, Database, FileText, History, LoaderCircle, Trash2, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent,
  ScrollableDialogFooter, DialogTitle, DialogDescription,
} from "@/components/qiuye-ui/scrollable-dialog";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { MaintenancePreview } from "@/translation-knowledge/maintenance-contract";
import { Pagination } from "./Controls";
import { PAGE_SIZE } from "./model";
import "./collection-delete-dialog.css";

function ImpactRow({ icon: Icon, tone, title, description, badge, children, testId, defaultOpen = false }: {
  icon: LucideIcon;
  tone: string;
  title: string;
  description: string;
  badge: ReactNode;
  children?: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const content = <>
    <span aria-hidden="true" className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon className="size-5" /></span>
    <span className="min-w-0 flex-1 space-y-1">
      <span className="block text-sm font-medium leading-5">{title}</span>
      <span className="block text-xs font-normal leading-5 text-muted-foreground [overflow-wrap:anywhere]">{description}</span>
    </span>
    <span className="max-w-[35%] shrink-0 rounded-full bg-muted/70 px-2.5 py-1 text-center text-xs font-medium tabular-nums text-muted-foreground">{badge}</span>
    {children && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" />}
  </>;
  return children ? <details data-testid={testId} open={open} onToggle={event => setOpen(event.currentTarget.open)} className="collection-delete-impact-row group min-w-0">
    <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl p-2 outline-none transition-colors duration-150 ease-out hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none [&::-webkit-details-marker]:hidden">{content}</summary>
    <div className="px-2 pb-2">{children}</div>
  </details> : <div data-testid={testId} className="collection-delete-impact-row flex min-w-0 items-center gap-3 p-2">{content}</div>;
}

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
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState(0);
  const affected = preview.items.filter(item => item.effect !== "retain");
  const sample = affected.find(item => item.group === "entries");
  const sources = [...new Map(preview.items.filter(item => item.group === "sources" && item.effect === "retain").map(item => [item.id, item])).values()];
  const tasksKnown = preview.taskTracking === "connected" && !!preview.tasks && preview.tasks.unknownDocuments === 0;
  const hasTasks = !!preview.tasks?.total;
  const tasksClear = tasksKnown && !hasTasks;
  const hasHistory = preview.history.scope === "all";
  return <ScrollableDialog
    open
    onOpenChange={open => { if (!open && !pending) onClose(); }}
    maxWidth="sm:max-w-[600px]"
    contentClassName="max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] rounded-[20px] [&>button]:hidden"
    onOpenAutoFocus={event => { event.preventDefault(); cancelButton.current?.focus({ preventScroll: true }); }}
  >
    <ScrollableDialogHeader className="border-b-0 p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div data-testid="collection-maintenance-summary" className="flex items-start gap-3 text-left">
          <span aria-hidden="true" className="flex size-14 shrink-0 items-center justify-center rounded-[16px] bg-destructive/8 text-destructive"><Trash2 className="size-6" /></span>
          <div className="min-w-0 space-y-1.5 pt-0.5">
            <DialogTitle className="text-lg leading-7 [overflow-wrap:anywhere]">{t("collection_actions.delete_named", { names })}</DialogTitle>
            <DialogDescription className="text-sm leading-5">{t("collection_actions.delete_intro")}</DialogDescription>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("actions.close")} disabled={pending} onClick={onClose}><X /></Button>
      </div>
    </ScrollableDialogHeader>
    <ScrollableDialogContent fadeMaskHeight={16} className="min-h-0 min-w-0 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:min-w-0 [&>[data-slot=scroll-area-viewport]>div>div]:px-4 [&>[data-slot=scroll-area-viewport]>div>div]:py-0">
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="space-y-3 [&:has(>*)]:pb-3">
          {preview.blockers.some(item => item.code === "PURGE_REFERENCED") && <p role="alert" className="text-xs leading-5 text-destructive">{t("collection_actions.references_help")}</p>}
          {notice}
        </div>
        <section className="pb-1" aria-labelledby="collection-delete-removal-heading">
          <h3 id="collection-delete-removal-heading" className="mb-1 text-sm font-semibold">{t("collection_actions.will_delete")}</h3>
          <div className="collection-delete-impact-list -mx-2">
            <ImpactRow icon={FileText} tone="bg-violet-500/10 text-violet-600 dark:text-violet-400" title={t("collection_actions.entries_label")}
              description={sample ? t("collection_actions.entry_example", { title: sample.title }) : t("collection_actions.empty_entries")}
              badge={t("collection_actions.entry_count", { count: entries })} testId="knowledge-collection-delete-details" defaultOpen={!preview.canCommit}>
              <ul className="divide-y divide-border/60 rounded-lg border px-3">
                {affected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) => <li key={`${item.group}-${item.id}-${index}`} className="py-2 text-xs leading-5">
                  <p className="font-medium">{item.title}</p>
                  <p className="text-muted-foreground">{t(`group.${item.group}`)} · {t(`maintenance.effect.${item.effect}`)} · {t(`maintenance.reason.${item.reason}`)}</p>
                </li>)}
              </ul>
              {affected.length > PAGE_SIZE && <Pagination page={page} total={affected.length} onChange={setPage} />}
            </ImpactRow>
            {hasHistory && <ImpactRow icon={History} tone="bg-destructive/8 text-destructive" title={t("collection_actions.history_label")}
              description={t("collection_actions.history_scope", { count: preview.history.importsLosingUndo })}
              badge={t("collection_actions.snapshot_count", { count: preview.history.snapshots })} testId="knowledge-collection-delete-history">
              <p className="text-xs leading-5 text-muted-foreground">{t("maintenance.purge_help")}</p>
              {preview.history.importsLosingUndo > 0 && <div className="mt-3 space-y-2 text-xs leading-5">
                <p className="font-medium">{t("maintenance.imports_losing_undo")}</p>
                <ul className="space-y-1 text-muted-foreground">{snapshot.imports.filter(item => snapshot.maintenance?.undoableImportIds.includes(item.id)).map(item => <li key={item.id}>{item.packageName} · {new Date(item.createdAt).toLocaleString(i18n.language)}</li>)}</ul>
              </div>}
            </ImpactRow>}
          </div>
        </section>
        <section className="pt-1 pb-1" aria-labelledby="collection-delete-retained-heading">
          <h3 id="collection-delete-retained-heading" className="mb-1 text-sm font-semibold">{t("collection_actions.will_keep")}</h3>
          <div className="collection-delete-impact-list -mx-2">
            <ImpactRow icon={Database} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" title={t("collection_actions.sources_label")}
              description={sources.length ? sources.map(item => item.title).join(" · ") : t("collection_actions.no_sources")}
              badge={<span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 aria-hidden="true" className="size-3.5" />{t("collection_actions.retained")}</span>} />
            <ImpactRow icon={CheckCircle2} tone="bg-blue-500/10 text-blue-600 dark:text-blue-400" title={t("collection_actions.tasks_label")}
              description={t(tasksClear ? "collection_actions.tasks_clear" : hasTasks ? "collection_actions.tasks_blocked" : "collection_actions.tasks_unknown")}
              badge={t(tasksClear ? "collection_actions.unaffected" : hasTasks ? "collection_actions.needs_unlink" : "collection_actions.needs_check")} testId="knowledge-collection-delete-tasks" defaultOpen={!tasksClear}>
              {tasksClear ? undefined : tasks}
            </ImpactRow>
          </div>
        </section>

      </div>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="p-4">
      <div className="flex flex-wrap justify-end gap-3">
        <Button ref={cancelButton} variant="outline" className="min-w-24" disabled={pending} onClick={onClose}>{t("collection_actions.cancel")}</Button>
        <Button data-testid="knowledge-maintenance-confirm" variant="destructive" className="min-w-32" disabled={disabled} onClick={onSubmit}>
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {t(pending ? "maintenance.working" : "collection_actions.delete_title")}
        </Button>
      </div>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
