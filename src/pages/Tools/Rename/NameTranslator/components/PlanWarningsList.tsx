import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RenameWarningDetail } from "../riskSummary";

interface PlanWarningsListProps {
  details: RenameWarningDetail[];
  getSourceLabel: (detail: RenameWarningDetail) => string;
  maxVisible?: number;
  moreLabel?: string;
  className?: string;
}

export default function PlanWarningsList({
  details,
  getSourceLabel,
  maxVisible,
  moreLabel,
  className,
}: PlanWarningsListProps) {
  const visibleDetails =
    typeof maxVisible === "number" ? details.slice(0, maxVisible) : details;
  const hiddenCount = details.length - visibleDetails.length;

  return (
    <div className={cn("min-w-0 w-full max-w-full space-y-2", className)}>
      <ol className="min-w-0 w-full max-w-full space-y-2">
        {visibleDetails.map((detail, index) => (
          <li
            key={`${detail.source}-${detail.itemId ?? "plan"}-${index}-${detail.message}`}
            className="min-w-0 w-full max-w-full overflow-hidden rounded-md border bg-background/60 px-3 py-2.5"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="min-w-0 break-words text-[11px] font-medium text-muted-foreground [overflow-wrap:anywhere]">
                  {getSourceLabel(detail)}
                </p>
                <p className="mt-1 min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
                  {detail.message}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ol>

      {hiddenCount > 0 && moreLabel ? (
        <p className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {moreLabel}
        </p>
      ) : null}
    </div>
  );
}
