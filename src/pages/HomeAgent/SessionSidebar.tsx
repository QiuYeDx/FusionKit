import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { animate, AnimatePresence, motion } from "motion/react";
import { PanelLeftClose, PanelLeftOpen, Search, SquarePen } from "lucide-react";
import { newSession, saveSessionNow, useSessionPersistenceStore } from "@/agent/session-persistence";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { SessionList, useOtherSessionsActivity } from "./components/SessionList";
import { DOCKED_CONTENT_SHIFT, homeContentShift, readSidebarCollapsed, SIDEBAR_DOCK_MIN_WIDTH, SIDEBAR_WIDTH, writeSidebarCollapsed } from "./home-layout";

/** Below this width the bottom navigation reaches under the list, so the open list ends above it. */
const CLEAR_NAVIGATION_BELOW = 900;
const PANEL_WIDTH = SIDEBAR_WIDTH;
/** Closed, the container is just its two 28px buttons with 8px around them. */
const COLLAPSED = { width: 76, height: 44 };
/** The container's top edge: under the title bar. */
const TOP = 56;
/** No overshoot: the corners and border must land still. */
const SHELL_SPRING = { type: "spring" as const, duration: 0.42, bounce: 0 };
const CONTENT_EASE = [0.23, 1, 0.32, 1] as const;


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
  return <div className="flex flex-col" style={{ width: PANEL_WIDTH, height }}>
    {/* The two buttons of the container sit at the right of this row. */}
    <div className="flex h-11 shrink-0 items-center pt-1 pr-[76px] pl-[18px]">
      <h2 className="min-w-0 truncate text-sm font-medium">{t("home:sessions_title")}</h2>
    </div>
    <div className="px-2 pt-1 pb-2">
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
 * A button of the container: the same element whether the list is open or not, so it travels with the
 * container's corner. Its tooltip stays closed after a click or a focus FusionKit moved there, until the
 * pointer leaves it: the button has just moved away from under the pointer and nobody asked for its name.
 */
function ShellButton({ label, onClick, children, testId, dot, quiet }: {
  label: string; onClick: () => void; children: React.ReactNode; testId: string; dot?: "running" | "unread";
  quiet: React.MutableRefObject<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return <Tooltip delayDuration={350} open={open} onOpenChange={(next) => setOpen(next && !quiet.current)}>
    <TooltipTrigger asChild>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} data-testid={testId}
        onClick={() => { quiet.current = true; setOpen(false); onClick(); }}
        onPointerLeave={() => { quiet.current = false; }}
        className="relative size-7 rounded-smooth-md text-muted-foreground hover:text-foreground">
        {children}
        {dot && <span aria-hidden className={cn("absolute top-1 right-1 size-1.5 rounded-full", dot === "running" ? "bg-muted-foreground animate-pulse motion-reduce:animate-none" : "bg-primary")} />}
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
  </Tooltip>;
}

/**
 * The home page's conversations. One container holds the two buttons and the list: closed, it is just the
 * buttons at the top left; open, it grows from there into the list, beside the conversation column when the
 * window is wide enough (the user may close it), otherwise over the page. The buttons stay the same elements
 * and ride the container's top-right corner, so they move into the list's header and back.
 */
