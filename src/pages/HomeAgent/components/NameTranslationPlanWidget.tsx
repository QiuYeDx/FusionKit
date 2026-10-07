"use client";

import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FilePenLine,
  Loader2,
  PauseCircle,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import useAgentStore from "@/store/agent/useAgentStore";
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
  const canConfirm =
    isTrustedResult &&
    !!pendingPlan &&
    props.requiresConfirmation !== false &&
    props.applyable &&
    !resolvedAction &&
    !isApplying &&
    !isStreaming;
  const hasRiskPrompt = props.totalTargets > 50 || props.warnings.length > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    if (hasRiskPrompt) {
      const accepted = window.confirm(
        t("home:rename_risk_confirm", { count: props.readyCount })
      );
      if (!accepted) return;
    }
    context.onWidgetAction?.({
      widgetId: id,
      type: "name-translation-plan",
      action: "confirm",
      payload: { planId: props.planId },
    });
  };

  const handleDismiss = () => {
    if (!isTrustedResult || !pendingPlan || isApplying || isStreaming) return;
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

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/50">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <FilePenLine className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {t("home:rename_preview")}
        </span>
        <code className="ml-auto max-w-[11rem] truncate text-[11px] text-muted-foreground">
          {shortPlanId(props.planId)}
        </code>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          <Metric label={t("home:rename_total")} value={props.totalTargets} />
          <Metric label={t("home:rename_ready")} value={props.readyCount} tone="success" />
          <Metric label={t("home:rename_blocked")} value={props.blockedCount} tone="danger" />
          <Metric label={t("home:rename_skipped")} value={props.skippedCount} />
          <Metric label={t("home:rename_unchanged")} value={props.unchangedCount} />
        </div>

        {props.itemsPreview.length > 0 && (
          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {props.itemsPreview.map((item) => (
              <PreviewRow key={item.id} item={item} />
            ))}
            {props.totalTargets > props.itemsPreview.length && (
              <div className="px-2 pt-1 text-[11px] text-muted-foreground">
                {t("home:rename_more", { count: props.totalTargets - props.itemsPreview.length })}
              </div>
            )}
          </div>
        )}

        {props.warnings.length > 0 && (
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
            <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
          </div>
        )}

        {resolvedAction ? (
          <ResolvedState action={resolvedAction} result={applyResult} />
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="h-7 rounded-full px-3 text-xs"
            >
              {isApplying ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {t("home:rename_confirm")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNavigate}
              className="h-7 rounded-full px-3 text-xs"
            >
              {t("home:open_tool")}
              <ArrowRight className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              disabled={!isTrustedResult || !pendingPlan || isApplying || isStreaming}
              className="h-7 rounded-full px-3 text-xs text-muted-foreground"
            >
              {t("home:rename_cancel")}
            </Button>
          </div>
        )}

        {!props.applyable && !resolvedAction && (
          <p className="text-xs text-muted-foreground">
            {t("home:rename_unavailable")}
          </p>
        )}
      </div>
    </div>
  );
}

function NameTranslationApplyResultWidgetComponent({
  props,
}: MarkdownWidgetComponentProps<NameTranslationApplyResultWidgetProps>) {
  const { t } = useTranslation();
  const hasFailures = props.failedCount > 0;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card/50",
        hasFailures ? "border-destructive/30" : "border-emerald-500/30"
      )}
    >
      <div className="flex items-center gap-2 bg-muted/30 px-3 py-2">
        {hasFailures ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        )}
        <span className="text-sm font-medium text-foreground">
          {t("home:rename_result")}
        </span>
      </div>
      <div className="space-y-2 px-3 py-3 text-sm">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <Metric label={t("home:rename_total")} value={props.totalCount} />
          <Metric label={t("home:rename_success")} value={props.successCount} tone="success" />
          <Metric label={t("home:rename_failed")} value={props.failedCount} tone="danger" />
          <Metric label={t("home:rename_skipped")} value={props.skippedCount} />
        </div>
        {props.message ? (
          <div className="rounded-lg bg-background/60 px-3 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {props.rolledBack ? t("home:rename_rolled_back_hint") : null} {props.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "danger";
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-base font-semibold tabular-nums",
          tone === "success" && "text-emerald-600 dark:text-emerald-400",
          tone === "danger" && "text-destructive"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function PreviewRow({ item }: { item: NameTranslationPlanItem }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">
          {item.originalName}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm">
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">
            {item.newName}
          </span>
        </div>
      </div>
      <Badge
        variant={item.status === "blocked" || item.status === "failed" ? "destructive" : "outline"}
        className="h-6 rounded-full px-2 text-[10px]"
      >
        {statusLabel(item.status, t)}
      </Badge>
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
    <div className="rounded-lg border border-border/40 bg-background/60 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        {isConfirm ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <PauseCircle className="h-4 w-4 text-muted-foreground" />
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
      </div>
      {result && (
        <div className="mt-2 text-xs text-muted-foreground">
          {t("home:rename_result_summary", { success: result.successCount, failed: result.failedCount })}
          {result.rolledBack ? ` · ${t("home:rename_rolled_back_hint")}` : null}
        </div>
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
