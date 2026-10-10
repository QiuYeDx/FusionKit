import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAgentStore from "@/store/agent/useAgentStore";
import { registerPreparedAction, usePreparedActionsStore } from "./prepared-actions";

function setSession(id: string) {
  useAgentStore.setState({ session: { ...useAgentStore.getState().session, id } });
}
beforeEach(() => {
  setSession(`reset-${Math.random()}`);
  usePreparedActionsStore.setState({ actions: [] });
  setSession("prepared-test");
});
afterEach(() => { vi.restoreAllMocks(); });
const register = (execute = vi.fn().mockResolvedValue({ success: true, data: { taskId: "task-one" } }), cleanup = vi.fn()) => ({
  action: registerPreparedAction({ sessionId: "prepared-test", toolKey: "subtitleStudio", title: "Translation", summary: "One document", execute, cleanup }), execute, cleanup,
});

describe("prepared action authority", () => {
  it("passes the card's choice to the action and keeps confirmation-only actions and their details", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, data: { executionStatus: "saved" } });
    const knowledge = { items: [], counts: { subjects: 0, collections: 0, created: 1, updated: 0, archived: 0, existing: 0 }, adoptDefault: false, adoptable: 1 };
    const action = registerPreparedAction({ sessionId: "prepared-test", toolKey: "translationKnowledge", title: "Save", summary: "One term", requiresConfirmation: true, knowledge, execute });
    expect(action).toMatchObject({ requiresConfirmation: true, knowledge });
    await usePreparedActionsStore.getState().confirmAction(action.id, { adopt: true });
    expect(execute).toHaveBeenCalledWith({ adopt: true });
    const plain = register();
    expect(plain.action.requiresConfirmation).toBeUndefined();
    await usePreparedActionsStore.getState().confirmAction(plain.action.id);
    expect(plain.execute).toHaveBeenCalledWith(undefined);
  });
  it("timestamps actual state changes when an older preparation completes after newer actions", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let finish!: (value: unknown) => void;
    const older = register(vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    expect(older.action.updatedAt).toBe(1000);
    now.mockReturnValue(2000); const newer = register();
    now.mockReturnValue(3000); await usePreparedActionsStore.getState().confirmAction(newer.action.id);
    now.mockReturnValue(4000); const pending = usePreparedActionsStore.getState().confirmAction(older.action.id);
    expect(usePreparedActionsStore.getState().actions.find(item => item.id === older.action.id)).toMatchObject({ status: "running", updatedAt: 4000 });
    now.mockReturnValue(5000); finish({ success: false, error: "revision_conflict" }); await pending;
    const actions = usePreparedActionsStore.getState().actions;
    expect(actions.find(item => item.id === newer.action.id)).toMatchObject({ status: "completed", updatedAt: 3000 });
    expect(actions.find(item => item.id === older.action.id)).toMatchObject({ status: "failed", updatedAt: 5000 });
    now.mockReturnValue(6000); const dismissed = register();
    now.mockReturnValue(7000); usePreparedActionsStore.getState().dismissAction(dismissed.action.id);
    expect(usePreparedActionsStore.getState().actions.find(item => item.id === dismissed.action.id)).toMatchObject({ status: "dismissed", updatedAt: 7000 });
  });
  it("claims synchronously so concurrent confirmation submits only once", async () => {
    let finish!: (value: unknown) => void;
    const execute = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const value = register(execute);
    const first = usePreparedActionsStore.getState().confirmAction(value.action.id);
    const second = usePreparedActionsStore.getState().confirmAction(value.action.id);
    expect(usePreparedActionsStore.getState().actions[0].status).toBe("running");
    expect(execute).toHaveBeenCalledTimes(1);
    finish({ success: true, data: { executionStatus: "queued" } });
    await Promise.all([first, second]);
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ status: "completed", result: { executionStatus: "queued" } });
    expect(value.cleanup).toHaveBeenCalledTimes(1);
  });
  it("dismisses previous-session authority and invokes cleanup once", async () => {
    const value = register();
    setSession("new-session");
    await usePreparedActionsStore.getState().confirmAction(value.action.id);
    usePreparedActionsStore.getState().dismissAction(value.action.id);
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.cleanup).toHaveBeenCalledTimes(1);
    expect(usePreparedActionsStore.getState().actions[0].status).toBe("dismissed");
  });
  it("never retries a failed or ambiguous invocation and does not expose thrown secrets", async () => {
    const value = register(vi.fn().mockRejectedValue(new Error("https://secret.example apiKey=private")));
    await usePreparedActionsStore.getState().confirmAction(value.action.id);
    await usePreparedActionsStore.getState().confirmAction(value.action.id);
    expect(value.execute).toHaveBeenCalledTimes(1);
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ status: "failed", error: "prepared_action_failed" });
    expect(JSON.stringify(usePreparedActionsStore.getState())).not.toContain("private");
  });
  it("retains preparation details and all-failed submission receipts without enabling retry", async () => {
    const preparationReceipt = { phase: "preparation" as const, total: 1, successCount: 1, failureCount: 0,
      items: [{ id: "doc-one", name: "one.srt", status: "ready" as const }] };
    const submissionReceipt = { phase: "submission" as const, total: 1, successCount: 0, failureCount: 1,
      items: [{ id: "doc-one", name: "one.srt", status: "failed" as const, error: "revision_conflict" }] };
    const execute = vi.fn().mockResolvedValue({ success: false, error: "not_admitted", data: { receipt: submissionReceipt } });
    const action = registerPreparedAction({ sessionId: "prepared-test", toolKey: "subtitleStudio", title: "Translation", summary: "One document", preparationReceipt, execute });
    await usePreparedActionsStore.getState().confirmAction(action.id);
    await usePreparedActionsStore.getState().confirmAction(action.id);
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ status: "failed", preparationReceipt, error: "not_admitted", result: { receipt: submissionReceipt } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("keeps running receipts truthful when the chat changes", async () => {
    let finish!: (value: unknown) => void;
    const value = register(vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    const pending = usePreparedActionsStore.getState().confirmAction(value.action.id);
    setSession("another-session");
    finish({ success: true, data: { taskId: "accepted-task" } });
    await pending;
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ sessionId: "prepared-test", status: "completed", result: { taskId: "accepted-task" } });
  });
  it("refuses stale registrations and bounds pending authority without silently deleting it", () => {
    expect(() => registerPreparedAction({ sessionId: "stale", title: "x", summary: "x", toolKey: "subtitleStudio", execute: vi.fn() })).toThrow("agent_session_changed");
    for (let index = 0; index < 12; index++) register();
    expect(() => register()).toThrow("prepared_action_limit");
    expect(usePreparedActionsStore.getState().actions).toHaveLength(12);
    expect(JSON.stringify(usePreparedActionsStore.getState().actions)).not.toMatch(/execute|cleanup/);
  });
});
