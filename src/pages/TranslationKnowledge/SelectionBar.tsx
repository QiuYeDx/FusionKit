import { useTranslation } from "react-i18next";
import { FolderInput, Power, PowerOff, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Collection } from "@/translation-knowledge/schemas";

/** Replaces the panel toolbar while entries are chosen: what can be done to all of them at once. */
export function SelectionBar({ count, targets, busy, onEnable, onMove, onDelete, onClear }: {
  count: number; targets: Collection[]; busy: boolean;
  onEnable: (enabled: boolean) => void; onMove: (collectionId: string) => void; onDelete: () => void; onClear: () => void;
}) {
  const { t } = useTranslation("knowledge");
  return <div data-testid="knowledge-selection-bar" role="toolbar" aria-label={t("selection.toolbar")} className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-1 gap-y-1 border-b bg-muted/30 px-3 py-2">
    <span data-testid="knowledge-selection-count" className="mr-2 text-xs font-medium tabular-nums">{t("selection.count", { count })}</span>
    <Button data-testid="knowledge-selection-enable" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onEnable(true)}><Power />{t("selection.enable")}</Button>
    <Button data-testid="knowledge-selection-disable" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onEnable(false)}><PowerOff />{t("selection.disable")}</Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button data-testid="knowledge-selection-move" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy}><FolderInput />{t("selection.move")}</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{t("selection.move_help")}</DropdownMenuLabel>
        {targets.map(collection => <DropdownMenuItem key={collection.id} data-move-target={collection.id} onSelect={() => onMove(collection.id)} className="[overflow-wrap:anywhere]">{collection.name}</DropdownMenuItem>)}
        {!targets.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("selection.move_none")}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Button data-testid="knowledge-selection-delete" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive" disabled={busy} onClick={onDelete}><Trash2 />{t("actions.delete")}</Button>
    <Button data-testid="knowledge-selection-clear" size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs text-muted-foreground" disabled={busy} onClick={onClear}><X />{t("selection.clear")}</Button>
  </div>;
}
