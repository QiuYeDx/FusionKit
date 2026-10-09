import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { smoothCorners } from "@qiuyedx/smooth-corners";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, ArrowDown, ChevronDown, Maximize2, Pin, RotateCcw, Send, Settings, Sparkles, Square, X } from "lucide-react";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { abortCurrentStream, handleUserMessage } from "@/agent/orchestrator";
import { isAgentProfileApiFormatSupported } from "@/agent/api-format-capability";
import { pageTitleKey, usePageContextStore } from "@/agent/page-context";
import { setAgentNavigator } from "@/agent/navigation-tools";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { useFileDropInput, useInputHistory } from "../HomeAgent/composer";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChatMarkdownRenderer } from "@/components/qiuye-ui/markdown-renderer";
import { cn } from "@/lib/utils";
import AgentPlanPanel from "../HomeAgent/components/AgentPlanPanel";
import AgentPreparedActions from "../HomeAgent/components/AgentPreparedActions";
import { CapsuleModeSelector, homeAgentWidgetRegistry, MessageBubble, pendingExecutionToFence, StreamingAssistant, useAgentWidgetContexts, useConversationIndex } from "../HomeAgent/conversation";
import { dockClipPath, hasUnreadReply, isDockRoute } from "./dock-state";
import { DOCK_EDGE, DOCK_PANEL_BOTTOM, dockPanelRect, homeColumnTarget, readHomeColumn, type DockRect, type Viewport } from "./handoff";
import "./AgentDock.css";

/** Draft kept across closing the panel and page changes; cleared on reload like the home page draft. */
let draftCache = "";
const PIN_KEY = "fusionkit-agent-dock-pinned";
const readPinned = () => { try { return localStorage.getItem(PIN_KEY) === "1"; } catch { return false; } };
const EDGE = DOCK_EDGE;
const PANEL_BOTTOM = DOCK_PANEL_BOTTOM;
const SPRING = { type: "spring" as const, duration: 0.42, bounce: 0 };
// Smooth corners for the panel; set directly because the panel is a motion element.
const PANEL_CORNERS = smoothCorners(20, 0.72) as CSSProperties;
/** The flight between the home page's conversation column and the panel. */
const HANDOFF = { type: "spring" as const, duration: 0.52, bounce: 0 };
const readViewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });
const CONTENT_EASE = [0.23, 1, 0.32, 1] as const;

function DockIconButton({ label, onClick, disabled, children, testId, className, pressed }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; testId?: string; className?: string; pressed?: boolean }) {
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-pressed={pressed} data-testid={testId} disabled={disabled} onClick={onClick}
        className={cn("size-7 rounded-md text-muted-foreground hover:text-foreground", className)}>{children}</Button>
    </TooltipTrigger>
    <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
  </Tooltip>;
}

/**
 * The assistant on every page but the home page: a launcher at the bottom left,
 * mirroring the theme switch, opens a non-modal panel with the same conversation
 * as the home page. The panel tells the agent which page the user is on.
 *
 * Leaving the home page with a conversation hands it over: the panel's frame
 * flies from the home conversation column to its place, and back when the user
 * returns home.
 */
export default function AgentDock() {
  const location = useLocation();
  const navigate = useNavigate();
  const visible = isDockRoute(location.pathname);
  useEffect(() => { usePageContextStore.getState().setPathname(location.pathname); }, [location.pathname]);
  // The dock is mounted on every page, so it lends the router to the agent's open_app_page tool.
  useEffect(() => { setAgentNavigator((to) => navigate(to)); return () => setAgentNavigator(null); }, [navigate]);
  // Read during the render that leaves home: the home page is still on screen while the route exits.
  const previous = useRef(location.pathname);
  const arrival = useRef<DockRect | null>(null);
  const serial = useRef(0);
  if (previous.current !== location.pathname) {
    arrival.current = previous.current === "/" && visible ? readHomeColumn() : null;
    // Each handover mounts a fresh surface, even if the previous one is still finishing its exit.
    if (previous.current === "/") serial.current++;
    previous.current = location.pathname;
  }
  return <AnimatePresence>{visible && <DockSurface key={`dock-${serial.current}`} arrival={arrival.current} />}</AnimatePresence>;
}

