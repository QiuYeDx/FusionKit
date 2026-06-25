import * as React from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";

type ToolFieldProps = {
  label: React.ReactNode;
  /** Optional contextual help rendered as a "?" affordance next to the label. */
  hint?: React.ReactNode;
  hintVariant?: "tooltip" | "popover";
  /** Associates the label with a control id for accessibility. */
  htmlFor?: string;
  required?: boolean;
  /** Optional control aligned to the right edge of the label row. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

/**
 * A labelled form field with an optional inline help hint.
 *
 * Standardizes label typography, spacing and the "?" hint placement so that
 * every configuration control on a tool detail page lines up consistently.
 */
export function ToolField({
  label,
  hint,
  hintVariant,
  htmlFor,
  required,
  action,
  children,
  className,
}: ToolFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex min-h-4 items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Label
            htmlFor={htmlFor}
            className="gap-1 text-[13px] font-medium text-foreground/90"
          >
            {label}
            {required ? (
              <span className="text-destructive" aria-hidden>
                *
              </span>
            ) : null}
          </Label>
          {hint ? <InfoHint variant={hintVariant}>{hint}</InfoHint> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

export default ToolField;
