import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, FileStack, FilePlus2, FolderPlus, Languages, ListChecks, Loader2, Square, Trash2, Wand2 } from "lucide-react";
import { ToolPanel } from "@/pages/Tools/_shared/ui";
import { ClipPathTabs } from "@/components/qiuye-ui/clip-path-tabs";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RowFilter, RowState, VisibleRow } from "@/services/name-translation/workspace";
import useNameTranslatorStore from "@/store/tools/rename/useNameTranslatorStore";
import { EntryRow, ROW_HEIGHT, type EntryRowActions } from "./EntryRow";

const OVERSCAN = 8;

export interface EntrySummary {
  checked: number;
  ready: number;
  needsTranslation: number;
  issues: number;
  failed: number;
  translating: number;
  duplicates: number;
}

export function summarize(checked: Record<string, true>, states: ReadonlyMap<string, RowState>): EntrySummary {
  const summary: EntrySummary = { checked: 0, ready: 0, needsTranslation: 0, issues: 0, failed: 0, translating: 0, duplicates: 0 };
  for (const key of Object.keys(checked)) {
    const state = states.get(key);
    // Selections whose entry is not loaded (e.g. removed from disk) are ignored.
    if (!state) continue;
    summary.checked += 1;
    switch (state?.status) {
      case "ready":
        summary.ready += 1;
        break;
      case "issue":
        summary.issues += 1;
        if (state.issue === "duplicate_target") summary.duplicates += 1;
        break;
      case "failed":
        summary.failed += 1;
        summary.needsTranslation += 1;
        break;
      case "translating":
        summary.translating += 1;
        break;
      case "unchanged":
        break;
      default:
        summary.needsTranslation += 1;
    }
  }
  return summary;
}

interface EntryListProps {
  rows: readonly VisibleRow[];
  states: ReadonlyMap<string, RowState>;
  summary: EntrySummary;
  modelReady: boolean;
  /** The custom name template is invalid; renaming waits until it is fixed. */
  formatInvalid: boolean;
  onAddFiles: () => void;
  onAddFolders: () => void;
}

