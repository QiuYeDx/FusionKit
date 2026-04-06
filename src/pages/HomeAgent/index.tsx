import React, { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router-dom";
import {
  Send,
  Loader2,
  Bot,
  User,
  RotateCcw,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Play,
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
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import { handleUserMessage, abortCurrentStream } from "@/agent/orchestrator";
import { exportSession, importSession } from "@/agent/session-io";
import SessionLogViewer from "./SessionLogViewer";
import type { AgentMessage, AgentToolCall, ExecutionMode } from "@/agent/types";
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
import FusionKitLogo from "@/assets/FusionKit.svg";

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

const TOOL_LABEL_KEYS: Record<string, string> = {
  scan_subtitle_files: "home:tool_name_scan",
  queue_subtitle_translate: "home:tool_name_translate",
  queue_subtitle_convert: "home:tool_name_convert",
  queue_subtitle_extract: "home:tool_name_extract",
};

const STORE_LABEL_KEYS: Record<string, string> = {
  translate: "home:store_label_translate",
  convert: "home:store_label_convert",
  extract: "home:store_label_extract",
};

const STORE_PATH: Record<string, string> = {
  translate: "/tools/subtitle/translator",
  convert: "/tools/subtitle/converter",
  extract: "/tools/subtitle/extractor",
};

// ---------------------------------------------------------------------------

function HomeAgent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const confirmResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [logOpen, setLogOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const {
    session,
    isStreaming,
    streamingText,
    resetSession,
    executionMode,
    setExecutionMode,
    pendingExecution,
    confirmExecution,
    dismissExecution,
    activeToolCalls,
    sessionLog,
  } = useAgentStore();
  const { messages, status } = session;

  const agentProfile = useModelStore((s) => s.getAgentProfile());
  const hasAgentConfig = !!(agentProfile && agentProfile.apiKey);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingExecution, streamingText, activeToolCalls]);

  useEffect(() => {
    return () => {
      if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
    };
  }, []);

  const handleResetClick = () => {
    if (confirmingReset) {
      setConfirmingReset(false);
      if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
      resetSession();
    } else {
      setConfirmingReset(true);
      confirmResetTimer.current = setTimeout(
        () => setConfirmingReset(false),
        3000
      );
    }
  };

  const handleExport = async () => {
    await exportSession();
  };

  const handleImport = async () => {
    setImportError(null);
    const result = await importSession();
    if (!result.success && result.error) {
      setImportError(result.error);
      setTimeout(() => setImportError(null), 4000);
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    await handleUserMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const isEmpty = messages.length === 0;
  const canSend = input.trim().length > 0 && !isStreaming;
  const inputCapsule = (
    <>
      <AnimatePresence>
        {!isEmpty && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: "spring", bounce: 0, duration: 0.8, delay: 1.2 }}
            className="max-w-2xl mx-auto mb-2 pointer-events-auto flex items-end justify-between gap-2"
          >
            <TokenStatsBar className="max-w-none mx-0 mb-0" />
            <div className="flex items-center gap-1 ml-auto translate-y-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLogOpen(true)}
                disabled={sessionLog.length === 0}
                className="h-7 px-2 text-xs text-muted-foreground/60 hover:text-foreground rounded-full disabled:opacity-30"
                title={t("home:session_log_title")}
              >
                <ScrollText className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExport}
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
                    : "text-muted-foreground/80 hover:text-foreground"
                )}
              >
                <RotateCcw className="h-3 w-3" />
                {confirmingReset
                  ? t("home:confirm_new_conversation")
                  : t("home:new_conversation")}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
              <span>{t("home:import_failed")}: {importError}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        layoutId="input-capsule"
        layout
        transition={{ type: "spring", bounce: 0, duration: 0.8 }}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-border/70 shadow-sm",
          "bg-background",
          "focus-within:shadow-md focus-within:border-ring/50",
          "max-w-2xl mx-auto w-full",
          "pl-1.5 pr-1.5 py-1",
          "pointer-events-auto"
        )}
      >
        <CapsuleModeSelector
          value={executionMode}
          onChange={setExecutionMode}
          disabled={isStreaming}
        />
        <input
          ref={inputRef}
          placeholder={t("home:agent_input_placeholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground/70 disabled:opacity-50 min-w-0"
        />
        <Button
          onClick={isStreaming ? () => abortCurrentStream() : handleSend}
          disabled={!isStreaming && !canSend}
          className={cn(
            "flex items-center justify-center rounded-full w-8 h-8 shrink-0",
            "transition-all duration-200",
            isStreaming
              ? "shadow-sm hover:bg-destructive"
              : canSend
                ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90"
                : "bg-transparent text-muted-foreground/45"
          )}
        >
          {isStreaming ? (
            <Square className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </motion.div>
    </>
  );

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* ===== Empty State ===== */}
      {isEmpty && (
        <div className="mt-4 mb-6 flex-1 flex flex-col items-center justify-center px-4 animate-in fade-in duration-500">
          {/* Concentric Circles + Logo */}
          <div className="relative flex items-center justify-center mb-8 z-0">
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
          </div>

          <h1 className="text-xl font-semibold tracking-tight mt-4 mb-4 z-10">
            {t("home:agent_title")}
          </h1>
          <p className="text-sm text-muted-foreground max-w-sm text-center mb-6 z-10">
            {t("home:home_description")}
          </p>

          {/* Unconfigured Agent Banner */}
          {!hasAgentConfig && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/5 max-w-md mb-4 z-10">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
              <span className="text-sm text-amber-700 dark:text-amber-400 flex-1">
                {t("home:agent_not_configured")}
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
            </div>
          )}

          {/* Suggestion Pills */}
          <div className="flex flex-nowrap justify-center gap-2 max-w-md">
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text={t("home:suggestion_translate_srt")}
              onClick={() => {
                setInput(t("home:suggestion_translate_srt_prompt"));
                inputRef.current?.focus();
              }}
            />
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text={t("home:suggestion_lrc_to_srt")}
              onClick={() => {
                setInput(t("home:suggestion_lrc_to_srt_prompt"));
                inputRef.current?.focus();
              }}
            />
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text={t("home:suggestion_extract_chinese")}
              onClick={() => {
                setInput(t("home:suggestion_extract_chinese_prompt"));
                inputRef.current?.focus();
              }}
            />
          </div>
        </div>
      )}

      {/* ===== Message List ===== */}
      {!isEmpty && (
        <div className="relative flex-1 min-h-0">
          <div className="pointer-events-none fixed inset-x-0 -top-2 z-20 h-12 bg-linear-to-b from-background via-background/80 to-transparent" />
          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 h-28 bg-linear-to-t from-background via-background/90 to-transparent" />

          <div className="h-full overflow-y-auto px-4 pt-2 pb-2">
            <div className="max-w-2xl mx-auto space-y-4 pt-1 pb-44">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}

              {isStreaming && status === "thinking" && !streamingText && activeToolCalls.length === 0 && (
                <div className="flex items-center gap-2 text-muted-foreground text-sm pl-10">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t("home:agent_thinking")}</span>
                </div>
              )}

              {isStreaming && streamingText && (
                <div className="flex items-start gap-2.5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="flex items-center justify-center rounded-full w-7 h-7 shrink-0 bg-muted text-muted-foreground">
                    <Bot className="h-3.5 w-3.5" />
                  </div>
                  <div className="relative rounded-sm px-4 py-2.5 max-w-[80%] text-sm leading-relaxed bg-muted chat-bubble-assistant">
                    <StreamingTextContent text={streamingText} />
                  </div>
                </div>
              )}

              {isStreaming && activeToolCalls.length > 0 && (
                <ToolCallBubble toolCalls={activeToolCalls} isLoading />
              )}

              {pendingExecution && !isStreaming && (
                <PendingExecutionCard
                  pendingExecution={pendingExecution}
                  onConfirm={confirmExecution}
                  onDismiss={dismissExecution}
                />
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* ===== Bottom Input Area ===== */}
      {isEmpty ? (
        <div className={cn("absolute inset-x-0 z-20 px-4 pb-4 pt-2 pointer-events-none", hasAgentConfig ? "top-72" : "top-82")}>
          {inputCapsule}
        </div>
      ) : (
        <>
          <div className="pointer-events-none fixed inset-x-0 bottom-0 h-32 bg-linear-to-b from-transparent via-background/95 to-background" />
          <div className="fixed inset-x-0 bottom-[42px] z-20 pointer-events-none">
            <div className="relative px-4 pt-3 pb-4 pointer-events-none">
              {inputCapsule}
            </div>
          </div>
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
        className={cn(
          "h-8 rounded-full border-0 shadow-none -translate-x-0.5",
          "bg-secondary hover:bg-accent/60",
          "text-foreground/65",
          "focus-visible:ring-0",
          "cursor-pointer shrink-0"
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

function PendingExecutionCard({
  pendingExecution,
  onConfirm,
  onDismiss,
}: {
  pendingExecution: { stores: string[]; taskCounts: Record<string, number> };
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="pl-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="rounded-xl border border-border/60 bg-muted/40 p-4 max-w-sm">
        <p className="text-sm font-medium mb-2.5">{t("home:queued_title")}</p>

        <div className="space-y-1.5 mb-3">
          {pendingExecution.stores.map((store) => (
            <div
              key={store}
              className="flex items-center justify-between rounded-lg bg-background/60 border border-border/40 px-3 py-1.5"
            >
              <span className="text-sm text-muted-foreground">
                {t(STORE_LABEL_KEYS[store] ?? store)}{" "}
                <span className="font-medium text-foreground">
                  {pendingExecution.taskCounts[store] ?? 0}
                </span>{" "}
                {t("home:task_unit")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => navigate(STORE_PATH[store])}
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground mb-3">
          {t("home:execute_immediately_confirm")}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onConfirm}
            className="h-7 rounded-full text-xs gap-1 px-3"
          >
            <Play className="h-3 w-3" />
            {t("home:execute_now")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className="h-7 rounded-full text-xs text-muted-foreground px-3"
          >
            {t("home:execute_later")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: AgentMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isTool) {
    const result = message.toolResult;
    const isSuccess = result?.success ?? true;
    return (
      <div className="pl-10">
        <div
          className={cn(
            "rounded-xl border p-3 text-xs font-mono max-w-full overflow-auto",
            isSuccess
              ? "bg-muted/40 border-border/50"
              : "bg-destructive/5 border-destructive/20"
          )}
        >
          <div className="flex items-center gap-1.5 mb-1 text-muted-foreground">
            {isSuccess ? (
              <CheckCircle2 className="h-3 w-3 text-green-600" />
            ) : (
              <XCircle className="h-3 w-3 text-destructive" />
            )}
            <span>{result?.toolName ?? t("home:tool_execution_fallback")}</span>
          </div>
          <pre className="whitespace-pre-wrap wrap-break-word max-h-48 overflow-auto text-foreground/80">
            {formatToolContent(message.content, t)}
          </pre>
        </div>
      </div>
    );
  }

  if (
    message.role === "assistant" &&
    !message.content &&
    message.toolCalls?.length
  ) {
    return <ToolCallBubble toolCalls={message.toolCalls} />;
  }

  return (
    <>
      <div
        className={cn(
          "flex items-start gap-2.5",
          isUser ? "flex-row-reverse" : ""
        )}
      >
        <div
          className={cn(
            "flex items-center justify-center rounded-full w-7 h-7 shrink-0",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
          )}
        >
          {isUser ? (
            <User className="h-3.5 w-3.5" />
          ) : (
            <Bot className="h-3.5 w-3.5" />
          )}
        </div>
        <div
          className={cn(
            "relative rounded-sm px-4 py-2.5 max-w-[80%] text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground chat-bubble-user"
              : "bg-muted chat-bubble-assistant"
          )}
        >
          <p className="whitespace-pre-wrap wrap-break-word">{message.content}</p>
        </div>
      </div>
      {message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0 && (
        <ToolCallBubble toolCalls={message.toolCalls} />
      )}
    </>
  );
}

function ToolCallBubble({
  toolCalls,
  isLoading = false,
}: {
  toolCalls: AgentToolCall[];
  isLoading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "pl-10",
        isLoading && "animate-in fade-in slide-in-from-bottom-2 duration-300"
      )}
    >
      <div className="inline-flex flex-col gap-1 rounded-lg border border-border/40 bg-muted/30 px-3 py-2">
        {toolCalls.map((tc) => (
          <div
            key={tc.toolCallId}
            className="flex items-center gap-2 text-xs"
          >
            {isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-primary/70" />
            ) : (
              <CheckCircle2 className="h-3 w-3 text-emerald-500/70" />
            )}
            <span className="text-muted-foreground">
              {t(TOOL_LABEL_KEYS[tc.toolName] ?? tc.toolName)}
            </span>
            {isLoading && (
              <span className="text-muted-foreground/40 text-[10px]">
                {t("home:tool_executing")}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StreamingTextContent({ text }: { text: string }) {
  const segmentsRef = useRef<string[]>([]);
  const processedLenRef = useRef(0);

  if (text.length === 0 && processedLenRef.current > 0) {
    segmentsRef.current = [];
    processedLenRef.current = 0;
  }

  if (text.length > processedLenRef.current) {
    const delta = text.slice(processedLenRef.current);
    const segs = segmentsRef.current;
    const lastSeg = segs.length > 0 ? segs[segs.length - 1] : undefined;
    if (lastSeg !== undefined && lastSeg.length < 12) {
      segs[segs.length - 1] = lastSeg + delta;
    } else {
      segs.push(delta);
    }
    processedLenRef.current = text.length;
  }

  return (
    <p className="whitespace-pre-wrap wrap-break-word">
      {segmentsRef.current.map((seg, i) => (
        <span key={i} className="streaming-fade-in">{seg}</span>
      ))}
      <motion.span
        layoutId="streaming-cursor"
        className="inline-block w-1.5 h-4 ml-0.5 -mb-0.5 bg-foreground/60 animate-pulse"
        transition={{ type: "spring", bounce: 0, duration: 0.2 }}
      />
    </p>
  );
}

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
        "transition-all duration-200"
      )}
      onClick={onClick}
    >
      {icon}
      <span>{text}</span>
    </Button>
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
    (tokenStats.lastPromptTokens / contextWindow) * 100
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
              isStreaming && "animate-pulse"
            )}
          >
            <Activity className="h-3 w-3 shrink-0" />

            <span className="flex items-center gap-1.5">
              <span>{t("home:context_label")}</span>
              <span className="w-14 h-1 rounded-full bg-muted overflow-hidden border border-muted-foreground/25">
                <span
                  className={cn(
                    "block h-full rounded-full transition-all duration-700",
                    barColor
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
                    barColor
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
                  <span className="text-muted-foreground">{t("home:input_label")}</span>
                  <span className="tabular-nums">
                    {tokenStats.totalPromptTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("home:output_label")}</span>
                  <span className="tabular-nums">
                    {tokenStats.totalCompletionTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("home:total_label")}</span>
                  <span className="tabular-nums font-medium">
                    {tokenStats.totalTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("home:calls_label")}</span>
                  <span className="tabular-nums">
                    {tokenStats.stepCount} {t("home:times_unit")}
                  </span>
                </div>
                {pricing && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("home:input_cost_label")}</span>
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
                      <span className="text-muted-foreground">{t("home:output_cost_label")}</span>
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
                        ↓{formatTokenCount(rec.promptTokens)}{" "}
                        ↑{formatTokenCount(rec.completionTokens)}
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatToolContent(raw: string, t: TFunction): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.files && Array.isArray(parsed.files)) {
      const count = parsed.totalCount ?? parsed.files.length;
      const names = parsed.files
        .slice(0, 10)
        .map((f: any) => f.fileName || f)
        .join("\n  ");
      const more = count > 10 ? `\n  ${t("home:tool_result_more_files", { count })}` : "";
      return `${t("home:tool_result_files_found", { count })}:\n  ${names}${more}`;
    }
    if (parsed?.queuedCount !== undefined) {
      return t("home:tool_result_queued_progress", {
        queuedCount: parsed.queuedCount,
        totalFiles: parsed.totalFiles,
      });
    }
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  }
}

export default HomeAgent;
