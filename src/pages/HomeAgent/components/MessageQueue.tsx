import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, CirclePause, ListEnd, ListOrdered, PencilLine, Play, Send, Square, X } from "lucide-react";
import useAgentStore from "@/store/agent/useAgentStore";
import { resumeMessageQueue, sendQueuedMessageNow } from "@/agent/orchestrator";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { Button } from "@/components/ui/button";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Messages written while a reply runs, and the send controls that put them there.
// Shared by the home page and the floating panel.
// ---------------------------------------------------------------------------

const ROW_TRANSITION = { type: "spring" as const, duration: 0.32, bounce: 0 };

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
export const SEND_NOW_SHORTCUT = isMac ? "⌘ Enter" : "Ctrl Enter";

/** Enter queues (or sends) the draft; Ctrl/Cmd+Enter sends it now, stopping a running reply. */
export function composerSubmitKey(event: React.KeyboardEvent<HTMLTextAreaElement>): "send" | "now" | null {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return null;
  return event.ctrlKey || event.metaKey ? "now" : "send";
}

function QueueIconButton({ label, onClick, children, testId }: { label: string; onClick: () => void; children: React.ReactNode; testId: string }) {
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} data-testid={testId} onClick={onClick}
        className="size-6 rounded-smooth-md text-muted-foreground hover:text-foreground">{children}</Button>
    </TooltipTrigger>
    <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
  </Tooltip>;
}

/**
 * The current session's queued messages: what goes out after the reply, in order. Each can be sent now
 * (the reply stops), taken back into the composer to edit, or dropped. A queue behind a stopped or failed
 * reply waits until the user lets it go on.
 */
export function MessageQueue({ onEdit, className }: { onEdit: (text: string) => void; className?: string }) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const { queue, paused, sessionId, busy } = useAgentStore(useShallow((state) => ({
    queue: state.queuedMessages, paused: state.queuePaused, sessionId: state.activeSessionId, busy: state.isStreaming,
  })));
  const remove = (id: string) => useAgentStore.getState().forSession(sessionId).takeQueuedMessage(id);
  const edit = (id: string) => {
    const message = remove(id);
    if (message) onEdit(message.content);
  };
  const transition = reduceMotion ? { duration: 0 } : ROW_TRANSITION;
  return <AnimatePresence initial={false}>
    {queue.length > 0 && <motion.div key="queue" className={cn("pointer-events-auto overflow-hidden", className)} data-testid="agent-message-queue"
      data-paused={paused || undefined}
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={transition}>
      <SmoothCorners radius={16} smoothing={0.72} className="mb-2 border bg-background/85 p-1 backdrop-blur-md">
        <div className="flex h-7 items-center gap-1.5 pr-1 pl-2.5 text-[11.5px] text-muted-foreground">
          {paused ? <CirclePause className="size-3.5 shrink-0 text-amber-500" aria-hidden /> : <ListOrdered className="size-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1 truncate" role="status" aria-live="polite">
            {paused ? t("home:queue_paused", { count: queue.length }) : busy ? t("home:queue_waiting", { count: queue.length }) : t("home:queue_next", { count: queue.length })}
          </span>
          {paused && <Button type="button" variant="ghost" size="sm" data-testid="agent-queue-resume" onClick={() => resumeMessageQueue(sessionId)}
            className="h-6 gap-1 rounded-smooth-md px-2 text-[11.5px] text-foreground/80 hover:text-foreground">
            <Play className="size-3 fill-current" />{t("home:queue_resume")}
          </Button>}
        </div>
        <ul className="flex flex-col">
          <AnimatePresence initial={false}>
            {queue.map((message, index) => <motion.li key={message.id} layout={!reduceMotion} data-testid="agent-queued-message"
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={transition}
              className="group/queued overflow-hidden">
              <SmoothCorners radius={12} smoothing={0.72} className="flex min-h-8 items-center gap-2 py-1 pr-1 pl-2.5 transition-colors hover:bg-muted/70 focus-within:bg-muted/70">
                <span aria-hidden className="w-3 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground/70">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] leading-5" title={message.content}>{message.content.replace(/\s+/g, " ")}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <QueueIconButton label={t("home:queue_send_now")} testId="agent-queued-send-now" onClick={() => sendQueuedMessageNow(message.id, sessionId)}>
                    <ArrowUp className="size-3.5" />
                  </QueueIconButton>
                  <QueueIconButton label={t("home:queue_edit")} testId="agent-queued-edit" onClick={() => edit(message.id)}>
                    <PencilLine className="size-3.5" />
                  </QueueIconButton>
                  <QueueIconButton label={t("home:queue_remove")} testId="agent-queued-remove" onClick={() => remove(message.id)}>
                    <X className="size-3.5" />
                  </QueueIconButton>
                </span>
              </SmoothCorners>
            </motion.li>)}
          </AnimatePresence>
        </ul>
      </SmoothCorners>
    </motion.div>}
  </AnimatePresence>;
}

