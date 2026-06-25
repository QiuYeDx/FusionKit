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
        className="min-w-0"
        title={value || placeholder}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={onSelect}
        disabled={disabled}
        aria-label={selectLabel}
        title={selectLabel}
      >
        <Folder className="h-4 w-4" />
      </Button>
    </div>
  );
}

export default ToolOutputPathPicker;
