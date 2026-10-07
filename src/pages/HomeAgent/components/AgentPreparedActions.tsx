import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, PauseCircle, Play, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { usePreparedActionsStore, type PreparedAction } from "@/agent/prepared-actions";
import { AGENT_CAPABILITIES } from "@/agent/capability-catalog";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { capabilityLabels } from "./AgentCapabilities";
import { actionErrorMessage } from "./action-error";
import AgentActionReceipt from "./AgentActionReceipt";
import { actionFailureReceipt, actionReceipt, agentToolPath, groupPreparedActions, objectValue } from "../presentation";

const actionStatusKeys = { ready: "home:action_ready", running: "home:action_running", completed: "home:action_completed", failed: "home:action_failed", dismissed: "home:action_dismissed" } as const;

function ActionCard({ action, busy }: { action: PreparedAction; busy: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirmAction, dismissAction } = usePreparedActionsStore();
  const capability = AGENT_CAPABILITIES.find(item => item.toolKey === action.toolKey);
  const labels = capabilityLabels[action.toolKey as keyof typeof capabilityLabels];
  const title = action.summaryKey === "home:prepared_translation_summary" ? t("home:prepared_translation_title")
    : action.summaryKey === "home:prepared_transcription_summary" ? t("home:prepared_transcription_title") : labels ? t(labels.title) : action.title;
  const summary = action.summaryKey === "home:prepared_translation_summary" ? t("home:prepared_translation_summary", action.summaryValues)
    : action.summaryKey === "home:prepared_transcription_summary" ? t("home:prepared_transcription_summary", action.summaryValues) : action.summary;
  const Icon = { ready: Play, running: Loader2, completed: CheckCircle2, failed: XCircle, dismissed: PauseCircle }[action.status];
  const submitted = action.status === "completed" && objectValue(action.result).executionStatus === "queued";
  const receipt = actionReceipt(action);
  return <SmoothCorners radius={16} smoothing={0.72} className="min-w-0 border bg-card p-3" data-action-id={action.id} data-action-status={action.status}>
    <div className="flex items-start gap-2">
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${action.status === "failed" ? "text-destructive" : "text-muted-foreground"} ${action.status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{title}</h3>
          <span className="text-[11px] text-muted-foreground">{submitted ? t("home:result_submitted") : t(actionStatusKeys[action.status])}</span>
        </div>
        <p className="mt-1 whitespace-pre-line text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{summary}</p>
        {action.error && <p className="mt-2 text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(action.error, t)}</p>}
        {action.preparationReceipt && receipt?.phase === "submission" && <AgentActionReceipt receipt={action.preparationReceipt} />}
        {receipt && <AgentActionReceipt receipt={receipt} />}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {action.status === "ready" && <>
        <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void confirmAction(action.id)}>{t("home:action_confirm")}</Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => dismissAction(action.id)}>{t("home:action_dismiss")}</Button>
      </>}
      {capability && <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={() => navigate(agentToolPath(action.toolKey, capability.route, action.summaryKey))}>{t("home:open_tool")}</Button>}
    </div>
  </SmoothCorners>;
}

export default function AgentPreparedActions({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const { t } = useTranslation();
  const actions = usePreparedActionsStore(state => state.actions);
  const [expanded, setExpanded] = useState("");
  const { active, history, failedCount, latestFailure } = groupPreparedActions(actions, sessionId);
  if (!active.length && !history.length) return null;
  const latest = history[0];
  const failureItem = latestFailure && actionFailureReceipt(latestFailure)?.items.find(item => item.status === "failed");
  return <div className="space-y-3" data-testid="agent-prepared-actions">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{t("home:actions_status", { active: active.length, completed: history.length, failed: failedCount })}</p>
    {active.length > 0 && <section className="space-y-3" aria-label={t("home:actions_current", { count: active.length })} data-testid="agent-active-actions">
      <h2 className="text-xs font-medium text-muted-foreground">{t("home:actions_current", { count: active.length })}</h2>
      {active.map(action => <ActionCard key={action.id} action={action} busy={busy} />)}
    </section>}
    {history.length > 0 && <div className="min-w-0 rounded-xl border bg-card/40" data-testid="agent-action-history">
      <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
        <AccordionItem value="history" className="border-0">
          <AccordionTrigger className="rounded-t-[11px] rounded-b-none px-3 py-3 text-xs" data-testid="action-history-toggle">{t("home:actions_history", { count: history.length, failed: failedCount })}</AccordionTrigger>
          {!expanded && <div className="space-y-1 px-3 pb-3 text-xs leading-5">
            <p className="text-muted-foreground">{t("home:actions_latest", { status: latest.status === "completed" && objectValue(latest.result).executionStatus === "queued" ? t("home:result_submitted") : t(actionStatusKeys[latest.status]) })}</p>
            {latestFailure && <p className="text-destructive [overflow-wrap:anywhere]" data-testid="action-latest-failure">{t("home:actions_latest_failure")}: {failureItem ? `${failureItem.name} · ${actionErrorMessage(failureItem.error ?? "prepared_action_failed", t)}` : actionErrorMessage(latestFailure.error ?? "prepared_action_failed", t)}</p>}
          </div>}
          <AccordionContent className="space-y-3 px-3 pb-3">{history.map(action => <ActionCard key={action.id} action={action} busy={busy} />)}</AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>}
  </div>;
}
