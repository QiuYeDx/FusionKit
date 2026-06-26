import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type ToolConfigDisclosureProps = {
  icon?: LucideIcon;
  title: React.ReactNode;
  summary?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

/**
 * Compact disclosure block for low-frequency tool configuration.
 *
 * Use this only for advanced settings that can be safely hidden by default;
 * core tool options should remain visible in the regular ToolConfigPanel flow.
 */
export function ToolConfigDisclosure({
  icon: Icon,
  title,
  summary,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  className,
  contentClassName,
}: ToolConfigDisclosureProps) {
  const contentId = React.useId();
  const [innerOpen, setInnerOpen] = React.useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const [overflowVisible, setOverflowVisible] = React.useState(isOpen);

  React.useEffect(() => {
    if (!isOpen) {
      setOverflowVisible(false);
      return;
    }
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) {
      setOverflowVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setOverflowVisible(true), 260);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const handleToggle = () => {
    const nextOpen = !isOpen;
    if (open === undefined) {
      setInnerOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <div className={cn("rounded-lg", className)}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/10 p-3 text-left transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={handleToggle}
      >
        <span className="flex min-w-0 items-start gap-2">
          {Icon ? (
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="min-w-0 space-y-0.5">
            <span className="block text-[12.5px] font-medium leading-5 text-foreground">
              {title}
            </span>
            {summary ? (
              <span className="block truncate text-[10.5px] leading-4 text-muted-foreground">
                {summary}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            isOpen && "rotate-180",
          )}
        />
      </button>
      <div
        id={contentId}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        onTransitionEnd={(event) => {
          if (event.propertyName === "grid-template-rows" && isOpen) {
            setOverflowVisible(true);
          }
        }}
      >
        <div
          className={cn(
            "min-h-0",
            overflowVisible ? "overflow-visible" : "overflow-hidden",
          )}
        >
          <div
            className={cn(
              "space-y-3 pt-3",
              !isOpen && "pointer-events-none",
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ToolConfigDisclosure;
