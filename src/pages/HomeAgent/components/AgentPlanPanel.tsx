import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, CircleDot, ListChecks, Loader2, PauseCircle } from "lucide-react";
import type { AgentPlan } from "@/agent/types";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import AgentCard from "./AgentCard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const statusKeys = {
  pending: "home:plan_pending", in_progress: "home:plan_in_progress",
  completed: "home:plan_completed", blocked: "home:plan_blocked",
} as const;

export default function AgentPlanPanel({ plan, onCheckProgress, busy }: { plan: AgentPlan; onCheckProgress: () => void; busy: boolean }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState("plan");
  const completed = plan.steps.filter(step => step.status === "completed").length;
  return <AgentCard data-testid="agent-plan">
    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="plan" className="border-0">
        <AccordionTrigger className="gap-2 rounded-none px-3 py-2.5 hover:bg-muted/40 hover:no-underline focus-visible:ring-inset" data-testid="plan-toggle">
          <ListChecks className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-[11px] font-normal text-muted-foreground">{t("home:plan_last_snapshot")}</span>
            <span className="mt-0.5 block text-xs font-medium leading-5 [overflow-wrap:anywhere]">{plan.goal}</span>
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{completed}/{plan.steps.length}</span>
        </AccordionTrigger>
        <AccordionContent className="border-t px-3 pt-2 pb-3">
          <ol className="space-y-1" aria-label={t("home:plan_title")}>
            {plan.steps.map((step, index) => {
              // Between turns an in-progress step is waiting for the user, not running.
              const waiting = step.status === "in_progress" && !busy;
              const Icon = waiting ? CircleDot : { pending: Circle, in_progress: Loader2, completed: CheckCircle2, blocked: PauseCircle }[step.status];
              return <li key={step.id} data-plan-status={step.status} className={cn("flex items-start gap-2 rounded-lg p-2", step.status === "in_progress" && "bg-muted/60")}>
                <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground", step.status === "in_progress" && !waiting && "animate-spin motion-reduce:animate-none", step.status === "completed" && "text-emerald-600 dark:text-emerald-400", step.status === "blocked" && "text-amber-600 dark:text-amber-400")} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs leading-5 [overflow-wrap:anywhere]"><span className="mr-1.5 text-muted-foreground tabular-nums">{index + 1}.</span>{step.title}</div>
                  {step.detail && <p className="mt-0.5 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{step.detail}</p>}
                </div>
                <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">{t(waiting ? "home:plan_waiting" : statusKeys[step.status])}</span>
              </li>;
            })}
          </ol>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div className="min-w-0 flex-1 text-[11px] leading-5 text-muted-foreground">
              <p>{t("home:plan_updated_at", { time: new Date(plan.updatedAt).toLocaleString(i18n.resolvedLanguage || i18n.language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</p>
              <p>{t("home:plan_snapshot_help")}</p>
            </div>
            <Button variant="outline" size="sm" className="h-7 text-xs" data-testid="plan-check-progress" disabled={busy} onClick={onCheckProgress}>{t("home:plan_check_progress")}</Button>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </AgentCard>;
}
