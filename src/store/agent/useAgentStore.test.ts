import { beforeEach, describe, expect, it, vi } from "vitest";
import useAgentStore from "./useAgentStore";
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
  it("does not record a receipt after a reset while apply is in flight", async () => {
    let resolve!: (result: never) => void;
    vi.mocked(applyNameTranslationPlan).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const operation = useAgentStore.getState().confirmNameTranslationPlan("rename-p");
    useAgentStore.getState().resetSession(); resolve({ planId: "rename-p" } as never); await operation;
    expect(useAgentStore.getState().pendingNameTranslationPlan).toBeNull();
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
    expect(useAgentStore.getState().pendingNameTranslationPlan?.error).toContain("不要重复应用");
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
