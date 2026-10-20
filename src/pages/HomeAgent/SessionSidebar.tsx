import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { animate, AnimatePresence, motion } from "motion/react";
import { MessagesSquare, PanelLeftClose, Search, SquarePen } from "lucide-react";
import { newSession, saveSessionNow, useSessionPersistenceStore } from "@/agent/session-persistence";
import useAgentStore from "@/store/agent/useAgentStore";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SessionList, sessionDisplayTitle, useOtherSessionsActivity } from "./components/SessionList";
import { DOCKED_CONTENT_SHIFT, homeContentShift, readSidebarCollapsed, SIDEBAR_DOCK_MIN_WIDTH, SIDEBAR_LEFT, SIDEBAR_WIDTH, writeSidebarCollapsed } from "./home-layout";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
/** Below this width the bottom navigation reaches under the list, so the open list ends above it. */
const CLEAR_NAVIGATION_BELOW = 900;
const PANEL_WIDTH = SIDEBAR_WIDTH;
/** The capsule shares the title bar's row with the app name and the external-agent capsule at the right. */
const CAPSULE_HEIGHT = 28;
const CAPSULE_TOP = 6;
/** On macOS the window's own buttons sit at the top left; the capsule starts after them. */
const CAPSULE_LEFT = isMac ? 84 : SIDEBAR_LEFT;
/** Open, the list starts in the title bar's row; on macOS under it, clear of the window buttons. */
const PANEL_TOP = isMac ? 44 : CAPSULE_TOP;
/** The "new conversation" button: 26px in the capsule, 28px in the list's header, always at the right corner. */
const HEADER_INSET = 6;
/** No overshoot: the corners and border must land still. */
const SHELL_SPRING = { type: "spring" as const, duration: 0.42, bounce: 0 };
const CONTENT_EASE = [0.23, 1, 0.32, 1] as const;
const OPEN_SHADOW = "0 18px 48px -16px rgb(0 0 0 / 0.35)";
const REST_SHADOW = "0 0px 0px 0px rgb(0 0 0 / 0)";

function useWindowSize(): { width: number; height: number } {
  const read = () => typeof window !== "undefined" ? { width: window.innerWidth, height: window.innerHeight } : { width: SIDEBAR_DOCK_MIN_WIDTH, height: 800 };
  const [size, setSize] = useState(read);
  useEffect(() => {
    const update = () => setSize(read());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}

/** Finds sessions by title and latest words; Escape clears it, then leaves it. */
export function SessionSearch({ value, onChange, inputRef, testId, onEscapeEmpty }: {
  value: string; onChange: (value: string) => void; inputRef?: React.Ref<HTMLInputElement>; testId?: string; onEscapeEmpty?: () => void;
}) {
  const { t } = useTranslation();
  return <div className="relative">
    <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
    <Input ref={inputRef} type="search" value={value} placeholder={t("home:sessions_search")} aria-label={t("home:sessions_search")} data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (value) { event.preventDefault(); event.stopPropagation(); onChange(""); }
        else onEscapeEmpty?.();
      }}
      className="h-8 rounded-smooth-lg pl-7 text-[13px] md:text-[13px] shadow-none [&::-webkit-search-cancel-button]:hidden" />
  </div>;
}

/** Shown when a session could not be saved; the session itself stays usable. */
function SaveProblem() {
  const { t } = useTranslation();
  const failed = useSessionPersistenceStore(useShallow((state) => Object.keys(state.saveErrors)));
  if (!failed.length) return null;
  return <div role="status" className="flex items-center gap-2 border-t px-3 py-2 text-[11px] leading-4 text-muted-foreground" data-testid="agent-sessions-save-problem">
    <span className="min-w-0 flex-1">{t("home:sessions_save_failed")}</span>
    <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => { for (const id of failed) void saveSessionNow(id); }}>
      {t("home:sessions_save_retry")}
    </Button>
  </div>;
}

/** The open list: what fades in once the container has started to grow, and fades out first when it shrinks. */
function SessionPanel({ onPicked, searchRef, height }: { onPicked?: () => void; searchRef?: React.Ref<HTMLInputElement>; height: number }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // A fixed size: the content does not reflow while the container around it grows or shrinks; the container clips it.
  return <div className="flex flex-col" style={{ width: PANEL_WIDTH - 2, height: height - 2 }}>
    {/* The header's two buttons ride the container's top-right corner; the title leaves room for them. */}
    <div className="flex h-10 shrink-0 items-center gap-2 pr-[72px] pl-3.5">
      <MessagesSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="min-w-0 truncate text-sm font-medium">{t("home:sessions_title")}</h2>
    </div>
    <div className="px-2 pt-0.5 pb-2">
      <SessionSearch value={query} onChange={setQuery} inputRef={searchRef} testId="agent-sessions-search" onEscapeEmpty={onPicked} />
    </div>
    {/* Radix lays its content out as a table, which would let long titles widen the list instead of being cut. */}
    <ScrollArea className="min-h-0 flex-1" viewportProps={{ className: "[&>div]:!block" }}>
      <SessionList className="px-2 pb-3" query={query} onPicked={() => onPicked?.()} />
    </ScrollArea>
    <SaveProblem />
  </div>;
}

