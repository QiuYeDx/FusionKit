import * as React from "react";
import { cn } from "@/lib/utils";

type ToolSummaryLineProps = {
  items: React.ReactNode[];
  className?: string;
};

export function ToolSummaryLine({ items, className }: ToolSummaryLineProps) {
  const visibleItems = items.filter(Boolean);
  if (visibleItems.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground",
        className,
      )}
    >
      {visibleItems.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span className="opacity-50">·</span> : null}
          <span>{item}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export default ToolSummaryLine;
