import * as React from "react";
import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";

type DropEvent = React.DragEvent<HTMLElement>;
type DropTarget = {
  label: React.ReactNode;
  onDrop: (event: DropEvent) => void | Promise<void>;
  disabled?: boolean;
  /** Inactive views must not participate in page-wide routing. */
  enabled?: boolean;
  /** Opt out when a target should only receive drops inside its own bounds. */
  pageWide?: boolean;
};
type TargetRef = React.RefObject<DropTarget>;
type RegisteredTarget = readonly [string, DropTarget];
type DropContext = {
  activeId: string | null;
  register: (id: string, target: TargetRef) => () => void;
  clear: (id?: string) => void;
};

const Context = React.createContext<DropContext | null>(null);
const TARGET_ATTRIBUTE = "data-tool-file-drop-target";

export function isToolFileDrag(dataTransfer: DataTransfer): boolean {
  // File lists are protected (empty) until drop, but Files remains in types.
  return Array.from(dataTransfer.types).includes("Files") || dataTransfer.files.length > 0;
}

function hasOpenDialog() {
  return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
    .some(element => element.getClientRects().length > 0);
}

export function selectToolFileDropTarget(visible: readonly RegisteredTarget[], directId?: string | null) {
  const target = directId ? visible.find(([id]) => id === directId)
    : visible.length === 1 && visible[0][1].pageWide !== false ? visible[0] : undefined;
  // Disabled entries still count: never redirect a drop into another importer.
  return target && !target[1].disabled ? target : undefined;
}

