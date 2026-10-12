import { beforeEach, describe, expect, it, vi } from "vitest";
import useAgentStore, { createSessionSlot } from "./useAgentStore";
import { applyAgentNamePlan as applyNameTranslationPlan } from "@/services/name-translation/agentPlan";

vi.mock("@/services/name-translation/agentPlan", () => ({ getAgentNamePlan: () => ({ summary: { applyable: true } }), applyAgentNamePlan: vi.fn() }));
const pending = () => ({ planId: "rename-p", createdAt: 1, createdByUserMessageId: "user-before", summary: {} as never });
beforeEach(() => {
  vi.clearAllMocks(); useAgentStore.getState().resetSession();
  useAgentStore.getState().setPendingNameTranslationPlan(pending());
  vi.mocked(applyNameTranslationPlan).mockResolvedValue({ planId: "rename-p", appliedCount: 1 } as never);
});

describe("Agent state boundaries", () => {
  it("claims rename confirmation synchronously across duplicate clicks", async () => {
    await Promise.all([useAgentStore.getState().confirmNameTranslationPlan("rename-p"), useAgentStore.getState().confirmNameTranslationPlan("rename-p")]);
    expect(applyNameTranslationPlan).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().pendingNameTranslationPlan?.resolvedAction).toBe("confirm");
  });
  it("records an apply receipt in its own session after the user started another one", async () => {
    let resolve!: (result: never) => void;
    vi.mocked(applyNameTranslationPlan).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const owner = useAgentStore.getState().activeSessionId;
    const operation = useAgentStore.getState().confirmNameTranslationPlan("rename-p");
    useAgentStore.getState().resetSession(); resolve({ planId: "rename-p" } as never); await operation;
    expect(useAgentStore.getState().pendingNameTranslationPlan).toBeNull();
    expect(useAgentStore.getState().slots[owner].pendingNameTranslationPlan).toMatchObject({ resolvedAction: "confirm", applyResult: { planId: "rename-p" } });
  });
  it("does not overwrite a new preview with an old apply receipt", async () => {
    let resolve!: (result: never) => void;
    vi.mocked(applyNameTranslationPlan).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const operation = useAgentStore.getState().confirmNameTranslationPlan("rename-p");
    await Promise.resolve();
    useAgentStore.getState().setPendingNameTranslationPlan({ ...pending(), planId: "new" });
    resolve({ planId: "rename-p", appliedCount: 1 } as never); await operation;
    expect(useAgentStore.getState().pendingNameTranslationPlan?.planId).toBe("new");
    expect(useAgentStore.getState().pendingNameTranslationPlan?.applyResult).toBeUndefined();
  });
  it("prevents replay after an ambiguous apply failure", async () => {
    vi.mocked(applyNameTranslationPlan).mockRejectedValue(new Error("IPC lost"));
    await useAgentStore.getState().confirmNameTranslationPlan("rename-p");
    await useAgentStore.getState().confirmNameTranslationPlan("rename-p");
    expect(applyNameTranslationPlan).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().pendingNameTranslationPlan).toMatchObject({
      error: "rename_apply_outcome_unknown", errorDetail: "IPC lost", resolvedAction: "confirm",
    });
  });
  it("keeps a definite pre-rename rejection retryable instead of ambiguous", async () => {
    vi.mocked(applyNameTranslationPlan).mockRejectedValue(new Error("rename_plan_changed"));
    await useAgentStore.getState().confirmNameTranslationPlan("rename-p");
    const plan = useAgentStore.getState().pendingNameTranslationPlan;
    expect(plan).toMatchObject({ error: "rename_plan_changed", isApplying: false });
    expect(plan?.resolvedAction).toBeFalsy();
    expect(plan).not.toHaveProperty("errorDetail");
  });
  it("imports display history into a new idle session without confirmations", () => {
    const state = useAgentStore.getState();
    state.updatePlan({ goal: "Work", steps: [{ id: "a", title: "Start", status: "in_progress" }] });
    const data = state.getSessionExportData(); data.session.status = "streaming"; data.executionMode = "auto_execute";
    state.restoreSession(data);
    const restored = useAgentStore.getState();
    expect(restored.session.id).not.toBe(data.session.id);
    expect(restored.session.status).toBe("idle");
    expect(restored.executionMode).toBe("queue_only");
    expect(restored.session.plan?.steps[0].status).toBe("pending");
    expect(restored.pendingNameTranslationPlan).toBeNull();
    expect(restored.pendingExecution).toBeNull();
  });
});

