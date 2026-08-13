import { useId, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
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

/** Shared full-row boolean setting used across tool configuration surfaces. */
export function ToolSwitchRow({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
  id,
  testId,
  className,
}: ToolSwitchRowProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;

  return (
    <label
      htmlFor={switchId}
      data-testid={testId}
      className={cn(
        "flex cursor-pointer items-start justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/40",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium leading-tight">
          {label}
        </span>
        {hint ? (
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
      <Switch
        id={switchId}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

export default ToolSwitchRow;
