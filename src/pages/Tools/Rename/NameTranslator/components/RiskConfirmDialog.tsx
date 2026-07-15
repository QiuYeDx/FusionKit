import { AlertTriangle, FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from "@/components/qiuye-ui/scrollable-dialog";
import type { NameTranslationPlan } from "@/services/rename/nameTypes";
import type {
  RenameRiskSummary,
  RenameWarningDetail,
} from "../riskSummary";
import PlanWarningsList from "./PlanWarningsList";

interface RiskConfirmDialogProps {
  open: boolean;
  plan: NameTranslationPlan | null;
  risk: RenameRiskSummary;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export default function RiskConfirmDialog({
  open,
  plan,
  risk,
  onOpenChange,
  onConfirm,
}: RiskConfirmDialogProps) {
  const { t } = useTranslation("rename");

  return (
    <ScrollableDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="sm:max-w-2xl"
    >
      <ScrollableDialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {t("risk.title")}
        </DialogTitle>
        <DialogDescription>{t("risk.description")}</DialogDescription>
      </ScrollableDialogHeader>

      <ScrollableDialogContent
        fadeMasks
        className="min-w-0 max-w-full [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!w-full [&_[data-slot=scroll-area-viewport]>div]:!max-w-full"
      >
        <div className="min-w-0 w-full max-w-full space-y-4 overflow-hidden">
          <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
            <RiskMetric
              label={t("risk.metrics.impacted")}
              value={risk.readyCount}
            />
            <RiskMetric label={t("risk.metrics.files")} value={risk.fileCount} />
            <RiskMetric
              label={t("risk.metrics.directories")}
              value={risk.directoryCount}
            />
            <RiskMetric
              label={t("risk.metrics.warnings")}
              value={risk.warningCount}
            />
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium">
              <FolderTree className="h-3.5 w-3.5 text-muted-foreground" />
              {t("risk.reasons_title")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {risk.reasons.map((reason) => (
                <Badge key={reason} variant="outline">
                  {t(`risk_reasons.${reason}`)}
                </Badge>
              ))}
            </div>
          </div>

          {risk.warningDetails.length > 0 ? (
            <section
              data-testid="rename-risk-warning-details"
              className="min-w-0 overflow-hidden rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
            >
              <div className="mb-1 flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span>{t("risk.warnings_title")}</span>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 font-mono text-[10.5px]"
                >
                  {risk.warningCount}
                </Badge>
              </div>
              <p className="mb-3 min-w-0 break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {t("risk.warnings_desc")}
              </p>
              <PlanWarningsList
                details={risk.warningDetails}
                getSourceLabel={(detail) => getWarningSourceLabel(detail, t)}
              />
            </section>
          ) : null}

          <div className="space-y-1 rounded-lg border p-3 text-[12px] text-muted-foreground">
            <p>
              {t("risk.scope", {
                scope: plan?.options.scope
                  ? t(`options.scope.${plan.options.scope}.label`)
                  : "-",
              })}
            </p>
            <p>{t("risk.journal_hint")}</p>
            <p>{t("risk.apply_hint")}</p>
          </div>
        </div>
      </ScrollableDialogContent>

      <ScrollableDialogFooter className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          {t("risk.cancel")}
        </Button>
        <Button type="button" onClick={onConfirm}>
          {t("risk.confirm")}
        </Button>
      </ScrollableDialogFooter>
    </ScrollableDialog>
  );
}

function getWarningSourceLabel(
  detail: RenameWarningDetail,
  t: ReturnType<typeof useTranslation<"rename">>["t"]
): string {
  if (detail.source === "plan") {
    return t("warning_details.plan_source");
  }

  return t("warning_details.item_source", {
    kind: detail.itemKind ? t(`preview.kind.${detail.itemKind}`) : "-",
    name: detail.itemName ?? "-",
  });
}

function RiskMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3 py-2 text-center">
      <div className="font-mono text-lg font-semibold leading-tight">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
