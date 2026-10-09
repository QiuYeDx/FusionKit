import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NavigateFunction } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Check, CheckCircle2, Copy, Loader2, ListPlus, MessageSquareMore, PauseCircle, XCircle, Zap } from "lucide-react";
import useAgentStore from "@/store/agent/useAgentStore";
import { usePreparedActionsStore } from "@/agent/prepared-actions";
import { reportUiEvent } from "@/agent/orchestrator";
import { AgentToolGroup } from "./components/AgentToolCall";
import AgentPlanPanel from "./components/AgentPlanPanel";
import AgentPreparedActions, { AgentPreparedActionCard } from "./components/AgentPreparedActions";
import { actionErrorMessage } from "./components/action-error";
import { createWidgetActionHandler, isNamePlanResultFor } from "./widget-actions";
import { anchoredActionIds, buildFeed, type FeedItem, type ToolEntry } from "./feed";
import type {
  AgentMessage,
  AgentToolResult,
  ExecutionMode,
  PendingExecution,
  TaskStoreType,
} from "@/agent/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import {
  ChatMarkdownRenderer,
  type MarkdownWidgetRegistry,
  type MarkdownWidgetContext,
} from "@/components/qiuye-ui/markdown-renderer";
import { builtinWidgetRegistry } from "@/components/qiuye-ui/markdown-renderer/widgets/builtin-registry";
import {
  pendingExecutionWidget,
  type PendingExecutionStoreLabelKey,
} from "@/components/qiuye-ui/markdown-renderer/widgets/PendingExecutionWidget";
import {
  nameTranslationApplyResultWidget,
  nameTranslationPlanWidget,
} from "./components/NameTranslationPlanWidget";

// Conversation parts shared by the home page and the floating assistant panel.
// Both read the same agent store, so a conversation continues in either place.

const EXECUTION_MODE_OPTIONS: {
  value: ExecutionMode;
  labelKey: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "queue_only",
    labelKey: "home:execution_mode_queue_only",
    icon: <ListPlus className="h-3.5 w-3.5" />,
  },
  {
    value: "ask_before_execute",
    labelKey: "home:execution_mode_ask_before_execute",
    icon: <MessageSquareMore className="h-3.5 w-3.5" />,
  },
  {
    value: "auto_execute",
    labelKey: "home:execution_mode_auto_execute",
    icon: <Zap className="h-3.5 w-3.5" />,
  },
];

const STORE_LABEL_KEYS: Record<TaskStoreType, PendingExecutionStoreLabelKey> = {
  translate: "home:store_label_translate",
  convert: "home:store_label_convert",
  extract: "home:store_label_extract",
};

const STORE_PATH: Record<TaskStoreType, string> = {
  translate: "/tools/subtitle/translator",
  convert: "/tools/subtitle/converter",
  extract: "/tools/subtitle/extractor",
};

// ---------------------------------------------------------------------------
// Widget registry (builtin + pending-execution)
// ---------------------------------------------------------------------------

export const homeAgentWidgetRegistry: MarkdownWidgetRegistry = {
  ...builtinWidgetRegistry,
  [pendingExecutionWidget.type]: pendingExecutionWidget,
  [nameTranslationPlanWidget.type]: nameTranslationPlanWidget,
  [nameTranslationApplyResultWidget.type]: nameTranslationApplyResultWidget,
};

// ---------------------------------------------------------------------------
// Structured data → Widget fence converters
// ---------------------------------------------------------------------------

export function pendingExecutionToFence(pe: PendingExecution): string {
  const payload = JSON.stringify({
    stores: pe.stores.map((s) => ({
      name: s,
      labelKey: STORE_LABEL_KEYS[s],
      count: pe.taskCounts[s] ?? 0,
      path: STORE_PATH[s],
    })),
    ...(pe.resolvedAction ? { resolvedAction: pe.resolvedAction } : {}),
  });
  return "```qv:pending-execution\n" + payload + "\n```";
}

/** Name translation plans render as their own interactive card at the end of their turn. */
function namePlanFence(result: AgentToolResult): string {
  const type = result.toolName === "create_name_translation_plan" ? "name-translation-plan" : "name-translation-apply-result";
  return "```qv:" + type + "\n" + JSON.stringify(result.data) + "\n```";
}

type PendingNamePlan = Parameters<typeof createWidgetActionHandler>[3] extends infer Target
  ? Target extends { kind: "name-translation-plan"; plan: infer Plan } ? Plan : never : never;

