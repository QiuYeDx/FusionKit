"use client";

import React from "react";
import { Play, ArrowRight, Clock, CheckCircle2, PauseCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type {
  MarkdownWidgetComponentProps,
  MarkdownWidgetDefinition,
} from "../markdown-types";

interface PendingExecutionStoreItem {
  name: string;
  labelKey: string;
  count: number;
  path?: string;
}

type ResolvedAction = "confirm" | "dismiss";

interface PendingExecutionProps {
  stores: PendingExecutionStoreItem[];
  resolvedAction?: ResolvedAction | null;
}

function ResolvedBanner({ action }: { action: ResolvedAction }) {
  const { t } = useTranslation();
  const isConfirm = action === "confirm";

  return (
    <div className="flex items-center gap-2 px-3 py-2.5 animate-in fade-in slide-in-from-top-1 duration-200">
      {isConfirm ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
      ) : (
        <PauseCircle className="h-4 w-4 text-muted-foreground shrink-0" />
      )}
      <span
        className={`text-sm font-medium ${isConfirm ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
      >
        {t(isConfirm ? "home:execution_confirmed" : "home:execution_dismissed")}
      </span>
    </div>
  );
}

function PendingExecutionWidgetComponent({
  id,
  props,
  context,
}: MarkdownWidgetComponentProps<PendingExecutionProps>) {
  const { stores, resolvedAction } = props;
  const { t } = useTranslation();
  const isResolved = !!resolvedAction;

  const handleConfirm = () => {
    context.onWidgetAction?.({
      widgetId: id,
      type: "pending-execution",
      action: "confirm",
    });
  };

  const handleDismiss = () => {
    context.onWidgetAction?.({
      widgetId: id,
      type: "pending-execution",
      action: "dismiss",
    });
  };

  const handleNavigate = (path: string) => {
    context.onWidgetAction?.({
      widgetId: id,
      type: "pending-execution",
      action: "navigate",
      payload: { path },
    });
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {t("home:queued_title")}
        </span>
      </div>

      <div className="px-3 py-2.5 space-y-1.5">
        {stores.map((store) => (
          <div
            key={store.name}
            className="flex items-center justify-between rounded-lg bg-background/60 border border-border/40 px-3 py-1.5"
          >
            <span className="text-sm text-muted-foreground">
              {t(store.labelKey)}{" "}
              <span className="font-medium text-foreground">
                {store.count}
              </span>{" "}
              {t("home:task_unit")}
            </span>
            {store.path && (
              <button
                className="h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                onClick={() => handleNavigate(store.path!)}
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {isResolved ? (
        <ResolvedBanner action={resolvedAction!} />
      ) : (
        <div className="px-3 pb-3 pt-1">
          <p className="text-xs text-muted-foreground mb-2.5">
            {t("home:execute_immediately_confirm")}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleConfirm}
              className="h-7 rounded-full text-xs gap-1 px-3"
            >
              <Play className="h-3 w-3" />
              {t("home:execute_now")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              className="h-7 rounded-full text-xs text-muted-foreground px-3"
            >
              {t("home:execute_later")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function parsePendingExecutionProps(
  raw: unknown,
): { ok: true; props: PendingExecutionProps } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "props must be an object" };
  }

  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.stores)) {
    return { ok: false, reason: "stores is required and must be an array" };
  }

  const stores: PendingExecutionStoreItem[] = [];
  for (const item of value.stores) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.name !== "string" || typeof s.labelKey !== "string") continue;
    stores.push({
      name: s.name,
      labelKey: s.labelKey,
      count: typeof s.count === "number" ? s.count : 0,
      path: typeof s.path === "string" ? s.path : undefined,
    });
  }

  if (stores.length === 0) {
    return { ok: false, reason: "stores must contain at least one valid item" };
  }

  const resolvedAction =
    value.resolvedAction === "confirm" || value.resolvedAction === "dismiss"
      ? (value.resolvedAction as ResolvedAction)
      : null;

  return { ok: true, props: { stores, resolvedAction } };
}

export const pendingExecutionWidget: MarkdownWidgetDefinition<PendingExecutionProps> =
  {
    type: "pending-execution",
    displayName: "Pending Execution",
    version: 1,
    component: PendingExecutionWidgetComponent,
    parseProps: parsePendingExecutionProps,
    permissions: ["client-action"],
  };
