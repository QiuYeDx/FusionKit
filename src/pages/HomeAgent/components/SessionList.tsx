import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { smoothCorners } from "@qiuyedx/smooth-corners";
import { Loader2, MoreHorizontal, Pencil, Pin, PinOff, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import useAgentStore from "@/store/agent/useAgentStore";
import { groupSessions, type SessionGroupKey } from "@/agent/session-list";
import { deleteSession, exportSessionById, openSession, renameSession, setSessionPinned, useSessionPersistenceStore } from "@/agent/session-persistence";
import type { AgentSessionMeta } from "@/agent/types";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ROW_CORNERS = smoothCorners(10, 0.72) as CSSProperties;
const GROUP_LABELS: Record<SessionGroupKey, string> = {
  pinned: "home:sessions_group_pinned",
  today: "home:sessions_group_today",
  yesterday: "home:sessions_group_yesterday",
  week: "home:sessions_group_week",
  earlier: "home:sessions_group_earlier",
};

export type SessionListVariant = "sidebar" | "compact";

/** What a row shows besides its title: a reply running, or one the user has not seen. */
type RowState = "running" | "unread" | undefined;

function useRowStates(): Record<string, RowState> {
  return useAgentStore(useShallow((state) => Object.fromEntries(Object.entries(state.slots).flatMap(([id, slot]): [string, RowState][] =>
    slot.isStreaming ? [[id, "running"]] : slot.unread ? [[id, "unread"]] : []))));
}

export function sessionDisplayTitle(meta: Pick<AgentSessionMeta, "title" | "preview">, untitled: string): string {
  return meta.title || meta.preview || untitled;
}

/** Whether any session but the shown one is replying or has a reply the user has not seen. */
export function useOtherSessionsActivity(): RowState {
  return useAgentStore((state) => {
    let result: RowState;
    for (const [id, slot] of Object.entries(state.slots)) {
      if (id === state.activeSessionId) continue;
      if (slot.isStreaming) return "running";
      if (slot.unread) result = "unread";
    }
    return result;
  });
}

function StateMark({ state, className }: { state: RowState | "loading"; className?: string }) {
  const { t } = useTranslation();
  if (state === "running" || state === "loading") {
    return <Loader2 aria-label={t(state === "running" ? "home:sessions_running" : "home:sessions_loading")} role="img"
      className={cn("size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none", className)} />;
  }
  if (state === "unread") return <span role="img" aria-label={t("home:sessions_unread")} className={cn("size-1.5 rounded-full bg-primary", className)} />;
  return null;
}

/** Shows the full title only when the row cuts it short. */
function RowTooltip({ title, children }: { title: string; children: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLElement | null>(null);
  return <Tooltip delayDuration={500} open={open} onOpenChange={(next) => {
    const text = holder.current?.querySelector<HTMLElement>("[data-session-title]");
    setOpen(next && !!text && text.scrollWidth > text.clientWidth);
  }}>
    <TooltipTrigger asChild ref={holder as never}>{children}</TooltipTrigger>
    <TooltipContent side="right" align="start" sideOffset={8} className="max-w-72 [overflow-wrap:anywhere]">{title}</TooltipContent>
  </Tooltip>;
}

function RenameField({ initial, label, onDone }: { initial: string; label: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => { if (done.current) return; done.current = true; onDone(title); };
  return <Input autoFocus aria-label={label} value={value} data-testid="agent-session-rename"
    onFocus={(event) => event.currentTarget.select()}
    onChange={(event) => setValue(event.target.value)}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); finish(value); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); }
    }}
    onBlur={() => finish(value)}
    style={ROW_CORNERS}
    className="smooth-corners h-8 rounded-[10px] px-2.5 text-[13px] md:text-[13px] shadow-none" />;
}

