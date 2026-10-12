import { useTranslation } from "react-i18next";
import { Archive, ArchiveRestore, Ellipsis, Pencil, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Collection } from "@/translation-knowledge/schemas";
import { languagePairLabel } from "./labels";

/** The current collection: what it is, and what can be done to it as a whole. */
export function CollectionHeader({ collection, busy, onEdit, onExport, onArchive, onDelete }: {
  collection: Collection; busy: boolean;
  onEdit: () => void; onExport: () => void; onArchive: (archived: boolean) => void; onDelete: () => void;
}) {
  const { t } = useTranslation("knowledge");
  return <div data-testid="knowledge-collection-header" className="flex min-w-0 items-start justify-between gap-3">
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="min-w-0 text-lg font-semibold leading-7 [overflow-wrap:anywhere]">{collection.name}</h2>
        {collection.archived && <Badge variant="secondary" data-testid="knowledge-archived-badge">{t("collection.archived")}</Badge>}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        <span data-testid="knowledge-collection-direction">{languagePairLabel(t, collection.languagePair)}</span>
        {collection.description && <><span aria-hidden className="px-1.5">·</span>
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild><span tabIndex={0} className="rounded outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring line-clamp-1 inline">{collection.description}</span></TooltipTrigger>
            <TooltipContent className="w-max max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-wrap text-wrap [overflow-wrap:anywhere]">{collection.description}</TooltipContent>
          </Tooltip>
        </>}
      </p>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      {collection.archived && <Button data-testid="knowledge-collection-restore" size="sm" variant="outline" disabled={busy} onClick={() => onArchive(false)}><ArchiveRestore />{t("collection.restore")}</Button>}
      <Button data-testid="knowledge-edit-collection" variant="ghost" size="icon-sm" aria-label={t("collection.edit")} title={t("collection.edit")} disabled={busy} onClick={onEdit}><Pencil /></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button data-testid="knowledge-collection-actions" variant="ghost" size="icon-sm" aria-label={t("collection.more")} disabled={busy}><Ellipsis /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="knowledge-collection-export" onSelect={onExport}><Upload />{t("collection.export")}</DropdownMenuItem>
          {!collection.archived && <DropdownMenuItem data-testid="knowledge-collection-archive" onSelect={() => onArchive(true)}><Archive />{t("collection.archive")}</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="knowledge-collection-delete" variant="destructive" onSelect={onDelete}><Trash2 />{t("collection.delete")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>;
}