/** Widget contexts bound to the current session and its pending confirmations. */
export function useAgentWidgetContexts(
  sessionId: string,
  pendingExecution: PendingExecution | null,
  pendingNameTranslationPlan: PendingNamePlan | null,
  navigate: NavigateFunction,
) {
  const widgetContext = useMemo<MarkdownWidgetContext>(
    () => ({
      conversationId: sessionId,
      role: "assistant",
      density: "compact",
      onWidgetAction: createWidgetActionHandler(sessionId, useAgentStore.getState, navigate),
    }),
    [sessionId, navigate],
  );
  const streamingWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, isStreaming: true }),
    [widgetContext],
  );
  // Decisions on the trusted cards are reported, so the agent follows up on them by itself.
  const pendingWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, role: "tool", onWidgetAction: createWidgetActionHandler(sessionId, useAgentStore.getState, navigate,
      pendingExecution ? { kind: "pending-execution", pending: pendingExecution } : { kind: "display" }, reportUiEvent) }),
    [widgetContext, sessionId, navigate, pendingExecution],
  );
  const namePlanWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, role: "tool", onWidgetAction: createWidgetActionHandler(sessionId, useAgentStore.getState, navigate,
      pendingNameTranslationPlan ? { kind: "name-translation-plan", plan: pendingNameTranslationPlan } : { kind: "display" }, reportUiEvent) }),
    [widgetContext, sessionId, navigate, pendingNameTranslationPlan],
  );
  return { widgetContext, streamingWidgetContext, pendingWidgetContext, namePlanWidgetContext };
}

export type AgentWidgetContexts = ReturnType<typeof useAgentWidgetContexts>;

