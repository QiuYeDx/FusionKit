import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ToolConfigPanelProps = {
  icon?: LucideIcon;
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

/**
 * Compact configuration panel used by tool detail sidebars.
 *
 * It intentionally owns only the visual shell: business fields, i18n and state
 * remain in each tool page.
 */
export function ToolConfigPanel({
  icon: Icon,
  title,
  action,
  children,
  className,
  contentClassName,
}: ToolConfigPanelProps) {
  return (
    <Card className={cn("overflow-hidden p-0 gap-0", className)}>
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {Icon ? (
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
            {title}
          </span>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={cn("p-4 space-y-5", contentClassName)}>{children}</div>
    </Card>
  );
}

export default ToolConfigPanel;
