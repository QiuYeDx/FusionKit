import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, CheckCircle2, Loader2, PauseCircle, Play, Workflow, XCircle } from "lucide-react";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router-dom";
import { usePreparedActionsStore, type PreparedAction } from "@/agent/prepared-actions";
import { reportUiEvent } from "@/agent/orchestrator";
import { cn } from "@/lib/utils";
import { AGENT_CAPABILITIES } from "@/agent/capability-catalog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import AgentCard from "./AgentCard";
import { capabilityLabels } from "./AgentCapabilities";
import { actionErrorMessage } from "./action-error";
import AgentActionReceipt from "./AgentActionReceipt";
import { actionFailureReceipt, actionReceipt, agentToolPath, groupPreparedActions, objectValue } from "../presentation";

const actionStatusKeys = { ready: "home:action_ready", running: "home:action_running", completed: "home:action_completed", failed: "home:action_failed", dismissed: "home:action_dismissed" } as const;

/** The prepared action a tool result created, shown as a card at the end of that turn. */
export function AgentPreparedActionCard({ actionId, busy }: { actionId: string; busy: boolean }) {
  const action = usePreparedActionsStore(state => state.actions.find(item => item.id === actionId));
  return action ? <ActionCard action={action} busy={busy} /> : null;
}

/** A language code as the interface language names it ("ja" → "日语"); anything else stays as written. */
function languageName(value: unknown, locale: string): string {
  const text = String(value ?? "");
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(text)) return text;
  try { return new Intl.DisplayNames([locale], { type: "language" }).of(text) ?? text; } catch { return text; }
}

/** What runs after transcription without the assistant: translation, export, or both. */
function pipelineLines(values: PreparedAction["summaryValues"], t: TFunction, locale: string): string[] {
  if (!values || (values.translateTo === undefined && values.exportFormat === undefined)) return [];
  const target = values.translateTo !== undefined ? languageName(values.translateTo, locale) : "";
  const lines = [values.translateTo !== undefined && values.exportFormat !== undefined ? t("home:prepared_pipeline", { target })
    : values.translateTo !== undefined ? t("home:prepared_pipeline_translate", { target }) : t("home:prepared_pipeline_export")];
  if (values.exportFormat !== undefined) lines.push(t("home:prepared_pipeline_detail", {
    format: values.exportFormat === "auto" ? t("home:pipeline_format_auto") : String(values.exportFormat).toUpperCase(),
    content: t(`home:pipeline_content_${values.exportContent}`), conflict: t(`home:pipeline_conflict_${values.exportConflict}`) }));
  if (values.exportRemove) lines.push(t("home:pipeline_remove_document"));
  return lines;
}

/** A prepared action; inside the history card it is a row rather than a card of its own. */
function ActionCard({ action, busy, flat = false }: { action: PreparedAction; busy: boolean; flat?: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { confirmAction, dismissAction } = usePreparedActionsStore();
  const capability = AGENT_CAPABILITIES.find(item => item.toolKey === action.toolKey);
  const labels = capabilityLabels[action.toolKey as keyof typeof capabilityLabels];
  const title = action.summaryKey === "home:prepared_translation_summary" ? t("home:prepared_translation_title")
    : action.summaryKey === "home:prepared_transcription_summary" ? t("home:prepared_transcription_title") : labels ? t(labels.title) : action.title;
  // The files are the receipt's items; the summary keeps to one line of what will happen.
  const values = action.summaryValues ? { ...action.summaryValues, language: languageName(action.summaryValues.language, i18n.resolvedLanguage || i18n.language) } : undefined;
  const summary = action.summaryKey ? t(action.summaryKey, values) : action.summary;
  const pipeline = pipelineLines(action.summaryValues, t, i18n.resolvedLanguage || i18n.language);
  const Icon = { ready: Play, running: Loader2, completed: CheckCircle2, failed: XCircle, dismissed: PauseCircle }[action.status];
  const submitted = action.status === "completed" && objectValue(action.result).executionStatus === "queued";
  const receipt = actionReceipt(action);
  // Only the latest receipt; the preparation stays in view when the submission came after a partial one.
  const preparationFailures = action.preparationReceipt && receipt?.phase === "submission" && action.preparationReceipt.failureCount > 0 ? action.preparationReceipt : undefined;
  const Surface = flat ? "div" : AgentCard;
  // What the user decided goes back to the agent, which then follows up on its own.
  const confirm = async () => {
    await confirmAction(action.id);
    const after = usePreparedActionsStore.getState().actions.find(item => item.id === action.id);
    if (after?.status === "completed") reportUiEvent({ kind: "action_completed", values: { title, actionId: action.id } });
    else if (after?.status === "failed") reportUiEvent({ kind: "action_failed", values: { title, actionId: action.id, error: after.error ?? "prepared_action_failed" } });
  };
  const dismiss = () => {
    dismissAction(action.id);
    reportUiEvent({ kind: "action_dismissed", values: { title, actionId: action.id } });
  };
  const status = submitted ? t("home:result_submitted") : t(actionStatusKeys[action.status]);
  return <Surface className={cn(flat ? "border-t px-3 py-2.5" : "px-3 py-2.5", !flat && action.status === "ready" && "border-primary/30 ring-1 ring-primary/10")}
    data-testid={flat ? undefined : "agent-prepared-action"} data-action-id={action.id} data-action-status={action.status}>
    <div className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", action.status === "failed" && "text-destructive",
        action.status === "completed" && "text-emerald-600 dark:text-emerald-400", action.status === "running" && "animate-spin motion-reduce:animate-none")} />
      <h3 className="min-w-0 flex-1 truncate text-xs font-medium leading-5" title={title}>{title}</h3>
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4", action.status === "ready" ? "bg-primary text-primary-foreground"
        : action.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{status}</span>
      {capability && <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("home:open_tool")} className="-mr-1.5 size-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            onClick={() => navigate(agentToolPath(action.toolKey, capability.route, action.summaryKey))}><ArrowUpRight className="size-3.5" /></Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>{t("home:open_tool")}</TooltipContent>
      </Tooltip>}
    </div>
    <div className="mt-1 space-y-1.5 pl-5.5">
      <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{summary}</p>
      {pipeline.length > 0 && <div className="flex items-start gap-1.5 text-xs leading-5 text-foreground/80" data-testid="prepared-pipeline">
        <Workflow aria-hidden className="mt-1 size-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 [overflow-wrap:anywhere]">{pipeline.map((line, index) => <p key={index} className={index ? "text-muted-foreground" : undefined}>{line}</p>)}</div>
      </div>}
      {action.error && <p className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{actionErrorMessage(action.error, t)}</p>}
      {preparationFailures && <AgentActionReceipt receipt={preparationFailures} />}
      {receipt && <AgentActionReceipt receipt={receipt} />}
      {action.status === "ready" && <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" className="h-7 rounded-full px-3 text-xs" disabled={busy} onClick={() => void confirm()}>{t("home:action_confirm")}</Button>
        <Button variant="ghost" size="sm" className="h-7 rounded-full px-3 text-xs text-muted-foreground" disabled={busy} onClick={dismiss}>{t("home:action_dismiss")}</Button>
      </div>}
    </div>
  </Surface>;
}