/**
 * Send and stop. Idle: one send button. While a reply runs: stop, and once there is a draft, a queue button
 * beside it (Enter); Ctrl/Cmd+Enter sends the draft now instead.
 */
export function ComposerSendControls({ busy, hasDraft, canSend, onSend, onStop, testId, radius }: {
  busy: boolean;
  hasDraft: boolean;
  /** A draft can go out: there is text and the agent is configured. */
  canSend: boolean;
  onSend: (now: boolean) => void;
  onStop: () => void;
  testId: string;
  /** Smooth corners instead of circles, to sit concentrically in a rounded composer. */
  radius?: number;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const shape = radius === undefined ? "rounded-full" : undefined;
  const corner = (node: React.ReactElement) => radius === undefined ? node : <SmoothCorners asChild radius={radius} smoothing={0.72}>{node}</SmoothCorners>;
  const queueing = busy && hasDraft;
  const primary = busy && !hasDraft
    ? { label: t("home:stop_response"), onClick: onStop, icon: <Square className="size-3.5 fill-current" />, active: true, stop: true }
    : { label: busy ? t("home:queue_add") : t("home:send_message"), onClick: () => onSend(false),
      icon: busy ? <ListEnd className="size-4" /> : <Send className="size-4" />, active: canSend, stop: false };
  return <div className="flex shrink-0 items-center gap-1">
    <AnimatePresence initial={false} mode="popLayout">
      {queueing && <motion.span key="stop" initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }} transition={{ type: "spring", duration: 0.3, bounce: 0 }}>
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            {corner(<Button type="button" variant="ghost" aria-label={t("home:stop_response")} data-testid={`${testId}-stop`} onClick={onStop}
              className={cn("size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive", shape)}>
              <Square className="size-3 fill-current" />
            </Button>)}
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t("home:stop_response")}</TooltipContent>
        </Tooltip>
      </motion.span>}
    </AnimatePresence>
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        {corner(<Button type="button" aria-label={primary.label} data-testid={testId} data-mode={primary.stop ? "stop" : busy ? "queue" : "send"}
          onClick={primary.onClick} disabled={!primary.stop && !primary.active}
          className={cn("size-8 shrink-0 transition-[background-color,color,opacity] duration-200", shape,
            primary.stop ? "hover:bg-destructive" : primary.active ? "bg-primary text-primary-foreground hover:opacity-90" : "bg-transparent text-muted-foreground/45")}>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={primary.stop ? "stop" : busy ? "queue" : "send"} className="flex items-center justify-center"
              initial={reduceMotion ? false : { opacity: 0, scale: 0.5, filter: "blur(2px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, filter: "blur(2px)" }} transition={{ type: "spring", duration: 0.28, bounce: 0 }}>
              {primary.icon}
            </motion.span>
          </AnimatePresence>
        </Button>)}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {primary.stop ? primary.label : busy
          ? <span className="flex flex-col gap-0.5"><span>{t("home:queue_add_hint")}</span><span className="text-background/70">{t("home:queue_now_hint", { shortcut: SEND_NOW_SHORTCUT })}</span></span>
          : primary.label}
      </TooltipContent>
    </Tooltip>
  </div>;
}