export default function SessionSidebar() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const { width, height } = useWindowSize();
  const wide = width >= SIDEBAR_DOCK_MIN_WIDTH;
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [overlay, setOverlay] = useState(false);
  const activity = useOtherSessionsActivity();
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLDivElement>(null);
  const quiet = useRef(false);
  const docked = wide && !collapsed;
  const open = docked || overlay;
  const floating = !docked;
  const panelHeight = Math.max(COLLAPSED.height, height - TOP - (floating && width < CLEAR_NAVIGATION_BELOW ? 60 : 16));

  useEffect(() => { if (docked) setOverlay(false); }, [docked]);
  // Docked, the conversation is centered in the space beside the list and moves with it; over the page it stays.
  const shown = useRef(false);
  useLayoutEffect(() => {
    const target = docked ? DOCKED_CONTENT_SHIFT : 0;
    if (!shown.current || reduceMotion) { shown.current = true; homeContentShift.jump(target); return; }
    const controls = animate(homeContentShift, target, SHELL_SPRING);
    return () => controls.stop();
  }, [docked, reduceMotion]);
  // Focus moved by FusionKit: back on the open/close button, without its tooltip.
  const focusToggle = () => {
    quiet.current = true;
    requestAnimationFrame(() => toggleRef.current?.querySelector<HTMLButtonElement>("[data-testid=agent-sessions-expand], [data-testid=agent-sessions-collapse]")?.focus({ preventScroll: true }));
  };
  const closeOverlay = (returnFocus = false) => {
    setOverlay(false);
    if (returnFocus || toggleRef.current?.closest("aside")?.contains(document.activeElement)) focusToggle();
  };
  useEffect(() => {
    if (!overlay) return;
    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeOverlay(true); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [overlay]);
  const toggle = () => {
    if (open) {
      if (wide) { setCollapsed(true); writeSidebarCollapsed(true); }
      setOverlay(false);
    } else if (wide) { setCollapsed(false); writeSidebarCollapsed(false); }
    else setOverlay(true);
  };

  const shellTransition = reduceMotion ? { duration: 0 } : SHELL_SPRING;
  return <>
    <AnimatePresence>
      {overlay && <motion.div key="backdrop" className="fixed inset-0 z-30" aria-hidden onPointerDown={() => closeOverlay()}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}
    </AnimatePresence>
    <SmoothCorners asChild radius={16} smoothing={0.72}>
      <motion.aside aria-label={t("home:sessions_title")} data-testid="agent-sessions-shell" data-open={open || undefined}
        className={cn("fixed top-14 left-4 isolate overflow-hidden", overlay ? "z-40" : "z-30",
          // The shadow belongs to the list floating over the page; the browser fades it.
          "transition-shadow duration-200",
          overlay && "shadow-[0_12px_32px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.06)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.45)]")}
        initial={false}
        animate={open ? { width: PANEL_WIDTH, height: panelHeight } : COLLAPSED}
        transition={shellTransition}>
        {/* The surface: present while open, gone when only the buttons are left. */}
        <SmoothCorners radius={16} smoothing={0.72} aria-hidden
          className={cn("pointer-events-none absolute inset-0 border bg-background", overlay ? "border-border/60 dark:border-border" : "border-border/60")}
          // Motion animates the opacity; the corner radius and border stay static.
          asChild>
          <motion.div initial={false} animate={{ opacity: open ? 1 : 0 }}
            transition={reduceMotion ? { duration: 0 } : open ? { duration: 0.16 } : { duration: 0.18, delay: 0.16 }} />
        </SmoothCorners>
        <AnimatePresence initial={false}>
          {open && <motion.div key="panel" className="absolute top-0 left-0" data-testid="agent-sessions-sidebar" data-mode={docked ? "docked" : "overlay"}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: reduceMotion ? { duration: 0.12 } : { duration: 0.22, delay: 0.08, ease: CONTENT_EASE } }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -4, transition: { duration: reduceMotion ? 0.1 : 0.12, ease: CONTENT_EASE } }}>
            <SessionPanel height={panelHeight} searchRef={searchRef} onPicked={floating ? () => closeOverlay(true) : undefined} />
          </motion.div>}
        </AnimatePresence>
        <div ref={toggleRef} className="absolute top-2 right-2 z-10 flex items-center gap-1" data-testid="agent-sessions-toggles">
          <ShellButton label={t("home:sessions_new")} testId={open ? "agent-sessions-new" : "agent-sessions-new-collapsed"} quiet={quiet}
            onClick={() => { newSession(); if (overlay) closeOverlay(true); }}>
            <SquarePen className="size-4" />
          </ShellButton>
          <ShellButton label={t(open ? "home:sessions_collapse" : "home:sessions_expand")} testId={open ? "agent-sessions-collapse" : "agent-sessions-expand"}
            quiet={quiet} onClick={toggle} dot={open ? undefined : activity}>
            {/* One button, two drawings: the open and close icons cross-fade. */}
            <span data-shell-toggle-icon className="relative size-4">
              <motion.span className="absolute inset-0" initial={false} animate={{ opacity: open ? 1 : 0 }} transition={{ duration: 0.16 }}><PanelLeftClose className="size-4" /></motion.span>
              <motion.span className="absolute inset-0" initial={false} animate={{ opacity: open ? 0 : 1 }} transition={{ duration: 0.16 }}><PanelLeftOpen className="size-4" /></motion.span>
            </span>
          </ShellButton>
        </div>
      </motion.aside>
    </SmoothCorners>
  </>;
}
