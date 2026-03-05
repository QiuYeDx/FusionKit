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
