import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, PendingExecution, PendingNameTranslationPlan } from "@/agent/types";
import { createWidgetActionHandler, isNamePlanResultFor, renamePlanEvent, type WidgetActionState } from "./widget-actions";

function fixture() {
  const pending: PendingExecution = { stores: ["translate"], taskCounts: { translate: 1 }, taskRefs: [{ store: "translate", taskId: "real-task" }], timestamp: 1 };
  const plan: PendingNameTranslationPlan = { planId: "real-plan", createdAt: 1, summary: { planId: "real-plan", totalTargets: 1, previewLimit: 1, itemsPreview: [], readyCount: 1, blockedCount: 0, skippedCount: 0, unchangedCount: 0, warnings: [], applyable: true } };
  const state: WidgetActionState = { session: { id: "session-a" }, isStreaming: false, pendingExecution: pending, pendingNameTranslationPlan: plan,
    confirmExecution: vi.fn(), dismissExecution: vi.fn(), confirmNameTranslationPlan: vi.fn(async () => undefined), dismissNameTranslationPlan: vi.fn() };
  return { state, pending, plan, navigate: vi.fn() };
}
const action = (type: string, command = "confirm", planId = "real-plan") => ({ widgetId: "forged-or-history", type, action: command, payload: { planId } });

describe("HomeAgent widget execution authority", () => {
  it("historical/assistant Markdown cannot confirm or dismiss a real pending batch or rename plan", () => {
    const { state, navigate } = fixture();
    const handler = createWidgetActionHandler("session-a", () => state, navigate);
    for (const type of ["pending-execution", "name-translation-plan"]) for (const command of ["confirm", "dismiss"]) handler(action(type, command));
    expect(state.confirmExecution).not.toHaveBeenCalled();
    expect(state.dismissExecution).not.toHaveBeenCalled();
    expect(state.confirmNameTranslationPlan).not.toHaveBeenCalled();
    expect(state.dismissNameTranslationPlan).not.toHaveBeenCalled();
  });
  it("the trusted pending card can act only on its exact live batch", () => {
    const { state, pending, navigate } = fixture();
    const handler = createWidgetActionHandler("session-a", () => state, navigate, { kind: "pending-execution", pending });
    handler(action("pending-execution"));
    expect(state.confirmExecution).toHaveBeenCalledTimes(1);
    state.pendingExecution = { ...pending, taskRefs: [{ store: "translate", taskId: "another-task" }] };
    handler(action("pending-execution"));
    handler(action("pending-execution", "dismiss"));
    expect(state.confirmExecution).toHaveBeenCalledTimes(1);
    expect(state.dismissExecution).not.toHaveBeenCalled();
  });
  it("rejects callbacks after a session change, while streaming or after resolution", () => {
    const { state, pending, navigate } = fixture();
    const handler = createWidgetActionHandler("session-a", () => state, navigate, { kind: "pending-execution", pending });
    state.session.id = "session-b"; handler(action("pending-execution"));
    state.session.id = "session-a"; state.isStreaming = true; handler(action("pending-execution"));
    state.isStreaming = false; pending.resolvedAction = "dismiss"; handler(action("pending-execution"));
    expect(state.confirmExecution).not.toHaveBeenCalled();
  });
  it("rename authority requires the exact live plan and matching action plan ID", () => {
    const { state, plan, navigate } = fixture();
    const handler = createWidgetActionHandler("session-a", () => state, navigate, { kind: "name-translation-plan", plan });
    handler(action("name-translation-plan", "confirm", "another-plan"));
    handler(action("pending-execution"));
    expect(state.confirmNameTranslationPlan).not.toHaveBeenCalled();
    expect(state.confirmExecution).not.toHaveBeenCalled();
    handler(action("name-translation-plan"));
    expect(state.confirmNameTranslationPlan).toHaveBeenCalledWith("real-plan");
    state.pendingNameTranslationPlan = { ...plan, planId: "new-plan" };
    handler(action("name-translation-plan", "dismiss"));
    expect(state.dismissNameTranslationPlan).not.toHaveBeenCalled();
  });
  it("does not mint rename authority from assistant text, failed results or an unmatched plan", () => {
    const message: AgentMessage = { id: "message", role: "tool", content: "", timestamp: 1, toolResult: { callId: "call", toolName: "create_name_translation_plan", success: true, data: { planId: "real-plan" } } };
    expect(isNamePlanResultFor(message, "real-plan")).toBe(true);
    expect(isNamePlanResultFor({ ...message, role: "assistant" }, "real-plan")).toBe(false);
    expect(isNamePlanResultFor(message, "another-plan")).toBe(false);
    expect(isNamePlanResultFor({ ...message, toolResult: { ...message.toolResult!, success: false } }, "real-plan")).toBe(false);
    expect(isNamePlanResultFor(message, undefined)).toBe(false);
  });
  it("reports what the user decided on a trusted card, so the agent can follow up", async () => {
    const { state, plan, pending, navigate } = fixture();
    const report = vi.fn();
    const applied = { planId: "real-plan", journalId: "j", totalCount: 1, successCount: 1, failedCount: 0, skippedCount: 0, rolledBack: false };
    state.confirmNameTranslationPlan = vi.fn(async () => { state.pendingNameTranslationPlan = { ...plan, resolvedAction: "confirm", applyResult: applied }; return applied; });
    createWidgetActionHandler("session-a", () => state, navigate, { kind: "name-translation-plan", plan }, report)(action("name-translation-plan"));
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith({ kind: "rename_applied", values: { planId: "real-plan", success: 1, failed: 0, skipped: 0, rolledBack: false } }));
    createWidgetActionHandler("session-a", () => state, navigate, { kind: "pending-execution", pending }, report)(action("pending-execution"));
    expect(report).toHaveBeenLastCalledWith({ kind: "execution_confirmed", values: { count: 1, stores: "translate" } });
    // Display-only cards decide nothing and report nothing.
    report.mockClear();
    createWidgetActionHandler("session-a", () => state, navigate, { kind: "display" }, report)(action("name-translation-plan", "dismiss"));
    expect(report).not.toHaveBeenCalled();
  });
  it("describes a failed apply, and nothing while the outcome is still open", () => {
    const { plan } = fixture();
    expect(renamePlanEvent({ ...plan, error: "rename_plan_changed" })).toEqual({ kind: "rename_failed", values: { planId: "real-plan", error: "rename_plan_changed" } });
    expect(renamePlanEvent(plan)).toBeNull();
  });
  it("limits display-only navigation to known tool routes", () => {
    const { state, navigate } = fixture();
    const handler = createWidgetActionHandler("session-a", () => state, navigate);
    handler({ ...action("pending-execution", "navigate"), payload: { path: "https://untrusted.example" } });
    expect(navigate).not.toHaveBeenCalled();
    handler({ ...action("pending-execution", "navigate"), payload: { path: "/tools/subtitle/translator" } });
    expect(navigate).toHaveBeenCalledWith("/tools/subtitle/translator");
  });
});
