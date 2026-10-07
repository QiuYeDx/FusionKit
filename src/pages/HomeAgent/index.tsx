import React, {
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import {
  Send,
  Loader2,
  Bot,
  User,
  RotateCcw,
  Sparkles,
  ListPlus,
  MessageSquareMore,
  Zap,
  Square,
  Settings,
  AlertTriangle,
  Activity,
  ScrollText,
  Download,
  Upload,
  ArrowDown,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { handleUserMessage, abortCurrentStream } from "@/agent/orchestrator";
import { isAgentProfileApiFormatSupported } from "@/agent/api-format-capability";
import { exportSession, importSession } from "@/agent/session-io";
import SessionLogViewer from "./SessionLogViewer";
import AgentPlanPanel from "./components/AgentPlanPanel";
import AgentCapabilities from "./components/AgentCapabilities";
import AgentPreparedActions from "./components/AgentPreparedActions";
import AgentToolCallView from "./components/AgentToolCall";
import AgentToolResultView, { isModernToolResult } from "./components/AgentToolResult";
import { actionErrorMessage } from "./components/action-error";
import { createWidgetActionHandler, isNamePlanResultFor } from "./widget-actions";
import { appendProgressPrompt } from "./presentation";
import type {
  AgentMessage,
  AgentToolResult,
  ExecutionMode,
  PendingExecution,
  TaskStoreType,
} from "@/agent/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { inferContextWindowSize } from "@/constants/model";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import FusionKitLogo from "@/assets/FusionKit.svg";
import { getFilePathFromFile } from "@/utils/filePath";
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

// ---------------------------------------------------------------------------
// Persist draft input across in-app navigation (reset on full page reload)
// ---------------------------------------------------------------------------

let draftInputCache = "";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

const SCROLL_BOTTOM_THRESHOLD = 8;
const EMPTY_STATE_LAYOUT_TRANSITION = {
  type: "spring",
  bounce: 0,
  duration: 0.8,
} as const;

// ---------------------------------------------------------------------------
// Widget registry (builtin + pending-execution)
// ---------------------------------------------------------------------------

const homeAgentWidgetRegistry: MarkdownWidgetRegistry = {
  ...builtinWidgetRegistry,
  [pendingExecutionWidget.type]: pendingExecutionWidget,
  [nameTranslationPlanWidget.type]: nameTranslationPlanWidget,
  [nameTranslationApplyResultWidget.type]: nameTranslationApplyResultWidget,
};

// ---------------------------------------------------------------------------
// Structured data → Widget fence converters
// ---------------------------------------------------------------------------

function pendingExecutionToFence(pe: PendingExecution): string {
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

// ---------------------------------------------------------------------------

function HomeAgent() {
  const { t } = useTranslation();
  const [input, setInput] = useState(draftInputCache);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomComposerRef = useRef<HTMLDivElement>(null);
  const [bottomComposerHeight, setBottomComposerHeight] = useState(0);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const confirmResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [logOpen, setLogOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [sessionFeedback, setSessionFeedback] = useState<string | null>(null);

  // Streaming text and in-flight tool calls are read by StreamingAssistant only, so
  // token deltas do not re-render the whole page.
  const {
    session,
    isStreaming,
    resetSession,
    executionMode,
    setExecutionMode,
    pendingExecution,
    pendingNameTranslationPlan,
    hasSessionLog,
  } = useAgentStore(useShallow((state) => ({
    session: state.session,
    isStreaming: state.isStreaming,
    resetSession: state.resetSession,
    executionMode: state.executionMode,
    setExecutionMode: state.setExecutionMode,
    pendingExecution: state.pendingExecution,
    pendingNameTranslationPlan: state.pendingNameTranslationPlan,
    hasSessionLog: state.sessionLog.length > 0,
  })));
  const { messages, status } = session;
  const isEmpty = messages.length === 0;
  const toolResults = useMemo(() => new Map(messages.flatMap(message => message.toolResult ? [[message.toolResult.callId, message.toolResult] as const] : [])), [messages]);

  const agentProfile = useModelStore((s) => s.getAgentProfile());
  const hasAgentConfig = !!agentProfile?.apiKey?.trim();
  const hasUnsupportedAgentApiFormat =
    hasAgentConfig && !isAgentProfileApiFormatSupported(agentProfile);
  const agentApiFormatLabel =
    agentProfile?.apiFormat === "responses"
      ? t("home:api_format_responses")
      : t("home:api_format_chat_completions");

  const [isMultiline, setIsMultiline] = useState(() => draftInputCache.includes("\n"));
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const setBottomState = useCallback((nextIsAtBottom: boolean) => {
    isAtBottomRef.current = nextIsAtBottom;
    setIsAtBottom((prev) =>
      prev === nextIsAtBottom ? prev : nextIsAtBottom,
    );
  }, []);

  const updateScrollPosition = useCallback(() => {
    const el = scrollViewportRef.current;
    if (!el) return;

    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setBottomState(distanceToBottom <= SCROLL_BOTTOM_THRESHOLD);
  }, [setBottomState]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = scrollViewportRef.current;
      if (!el) return;

      setBottomState(true);
      el.scrollTo({
        top: Math.max(0, el.scrollHeight - el.clientHeight),
        behavior,
      });
    },
    [setBottomState],
  );

  const scheduleScrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }

      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (!isAtBottomRef.current) return;
        scrollToBottom(behavior);
      });
    },
    [scrollToBottom],
  );

  // Input history navigation (Up/Down arrow), persisted across sessions
  const INPUT_HISTORY_KEY = "fusionkit-input-history";
  const INPUT_HISTORY_MAX = 50;
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");
  const inputHistoryRef = useRef<string[]>(null!);
  if (inputHistoryRef.current === null) {
    try {
      const raw = localStorage.getItem(INPUT_HISTORY_KEY);
      inputHistoryRef.current = raw ? JSON.parse(raw) : [];
    } catch {
      inputHistoryRef.current = [];
    }
  }
  const pushHistory = (text: string) => {
    const hist = inputHistoryRef.current;
    if (hist[hist.length - 1] === text) return;
    hist.push(text);
    if (hist.length > INPUT_HISTORY_MAX) hist.splice(0, hist.length - INPUT_HISTORY_MAX);
    localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(hist));
  };

  useEffect(() => {
    draftInputCache = input;
  }, [input]);

  useEffect(() => {
    if (!isMultiline && input.includes("\n")) {
      setIsMultiline(true);
    } else if (isMultiline && input === "") {
      setIsMultiline(false);
    }
  }, [input, isMultiline]);

  useLayoutEffect(() => {
    const composer = bottomComposerRef.current;
    if (isEmpty || !composer) return;
    // Layout height excludes shared-layout transforms during the empty-state handoff.
    const measure = () => setBottomComposerHeight(composer.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [isEmpty]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const viewport = root.closest<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;

    scrollViewportRef.current = viewport;
    viewport.addEventListener("scroll", updateScrollPosition, {
      passive: true,
    });

    const resizeObserver = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        scheduleScrollToBottom("auto");
      } else {
        updateScrollPosition();
      }
    });
    resizeObserver.observe(root);

    if (isAtBottomRef.current) {
      scheduleScrollToBottom("auto");
    } else {
      updateScrollPosition();
    }

    return () => {
      viewport.removeEventListener("scroll", updateScrollPosition);
      resizeObserver.disconnect();
      if (scrollViewportRef.current === viewport) {
        scrollViewportRef.current = null;
      }
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [scheduleScrollToBottom, updateScrollPosition]);

  useLayoutEffect(() => {
    if (isEmpty) {
      setBottomState(true);
      return;
    }

    if (!isAtBottomRef.current) {
      updateScrollPosition();
      return;
    }

    scheduleScrollToBottom("auto");
  }, [
    isEmpty,
    isStreaming,
    messages.length,
    pendingExecution,
    scheduleScrollToBottom,
    setBottomState,
    status,
    updateScrollPosition,
  ]);

  useEffect(() => {
    return () => {
      if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
    };
  }, []);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isMultiline]);

  const navigate = useNavigate();

  const widgetContext = useMemo<MarkdownWidgetContext>(
    () => ({
      conversationId: session.id,
      role: "assistant",
      density: "compact",
      onWidgetAction: createWidgetActionHandler(session.id, useAgentStore.getState, navigate),
    }),
    [session.id, navigate],
  );
  const streamingWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, isStreaming: true }),
    [widgetContext],
  );
  const pendingWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, role: "tool", onWidgetAction: createWidgetActionHandler(session.id, useAgentStore.getState, navigate,
      pendingExecution ? { kind: "pending-execution", pending: pendingExecution } : { kind: "display" }) }),
    [widgetContext, session.id, navigate, pendingExecution],
  );
  const namePlanWidgetContext = useMemo<MarkdownWidgetContext>(
    () => ({ ...widgetContext, role: "tool", onWidgetAction: createWidgetActionHandler(session.id, useAgentStore.getState, navigate,
      pendingNameTranslationPlan ? { kind: "name-translation-plan", plan: pendingNameTranslationPlan } : { kind: "display" }) }),
    [widgetContext, session.id, navigate, pendingNameTranslationPlan],
  );

  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      textareaRef.current?.focus();
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const handleResetClick = () => {
    if (confirmingReset) {
      setConfirmingReset(false);
      if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
      resetSession();
      setImportError(null);
      setSessionFeedback(null);
    } else {
      setConfirmingReset(true);
      confirmResetTimer.current = setTimeout(
        () => setConfirmingReset(false),
        3000,
      );
    }
  };

  const handleExport = async () => {
    setImportError(null);
    setSessionFeedback(null);
    const result = await exportSession();
    if (result.success) setSessionFeedback(t("home:session_exported"));
    else if (!result.cancelled) {
      const labels = { too_large: "home:export_error_too_large", invalid: "home:export_error_invalid", save_failed: "home:export_error_save" } as const;
      setImportError(t(labels[result.errorCode ?? "save_failed"]));
    }
  };

  const handleImport = async () => {
    setImportError(null);
    setSessionFeedback(null);
    const result = await importSession();
    if (!result.success && result.error) {
      setImportError(`${t("home:import_failed")}: ${result.error}`);
    }
    if (result.success) setSessionFeedback(t("home:session_imported"));
  };

  const handleCheckProgress = () => {
    setInput(current => appendProgressPrompt(current, t("home:plan_check_prompt")));
    setSessionFeedback(t("home:plan_check_draft_added"));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || !hasAgentConfig || hasUnsupportedAgentApiFormat) return;
    setSessionFeedback(null);
    pushHistory(trimmed);
    setInput("");
    historyIndexRef.current = -1;
    draftRef.current = "";
    await handleUserMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
      return;
    }

    const hist = inputHistoryRef.current;
    if (e.key === "ArrowUp" && hist.length > 0) {
      const el = textareaRef.current;
      const isAtStart = !el || el.selectionStart === 0;
      const isSingleLine = !input.includes("\n");
      if (isAtStart && isSingleLine) {
        e.preventDefault();
        if (historyIndexRef.current === -1) {
          draftRef.current = input;
        }
        const nextIdx = Math.min(
          historyIndexRef.current + 1,
          hist.length - 1,
        );
        historyIndexRef.current = nextIdx;
        setInput(hist[hist.length - 1 - nextIdx]);
      }
    }

    if (e.key === "ArrowDown" && historyIndexRef.current >= 0) {
      const el = textareaRef.current;
      const isAtEnd = !el || el.selectionStart === el.value.length;
      const isSingleLine = !input.includes("\n");
      if (isAtEnd && isSingleLine) {
        e.preventDefault();
        const nextIdx = historyIndexRef.current - 1;
        historyIndexRef.current = nextIdx;
        if (nextIdx < 0) {
          setInput(draftRef.current);
        } else {
          setInput(hist[hist.length - 1 - nextIdx]);
        }
      }
    }
  };

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      dragCounterRef.current = 0;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const paths = files
        .map((f) => getFilePathFromFile(f))
        .filter((p): p is string => !!p);

      if (paths.length === 0) return;

      const pathText = paths.map((p) => `\`${p}\``).join(" ");
      setInput((prev) => {
        const trimmed = prev.trimEnd();
        return trimmed ? `${trimmed} ${pathText}` : pathText;
      });

      textareaRef.current?.focus();
    },
    [],
  );

  const canSend =
    input.trim().length > 0 && !isStreaming && hasAgentConfig && !hasUnsupportedAgentApiFormat;
  const showScrollToBottomButton = !isEmpty && !isAtBottom;
  const hasActiveResponse =
    isStreaming || status === "thinking" || status === "streaming";
  const agentConfigNotice =
    !hasAgentConfig || hasUnsupportedAgentApiFormat ? (
      <motion.div
        layout="position"
        transition={EMPTY_STATE_LAYOUT_TRANSITION}
        className="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/5 max-w-md mx-auto mb-4 z-10"
      >
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
        <span className="text-sm text-amber-700 dark:text-amber-400 flex-1">
          {hasUnsupportedAgentApiFormat
            ? t("home:agent_api_format_unsupported", {
                format: agentApiFormatLabel,
              })
            : t("home:agent_not_configured")}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1 text-xs rounded-full"
          onClick={() => navigate("/setting")}
        >
          <Settings className="h-3 w-3" />
          {t("home:go_settings")}
        </Button>
      </motion.div>
    ) : null;
  const inputCapsule = (
    <motion.div layout transition={EMPTY_STATE_LAYOUT_TRANSITION}>
        {!isEmpty && (
          <div
            data-testid="agent-composer-toolbar"
            className="max-w-2xl mx-auto mb-2 pointer-events-auto flex flex-wrap items-end justify-between gap-2"
          >
            <TokenStatsBar className="max-w-none mx-0 mb-0" />
            <div className="flex items-center gap-1 ml-auto translate-y-1">
              <AgentCapabilities />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLogOpen(true)}
                data-testid="agent-logs-trigger"
                disabled={!hasSessionLog}
                className="h-7 px-2 text-xs text-muted-foreground/60 hover:text-foreground rounded-full disabled:opacity-30"
                title={t("home:session_log_title")}
              >
                <ScrollText className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExport}
                data-testid="agent-export"
                disabled={isStreaming || messages.length === 0}
                className="h-7 px-2 text-xs text-muted-foreground/60 hover:text-foreground rounded-full disabled:opacity-30"
                title={t("home:export_session")}
              >
                <Upload className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleImport}
                data-testid="agent-import"
                disabled={isStreaming}
                className="h-7 px-2 text-xs text-muted-foreground/60 hover:text-foreground rounded-full disabled:opacity-30"
                title={t("home:import_session")}
              >
                <Download className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                onClick={handleResetClick}
                disabled={isStreaming}
                className={cn(
                  "h-7 px-2 text-xs text-muted-foreground/60 hover:text-foreground rounded-full disabled:opacity-30",
                  "dark:bg-background dark:hover:bg-accent shadow-none",
                  confirmingReset
                    ? "text-destructive hover:text-destructive/80"
                    : "text-muted-foreground/80 hover:text-foreground",
                )}
              >
                <RotateCcw className="h-3 w-3" />
                {confirmingReset
                  ? t("home:confirm_new_conversation")
                  : t("home:new_conversation")}
              </Button>
            </div>
          </div>
        )}

      {/* Import error toast */}
      <AnimatePresence>
        {importError && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="max-w-2xl mx-auto mb-2 pointer-events-auto"
          >
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span role="alert" className="min-w-0 flex-1 [overflow-wrap:anywhere]" data-testid="agent-session-error">{importError}</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setImportError(null)}>{t("home:feedback_dismiss")}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {sessionFeedback && <p className="max-w-2xl mx-auto mb-2 px-2 text-xs leading-5 text-muted-foreground" role="status" aria-live="polite" data-testid="agent-session-feedback">{sessionFeedback}</p>}

      <motion.div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "shadow-sm relative",
          "bg-background",
          "focus-within:shadow-md focus-within:border-ring/50",
          "max-w-2xl mx-auto w-full",
          "pointer-events-auto",
          "transition-colors duration-150",
          isDragOver && "bg-primary/5 ring-2 ring-primary/40 ring-inset",
        )}
      >
        <AnimatePresence>
          {isDragOver && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-60 flex items-center justify-center rounded-3xl pointer-events-none"
            >
              <span className="text-xs text-primary font-medium">
                {t("home:drop_files_hint")}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          layout
          className={cn(
            "px-1.5 py-1",
            isMultiline ? "flex flex-col gap-1" : "flex items-center gap-1.5",
          )}
        >
          {!isMultiline && (
            <motion.div
              layout="position"
              layoutId="capsule-mode"
              className="shrink-0"
            >
              <CapsuleModeSelector
                value={executionMode}
                onChange={setExecutionMode}
                disabled={isStreaming}
              />
            </motion.div>
          )}
          <motion.div
            layout="preserve-aspect"
            className={isMultiline ? "w-full" : "flex-1 min-w-0"}
          >
            <Textarea
              data-testid="agent-input"
              aria-label={t("home:agent_input_label")}
              ref={textareaRef}
              rows={1}
              placeholder={t("home:agent_input_placeholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              className="bg-transparent border-0 shadow-none rounded-none min-h-0 px-1.5 py-1 text-sm placeholder:text-muted-foreground/70 disabled:opacity-50 resize-none max-h-40 overflow-y-auto focus-visible:ring-0 focus-visible:border-transparent dark:bg-transparent"
            />
          </motion.div>
          {isMultiline ? (
            <div className="flex items-center justify-between">
              <motion.div
                layout="position"
                layoutId="capsule-mode"
                className="shrink-0"
              >
                <CapsuleModeSelector
                  value={executionMode}
                  onChange={setExecutionMode}
                  disabled={isStreaming}
                />
              </motion.div>
              <motion.div
                layout="position"
                layoutId="capsule-send"
                className="shrink-0"
              >
                <Button
                  aria-label={isStreaming ? t("home:stop_response") : t("home:send_message")}
                  data-testid="agent-send"
                  onClick={
                    isStreaming ? () => abortCurrentStream() : handleSend
                  }
                  disabled={!isStreaming && !canSend}
                  className={cn(
                    "flex items-center justify-center rounded-full w-8 h-8 shrink-0",
                    "transition-all duration-200",
                    isStreaming
                      ? "shadow-sm hover:bg-destructive"
                      : canSend
                        ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90"
                        : "bg-transparent text-muted-foreground/45",
                  )}
                >
                  {isStreaming ? (
                    <Square className="h-3.5 w-3.5 fill-current" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </motion.div>
            </div>
          ) : (
            <motion.div
              layout="position"
              layoutId="capsule-send"
              className="ml-auto shrink-0"
            >
              <Button
                aria-label={isStreaming ? t("home:stop_response") : t("home:send_message")}
                data-testid="agent-send"
                onClick={isStreaming ? () => abortCurrentStream() : handleSend}
                disabled={!isStreaming && !canSend}
                className={cn(
                  "flex items-center justify-center rounded-full w-8 h-8 shrink-0",
                  "transition-all duration-200",
                  isStreaming
                    ? "shadow-sm hover:bg-destructive"
                    : canSend
                      ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90"
                      : "bg-transparent text-muted-foreground/45",
                )}
              >
                {isStreaming ? (
                  <Square className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </motion.div>
          )}
        </motion.div>
        {/* 模拟四角边框 */}
        <motion.div
          layout
          className="size-5 absolute z-50 top-0 left-0 rounded-tl-3xl border-l border-t border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
        <motion.div
          layout
          className="size-5 absolute z-50 top-0 right-0 rounded-tr-3xl border-r border-t border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
        <motion.div
          layout
          className="size-5 absolute z-50 bottom-0 left-0 rounded-bl-3xl border-b border-l border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
        <motion.div
          layout
          className="size-5 absolute z-50 bottom-0 right-0 rounded-br-3xl border-b border-r border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
        {/* 模拟四边边框 */}
        <motion.div
          layout
          className="absolute z-50 top-0 left-5 h-0 w-[calc(100%-2.5rem)] border-t border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
        <motion.div
          layout
          className="absolute z-50 bottom-0 left-5 h-0 w-[calc(100%-2.5rem)] border-b border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
        <motion.div
          layout
          className="absolute z-50 top-5 left-0 w-0 min-h-px h-[calc(100%-2.5rem)] border-l border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
        <motion.div
          layout
          className="absolute z-50 top-5 right-0 w-0 min-h-px h-[calc(100%-2.5rem)] border-r border-[oklch(0.922_0_0)] dark:border-[oklch(0.231_0_0)]"
        ></motion.div>
      </motion.div>
    </motion.div>
  );

  return (
    <div
      ref={rootRef}
      data-testid="home-agent"
      className="relative flex min-h-[calc(100dvh-120px)] flex-col"
    >
      {/* ===== Empty State ===== */}
      {isEmpty && (
        <motion.div
          layout
          transition={EMPTY_STATE_LAYOUT_TRANSITION}
          className="flex flex-1 flex-col items-center justify-center px-4 pb-28 pt-8 animate-in fade-in duration-500"
        >
          {/* Concentric Circles + Logo */}
          <motion.div
            layout="position"
            transition={EMPTY_STATE_LAYOUT_TRANSITION}
            className="relative flex items-center justify-center mb-8 z-0"
          >
            <div
              className="absolute w-48 h-48 rounded-full border border-border/25"
              style={{ animation: "ring-breathe 6s ease-in-out infinite" }}
            />
            <div
              className="absolute w-36 h-36 rounded-full border border-border/45"
              style={{
                animation: "ring-breathe 5s ease-in-out infinite 0.8s",
              }}
            />
            <div
              className="absolute w-24 h-24 rounded-full border border-border/75"
              style={{
                animation: "ring-breathe 4s ease-in-out infinite 1.6s",
              }}
            />
            <img
              src={FusionKitLogo}
              alt="FusionKit"
              className="w-12 h-12 rounded-xl relative z-10"
            />
          </motion.div>

          <motion.h1
            layout="position"
            transition={EMPTY_STATE_LAYOUT_TRANSITION}
            className="text-xl font-semibold tracking-tight mt-4 mb-4 z-10"
          >
            {t("home:agent_title")}
          </motion.h1>
          <motion.p
            layout="position"
            transition={EMPTY_STATE_LAYOUT_TRANSITION}
            className="text-sm text-muted-foreground max-w-sm text-center mb-6 z-10"
          >
            {t("home:home_description")}
          </motion.p>

          {agentConfigNotice}

          <motion.div
            layout
            layoutId="input-capsule"
            transition={EMPTY_STATE_LAYOUT_TRANSITION}
            className="z-20 mt-7 w-full pointer-events-none"
          >
            {inputCapsule}
          </motion.div>

          {/* Suggestion Pills */}
          <motion.div
            layout="position"
            transition={EMPTY_STATE_LAYOUT_TRANSITION}
            className="mt-6 flex flex-wrap justify-center gap-2 max-w-xl"
          >
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text={t("home:suggestion_studio")}
              onClick={() => {
                setInput(t("home:suggestion_studio_prompt"));
                textareaRef.current?.focus();
              }}
            />
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text={t("home:suggestion_lrc_to_srt")}
              onClick={() => {
                setInput(t("home:suggestion_lrc_to_srt_prompt"));
                textareaRef.current?.focus();
              }}
            />
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text={t("home:suggestion_extract_chinese")}
              onClick={() => {
                setInput(t("home:suggestion_extract_chinese_prompt"));
                textareaRef.current?.focus();
              }}
            />
          </motion.div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2"><AgentCapabilities /><Button variant="ghost" size="sm" className="h-7 gap-1.5 rounded-full px-2 text-xs text-muted-foreground" data-testid="agent-import-empty" onClick={handleImport}><Download className="size-3.5" />{t("home:import_session")}</Button></div>
        </motion.div>
      )}

      {/* ===== Message List ===== */}
      {!isEmpty && (
        <div className="relative flex-1 min-h-0">
          <div className="pointer-events-none fixed inset-x-0 -top-2 z-20 h-12 bg-linear-to-b from-background via-background/80 to-transparent" />
          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 h-28 bg-linear-to-t from-background via-background/90 to-transparent" />

          <div className="px-4 pt-2 pb-2">
            <div className="max-w-2xl mx-auto space-y-4 pt-1" style={{ paddingBottom: Math.max(176, bottomComposerHeight + 42 + 16) }}>
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  widgetRegistry={homeAgentWidgetRegistry}
                  widgetContext={widgetContext}
                  namePlanWidgetContext={namePlanWidgetContext}
                  pendingNamePlanId={pendingNameTranslationPlan?.planId}
                  toolResults={toolResults}
                />
              ))}

              {isStreaming && <StreamingAssistant widgetContext={streamingWidgetContext} />}

              <AgentPreparedActions key={session.id} sessionId={session.id} busy={isStreaming} />
              {session.plan && <AgentPlanPanel key={session.plan.id} plan={session.plan} onCheckProgress={handleCheckProgress} busy={isStreaming} />}

              {/* Pending execution widget */}
              {pendingExecution && !isStreaming && (
                <div className="pl-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <ChatMarkdownRenderer
                    content={pendingExecutionToFence(pendingExecution)}
                    widgetRegistry={homeAgentWidgetRegistry}
                    widgetContext={pendingWidgetContext}
                    codeBlock={{ colorTheme: "qiuvision" }}
                  />
                </div>
              )}

              {/* pendingNameTranslationPlan is NOT rendered here because the
                 tool result message already contains a NameTranslationPlanWidget
                 that reads live state from the store. Rendering it again would
                 cause a duplicate card. */}
            </div>
          </div>

          <AnimatePresence>
            {showScrollToBottomButton && (
              <motion.div
                initial={{ opacity: 0, y: 42, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 42, scale: 0.8 }}
                transition={{ type: "spring", bounce: 0, duration: 0.3 }}
                className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4"
                style={{ bottom: Math.max(142, bottomComposerHeight + 42 + 8) }}
              >
                <Button
                  variant="outline"
                  size={hasActiveResponse ? "sm" : "icon"}
                  aria-label={t("home:scroll_to_bottom")}
                  title={t("home:scroll_to_bottom")}
                  onClick={() => scrollToBottom("smooth")}
                  className={cn(
                    "pointer-events-auto border-border/60 bg-background/72 text-foreground/75 backdrop-blur-[5px]",
                    "shadow-[0_3px_10px_rgba(0,0,0,0.08)] ring-1 ring-background/35 hover:bg-background/84 hover:text-foreground",
                    "dark:bg-background/58 dark:ring-foreground/5 dark:hover:bg-background/72",
                    hasActiveResponse
                      ? "h-8 w-[52px] gap-0 rounded-[18px] px-0"
                      : "h-9 w-9 rounded-full",
                  )}
                >
                  {hasActiveResponse ? (
                    <ScrollToBottomLoadingDots />
                  ) : (
                    <ArrowDown className="h-4 w-4" />
                  )}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ===== Bottom Input Area ===== */}
      {!isEmpty && (
        <>
          <div className="pointer-events-none fixed inset-x-0 bottom-0 h-32 bg-linear-to-b from-transparent via-background/95 to-background" />
          <motion.div
            ref={bottomComposerRef}
            data-testid="agent-bottom-composer"
            layoutId="input-capsule"
            // transition={{
            //   type: "spring",
            //   bounce: 0,
            //   duration: 0.8,
            // }}
            className="fixed inset-x-0 bottom-[42px] z-20 pointer-events-none"
          >
            <div className="relative px-4 pt-3 pb-4 pointer-events-none">
              {agentConfigNotice}
              {inputCapsule}
            </div>
          </motion.div>
        </>
      )}

      <SessionLogViewer open={logOpen} onOpenChange={setLogOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CapsuleModeSelector({
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
function StreamingAssistant({ widgetContext }: { widgetContext: MarkdownWidgetContext }) {
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

const MessageBubble = React.memo(
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

function SuggestionPill({
  icon,
  text,
  onClick,
}: {
  icon: React.ReactNode;
  text: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      className={cn(
        "flex items-center gap-1.5 rounded-full",
        "px-3.5 py-1.5 text-sm text-foreground/60",
        "transition-all duration-200",
      )}
      onClick={onClick}
    >
      {icon}
      <span>{text}</span>
    </Button>
  );
}

function ScrollToBottomLoadingDots() {
  return (
    <span className="flex items-center justify-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-[4.5px] w-[4.5px] rounded-full bg-current"
          animate={{
            y: [0, -3, 0],
          }}
          transition={{
            duration: 0.82,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.12,
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Token Stats Bar — 上下文占用 + Token 统计 + 使用日志
// ---------------------------------------------------------------------------

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

function TokenStatsBar({ className }: { className?: string } = {}) {
  const { t, i18n } = useTranslation();
  const tokenStats = useAgentStore((s) => s.tokenStats);
  const isStreaming = useAgentStore((s) => s.isStreaming);
  const agentProfile = useModelStore((s) => s.getAgentProfile());

  if (tokenStats.stepCount === 0) return null;

  const modelKey = agentProfile?.modelKey ?? "";
  const contextWindow = inferContextWindowSize(modelKey);
  const contextPercent = Math.min(
    100,
    (tokenStats.lastPromptTokens / contextWindow) * 100,
  );
  const pricing = agentProfile?.tokenPricing;
  const locale = i18n.resolvedLanguage || i18n.language || "en-US";

  const barColor =
    contextPercent > 85
      ? "bg-destructive"
      : contextPercent > 60
        ? "bg-amber-500"
        : "bg-emerald-500";

  const barColorMuted =
    contextPercent > 85
      ? "text-destructive"
      : contextPercent > 60
        ? "text-amber-500"
        : "text-emerald-600 dark:text-emerald-400";

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", bounce: 0, duration: 0.5 }}
      className={cn("max-w-2xl mx-auto pointer-events-auto", className)}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-2 text-[10px] text-muted-foreground/60",
              "hover:text-muted-foreground transition-colors rounded-full",
              "px-2.5 pt-1 cursor-pointer select-none",
              isStreaming && "animate-pulse",
            )}
          >
            <Activity className="h-3 w-3 shrink-0" />

            <span className="flex items-center gap-1.5">
              <span>{t("home:context_label")}</span>
              <span className="w-14 h-1 rounded-full bg-muted overflow-hidden border border-muted-foreground/25">
                <span
                  className={cn(
                    "block h-full rounded-full transition-all duration-700",
                    barColor,
                  )}
                  style={{ width: `${contextPercent}%` }}
                />
              </span>
              <span className={cn("tabular-nums", barColorMuted)}>
                {contextPercent.toFixed(0)}%
              </span>
            </span>

            <span className="text-muted-foreground/25">·</span>

            <span className="tabular-nums">
              ↓{formatTokenCount(tokenStats.totalPromptTokens)}
            </span>
            <span className="tabular-nums">
              ↑{formatTokenCount(tokenStats.totalCompletionTokens)}
            </span>

            <span className="text-muted-foreground/25">·</span>

            <span className="tabular-nums">
              ${tokenStats.totalCost.toFixed(4)}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="center"
          side="top"
          sideOffset={8}
          className="w-80 p-0 rounded-xl"
        >
          <div className="p-4 space-y-3.5">
            {/* --- Context usage --- */}
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-2">
                {t("home:context_usage")}
              </p>
              <div className="h-2 rounded-full bg-muted overflow-hidden mb-1.5">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-700",
                    barColor,
                  )}
                  style={{ width: `${contextPercent}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                <span>
                  {tokenStats.lastPromptTokens.toLocaleString()} /{" "}
                  {contextWindow.toLocaleString()} {t("home:tokens_unit")}
                </span>
                <span className={barColorMuted}>
                  {contextPercent.toFixed(1)}%
                </span>
              </div>
            </div>

            {/* --- Session stats --- */}
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-2">
                {t("home:session_stats")}
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("home:input_label")}
                  </span>
                  <span className="tabular-nums">
                    {tokenStats.totalPromptTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("home:output_label")}
                  </span>
                  <span className="tabular-nums">
                    {tokenStats.totalCompletionTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("home:total_label")}
                  </span>
                  <span className="tabular-nums font-medium">
                    {tokenStats.totalTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("home:calls_label")}
                  </span>
                  <span className="tabular-nums">
                    {tokenStats.stepCount} {t("home:times_unit")}
                  </span>
                </div>
                {pricing && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("home:input_cost_label")}
                      </span>
                      <span className="tabular-nums">
                        $
                        {(
                          (tokenStats.totalPromptTokens *
                            pricing.inputTokensPerMillion) /
                          1_000_000
                        ).toFixed(6)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("home:output_cost_label")}
                      </span>
                      <span className="tabular-nums">
                        $
                        {(
                          (tokenStats.totalCompletionTokens *
                            pricing.outputTokensPerMillion) /
                          1_000_000
                        ).toFixed(6)}
                      </span>
                    </div>
                  </>
                )}
                <div className="col-span-2 flex justify-between border-t border-border/30 pt-1 mt-0.5">
                  <span className="text-muted-foreground font-medium">
                    {t("home:total_cost_label")}
                  </span>
                  <span className="tabular-nums font-medium">
                    ${tokenStats.totalCost.toFixed(6)}
                  </span>
                </div>
              </div>
            </div>

            {/* --- Interaction log --- */}
            {tokenStats.interactions.length > 0 && (
              <div>
                <p className="text-[11px] font-medium text-muted-foreground mb-2">
                  {t("home:token_log")}
                </p>
                <div className="max-h-36 overflow-y-auto space-y-0.5 -mx-1 px-1">
                  {tokenStats.interactions.map((rec, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-[10px] text-muted-foreground rounded px-1.5 py-0.5 hover:bg-muted/50"
                    >
                      <span className="text-muted-foreground/40 w-4 shrink-0 text-right tabular-nums">
                        #{i + 1}
                      </span>
                      <span className="w-10 shrink-0 tabular-nums">
                        {new Date(rec.timestamp).toLocaleTimeString(locale, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="flex-1 tabular-nums">
                        ↓{formatTokenCount(rec.promptTokens)} ↑
                        {formatTokenCount(rec.completionTokens)}
                      </span>
                      <span className="tabular-nums shrink-0">
                        ${rec.cost.toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* --- Model info footer --- */}
            <div className="text-[10px] text-muted-foreground/40 pt-1 border-t border-border/20">
              {modelKey || t("home:unknown_model")} ·{" "}
              {formatTokenCount(contextWindow)} {t("home:context_window")}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </motion.div>
  );
}

export default HomeAgent;
