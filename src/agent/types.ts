// ---------------------------------------------------------------------------
// Agent 会话与消息类型
// ---------------------------------------------------------------------------

export type AgentMessageRole = "user" | "assistant" | "system" | "tool";

export interface AgentToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  timestamp: number;
  /** tool 消息对应的执行结果 */
  toolResult?: AgentToolResult;
  /** assistant 消息中的 tool calls（用于会话历史回传 API） */
  toolCalls?: AgentToolCall[];
}

export interface AgentToolResult {
  callId: string;
  toolName: string;
  success: boolean;
  data?: any;
  error?: string;
}

// ---------------------------------------------------------------------------
// 执行模式
// ---------------------------------------------------------------------------

export type ExecutionMode =
  | "queue_only"
  | "ask_before_execute"
  | "auto_execute";

export type TaskStoreType = "translate" | "convert" | "extract";

/** ask_before_execute 模式下的待确认执行信息 */
export interface PendingExecution {
  stores: TaskStoreType[];
  taskCounts: Partial<Record<TaskStoreType, number>>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Agent 会话状态
// ---------------------------------------------------------------------------

export type AgentSessionStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "error";

export interface AgentSession {
  id: string;
  messages: AgentMessage[];
  status: AgentSessionStatus;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Token 使用统计
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface InteractionTokenRecord {
  timestamp: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  stepCount: number;
}

export interface TokenStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCost: number;
  stepCount: number;
  /** 最近一步的 promptTokens，反映当前上下文窗口占用 */
  lastPromptTokens: number;
  interactions: InteractionTokenRecord[];
}

// ---------------------------------------------------------------------------
// Agent 会话日志
// ---------------------------------------------------------------------------

export type AgentLogEntryType =
  | "user_message"
  | "assistant_message"
  | "status_change"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "error"
  | "abort"
  | "session_reset";

export interface AgentLogEntry {
  id: string;
  timestamp: number;
  type: AgentLogEntryType;
  summary: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 会话导出 / 导入
// ---------------------------------------------------------------------------

export interface SessionExportData {
  version: number;
  exportedAt: number;
  session: AgentSession;
  tokenStats: TokenStats;
  sessionLog: AgentLogEntry[];
  executionMode: ExecutionMode;
}
