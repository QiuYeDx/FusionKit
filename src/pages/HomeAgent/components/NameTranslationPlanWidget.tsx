"use client";

import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  FilePenLine,
  Loader2,
  PauseCircle,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ConfirmDialog from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import useAgentStore from "@/store/agent/useAgentStore";
import { actionErrorMessage } from "./action-error";
import type {
  NameTranslationApplyResult,
  NameTranslationPlanItem,
} from "@/services/name-translation/agentPlan";
import type {
  MarkdownWidgetComponentProps,
  MarkdownWidgetDefinition,
} from "@/components/qiuye-ui/markdown-renderer";

type ResolvedAction = "confirm" | "dismiss";

interface NameTranslationPlanWidgetProps {
  planId: string;
  totalTargets: number;
  previewLimit: number;
  itemsPreview: readonly NameTranslationPlanItem[];
  readyCount: number;
  blockedCount: number;
  skippedCount: number;
  unchangedCount: number;
  warnings: readonly string[];
  applyable: boolean;
  requiresConfirmation?: boolean;
  executionStatus?: string;
  resolvedAction?: ResolvedAction | null;
  isApplying?: boolean;
  applyResult?: NameTranslationApplyResult;
  error?: string;
}

interface NameTranslationApplyResultWidgetProps extends NameTranslationApplyResult {
  executionStatus?: string;
}

