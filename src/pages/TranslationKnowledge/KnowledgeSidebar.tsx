import type { ComponentProps, ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Archive, ArrowRight, BookOpen, CircleCheck, Download, Folder, FolderPlus,
  History, Layers3, Library, Plus, SlidersHorizontal, Subtitles,
  Upload, Users, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToolPanel } from "@/pages/Tools/_shared/ui/ToolPanel";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { Collection, Subject } from "@/translation-knowledge/schemas";
import { cn } from "@/lib/utils";
import { KnowledgeDisclosure } from "./KnowledgeDisclosure";
import { languagePairLabel } from "./labels";

export type KnowledgeLibraryView = "materials" | "plans" | "review" | "archived" | "stored";

type KnowledgeSidebarProps = {
  snapshot: LibrarySnapshot | null;
  view: KnowledgeLibraryView;
  selectedCollectionId: string;
  reviewCount: number;
  busy: boolean;
  blocked: boolean;
  onSelectCollection: (id: string, archived?: boolean) => void;
  onSelectView: (view: KnowledgeLibraryView) => void;
  onCreateCollection: () => void;
  onCreateSubject: () => void;
  onEditSubject: (subject: Subject) => void;
  onImport: () => void;
  onExport: () => void;
  onHistory: () => void;
};

