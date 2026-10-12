import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } });
  return { turnEnd: [] as ((id: string) => void)[], abortSession: vi.fn(), abortAll: vi.fn() };
});
vi.mock("./orchestrator", () => ({
  abortSessionTurn: mocks.abortSession, abortAllTurns: mocks.abortAll,
  onTurnEnd: (listener: (id: string) => void) => { mocks.turnEnd.push(listener); return () => {}; },
}));

import useAgentStore from "@/store/agent/useAgentStore";
import type { AgentSessionsApi, SaveAgentSessionRequest, StoredAgentSessionMeta } from "./session-store-contract";
import { MAX_STORED_SESSION_BYTES } from "./session-store-contract";
import { clearAllSessions, deleteSession, initAgentSessions, openSession, renameSession, SAVE_DELAY_MS, saveSessionNow, serializeSession, useSessionPersistenceStore } from "./session-persistence";
import type { SessionExportData } from "./types";

const files = new Map<string, string>();
const disk: AgentSessionsApi = {
  list: vi.fn(async () => ({ ok: true as const, value: [] as StoredAgentSessionMeta[] })),
  load: vi.fn(async (id: string) => files.has(id) ? { ok: true as const, value: files.get(id)! } : { ok: false as const, error: "agent_session_not_found" as const }),
  save: vi.fn(async (request: SaveAgentSessionRequest) => { files.set(request.meta.id, request.content); return { ok: true as const, value: null }; }),
  remove: vi.fn(async (id: string) => { files.delete(id); return { ok: true as const, value: null }; }),
  clear: vi.fn(async () => { files.clear(); return { ok: true as const, value: null }; }),
};
const state = () => useAgentStore.getState();
const user = (content: string) => ({ id: `u-${content}`, role: "user" as const, content, timestamp: 1 });
const saved = (id: string, extra: Record<string, unknown> = {}): SessionExportData => ({
  version: 1, exportedAt: 1, executionMode: "auto_execute",
  session: { id, messages: [user("old question"), { id: "r", role: "assistant", content: "old answer", timestamp: 2 }], status: "streaming", createdAt: 1, updatedAt: 5,
    title: "Old work", titleSource: "generated", plan: { id: "p", goal: "Goal", updatedAt: 1, steps: [{ id: "s", title: "Step", status: "in_progress", dependsOn: [] }] }, ...extra },
  tokenStats: { totalPromptTokens: 7, totalCompletionTokens: 3, totalTokens: 10, totalCost: 0.5, stepCount: 1, lastPromptTokens: 7, interactions: [] },
  sessionLog: [{ id: "l", timestamp: 1, type: "usage", summary: "10 tokens" }],
});
const meta = (id: string): StoredAgentSessionMeta => ({ id, title: "Old work", titleSource: "generated", pinned: false, createdAt: 1, updatedAt: 5, messageCount: 2, preview: "old answer" });

