import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ToolPanelProps = {
  id?: string;
  title: React.ReactNode;
  icon?: LucideIcon;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
};

/**
 * Compact working panel for queues, previews and result summaries.
 *
 * The body is deliberately unpadded by default so task rows, tables or empty
 * states can own their exact spacing.
 */
export function ToolPanel({
  id,
  title,
  icon: Icon,
  badge,
  actions,
  children,
  footer,
  className,
  headerClassName,
  bodyClassName,
}: ToolPanelProps) {
  return (
    <Card id={id} className={cn("overflow-hidden p-0 gap-0", className)}>
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3",
          headerClassName,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {Icon ? (
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <div className="truncate text-[13.5px] font-semibold">{title}</div>
          {badge ? <div className="shrink-0">{badge}</div> : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {actions}
          </div>
        ) : null}
      </div>
      <div className={bodyClassName}>{children}</div>
      {footer ? <div className="border-t px-4 py-3">{footer}</div> : null}
    </Card>
  );
}

export default ToolPanel;
