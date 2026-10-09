import type { AgentMessage, AgentToolCall, AgentToolResult } from "@/agent/types";

// ---------------------------------------------------------------------------
// The conversation as it is shown: consecutive tool calls share one compact
// card, and what asks the user to decide (a rename preview, a prepared action,
// a classic execution confirmation) comes at the end of the turn that made it,
// right below the reply that asks for the decision.
// ---------------------------------------------------------------------------

export interface ToolEntry { call: AgentToolCall; result?: AgentToolResult }

export type FeedItem =
  | { kind: "user"; key: string; message: AgentMessage }
  | { kind: "event"; key: string; message: AgentMessage }
  | { kind: "text"; key: string; message: AgentMessage }
  | { kind: "tools"; key: string; entries: ToolEntry[] }
  | { kind: "name-plan"; key: string; message: AgentMessage }
  | { kind: "prepared-action"; key: string; actionId: string }
  | { kind: "pending-execution"; key: string };

export const NAME_PLAN_TOOLS = ["create_name_translation_plan", "apply_name_translation_plan"];

/** Name translation results render as their own interactive card. */
export function isNamePlanCard(result: AgentToolResult): boolean {
  return result.success && !!result.data && typeof result.data === "object" && NAME_PLAN_TOOLS.includes(result.toolName);
}

function preparedActionId(result: AgentToolResult | undefined): string | undefined {
  const data = result?.success && result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : undefined;
  return data?.executionStatus === "prepared" && typeof data.actionId === "string" ? data.actionId : undefined;
}

export interface FeedOptions {
  /** Prepared actions that still exist; others are shown by their tool row and its receipt. */
  hasAction?: (actionId: string) => boolean;
  /** When the classic execution confirmation was raised; it closes the turn that raised it. */
  pendingExecutionAt?: number;
}

export function buildFeed(messages: readonly AgentMessage[], options: FeedOptions = {}): FeedItem[] {
  const { hasAction = () => false, pendingExecutionAt } = options;
  const results = new Map(messages.flatMap((message) => message.toolResult ? [[message.toolResult.callId, message.toolResult] as const] : []));
  const shownCalls = new Set(messages.flatMap((message) => message.toolCalls?.map((call) => call.toolCallId) ?? []));
  const items: FeedItem[] = [];
  let deferred: FeedItem[] = [];
  let group: Extract<FeedItem, { kind: "tools" }> | null = null;
  let executionPlaced = pendingExecutionAt === undefined;

  // A row the card below already says everything about adds nothing.
  const hidden = (call: AgentToolCall, result: AgentToolResult | undefined) => {
    if (!result?.success) return false;
    if (call.toolName === "update_agent_plan" || isNamePlanCard(result)) return true;
    const actionId = preparedActionId(result);
    return !!actionId && hasAction(actionId);
  };
  const addEntry = (entry: ToolEntry) => {
    if (hidden(entry.call, entry.result)) return;
    if (!group) { group = { kind: "tools", key: `tools-${entry.call.toolCallId}`, entries: [] }; items.push(group); }
    group.entries.push(entry);
  };
  const endTurn = (nextTimestamp?: number) => {
    if (!executionPlaced && (nextTimestamp === undefined || nextTimestamp > pendingExecutionAt!)) {
      deferred.push({ kind: "pending-execution", key: "pending-execution" });
      executionPlaced = true;
    }
    items.push(...deferred);
    deferred = [];
    group = null;
  };

  for (const message of messages) {
    if (message.role === "user") {
      endTurn(message.timestamp);
      items.push({ kind: message.event ? "event" : "user", key: message.id, message });
    } else if (message.role === "assistant") {
      if (message.content.trim()) {
        group = null;
        items.push({ kind: "text", key: message.id, message });
      }
      for (const call of message.toolCalls ?? []) addEntry({ call, result: results.get(call.toolCallId) });
    } else if (message.role === "tool" && message.toolResult) {
      const result = message.toolResult;
      if (isNamePlanCard(result)) deferred.push({ kind: "name-plan", key: message.id, message });
      const actionId = preparedActionId(result);
      if (actionId && hasAction(actionId)) deferred.push({ kind: "prepared-action", key: `action-${actionId}`, actionId });
      // A result whose call no assistant message shows still gets its row.
      if (!shownCalls.has(result.callId)) addEntry({ call: { toolCallId: result.callId, toolName: result.toolName, args: {} }, result });
    }
  }
  endTurn();
  return items;
}

/** Prepared actions that a tool result in the conversation shows at the end of its turn. */
export function anchoredActionIds(messages: readonly AgentMessage[]): Set<string> {
  return new Set(messages.flatMap((message) => {
    const id = preparedActionId(message.toolResult);
    return id ? [id] : [];
  }));
}
