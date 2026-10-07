import { describe, expect, it } from "vitest";
import type { AgentMessage } from "./types";
import { buildConversationContext, compactToolOutput, toolFailurePayload } from "./conversation-context";

const user = (id: string, content = id): AgentMessage => ({ id, content, role: "user", timestamp: 1 });
const pair = (id: string, data: unknown = { count: 1 }): AgentMessage[] => [
  { id: `${id}-call`, role: "assistant", content: "", timestamp: 2, toolCalls: [{ toolCallId: id, toolName: "lookup", args: { id } }] },
  { id: `${id}-result`, role: "tool", content: JSON.stringify(data), timestamp: 3, toolResult: { callId: id, toolName: "lookup", success: true, data } },
];

describe("bounded conversation projection", () => {
  it("drops entire old turns and retains the latest request with paired tools", () => {
    const recent = [user("new"), ...pair("new-tool")];
    const old = [user("old", "x".repeat(3000)), ...pair("old-tool")];
    const result = buildConversationContext([...old, ...recent], 1000);
    expect(result.messages.map((m) => m.id)).toEqual(recent.map((m) => m.id));
    expect(result.omittedMessages).toBe(old.length);
    expect(result.estimatedCharacters).toBeLessThanOrEqual(1000);
  });

  it("removes orphan outputs and unpaired calls instead of corrupting protocol history", () => {
    const result = buildConversationContext([user("u"), pair("orphan")[1], pair("missing")[0], ...pair("complete")]);
    expect(result.messages.map((m) => m.id)).toEqual(["u", "complete-call", "complete-result"]);
  });

  it("bounds large tool results without changing exportable source history", () => {
    const data = { taskId: "task-1", content: "x".repeat(50_000) };
    const source = [user("u"), ...pair("call", data)];
    const snapshot = JSON.stringify(source);
    const result = buildConversationContext(source, 10_000);
    expect(result.messages[2].toolResult?.data).toMatchObject({ truncated: true });
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(result.messages[1].toolCalls?.[0].toolCallId).toBe(result.messages[2].toolResult?.callId);
  });

  it("rejects a latest request that cannot fit rather than silently cutting user intent", () => {
    expect(() => buildConversationContext([user("u", "x".repeat(2000))], 1000)).toThrow("latest request");
  });

  it("bounds escaping-heavy output and preserves success=false", () => {
    const result = compactToolOutput({ success: false, values: Array(40).fill('"\\'.repeat(4000)) }, 700);
    expect(result).toMatchObject({ success: false, truncated: true });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(700);
  });
});

describe("tool failure replay", () => {
  it("keeps structured failure detail but drops a redundant receipt copy", () => {
    expect(toolFailurePayload({ error: "scan_failed", data: { directory: "/a", reason: "EACCES" } }))
      .toEqual({ success: false, error: "scan_failed", data: { directory: "/a", reason: "EACCES" } });
    expect(toolFailurePayload({ error: "scan_failed", data: { success: false, error: "scan_failed" } }))
      .toEqual({ success: false, error: "scan_failed" });
    expect(toolFailurePayload({})).toEqual({ success: false, error: "Unknown error" });
  });
});
