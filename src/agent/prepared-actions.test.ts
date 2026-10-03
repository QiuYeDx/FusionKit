import { beforeEach, describe, expect, it, vi } from "vitest";
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
const register = (execute = vi.fn().mockResolvedValue({ success: true, data: { taskId: "task-one" } }), cleanup = vi.fn()) => ({
  action: registerPreparedAction({ sessionId: "prepared-test", toolKey: "subtitleStudio", title: "Translation", summary: "One document", execute, cleanup }), execute, cleanup,
});

describe("prepared action authority", () => {
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
