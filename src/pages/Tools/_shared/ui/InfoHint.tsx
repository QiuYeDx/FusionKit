import * as React from "react";
import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

type InfoHintProps = {
  /** Explanation body. Keep it short for tooltip, richer for popover. */
  children: React.ReactNode;
  /** `tooltip` (default) for one-liners, `popover` for longer guidance. */
  variant?: "tooltip" | "popover";
  /** Optional bold title, only rendered in popover variant. */
  title?: React.ReactNode;
  side?: Side;
  align?: Align;
  /** Accessible label for the trigger button. */
  label?: string;
  className?: string;
  iconClassName?: string;
  contentClassName?: string;
};

/**
 * A small "?" affordance that reveals contextual help on hover/focus.
 *
 * Use this instead of pushing explanatory Alert/Card blocks into the document
 * flow — it keeps the layout calm while the guidance stays one interaction away.
 */
export function InfoHint({
  children,
  variant = "tooltip",
  title,
  side = "top",
  align = "center",
  label = "More information",
  className,
  iconClassName,
  contentClassName,
}: InfoHintProps) {
  const trigger = (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      <HelpCircle className={cn("size-3", iconClassName)} />
    </button>
  );

  if (variant === "popover") {
    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          className={cn("w-72 text-sm leading-relaxed", contentClassName)}
        >
          {title ? (
            <div className="mb-1.5 text-sm font-medium text-foreground">
              {title}
            </div>
          ) : null}
          <div className="text-sm leading-relaxed text-muted-foreground [&_p]:leading-relaxed">
            {children}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        className={cn(
          "max-w-[260px] text-xs leading-relaxed",
          contentClassName,
        )}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

export default InfoHint;
