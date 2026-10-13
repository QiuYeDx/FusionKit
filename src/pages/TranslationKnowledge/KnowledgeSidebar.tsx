import type { ComponentProps, ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowRight, Download, Folder, FolderArchive, Plus, Subtitles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToolPanel } from "@/pages/Tools/_shared/ui/ToolPanel";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { Collection } from "@/translation-knowledge/schemas";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "./GlobalSearch";
import { KnowledgeDisclosure } from "./KnowledgeDisclosure";
import { KnowledgeScrollList } from "./KnowledgeScrollList";
import { KnowledgeSkillDownload } from "./KnowledgeSkillDownload";
import { languagePairLabel } from "./labels";
import { entryCounts, orderedCollections } from "./model";

function NavigationRow({ active = false, children, count, className, icon: Icon = Folder, ...props }: ComponentProps<"button"> & {
  active?: boolean; count?: number; children: ReactNode; icon?: typeof Folder;
}) {
  return <button
    type="button"
    aria-current={active ? "true" : undefined}
    className={cn(
      "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-smooth-lg px-2.5 py-2 text-left text-[13px] leading-5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
      active && "bg-muted font-medium text-foreground hover:bg-muted",
      className,
    )}
    {...props}
  >
    <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1">{children}</span>
    {count !== undefined && <span className="min-w-5 shrink-0 rounded px-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>}
  </button>;
}

export function KnowledgeSidebar({ snapshot, selectedId, busy, onSelect, onSelectEntry, onCreate, onImport, onExport }: {
  snapshot: LibrarySnapshot | null;
  selectedId: string | undefined;
  busy: boolean;
  onSelect: (collectionId: string) => void;
  onSelectEntry: (collectionId: string, entryId: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onExport: () => void;
}) {
  const { t } = useTranslation("knowledge");
  const collections = snapshot ? orderedCollections(snapshot) : [];
  const live = collections.filter(item => !item.archived), archived = collections.filter(item => item.archived);
  const counts = useMemo(() => snapshot ? entryCounts(snapshot) : new Map<string, { terms: number; notes: number }>(), [snapshot]);
  const row = (collection: Collection) => {
    const count = counts.get(collection.id);
    return <Tooltip key={collection.id} delayDuration={400}>
      <TooltipTrigger asChild>
        <NavigationRow data-collection-id={collection.id} active={selectedId === collection.id} icon={collection.archived ? FolderArchive : Folder}
          count={(count?.terms ?? 0) + (count?.notes ?? 0)} onClick={() => onSelect(collection.id)} className="py-1.5">
          <span className="block truncate">{collection.name}</span>
          <span className="block truncate text-[11px] font-normal leading-4 text-muted-foreground">{languagePairLabel(t, collection.languagePair)}</span>
        </NavigationRow>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="w-max max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal text-wrap [overflow-wrap:anywhere]">
        <span className="block">{collection.name}</span>
        <span className="mt-1 block text-[11px] opacity-80">{languagePairLabel(t, collection.languagePair)}</span>
      </TooltipContent>
    </Tooltip>;
  };
  return <ToolPanel id="knowledge-collection-list" title={t("sidebar.collections")} badge={snapshot ? <span className="text-[11px] tabular-nums text-muted-foreground">{live.length}</span> : undefined} bodyClassName="min-w-0">
    <div className="border-b p-2"><GlobalSearch snapshot={snapshot} onSelect={onSelectEntry} /></div>
    <nav id="knowledge-tour-collections" aria-label={t("sidebar.collections")} className="space-y-1 p-2">
      <KnowledgeScrollList testId="knowledge-collections-scroll" maxHeight="min(27rem, 48vh)" contentClassName="space-y-1">
        {live.map(row)}
      </KnowledgeScrollList>
      {snapshot && !live.length && <p className="px-2.5 py-2 text-xs leading-5 text-muted-foreground">{t("sidebar.empty")}</p>}
      <NavigationRow data-testid="knowledge-new-collection" icon={Plus} disabled={!snapshot || busy} onClick={onCreate} className="text-muted-foreground hover:text-foreground">
        {t("collection.new")}
      </NavigationRow>
      {archived.length > 0 && <KnowledgeDisclosure id="knowledge-archived" data-testid="knowledge-archived" variant="inline"
        defaultOpen={archived.some(item => item.id === selectedId)}
        title={<span className="flex items-center gap-2.5 text-[13px] font-normal text-muted-foreground"><FolderArchive aria-hidden className="size-3.5 shrink-0" />{t("sidebar.archived", { count: archived.length })}</span>}
        className="[&>div>h3>button]:px-2.5" contentClassName="space-y-1 px-0 pb-0 pt-1">
        {archived.map(row)}
      </KnowledgeDisclosure>}
    </nav>
    <div className="grid grid-cols-2 gap-2 border-t p-3">
      <Button data-testid="knowledge-import" size="sm" variant="outline" className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5 text-xs" disabled={busy || !snapshot} onClick={onImport}><Download className="size-3.5" />{t("sidebar.import")}</Button>
      <Button data-testid="knowledge-export" size="sm" variant="outline" className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5 text-xs" disabled={busy || !snapshot?.data.collections.length} onClick={onExport}><Upload className="size-3.5" />{t("sidebar.export")}</Button>
    </div>
    <KnowledgeSkillDownload />
    <Link id="knowledge-tour-studio" data-testid="knowledge-open-studio" to="/tools/subtitle/studio"
      className="group flex min-w-0 items-center gap-3 border-t bg-muted/25 p-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none">
      <Subtitles aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 space-y-1 [overflow-wrap:anywhere]">
        <span className="block text-[13px] font-medium leading-5">{t("sidebar.studio")}</span>
        <span className="block text-[11px] leading-4 text-muted-foreground">{t("sidebar.studio_help")}</span>
      </span>
      <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" />
    </Link>
  </ToolPanel>;
}