/**
 * Prepared actions that no tool result in the conversation shows: the ones in progress, then the
 * history of the others. Actions created by a tool appear at the end of their turn instead.
 */
export default function AgentPreparedActions({ sessionId, busy, anchored }: { sessionId: string; busy: boolean; anchored: ReadonlySet<string> }) {
  const { t } = useTranslation();
  const allActions = usePreparedActionsStore(state => state.actions);
  const actions = useMemo(() => allActions.filter(action => !anchored.has(action.id)), [allActions, anchored]);
  const [expanded, setExpanded] = useState("");
  const { active, history, failedCount, latestFailure } = groupPreparedActions(actions, sessionId);
  if (!active.length && !history.length) return null;
  const latest = history[0];
  const failureItem = latestFailure && actionFailureReceipt(latestFailure)?.items.find(item => item.status === "failed");
  return <div className="space-y-3" data-testid="agent-prepared-actions">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{t("home:actions_status", { active: active.length, completed: history.length, failed: failedCount })}</p>
    {active.length > 0 && <section className="space-y-3" aria-label={t("home:actions_current", { count: active.length })} data-testid="agent-active-actions">
      <h2 className="text-[11px] font-medium text-muted-foreground">{t("home:actions_current", { count: active.length })}</h2>
      {active.map(action => <ActionCard key={action.id} action={action} busy={busy} />)}
    </section>}
    {history.length > 0 && <AgentCard data-testid="agent-action-history">
      <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
        <AccordionItem value="history" className="border-0">
          <AccordionTrigger className="rounded-none px-3 py-2.5 text-xs font-medium hover:bg-muted/40 hover:no-underline focus-visible:ring-inset" data-testid="action-history-toggle">{t("home:actions_history", { count: history.length, failed: failedCount })}</AccordionTrigger>
          {!expanded && <div className="space-y-1 px-3 pb-3 text-xs leading-5">
            <p className="text-muted-foreground">{t("home:actions_latest", { status: latest.status === "completed" && objectValue(latest.result).executionStatus === "queued" ? t("home:result_submitted") : t(actionStatusKeys[latest.status]) })}</p>
            {latestFailure && <p className="text-destructive [overflow-wrap:anywhere]" data-testid="action-latest-failure">{t("home:actions_latest_failure")}: {failureItem ? `${failureItem.name} · ${actionErrorMessage(failureItem.error ?? "prepared_action_failed", t)}` : actionErrorMessage(latestFailure.error ?? "prepared_action_failed", t)}</p>}
          </div>}
          <AccordionContent className="pb-0">{history.map(action => <ActionCard key={action.id} action={action} busy={busy} flat />)}</AccordionContent>
        </AccordionItem>
      </Accordion>
    </AgentCard>}
  </div>;
}
