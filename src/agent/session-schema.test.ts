import { describe, expect, it } from "vitest";
import { MAX_SESSION_BYTES, parseSessionJson } from "./session-schema";
import { AGENT_LOG_ENTRY_TYPES, AGENT_UI_EVENT_KINDS } from "./types";
const session = () => ({ version: 1, exportedAt: 1, executionMode: "queue_only", session: {
  id: "old-session", messages: [{ id: "one", role: "user", content: "Hello", timestamp: 1 }], status: "streaming", createdAt: 1, updatedAt: 1,
}, tokenStats: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalCost: 0, stepCount: 0, lastPromptTokens: 0, interactions: [] }, sessionLog: [] });

describe("Agent session import validation", () => {
  it("accepts valid legacy v1 exports without a plan", () => { expect(parseSessionJson(JSON.stringify(session())).session.id).toBe("old-session"); });
  it.each([-1, 0, 2, 1.5])("rejects unsupported version %s", version => { expect(() => parseSessionJson(JSON.stringify({ ...session(), version }))).toThrow(); });
  it("rejects malformed nested data and execution modes", () => {
    expect(() => parseSessionJson(JSON.stringify({ ...session(), executionMode: "run-anything" }))).toThrow();
    const data = session(); data.tokenStats.totalCost = -1;
    expect(() => parseSessionJson(JSON.stringify(data))).toThrow();
    (data.session.messages[0] as { role: string }).role = "unknown";
    expect(() => parseSessionJson(JSON.stringify(data))).toThrow();
  });
  it("rejects excessive byte size before parsing", () => { expect(() => parseSessionJson("x".repeat(MAX_SESSION_BYTES + 1))).toThrow(/8 MiB/); });
  it("validates plan dependencies and strips imported capabilities", () => {
    const data = session();
    const extended = { ...data, pendingExecution: { stores: ["translate"] }, session: { ...data.session, plan: { id: "p", goal: "Goal", updatedAt: 1, steps: [{ id: "a", title: "Do it", status: "pending", dependsOn: [] }] } } };
    expect(parseSessionJson(JSON.stringify(extended))).not.toHaveProperty("pendingExecution");
    extended.session.plan.steps[0].dependsOn = ["missing"] as never;
    expect(() => parseSessionJson(JSON.stringify(extended))).toThrow(/plan/);
  });
  it("round-trips every interface event, every log entry type and the list fields", () => {
    const data = session();
    const messages = [...data.session.messages, ...AGENT_UI_EVENT_KINDS.map((kind, index) => ({ id: `event-${index}`, role: "user", content: kind, timestamp: 2, event: { kind, values: { n: index } } }))];
    const sessionLog = AGENT_LOG_ENTRY_TYPES.map((type, index) => ({ id: `log-${index}`, timestamp: 3, type, summary: type }));
    const saved = { ...data, session: { ...data.session, messages, title: "字幕翻译", titleSource: "manual", pinned: true }, sessionLog };
    const parsed = parseSessionJson(JSON.stringify(saved));
    expect(parsed.session.messages.map((message) => message.event?.kind).filter(Boolean)).toEqual([...AGENT_UI_EVENT_KINDS]);
    expect(parsed.sessionLog.map((entry) => entry.type)).toEqual([...AGENT_LOG_ENTRY_TYPES]);
    expect(parsed.session).toMatchObject({ title: "字幕翻译", titleSource: "manual", pinned: true });
  });
  it("keeps why a model request failed on the assistant message that reports it", () => {
    const data = session();
    const failed = { id: "failed", role: "assistant", content: "调用出错：HTTP 402", timestamp: 2, failure: { category: "balance" } };
    const parsed = parseSessionJson(JSON.stringify({ ...data, session: { ...data.session, messages: [...data.session.messages, failed] } }));
    expect(parsed.session.messages[1].failure).toEqual({ category: "balance" });
    expect(parsed.session.messages[0]).not.toHaveProperty("failure");
    for (const bad of [{ ...failed, role: "user" }, { ...failed, failure: { category: "ok" } }, { ...failed, failure: { category: "auth", detail: "x" } }]) {
      expect(() => parseSessionJson(JSON.stringify({ ...data, session: { ...data.session, messages: [bad] } }))).toThrow();
    }
  });
});
