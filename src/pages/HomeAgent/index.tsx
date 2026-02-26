import React, { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import useAgentStore from "@/store/agent/useAgentStore";
import { handleUserMessage } from "@/agent/orchestrator";
import type { AgentMessage, ExecutionMode } from "@/agent/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import FusionKitLogo from "@/assets/FusionKit.svg";

// ---------------------------------------------------------------------------

const EXECUTION_MODE_OPTIONS: {
  value: ExecutionMode;
  label: string;
  icon: React.ReactNode;
}[] = [
    {
      value: "queue_only",
      label: "仅添加",
      icon: <ListPlus className="h-3.5 w-3.5" />,
    },
    {
      value: "ask_before_execute",
      label: "询问执行",
      icon: <MessageSquareMore className="h-3.5 w-3.5" />,
    },
    {
      value: "auto_execute",
      label: "自动执行",
      icon: <Zap className="h-3.5 w-3.5" />,
    },
  ];

const STORE_LABEL: Record<string, string> = {
  translate: "翻译",
  convert: "转换",
  extract: "提取",
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

  const {
    session,
    isStreaming,
    resetSession,
    executionMode,
    setExecutionMode,
    pendingExecution,
    confirmExecution,
    dismissExecution,
  } = useAgentStore();
  const { messages, status } = session;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingExecution]);

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

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    await handleUserMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
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
            className="max-w-2xl mx-auto flex justify-end mb-2 pointer-events-auto"
          >
            <Button
              variant="outline"
              onClick={handleResetClick}
              disabled={isStreaming}
              className={cn(
                "flex items-center gap-1 text-xs rounded-full transition-colors disabled:opacity-40",
                "dark:bg-background dark:hover:bg-accent",
                confirmingReset
                  ? "text-destructive hover:text-destructive/80"
                  : "text-muted-foreground/80 hover:text-foreground"
              )}
            >
              <RotateCcw className="h-3 w-3" />
              {confirmingReset ? "确认新建?" : "新对话"}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        layoutId="input-capsule"
        layout
        transition={{ type: "spring", bounce: 0, duration: 0.8 }}
        className={cn(
          "flex items-center gap-1.5 rounded-full border shadow-sm",
          "bg-background",
          "focus-within:shadow-md focus-within:border-ring/40",
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
          placeholder="输入任务或随意聊天…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground/50 disabled:opacity-50 min-w-0"
        />
        <Button
          onClick={handleSend}
          disabled={!canSend}
          className={cn(
            "flex items-center justify-center rounded-full w-8 h-8 shrink-0",
            "transition-all duration-200",
            canSend
              ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90"
              : "bg-transparent text-muted-foreground/30"
          )}
        >
          {isStreaming ? (
            <Loader2 className="h-4 w-4 animate-spin" />
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
            FusionKit Agent
          </h1>
          <p className="text-sm text-muted-foreground max-w-sm text-center mb-6 z-10">
            {t("home:home_description")}
          </p>

          {/* Suggestion Pills */}
          <div className="flex flex-wrap justify-center gap-2 max-w-md">
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text="翻译 SRT 字幕"
              onClick={() => {
                setInput("翻译 ~/Downloads 目录下所有 SRT 字幕文件");
                inputRef.current?.focus();
              }}
            />
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text="LRC 转 SRT"
              onClick={() => {
                setInput(
                  "把 ~/Downloads 目录下的 LRC 字幕文件转换成 SRT 格式"
                );
                inputRef.current?.focus();
              }}
            />
            <SuggestionPill
              icon={<Sparkles className="h-3 w-3" />}
              text="提取中文字幕"
              onClick={() => {
                setInput("从 ~/Downloads 目录下的双语字幕中提取中文部分");
                inputRef.current?.focus();
              }}
            />
          </div>
        </div>
      )}

      {/* ===== Message List ===== */}
      {!isEmpty && (
        <div className="relative flex-1 min-h-0">
          <div className="pointer-events-none absolute inset-x-0 -top-8 z-10 h-12 bg-linear-to-b from-background via-background/90 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-28 bg-linear-to-t from-background via-background/90 to-transparent" />

          <div className="h-full overflow-y-auto px-4 pt-2 pb-2">
            <div className="max-w-2xl mx-auto space-y-4 pt-1 pb-44">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}

              {isStreaming && status === "thinking" && (
                <div className="flex items-center gap-2 text-muted-foreground text-sm pl-10">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>思考中…</span>
                </div>
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
        <div className="absolute inset-x-0 top-72 z-20 px-4 pb-4 pt-2 pointer-events-none">
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
          "bg-secondary hover:bg-accent/50",
          "text-muted-foreground",
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
              {opt.label}
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
  const summary = pendingExecution.stores
    .map(
      (s) =>
        `${STORE_LABEL[s] ?? s} ${pendingExecution.taskCounts[s] ?? 0} 个`
    )
    .join("、");

  return (
    <div className="pl-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="rounded-2xl border border-primary/15 bg-primary/5 p-3.5 max-w-md">
        <p className="text-sm mb-3">
          已加入队列：{summary}任务。是否立即开始执行？
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onConfirm}
            className="h-7 rounded-full text-xs gap-1 px-3"
          >
            <Play className="h-3 w-3" />
            立即执行
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className="h-7 rounded-full text-xs text-muted-foreground px-3"
          >
            稍后手动
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: AgentMessage }) {
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
            <span>{result?.toolName ?? "工具执行"}</span>
          </div>
          <pre className="whitespace-pre-wrap wrap-break-word max-h-48 overflow-auto text-foreground/80">
            {formatToolContent(message.content)}
          </pre>
        </div>
      </div>
    );
  }

  if (
    message.role === "assistant" &&
    !message.content &&
    message.rawToolCalls?.length
  ) {
    return null;
  }

  return (
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
        "px-3.5 py-1.5 text-sm text-muted-foreground",
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
// Utilities
// ---------------------------------------------------------------------------

function formatToolContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.files && Array.isArray(parsed.files)) {
      const count = parsed.totalCount ?? parsed.files.length;
      const names = parsed.files
        .slice(0, 10)
        .map((f: any) => f.fileName || f)
        .join("\n  ");
      const more = count > 10 ? `\n  ... 共 ${count} 个文件` : "";
      return `发现 ${count} 个文件:\n  ${names}${more}`;
    }
    if (parsed?.queuedCount !== undefined) {
      return `已加入队列: ${parsed.queuedCount}/${parsed.totalFiles} 个文件`;
    }
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  }
}

export default HomeAgent;
