import * as React from "react";
import { FolderOpen, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ToolFileDropZoneProps = {
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  accept: string;
  multiple?: boolean;
  dragging?: boolean;
  disabled?: boolean;
  title: React.ReactNode;
  description: React.ReactNode;
  actionLabel: React.ReactNode;
  icon?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  onFiles: (files: FileList) => void | Promise<void>;
  onDraggingChange?: (dragging: boolean) => void;
  className?: string;
};

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<T | null>).current = value;
}

export function ToolFileDropZone({
  id,
  inputRef,
  accept,
  multiple,
  dragging,
  disabled,
  title,
  description,
  actionLabel,
  icon,
  secondaryAction,
  onFiles,
  onDraggingChange,
  className,
}: ToolFileDropZoneProps) {
  const internalInputRef = React.useRef<HTMLInputElement | null>(null);

  const setInputRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      internalInputRef.current = node;
      assignRef(inputRef, node);
    },
    [inputRef],
  );

  const handleFiles = React.useCallback(
    (files: FileList | null) => {
      if (disabled || !files || files.length === 0) return;
      void onFiles(files);
    },
    [disabled, onFiles],
  );

  return (
    <div
      id={id}
      className={cn(
        "relative flex items-center gap-4 rounded-xl border-2 border-dashed px-5 py-5 transition-colors",
        disabled
          ? "cursor-not-allowed border-border/70 opacity-60"
          : "cursor-pointer",
        dragging
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/40",
        className,
      )}
      onClick={() => {
        if (!disabled) internalInputRef.current?.click();
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) onDraggingChange?.(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (!disabled) onDraggingChange?.(false);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (disabled) return;
        onDraggingChange?.(false);
        handleFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={setInputRef}
        type="file"
        multiple={multiple}
        className="hidden"
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          const input = event.currentTarget;
          const files = input.files;
          handleFiles(files);
          input.value = "";
        }}
      />
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-foreground/70">
        {icon ?? (dragging ? <FolderOpen className="h-5 w-5" /> : <Upload className="h-5 w-5" />)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {secondaryAction}
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            internalInputRef.current?.click();
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

export default ToolFileDropZone;
