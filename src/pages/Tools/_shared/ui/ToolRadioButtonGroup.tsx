import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";

export interface ToolRadioButtonOption<T extends string> {
  value: T;
  label: ReactNode;
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
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % options.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + options.length) % options.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    }
    if (nextIndex === undefined) return;

    const nextOption = options[nextIndex];
    if (!nextOption) return;
    event.preventDefault();
    onValueChange(nextOption.value);
    buttonRefs.current.get(nextOption.value)?.focus();
  };

  return (
    <ButtonGroup
      className={cn("w-full", className)}
      orientation={orientation}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option, index) => (
        <Button
          key={option.value}
          ref={(node) => {
            if (node) buttonRefs.current.set(option.value, node);
            else buttonRefs.current.delete(option.value);
          }}
          type="button"
          size="sm"
          className={cn(
            "min-w-0 flex-1",
            orientation === "vertical" &&
              "h-auto min-h-8 justify-start whitespace-normal py-2 text-left",
          )}
          role="radio"
          aria-label={option.ariaLabel}
          aria-checked={value === option.value}
          data-state={value === option.value ? "checked" : "unchecked"}
          tabIndex={value === option.value ? 0 : -1}
          disabled={disabled}
          variant={value === option.value ? "default" : "outline"}
          data-testid={option.testId}
          onKeyDown={(event) => handleKeyDown(event, index)}
          onClick={() => onValueChange(option.value)}
          onPointerUp={() => onPointerValueChange?.(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </ButtonGroup>
  );
}
