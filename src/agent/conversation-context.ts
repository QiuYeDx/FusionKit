import type { AgentMessage } from "./types";

/** Conservative serialized-character budget, not a tokenizer or model capacity claim. */
export const AGENT_CONTEXT_CHARACTER_BUDGET = 96_000;
export const AGENT_TOOL_RESULT_CHARACTER_BUDGET = 6_000;

function summarize(value: unknown, depth = 0): unknown {
  if (depth > 4 && value && typeof value === "object") return "[nested data omitted]";
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}… [truncated]` : value;
  if (Array.isArray(value)) return [...value.slice(0, 8).map((item) => summarize(item, depth + 1)), ...(value.length > 8 ? [`[${value.length - 8} more items omitted]`] : [])];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key, summarize(item, depth + 1)]));
  }
  return value;
}

export function compactToolOutput(output: unknown, budget = AGENT_TOOL_RESULT_CHARACTER_BUDGET): unknown {
  const serialized = JSON.stringify(output ?? null);
  if (serialized.length <= budget) return output;
  const summary = summarize(output);
  const status = output && typeof output === "object" && "success" in output && typeof output.success === "boolean"
    ? { success: output.success } : {};
  const candidate = { ...status, truncated: true, originalCharacters: serialized.length, summary };
  if (JSON.stringify(candidate).length <= budget) return candidate;
  let preview = serialized.slice(0, Math.max(0, budget - 150));
  while (JSON.stringify({ ...status, truncated: true, originalCharacters: serialized.length, preview }).length > budget && preview.length) {
    preview = preview.slice(0, Math.floor(preview.length * 0.8));
  }
  return { ...status, truncated: true, originalCharacters: serialized.length, preview };
}

/** Failure payload replayed to the model: the stable error plus any structured detail. */
export function toolFailurePayload(result: { error?: string; data?: unknown }): { success: false; error: string; data?: unknown } {
  const data = result.data;
  const redundant = data === undefined || data === null
    || (typeof data === "object" && !Array.isArray(data) && Object.keys(data).every((key) => key === "success" || key === "error"));
  return { success: false, error: result.error ?? "Unknown error", ...(redundant ? {} : { data }) };
}

/** Remove orphan results and incomplete call groups; keep the original session untouched. */
function completeGroups(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool" || message.role === "system") continue;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      result.push(message);
      continue;
    }
    const results = new Map<string, AgentMessage>();
    let next = index + 1;
    while (next < messages.length && messages[next].role === "tool") {
      const toolMessage = messages[next++];
      if (toolMessage.toolResult) results.set(toolMessage.toolResult.callId, toolMessage);
    }
    const calls = message.toolCalls.filter((call) => results.get(call.toolCallId)?.toolResult?.toolName === call.toolName);
    if (calls.length) {
      result.push({ ...message, toolCalls: calls });
      for (const call of calls) {
        const toolMessage = results.get(call.toolCallId)!;
        const original = toolMessage.toolResult!;
        const data = compactToolOutput(original.data);
        const error = original.error?.slice(0, AGENT_TOOL_RESULT_CHARACTER_BUDGET);
        result.push({ ...toolMessage, content: "", toolResult: { ...original, data, error } });
      }
    } else if (message.content) result.push({ ...message, toolCalls: undefined });
    index = next - 1;
  }
  return result;
}

export function buildConversationContext(messages: AgentMessage[], budget = AGENT_CONTEXT_CHARACTER_BUDGET): {
  messages: AgentMessage[];
  omittedMessages: number;
  estimatedCharacters: number;
} {
  const normalized = completeGroups(messages);
  const turns: AgentMessage[][] = [];
  for (const message of normalized) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  const selected: AgentMessage[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidate = [...turns[index], ...selected];
    if (JSON.stringify(candidate).length > budget) {
      if (index === turns.length - 1) throw new Error("The latest request exceeds the Agent context budget. Please shorten it or start a new conversation.");
      break;
    }
    selected.unshift(...turns[index]);
  }
  return { messages: selected, omittedMessages: messages.length - selected.length, estimatedCharacters: JSON.stringify(selected).length };
}
