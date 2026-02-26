// ---------------------------------------------------------------------------
// Agent 会话与消息类型
// ---------------------------------------------------------------------------

export type AgentMessageRole = "user" | "assistant" | "system" | "tool";

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  timestamp: number;
  /** tool 消息对应的执行结果 */
  toolResult?: AgentToolResult;
  /** assistant 消息中 LLM 返回的原始 tool_calls，用于 round-trip 回传 API */
  rawToolCalls?: any[];
}

export interface AgentToolResult {
  callId: string;
  toolName: string;
  success: boolean;
  data?: any;
  error?: string;
}

// ---------------------------------------------------------------------------
// Agent 会话状态
// ---------------------------------------------------------------------------

export type AgentSessionStatus =
  | "idle"
  | "thinking"
  | "error";

export interface AgentSession {
  id: string;
  messages: AgentMessage[];
  status: AgentSessionStatus;
  createdAt: number;
  updatedAt: number;
}