beforeAll(async () => {
  vi.stubGlobal("window", { agentSessions: disk, addEventListener: vi.fn() });
  await initAgentSessions();
});
beforeEach(() => {
  vi.useFakeTimers();
  files.clear();
  state().removeAllSessions();
  useSessionPersistenceStore.setState({ loading: {}, saveErrors: {} });
  vi.clearAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

describe("saving sessions", () => {
  it("saves a session with messages shortly after it changes, never a blank one", async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(disk.save).not.toHaveBeenCalled();
    state().addMessage(user("hello"));
    state().appendLog("status_change", "one");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
    expect(disk.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.save).toHaveBeenCalledTimes(1);
    const request = vi.mocked(disk.save).mock.calls[0][0];
    expect(request.meta).toMatchObject({ id: state().activeSessionId, title: "hello", titleSource: "auto", messageCount: 1, preview: "hello" });
    expect(JSON.parse(request.content).session.messages).toHaveLength(1);
  });

  it("saves at once when a turn ends", async () => {
    state().addMessage(user("hello"));
    for (const listener of mocks.turnEnd) listener(state().activeSessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(disk.save).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed session in memory, reports it, and clears the report after a later save", async () => {
    vi.mocked(disk.save).mockResolvedValueOnce({ ok: false, error: "agent_session_write_failed" });
    state().addMessage(user("hello"));
    const id = state().activeSessionId;
    await saveSessionNow(id);
    expect(useSessionPersistenceStore.getState().saveErrors[id]).toBe("agent_session_write_failed");
    expect(state().session.messages).toHaveLength(1);
    await saveSessionNow(id);
    expect(useSessionPersistenceStore.getState().saveErrors[id]).toBeUndefined();
  });

  it("drops the oldest log details first, then old log entries, to stay within the limit", () => {
    const data = saved("big");
    const detail = "x".repeat(1024 * 1024);
    data.sessionLog = Array.from({ length: 12 }, (_, index) => ({ id: `l${index}`, timestamp: index, type: "tool_result" as const, summary: `entry ${index}`, data: { output: detail } }));
    const trimmed = JSON.parse(serializeSession(data)!) as SessionExportData;
    expect(trimmed.sessionLog).toHaveLength(12);
    expect(trimmed.sessionLog.every((entry) => !entry.data)).toBe(true);
    data.sessionLog = Array.from({ length: 40 }, (_, index) => ({ id: `l${index}`, timestamp: index, type: "usage" as const, summary: "s".repeat(400_000) }));
    const fewer = JSON.parse(serializeSession(data)!) as SessionExportData;
    expect(fewer.sessionLog.length).toBeLessThan(40);
    expect(fewer.sessionLog.at(-1)?.id).toBe("l39");
    data.session.messages = [user("m".repeat(MAX_STORED_SESSION_BYTES))];
    expect(serializeSession(data)).toBeNull();
  });
});

describe("reading sessions back", () => {
  it("opens a saved session idle, with its plan step no longer in progress and no confirmation", async () => {
    files.set("saved-a", JSON.stringify(saved("saved-a")));
    state().setCatalog([meta("saved-a")]);
    expect(await openSession("saved-a")).toBe(true);
    expect(state().activeSessionId).toBe("saved-a");
    expect(state().session).toMatchObject({ status: "idle", title: "Old work", titleSource: "generated" });
    expect(state().session.plan?.steps[0].status).toBe("pending");
    expect(state()).toMatchObject({ pendingExecution: null, pendingNameTranslationPlan: null });
    expect(state().tokenStats.totalTokens).toBe(10);
    expect(state().executionMode).not.toBe("auto_execute");
  });

  it("marks a damaged file unreadable and stays where it was", async () => {
    files.set("broken", "{ not json");
    state().setCatalog([meta("broken")]);
    const before = state().activeSessionId;
    expect(await openSession("broken")).toBe(false);
    expect(state().catalog.broken.unreadable).toBe(true);
    expect(state().activeSessionId).toBe(before);
    expect(useSessionPersistenceStore.getState().loading).toEqual({});
  });

  it("renames a session that is not open yet and saves the new name", async () => {
    files.set("saved-b", JSON.stringify(saved("saved-b")));
    state().setCatalog([meta("saved-b")]);
    expect(await renameSession("saved-b", "  New name ")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(files.get("saved-b")!).session).toMatchObject({ title: "New name", titleSource: "manual" });
    expect(state().activeSessionId).not.toBe("saved-b");
  });
});

describe("deleting sessions", () => {
  it("stops the reply, forgets the waiting save and removes the file", async () => {
    state().addMessage(user("delete me"));
    const id = state().activeSessionId;
    expect(await deleteSession(id)).toBe(true);
    expect(mocks.abortSession).toHaveBeenCalledWith(id);
    expect(disk.remove).toHaveBeenCalledWith(id);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(disk.save).not.toHaveBeenCalled();
    expect(state().hasSession(id)).toBe(false);
    expect(state().session.messages).toEqual([]);
  });

  it("clears everything and starts with a blank session", async () => {
    state().addMessage(user("one"));
    state().createSession();
    state().addMessage(user("two"));
    files.set("other", "{}");
    expect(await clearAllSessions()).toBe(true);
    expect(mocks.abortAll).toHaveBeenCalled();
    expect(disk.clear).toHaveBeenCalled();
    expect(Object.keys(state().catalog)).toEqual([]);
    expect(state().session.messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(disk.save).not.toHaveBeenCalled();
  });
});
