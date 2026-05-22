import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import useNameTranslatorStore from "@/store/tools/rename/useNameTranslatorStore";
import type { NameTranslationPlan } from "@/services/rename/nameTypes";
import ApplySummaryPanel from "./components/ApplySummaryPanel";
import OptionsPanel from "./components/OptionsPanel";
import PathPickerPanel from "./components/PathPickerPanel";
import PlanPreviewTable from "./components/PlanPreviewTable";
import RiskConfirmDialog, {
  type RenameRiskSummary,
} from "./components/RiskConfirmDialog";

export default function NameTranslator() {
  const { t } = useTranslation("rename");
  const [searchParams] = useSearchParams();
  const requestedPlanId = searchParams.get("planId")?.trim() ?? "";
  const {
    selectedPaths,
    options,
    currentPlan,
    isPlanning,
    isApplying,
    applyProgress,
    lastApplyResult,
    lastRollbackResult,
    lastValidation,
    lastError,
    originalSuggestions,
    addPaths,
    removePath,
    updateOptions,
    loadPlanFromCache,
    createPreview,
    updatePlanItem,
    revalidateCurrentPlan,
    applyCurrentPlan,
    rollback,
    reset,
  } = useNameTranslatorStore();
  const [riskDialogOpen, setRiskDialogOpen] = useState(false);
  const [urlPlanStatus, setUrlPlanStatus] = useState<
    "idle" | "loading" | "loaded" | "missing"
  >("idle");

  const risk = useMemo(() => getRiskSummary(currentPlan), [currentPlan]);

  useEffect(() => {
    if (!requestedPlanId) {
      setUrlPlanStatus("idle");
      return;
    }

    let canceled = false;
    setUrlPlanStatus("loading");
    void loadPlanFromCache(requestedPlanId).then((loaded) => {
      if (canceled) return;
      setUrlPlanStatus(loaded ? "loaded" : "missing");
    });

    return () => {
      canceled = true;
    };
  }, [loadPlanFromCache, requestedPlanId]);

  const requestApply = () => {
    if (!currentPlan) return;
    if (risk.hasRisk) {
      setRiskDialogOpen(true);
      return;
    }
    void applyCurrentPlan();
  };

  const confirmRiskApply = () => {
    setRiskDialogOpen(false);
    void applyCurrentPlan();
  };

  return (
    <div className="px-4 sm:px-8 pt-6 pb-[100px] max-w-7xl mx-auto">
      <ToolPageHeader
        meta={TOOL_META.nameTranslator}
        title={t("page.title")}
        description={t("page.description")}
        right={
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span className="font-mono text-[11px]">{t("page.badge")}</span>
          </Badge>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
        <aside className="flex flex-col gap-4 lg:sticky lg:top-10">
          <PathPickerPanel
            selectedPaths={selectedPaths}
            isPlanning={isPlanning}
            onAddPaths={addPaths}
            onRemovePath={removePath}
            onCreatePreview={createPreview}
            onReset={reset}
          />
          <OptionsPanel
            options={options}
            disabled={isPlanning || isApplying}
            onUpdateOptions={updateOptions}
          />
        </aside>

        <main className="flex min-w-0 flex-col gap-3">
          {requestedPlanId && urlPlanStatus === "loading" ? (
            <Alert>
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertTitle>{t("page.loading_plan_title")}</AlertTitle>
              <AlertDescription>{t("page.loading_plan_desc")}</AlertDescription>
            </Alert>
          ) : null}

          {requestedPlanId &&
          urlPlanStatus === "loaded" &&
          currentPlan?.planId === requestedPlanId ? (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>{t("page.loaded_from_agent_title")}</AlertTitle>
              <AlertDescription>
                {t("page.loaded_from_agent_desc", {
                  planId: shortPlanId(currentPlan.planId),
                  count: currentPlan.totalTargets,
                })}
              </AlertDescription>
            </Alert>
          ) : null}

          {lastError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{t("page.error_title")}</AlertTitle>
              <AlertDescription>{lastError}</AlertDescription>
            </Alert>
          ) : null}

          <PlanPreviewTable
            plan={currentPlan}
            isPlanning={isPlanning}
            originalSuggestions={originalSuggestions}
            onEditItem={updatePlanItem}
            onRevalidate={revalidateCurrentPlan}
            onUseAutoIndex={() => updateOptions({ collisionPolicy: "append_index" })}
          />

          <ApplySummaryPanel
            plan={currentPlan}
            isApplying={isApplying}
            applyProgress={applyProgress}
            lastApplyResult={lastApplyResult}
            lastRollbackResult={lastRollbackResult}
            lastValidation={lastValidation}
            onApply={requestApply}
            onRollback={rollback}
          />
        </main>
      </div>

      <RiskConfirmDialog
        open={riskDialogOpen}
        plan={currentPlan}
        risk={risk}
        onOpenChange={setRiskDialogOpen}
        onConfirm={confirmRiskApply}
      />
    </div>
  );
}

function getRiskSummary(plan: NameTranslationPlan | null): RenameRiskSummary {
  if (!plan) {
    return {
      hasRisk: false,
      reasons: [],
      readyCount: 0,
      fileCount: 0,
      directoryCount: 0,
      warningCount: 0,
    };
  }

  const readyItems = plan.items.filter((item) => item.status === "ready");
  const directoryCount = readyItems.filter((item) => item.kind === "directory").length;
  const fileCount = readyItems.filter((item) => item.kind === "file").length;
  const warningCount =
    plan.warnings.length +
    readyItems.reduce((total, item) => total + item.warnings.length, 0);
  const reasons: string[] = [];

  if (directoryCount > 0) reasons.push("directories");
  if (plan.options.scope === "descendants") reasons.push("descendants");
  if (plan.options.scope === "path_segments") reasons.push("path_segments");
  if (readyItems.length > 100) reasons.push("large_batch");
  if (warningCount > 0) reasons.push("warnings");

  return {
    hasRisk: reasons.length > 0,
    reasons,
    readyCount: readyItems.length,
    fileCount,
    directoryCount,
    warningCount,
  };
}

function shortPlanId(planId: string): string {
  return planId.length > 18 ? `...${planId.slice(-12)}` : planId;
}
