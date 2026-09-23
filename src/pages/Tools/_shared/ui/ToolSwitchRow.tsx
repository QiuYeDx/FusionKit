import { useId, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

type ToolSwitchRowProps = {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  testId?: string;
  className?: string;
};

type ToolToggleRowProps = ToolSwitchRowProps & {
  control?: "switch" | "checkbox";
  children?: ReactNode;
  detailsClassName?: string;
};

/** One visual surface for boolean settings; details stay outside the clickable label. */
export function ToolToggleRow({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
  id,
  testId,
  className,
  control = "switch",
  children,
  detailsClassName,
}: ToolToggleRowProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;

  return (
    <div
      data-testid={testId}
      className={cn(
        "min-w-0 rounded-lg border transition-colors hover:bg-accent/40",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <label htmlFor={controlId} className={cn("flex cursor-pointer items-start justify-between gap-3 p-3", disabled && "cursor-not-allowed")}>
        <span className="min-w-0 break-words">
          <span className="block text-[12.5px] font-medium leading-tight">
            {label}
          </span>
          {hint ? (
            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
              {hint}
            </span>
          ) : null}
        </span>
        {control === "checkbox" ? <Checkbox
          id={controlId}
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={value => onCheckedChange(value === true)}
        /> : <Switch
          id={controlId}
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />}
      </label>
      {children && <div className={cn("min-w-0 px-3 pb-3", detailsClassName)}>{children}</div>}
    </div>
  );
}

/** Shared full-row switch used by Thinking and other tool settings. */
export function ToolSwitchRow(props: ToolSwitchRowProps) {
  return <ToolToggleRow {...props} />;
}

export default ToolSwitchRow;
