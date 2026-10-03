import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, PauseCircle, Play, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { usePreparedActionsStore } from "@/agent/prepared-actions";
import { AGENT_CAPABILITIES } from "@/agent/capability-catalog";
import { Button } from "@/components/ui/button";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { capabilityLabels } from "./AgentCapabilities";
import { actionErrorMessage } from "./action-error";

const actionStatusKeys = { ready: "home:action_ready", running: "home:action_running", completed: "home:action_completed", failed: "home:action_failed", dismissed: "home:action_dismissed" } as const;

export default function AgentPreparedActions({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { actions, confirmAction, dismissAction } = usePreparedActionsStore();
  const current = actions.filter(action => action.sessionId === sessionId);
  if (!current.length) return null;
  return <div className="space-y-3" data-testid="agent-prepared-actions">
    {current.map(action => {
      const capability = AGENT_CAPABILITIES.find(item => item.toolKey === action.toolKey);
      const labels = capabilityLabels[action.toolKey as keyof typeof capabilityLabels];
      const title = action.summaryKey === "home:prepared_translation_summary" ? t("home:prepared_translation_title")
        : action.summaryKey === "home:prepared_transcription_summary" ? t("home:prepared_transcription_title")
        : labels ? t(labels.title) : action.title;
      const summary = action.summaryKey === "home:prepared_translation_summary" ? t("home:prepared_translation_summary", action.summaryValues)
        : action.summaryKey === "home:prepared_transcription_summary" ? t("home:prepared_transcription_summary", action.summaryValues) : action.summary;
      const Icon = { ready: Play, running: Loader2, completed: CheckCircle2, failed: XCircle, dismissed: PauseCircle }[action.status];
      return <SmoothCorners key={action.id} radius={16} smoothing={0.72} className="min-w-0 border bg-card p-3" data-action-status={action.status}>
        <div className="flex items-start gap-2">
          <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${action.status === "failed" ? "text-destructive" : "text-muted-foreground"} ${action.status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{title}</h3>
              <span className="text-[11px] text-muted-foreground">{action.status === "completed" && action.result && typeof action.result === "object" && "executionStatus" in action.result && action.result.executionStatus === "queued" ? t("home:result_submitted") : t(actionStatusKeys[action.status])}</span>
            </div>
            <p className="mt-1 whitespace-pre-line text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{summary}</p>
            {action.error && <p className="mt-2 text-xs leading-5 text-destructive [overflow-wrap:anywhere]" role="alert">{actionErrorMessage(action.error, t)}</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {action.status === "ready" && <>
            <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void confirmAction(action.id)}>{t("home:action_confirm")}</Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => dismissAction(action.id)}>{t("home:action_dismiss")}</Button>
          </>}
          {capability && <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={() => navigate(capability.route)}>{t("home:open_tool")}</Button>}
        </div>
      </SmoothCorners>;
    })}
  </div>;
}
