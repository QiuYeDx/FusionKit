import type { AgentMessage, PendingExecution, PendingNameTranslationPlan } from "@/agent/types";
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

/** Execution authority comes from a live UI receipt, never a Markdown payload. */
export function createWidgetActionHandler(
  sessionId: string,
  readState: () => WidgetActionState,
  navigate: (path: string) => void,
  authority: Authority = { kind: "display" },
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
      if (action.action === "confirm") state.confirmExecution();
      if (action.action === "dismiss") state.dismissExecution();
    }
    if (authority.kind === "name-translation-plan" && action.type === "name-translation-plan") {
      const plan = authority.plan;
      if (state.pendingNameTranslationPlan !== plan || payload.planId !== plan.planId || plan.resolvedAction || plan.isApplying) return;
      if (action.action === "confirm") void state.confirmNameTranslationPlan(plan.planId);
      if (action.action === "dismiss") state.dismissNameTranslationPlan(plan.planId);
    }
  };
}