/** One visible import target owns the page; multiple targets retain their bounds. */
export function ToolFileDropScope({
  children,
  enabled = true,
  className,
}: {
  children: React.ReactNode;
  enabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const targets = React.useRef(new Map<string, TargetRef>());
  const depth = React.useRef(0);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [pageWideActive, setPageWideActive] = React.useState(false);
  const clear = React.useCallback((id?: string) => {
    if (!id) depth.current = 0;
    setActiveId(current => !id || current === id ? null : current);
  }, []);
  const register = React.useCallback((id: string, target: TargetRef) => {
    targets.current.set(id, target);
    return () => {
      targets.current.delete(id);
      clear(id);
    };
  }, [clear]);

  React.useEffect(() => {
    if (!enabled) return;
    const reset = () => clear();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") reset(); };
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("keydown", escape);
    };
  }, [enabled, clear]);

  const context = React.useMemo(() => ({ activeId, register, clear }), [activeId, register, clear]);
  const handles = (event: DropEvent) => enabled && targets.current.size > 0
    // React portal events also bubble here, but dialogs are not part of this surface.
    && event.currentTarget.contains(event.target as Node)
    && isToolFileDrag(event.dataTransfer);
  const resolve = (event: DropEvent) => {
    if (hasOpenDialog()) return;
    const visible = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[${TARGET_ATTRIBUTE}]`))
      .filter(element => !element.closest('[hidden], [inert], [aria-hidden="true"]')
        && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible")
      .map(element => [element.getAttribute(TARGET_ATTRIBUTE)!, targets.current.get(element.getAttribute(TARGET_ATTRIBUTE)!)?.current] as const)
      .filter((entry): entry is RegisteredTarget => !!entry[1] && entry[1].enabled !== false);
    const element = event.target instanceof Element ? event.target : (event.target as Node).parentElement;
    const directId = element?.closest(`[${TARGET_ATTRIBUTE}]`)?.getAttribute(TARGET_ATTRIBUTE);
    const target = selectToolFileDropTarget(visible, directId);
    return target ? { id: target[0], target: target[1], pageWide: visible.length === 1 && target[1].pageWide !== false } : undefined;
  };
  const hover = (event: DropEvent) => {
    event.preventDefault();
    const target = resolve(event);
    event.dataTransfer.dropEffect = target ? "copy" : "none";
    setActiveId(target?.id ?? null);
    setPageWideActive(target?.pageWide ?? false);
  };
  const activeTarget = activeId ? targets.current.get(activeId)?.current : undefined;

  return <Context.Provider value={enabled ? context : null}>
    <div
      data-slot="tool-file-drop-scope"
      className={cn(enabled && "min-h-[calc(100dvh-2.5rem)]", className)}
      onDragEnter={event => {
        if (!handles(event)) return;
        depth.current++;
        hover(event);
      }}
      onDragOver={event => { if (handles(event)) hover(event); }}
      onDragLeave={event => {
        if (!handles(event)) return;
        event.preventDefault();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) clear();
      }}
      onDrop={event => {
        if (!handles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const target = resolve(event);
        clear();
        if (!target || event.dataTransfer.files.length === 0) return;
        // Stay inside the native drop event: Electron captures File authority
        // synchronously, before any Promise, queued action or React effect.
        void target.target.onDrop(event);
      }}
    >
      {children}
      {enabled && pageWideActive && activeTarget && !activeTarget.disabled && <SmoothCorners
        data-testid="tool-page-drop-overlay"
        role="status"
        radius={24}
        smoothing={0.74}
        className="pointer-events-none fixed inset-x-4 bottom-16 top-14 z-40 flex items-center justify-center border-2 border-dashed border-primary/60 bg-background/95 p-6"
      >
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <FolderOpen aria-hidden="true" className="size-8 text-primary" />
          <strong className="text-base font-semibold">{t("tools:file_drop.release")}</strong>
          <div className="max-w-full break-words text-sm text-muted-foreground">{activeTarget.label}</div>
        </div>
      </SmoothCorners>}
    </div>
  </Context.Provider>;
}

/** Register existing import behavior without moving native File handling out of the event. */
export function useToolFileDropTarget(options: DropTarget) {
  const context = React.useContext(Context);
  const id = React.useId();
  const target = React.useRef(options);
  const [localDragging, setLocalDragging] = React.useState(false);
  const localDepth = React.useRef(0);
  React.useLayoutEffect(() => { target.current = options; });
  const register = context?.register;
  const clear = context?.clear;
  React.useLayoutEffect(() => {
    if (options.enabled === false) return;
    return register?.(id, target);
  }, [register, id, options.enabled]);
  React.useEffect(() => {
    if (options.disabled || options.enabled === false) {
      clear?.(id);
      localDepth.current = 0;
      setLocalDragging(false);
    }
  }, [options.disabled, options.enabled, clear, id]);

  React.useEffect(() => {
    if (!localDragging) return;
    const reset = () => { localDepth.current = 0; setLocalDragging(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") reset(); };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset, true);
    window.addEventListener("blur", reset);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("keydown", escape);
    };
  }, [localDragging]);

  // A portal inherits context but lies outside the page's DOM. Keep its local
  // importer usable without forwarding the drop to the background page.
  const usesPageScope = (event: DropEvent) => context
    && !!event.currentTarget.closest('[data-slot="tool-file-drop-scope"]');
  const localProps: Pick<React.HTMLAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"> = {
    onDragEnter: event => {
      if (usesPageScope(event) || !isToolFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      localDepth.current++;
      setLocalDragging(!options.disabled && options.enabled !== false);
    },
    onDragOver: event => {
      if (usesPageScope(event) || !isToolFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = options.disabled || options.enabled === false ? "none" : "copy";
    },
    onDragLeave: event => {
      if (usesPageScope(event) || !isToolFileDrag(event.dataTransfer)) return;
      localDepth.current = Math.max(0, localDepth.current - 1);
      if (!localDepth.current) setLocalDragging(false);
    },
    onDrop: event => {
      if (usesPageScope(event) || !isToolFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      localDepth.current = 0;
      setLocalDragging(false);
      if (!options.disabled && options.enabled !== false && event.dataTransfer.files.length) void options.onDrop(event);
    },
  };
  return {
    dragging: !options.disabled && options.enabled !== false && (context?.activeId === id || localDragging),
    dropProps: { [TARGET_ATTRIBUTE]: id, ...localProps },
  };
}
