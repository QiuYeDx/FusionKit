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
  testId?: string;
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
  testId,
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
    <div className={cn("-mx-4 border-y", className)}>
      <button
        type="button"
        data-testid={testId}
        className="group flex min-h-14 w-full cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={handleToggle}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {Icon ? (
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
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
        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform duration-200 motion-reduce:transition-none",
              isOpen && "rotate-180",
            )}
          />
        </span>
      </button>
      <div
        id={contentId}
        aria-hidden={!isOpen}
        inert={!isOpen}
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
              "space-y-3 px-4 pb-4 pt-2",
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