export function CapsuleModeSelector({
  value,
  onChange,
  disabled,
  radius,
}: {
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
  disabled?: boolean;
  /** A smooth corner radius instead of the capsule, to sit concentrically in a rounded composer. */
  radius?: number;
}) {
  const { t } = useTranslation();
  const trigger = (
      <SelectTrigger
        size="sm"
        aria-label={t("home:execution_mode_label")}
        data-testid="agent-execution-mode"
        className={cn(
          "h-8 rounded-full border-0 shadow-none",
          radius === undefined && "-translate-x-0.5",
          "bg-secondary hover:bg-accent/60",
          "text-foreground/65",
          "focus-visible:ring-2 focus-visible:ring-ring/50",
          "cursor-pointer shrink-0",
        )}
      >
        <SelectValue />
      </SelectTrigger>
  );

  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as ExecutionMode)}
      disabled={disabled}
    >
      {radius === undefined ? trigger : <SmoothCorners asChild radius={radius} smoothing={0.72}>{trigger}</SmoothCorners>}
      <SelectContent position="item-aligned">
        {EXECUTION_MODE_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            <span className="flex items-center gap-1.5">
              {opt.icon}
              {t(opt.labelKey)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Thinking indicator, streamed reply and in-flight tool calls of the current turn. */
export function StreamingAssistant({ widgetContext }: { widgetContext: MarkdownWidgetContext }) {
  const { t } = useTranslation();
  const { streamingText, activeToolCalls, thinking } = useAgentStore(useShallow((state) => ({
    streamingText: state.streamingText,
    activeToolCalls: state.activeToolCalls,
    thinking: state.session.status === "thinking",
  })));
  const running = useMemo(() => activeToolCalls.map(call => ({ call })), [activeToolCalls]);
  if (!streamingText && activeToolCalls.length === 0) {
    return thinking ? (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{t("home:agent_thinking")}</span>
      </div>
    ) : null;
  }
  return (
    <div className="min-w-0 space-y-2 text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300">
      {streamingText && <ChatMarkdownRenderer
        content={streamingText}
        widgetRegistry={homeAgentWidgetRegistry}
        widgetContext={widgetContext}
        codeBlock={{ colorTheme: "qiuvision" }}
      />}
      <AgentToolGroup entries={running} running />
    </div>
  );
}

const DECISION_KINDS = new Set<FeedItem["kind"]>(["name-plan", "prepared-action", "pending-execution"]);

/**
 * The whole conversation: messages, tool rows and decision cards in turn order, the reply being
 * written, prepared actions no tool result shows, and the plan as a status bar at the end.
 */
export function ConversationFeed({ contexts, onCheckProgress, canCheckProgress }: {
  contexts: AgentWidgetContexts;
  onCheckProgress: () => void;
  canCheckProgress: boolean;
}) {
  const { session, isStreaming, pendingExecution, pendingNamePlanId } = useAgentStore(useShallow((state) => ({
    session: state.session,
    isStreaming: state.isStreaming,
    pendingExecution: state.pendingExecution,
    pendingNamePlanId: state.pendingNameTranslationPlan?.planId,
  })));
  const actions = usePreparedActionsStore((state) => state.actions);
  const { messages } = session;
  const items = useMemo(() => buildFeed(messages, {
    hasAction: (id) => actions.some((action) => action.id === id && action.sessionId === session.id),
    pendingExecutionAt: pendingExecution?.timestamp,
  }), [messages, actions, session.id, pendingExecution?.timestamp]);
  const anchored = useMemo(() => anchoredActionIds(messages), [messages]);
  // While the reply is still being written, the turn's decision cards wait below it.
  let split = items.length;
  if (isStreaming) while (split > 0 && DECISION_KINDS.has(items[split - 1].kind)) split--;
  const render = (item: FeedItem) => <FeedItemView key={item.key} item={item} contexts={contexts} pendingNamePlanId={pendingNamePlanId}
    pendingExecution={pendingExecution} busy={isStreaming} />;
  return <>
    {items.slice(0, split).map(render)}
    {isStreaming && <StreamingAssistant widgetContext={contexts.streamingWidgetContext} />}
    {items.slice(split).map(render)}
    <AgentPreparedActions key={session.id} sessionId={session.id} busy={isStreaming} anchored={anchored} />
    {session.plan && <AgentPlanPanel key={session.plan.id} plan={session.plan} busy={isStreaming} canCheck={canCheckProgress} onCheckProgress={onCheckProgress} />}
  </>;
}

function FeedItemView({ item, contexts, pendingNamePlanId, pendingExecution, busy }: {
  item: FeedItem;
  contexts: AgentWidgetContexts;
  pendingNamePlanId?: string;
  pendingExecution: PendingExecution | null;
  busy: boolean;
}) {
  switch (item.kind) {
    case "user": return <UserMessage message={item.message} />;
    case "event": return <UiEventLine message={item.message} />;
    case "text": return <AssistantText message={item.message} widgetContext={contexts.widgetContext} />;
    case "tools": return <ToolGroup entries={item.entries} />;
    case "name-plan": {
      const context = isNamePlanResultFor(item.message, pendingNamePlanId) ? contexts.namePlanWidgetContext : contexts.widgetContext;
      return <NamePlanCard result={item.message.toolResult!} widgetContext={context} />;
    }
    case "prepared-action": return <AgentPreparedActionCard actionId={item.actionId} busy={busy} />;
    case "pending-execution": return pendingExecution ? <ChatMarkdownRenderer content={pendingExecutionToFence(pendingExecution)} widgetRegistry={homeAgentWidgetRegistry}
      widgetContext={contexts.pendingWidgetContext} codeBlock={{ colorTheme: "qiuvision" }} /> : null;
  }
}

const UserMessage = React.memo(function UserMessage({ message }: { message: AgentMessage }) {
  return (
    <div className="group/message flex items-start justify-end gap-1" data-message-role="user">
      <CopyMessageButton text={message.content} />
      <SmoothCorners radius={18} smoothing={0.72} className="max-w-[85%] bg-secondary px-3.5 py-2 text-sm leading-6 text-secondary-foreground">
        <p className="whitespace-pre-wrap wrap-break-word">{message.content}</p>
      </SmoothCorners>
    </div>
  );
});

const AssistantText = React.memo(function AssistantText({ message, widgetContext }: { message: AgentMessage; widgetContext: MarkdownWidgetContext }) {
  return (
    <div className="min-w-0 text-sm leading-relaxed" data-message-role="assistant">
      <ChatMarkdownRenderer
        content={message.content}
        widgetRegistry={homeAgentWidgetRegistry}
        widgetContext={widgetContext}
        codeBlock={{ colorTheme: "qiuvision" }}
      />
    </div>
  );
});

const ToolGroup = React.memo(function ToolGroup({ entries }: { entries: ToolEntry[] }) {
  return <AgentToolGroup entries={entries} />;
}, (prev, next) => prev.entries.length === next.entries.length
  && prev.entries.every((entry, index) => entry.call === next.entries[index].call && entry.result === next.entries[index].result));

const NamePlanCard = React.memo(function NamePlanCard({ result, widgetContext }: { result: AgentToolResult; widgetContext: MarkdownWidgetContext }) {
  return <ChatMarkdownRenderer content={namePlanFence(result)} widgetRegistry={homeAgentWidgetRegistry} widgetContext={widgetContext} codeBlock={{ colorTheme: "qiuvision" }} />;
});

/** What the user did on a card, as FusionKit reported it to the agent. */
const UiEventLine = React.memo(function UiEventLine({ message }: { message: AgentMessage }) {
  const { t } = useTranslation();
  const event = message.event!;
  const values = event.values ?? {};
  const failed = event.kind.endsWith("_failed");
  const dismissed = event.kind.endsWith("_dismissed");
  const Icon = failed ? XCircle : dismissed ? PauseCircle : CheckCircle2;
  const error = typeof values.error === "string" ? actionErrorMessage(values.error, t) : undefined;
  return <div className="flex justify-end" data-message-role="event" data-event-kind={event.kind}>
    <span className={cn("inline-flex max-w-[85%] items-start gap-1.5 rounded-full border px-3 py-1 text-xs leading-5 text-muted-foreground", failed && "border-destructive/30 text-destructive")}>
      <Icon aria-hidden className={cn("mt-1 size-3 shrink-0", !failed && !dismissed && "text-emerald-600 dark:text-emerald-400")} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{t(`home:ui_event_${event.kind}`, { ...values, error })}</span>
    </span>
  </div>;
});

/** Copies a sent message; it appears beside the bubble while the message is hovered or focused. */
function CopyMessageButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  const label = t(copied ? "home:message_copied" : "home:copy_message");
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild>
      <Button type="button" variant="ghost" size="icon" aria-label={label} data-testid="agent-copy-message" onClick={() => void copy()}
        className={cn("mt-1 size-7 shrink-0 rounded-lg text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100",
          "group-hover/message:opacity-100 group-focus-within/message:opacity-100", copied && "opacity-100")}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
  </Tooltip>;
}
