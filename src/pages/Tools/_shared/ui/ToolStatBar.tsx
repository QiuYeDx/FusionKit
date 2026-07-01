import * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";

type StatTone = "default" | "muted" | "success" | "warning" | "danger";

const VALUE_TONE_CLASS: Record<StatTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
};

const GRID_COLS = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
} as const;

export type ToolStatBarItem = {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: StatTone;
  loading?: boolean;
};

type ToolStatBarProps = {
  items: ToolStatBarItem[];
  title?: React.ReactNode;
  icon?: React.ReactNode;
  columns?: keyof typeof GRID_COLS;
  className?: string;
  gridClassName?: string;
};

/**
 * Compact horizontal metrics bar for tool detail pages.
 *
 * It keeps status / file / token / encoding style metrics in one low-profile
 * surface so page bodies do not drift back into large independent stat cards.
 */
export function ToolStatBar({
  items,
  title,
  icon,
  columns = 4,
  className,
  gridClassName,
}: ToolStatBarProps) {
  const visibleItems = items.filter(Boolean);
  if (visibleItems.length === 0) return null;

  return (
    <Card className={cn("overflow-hidden p-0 gap-0", className)}>
      {title || icon ? (
        <div className="flex items-center gap-2 border-b px-4 py-2.5 text-[12px] font-medium text-foreground/90">
          {icon ? (
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5">
              {icon}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{title}</span>
        </div>
      ) : null}
      <div
        className={cn(
          "grid",
          GRID_COLS[columns],
          gridClassName,
        )}
      >
        {visibleItems.map((item, index) => (
          <div
            key={index}
            className="min-w-0 border-b border-r border-border/70 px-4 py-3"
          >
            <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] uppercase tracking-[0.05em] text-muted-foreground">
              <span className="min-w-0 truncate">{item.label}</span>
              {item.hint ? <InfoHint>{item.hint}</InfoHint> : null}
            </div>
            <div
              className={cn(
                "mt-1 truncate font-mono text-[13px] font-semibold tabular-nums",
                VALUE_TONE_CLASS[item.tone ?? "default"],
                item.loading && "animate-pulse",
              )}
            >
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default ToolStatBar;
