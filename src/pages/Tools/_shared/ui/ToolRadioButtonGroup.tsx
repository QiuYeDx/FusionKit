import type { ReactNode } from "react";
import { SegmentedControl } from "@/components/qiuye-ui/segmented-control";
import { cn } from "@/lib/utils";

export interface ToolRadioButtonOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  testId?: string;
}

interface ToolRadioButtonGroupProps<T extends string> {
  value: T;
  options: readonly ToolRadioButtonOption<T>[];
  ariaLabel: string;
  onValueChange: (value: T) => void;
  onPointerValueChange?: (value: T) => void;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export function ToolRadioButtonGroup<T extends string>({
  value,
  options,
  ariaLabel,
  onValueChange,
  onPointerValueChange,
  disabled = false,
  orientation = "horizontal",
  className,
}: ToolRadioButtonGroupProps<T>) {
  return (
    <SegmentedControl
      className={cn("w-full", className)}
      size="sm"
      fullWidth
      orientation={orientation}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      items={options.map((option) => ({
        value: option.value,
        label: option.label,
        disabled: option.disabled,
        ariaLabel: option.ariaLabel,
        testId: option.testId,
      }))}
      itemClassName={cn(
        "min-w-0",
        orientation === "vertical" &&
          "h-auto min-h-8 justify-start whitespace-normal py-2 text-left [&_[data-slot=segmented-control-label]]:whitespace-normal",
      )}
      onValueChange={(nextValue) => onValueChange(nextValue as T)}
      onPointerValueChange={(nextValue) =>
        onPointerValueChange?.(nextValue as T)
      }
    />
  );
}
