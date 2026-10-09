import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { NavigateFunction } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Check, Copy, Loader2, ListPlus, MessageSquareMore, Zap } from "lucide-react";
import useAgentStore from "@/store/agent/useAgentStore";
import AgentToolCallView from "./components/AgentToolCall";
import { isModernToolResult } from "./components/AgentToolResult";
import { actionErrorMessage } from "./components/action-error";
import { createWidgetActionHandler, isNamePlanResultFor } from "./widget-actions";
import type {
  AgentMessage,
  AgentToolCall,
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

function nameTranslationPlanToFence(
  plan: Record<string, unknown>,
): string {
  return (
    "```qv:name-translation-plan\n" +
    JSON.stringify(plan) +
    "\n```"
  );
}

function nameTranslationApplyResultToFence(
  result: Record<string, unknown>,
): string {
  return (
    "```qv:name-translation-apply-result\n" +
    JSON.stringify(result) +
    "\n```"
  );
}

const NAME_PLAN_TOOLS = ["create_name_translation_plan", "apply_name_translation_plan"];

/** Name translation plans render as their own interactive widget below the tool card. */
function namePlanFence(result: AgentToolResult): string | null {
  if (!result.success || !result.data || typeof result.data !== "object") return null;
  if (result.toolName === "create_name_translation_plan") return nameTranslationPlanToFence(result.data);
  if (result.toolName === "apply_name_translation_plan") return nameTranslationApplyResultToFence(result.data);
  return null;
}

/** The body of a classic tool's card: what it found or queued, or why it failed. */
function ClassicResultBody({ result }: { result: AgentToolResult }) {
  const { t } = useTranslation();
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, any> : undefined;
  if (!result.success) {
    const details = Array.isArray(data?.errors) ? (data.errors as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 5) : [];
    return <div className="space-y-1.5 text-xs leading-5 text-destructive">
      <p className="[overflow-wrap:anywhere]">{result.error ? actionErrorMessage(result.error, t) : t("home:action_failed")}</p>
      {details.length > 0 && <ul className="space-y-0.5 rounded-lg bg-destructive/5 px-2.5 py-1.5 font-mono text-[11px]">{details.map((item, index) => <li key={index} className="[overflow-wrap:anywhere]">{item}</li>)}</ul>}
    </div>;
  }
  if (NAME_PLAN_TOOLS.includes(result.toolName) || !data) return null;
  if (Array.isArray(data.files)) {
    const count = Number(data.totalCount ?? data.files.length);
    const names = (data.files as unknown[]).slice(0, 10).map(file => typeof file === "string" ? file : String((file as Record<string, unknown>)?.fileName ?? ""));
    return <div className="space-y-2 text-xs leading-5">
      <p>{t("home:tool_result_files_found", { count })}</p>
      {names.length > 0 && <ul className="divide-y divide-border/60 rounded-lg bg-muted/40 px-2.5">{names.map((name, index) => <li key={index} className="py-1 [overflow-wrap:anywhere]">{name}</li>)}</ul>}
      {count > 10 && <p className="text-[11px] text-muted-foreground">{t("home:tool_result_more_files", { count })}</p>}
    </div>;
  }
  if (data.queuedCount !== undefined) {
    const lines = data.batch ? [t("home:tool_result_queued_batch_progress", { queuedCount: data.queuedCount, batchStart: Number(data.batch.batchStart ?? 0) + 1,
      batchEnd: data.batch.batchEnd, queuedThrough: data.batch.queuedThrough, totalFiles: data.totalFiles, remainingCount: data.batch.remainingCount }),
      ...(data.batch.hasMore ? [t("home:tool_result_queued_batch_more", { nextBatchStart: data.batch.nextBatchStart })] : [])]
      : [t("home:tool_result_queued_progress", { queuedCount: data.queuedCount, totalFiles: data.totalFiles })];
    return <div className="space-y-1 text-xs leading-5">{lines.map((line, index) => <p key={index} className={index ? "text-muted-foreground" : undefined}>{line}</p>)}</div>;
  }
  return null;
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
  const pendingWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, role: "tool", onWidgetAction: createWidgetActionHandler(sessionId, useAgentStore.getState, navigate,
      pendingExecution ? { kind: "pending-execution", pending: pendingExecution } : { kind: "display" }) }),
    [widgetContext, sessionId, navigate, pendingExecution],
  );
  const namePlanWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, role: "tool", onWidgetAction: createWidgetActionHandler(sessionId, useAgentStore.getState, navigate,
      pendingNameTranslationPlan ? { kind: "name-translation-plan", plan: pendingNameTranslationPlan } : { kind: "display" }) }),
    [widgetContext, sessionId, navigate, pendingNameTranslationPlan],
  );
  return { widgetContext, streamingWidgetContext, pendingWidgetContext, namePlanWidgetContext };
}

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
      {activeToolCalls.map(call => <AgentToolCallView key={call.toolCallId} call={call} running />)}
    </div>
  );
}