export function EntryList({ rows, states, summary, modelReady, formatInvalid, onAddFiles, onAddFolders }: EntryListProps) {
  const { t } = useTranslation("rename");
  const roots = useNameTranslatorStore((state) => state.roots);
  const entries = useNameTranslatorStore((state) => state.entries);
  const checked = useNameTranslatorStore((state) => state.checked);
  const dirs = useNameTranslatorStore((state) => state.dirs);
  const collecting = useNameTranslatorStore((state) => state.collecting);
  const filter = useNameTranslatorStore((state) => state.filter);
  const run = useNameTranslatorStore((state) => state.run);
  const preparing = useNameTranslatorStore((state) => state.preparing);
  const applying = useNameTranslatorStore((state) => state.applying);
  const adding = useNameTranslatorStore((state) => state.adding);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const busy = applying || preparing;
  const translating = Boolean(run);
  const rootSet = useMemo(() => new Set(roots), [roots]);
  const anyCollecting = Object.keys(collecting).length > 0;

  const statesRef = useRef(states);
  statesRef.current = states;
  const actions = useMemo<EntryRowActions>(() => {
    const store = () => useNameTranslatorStore.getState();
    return {
      toggleExpanded: (path) => store().toggleExpanded(path),
      toggleChecked: (path) => store().toggleChecked(path),
      selectInside: (path, mode) => void store().selectInside(path, mode),
      startEdit: (path) => setEditingKey(path),
      commitEdit: (path, value) => {
        setEditingKey(null);
        const entry = store().entries[path];
        const current = statesRef.current.get(path)?.proposedName;
        const next = value.trim() ? value : (entry?.name ?? value);
        if (next === current) return;
        if (entry && next === entry.name && !current) return;
        store().editName(path, next);
      },
      cancelEdit: () => setEditingKey(null),
      resetName: (path) => store().resetName(path),
      retranslate: (path) => {
        store().setChecked([path], true);
        void store().translate([path]);
      },
      removeRoot: (path) => store().removeRoot(path),
    };
  }, []);

  // --- windowed rendering -------------------------------------------------
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.clientHeight || 480);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [roots.length > 0]);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(start, end);

  useEffect(() => {
    if (editingKey && !rows.some((row) => row.key === editingKey)) setEditingKey(null);
  }, [rows, editingKey]);

  const store = useCallback(() => useNameTranslatorStore.getState(), []);
  const totalEntries = roots.length;
  // Every folder that is listed is expanded (unloaded subfolders count as collapsed).
  const expandableRows = rows.filter((row) => row.expandable);
  const hasFolders = expandableRows.length > 0;
  const allExpanded = hasFolders && expandableRows.every((row) => row.expanded);
  const issueTotal = useMemo(
    () => [...states.values()].filter((state) => state.status === "issue" || state.status === "failed").length,
    [states],
  );

  const header = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" disabled={busy || totalEntries === 0 || anyCollecting} className="h-7 gap-1 px-2 text-xs">
            {anyCollecting ? <Loader2 className="animate-spin" /> : <ListChecks />}
            {t("list.select")}
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem onSelect={() => void store().selectAll("everything")}>{t("select_all.everything")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void store().selectAll("files")}>{t("select_all.files")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void store().selectAll("folders")}>{t("select_all.folders")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void store().selectAll("roots")}>{t("select_all.roots")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void store().selectAll("none")}>{t("select_all.none")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground"
            disabled={busy || translating || totalEntries === 0}
            aria-label={t("list.clear")}
            onClick={() => store().clearWorkspace()}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t("list.clear")}</TooltipContent>
      </Tooltip>
    </>
  );

  const primaryAction = (() => {
    if (translating) {
      return (
        <Button type="button" variant="outline" size="sm" onClick={() => store().stopTranslation()}>
          <Square className="size-3 fill-current" />
          {t("actions.stop")}
        </Button>
      );
    }
    const renameButton = (variant: "default" | "outline") => (
      <Button
        type="button"
        size="sm"
        variant={variant}
        data-testid="name-translator-rename"
        disabled={busy || summary.ready === 0 || formatInvalid}
        onClick={() => void store().prepareRename()}
      >
        {preparing ? <Loader2 className="animate-spin" /> : <FileStack />}
        {t("actions.rename", { count: summary.ready })}
      </Button>
    );
    if (summary.needsTranslation === 0) return renameButton("default");
    // Some entries still need translation (never translated, settings changed
    // or failed). Translating stays available, but ready entries can already
    // be renamed on their own; when only failures remain, renaming leads.
    const onlyFailures = summary.failed === summary.needsTranslation;
    const translateButton = (
      <Button
        type="button"
        size="sm"
        variant={onlyFailures && summary.ready > 0 ? "outline" : "default"}
        disabled={busy || !modelReady}
        onClick={() => void store().translate("needed")}
      >
        <Languages />
        {onlyFailures
          ? t("actions.retry_failed", { count: summary.needsTranslation })
          : t("actions.translate", { count: summary.needsTranslation })}
      </Button>
    );
    if (summary.ready === 0) return translateButton;
    return onlyFailures ? (
      <>
        {translateButton}
        {renameButton("default")}
      </>
    ) : (
      <>
        {renameButton("outline")}
        {translateButton}
      </>
    );
  })();

  const footer =
    totalEntries === 0 ? null : (
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-1.5">
        {translating && run ? (
          <div className="flex min-w-[12rem] flex-1 items-center gap-3" aria-live="polite">
            <Progress value={run.total ? (run.done / run.total) * 100 : 0} className="h-1.5 max-w-60 flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t("progress.translating", { done: run.done, total: run.total })}
            </span>
          </div>
        ) : (
          <p className="min-w-0 text-xs text-muted-foreground" aria-live="polite">
            {summary.checked === 0
              ? t("summary.none_checked")
              : t("summary.checked", { count: summary.checked })}
            {summary.checked > 0 && summary.ready > 0 ? ` · ${t("summary.ready", { count: summary.ready })}` : ""}
            {summary.failed > 0 ? (
              <span className="text-destructive"> · {t("summary.failed", { count: summary.failed })}</span>
            ) : null}
            {summary.issues > 0 ? (
              <span className="text-destructive"> · {t("summary.issues", { count: summary.issues })}</span>
            ) : null}
            {formatInvalid ? <span className="text-destructive"> · {t("summary.format_invalid")}</span> : null}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {summary.duplicates > 0 && !translating ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => store().applyNumbering()}>
              <Wand2 />
              {t("actions.number_duplicates")}
            </Button>
          ) : null}
          {!translating && summary.needsTranslation === 0 && summary.checked > 0 ? (
            <Button type="button" variant="outline" size="sm" disabled={busy || !modelReady} onClick={() => void store().translate("all")}>
              {t("actions.retranslate")}
            </Button>
          ) : null}
          {primaryAction}
        </div>
      </div>
    );

  return (
    <ToolPanel
      id="name-translator-entries"
      title={t("list.title")}
      icon={FileStack}
      badge={
        totalEntries > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 tabular-nums text-muted-foreground">
            {Object.keys(entries).length}
          </span>
        ) : undefined
      }
      actions={totalEntries > 0 ? header : undefined}
      footer={footer}
      bodyClassName="flex flex-col"
    >
      {totalEntries === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl border bg-muted/40 text-foreground/70">
            <Languages className="size-5" />
          </div>
          <div>
            <div className="text-sm font-semibold">{t("empty.title")}</div>
            <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{t("empty.description")}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={adding} onClick={onAddFiles}>
              <FilePlus2 />
              {t("add.files")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={adding} onClick={onAddFolders}>
              <FolderPlus />
              {t("add.folders")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <ClipPathTabs
              value={filter}
              onValueChange={(value) => store().setFilter(value as RowFilter)}
              ariaLabel={t("filter.label")}
              shape="rounded"
              smoothCorners
              size="sm"
              transitionDuration={200}
              transitionEasing="ease-out"
              items={[
                { value: "all", label: t("filter.all") },
                { value: "checked", label: t("filter.checked", { count: summary.checked }) },
                { value: "issues", label: t("filter.issues", { count: issueTotal }) },
              ]}
            />
          </div>
          <div
            role="row"
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_56px] gap-2 border-b px-5 py-1.5 text-[11px] font-medium text-muted-foreground"
          >
            <span role="columnheader" className="flex min-w-0 items-center">
              <Tooltip delayDuration={350}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid="name-translator-toggle-all"
                    disabled={busy || anyCollecting || !hasFolders}
                    aria-label={allExpanded ? t("list.collapse_all") : t("list.expand_all")}
                    onClick={() => (allExpanded ? store().collapseAll() : void store().expandAll())}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
                  >
                    {anyCollecting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : allExpanded ? (
                      <ChevronsDownUp className="size-3.5" />
                    ) : (
                      <ChevronsUpDown className="size-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{allExpanded ? t("list.collapse_all") : t("list.expand_all")}</TooltipContent>
              </Tooltip>
              <span className="ml-[26px] truncate">{t("list.column_name")}</span>
            </span>
            <span role="columnheader" className="pl-2">{t("list.column_new_name")}</span>
            <span role="columnheader" className="text-right">{t("list.column_status")}</span>
          </div>
          <div
            ref={viewportRef}
            role="grid"
            aria-label={t("list.title")}
            aria-rowcount={rows.length}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            className="max-h-[min(36rem,calc(100dvh-22rem))] min-h-[12rem] overflow-y-auto px-3 py-1.5"
          >
            {rows.length === 0 ? (
              <p className="px-2 py-10 text-center text-xs text-muted-foreground">{t("filter.empty")}</p>
            ) : (
              <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
                <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
                  {visible.map((row) => {
                    const entry = entries[row.key];
                    if (!entry) return null;
                    return (
                      <EntryRow
                        key={row.key}
                        row={row}
                        entry={entry}
                        state={states.get(row.key)}
                        checked={Boolean(checked[row.key])}
                        isRoot={rootSet.has(row.key)}
                        editing={editingKey === row.key}
                        collecting={Boolean(collecting[row.key])}
                        loading={dirs[row.key]?.status === "loading"}
                        busy={busy}
                        actions={actions}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </ToolPanel>
  );
}
