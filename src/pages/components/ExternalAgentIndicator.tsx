import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Bot, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useExternalAgentStore } from "@/agent/external/store";
import { useExternalConfirmationsStore } from "@/agent/external/confirmations";
import { unseenTotal, useExternalActivityStore } from "@/agent/external/activity-store";
import { toolLabel } from "@/agent/external/activity-text";
import { externalActivityPath } from "@/pages/ExternalAgentActivity/route";
import { cn } from "@/lib/utils";

const PANEL_WIDTH = 320;
const TRIGGER_HEIGHT = 28;
const SESSIONS_SHOWN = 3;
const SHELL_SPRING = { type: "spring" as const, duration: 0.38, bounce: 0 };
const CONTENT_EASE = [0.22, 1, 0.36, 1] as const;
const REST_SHADOW = "0 0px 0px 0px rgb(0 0 0 / 0)";
const OPEN_SHADOW = "0 18px 48px -16px rgb(0 0 0 / 0.35)";

/**
 * The top-right capsule: connected external agents, whether one is working or
 * waiting for a yes, and how many changes ran without asking since the activity
 * page was last open. Clicking grows it in place into a small panel with the
 * connections and a way to the activity page.
 */
export default function ExternalAgentIndicator() {
  const { t } = useTranslation("setting");
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const status = useExternalAgentStore((state) => state.status);
  const activity = useExternalAgentStore((state) => state.activity);
  const running = useExternalAgentStore((state) => state.running);
  const waitingCount = useExternalConfirmationsStore((state) => state.requests.filter((item) => item.status === "pending").length);
  const unseen = useExternalActivityStore((state) => state.unseen);
  const total = unseenTotal({ unseen });
  const sessions = status?.sessions ?? [];
  const count = sessions.length;
  const waiting = waitingCount > 0;
  const visible = count > 0 || total > 0;

  const [open, setOpen] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [triggerWidth, setTriggerWidth] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setInteractive(false);
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  // Nothing left to show: the capsule goes away, so the panel must not stay open.
  useEffect(() => { if (!visible) { setOpen(false); setInteractive(false); } }, [visible]);

  // Both sizes follow their content: the capsule's name and badges, the panel's rows.
  useLayoutEffect(() => {
    const measure = measureRef.current;
    const panel = panelRef.current;
    if (!measure || !panel) return;
    const read = () => {
      setTriggerWidth(Math.ceil(measure.getBoundingClientRect().width));
      setPanelHeight(Math.ceil(panel.getBoundingClientRect().height));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(measure); observer.observe(panel);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => { clearInterval(timer); document.removeEventListener("pointerdown", onPointer, true); document.removeEventListener("keydown", onKey, true); };
  }, [open, close]);

  // Toasts share the top-right corner: while the panel is open they make room under it.
  useEffect(() => {
    const push = open && panelHeight ? `${panelHeight - TRIGGER_HEIGHT + 8}px` : "0px";
    document.documentElement.style.setProperty("--titlebar-panel-push", push);
    return () => { document.documentElement.style.setProperty("--titlebar-panel-push", "0px"); };
  }, [open, panelHeight]);

  if (!visible) return null;

  const target = Object.entries(unseen).find(([, value]) => value > 0)?.[0] ?? (count === 1 ? sessions[0].id : undefined);
  const name = count === 1 ? sessions[0].client.name : count > 1 ? t("external_agent.activity.titlebar.connections", { count }) : null;
  const stateKey = waiting ? "state_waiting" : running ? "state_running" : count ? "state_connected" : "state_idle";
  const label = [
    count ? t("external_agent.titlebar", { count }) : null,
    total ? t("external_agent.activity.titlebar.unseen", { count: total }) : null,
    waiting ? t("external_agent.activity.titlebar.pending") : running ? t("external_agent.activity.titlebar.running") : null,
    t("external_agent.activity.titlebar.open"),
  ].filter(Boolean).join(" · ");
  const dot = (
    <span aria-hidden className="relative flex size-1.5 shrink-0">
      {(running || waiting) && !reduceMotion && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", waiting ? "bg-amber-500" : "bg-emerald-500")} />}
      <span className={cn("relative size-1.5 rounded-full", waiting ? "bg-amber-500" : count ? "bg-emerald-500" : "bg-muted-foreground/50")} />
    </span>
  );
  const triggerContent = (measuring = false) => <>
    {dot}
    {name && <span className="min-w-0 max-w-40 truncate font-mono">{name}</span>}
    {total > 0 && <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium tabular-nums text-primary-foreground"
      data-testid={measuring ? undefined : "titlebar-external-unseen"}>{total > 99 ? "99+" : total}</span>}
  </>;

  const go = (path: string) => { close(false); navigate(path); };
  const transition = reduceMotion ? { duration: 0 } : SHELL_SPRING;
  const width = open ? PANEL_WIDTH : triggerWidth || TRIGGER_HEIGHT;
  const height = open ? panelHeight || TRIGGER_HEIGHT : TRIGGER_HEIGHT;

  return (
    // The anchor keeps the capsule's place; the shell grows from its top-right corner.
    <div ref={rootRef} className="app-region-no-drag relative isolate" style={{ width: triggerWidth || TRIGGER_HEIGHT, height: TRIGGER_HEIGHT }}
      data-testid="titlebar-external-agent-root" data-open={open || undefined}>
      {/* The shell's border is part of its size, so the copy has one too. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute right-0 top-0 flex h-7 w-max items-center gap-1.5 border border-transparent px-2.5 text-xs">{triggerContent(true)}</div>

      <motion.div
        className={cn("absolute right-0 top-0 overflow-hidden border bg-background/60 backdrop-blur-md transition-colors duration-200",
          open || hovered ? "border-border/80" : "border-border/40")}
        initial={false}
        animate={{ width, height, borderRadius: open ? 16 : 14, boxShadow: open ? OPEN_SHADOW : REST_SHADOW }}
        transition={transition}
        onAnimationComplete={() => { if (open) setInteractive(true); }}
        onHoverStart={() => setHovered(true)} onHoverEnd={() => setHovered(false)}
      >
        {/* Hover tints the capsule; the panel's own surface fades in over the glass as it grows. */}
        <motion.div aria-hidden className="pointer-events-none absolute inset-0 bg-muted" initial={false}
          animate={{ opacity: hovered && !open ? 1 : 0 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: CONTENT_EASE }} />
        <motion.div aria-hidden className="pointer-events-none absolute inset-0 bg-popover" initial={false}
          animate={{ opacity: open ? 0.96 : 0 }} transition={reduceMotion ? { duration: 0 } : { duration: open ? 0.24 : 0.2, ease: CONTENT_EASE }} />

        <AnimatePresence initial={false}>
          {!open && (
            <motion.button key="trigger" ref={triggerRef} type="button" aria-label={label} title={label}
              aria-expanded={false} aria-haspopup="dialog" data-testid="titlebar-external-agent"
              data-state={waiting ? "waiting" : running ? "running" : count ? "connected" : "idle"}
              className="absolute right-0 top-0 flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full bg-transparent px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setInteractive(false); setOpen(true); }}
              initial={reduceMotion ? false : { opacity: 0, x: 4, y: -4 }}
              animate={{ opacity: 1, x: 0, y: 0, transition: reduceMotion ? { duration: 0 } : { duration: 0.18, delay: 0.12, ease: CONTENT_EASE } }}
              exit={{ opacity: 0, x: -4, y: 4, transition: reduceMotion ? { duration: 0 } : { duration: 0.12, ease: CONTENT_EASE } }}
              whileTap={reduceMotion ? undefined : { scale: 0.96 }}>
              {triggerContent()}
            </motion.button>
          )}
        </AnimatePresence>

        {/* Always mounted so its height is known before the first open; hidden from input until the shell has grown. */}
        <motion.div ref={panelRef} role="dialog" aria-label={t("external_agent.activity.titlebar.panel_title")} data-testid="titlebar-external-panel"
          className="absolute right-0 top-0 text-[13px]" style={{ width: PANEL_WIDTH - 2 }}
          initial={false}
          animate={{ opacity: open ? 1 : 0, x: open ? 0 : 6, y: open ? 0 : -8 }}
          transition={reduceMotion ? { duration: 0 } : { duration: open ? 0.22 : 0.14, delay: open ? 0.06 : 0, ease: CONTENT_EASE }}
          inert={!interactive || undefined} aria-hidden={!open || undefined}>
          <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-smooth-md border bg-muted/50 text-muted-foreground"><Bot className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="font-medium leading-5">{t("external_agent.activity.titlebar.panel_title")}</div>
              <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                {dot}
                <span className={cn("shrink-0", waiting && "text-amber-600 dark:text-amber-400")}>{t(`external_agent.activity.titlebar.${stateKey}`)}</span>
                {status && <span className="min-w-0 truncate">· {t("external_agent.activity.trust_now", { trust: t(`external_agent.trust.${status.trust}.name`) })}</span>}
              </div>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" className="-mr-1.5 -mt-0.5 text-muted-foreground hover:text-foreground" aria-label={t("external_agent.activity.titlebar.close")}
              data-testid="titlebar-external-close" onClick={() => close()}><X /></Button>
          </div>

          {waiting && (
            <div className="mx-3.5 mb-2 rounded-smooth-md bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-700 dark:text-amber-300" data-testid="titlebar-external-waiting">
              {t("external_agent.activity.titlebar.waiting", { count: waitingCount })}
            </div>
          )}

          {count > 0 && (
            <div className="mx-2 space-y-0.5 border-t pt-1.5">
              {sessions.slice(0, SESSIONS_SHOWN).map((session) => {
                const last = activity[session.id]?.at(-1);
                const minutes = Math.max(0, Math.floor((now - session.connectedAt) / 60_000));
                return (
                  <button key={session.id} type="button" className="flex w-full min-w-0 items-start gap-2.5 rounded-smooth-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    data-testid="titlebar-external-session" onClick={() => go(externalActivityPath(session.id))}>
                    <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-emerald-500" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate font-mono text-[12.5px]">{session.client.name}</span>
                        {session.client.version && <span className="shrink-0 text-[11px] text-muted-foreground">{session.client.version}</span>}
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                          {minutes ? t("external_agent.sessions.connected_minutes", { count: minutes }) : t("external_agent.sessions.connected_now")}
                        </span>
                      </span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {last ? <>{t("external_agent.sessions.last", { tool: toolLabel(t, last.tool) })} <span className={last.ok ? "" : "text-destructive"}>
                          {last.ok ? t("external_agent.sessions.ok") : t("external_agent.sessions.failed", { error: last.error ?? "" })}</span></> : t("external_agent.activity.titlebar.no_calls")}
                      </span>
                    </span>
                  </button>
                );
              })}
              {count > SESSIONS_SHOWN && <div className="px-1.5 pb-1 text-[11.5px] text-muted-foreground">{t("external_agent.activity.titlebar.more", { count: count - SESSIONS_SHOWN })}</div>}
            </div>
          )}

          <div className="mt-1.5 flex items-center gap-1.5 border-t px-2.5 py-2.5">
            <Button type="button" size="sm" className="h-8 flex-1 justify-between gap-2" data-testid="titlebar-external-open" onClick={() => go(externalActivityPath(target))}>
              <span className="flex min-w-0 items-center gap-1.5">
                {t("external_agent.activity.titlebar.view_activity")}
                {total > 0 && <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[10.5px] tabular-nums">{t("external_agent.activity.titlebar.unseen", { count: total })}</span>}
              </span>
              <ArrowRight className="size-3.5" />
            </Button>
            <Button type="button" variant="outline" size="icon-sm" className="size-8 text-muted-foreground hover:text-foreground" aria-label={t("external_agent.activity.titlebar.settings")} title={t("external_agent.activity.titlebar.settings")}
              data-testid="titlebar-external-settings" onClick={() => go("/setting?tab=external")}><Settings2 /></Button>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
