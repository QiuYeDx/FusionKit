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
import useAgentStore from "@/store/agent/useAgentStore";
import { handleUserMessage } from "@/agent/orchestrator";
import type { AgentMessage, ExecutionMode } from "@/agent/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
// HomeAgent 页面 — 对话式 Agent 工作台
// ---------------------------------------------------------------------------

const EXECUTION_MODE_OPTIONS: { value: ExecutionMode; label: string; icon: React.ReactNode }[] = [
  { value: "queue_only", label: "仅添加任务", icon: <ListPlus className="h-3.5 w-3.5" /> },
  { value: "ask_before_execute", label: "询问后执行", icon: <MessageSquareMore className="h-3.5 w-3.5" /> },
  { value: "auto_execute", label: "自动执行", icon: <Zap className="h-3.5 w-3.5" /> },
];

const STORE_LABEL: Record<string, string> = {
  translate: "翻译",
  convert: "转换",
  extract: "提取",
};

function HomeAgent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="flex flex-col h-full p-4">
      {/* 空状态欢迎区域 */}
      {isEmpty && (
        <div className="flex-1 flex flex-col items-center justify-center text-center animate-in fade-in duration-500">
          <img
            src={FusionKitLogo}
            alt="FusionKit Logo"
            className="w-16 h-16 mb-4 rounded-xl shadow-sm"
          />
          <h1 className="text-2xl font-bold tracking-tight mb-2">
            FusionKit Agent
          </h1>
          <p className="text-sm text-muted-foreground max-w-md mb-6">
            {t("home:home_description")}
          </p>

          <div className="grid gap-2 grid-cols-1 md:grid-cols-2 w-full max-w-lg">
            <SuggestionCard
              icon={<Sparkles className="h-4 w-4" />}
              text="翻译 Downloads 下所有 SRT 字幕"
              onClick={() => {
                setInput("翻译 ~/Downloads 目录下所有 SRT 字幕文件");
                inputRef.current?.focus();
              }}
            />
            <SuggestionCard
              icon={<Sparkles className="h-4 w-4" />}
              text="将 LRC 转换为 SRT 格式"
              onClick={() => {
                setInput("把 ~/Downloads 目录下的 LRC 字幕文件转换成 SRT 格式");
                inputRef.current?.focus();
              }}
            />
            <SuggestionCard
              icon={<Sparkles className="h-4 w-4" />}
              text="提取中文字幕"
              onClick={() => {
                setInput("从 ~/Downloads 目录下的双语字幕中提取中文部分");
                inputRef.current?.focus();
              }}
            />
            <SuggestionCard
              icon={<ArrowRight className="h-4 w-4" />}
              text={t("home:get_started")}
              onClick={() => navigate("/tools")}
            />
          </div>
        </div>
      )}

      {/* 消息列表 */}
      {!isEmpty && (
        <div className="flex-1 overflow-y-auto space-y-4 mb-4 min-h-0">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {isStreaming && status === "thinking" && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm pl-10">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>思考中…</span>
            </div>
          )}

          {/* 待确认执行卡片（ask_before_execute 模式） */}
          {pendingExecution && !isStreaming && (
            <PendingExecutionCard
              pendingExecution={pendingExecution}
              onConfirm={confirmExecution}
              onDismiss={dismissExecution}
            />
          )}

          <div ref={messagesEndRef} />
        </div>
      )}

      {/* 底部输入区域 */}
      <div className="sticky bottom-0 pt-2">
        {!isEmpty && (
          <div className="flex items-center justify-between mb-2">
            <ExecutionModeSelector
              value={executionMode}
              onChange={setExecutionMode}
              disabled={isStreaming}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={resetSession}
              disabled={isStreaming}
              className="text-xs text-muted-foreground"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              新对话
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          {isEmpty && (
            <ExecutionModeSelector
              value={executionMode}
              onChange={setExecutionMode}
              disabled={isStreaming}
            />
          )}
          <Input
            ref={inputRef}
            placeholder="输入任务或随意聊天，例如：把这个目录下的字幕文件转换为 SRT…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            className="flex-1"
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function ExecutionModeSelector({
  value,
  onChange,
  disabled,
}: {
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ExecutionMode)} disabled={disabled}>
      <SelectTrigger size="sm" className="h-7 text-xs gap-1.5 text-muted-foreground">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
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
    .map((s) => `${STORE_LABEL[s] ?? s} ${pendingExecution.taskCounts[s] ?? 0} 个`)
    .join("、");

  return (
    <div className="flex items-start gap-2 pl-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 w-full max-w-md">
        <p className="text-sm mb-2.5">
          已加入队列：{summary}任务。是否立即开始执行？
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onConfirm} className="h-7 text-xs gap-1">
            <Play className="h-3 w-3" />
            立即执行
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className="h-7 text-xs text-muted-foreground"
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
      <div className="flex items-start gap-2 pl-10">
        <div
          className={cn(
            "rounded-md border p-3 text-xs font-mono max-w-full overflow-auto",
            isSuccess ? "bg-muted/50" : "bg-destructive/5 border-destructive/20"
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
          <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">
            {formatToolContent(message.content)}
          </pre>
        </div>
      </div>
    );
  }

  // assistant 消息如果只有 rawToolCalls 但没有文字内容，隐藏气泡
  if (message.role === "assistant" && !message.content && message.rawToolCalls?.length) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3",
        isUser ? "flex-row-reverse" : ""
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-full w-8 h-8 shrink-0",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div
        className={cn(
          "rounded-lg px-4 py-2.5 max-w-[80%] text-sm leading-relaxed",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    </div>
  );
}

function SuggestionCard({
  icon,
  text,
  onClick,
}: {
  icon: React.ReactNode;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex items-center gap-2 rounded-lg border bg-background p-3 text-left text-sm hover:bg-accent transition-colors"
      onClick={onClick}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span>{text}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 工具函数
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
