import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ToolActionBarProps = {
  /** Primary actions — the page's main call(s) to action. */
  children: React.ReactNode;
  /** Secondary / utility actions, typically icon buttons. */
  secondary?: React.ReactNode;
  /** A short hint line shown beneath the actions. */
  hint?: React.ReactNode;
  className?: string;
};

/**
 * Two-tier action region that gives a tool detail page a clear visual focus:
 * a prominent primary row, then a quieter row of utility actions, then an
 * optional hint. Prevents the "wall of equally-weighted buttons" problem.
 */
export function ToolActionBar({
  children,
  secondary,
  hint,
  className,
}: ToolActionBarProps) {
  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {children}
      </div>
      {secondary ? (
        <div className="flex flex-wrap items-center gap-1">{secondary}</div>
      ) : null}
      {hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

type TooltipIconButtonProps = React.ComponentProps<typeof Button> & {
  tooltip: React.ReactNode;
  tooltipSide?: "top" | "right" | "bottom" | "left";
};

/**
 * Ghost icon button with an attached tooltip. The trigger is wrapped in a span
 * so the tooltip still appears even when the underlying button is disabled.
 */
export function TooltipIconButton({
  tooltip,
  tooltipSide = "top",
  variant = "ghost",
  size = "icon",
  className,
  ...props
}: TooltipIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant={variant}
            size={size}
            className={className}
            {...props}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export default ToolActionBar;
