import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, ListChecks, Loader2, PauseCircle } from "lucide-react";
import type { AgentPlan } from "@/agent/types";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { cn } from "@/lib/utils";

const statusKeys = {
  pending: "home:plan_pending", in_progress: "home:plan_in_progress",
  completed: "home:plan_completed", blocked: "home:plan_blocked",
} as const;

export default function AgentPlanPanel({ plan }: { plan: AgentPlan }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState("plan");
  const completed = plan.steps.filter(step => step.status === "completed").length;
  return <SmoothCorners radius={16} smoothing={0.72} className="min-w-0 border bg-card" data-testid="agent-plan">
    <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="plan" className="border-0">
        <AccordionTrigger className="gap-3 p-3 hover:bg-muted/30">
          <ListChecks className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-xs font-medium">{t("home:plan_title")}</span>
            <span className="mt-1 block text-sm font-normal leading-5 [overflow-wrap:anywhere]">{plan.goal}</span>
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{completed}/{plan.steps.length}</span>
        </AccordionTrigger>
        <AccordionContent className="px-3 pb-3">
          <ol className="space-y-1" aria-label={t("home:plan_title")}>
            {plan.steps.map((step, index) => {
              const Icon = { pending: Circle, in_progress: Loader2, completed: CheckCircle2, blocked: PauseCircle }[step.status];
              return <li key={step.id} data-plan-status={step.status} className={cn("flex items-start gap-2 rounded-lg p-2", step.status === "in_progress" && "bg-muted/60")}>
                <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground", step.status === "completed" && "text-emerald-600 dark:text-emerald-400", step.status === "blocked" && "text-amber-600 dark:text-amber-400", step.status === "in_progress" && "animate-spin motion-reduce:animate-none")} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs leading-5 [overflow-wrap:anywhere]"><span className="mr-1.5 text-muted-foreground tabular-nums">{index + 1}.</span>{step.title}</div>
                  {step.detail && <p className="mt-0.5 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{step.detail}</p>}
                </div>
                <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">{t(statusKeys[step.status])}</span>
              </li>;
            })}
          </ol>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </SmoothCorners>;
}