function SessionRow({ meta, variant, active, state, loading, onPick, onRename, onDelete, editing, onEditDone }: {
  meta: AgentSessionMeta; variant: SessionListVariant; active: boolean; state: RowState; loading: boolean;
  onPick: (id: string) => void; onRename: (id: string) => void; onDelete: (meta: AgentSessionMeta) => void;
  editing: boolean; onEditDone: (title: string | null) => void;
}) {
  const { t } = useTranslation();
  const title = sessionDisplayTitle(meta, t("home:sessions_untitled"));
  const compact = variant === "compact";
  const [menuOpen, setMenuOpen] = useState(false);
  const mark: RowState | "loading" = loading ? "loading" : state;
  const exportRow = async () => {
    const result = await exportSessionById(meta.id);
    if (!result.success && !result.cancelled) toast.error(t("home:export_error_save"));
  };
  if (editing) return <li className="py-px"><RenameField initial={meta.title || title} label={t("home:sessions_rename_label")} onDone={onEditDone} /></li>;
  return (
    <li className="group/row relative" data-session-item={meta.id}>
      <RowTooltip title={title}>
        <button
          type="button"
          data-session-row
          data-session-id={meta.id}
          data-session-state={meta.unreadable ? "unreadable" : mark ?? "idle"}
          aria-current={active ? "true" : undefined}
          aria-label={meta.unreadable ? `${title} · ${t("home:sessions_unreadable")}` : undefined}
          disabled={meta.unreadable}
          onClick={() => onPick(meta.id)}
          style={ROW_CORNERS}
          className={cn(
            "smooth-corners flex w-full min-w-0 items-center rounded-[10px] text-left outline-none transition-colors duration-150",
            "focus-visible:ring-2 focus-visible:ring-ring/50",
            compact ? "h-[30px] pl-2.5 pr-7 text-[13px]" : "h-8 pl-2.5 pr-8 text-[13px]",
            active ? "bg-accent font-medium text-foreground" : "text-foreground/80 hover:bg-accent/60 hover:text-foreground",
            meta.unreadable && "cursor-default text-muted-foreground/60 hover:bg-transparent",
          )}
        >
          <span data-session-title className="min-w-0 flex-1 truncate">{title}</span>
          {meta.unreadable && <span className="ml-2 shrink-0 text-[11px] text-muted-foreground/70">{t("home:sessions_unreadable")}</span>}
        </button>
      </RowTooltip>
      {/* One fixed slot at the end: the state mark, replaced by the menu while the row is hovered or focused. */}
      <span className={cn("pointer-events-none absolute top-1/2 flex size-5 -translate-y-1/2 items-center justify-center", compact ? "right-1.5" : "right-1.5")}>
        <StateMark state={mark} className={cn(!compact && "transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0", menuOpen && "opacity-0")} />
      </span>
      {!compact && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("home:sessions_more")} data-testid="agent-session-menu"
              className={cn("absolute top-1/2 right-1 size-6 -translate-y-1/2 rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground",
                "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100")}>
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" sideOffset={6} className="min-w-40">
            {!meta.unreadable && <>
              <DropdownMenuItem onSelect={() => onRename(meta.id)}><Pencil />{t("home:sessions_rename")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void setSessionPinned(meta.id, !meta.pinned)}>
                {meta.pinned ? <PinOff /> : <Pin />}{t(meta.pinned ? "home:sessions_unpin" : "home:sessions_pin")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportRow()}><Upload />{t("home:sessions_export")}</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>}
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(meta)}><Trash2 />{t("home:sessions_delete")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/**
 * Saved conversations grouped by day, pinned first. The sidebar variant also renames, pins, exports and
 * deletes; the compact variant in the floating panel only finds and opens a session.
 */
export function SessionList({ variant = "sidebar", query = "", onPicked, className }: {
  variant?: SessionListVariant;
  query?: string;
  onPicked?: (id: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const catalog = useAgentStore((state) => state.catalog);
  const activeId = useAgentStore((state) => state.activeSessionId);
  const states = useRowStates();
  const loading = useSessionPersistenceStore((state) => state.loading);
  const groups = useMemo(() => groupSessions(Object.values(catalog), Date.now(), query), [catalog, query]);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AgentSessionMeta | null>(null);
  const deletingRunning = useAgentStore((state) => !!deleting && !!state.slots[deleting.id]?.isStreaming);
  const listRef = useRef<HTMLDivElement>(null);

  const pick = (id: string) => {
    void openSession(id).then((opened) => {
      if (!opened) { toast.error(t("home:sessions_open_failed")); return; }
      onPicked?.(id);
    });
  };
  // Up and Down move between rows, as in a list box; Tab still reaches each row's menu.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-session-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 && !rows.length) return;
    event.preventDefault();
    const next = index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  };

  if (!groups.length) {
    // Padded like a row, so the text lines up with the titles and the search field.
    return <div className={className}>
      <p className="px-2.5 py-2 text-xs leading-5 text-muted-foreground" data-testid="agent-sessions-empty">
        {t(query.trim() ? "home:sessions_no_match" : "home:sessions_empty")}
      </p>
    </div>;
  }
  const deletingTitle = deleting ? sessionDisplayTitle(deleting, t("home:sessions_untitled")) : "";
  return (
    <div ref={listRef} className={cn("space-y-3", className)} onKeyDown={onKeyDown} data-testid={`agent-sessions-list-${variant}`}>
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`agent-sessions-${variant}-${group.key}`}>
          <h3 id={`agent-sessions-${variant}-${group.key}`} className="mb-1 px-2.5 text-[11px] font-medium leading-5 text-muted-foreground">{t(GROUP_LABELS[group.key])}</h3>
          <ul className="space-y-0.5">
            {group.sessions.map((meta) => (
              <SessionRow key={meta.id} meta={meta} variant={variant} active={meta.id === activeId} state={states[meta.id]} loading={!!loading[meta.id]}
                onPick={pick} onRename={setEditing} onDelete={setDeleting} editing={editing === meta.id}
                onEditDone={(title) => {
                  setEditing(null);
                  if (title !== null && title.trim() && title.trim() !== meta.title) void renameSession(meta.id, title);
                  requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-session-id="${meta.id}"]`)?.focus());
                }} />
            ))}
          </ul>
        </section>
      ))}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t("home:sessions_delete_title")}
        description={`${t("home:sessions_delete_description", { title: deletingTitle })}${deletingRunning ? ` ${t("home:sessions_delete_running")}` : ""}`}
        confirmText={t("home:sessions_delete_confirm")}
        cancelText={t("home:sessions_cancel")}
        onConfirm={() => { if (deleting) void deleteSession(deleting.id); }}
      />
    </div>
  );
}