function NameTranslationPlanWidgetComponent({
  id,
  props: suppliedProps,
  context,
}: MarkdownWidgetComponentProps<NameTranslationPlanWidgetProps>) {
  const { t } = useTranslation();
  const pendingPlan = useAgentStore((state) =>
    state.pendingNameTranslationPlan?.planId === suppliedProps.planId
      ? state.pendingNameTranslationPlan
      : null
  );
  const isTrustedResult = context.role === "tool";
  const props = isTrustedResult && pendingPlan ? { ...suppliedProps, ...pendingPlan.summary } : suppliedProps;

  const isStreaming = useAgentStore((state) => state.isStreaming);

  const resolvedAction =
    pendingPlan?.resolvedAction ?? props.resolvedAction ?? null;
  const isApplying = pendingPlan?.isApplying ?? props.isApplying ?? false;
  const applyResult = pendingPlan?.applyResult ?? props.applyResult;
  const error = pendingPlan?.error ?? props.error;
  const live = isTrustedResult && !!pendingPlan;
  // A preview without its live plan is history: a newer preview replaced it, or the session was imported.
  const historical = !live && props.applyable;
  const awaiting = live && props.requiresConfirmation !== false && props.applyable && !resolvedAction;
  const canConfirm = awaiting && !isApplying && !isStreaming;
  const hasRiskPrompt = props.totalTargets > 50 || props.warnings.length > 0;
  // The items are open while the preview waits for a decision, and folded once it is history.
  const [itemsChoice, setItemsChoice] = React.useState<boolean | null>(null);
  const showItems = itemsChoice ?? awaiting;

  // Large or warned plans ask once more, in the app's own dialog.
  const [riskOpen, setRiskOpen] = React.useState(false);
  const handleConfirm = () => {
    if (!canConfirm) return;
    if (hasRiskPrompt) { setRiskOpen(true); return; }
    submitConfirm();
  };
  const submitConfirm = () => {
    if (!canConfirm) return;
    context.onWidgetAction?.({
      widgetId: id,
      type: "name-translation-plan",
      action: "confirm",
      payload: { planId: props.planId },
    });
  };

  const handleDismiss = () => {
    if (!live || isApplying || isStreaming) return;
    context.onWidgetAction?.({
      widgetId: id,
      type: "name-translation-plan",
      action: "dismiss",
      payload: { planId: props.planId },
    });
  };

  const handleNavigate = () => {
    context.onWidgetAction?.({
      widgetId: id,
      type: "name-translation-plan",
      action: "navigate",
      payload: {
        path: `/tools/rename/name-translator?planId=${encodeURIComponent(
          props.planId
        )}`,
      },
    });
  };

  const counts = [
    { key: "ready", value: props.readyCount, label: t("home:rename_ready"), tone: "success" },
    { key: "blocked", value: props.blockedCount, label: t("home:rename_blocked"), tone: "danger" },
    { key: "skipped", value: props.skippedCount, label: t("home:rename_skipped") },
    { key: "unchanged", value: props.unchangedCount, label: t("home:rename_unchanged") },
  ].filter((item) => item.key === "ready" || item.value > 0);

  return (
    <SmoothCorners
      radius={14}
      smoothing={0.72}
      data-testid="agent-name-plan"
      data-plan-state={awaiting ? "awaiting" : historical ? "historical" : resolvedAction ?? "display"}
      className={cn(
        "min-w-0 overflow-hidden border bg-card",
        awaiting && "border-primary/30 ring-1 ring-primary/10"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <FilePenLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-foreground">
          {t("home:rename_preview")}
        </span>
        {awaiting && (
          <Badge className="h-5 shrink-0 rounded-full px-2 text-[10px]">{t("home:rename_awaiting")}</Badge>
        )}
        {historical && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{t("home:rename_superseded")}</span>
        )}
        <span className="ml-auto flex min-w-0 flex-wrap items-baseline justify-end gap-x-2 text-[11px] tabular-nums text-muted-foreground" data-testid="name-plan-counts">
          <span>{t("home:rename_total_count", { count: props.totalTargets })}</span>
          {counts.map((item) => (
            <span key={item.key} className={cn(
              item.tone === "success" && item.value > 0 && "text-emerald-600 dark:text-emerald-400",
              item.tone === "danger" && "text-destructive"
            )}>
              {item.label} {item.value}
            </span>
          ))}
        </span>
      </div>

      <div className="space-y-2.5 border-t px-3 py-2.5">
        {(props.itemsPreview.length > 0 || historical) && (
          <div>
            <div className="flex min-h-6 items-center gap-2">
              {props.itemsPreview.length > 0 && <button
                type="button"
                onClick={() => setItemsChoice(!showItems)}
                aria-expanded={showItems}
                className="flex items-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform duration-200 motion-reduce:transition-none", !showItems && "-rotate-90")} />
                {t("home:rename_items", { count: props.totalTargets })}
              </button>}
              {/* History has nothing left to decide: the tool page is its only way on. */}
              {historical && <Button variant="ghost" size="sm" onClick={handleNavigate}
                className="ml-auto h-6 rounded-full px-2 text-[11px] text-muted-foreground">
                {t("home:open_tool")}
                <ArrowRight className="h-3 w-3" />
              </Button>}
            </div>
            {showItems && (
              <div className="mt-1.5 max-h-52 divide-y divide-border/50 overflow-y-auto rounded-lg bg-muted/30 px-2.5">
                {props.itemsPreview.map((item) => (
                  <PreviewRow key={item.id} item={item} />
                ))}
                {props.totalTargets > props.itemsPreview.length && (
                  <div className="py-1.5 text-[11px] text-muted-foreground">
                    {t("home:rename_more", { count: props.totalTargets - props.itemsPreview.length })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {props.warnings.length > 0 && !historical && (
          <div className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 space-y-1">
              {props.warnings.slice(0, 3).map((warning) => (
                <div key={warning} className="[overflow-wrap:anywhere]">
                  {warning}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{actionErrorMessage(error, t)}</span>
          </div>
        )}

        {resolvedAction ? (
          <ResolvedState action={resolvedAction} result={applyResult} />
        ) : !historical && (
          <div className="flex flex-wrap items-center gap-2">
            {live && props.applyable && (
              <>
                <Button
                  size="sm"
                  onClick={handleConfirm}
                  disabled={!canConfirm}
                  data-testid="name-plan-confirm"
                  className="h-7 rounded-full px-3 text-xs"
                >
                  {isApplying ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" />
                  )}
                  {t("home:rename_confirm_count", { count: props.readyCount })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDismiss}
                  disabled={isApplying || isStreaming}
                  className="h-7 rounded-full px-3 text-xs text-muted-foreground"
                >
                  {t("home:rename_cancel")}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleNavigate}
              className="ml-auto h-7 rounded-full px-3 text-xs"
            >
              {t("home:open_tool")}
              <ArrowRight className="h-3 w-3" />
            </Button>
          </div>
        )}

        {!props.applyable && !resolvedAction && (
          <p className="text-xs text-muted-foreground">
            {t("home:rename_unavailable")}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={riskOpen}
        onOpenChange={setRiskOpen}
        variant="default"
        title={t("home:rename_risk_title")}
        description={[
          t("home:rename_risk_confirm", { count: props.readyCount }),
          ...(props.warnings.length ? [t("home:rename_risk_warnings", { count: props.warnings.length })] : []),
        ].join(" ")}
        confirmText={t("home:rename_confirm_count", { count: props.readyCount })}
        cancelText={t("home:rename_cancel")}
        onConfirm={submitConfirm}
      />
    </SmoothCorners>
  );
}

function NameTranslationApplyResultWidgetComponent({
  props,
}: MarkdownWidgetComponentProps<NameTranslationApplyResultWidgetProps>) {
  const { t } = useTranslation();
  const hasFailures = props.failedCount > 0;

  return (
    <SmoothCorners
      radius={14}
      smoothing={0.72}
      className={cn(
        "min-w-0 overflow-hidden border bg-card",
        hasFailures && "border-destructive/30"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
        {hasFailures ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="shrink-0 font-medium text-foreground">
          {t("home:rename_result")}
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-x-2 text-[11px] tabular-nums text-muted-foreground">
          <span>{t("home:rename_total_count", { count: props.totalCount })}</span>
          <span className="text-emerald-600 dark:text-emerald-400">{t("home:rename_success")} {props.successCount}</span>
          {props.failedCount > 0 && <span className="text-destructive">{t("home:rename_failed")} {props.failedCount}</span>}
          {props.skippedCount > 0 && <span>{t("home:rename_skipped")} {props.skippedCount}</span>}
        </span>
      </div>
      {(props.message || props.rolledBack) && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {props.rolledBack ? t("home:rename_rolled_back_hint") : null} {props.message}
        </div>
      )}
    </SmoothCorners>
  );
}

function PreviewRow({ item }: { item: NameTranslationPlanItem }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-muted-foreground" title={item.originalName}>
          {item.originalName}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-xs">
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground" title={item.newName}>
            {item.newName}
          </span>
        </div>
      </div>
      {item.status !== "ready" && (
        <Badge
          variant={item.status === "blocked" || item.status === "failed" ? "destructive" : "outline"}
          className="h-5 shrink-0 rounded-full px-2 text-[10px]"
        >
          {statusLabel(item.status, t)}
        </Badge>
      )}
    </div>
  );
}

function ResolvedState({
  action,
  result,
}: {
  action: ResolvedAction;
  result?: NameTranslationApplyResult;
}) {
  const { t } = useTranslation();
  const isConfirm = action === "confirm";

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {isConfirm ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <PauseCircle className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      <span
        className={cn(
          "font-medium",
          isConfirm
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground"
        )}
      >
        {isConfirm ? t("home:rename_confirmed") : t("home:rename_cancelled")}
      </span>
      {result && (
        <span className="text-muted-foreground">
          {t("home:rename_result_summary", { success: result.successCount, failed: result.failedCount })}
          {result.rolledBack ? ` · ${t("home:rename_rolled_back_hint")}` : null}
        </span>
      )}
    </div>
  );
}

function parseNameTranslationPlanProps(
  raw: unknown
):
  | { ok: true; props: NameTranslationPlanWidgetProps }
  | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "props must be an object" };
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.planId !== "string") {
    return { ok: false, reason: "planId is required" };
  }

  return {
    ok: true,
    props: {
      planId: value.planId,
      totalTargets: toNumber(value.totalTargets),
      previewLimit: toNumber(value.previewLimit),
      itemsPreview: parsePlanItems(value.itemsPreview),
      readyCount: toNumber(value.readyCount),
      blockedCount: toNumber(value.blockedCount),
      skippedCount: toNumber(value.skippedCount),
      unchangedCount: toNumber(value.unchangedCount),
      warnings: parseStringArray(value.warnings),
      applyable: value.applyable === true,
      requiresConfirmation: value.requiresConfirmation !== false,
      executionStatus:
        typeof value.executionStatus === "string"
          ? value.executionStatus
          : undefined,
      resolvedAction:
        value.resolvedAction === "confirm" || value.resolvedAction === "dismiss"
          ? value.resolvedAction
          : null,
      isApplying: value.isApplying === true,
      applyResult: parseApplyResult(value.applyResult),
      error: typeof value.error === "string" ? value.error : undefined,
    },
  };
}

function parseNameTranslationApplyResultProps(
  raw: unknown
):
  | { ok: true; props: NameTranslationApplyResultWidgetProps }
  | { ok: false; reason: string } {
  const result = parseApplyResult(raw);
  if (!result) return { ok: false, reason: "apply result is invalid" };
  const executionStatus =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).executionStatus
      : undefined;

  return {
    ok: true,
    props: {
      ...result,
      executionStatus:
        typeof executionStatus === "string" ? executionStatus : undefined,
    },
  };
}

function parsePlanItems(raw: unknown): NameTranslationPlanItem[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      id: String(item.id ?? ""),
      kind: item.kind === "directory" ? "directory" : "file",
      sourcePath: String(item.sourcePath ?? ""),
      originalName: String(item.originalName ?? ""),
      newName: String(item.newName ?? ""),
      status: parseItemStatus(item.status),
      ...(typeof item.reason === "string"
        ? { reason: item.reason as NameTranslationPlanItem["reason"] }
        : {}),
    }));
}

function parseApplyResult(raw: unknown): NameTranslationApplyResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.planId !== "string" || typeof value.journalId !== "string") {
    return undefined;
  }

  return {
    planId: value.planId,
    journalId: value.journalId,
    totalCount: toNumber(value.totalCount),
    successCount: toNumber(value.successCount),
    failedCount: toNumber(value.failedCount),
    skippedCount: toNumber(value.skippedCount),
    rolledBack: value.rolledBack === true,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

function parseItemStatus(raw: unknown): NameTranslationPlanItem["status"] {
  const allowed: NameTranslationPlanItem["status"][] = ["ready", "unchanged", "blocked", "failed"];
  return allowed.includes(raw as NameTranslationPlanItem["status"])
    ? (raw as NameTranslationPlanItem["status"])
    : "blocked";
}

function parseStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function shortPlanId(planId: string): string {
  return planId.length > 18 ? `...${planId.slice(-12)}` : planId;
}

function statusLabel(status: NameTranslationPlanItem["status"], t: TFunction): string {
  const labels: Record<NameTranslationPlanItem["status"], string> = {
    ready: t("home:rename_ready"),
    unchanged: t("home:rename_unchanged"),
    blocked: t("home:rename_blocked"),
    failed: t("home:rename_failed"),
  };
  return labels[status];
}

export const nameTranslationPlanWidget: MarkdownWidgetDefinition<NameTranslationPlanWidgetProps> =
  {
    type: "name-translation-plan",
    displayName: "Name Translation Plan",
    version: 1,
    component: NameTranslationPlanWidgetComponent,
    parseProps: parseNameTranslationPlanProps,
    permissions: ["client-action"],
  };

export const nameTranslationApplyResultWidget: MarkdownWidgetDefinition<NameTranslationApplyResultWidgetProps> =
  {
    type: "name-translation-apply-result",
    displayName: "Name Translation Apply Result",
    version: 1,
    component: NameTranslationApplyResultWidgetComponent,
    parseProps: parseNameTranslationApplyResultProps,
  };
