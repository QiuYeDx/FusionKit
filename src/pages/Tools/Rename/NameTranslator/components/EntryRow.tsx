import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  File,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  Minus,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { NameEntry } from "@/name-translation/contract";
import type { RowState, VisibleRow } from "@/services/name-translation/workspace";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SelectInsideMode } from "@/store/tools/rename/useNameTranslatorStore";
import { EntryMenuContent } from "./EntryMenu";
import { NameText } from "./NameText";

export const ROW_HEIGHT = 34;
const INDENT = 18;

/** Marks controls that keep their own click behaviour (no row selection or marquee). */
export const ROW_CONTROL_ATTR = "data-row-control";
const control = { [ROW_CONTROL_ATTR]: "" };

export interface EntryRowActions {
  toggleExpanded: (path: string) => void;
  /** Checkbox click; Shift checks a range, a multi-row selection is checked together. */
  clickCheckbox: (path: string, range: boolean) => void;
  selectInside: (path: string, mode: SelectInsideMode) => void;
  startEdit: (path: string) => void;
  commitEdit: (path: string, value: string) => void;
  cancelEdit: () => void;
  /** Rows a menu opened on `path` applies to (the selection when the row is in it). */
  menuTargets: (path: string) => string[];
  /** Selects the row before its menu opens unless it is already selected. */
  prepareMenu: (path: string) => void;
}

interface EntryRowProps {
  row: VisibleRow;
  entry: NameEntry;
  state: RowState | undefined;
  checked: boolean;
  selected: boolean;
  /** The previous / next row is selected too: square the shared edge. */
  joinTop: boolean;
  joinBottom: boolean;
  /** Keyboard focus row of the list. */
  lead: boolean;
  editing: boolean;
  collecting: boolean;
  loading: boolean;
  busy: boolean;
  modelReady: boolean;
  actions: EntryRowActions;
}

function parentPath(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return "";
  // Keep the separator of a drive or filesystem root (C:\ or /).
  return index === 0 || path[index - 1] === ":" ? path.slice(0, index + 1) : path.slice(0, index);
}

const hasModifier = (event: MouseEvent) => event.ctrlKey || event.metaKey || event.shiftKey;

function StatusIcon({ state, checked }: { state: RowState | undefined; checked: boolean }) {
  const { t } = useTranslation("rename");
  if (!state || (!checked && state.status === "idle")) return null;
  const status = state.status;
  const config = {
    idle: null,
    pending: { icon: CircleDashed, className: "text-muted-foreground/70", label: t("status.pending") },
    translating: { icon: Loader2, className: "animate-spin text-muted-foreground", label: t("status.translating") },
    stale: { icon: RefreshCw, className: "text-amber-600 dark:text-amber-400", label: t("status.stale") },
    failed: { icon: XCircle, className: "text-destructive", label: t("status.failed") },
    unchanged: { icon: Minus, className: "text-muted-foreground/70", label: t("status.unchanged") },
    issue: {
      icon: AlertTriangle,
      className: "text-destructive",
      label: state.issue ? t(`issues.${state.issue}`) : t("status.issue"),
    },
    ready: { icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400", label: t("status.ready") },
  }[status];
  if (!config) return null;
  const Icon = config.icon;
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={config.label}
          tabIndex={status === "issue" || status === "failed" ? 0 : -1}
          className="inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-status={status}
        >
          <Icon className={cn("size-3.5", config.className)} />
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={6} className="max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal text-wrap">
        {config.label}
      </TooltipContent>
    </Tooltip>
  );
}

function NameEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("rename");
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the part before the extension, like file managers do.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      // Consume Escape so the page does not navigate back (FK-PIT-0164).
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  return (
    <input
      ref={inputRef}
      {...control}
      value={value}
      aria-label={t("list.edit_name")}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      className="h-7 w-full min-w-0 rounded-md border border-ring/60 bg-background px-2 text-[13px] outline-none ring-2 ring-ring/20"
    />
  );
}