/**
 * A button whose tooltip stays closed after a click or a focus FusionKit moved there, until the pointer leaves
 * it: the button has just moved away from under the pointer and nobody asked for its name.
 */
function QuietTooltip({ label, quiet, children, side = "bottom" }: {
  label: string; quiet: React.MutableRefObject<boolean>; children: React.ReactElement; side?: "bottom" | "right";
}) {
  const [open, setOpen] = useState(false);
  return <Tooltip delayDuration={350} open={open} onOpenChange={(next) => setOpen(next && !quiet.current)}>
    <TooltipTrigger asChild onClick={() => { quiet.current = true; setOpen(false); }} onPointerLeave={() => { quiet.current = false; }}>
      {children}
    </TooltipTrigger>
    <TooltipContent side={side} sideOffset={6}>{label}</TooltipContent>
  </Tooltip>;
}

function ActivityDot({ state }: { state?: "running" | "unread" }) {
  if (!state) return null;
  return <span aria-hidden data-testid="agent-sessions-activity" className="relative flex size-1.5 shrink-0">
    {state === "running" && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:animate-none" />}
    <span className={cn("relative size-1.5 rounded-full", state === "running" ? "bg-emerald-500" : "bg-primary")} />
  </span>;
}

/**
 * The home page's conversations. Closed, they are a capsule in the title bar's row at the top left, the
 * counterpart of the external-agent capsule at the top right: it names the conversation on screen and
 * offers a new one. Clicking it grows the capsule in place into the list, beside the conversation column
 * when the window is wide enough (the user may close it again), otherwise over the page. The "new
 * conversation" button is the same element throughout and rides the container's top-right corner.
 */
export default function SessionSidebar() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const { width, height } = useWindowSize();
  const wide = width >= SIDEBAR_DOCK_MIN_WIDTH;
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [overlay, setOverlay] = useState(false);
  const [hovered, setHovered] = useState(false);
  const activity = useOtherSessionsActivity();
  const title = useAgentStore((state) => {
    const meta = state.catalog[state.activeSessionId];
    return meta ? sessionDisplayTitle(meta, "") : "";
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const quiet = useRef(false);
  const [capsuleWidth, setCapsuleWidth] = useState(0);
  const docked = wide && !collapsed;
  const open = docked || overlay;
  const floating = !docked;
  const panelHeight = Math.max(CAPSULE_HEIGHT, height - PANEL_TOP - (floating && width < CLEAR_NAVIGATION_BELOW ? 60 : 8));

  // The capsule is as wide as its title, up to a limit.
  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure) return;
    const read = () => setCapsuleWidth(Math.ceil(measure.getBoundingClientRect().width));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(measure);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { if (docked) setOverlay(false); }, [docked]);
  // Docked, the conversation is centered in the space beside the list and moves with it; over the page it stays.
  const shown = useRef(false);
  useLayoutEffect(() => {
    const target = docked ? DOCKED_CONTENT_SHIFT : 0;
    if (!shown.current || reduceMotion) { shown.current = true; homeContentShift.jump(target); return; }
    const controls = animate(homeContentShift, target, SHELL_SPRING);
    return () => controls.stop();
  }, [docked, reduceMotion]);
  // Focus moved by FusionKit, without a tooltip: onto the capsule once it is back, or the list's close button.
  const focusToggle = (target: "expand" | "collapse") => {
    quiet.current = true;
    requestAnimationFrame(() => (target === "expand" ? expandRef : collapseRef).current?.focus({ preventScroll: true }));
  };
  const closeOverlay = (returnFocus = false) => {
    setOverlay(false);
    if (returnFocus || expandRef.current?.closest("aside")?.contains(document.activeElement)) focusToggle("expand");
  };
  useEffect(() => {
    if (!overlay) return;
    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeOverlay(true); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [overlay]);
  const expand = () => {
    if (wide) { setCollapsed(false); writeSidebarCollapsed(false); focusToggle("collapse"); }
    else setOverlay(true);
  };
  const collapse = () => {
    if (wide) { setCollapsed(true); writeSidebarCollapsed(true); }
    setOverlay(false);
    focusToggle("expand");
  };
  const startNew = () => { newSession(); if (overlay) closeOverlay(true); };

  const transition = reduceMotion ? { duration: 0 } : SHELL_SPRING;
  const contentIn = reduceMotion ? { duration: 0.12 } : { duration: 0.22, delay: 0.08, ease: CONTENT_EASE };
  const contentOut = { duration: reduceMotion ? 0.1 : 0.12, ease: CONTENT_EASE };
  const capsuleLabel = title || t("home:sessions_new");
  // The title, the list icon and the dot, as the capsule shows them; measured from a hidden copy.
  const capsuleContent = <>
    <MessagesSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 max-w-44 truncate">{capsuleLabel}</span>
    <ActivityDot state={activity} />
  </>;
  // The title part, the divider, the 26px button and the border.
  const closedWidth = (capsuleWidth || 120) + 33;

  return <>
    <AnimatePresence>
      {overlay && <motion.div key="backdrop" className="fixed inset-0 z-50" aria-hidden onPointerDown={() => closeOverlay()}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}
    </AnimatePresence>
    {/* Measures the capsule's title part; the border is part of the size. */}
    <div ref={measureRef} aria-hidden className="pointer-events-none invisible fixed top-0 left-0 flex h-7 w-max items-center gap-1.5 pr-2 pl-2.5 text-xs">{capsuleContent}</div>
    <motion.aside aria-label={t("home:sessions_title")} data-testid="agent-sessions-shell" data-open={open || undefined}
      className={cn("app-region-no-drag fixed isolate z-50 overflow-hidden border bg-background/60 backdrop-blur-md transition-colors duration-200",
        open ? "border-border/70" : hovered ? "border-border/80" : "border-border/40")}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      initial={false}
      animate={open
        ? { left: SIDEBAR_LEFT, top: PANEL_TOP, width: PANEL_WIDTH, height: panelHeight, borderRadius: 16, boxShadow: overlay ? OPEN_SHADOW : REST_SHADOW }
        : { left: CAPSULE_LEFT, top: CAPSULE_TOP, width: closedWidth, height: CAPSULE_HEIGHT, borderRadius: 14, boxShadow: REST_SHADOW }}
      transition={transition}>
      {/* Closed, a hover tint; open, the list's opaque surface. */}
      <motion.div aria-hidden className="pointer-events-none absolute inset-0 bg-muted" initial={false}
        animate={{ opacity: hovered && !open ? 1 : 0 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: CONTENT_EASE }} />
      <motion.div aria-hidden data-testid="agent-sessions-surface" className="pointer-events-none absolute inset-0 bg-background" initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={reduceMotion ? { duration: 0 } : open ? { duration: 0.16 } : { duration: 0.18, delay: 0.16 }} />

      <AnimatePresence initial={false}>
        {!open && <motion.button key="capsule" ref={expandRef} type="button" data-testid="agent-sessions-expand"
          aria-label={`${t("home:sessions_expand")} · ${capsuleLabel}`} aria-expanded={false}
          onClick={() => { quiet.current = true; expand(); }}
          className="absolute top-0 left-0 flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full pr-2 pl-2.5 text-xs text-foreground/85 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{ width: capsuleWidth || undefined }}
          initial={reduceMotion ? false : { opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0, transition: reduceMotion ? { duration: 0 } : { duration: 0.18, delay: 0.12, ease: CONTENT_EASE } }}
          exit={{ opacity: 0, x: reduceMotion ? 0 : -4, transition: contentOut }}>
          {capsuleContent}
        </motion.button>}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {open && <motion.div key="panel" className="absolute top-0 left-0" data-testid="agent-sessions-sidebar" data-mode={docked ? "docked" : "overlay"}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0, transition: contentIn }}
          exit={{ opacity: 0, y: reduceMotion ? 0 : -4, transition: contentOut }}>
          <SessionPanel height={panelHeight} searchRef={searchRef} onPicked={floating ? () => closeOverlay(true) : undefined} />
        </motion.div>}
      </AnimatePresence>

      {/* Rides the top-right corner: the capsule's end, then the list header's right side. */}
      <motion.div className="absolute z-10 flex items-center gap-1" data-testid="agent-sessions-toggles" initial={false}
        animate={open ? { top: HEADER_INSET, right: HEADER_INSET } : { top: 0, right: 0 }} transition={transition}>
        <AnimatePresence initial={false}>
          {!open && <motion.span key="divider" aria-hidden className="h-3.5 w-px bg-border" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} />}
        </AnimatePresence>
        <QuietTooltip label={t("home:sessions_new")} quiet={quiet}>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("home:sessions_new")} data-testid={open ? "agent-sessions-new" : "agent-sessions-new-collapsed"}
            onClick={startNew}
            className={cn("text-muted-foreground transition-[width,height,border-radius] hover:text-foreground",
              open ? "size-7 rounded-smooth-md" : "size-[26px] rounded-full hover:bg-foreground/5 dark:hover:bg-foreground/10")}>
            <SquarePen className="size-3.5" />
          </Button>
        </QuietTooltip>
        <AnimatePresence initial={false} mode="popLayout">
          {open && <motion.span key="collapse" initial={reduceMotion ? false : { opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1, transition: contentIn }} exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.7, transition: contentOut }}>
            <QuietTooltip label={t("home:sessions_collapse")} quiet={quiet}>
              <Button ref={collapseRef} type="button" variant="ghost" size="icon-sm" aria-label={t("home:sessions_collapse")} aria-expanded data-testid="agent-sessions-collapse"
                onClick={collapse} className="size-7 rounded-smooth-md text-muted-foreground hover:text-foreground">
                <PanelLeftClose className="size-4" />
              </Button>
            </QuietTooltip>
          </motion.span>}
        </AnimatePresence>
      </motion.div>
    </motion.aside>
  </>;
}
