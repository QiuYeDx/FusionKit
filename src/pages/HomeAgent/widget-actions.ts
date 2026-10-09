import type { AgentMessage, AgentUiEvent, PendingExecution, PendingNameTranslationPlan } from "@/agent/types";
import type { MarkdownWidgetAction } from "@/lib/markdown-types";

export interface WidgetActionState {
  session: { id: string };
  isStreaming: boolean;
  pendingExecution: PendingExecution | null;
  pendingNameTranslationPlan: PendingNameTranslationPlan | null;
  confirmExecution: () => void;
  dismissExecution: () => void;
  confirmNameTranslationPlan: (planId: string) => Promise<unknown>;
  dismissNameTranslationPlan: (planId: string) => void;
}

type Authority = { kind: "display" }
  | { kind: "pending-execution"; pending: PendingExecution }
  | { kind: "name-translation-plan"; plan: PendingNameTranslationPlan };

const toolPaths = new Set(["/tools/subtitle/translator", "/tools/subtitle/converter", "/tools/subtitle/extractor"]);

export function isNamePlanResultFor(message: AgentMessage, planId: string | undefined): boolean {
  return !!planId && message.role === "tool" && message.toolResult?.success === true
    && message.toolResult.toolName === "create_name_translation_plan"
    && message.toolResult.data?.planId === planId;
}

/** The outcome of a resolved rename plan, as reported to the agent. */
export function renamePlanEvent(plan: PendingNameTranslationPlan): AgentUiEvent | null {
  if (plan.applyResult) {
    const { successCount, failedCount, skippedCount, rolledBack } = plan.applyResult;
    return { kind: "rename_applied", values: { planId: plan.planId, success: successCount, failed: failedCount, skipped: skippedCount, rolledBack } };
  }
  if (plan.error) return { kind: "rename_failed", values: { planId: plan.planId, error: plan.error } };
  return null;
}

/**
 * Execution authority comes from a live UI receipt, never a Markdown payload. What the user decided
 * is reported, so the agent can follow up on it.
 */
export function createWidgetActionHandler(
  sessionId: string,
  readState: () => WidgetActionState,
  navigate: (path: string) => void,
  authority: Authority = { kind: "display" },
  report: (event: AgentUiEvent) => void = () => {},
) {
  return (action: MarkdownWidgetAction): void => {
    const state = readState();
    if (state.session.id !== sessionId) return;
    const payload = action.payload && typeof action.payload === "object" ? action.payload as Record<string, unknown> : {};
    if (action.action === "navigate") {
      const path = payload.path;
      if (typeof path === "string" && (toolPaths.has(path) || /^\/tools\/rename\/name-translator\?planId=[^&#]+$/.test(path))) navigate(path);
      return;
    }
    if (state.isStreaming) return;
    if (authority.kind === "pending-execution" && action.type === "pending-execution") {
      if (state.pendingExecution !== authority.pending || authority.pending.resolvedAction) return;
      const pending = authority.pending;
      if (action.action === "confirm") {
        state.confirmExecution();
        const count = Object.values(pending.taskCounts).reduce((sum, value) => sum + (value ?? 0), 0);
        report({ kind: "execution_confirmed", values: { count, stores: pending.stores.join(", ") } });
      }
      if (action.action === "dismiss") {
        state.dismissExecution();
        report({ kind: "execution_dismissed" });
      }
    }
    if (authority.kind === "name-translation-plan" && action.type === "name-translation-plan") {
      const plan = authority.plan;
      if (state.pendingNameTranslationPlan !== plan || payload.planId !== plan.planId || plan.resolvedAction || plan.isApplying) return;
      if (action.action === "confirm") {
        void state.confirmNameTranslationPlan(plan.planId).then(() => {
          const after = readState();
          if (after.session.id !== sessionId || after.pendingNameTranslationPlan?.planId !== plan.planId) return;
          const event = renamePlanEvent(after.pendingNameTranslationPlan);
          if (event) report(event);
        });
      }
      if (action.action === "dismiss") {
        state.dismissNameTranslationPlan(plan.planId);
        report({ kind: "rename_dismissed", values: { planId: plan.planId } });
      }
    }
  };
}
