import * as React from "react";
import { FolderOpen, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { cn } from "@/lib/utils";

type ToolFileDropZoneProps = {
  id?: string;
  inputTestId?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  accept: string;
  multiple?: boolean;
  dragging?: boolean;
  disabled?: boolean;
  layout?: "horizontal" | "stacked";
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

export async function consumeToolFileInputSelection(
  input: Pick<HTMLInputElement, "files" | "value">,
  onFiles: (files: FileList) => void | Promise<void>,
): Promise<void> {
  const files = input.files;
  if (!files || files.length === 0) return;

  try {
    await onFiles(files);
  } finally {
    // Electron ties webUtils.getPathForFile(file) to the native File object
    // retained by this input. Clearing earlier revokes that authority before an
    // async contextBridge call can consume it. Reset only after authorization
    // settles so selecting the same file again remains possible and safe.
    input.value = "";
  }
}

export function ToolFileDropZone({
  id,
  inputTestId,
  inputRef,
  accept,
  multiple,
  dragging,
  disabled,
  layout = "horizontal",
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
    async (files: FileList | null) => {
      if (disabled || !files || files.length === 0) return;
      await onFiles(files);
    },
    [disabled, onFiles],
  );

  return (
    <SmoothCorners
      id={id}
      radius={18}
      smoothing={0.74}
      className={cn(
        "relative flex items-center gap-4 border-2 border-dashed px-5 py-5 transition-colors",
        layout === "stacked" && "flex-col items-stretch gap-3 text-center",
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
        void handleFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={setInputRef}
        data-testid={inputTestId}
        type="file"
        multiple={multiple}
        className="hidden"
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          const input = event.currentTarget;
          void consumeToolFileInputSelection(input, handleFiles);
        }}
      />
      <div
        className={cn(
          "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-foreground/70",
          layout === "stacked" && "self-center",
        )}
      >
        {icon ?? (dragging ? <FolderOpen className="h-5 w-5" /> : <Upload className="h-5 w-5" />)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center justify-end gap-2",
          layout === "stacked" && "justify-center",
        )}
      >
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
    </SmoothCorners>
  );
}

export default ToolFileDropZone;
