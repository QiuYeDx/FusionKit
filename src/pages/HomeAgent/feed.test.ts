import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@/agent/types";
import { anchoredActionIds, buildFeed } from "./feed";

let clock = 0;
const user = (content: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id: `u-${++clock}`, role: "user", content, timestamp: clock, ...extra });
const assistant = (content: string, calls: [string, string][] = []): AgentMessage => ({ id: `a-${++clock}`, role: "assistant", content, timestamp: clock,
  ...(calls.length ? { toolCalls: calls.map(([toolCallId, toolName]) => ({ toolCallId, toolName, args: {} })) } : {}) });
const tool = (callId: string, toolName: string, data: unknown = {}, success = true): AgentMessage => ({ id: `t-${callId}`, role: "tool", content: "", timestamp: ++clock,
  toolResult: { callId, toolName, success, data } });
const shape = (messages: AgentMessage[], options?: Parameters<typeof buildFeed>[1]) => buildFeed(messages, options).map((item) =>
  item.kind === "tools" ? `tools:${item.entries.map((entry) => entry.call.toolCallId).join(",")}` : item.kind);

describe("conversation feed", () => {
  it("puts consecutive tool calls of a turn in one group and drops rows a card or the plan bar covers", () => {
    const messages = [
      user("rename recursively"),
      assistant("", [["p", "update_agent_plan"]]), tool("p", "update_agent_plan", { plan: {} }),
      assistant("", [["i", "inspect_rename_paths"]]), tool("i", "inspect_rename_paths", { total: 3 }),
      assistant("", [["c", "create_name_translation_plan"]]), tool("c", "create_name_translation_plan", { planId: "plan" }),
      assistant("Preview ready, please confirm."),
    ];
    expect(shape(messages)).toEqual(["user", "tools:i", "text", "name-plan"]);
  });

  it("closes a turn with its decision cards, below the reply that asks for them", () => {
    const messages = [
      user("translate"),
      assistant("Preparing.", [["s", "prepare_studio_translation"]]), tool("s", "prepare_studio_translation", { actionId: "act", executionStatus: "prepared" }),
      assistant("Confirm the card to start."),
      user("", { event: { kind: "action_completed" } }),
      assistant("Submitted."),
    ];
    expect(shape(messages, { hasAction: (id) => id === "act" })).toEqual(["user", "text", "text", "prepared-action", "event", "text"]);
    // Without its live action the row stays, with the receipt it carries.
    expect(shape(messages)).toEqual(["user", "text", "tools:s", "text", "event", "text"]);
    expect([...anchoredActionIds(messages)]).toEqual(["act"]);
  });

  it("anchors the classic execution confirmation to the turn that raised it", () => {
    const first = user("convert");
    const reply = assistant("Queued.", [["q", "queue_subtitle_convert"]]);
    const result = tool("q", "queue_subtitle_convert", { queuedCount: 2 });
    const raisedAt = clock;
    const later = [user("thanks"), assistant("You're welcome.")];
    expect(shape([first, reply, result, ...later], { pendingExecutionAt: raisedAt })).toEqual(["user", "text", "tools:q", "pending-execution", "user", "text"]);
    expect(shape([first, reply, result], { pendingExecutionAt: raisedAt })).toEqual(["user", "text", "tools:q", "pending-execution"]);
  });

  it("keeps failures visible and gives orphan results their own row", () => {
    const messages = [user("go"), assistant("", [["p", "update_agent_plan"]]), tool("p", "update_agent_plan", undefined, false), tool("orphan", "scan_subtitle_files", { files: [] })];
    expect(shape(messages)).toEqual(["user", "tools:p,orphan"]);
  });
});
