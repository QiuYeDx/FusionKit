import * as React from "react";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";

type StatTone = "default" | "muted" | "success" | "warning" | "danger";

const TONE_VALUE_CLASS: Record<StatTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
};

type ToolStatProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: StatTone;
  className?: string;
};

/**
 * A single labelled metric tile (status / phase / size / encoding ...).
 * Replaces the ad-hoc `Metric` and `FileDetail` blocks with one consistent look.
 */
export function ToolStat({
  label,
  value,
  icon,
  hint,
  tone = "default",
  className,
}: ToolStatProps) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border bg-card px-3 py-2.5",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon ? (
          <span className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5">
            {icon}
          </span>
        ) : null}
        <span className="truncate">{label}</span>
        {hint ? <InfoHint>{hint}</InfoHint> : null}
      </div>
      <div
        className={cn(
          "mt-1 truncate text-sm font-semibold tabular-nums",
          TONE_VALUE_CLASS[tone],
        )}
      >
        {value}
      </div>
    </div>
  );
}

type ToolStatGridProps = {
  children: React.ReactNode;
  /** Columns at the largest breakpoint. Defaults to 4. */
  columns?: 2 | 3 | 4;
  className?: string;
};

const GRID_COLS: Record<NonNullable<ToolStatGridProps["columns"]>, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
};

/** Responsive grid container for `ToolStat` tiles. */
export function ToolStatGrid({
  children,
  columns = 4,
  className,
}: ToolStatGridProps) {
  return (
    <div className={cn("grid gap-2.5", GRID_COLS[columns], className)}>
      {children}
    </div>
  );
}

export default ToolStat;