function EntryRowComponent({
  row,
  entry,
  state,
  checked,
  selected,
  joinTop,
  joinBottom,
  lead,
  editing,
  collecting,
  loading,
  busy,
  modelReady,
  actions,
}: EntryRowProps) {
  const { t } = useTranslation("rename");
  const isDirectory = entry.kind === "directory";
  const KindIcon = entry.symlink ? Link2 : isDirectory ? (row.expanded ? FolderOpen : Folder) : File;
  const proposed = state?.proposedName;
  const showProposal = proposed !== undefined && state?.status !== "translating";
  const dimmed = !checked;

  const renderNewName = () => {
    if (editing) {
      return (
        <NameEditor
          initial={proposed ?? entry.name}
          onCommit={(value) => actions.commitEdit(entry.path, value)}
          onCancel={actions.cancelEdit}
        />
      );
    }
    let content: ReactNode;
    if (state?.status === "translating") {
      content = <span className="h-3 w-2/3 animate-pulse rounded bg-muted" aria-label={t("status.translating")} />;
    } else if (showProposal && state?.status === "unchanged") {
      content = <span className="truncate text-muted-foreground">{t("list.unchanged")}</span>;
    } else if (showProposal) {
      content = (
        <NameText
          name={proposed}
          className={cn(
            state?.status === "issue" && "text-destructive",
            state?.status === "stale" && "text-muted-foreground line-through decoration-muted-foreground/50",
          )}
        />
      );
    } else if (checked) {
      content = <span className="text-muted-foreground/60">—</span>;
    } else {
      content = null;
    }
    // A plain click edits; with Ctrl/Shift the click only changes the row selection.
    return (
      <button
        type="button"
        disabled={busy}
        onClick={(event) => {
          if (!hasModifier(event)) actions.startEdit(entry.path);
        }}
        className={cn(
          "group/name flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[13px] outline-none transition-shadow hover:shadow-[inset_0_0_0_1px_var(--border)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none",
          dimmed && "opacity-55",
        )}
        aria-label={t("list.edit_name_for", { name: entry.name })}
      >
        {content}
        {state?.edited ? <PencilLine aria-label={t("list.edited")} className="size-3 shrink-0 text-muted-foreground" /> : null}
      </button>
    );
  };

  const canSelectInside = isDirectory && !entry.symlink;

  return (
    <div
      role="row"
      data-path={entry.path}
      data-selected={selected}
      data-lead={lead}
      aria-selected={selected}
      className={cn(
        // One surface owns hover and selection (FK-PIT-0129); the select-inside
        // overlay reuses --nt-row-hover so it always matches the row behind it.
        "group/row grid h-[34px] grid-cols-[var(--nt-cols)] items-center gap-2 rounded-md px-2 transition-[background-color,grid-template-columns] duration-200 ease-out",
        "bg-[var(--nt-row-bg)] [--nt-row-bg:transparent] [--nt-row-hover:color-mix(in_oklch,var(--muted)_60%,var(--card))] hover:bg-[var(--nt-row-hover)] focus-within:bg-[var(--nt-row-hover)]",
        "data-[selected=true]:[--nt-row-bg:color-mix(in_oklab,oklch(68.5%_0.169_237.3)_13%,var(--card))] data-[selected=true]:[--nt-row-hover:color-mix(in_oklab,oklch(68.5%_0.169_237.3)_19%,var(--card))]",
        "dark:data-[selected=true]:[--nt-row-bg:color-mix(in_oklab,oklch(74.6%_0.16_232.7)_17%,var(--card))] dark:data-[selected=true]:[--nt-row-hover:color-mix(in_oklab,oklch(74.6%_0.16_232.7)_24%,var(--card))]",
        "group-focus/grid:data-[lead=true]:shadow-[inset_0_0_0_1px_var(--ring)]",
        joinTop && "rounded-t-none",
        joinBottom && "rounded-b-none",
      )}
    >
      <div
        role="gridcell"
        className="relative flex min-w-0 items-center gap-1.5"
        style={{ paddingLeft: row.depth * INDENT }}
        onDoubleClick={(event) => {
          if (row.expandable && !hasModifier(event) && !(event.target as Element).closest(`[${ROW_CONTROL_ATTR}]`)) {
            actions.toggleExpanded(entry.path);
          }
        }}
      >
        {row.expandable ? (
          <button
            type="button"
            {...control}
            onClick={() => actions.toggleExpanded(entry.path)}
            aria-label={row.expanded ? t("list.collapse") : t("list.expand")}
            aria-expanded={row.expanded}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ChevronRight className={cn("size-3.5 transition-transform duration-150", row.expanded && "rotate-90")} />
            )}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <Checkbox
          {...control}
          checked={checked}
          disabled={busy}
          onClick={(event) => {
            // Handled here (not onCheckedChange) to read Shift for range checks.
            event.preventDefault();
            actions.clickCheckbox(entry.path, event.shiftKey);
          }}
          aria-label={t("list.check_entry", { name: entry.name })}
        />
        <KindIcon className={cn("size-3.5 shrink-0", isDirectory ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground")} />
        <NameText name={entry.name} detail={parentPath(entry.path)} className={cn("text-[13px]", dimmed && !checked && "text-foreground/80")} />
        {canSelectInside && row.loadedInside > 0 ? (
          <span className="min-w-0 shrink-[2] truncate rounded-full bg-muted px-1.5 text-[11px] leading-4 tabular-nums text-muted-foreground">
            {t("list.inside_count", { checked: row.checkedInside, total: row.loadedInside })}
          </span>
        ) : null}
        {canSelectInside ? (
          // Overlays the end of the name cell without taking layout space. The
          // backdrop is the opaque row-hover colour with a fade on its left edge,
          // so it cleanly covers the count chip or a long name underneath.
          <span
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 flex items-center pl-6 opacity-0 transition-opacity duration-150 [background:linear-gradient(to_right,transparent,var(--nt-row-hover)_1.25rem)] group-hover/row:opacity-100 group-focus-within/row:opacity-100",
              collecting && "opacity-100",
            )}
          >
            <button
              type="button"
              {...control}
              disabled={busy || collecting}
              onClick={() => actions.selectInside(entry.path, "all")}
              className={cn(
                "pointer-events-none inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-2 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:border-border hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 group-hover/row:pointer-events-auto group-focus-within/row:pointer-events-auto",
              )}
            >
              {collecting ? <Loader2 className="size-3 animate-spin" /> : null}
              {t("list.select_inside")}
            </button>
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="min-w-0">
        {renderNewName()}
      </div>
      <div role="gridcell" className="flex items-center justify-end gap-0.5">
        <StatusIcon state={state} checked={checked} />
        <DropdownMenu onOpenChange={(open) => open && actions.prepareMenu(entry.path)}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              {...control}
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              aria-label={t("list.row_menu", { name: entry.name })}
              className="text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <EntryMenuContent
            align="end"
            className="min-w-52"
            getTargets={() => actions.menuTargets(entry.path)}
            modelReady={modelReady}
            onEdit={actions.startEdit}
          />
        </DropdownMenu>
      </div>
    </div>
  );
}

export const EntryRow = memo(EntryRowComponent);
