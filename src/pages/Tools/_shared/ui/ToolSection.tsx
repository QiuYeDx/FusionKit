import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";

type ToolSectionProps = {
  title: React.ReactNode;
  icon?: LucideIcon;
  /** Contextual help shown as a "?" next to the title. */
  hint?: React.ReactNode;
  /** Compact summary (e.g. current value) shown at the right of the header. */
  summary?: React.ReactNode;
  /** Whether the section can be folded. Defaults to true. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Controlled open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

/**
 * A foldable configuration group used to tame long settings panels.
 *
 * Collapse animation uses the `grid-template-rows: 0fr <-> 1fr` technique:
 * it never measures height, so it cannot "jump", and portal'd popovers/selects
 * inside are unaffected. Overflow is only released after the open transition so
 * focus rings and dropdown triggers are not clipped while folding.
 */
export function ToolSection({
  title,
  icon: Icon,
  hint,
  summary,
  collapsible = true,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  children,
  className,
  contentClassName,
}: ToolSectionProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const open = collapsible ? openProp ?? internalOpen : true;
  const [overflowVisible, setOverflowVisible] = React.useState(open);

  React.useEffect(() => {
    if (!open) {
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
    // Fallback in case the transitionend event is missed.
    const timer = window.setTimeout(() => setOverflowVisible(true), 360);
    return () => window.clearTimeout(timer);
  }, [open]);

  const toggle = () => {
    if (!collapsible) return;
    const next = !open;
    onOpenChange?.(next);
    if (openProp === undefined) setInternalOpen(next);
  };

  const headerContent = (
    <>
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
      <span className="text-sm font-semibold text-foreground">{title}</span>
      {hint ? <InfoHint>{hint}</InfoHint> : null}
      <span className="flex-1" />
      {summary && !open ? (
        <span className="truncate text-xs text-muted-foreground">
          {summary}
        </span>
      ) : null}
      {collapsible ? (
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      ) : null}
    </>
  );

  return (
    <div className={className}>
      {collapsible ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="group flex w-full items-center gap-2 rounded-md py-1 text-left transition-colors hover:text-foreground"
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 py-1 text-left">
          {headerContent}
        </div>
      )}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        onTransitionEnd={(event) => {
          if (event.propertyName === "grid-template-rows" && open) {
            setOverflowVisible(true);
          }
        }}
      >
        <div className={cn("min-h-0", overflowVisible ? "overflow-visible" : "overflow-hidden")}>
          <div className={cn("pt-3", contentClassName)}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export default ToolSection;
