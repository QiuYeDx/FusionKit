"use client";

import React from "react";
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
} from "@/services/rename/nameTypes";
import type {
  MarkdownWidgetComponentProps,
  MarkdownWidgetDefinition,
} from "@/components/qiuye-ui/markdown-renderer";

type ResolvedAction = "confirm" | "dismiss";

interface NameTranslationPlanWidgetProps {
  planId: string;
  totalTargets: number;
  previewLimit: number;
  itemsPreview: NameTranslationPlanItem[];
  readyCount: number;
  blockedCount: number;
  skippedCount: number;
  unchangedCount: number;
  warnings: string[];
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
  props,
  context,
}: MarkdownWidgetComponentProps<NameTranslationPlanWidgetProps>) {
  const pendingPlan = useAgentStore((state) =>
    state.pendingNameTranslationPlan?.planId === props.planId
      ? state.pendingNameTranslationPlan
      : null
  );

  const resolvedAction =
    pendingPlan?.resolvedAction ?? props.resolvedAction ?? null;
  const isApplying = pendingPlan?.isApplying ?? props.isApplying ?? false;
  const applyResult = pendingPlan?.applyResult ?? props.applyResult;
  const error = pendingPlan?.error ?? props.error;
  const canConfirm =
    props.requiresConfirmation !== false &&
    props.applyable &&
    props.blockedCount === 0 &&
    !resolvedAction &&
    !isApplying &&
    !context.isStreaming;
  const hasRiskPrompt = props.totalTargets > 50 || props.warnings.length > 0;

  const handleConfirm = () => {
    if (hasRiskPrompt) {
      const accepted = window.confirm(
        `将应用 ${props.readyCount} 个重命名操作。请确认已经检查预览结果。`
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
          名称翻译预览
        </span>
        <code className="ml-auto max-w-[11rem] truncate text-[11px] text-muted-foreground">
          {shortPlanId(props.planId)}
        </code>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          <Metric label="总数" value={props.totalTargets} />
          <Metric label="可应用" value={props.readyCount} tone="success" />
          <Metric label="冲突" value={props.blockedCount} tone="danger" />
          <Metric label="跳过" value={props.skippedCount} />
          <Metric label="无变化" value={props.unchangedCount} />
        </div>

        {props.itemsPreview.length > 0 && (
          <div className="space-y-1.5">
            {props.itemsPreview.slice(0, 8).map((item) => (
              <PreviewRow key={item.id} item={item} />
            ))}
            {props.totalTargets > props.itemsPreview.length && (
              <div className="px-2 pt-1 text-[11px] text-muted-foreground">
                还有 {props.totalTargets - props.itemsPreview.length} 项可在工具页查看。
              </div>
            )}
          </div>
        )}

        {props.warnings.length > 0 && (
          <div className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 space-y-1">
              {props.warnings.slice(0, 3).map((warning) => (
                <div key={warning} className="truncate">
                  {warning}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{error}</span>
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
              确认应用
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNavigate}
              className="h-7 rounded-full px-3 text-xs"
            >
              在工具页打开
              <ArrowRight className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              disabled={isApplying || context.isStreaming}
              className="h-7 rounded-full px-3 text-xs text-muted-foreground"
            >
              取消
            </Button>
          </div>
        )}

        {!props.applyable && !resolvedAction && (
          <p className="text-xs text-muted-foreground">
            当前计划不可直接应用，请先在工具页处理冲突或重新生成预览。
          </p>
        )}
      </div>
    </div>
  );
}

function NameTranslationApplyResultWidgetComponent({
  props,
}: MarkdownWidgetComponentProps<NameTranslationApplyResultWidgetProps>) {
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
          重命名执行结果
        </span>
      </div>
      <div className="space-y-2 px-3 py-3 text-sm">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <Metric label="总数" value={props.totalCount} />
          <Metric label="成功" value={props.successCount} tone="success" />
          <Metric label="失败" value={props.failedCount} tone="danger" />
          <Metric label="跳过" value={props.skippedCount} />
        </div>
        <div className="rounded-lg bg-background/60 px-3 py-2 text-xs text-muted-foreground">
          Journal: <code>{props.journalId}</code>
        </div>
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
        variant={item.status === "blocked" ? "destructive" : "outline"}
        className="h-6 rounded-full px-2 text-[10px]"
      >
        {statusLabel(item.status)}
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
          {isConfirm ? "已确认应用" : "已取消"}
        </span>
      </div>
      {result && (
        <div className="mt-2 text-xs text-muted-foreground">
          成功 {result.successCount} 项，失败 {result.failedCount} 项，Journal:{" "}
          <code>{result.journalId}</code>
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
      targetId: String(item.targetId ?? ""),
      kind: item.kind === "directory" ? "directory" : "file",
      sourcePath: String(item.sourcePath ?? ""),
      sourceParentPath: String(item.sourceParentPath ?? ""),
      originalName: String(item.originalName ?? ""),
      translatedStem: String(item.translatedStem ?? ""),
      newName: String(item.newName ?? ""),
      targetPath: String(item.targetPath ?? ""),
      status: parseItemStatus(item.status),
      reason: typeof item.reason === "string" ? item.reason : undefined,
      warnings: parseStringArray(item.warnings),
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
    startedAt: toNumber(value.startedAt),
    finishedAt: toNumber(value.finishedAt),
    totalCount: toNumber(value.totalCount),
    successCount: toNumber(value.successCount),
    failedCount: toNumber(value.failedCount),
    skippedCount: toNumber(value.skippedCount),
    failures: Array.isArray(value.failures)
      ? value.failures
          .filter(
            (item): item is Record<string, unknown> =>
              !!item && typeof item === "object"
          )
          .map((item) => ({
            itemId: String(item.itemId ?? ""),
            sourcePath: String(item.sourcePath ?? ""),
            targetPath: String(item.targetPath ?? ""),
            error: String(item.error ?? ""),
          }))
      : [],
  };
}

function parseItemStatus(raw: unknown): NameTranslationPlanItem["status"] {
  const allowed: NameTranslationPlanItem["status"][] = [
    "ready",
    "unchanged",
    "skipped",
    "blocked",
    "applied",
    "failed",
    "rolled_back",
  ];
  return allowed.includes(raw as NameTranslationPlanItem["status"])
    ? (raw as NameTranslationPlanItem["status"])
    : "ready";
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

function statusLabel(status: NameTranslationPlanItem["status"]): string {
  const labels: Record<NameTranslationPlanItem["status"], string> = {
    ready: "可应用",
    unchanged: "无变化",
    skipped: "跳过",
    blocked: "冲突",
    applied: "已应用",
    failed: "失败",
    rolled_back: "已回滚",
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
