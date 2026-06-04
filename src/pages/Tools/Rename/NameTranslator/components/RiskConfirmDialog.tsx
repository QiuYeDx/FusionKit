import { AlertTriangle, FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NameTranslationPlan } from "@/services/rename/nameTypes";

export interface RenameRiskSummary {
  hasRisk: boolean;
  reasons: string[];
  readyCount: number;
  fileCount: number;
  directoryCount: number;
  warningCount: number;
}

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            {t("risk.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <RiskMetric label={t("risk.metrics.impacted")} value={risk.readyCount} />
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

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("risk.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t("risk.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RiskMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-center">
      <div className="font-mono text-lg font-semibold leading-tight">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
