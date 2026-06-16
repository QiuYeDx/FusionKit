import {
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  RotateCw,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type {
  ApplyProgress,
  NameTranslationApplyResult,
  NameTranslationPlan,
  RollbackRenameJournalResult,
  ValidateRenamePlanResult,
} from "@/services/rename/nameTypes";

interface ApplySummaryPanelProps {
  plan: NameTranslationPlan | null;
  isApplying: boolean;
  applyProgress: ApplyProgress | null;
  lastApplyResult: NameTranslationApplyResult | null;
  lastRollbackResult: RollbackRenameJournalResult | null;
  lastValidation: ValidateRenamePlanResult | null;
  onApply: () => void;
  onRollback: (journalId: string) => Promise<void>;
}

export default function ApplySummaryPanel({
  plan,
  isApplying,
  applyProgress,
  lastApplyResult,
  lastRollbackResult,
  lastValidation,
  onApply,
  onRollback,
}: ApplySummaryPanelProps) {
  const { t } = useTranslation("rename");
  const canApply =
    Boolean(plan?.applyable) &&
    (lastValidation?.valid ?? true) &&
    !isApplying &&
    (plan?.blockedCount ?? 0) === 0 &&
    (plan?.readyCount ?? 0) > 0;
  const progressValue =
    applyProgress?.phase === "validating"
      ? 35
      : applyProgress?.phase === "applying" ||
          applyProgress?.phase === "rolling_back"
        ? 68
        : applyProgress?.phase === "done"
          ? 100
          : 0;

  return (
    <Card className="overflow-hidden p-0 gap-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b px-4 py-3 space-y-0 [&.border-b]:pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          <CardTitle className="text-[13.5px] font-semibold">
            {t("apply.title")}
          </CardTitle>
        </div>
        {plan ? (
          <Badge variant={plan.applyable ? "secondary" : "outline"} className="font-mono text-[11px]">
            {plan.planId.slice(0, 18)}
          </Badge>
        ) : null}
      </CardHeader>

      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label={t("apply.metrics.ready")} value={plan?.readyCount ?? 0} />
          <Metric
            label={t("apply.metrics.blocked")}
            value={plan?.blockedCount ?? 0}
            tone="bad"
          />
          <Metric
            label={t("apply.metrics.skipped")}
            value={plan?.skippedCount ?? 0}
          />
          <Metric
            label={t("apply.metrics.unchanged")}
            value={plan?.unchangedCount ?? 0}
          />
        </div>

        {plan?.warnings.length ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("apply.warnings_title")}</AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap gap-1.5">
                {plan.warnings.slice(0, 5).map((warning) => (
                  <Badge key={warning} variant="outline">
                    {warning}
                  </Badge>
                ))}
                {plan.warnings.length > 5 ? (
                  <span className="text-xs text-muted-foreground">
                    +{plan.warnings.length - 5}
                  </span>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {lastValidation && !lastValidation.valid ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("apply.validation_failed_title")}</AlertTitle>
            <AlertDescription>
              {lastValidation.errors.slice(0, 3).map((error) => (
                <p key={`${error.itemId ?? "global"}-${error.code}`}>
                  {error.code}: {error.message}
                </p>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}

        {applyProgress ? (
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] font-medium">
                {applyProgress.message}
              </span>
              <Badge variant="outline" className="font-mono text-[10.5px]">
                {t(`apply.phase.${applyProgress.phase}`)}
              </Badge>
            </div>
            <Progress value={progressValue} className="h-1.5" />
          </div>
        ) : null}

        {lastApplyResult ? (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2 text-[12.5px] font-medium">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              {t("apply.result_title")}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric
                label={t("apply.metrics.success")}
                value={lastApplyResult.successCount}
              />
              <Metric
                label={t("apply.metrics.failed")}
                value={lastApplyResult.failedCount}
                tone="bad"
              />
              <Metric
                label={t("apply.metrics.skipped")}
                value={lastApplyResult.skippedCount}
              />
            </div>
            <div className="rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
              journalId: {lastApplyResult.journalId}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isApplying}
              onClick={() => onRollback(lastApplyResult.journalId)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("apply.rollback")}
            </Button>
          </div>
        ) : null}

        {lastRollbackResult ? (
          <div className="rounded-lg border bg-muted/30 p-3 text-[12px]">
            {t("apply.rollback_summary", {
              journalId: lastRollbackResult.journalId,
              success: lastRollbackResult.successCount,
              failed: lastRollbackResult.failedCount,
            })}
          </div>
        ) : null}

        <Button
          type="button"
          className="w-full"
          disabled={!canApply}
          onClick={onApply}
        >
          <RotateCw className={cn("h-3.5 w-3.5", isApplying && "animate-spin")} />
          {t("apply.apply_button")}
        </Button>

        {!plan ? (
          <p className="text-[11px] text-muted-foreground">
            {t("apply.no_plan_hint")}
          </p>
        ) : !canApply ? (
          <p className="text-[11px] text-muted-foreground">
            {t("apply.blocked_hint")}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {t("apply.confirm_hint")}
          </p>
        )}
      </div>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "bad";
}) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div
        className={cn(
          "font-mono text-lg font-semibold leading-tight",
          tone === "bad" && value > 0
            ? "text-destructive"
            : "text-foreground"
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
