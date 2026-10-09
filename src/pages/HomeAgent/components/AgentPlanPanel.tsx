import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, CircleDot, ListChecks, Loader2, PauseCircle, RefreshCw } from "lucide-react";
import type { AgentPlan } from "@/agent/types";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import AgentCard from "./AgentCard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const statusKeys = {
  pending: "home:plan_pending", in_progress: "home:plan_in_progress",
  completed: "home:plan_completed", blocked: "home:plan_blocked",
} as const;

/** The step the plan is at: the one in progress, else the first blocked or pending one. */
export function currentPlanStep(plan: AgentPlan) {
  return plan.steps.find(step => step.status === "in_progress")
    ?? plan.steps.find(step => step.status === "blocked")
    ?? plan.steps.find(step => step.status === "pending");
}

/**
 * The plan as a status bar at the end of the conversation: one line with the current step and the
 * progress, the steps behind its disclosure. Checking progress asks the agent right away.
 */
export default function AgentPlanPanel({ plan, onCheckProgress, busy, canCheck = true }: { plan: AgentPlan; onCheckProgress: () => void; busy: boolean; canCheck?: boolean }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState("");
  const completed = plan.steps.filter(step => step.status === "completed").length;
  const done = completed === plan.steps.length;
  const current = currentPlanStep(plan);
  // Between turns an in-progress step is waiting for the user, not running.
  const currentWaiting = current?.status === "in_progress" && !busy;
  const CurrentIcon = done ? CheckCircle2 : current?.status === "blocked" ? PauseCircle : current?.status === "in_progress" && busy ? Loader2 : ListChecks;
  return <AgentCard data-testid="agent-plan" data-plan-done={done || undefined}>
    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="plan" className="border-0">
        <div className="flex min-w-0 items-center [&>h3]:min-w-0 [&>h3]:flex-1">
          <AccordionTrigger className="min-w-0 gap-2 rounded-none py-2 pr-2 pl-3 text-xs font-normal focus-visible:ring-inset [&>svg]:size-3.5" data-testid="plan-toggle">
            <CurrentIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", done && "text-emerald-600 dark:text-emerald-400",
              current?.status === "blocked" && "text-amber-600 dark:text-amber-400", CurrentIcon === Loader2 && "animate-spin motion-reduce:animate-none")} />
            <span className="shrink-0 text-muted-foreground">{t("home:plan_title")}</span>
            <span className="min-w-0 flex-1 truncate text-left font-medium" title={done ? plan.goal : current?.title}>
              {done ? t("home:plan_all_done") : current?.title ?? plan.goal}
              {currentWaiting && <span className="ml-1.5 font-normal text-muted-foreground">· {t("home:plan_waiting")}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{completed}/{plan.steps.length}</span>
          </AccordionTrigger>
          <Tooltip delayDuration={350}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("home:plan_check_progress")} data-testid="plan-check-progress"
                className="mr-1.5 size-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground" disabled={busy || !canCheck} onClick={onCheckProgress}>
                <RefreshCw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t("home:plan_check_progress")}</TooltipContent>
          </Tooltip>
        </div>
        <AccordionContent className="border-t px-3 pt-2.5 pb-3">
          <p className="mb-2 text-xs font-medium leading-5 [overflow-wrap:anywhere]">{plan.goal}</p>
          <ol className="space-y-1" aria-label={t("home:plan_title")}>
            {plan.steps.map((step, index) => {
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
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{t("home:plan_updated_at", { time: new Date(plan.updatedAt).toLocaleString(i18n.resolvedLanguage || i18n.language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</p>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </AgentCard>;
}