const user = (content: string, id = content) => ({ id, role: "user" as const, content, timestamp: 1 });
const reply = (content: string) => ({ id: `r-${content}`, role: "assistant" as const, content, timestamp: 2 });
const state = () => useAgentStore.getState();
/** Every field the interface reads equals the current session's slot. */
function expectProjection() {
  const { slots, activeSessionId } = state();
  const slot = slots[activeSessionId];
  for (const key of ["session", "isStreaming", "streamingText", "activeToolCalls", "tokenStats", "sessionLog", "pendingExecution", "pendingNameTranslationPlan"] as const) {
    expect(state()[key]).toBe(slot[key]);
  }
}

describe("multiple sessions", () => {
  beforeEach(() => { state().removeAllSessions(); });

  it("keeps the previous session when a new one starts and reuses a blank one", () => {
    state().addMessage(user("first question"));
    const first = state().activeSessionId;
    const second = state().createSession();
    expect(second).not.toBe(first);
    expect(state().session.messages).toEqual([]);
    expect(state().slots[first].session.messages).toHaveLength(1);
    expect(state().catalog[first]).toMatchObject({ title: "first question", messageCount: 1 });
    expect(state().createSession()).toBe(second);
    expectProjection();
  });

  it("shows each session's own messages, plan, usage, log and confirmations", () => {
    state().addMessage(user("A"));
    state().updatePlan({ goal: "A goal", steps: [{ id: "a", title: "A step", status: "in_progress" }] });
    state().recordUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.1, stepCount: 1, lastPromptTokens: 10 });
    state().appendLog("status_change", "A log");
    state().setPendingExecution({ stores: ["translate"], taskCounts: { translate: 1 }, timestamp: 1 });
    const a = state().activeSessionId;
    state().createSession();
    state().addMessage(user("B"));
    expect(state().session.plan).toBeUndefined();
    expect(state().tokenStats.totalTokens).toBe(0);
    expect(state().sessionLog).toEqual([]);
    expect(state().pendingExecution).toBeNull();
    const b = state().activeSessionId;
    expect(state().activateSession(a)).toBe(true);
    expect(state().session.messages.map((message) => message.content)).toEqual(["A"]);
    expect(state().session.plan?.goal).toBe("A goal");
    expect(state().tokenStats.totalTokens).toBe(15);
    expect(state().sessionLog.map((entry) => entry.summary)).toEqual(["A log"]);
    expect(state().pendingExecution).not.toBeNull();
    expectProjection();
    state().activateSession(b);
    expect(state().session.messages.map((message) => message.content)).toEqual(["B"]);
    expectProjection();
  });

  it("writes a background session without touching what the user sees, and marks its reply unread", () => {
    state().addMessage(user("A"));
    const a = state().activeSessionId;
    state().createSession();
    state().addMessage(user("B"));
    const shown = state().session;
    const background = state().forSession(a);
    background.setStreaming(true);
    background.appendStreamingText("partial");
    background.commitStepBatch("A answer", [], []);
    background.setStatus("idle");
    background.setStreaming(false);
    expect(state().session).toBe(shown);
    expect(state().isStreaming).toBe(false);
    expect(state().slots[a].session.messages.map((message) => message.content)).toEqual(["A", "A answer"]);
    expect(state().slots[a].unread).toBe(true);
    expectProjection();
    state().activateSession(a);
    expect(state().slots[a].unread).toBe(false);
    expect(state().session.messages).toHaveLength(2);
  });

  it("drops a blank session the user leaves and treats writes to removed sessions as no-ops", () => {
    state().addMessage(user("A"));
    const a = state().activeSessionId;
    const blank = state().createSession();
    state().activateSession(a);
    expect(state().slots[blank]).toBeUndefined();
    const writer = state().forSession(blank);
    writer.addMessage(user("late"));
    expect(state().slots[blank]).toBeUndefined();
    expect(state().catalog[blank]).toBeUndefined();
  });

  it("removing the current session shows a new blank one", () => {
    state().addMessage(user("A"));
    const a = state().activeSessionId;
    state().removeSession(a);
    expect(state().hasSession(a)).toBe(false);
    expect(state().catalog[a]).toBeUndefined();
    expect(state().activeSessionId).not.toBe(a);
    expect(state().session.messages).toEqual([]);
    expectProjection();
  });

  it("renames manually, ignores blank names and keeps the place in the list", () => {
    state().addMessage(user("A"));
    const id = state().activeSessionId;
    const updatedAt = state().session.updatedAt;
    expect(state().renameSession(id, "   ")).toBe(false);
    expect(state().renameSession(id, "  Renamed   session ")).toBe(true);
    expect(state().catalog[id]).toMatchObject({ title: "Renamed session", titleSource: "manual", updatedAt });
    state().setPinned(id, true);
    expect(state().catalog[id].pinned).toBe(true);
    expect(state().catalog[id].updatedAt).toBe(updatedAt);
  });

  it("titles a session from the first typed message only", () => {
    state().addMessage({ ...user("event text"), event: { kind: "action_completed" } });
    expect(state().session.title).toBeUndefined();
    state().addMessage(user("second line\nreal question"));
    expect(state().session).toMatchObject({ title: "second line", titleSource: "auto" });
    state().addMessage(user("later"));
    expect(state().session.title).toBe("second line");
  });

  it("does not move the context meter for a side request", () => {
    state().recordUsage({ promptTokens: 900, completionTokens: 5, totalTokens: 905, cost: 0, stepCount: 1, lastPromptTokens: 900 });
    state().recordUsage({ promptTokens: 40, completionTokens: 8, totalTokens: 48, cost: 0.001, stepCount: 0, lastPromptTokens: 40 }, { keepContext: true });
    expect(state().tokenStats).toMatchObject({ totalTokens: 953, lastPromptTokens: 900 });
  });

  it("adopts a saved session settled, and the saved list keeps loaded sessions current", () => {
    const saved = createSessionSlot({ id: "saved", messages: [user("old"), reply("answer")], status: "idle", createdAt: 1, updatedAt: 5, title: "Old", titleSource: "generated" });
    state().setCatalog([{ id: "saved", title: "Old", titleSource: "generated", pinned: false, createdAt: 1, updatedAt: 5, messageCount: 2, preview: "answer" },
      { id: "other", title: "Other", titleSource: "auto", pinned: true, createdAt: 1, updatedAt: 2, messageCount: 1, preview: "" }]);
    state().adoptSession(saved, { activate: true });
    expect(state().session.id).toBe("saved");
    expect(state().catalog.other.pinned).toBe(true);
    state().markUnreadable("other");
    expect(state().catalog.other.unreadable).toBe(true);
    expect(state().renameSession("other", "x")).toBe(false);
  });

  it("imports a file as a new session that keeps its title", () => {
    state().addMessage(user("current"));
    const current = state().activeSessionId;
    const data = state().getSessionExportData();
    state().restoreSession({ ...data, session: { ...data.session, title: "Imported", titleSource: undefined } });
    expect(state().activeSessionId).not.toBe(current);
    expect(state().session).toMatchObject({ title: "Imported", titleSource: "generated" });
    expect(state().slots[current].session.messages).toHaveLength(1);
    state().restoreSession({ ...data, session: { ...data.session, title: undefined } });
    expect(state().session).toMatchObject({ title: "current", titleSource: "auto" });
  });
});
