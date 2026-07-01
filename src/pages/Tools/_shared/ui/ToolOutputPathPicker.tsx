import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ToolOutputPathPickerProps = {
  value: string;
  placeholder: string;
  selectLabel: string;
  onSelect: () => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Shared output-directory picker used by tool detail configuration panels.
 *
 * Directory selection remains owned by each tool so the component can be
 * reused without coupling it to a specific store or Electron IPC handler.
 */
export function ToolOutputPathPicker({
  value,
  placeholder,
  selectLabel,
  onSelect,
  disabled = false,
  className,
}: ToolOutputPathPickerProps) {
  return (
    <div className={cn("flex gap-2", className)}>
      <Input
        value={value}
        readOnly
        placeholder={placeholder}
        className="h-8 min-w-0 text-xs"
        title={value || placeholder}
      />
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={onSelect}
        disabled={disabled}
        aria-label={selectLabel}
        title={selectLabel}
      >
        <Folder className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export default ToolOutputPathPicker;