function DockSurface({ arrival }: { arrival: DockRect | null }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotionPreference();
  // A handed-over conversation arrives open; otherwise the panel starts closed.
  const [open, setOpen] = useState(!!arrival);
  // Hidden after the closing animation, so that a closed panel is neither a layer nor focusable.
  const [hidden, setHidden] = useState(!arrival);
  const [arriving, setArriving] = useState(!!arrival && !reduceMotion);
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const resize = () => setViewport(readViewport());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const rest = dockPanelRect(viewport);
  const returningHome = open && !reduceMotion;
  const launcherRef = useRef<HTMLButtonElement>(null);
  const [launcherTip, setLauncherTip] = useState(false);
  // Focus returned to the launcher by closing the panel is not a request for its tooltip;
  // hovering it again or reaching it with Tab still shows the tooltip.
  const quietLauncherFocus = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [size, setSize] = useState({ width: 400, height: 620 });
  const [input, setInput] = useState(draftCache);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { draftCache = input; }, [input]);
  // Pinned, the panel stays open while the user works in the page (for example selecting cues to ask about).
  const [pinned, setPinned] = useState(readPinned);
  const togglePinned = () => setPinned((current) => {
    try { localStorage.setItem(PIN_KEY, current ? "0" : "1"); } catch { /* the choice then lasts for this session */ }
    return !current;
  });
  // A pointer press elsewhere on the page closes the panel so it does not keep covering it. Presses in
  // its own layers (menus, tooltips), in dialogs (such as a revision preview the agent opened) and on
  // the launcher do not; focus stays where the user pressed.
  useEffect(() => {
    if (!open || arriving || pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || panelRef.current?.contains(target) || launcherRef.current?.contains(target)) return;
      // Portalled layers (the execution mode list, menus, dialogs, toasts) live outside the app root.
      if (!document.getElementById("root")?.contains(target)) return;
      // While one of the panel's own popups is open, a press elsewhere only dismisses that popup.
      if (panelRef.current?.querySelector('[role="combobox"][aria-expanded="true"], [aria-haspopup][aria-expanded="true"]')) return;
      if (target.closest('[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [data-slot$="-overlay"], [data-sonner-toast]')) return;
      closePanel(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
    // closePanel only uses state setters and refs.
  }, [open, arriving, pinned]);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const { session, isStreaming, executionMode, setExecutionMode, pendingExecution, pendingNameTranslationPlan, resetSession } = useAgentStore(useShallow((state) => ({
    session: state.session, isStreaming: state.isStreaming, executionMode: state.executionMode, setExecutionMode: state.setExecutionMode,
    pendingExecution: state.pendingExecution, pendingNameTranslationPlan: state.pendingNameTranslationPlan, resetSession: state.resetSession,
  })));
  const { messages } = session;
  const { toolResults, toolCallIds } = useConversationIndex(messages);
  const { widgetContext, streamingWidgetContext, pendingWidgetContext, namePlanWidgetContext } =
    useAgentWidgetContexts(session.id, pendingExecution, pendingNameTranslationPlan, navigate);

  const agentProfile = useModelStore((state) => state.getAgentProfile());
  const configured = !!agentProfile?.apiKey?.trim() && isAgentProfileApiFormatSupported(agentProfile);

  // Page awareness: the registered page or the known route name, plus what it shows.
  const page = usePageContextStore((state) => [...state.pages].reverse().find((item) => item.route === state.pathname));
  const titleKey = pageTitleKey(location.pathname, page);
  const pageName = titleKey ? t(titleKey) : undefined;
  const pageLabel = [pageName, page?.subject].filter(Boolean).join(" · ");

  // Unread replies while closed.
  const seen = useRef(messages.length);
  if (open) seen.current = messages.length;
  const unread = !open && hasUnreadReply(messages, Math.min(seen.current, messages.length));
  useEffect(() => { if (seen.current > messages.length) seen.current = messages.length; }, [messages.length]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => setSize({ width: panel.offsetWidth, height: panel.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    atBottom.current = true; setShowLatest(false);
  }, []);
  // Follow new content while the reader is at the bottom; keep their place otherwise.
  useLayoutEffect(() => { if (atBottom.current) scrollToEnd(); }, [messages.length, isStreaming, pendingExecution, open, scrollToEnd]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const follow = new ResizeObserver(() => { if (atBottom.current) element.scrollTop = element.scrollHeight; });
    if (element.firstElementChild) follow.observe(element.firstElementChild);
    return () => follow.disconnect();
  }, []);
  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
    setShowLatest(!atBottom.current);
  };

  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [input, open]);

  const openPanel = () => { setHidden(false); setOpen(true); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })); };
  const closePanel = (restoreFocus = true) => {
    setOpen(false);
    setLauncherTip(false);
    if (restoreFocus) { quietLauncherFocus.current = true; launcherRef.current?.focus({ preventScroll: true }); }
  };
  // Up/Down recall sent messages and dropped files add their paths, as on the home page.
  const { remember: rememberInput, onHistoryKey } = useInputHistory(input, setInput, inputRef);
  const { isDragOver, dropHandlers } = useFileDropInput(setInput, inputRef);
  const send = async () => {
    const text = input.trim();
    if (!text || isStreaming || !configured) return;
    rememberInput(text);
    setInput("");
    atBottom.current = true;
    await handleUserMessage(text);
  };
  const onInputKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); return; }
    onHistoryKey(event);
  };
  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Inner layers (selects, tooltips) handle their own Escape first.
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    closePanel();
  };
  const onReset = () => {
    if (!confirmingReset) {
      setConfirmingReset(true);
      resetTimer.current = setTimeout(() => setConfirmingReset(false), 3000);
      return;
    }
    clearTimeout(resetTimer.current); setConfirmingReset(false);
    resetSession();
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  // Like the home page: when a reply finishes, the open panel is ready for the next message.
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    const finished = wasStreaming.current && !isStreaming;
    wasStreaming.current = isStreaming;
    const focus = document.activeElement;
    if (finished && open && !arriving && (!focus || focus === document.body || panelRef.current?.contains(focus))) inputRef.current?.focus({ preventScroll: true });
  }, [isStreaming, open, arriving]);
  const suggestions = page?.suggestions ?? [];
  const canSend = !!input.trim() && !isStreaming && configured;

  return <>
    <motion.div className="agent-dock-shadow fixed z-[45]" data-hidden={hidden || undefined} data-testid="agent-dock-frame"
      initial={arrival && !reduceMotion ? arrival : false}
      animate={rest}
      transition={arriving ? HANDOFF : { duration: 0 }}
      exit={returningHome ? { ...homeColumnTarget(viewport), transition: HANDOFF } : undefined}
      onAnimationComplete={() => {
        if (!arriving) return;
        setArriving(false);
        // The input is disabled while a reply streams; focus follows when it finishes.
        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
      }}>
      <motion.div ref={panelRef} id="agent-dock-panel" data-testid="agent-dock-panel" data-open={open || undefined}
        role={open ? "dialog" : undefined} aria-modal={open ? false : undefined} aria-label={open ? t("home:dock.panel_label") : undefined}
        aria-hidden={!open} inert={!open || arriving} data-arriving={arriving || undefined}
        onKeyDown={onPanelKey}
        className="agent-dock-panel smooth-corners flex h-full w-full flex-col overflow-hidden border bg-background"
        style={PANEL_CORNERS}
        initial={arrival ? { opacity: 0 } : false}
        // A hidden panel leaves without an exit animation, which could never be seen or finish.
        exit={hidden ? undefined : { opacity: 0, transition: returningHome ? { duration: 0.22, delay: 0.24 } : { duration: 0.15 } }}
        animate={reduceMotion
          ? { opacity: open ? 1 : 0, clipPath: dockClipPath(true, size), y: 0 }
          : { opacity: open ? 1 : 0, clipPath: dockClipPath(open, size), y: open ? 0 : PANEL_BOTTOM - EDGE }}
        transition={reduceMotion ? { duration: 0.16 } : {
          ...SPRING,
          opacity: open ? { duration: 0.12 } : { duration: 0.16, delay: 0.18 },
        }}
        onAnimationComplete={() => { if (!open) setHidden(true); }}
      >
        <motion.div className="flex min-h-0 flex-1 flex-col" initial={arrival ? { opacity: 0 } : false}
          animate={{ opacity: open ? 1 : 0 }}
          // A handover fades through: the opaque frame covers the home column before the conversation
          // appears in it, and on the way back the conversation leaves before the frame dissolves, so it
          // never doubles with the home page's copy at a slightly different offset.
          exit={hidden ? undefined : { opacity: 0, transition: returningHome ? { duration: 0.14, delay: 0.14 } : { duration: 0.12 } }}
          transition={reduceMotion ? { duration: arrival ? 0.2 : 0 } : { duration: open ? (arriving ? 0.16 : 0.22) : 0.12, delay: open ? (arriving ? 0.1 : 0.08) : 0, ease: CONTENT_EASE }}>
          <header className="relative z-10 flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2">
            <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium leading-5">{t("home:agent_title")}</div>
              {pageLabel && <div className="truncate text-[11px] leading-4 text-muted-foreground" title={pageLabel} data-testid="agent-dock-page">{pageLabel}</div>}
            </div>
            <DockIconButton label={t(pinned ? "home:dock.unpin" : "home:dock.pin")} testId="agent-dock-pin" pressed={pinned} onClick={togglePinned}
              className={pinned ? "bg-accent text-foreground" : undefined}><Pin className={cn("size-3.5", pinned && "fill-current")} /></DockIconButton>
            <DockIconButton label={t("home:dock.open_home")} testId="agent-dock-open-home" onClick={() => navigate("/")}><Maximize2 className="size-3.5" /></DockIconButton>
            <DockIconButton label={t(confirmingReset ? "home:confirm_new_conversation" : "home:new_conversation")} testId="agent-dock-reset" disabled={isStreaming || !messages.length} onClick={onReset}
              className={confirmingReset ? "text-destructive hover:text-destructive" : undefined}><RotateCcw className="size-3.5" /></DockIconButton>
            <DockIconButton label={t("home:dock.close")} testId="agent-dock-close" onClick={() => closePanel()}><X className="size-4" /></DockIconButton>
          </header>

          <div className="relative min-h-0 flex-1">
            {/* Radix lays its content wrapper out as a table, which would let long lines widen the panel. */}
            <ScrollArea className="agent-dock-scroll h-full" viewportRef={scrollRef}
              viewportProps={{ onScroll, className: "overscroll-contain [&>div]:!block", ...{ "data-testid": "agent-dock-messages" } }}>
              <div className="space-y-4 p-3">
                {!messages.length && !isStreaming && <div className="flex flex-col items-center gap-3 px-2 pt-6 pb-2 text-center" data-testid="agent-dock-empty">
                  <div className="text-sm font-medium">{t("home:dock.empty_title")}</div>
                  <p className="text-xs leading-5 text-muted-foreground">{pageName ? t("home:dock.empty_hint_page", { page: pageName }) : t("home:dock.empty_hint")}</p>
                  {suggestions.length > 0 && <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                    {suggestions.map((item) => <Button key={item.labelKey} type="button" variant="outline" size="sm" data-testid="agent-dock-suggestion"
                      className="h-7 rounded-full px-3 text-xs text-foreground/70"
                      onClick={() => { setInput(t(item.promptKey)); requestAnimationFrame(() => inputRef.current?.focus()); }}>
                      <Sparkles className="size-3" />{t(item.labelKey)}
                    </Button>)}
                  </div>}
                </div>}
                {messages.map((message) => <MessageBubble key={message.id} message={message} widgetRegistry={homeAgentWidgetRegistry} widgetContext={widgetContext}
                  namePlanWidgetContext={namePlanWidgetContext} pendingNamePlanId={pendingNameTranslationPlan?.planId} toolResults={toolResults} toolCallIds={toolCallIds} />)}
                {isStreaming && <StreamingAssistant widgetContext={streamingWidgetContext} />}
                <AgentPreparedActions key={session.id} sessionId={session.id} busy={isStreaming} />
                {session.plan && <AgentPlanPanel key={session.plan.id} plan={session.plan} busy={isStreaming}
                  onCheckProgress={() => { setInput(current => current || t("home:plan_check_prompt")); requestAnimationFrame(() => inputRef.current?.focus()); }} />}
                {pendingExecution && !isStreaming && <div>
                  <ChatMarkdownRenderer content={pendingExecutionToFence(pendingExecution)} widgetRegistry={homeAgentWidgetRegistry} widgetContext={pendingWidgetContext} codeBlock={{ colorTheme: "qiuvision" }} />
                </div>}
              </div>
            </ScrollArea>
            <AnimatePresence>
              {showLatest && <motion.div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center"
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.16 }}>
                <Button type="button" variant="outline" size="icon" aria-label={t("home:scroll_to_bottom")} onClick={() => scrollToEnd("smooth")}
                  className="pointer-events-auto size-8 rounded-full bg-background/80 shadow-sm backdrop-blur-[5px]"><ArrowDown className="size-4" /></Button>
              </motion.div>}
            </AnimatePresence>
          </div>

          <div className="relative z-10 shrink-0 border-t bg-background p-3">
            {!configured && <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2" data-testid="agent-dock-not-configured">
              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
              <span className="min-w-0 flex-1 text-xs leading-5 text-amber-700 dark:text-amber-400">{t("home:agent_not_configured")}</span>
              <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1 rounded-full px-2 text-xs" onClick={() => navigate("/setting")}><Settings className="size-3" />{t("home:go_settings")}</Button>
            </div>}
            {/* Concentric corners: the controls sit 6px inside the composer, so their radius is 16 - 6. */}
            <SmoothCorners radius={16} smoothing={0.72} {...dropHandlers} data-testid="agent-dock-composer" data-drag-over={isDragOver || undefined}
              className={cn("relative border bg-background p-1.5 transition-colors focus-within:border-ring/50 focus-within:shadow-sm",
                isDragOver && "border-primary/40 bg-primary/5")}>
              {isDragOver && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-xs font-medium text-primary">{t("home:drop_files_hint")}</div>}
              <Textarea ref={inputRef} rows={1} data-testid="agent-dock-input" aria-label={t("home:agent_input_label")} placeholder={t("home:agent_input_placeholder")}
                value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onInputKey} disabled={isStreaming}
                className="agent-dock-input max-h-32 min-h-0 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-2 pt-1.5 pb-1 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:opacity-50 dark:bg-transparent" />
              <div className={cn("flex items-center justify-between gap-2 pt-1.5", isDragOver && "opacity-0")}>
                <CapsuleModeSelector value={executionMode} onChange={setExecutionMode} disabled={isStreaming} radius={10} />
                <SmoothCorners asChild radius={10} smoothing={0.72}><Button type="button" data-testid="agent-dock-send" aria-label={isStreaming ? t("home:stop_response") : t("home:send_message")}
                  onClick={isStreaming ? () => abortCurrentStream() : () => void send()} disabled={!isStreaming && !canSend}
                  className={cn("size-8 shrink-0 transition-all duration-200",
                    isStreaming ? "shadow-sm hover:bg-destructive" : canSend ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90" : "bg-transparent text-muted-foreground/45")}>
                  {isStreaming ? <Square className="size-3.5 fill-current" /> : <Send className="size-4" />}
                </Button></SmoothCorners>
              </div>
            </SmoothCorners>
          </div>
        </motion.div>
      </motion.div>
    </motion.div>

    <motion.div className="fixed z-[46]" style={{ left: EDGE, bottom: EDGE }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
      <Tooltip delayDuration={350} open={launcherTip} onOpenChange={(next) => { if (!next || !quietLauncherFocus.current) setLauncherTip(next); }}>
        <TooltipTrigger asChild>
          <Button ref={launcherRef} type="button" variant="outline" size="icon" data-testid="agent-dock-launcher"
            aria-label={t(open ? "home:dock.close" : "home:dock.open")} aria-expanded={open} aria-controls="agent-dock-panel"
            onClick={() => open ? closePanel() : openPanel()}
            onPointerEnter={() => { quietLauncherFocus.current = false; }} onBlur={() => { quietLauncherFocus.current = false; }}
            className="agent-dock-launcher relative h-9 w-9 rounded-full dark:bg-background dark:hover:bg-accent">
            <span className="relative grid size-5 place-items-center" aria-hidden="true">
              <motion.span className="absolute inset-0 grid place-items-center" initial={false}
                animate={{ opacity: open ? 0 : 1, scale: open && !reduceMotion ? 0.6 : 1 }} transition={{ duration: 0.16 }}>
                <Sparkles className="size-5" />
              </motion.span>
              <motion.span className="absolute inset-0 grid place-items-center" initial={false}
                animate={{ opacity: open ? 1 : 0, scale: open || reduceMotion ? 1 : 0.6 }} transition={{ duration: 0.16 }}>
                <ChevronDown className="size-5" />
              </motion.span>
            </span>
            {!open && isStreaming && <span className="agent-dock-busy" data-testid="agent-dock-busy" aria-hidden="true" />}
            {unread && !isStreaming && <span className="agent-dock-unread" data-testid="agent-dock-unread" aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>{t(open ? "home:dock.close" : "home:dock.open")}{!open && (isStreaming ? ` · ${t("home:dock.working")}` : unread ? ` · ${t("home:dock.unread")}` : "")}</TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status" aria-live="polite">{!open && unread ? t("home:dock.unread") : ""}</span>
    </motion.div>
  </>;
}
