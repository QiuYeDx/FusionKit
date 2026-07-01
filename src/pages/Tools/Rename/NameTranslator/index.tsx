import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CircleHelp, Loader2, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { ToolDetailLayout } from "@/pages/Tools/_shared/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tour, type TourStep } from "@/components/qiuye-ui/tour";
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
    planningProgress,
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
    cancelPlanning,
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

  // Tour 引导状态（延迟到入场动画结束后再自动打开）
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("name-translator-tour-done")) return;
    const timer = setTimeout(() => setTourOpen(true), 400);
    return () => clearTimeout(timer);
  }, []);
  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        target: "#nt-tour-path-picker",
        title: t("tour.path_picker_title", "选择文件或文件夹"),
        content: t(
          "tour.path_picker_content",
          "将需要重命名的文件或文件夹拖拽到此处，或点击按钮选择。支持同时添加多个路径。"
        ),
        placement: "right" as const,
      },
      {
        target: "#nt-tour-options",
        title: t("tour.options_title", "翻译选项"),
        content: t(
          "tour.options_content",
          "配置翻译参数：源语言、目标语言、命名风格、翻译范围等。不同配置会影响重命名的结果。"
        ),
        placement: "right" as const,
      },
      {
        target: "#nt-tour-preview",
        title: t("tour.preview_title", "预览重命名计划"),
        content: t(
          "tour.preview_content",
          "生成预览后，所有待重命名的项目会在此展示。你可以逐条编辑、恢复原始建议或跳过某些项。"
        ),
        placement: "left" as const,
      },
      {
        target: "#nt-tour-apply",
        title: t("tour.apply_title", "应用重命名"),
        content: t(
          "tour.apply_content",
          "确认计划无误后点击应用。系统会自动记录操作日志，如需撤销可一键回滚。"
        ),
        placement: "top" as const,
      },
    ],
    [t]
  );

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

  const header = (
    <ToolPageHeader
      meta={TOOL_META.nameTranslator}
      title={t("page.title")}
      description={t("page.description")}
      right={
        <>
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span className="font-mono text-[11px]">{t("page.badge")}</span>
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setTourOpen(true)}
            title={t("tour.trigger", "使用引导")}
          >
            <CircleHelp className="h-4 w-4" />
          </Button>
        </>
      }
    />
  );

  const aside = (
    <div className="flex flex-col gap-4">
      <div id="nt-tour-path-picker">
        <PathPickerPanel
          selectedPaths={selectedPaths}
          isPlanning={isPlanning}
          onAddPaths={addPaths}
          onRemovePath={removePath}
          onCreatePreview={createPreview}
          onReset={reset}
        />
      </div>
      <div id="nt-tour-options">
        <OptionsPanel
          options={options}
          disabled={isPlanning || isApplying}
          onUpdateOptions={updateOptions}
        />
      </div>
    </div>
  );

  return (
    <>
      <ToolDetailLayout header={header} aside={aside}>
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

        <div id="nt-tour-preview">
          <PlanPreviewTable
            plan={currentPlan}
            isPlanning={isPlanning}
            planningProgress={planningProgress}
            originalSuggestions={originalSuggestions}
            onEditItem={updatePlanItem}
            onRevalidate={revalidateCurrentPlan}
            onUseAutoIndex={() =>
              updateOptions({ collisionPolicy: "append_index" })
            }
            onCancelPlanning={cancelPlanning}
          />
        </div>

        <div id="nt-tour-apply">
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
        </div>
      </ToolDetailLayout>

      <RiskConfirmDialog
        open={riskDialogOpen}
        plan={currentPlan}
        risk={risk}
        onOpenChange={setRiskDialogOpen}
        onConfirm={confirmRiskApply}
      />

      <Tour
        steps={tourSteps}
        open={tourOpen}
        onOpenChange={setTourOpen}
        onFinish={() => {
          localStorage.setItem("name-translator-tour-done", "1");
        }}
        onSkip={() => {
          localStorage.setItem("name-translator-tour-done", "1");
        }}
        maskClosable
        scrollIntoView
      />
    </>
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
