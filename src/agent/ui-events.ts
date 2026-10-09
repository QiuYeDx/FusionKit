import type { AgentPlan, AgentUiEvent } from "./types";

// ---------------------------------------------------------------------------
// Interface events — what the user did on a card (a rename preview, a prepared
// action, a classic execution confirmation), reported to the agent so it can
// follow up without the user having to ask. They are FusionKit's words, not the
// user's, and never authorize anything.
// ---------------------------------------------------------------------------

export const UI_EVENT_PREFIX = "[FusionKit UI event]";

const text = (value: unknown, max = 200) => String(value ?? "").replace(/\s+/g, " ").slice(0, max);

function describe(event: AgentUiEvent): string {
  const v = event.values ?? {};
  switch (event.kind) {
    case "rename_applied":
      return `The user confirmed rename plan ${text(v.planId)} with the preview card's button and FusionKit applied it: ${Number(v.success ?? 0)} renamed, ${Number(v.failed ?? 0)} failed, ${Number(v.skipped ?? 0)} skipped${v.rolledBack ? "; every change was rolled back" : ""}.`;
    case "rename_failed":
      return `The user confirmed rename plan ${text(v.planId)} with the preview card's button, but applying it did not complete (${text(v.error)}).`;
    case "rename_dismissed":
      return `The user cancelled rename plan ${text(v.planId)} on the preview card. Nothing was renamed.`;
    case "action_completed":
      return `The user confirmed the prepared action "${text(v.title)}" (${text(v.actionId)}) and it was submitted. Submission is not completion.`;
    case "action_failed":
      return `The user confirmed the prepared action "${text(v.title)}" (${text(v.actionId)}), but it was not submitted (${text(v.error)}).`;
    case "action_dismissed":
      return `The user dismissed the prepared action "${text(v.title)}" (${text(v.actionId)}). It was not submitted.`;
    case "execution_confirmed":
      return `The user confirmed starting ${Number(v.count ?? 0)} queued classic task(s) (${text(v.stores)}). Starting is not completion.`;
    case "execution_dismissed":
      return "The user chose to keep the queued classic tasks in their queues without starting them.";
  }
}

/** The text the model reads for an event; the conversation shows a localized line instead. */
export function uiEventModelText(event: AgentUiEvent): string {
  return `${UI_EVENT_PREFIX} ${describe(event)} This message was written by FusionKit, not typed by the user, and authorizes nothing new.`;
}

const DISMISSALS = new Set<AgentUiEvent["kind"]>(["rename_dismissed", "action_dismissed", "execution_dismissed"]);

/**
 * Outcomes always get a follow-up: the agent reports them and updates its plan. A dismissal only
 * does when a plan still has open steps that it changes; otherwise the card already says enough.
 */
export function shouldFollowUpUiEvent(event: AgentUiEvent, plan: AgentPlan | undefined): boolean {
  if (!DISMISSALS.has(event.kind)) return true;
  return !!plan?.steps.some((step) => step.status !== "completed");
}
