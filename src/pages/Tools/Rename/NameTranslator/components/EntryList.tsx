import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronDown, ChevronsDownUp, ChevronsUpDown, CircleHelp, FileStack, FilePlus2, FolderPlus, Languages, ListChecks, Loader2, Square, Trash2, Wand2 } from "lucide-react";
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
import { actionTargets, clickSelection, rangeKeys } from "@/services/name-translation/selection";
import useNameTranslatorStore from "@/store/tools/rename/useNameTranslatorStore";
import { EntryMenuContent } from "./EntryMenu";
import { EntryRow, ROW_HEIGHT, type EntryRowActions } from "./EntryRow";
import { useRowSelection } from "./useRowSelection";

const OVERSCAN = 8;
/** Name / new name / status. The name column gets most of the width until there are new names to show. */
const COLUMNS_WITH_NEW_NAMES = "minmax(0,1fr) minmax(0,1fr) 56px";
const COLUMNS_NAMES_ONLY = "minmax(0,2.4fr) minmax(0,1fr) 56px";

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

const HELP_ITEMS = ["select", "marquee", "space", "range", "menu", "edit", "arrows", "escape"] as const;

/** Help icon at the end of the footer summary: the list's mouse and keyboard shortcuts. */
function ListHelp() {
  const { t } = useTranslation("rename");
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("list.help.label")}
          data-testid="name-translator-help"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <CircleHelp className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" sideOffset={6} className="max-w-[min(22rem,calc(100vw-2rem))] px-3 py-2.5 text-left [text-wrap:wrap]">
        <div className="mb-1.5 text-[12px] font-medium">{t("list.help.label")}</div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-[11.5px] leading-4">
          {HELP_ITEMS.map((item) => (
            <div key={item} className="contents">
              <dt className="whitespace-nowrap text-[11px] text-background/65">{t(`list.help.${item}.keys`)}</dt>
              <dd>{t(`list.help.${item}.desc`)}</dd>
            </div>
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
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
  const translationWarning = useNameTranslatorStore((state) => state.translationWarning);
  const preparing = useNameTranslatorStore((state) => state.preparing);
  const applying = useNameTranslatorStore((state) => state.applying);
  const adding = useNameTranslatorStore((state) => state.adding);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const busy = applying || preparing;
  const translating = Boolean(run);
  const anyCollecting = Object.keys(collecting).length > 0;

  const statesRef = useRef(states);
  statesRef.current = states;
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ targets: string[]; x: number; y: number; serial: number } | null>(null);
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;

  const focusList = useCallback(() => {
    // After an inline edit or a menu closes, keyboard selection continues in the list.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) viewportRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const rowSelection = useRowSelection({
    rows,
    rowHeight: ROW_HEIGHT,
    viewportRef,
    contentRef,
    toggleChecked: (keys) => {
      const store = useNameTranslatorStore.getState();
      if (store.applying || store.preparing) return;
      store.setChecked(keys, !keys.every((key) => store.checked[key]));
    },
    edit: (key) => setEditingKey(key),
    setExpanded: (key, expanded) => {
      if (Boolean(useNameTranslatorStore.getState().expanded[key]) !== expanded) useNameTranslatorStore.getState().toggleExpanded(key);
    },
    openMenu: (targets, point) => setMenu((current) => ({ targets, ...point, serial: (current?.serial ?? lastMenu.current?.serial ?? 0) + 1 })),
  });
  const { selection, selectionRef, orderRef, commit: commitSelection } = rowSelection;

  const actions = useMemo<EntryRowActions>(() => {
    const store = () => useNameTranslatorStore.getState();
    return {
      toggleExpanded: (path) => store().toggleExpanded(path),
      clickCheckbox: (path, range) => {
        const current = selectionRef.current;
        const order = orderRef.current;
        const next = !store().checked[path];
        if (range && current.anchor && order.includes(current.anchor)) {
          store().setChecked(rangeKeys(order, current.anchor, path), next);
        } else if (current.keys.has(path) && current.keys.size > 1) {
          // A checkbox inside a multi-row selection checks the whole selection.
          store().setChecked(actionTargets(current, order, path), next);
        } else {
          store().toggleChecked(path);
        }
        commitSelection({ ...current, anchor: path, lead: path });
      },
      selectInside: (path, mode) => void store().selectInside(path, mode),
      startEdit: (path) => setEditingKey(path),
      commitEdit: (path, value) => {
        setEditingKey(null);
        focusList();
        const entry = store().entries[path];
        const current = statesRef.current.get(path)?.proposedName;
        const next = value.trim() ? value : (entry?.name ?? value);
        if (next === current) return;
        if (entry && next === entry.name && !current) return;
        store().editName(path, next);
      },
      cancelEdit: () => {
        setEditingKey(null);
        focusList();
      },
      menuTargets: (path) => actionTargets(selectionRef.current, orderRef.current, path),
      prepareMenu: (path) => {
        if (!selectionRef.current.keys.has(path)) {
          commitSelection(clickSelection(selectionRef.current, orderRef.current, path, { toggle: false, range: false }));
        }
      },
    };
  }, [commitSelection, focusList, orderRef, selectionRef]);

  // --- windowed rendering -------------------------------------------------
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
  // Widen the name column while there are no new names yet, so more of each
  // original name is visible while choosing what to rename.
  const hasNewNames = useMemo(
    () => [...states.values()].some((state) => state.proposedName !== undefined || state.status === "translating"),
    [states],
  );
  const columns = hasNewNames || editingKey ? COLUMNS_WITH_NEW_NAMES : COLUMNS_NAMES_ONLY;
  const selectedCount = selection.keys.size;
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
          // Short status on the left, actions on the right; details live in tooltips.
          <div className="flex min-w-[10rem] flex-1 items-center gap-1">
            <p className="min-w-0 truncate text-xs text-muted-foreground" aria-live="polite">
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
              {selectedCount > 1 ? (
                <span className="text-sky-700 dark:text-sky-300" data-testid="name-translator-selected-rows">
                  {" "}· {t("list.selected_rows", { count: selectedCount })}
                </span>
              ) : null}
            </p>
            {summary.failed > 0 && translationWarning ? (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t(`errors.${translationWarning.code}`, { defaultValue: t("errors.internal") })}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-destructive/80 outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <AlertCircle className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="max-w-[min(22rem,calc(100vw-2rem))] text-left [text-wrap:wrap]">
                  <div className="font-medium">{t(`errors.${translationWarning.code}`, { defaultValue: t("errors.internal") })}</div>
                  {translationWarning.message ? (
                    <div className="mt-0.5 text-[11px] text-background/65 [overflow-wrap:anywhere]">{translationWarning.message}</div>
                  ) : null}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <ListHelp />
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
        <div className="contents" style={{ "--nt-cols": columns } as CSSProperties}>
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
            className="grid grid-cols-[var(--nt-cols)] gap-2 border-b px-5 py-1.5 text-[11px] font-medium text-muted-foreground transition-[grid-template-columns] duration-200 ease-out"
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
            tabIndex={0}
            aria-label={t("list.title")}
            aria-rowcount={rows.length}
            aria-multiselectable="true"
            data-keyboard={rowSelection.keyboardNav}
            {...rowSelection.viewportProps}
            onScroll={(event) => {
              setScrollTop(event.currentTarget.scrollTop);
              rowSelection.viewportProps.onScroll();
            }}
            className="group/grid max-h-[min(36rem,calc(100dvh-22rem))] min-h-[12rem] select-none overflow-y-auto px-3 py-1.5 outline-none"
          >
            {rows.length === 0 ? (
              <p className="px-2 py-10 text-center text-xs text-muted-foreground">{t("filter.empty")}</p>
            ) : (
              <div ref={contentRef} style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
                <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
                  {visible.map((row, offset) => {
                    const entry = entries[row.key];
                    if (!entry) return null;
                    const index = start + offset;
                    const selected = selection.keys.has(row.key);
                    return (
                      <EntryRow
                        key={row.key}
                        row={row}
                        entry={entry}
                        state={states.get(row.key)}
                        checked={Boolean(checked[row.key])}
                        selected={selected}
                        joinTop={selected && index > 0 && selection.keys.has(rows[index - 1]!.key)}
                        joinBottom={selected && index < rows.length - 1 && selection.keys.has(rows[index + 1]!.key)}
                        lead={rowSelection.keyboardNav && selection.lead === row.key}
                        editing={editingKey === row.key}
                        collecting={Boolean(collecting[row.key])}
                        loading={dirs[row.key]?.status === "loading"}
                        busy={busy}
                        modelReady={modelReady}
                        actions={actions}
                      />
                    );
                  })}
                </div>
                {rowSelection.marquee ? (
                  <div
                    aria-hidden="true"
                    data-testid="name-translator-marquee"
                    className="pointer-events-none absolute z-10 rounded-[3px] border border-sky-500/60 bg-sky-500/10 dark:border-sky-400/60 dark:bg-sky-400/10"
                    style={rowSelection.marquee}
                  />
                ) : null}
              </div>
            )}
          </div>
          <DropdownMenu
            key={menu?.serial ?? lastMenu.current?.serial ?? 0}
            open={Boolean(menu)}
            modal={false}
            onOpenChange={(open) => {
              if (!open) setMenu(null);
            }}
          >
            {createPortal(
              <DropdownMenuTrigger
                tabIndex={-1}
                aria-hidden="true"
                style={{
                  position: "fixed",
                  left: (menu ?? lastMenu.current)?.x ?? 0,
                  top: (menu ?? lastMenu.current)?.y ?? 0,
                  width: 1,
                  height: 1,
                  opacity: 0,
                  pointerEvents: "none",
                }}
              />,
              document.body,
            )}
            <EntryMenuContent
              align="start"
              side="bottom"
              sideOffset={2}
              collisionPadding={8}
              className="min-w-52"
              data-testid="name-translator-context-menu"
              getTargets={() => (menu ?? lastMenu.current)?.targets ?? []}
              modelReady={modelReady}
              onEdit={(path) => setEditingKey(path)}
              restoreFocus={() => viewportRef.current?.focus({ preventScroll: true })}
            />
          </DropdownMenu>
        </div>
      )}
    </ToolPanel>
  );
}
