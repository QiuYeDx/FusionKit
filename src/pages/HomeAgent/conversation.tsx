import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { NavigateFunction } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Bot, User, ListPlus, MessageSquareMore, Zap } from "lucide-react";
import useAgentStore from "@/store/agent/useAgentStore";
import AgentToolCallView from "./components/AgentToolCall";
import AgentToolResultView, { isModernToolResult } from "./components/AgentToolResult";
import { actionErrorMessage } from "./components/action-error";
import { createWidgetActionHandler, isNamePlanResultFor } from "./widget-actions";
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

function formatToolResultAsMarkdown(message: AgentMessage, t: TFunction): string {
  const result = message.toolResult;
  const isSuccess = result?.success ?? true;
  const toolName = result?.toolName ?? t("home:tool_execution_fallback");
  const statusMark = isSuccess ? " ✓" : " ✗";
  const raw = message.content;

  if (!isSuccess && result?.error) {
    const details = Array.isArray(result.data?.errors)
      ? (result.data.errors as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 5)
      : [];
    const list = details.map((item) => `\n- \`${item.replace(/`/g, "'")}\``).join("");
    return `**${toolName}**${statusMark}\n\n${actionErrorMessage(result.error, t)}${list}`;
  }

  let body: string;
  try {
    const parsed = result?.data ?? JSON.parse(raw);
    if (isSuccess && result?.toolName === "create_name_translation_plan") {
      return nameTranslationPlanToFence(parsed);
    }
    if (isSuccess && result?.toolName === "apply_name_translation_plan") {
      return nameTranslationApplyResultToFence(parsed);
    }

    if (parsed?.files && Array.isArray(parsed.files)) {
      const count = parsed.totalCount ?? parsed.files.length;
      const names = parsed.files
        .slice(0, 10)
        .map((f: Record<string, unknown>) => `- \`${(f.fileName as string) || f}\``)
        .join("\n");
      const more =
        count > 10
          ? `\n- *...${t("home:tool_result_more_files", { count })}*`
          : "";
      body = `${t("home:tool_result_files_found", { count })}:\n${names}${more}`;
    } else if (parsed?.queuedCount !== undefined) {
      if (parsed?.batch) {
        body = t("home:tool_result_queued_batch_progress", {
          queuedCount: parsed.queuedCount,
          batchStart: Number(parsed.batch.batchStart ?? 0) + 1,
          batchEnd: parsed.batch.batchEnd,
          queuedThrough: parsed.batch.queuedThrough,
          totalFiles: parsed.totalFiles,
          remainingCount: parsed.batch.remainingCount,
        });
        if (parsed.batch.hasMore) {
          body += `\n${t("home:tool_result_queued_batch_more", {
            nextBatchStart: parsed.batch.nextBatchStart,
          })}`;
        }
      } else {
        body = t("home:tool_result_queued_progress", {
          queuedCount: parsed.queuedCount,
          totalFiles: parsed.totalFiles,
        });
      }
    } else if (typeof parsed === "string") {
      body = parsed;
    } else {
      const jsonStr = JSON.stringify(parsed, null, 2);
      body =
        jsonStr.length > 800
          ? "```json\n" + jsonStr.slice(0, 800) + "\n// …(truncated)\n```"
          : "```json\n" + jsonStr + "\n```";
    }
  } catch {
    body = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  }

  return `**${toolName}**${statusMark}\n\n${body}`;
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
}: {
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as ExecutionMode)}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("home:execution_mode_label")}
        data-testid="agent-execution-mode"
        className={cn(
          "h-8 rounded-full border-0 shadow-none -translate-x-0.5",
          "bg-secondary hover:bg-accent/60",
          "text-foreground/65",
          "focus-visible:ring-2 focus-visible:ring-ring/50",
          "cursor-pointer shrink-0",
        )}
      >
        <SelectValue />
      </SelectTrigger>
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
      <div className="flex items-center gap-2 text-muted-foreground text-sm pl-10">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{t("home:agent_thinking")}</span>
      </div>
    ) : null;
  }
  return (
    <div className="flex items-start gap-2.5 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex items-center justify-center rounded-full w-7 h-7 shrink-0 bg-muted text-muted-foreground">
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0 max-w-[80%] text-sm leading-relaxed">
        <ChatMarkdownRenderer
          content={streamingText}
          widgetRegistry={homeAgentWidgetRegistry}
          widgetContext={widgetContext}
          codeBlock={{ colorTheme: "qiuvision" }}
        />
        <div className="mt-2 space-y-2">{activeToolCalls.map(call => <AgentToolCallView key={call.toolCallId} call={call} running />)}</div>
      </div>
    </div>
  );
}

export const MessageBubble = React.memo(
  function MessageBubble({
    message,
    widgetRegistry,
    widgetContext,
    namePlanWidgetContext,
    pendingNamePlanId,
    toolResults,
  }: {
    message: AgentMessage;
    widgetRegistry: MarkdownWidgetRegistry;
    widgetContext: MarkdownWidgetContext;
    namePlanWidgetContext: MarkdownWidgetContext;
    pendingNamePlanId?: string;
    toolResults: ReadonlyMap<string, AgentToolResult>;
  }) {
    const { t } = useTranslation();
    const isUser = message.role === "user";
    const isTool = message.role === "tool";

    if (isUser) {
      return (
        <div className="flex items-start gap-2.5 flex-row-reverse">
          <div className="flex items-center justify-center rounded-full w-7 h-7 shrink-0 bg-primary text-primary-foreground">
            <User className="h-3.5 w-3.5" />
          </div>
          <div className="relative rounded-sm px-4 py-2.5 max-w-[80%] text-sm leading-relaxed bg-primary text-primary-foreground chat-bubble-user">
            <p className="whitespace-pre-wrap wrap-break-word">
              {message.content}
            </p>
          </div>
        </div>
      );
    }

    if (isTool) {
      if (message.toolResult && isModernToolResult(message.toolResult.toolName)) {
        return <div className="pl-10"><AgentToolResultView result={message.toolResult} /></div>;
      }
      return (
        <div className="pl-10">
          <ChatMarkdownRenderer
            content={formatToolResultAsMarkdown(message, t)}
            widgetRegistry={widgetRegistry}
            widgetContext={isNamePlanResultFor(message, pendingNamePlanId) ? namePlanWidgetContext : widgetContext}
            codeBlock={{ colorTheme: "qiuvision" }}
          />
        </div>
      );
    }

    const content = message.content || "";
    if (!content.trim() && !message.toolCalls?.length) return null;

    return (
      <div className="flex items-start gap-2.5">
        <div className="flex items-center justify-center rounded-full w-7 h-7 shrink-0 bg-muted text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0 max-w-[80%] text-sm leading-relaxed">
          <ChatMarkdownRenderer
            content={content}
            widgetRegistry={widgetRegistry}
            widgetContext={widgetContext}
            codeBlock={{ colorTheme: "qiuvision" }}
          />
          {!!message.toolCalls?.length && <div className="mt-2 space-y-2">{message.toolCalls.map(call => <AgentToolCallView key={call.toolCallId} call={call} result={toolResults.get(call.toolCallId)} />)}</div>}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.widgetRegistry === next.widgetRegistry &&
    prev.widgetContext === next.widgetContext &&
    prev.namePlanWidgetContext === next.namePlanWidgetContext &&
    prev.pendingNamePlanId === next.pendingNamePlanId &&
    prev.toolResults === next.toolResults,
);