/** Results by call, and the calls that assistant messages show, so result messages do not repeat them. */
export function useConversationIndex(messages: readonly AgentMessage[]) {
  return useMemo(() => ({
    toolResults: new Map(messages.flatMap(message => message.toolResult ? [[message.toolResult.callId, message.toolResult] as const] : [])) as ReadonlyMap<string, AgentToolResult>,
    toolCallIds: new Set(messages.flatMap(message => message.toolCalls?.map(call => call.toolCallId) ?? [])) as ReadonlySet<string>,
  }), [messages]);
}

export const MessageBubble = React.memo(
  function MessageBubble({
    message,
    widgetRegistry,
    widgetContext,
    namePlanWidgetContext,
    pendingNamePlanId,
    toolResults,
    toolCallIds,
  }: {
    message: AgentMessage;
    widgetRegistry: MarkdownWidgetRegistry;
    widgetContext: MarkdownWidgetContext;
    namePlanWidgetContext: MarkdownWidgetContext;
    pendingNamePlanId?: string;
    toolResults: ReadonlyMap<string, AgentToolResult>;
    toolCallIds: ReadonlySet<string>;
  }) {
    if (message.role === "user") {
      return (
        <div className="group/message flex items-start justify-end gap-1" data-message-role="user">
          <CopyMessageButton text={message.content} />
          <SmoothCorners radius={18} smoothing={0.72} className="max-w-[85%] bg-secondary px-3.5 py-2 text-sm leading-6 text-secondary-foreground">
            <p className="whitespace-pre-wrap wrap-break-word">{message.content}</p>
          </SmoothCorners>
        </div>
      );
    }

    if (message.role === "tool") {
      const result = message.toolResult;
      if (!result) return null;
      const fence = namePlanFence(result);
      if (fence) {
        return <ChatMarkdownRenderer content={fence} widgetRegistry={widgetRegistry}
          widgetContext={isNamePlanResultFor(message, pendingNamePlanId) ? namePlanWidgetContext : widgetContext} codeBlock={{ colorTheme: "qiuvision" }} />;
      }
      // The assistant message that made the call already shows this result in its card.
      if (toolCallIds.has(result.callId)) return null;
      return <ToolCard call={{ toolCallId: result.callId, toolName: result.toolName, args: {} }} result={result} />;
    }

    const content = message.content || "";
    if (!content.trim() && !message.toolCalls?.length) return null;

    return (
      <div className="min-w-0 space-y-2 text-sm leading-relaxed" data-message-role="assistant">
        {content.trim() && <ChatMarkdownRenderer
          content={content}
          widgetRegistry={widgetRegistry}
          widgetContext={widgetContext}
          codeBlock={{ colorTheme: "qiuvision" }}
        />}
        {message.toolCalls?.map(call => <ToolCard key={call.toolCallId} call={call} result={toolResults.get(call.toolCallId)} />)}
      </div>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.widgetRegistry === next.widgetRegistry &&
    prev.widgetContext === next.widgetContext &&
    prev.namePlanWidgetContext === next.namePlanWidgetContext &&
    prev.pendingNamePlanId === next.pendingNamePlanId &&
    prev.toolResults === next.toolResults &&
    prev.toolCallIds === next.toolCallIds,
);

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

function ToolCard({ call, result }: { call: AgentToolCall; result?: AgentToolResult }) {
  const classic = result && !isModernToolResult(result.toolName);
  return <AgentToolCallView call={call} result={result} body={classic ? <ClassicResultBody result={result} /> : undefined} />;
}