function NavigationRow({
  icon: Icon, active = false, children, count, className, ...props
}: ComponentProps<"button"> & {
  icon: LucideIcon;
  active?: boolean;
  count?: number;
  children: ReactNode;
}) {
  return <button
    type="button"
    aria-current={active ? "true" : undefined}
    className={cn(
      "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
      active && "bg-muted font-medium text-foreground",
      className,
    )}
    {...props}
  >
    <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
    {count !== undefined && <span className="min-w-5 shrink-0 rounded px-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>}
  </button>;
}

export function KnowledgeSidebar({
  snapshot, view, selectedCollectionId, reviewCount, busy, blocked,
  onSelectCollection, onSelectView, onCreateCollection, onCreateSubject,
  onEditSubject, onImport, onExport, onHistory,
}: KnowledgeSidebarProps) {
  const { t } = useTranslation("knowledge");
  const activeCollections = snapshot?.data.collections.filter(collection => !collection.archived) ?? [];
  const archivedCollections = snapshot?.data.collections.filter(collection => collection.archived) ?? [];
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const entry of snapshot?.data.entries ?? []) {
      if (entry.state !== "archived") result.set(entry.collectionId, (result.get(entry.collectionId) ?? 0) + 1);
    }
    return result;
  }, [snapshot]);
  const activeEntryCount = activeCollections.reduce((total, collection) => total + (counts.get(collection.id) ?? 0), 0);

  const collectionRow = (collection: Collection, archived = false) => <Tooltip key={collection.id} delayDuration={400}>
    <TooltipTrigger asChild>
      <NavigationRow
        data-collection-id={collection.id}
        icon={Folder}
        active={view === (archived ? "archived" : "materials") && selectedCollectionId === collection.id}
        count={archived ? undefined : counts.get(collection.id) ?? 0}
        onClick={() => onSelectCollection(collection.id, archived)}
        className={archived ? "min-h-8 py-1.5" : "py-2.5"}
      >
        <span className="block truncate font-medium">{collection.name}</span>
        {!archived && <span className="mt-0.5 block truncate text-[11px] font-normal leading-4 text-muted-foreground">
          {collection.defaultLanguagePair ? languagePairLabel(t, collection.defaultLanguagePair) : t("workspace.mixed_languages")}
        </span>}
      </NavigationRow>
    </TooltipTrigger>
    <TooltipContent side="right" sideOffset={8} className="w-max max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal text-wrap [overflow-wrap:anywhere]">
      <span className="block">{collection.name}</span>
      {collection.defaultLanguagePair && <span className="mt-1 block text-[11px] opacity-80">{languagePairLabel(t, collection.defaultLanguagePair)}</span>}
    </TooltipContent>
  </Tooltip>;

  return <ToolPanel
    id="knowledge-collection-list"
    title={t("workspace.collections")}
    icon={BookOpen}
    actions={<Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <Button
          data-testid="knowledge-new-collection"
          id="knowledge-tour-collection"
          size="icon-sm"
          variant="ghost"
          aria-label={t("actions.new_collection")}
          disabled={!snapshot || blocked}
          onClick={onCreateCollection}
        ><FolderPlus /></Button>
      </TooltipTrigger>
      <TooltipContent>{t("actions.new_collection")}</TooltipContent>
    </Tooltip>}
    bodyClassName="min-w-0"
  >
    <nav aria-label={t("workspace.collections")} className="space-y-1 p-2">
      <NavigationRow
        data-testid="knowledge-all"
        icon={Layers3}
        active={view === "materials" && selectedCollectionId === "all"}
        count={activeEntryCount}
        onClick={() => onSelectCollection("all")}
      >{t("workspace.all")}</NavigationRow>
      <div data-testid="knowledge-collections-scroll" className="max-h-[min(19rem,42vh)] space-y-1 overflow-y-auto overscroll-contain">
        {activeCollections.map(collection => collectionRow(collection))}
      </div>
      {!activeCollections.length && <p className="px-2.5 py-3 text-xs leading-5 text-muted-foreground">{t("workspace.empty_collections")}</p>}
    </nav>

    <div className="space-y-1 border-t p-2">
      {reviewCount > 0 && <NavigationRow data-testid="knowledge-review" icon={CircleCheck} active={view === "review"} count={reviewCount} onClick={() => onSelectView("review")}>
        {t("workspace.review")}
      </NavigationRow>}
      <NavigationRow data-testid="knowledge-archive" icon={Archive} active={view === "archived" && selectedCollectionId === "all"} onClick={() => onSelectView("archived")}>
        {t("workspace.archived")}
      </NavigationRow>
      {view === "archived" && archivedCollections.length > 0 && <div className="ml-4 max-h-40 space-y-1 overflow-y-auto overscroll-contain border-l pl-2">
        {archivedCollections.map(collection => collectionRow(collection, true))}
      </div>}
      <KnowledgeDisclosure
        id="knowledge-more-management"
        variant="inline"
        title={<span className="flex items-center gap-2.5 text-[13px] font-normal"><SlidersHorizontal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />{t("workspace.management")}</span>}
        className="[&>div>h3>button]:px-2.5"
        contentClassName="space-y-1 px-0 pb-0 pt-1"
      >
        <NavigationRow icon={SlidersHorizontal} active={view === "plans"} onClick={() => onSelectView("plans")}>{t("views.plans")}</NavigationRow>
        <NavigationRow icon={Library} active={view === "stored"} onClick={() => onSelectView("stored")}>{t("workspace.stored")}</NavigationRow>
        <KnowledgeDisclosure
          variant="inline"
          title={<span className="flex items-center gap-2.5 text-[13px] font-normal"><Users aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />{t("subjects.title")}</span>}
          className="[&>div>h3>button]:px-2.5"
          contentClassName="space-y-1 pl-8 pr-2 pb-2"
        >
          {snapshot?.data.subjects.map(subject => <Button key={subject.id} data-catalog-id={subject.id} variant="ghost" size="sm" className="h-auto min-h-8 w-full justify-start whitespace-normal px-2 text-left text-xs [overflow-wrap:anywhere]" onClick={() => onEditSubject(subject)}>
            {subject.name}{subject.archived ? ` · ${t("status.archived")}` : ""}
          </Button>)}
          <Button variant="outline" size="sm" className="h-auto min-h-8 w-full justify-start whitespace-normal text-left text-xs" disabled={!snapshot || blocked} onClick={onCreateSubject}><Plus />{t("actions.new_subject")}</Button>
        </KnowledgeDisclosure>
        <NavigationRow data-testid="knowledge-history" icon={History} disabled={!snapshot || busy} onClick={onHistory}>{t("sidebar.history")}</NavigationRow>
      </KnowledgeDisclosure>
    </div>

    <div className="grid grid-cols-2 gap-2 border-t p-3">
      <Button data-testid="knowledge-import" size="sm" variant="outline" className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5 text-xs" aria-label={t("actions.import")} title={t("actions.import")} disabled={busy || !snapshot || blocked} onClick={onImport}><Download className="size-3.5" />{t("sidebar.import")}</Button>
      <Button data-testid="knowledge-export" size="sm" variant="outline" className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5 text-xs" aria-label={t("actions.export")} title={t("actions.export")} disabled={!snapshot || busy || blocked} onClick={onExport}><Upload className="size-3.5" />{t("sidebar.export")}</Button>
    </div>
    <Link
      id="knowledge-tour-studio"
      data-testid="knowledge-open-studio"
      to="/tools/subtitle/studio"
      className="group flex min-w-0 items-center gap-3 border-t bg-muted/25 p-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
    >
      <Subtitles aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 space-y-1 [overflow-wrap:anywhere]">
        <span className="block text-[13px] font-medium leading-5">{t("guide.translate")}</span>
        <span className="block text-[11px] leading-4 text-muted-foreground">{t("sidebar.studio_help")}</span>
      </span>
      <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" />
    </Link>
  </ToolPanel>;
}
