import * as React from "react";
import { ToolFilePickerSurface } from './ToolFilePickerSurface';

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
  onFiles: (
    files: FileList,
    source: ToolFileSelectionSource,
  ) => void | Promise<void>;
  onDraggingChange?: (dragging: boolean) => void;
  className?: string;
};

export type ToolFileSelectionSource = "picker" | "drop";

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
  onFiles: (
    files: FileList,
    source: ToolFileSelectionSource,
  ) => void | Promise<void>,
): Promise<void> {
  const files = input.files;
  if (!files || files.length === 0) return;

  try {
    await onFiles(files, "picker");
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
    (files: FileList | null, source: ToolFileSelectionSource) => {
      if (disabled || !files || files.length === 0) return;
      // Invoke the consumer before returning from the native drop/change event.
      // Some Electron File capabilities expire as soon as that event unwinds.
      return onFiles(files, source);
    },
    [disabled, onFiles],
  );

  return (
    <ToolFilePickerSurface
      id={id}
      title={title}
      description={description}
      actionLabel={actionLabel}
      icon={icon}
      secondaryAction={secondaryAction}
      layout={layout}
      disabled={disabled}
      dragging={dragging}
      className={className}
      onSelect={() => internalInputRef.current?.click()}
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
        void handleFiles(event.dataTransfer.files, "drop");
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
    </ToolFilePickerSurface>
  );
}

export default ToolFileDropZone;
