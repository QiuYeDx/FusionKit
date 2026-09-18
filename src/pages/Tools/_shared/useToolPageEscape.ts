import { useEffect } from "react";

const escapeLayerSelector = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot="popover-content"]',
  '[data-slot="tooltip-content"]',
].join(",");

/** Page navigation is the last Escape action, after local editing and layers. */
export function useToolPageEscape(pathname: string, onBack: () => void) {
  useEffect(() => {
    if (!pathname.startsWith("/tools/")) return;

    const localEvents = new WeakSet<KeyboardEvent>();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const capture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Snapshot before Radix or a local handler closes/unmounts its layer.
      const editing = event.composedPath().some(target => target instanceof HTMLElement && (
        target.matches("input, textarea, select") || target.isContentEditable
      ));
      const layerOpen = Array.from(document.querySelectorAll(escapeLayerSelector))
        .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      if (editing || layerOpen) localEvents.add(event);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.isComposing ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          event.defaultPrevented || localEvents.has(event)) return;
      // Window listeners (e.g. drag cancellation) can consume Escape later in
      // this dispatch. Wait for all of them rather than depending on mount order.
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (!event.defaultPrevented) onBack();
      }, 0);
    };

    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", handleEscape);
    return () => {
      clearTimeout(pending);
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [pathname, onBack]);
}
