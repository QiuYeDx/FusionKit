import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import type { VisibleRow } from "@/services/name-translation/workspace";
import {
  EMPTY_SELECTION,
  actionTargets,
  clickSelection,
  marqueeSelection,
  moveSelection,
  pruneSelection,
  rowsInBand,
  type RowSelection,
} from "@/services/name-translation/selection";
import { ROW_CONTROL_ATTR } from "./EntryRow";

const DRAG_THRESHOLD = 4;
const AUTO_SCROLL_EDGE = 28;

export interface MarqueeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startX: number;
  readonly startY: number;
  readonly key: string | null;
  readonly toggle: boolean;
  readonly range: boolean;
  readonly base: ReadonlySet<string>;
  clientX: number;
  clientY: number;
  active: boolean;
}

interface Options {
  rows: readonly VisibleRow[];
  rowHeight: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Space: check the rows, or uncheck them when all are already checked. */
  toggleChecked: (keys: string[]) => void;
  edit: (key: string) => void;
  setExpanded: (key: string, expanded: boolean) => void;
  openMenu: (targets: string[], point: { x: number; y: number }) => void;
}

const isControl = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(`[${ROW_CONTROL_ATTR}]`));

/** Pressing the scrollbar scrolls; it does not select. */
const onScrollbar = (event: MouseEvent<HTMLDivElement>) =>
  event.target === event.currentTarget &&
  event.clientX - event.currentTarget.getBoundingClientRect().left >= event.currentTarget.clientWidth;

const rowKeyOf = (target: EventTarget | null) =>
  target instanceof Element ? (target.closest<HTMLElement>("[data-path]")?.dataset.path ?? null) : null;

/**
 * Explorer-style row selection for the windowed entry list. Rows have a fixed
 * height, so hit testing works on row indices and covers rows that are not
 * rendered (marquee auto-scroll, Shift ranges across the whole list).
 */
export function useRowSelection(options: Options) {
  const [selection, setSelection] = useState<RowSelection>(EMPTY_SELECTION);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  /** Last interaction was the keyboard: show the focus row outline. */
  const [keyboardNav, setKeyboardNav] = useState(false);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const order = options.rows.map((row) => row.key);
  const orderRef = useRef(order);
  orderRef.current = order;
  const drag = useRef<DragState | null>(null);
  const scrollFrame = useRef(0);
  const suppressClick = useRef(false);

  const commit = useCallback((next: RowSelection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  // Rows that disappear (collapsed, filtered, removed) leave the selection.
  const orderKey = order.join("\n");
  useEffect(() => {
    const pruned = pruneSelection(selectionRef.current, orderRef.current);
    if (pruned !== selectionRef.current) commit(pruned);
  }, [orderKey]);

  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  const contentPoint = (clientX: number, clientY: number) => {
    const rect = optionsRef.current.contentRef.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top, width: rect.width, height: rect.height } : null;
  };

  const updateMarquee = () => {
    const state = drag.current;
    const point = state ? contentPoint(state.clientX, state.clientY) : null;
    if (!state || !point) return;
    const clampX = (value: number) => Math.min(point.width, Math.max(0, value));
    const clampY = (value: number) => Math.min(point.height, Math.max(0, value));
    const [x0, x1] = [clampX(state.startX), clampX(point.x)].sort((a, b) => a - b) as [number, number];
    const [y0, y1] = [clampY(state.startY), clampY(point.y)].sort((a, b) => a - b) as [number, number];
    setMarquee({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    const band = rowsInBand(state.startY, point.y, optionsRef.current.rowHeight, orderRef.current.length);
    const mode = state.toggle ? "toggle" : state.range ? "add" : "replace";
    commit(marqueeSelection(state.base, orderRef.current, band, mode));
  };

  const autoScroll = () => {
    const state = drag.current;
    const viewport = optionsRef.current.viewportRef.current;
    if (!state?.active || !viewport) return;
    const rect = viewport.getBoundingClientRect();
    let delta = 0;
    if (state.clientY < rect.top + AUTO_SCROLL_EDGE) delta = -(rect.top + AUTO_SCROLL_EDGE - state.clientY);
    else if (state.clientY > rect.bottom - AUTO_SCROLL_EDGE) delta = state.clientY - (rect.bottom - AUTO_SCROLL_EDGE);
    if (delta !== 0) {
      const before = viewport.scrollTop;
      viewport.scrollTop += Math.sign(delta) * Math.min(32, Math.ceil(Math.abs(delta) / 3) + 2);
      if (viewport.scrollTop !== before) updateMarquee();
    }
    scrollFrame.current = requestAnimationFrame(autoScroll);
  };

  const endDrag = () => {
    const state = drag.current;
    drag.current = null;
    cancelAnimationFrame(scrollFrame.current);
    if (!state?.active) return;
    const viewport = optionsRef.current.viewportRef.current;
    if (viewport?.hasPointerCapture(state.pointerId)) viewport.releasePointerCapture(state.pointerId);
    setMarquee(null);
    // The click that ends a drag must not also edit or toggle the row under it.
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const scrollToRow = (key: string) => {
    const viewport = optionsRef.current.viewportRef.current;
    const content = optionsRef.current.contentRef.current;
    const index = orderRef.current.indexOf(key);
    if (!viewport || !content || index < 0) return;
    const top = content.offsetTop + index * optionsRef.current.rowHeight;
    const bottom = top + optionsRef.current.rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top - content.offsetTop;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight + content.offsetTop;
  };

  const openMenuAt = (key: string, point: { x: number; y: number }) => {
    let current = selectionRef.current;
    if (!current.keys.has(key)) {
      current = clickSelection(current, orderRef.current, key, { toggle: false, range: false });
      commit(current);
    }
    optionsRef.current.openMenu(actionTargets(current, orderRef.current, key), point);
  };

  const viewportProps = {
    onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || isControl(event.target) || onScrollbar(event)) return;
      // Keep focus on the list (keyboard selection) and avoid text selection.
      // A plain click on the new-name button still edits through its click.
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
    },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      setKeyboardNav(false);
      if (event.button !== 0 || isControl(event.target) || onScrollbar(event)) return;
      const point = contentPoint(event.clientX, event.clientY);
      drag.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: point?.x ?? 0,
        startY: point?.y ?? 0,
        key: rowKeyOf(event.target),
        toggle: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
        base: selectionRef.current.keys,
        clientX: event.clientX,
        clientY: event.clientY,
        active: false,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      state.clientX = event.clientX;
      state.clientY = event.clientY;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.startClientX, event.clientY - state.startClientY) < DRAG_THRESHOLD) return;
        if (!optionsRef.current.contentRef.current) return;
        state.active = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollFrame.current = requestAnimationFrame(autoScroll);
      }
      updateMarquee();
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (state.active) {
        endDrag();
        return;
      }
      drag.current = null;
      if (state.key) {
        commit(clickSelection(selectionRef.current, orderRef.current, state.key, { toggle: state.toggle, range: state.range }));
      } else if (!state.toggle && !state.range) {
        commit(EMPTY_SELECTION);
      }
    },
    onPointerCancel: endDrag,
    onLostPointerCapture: () => {
      if (drag.current?.active) endDrag();
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onScroll: () => {
      if (drag.current?.active) updateMarquee();
    },
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      const key = rowKeyOf(event.target);
      if (!key) {
        commit(EMPTY_SELECTION);
        return;
      }
      openMenuAt(key, { x: event.clientX, y: event.clientY });
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
      const current = selectionRef.current;
      const rows = optionsRef.current.rows;
      const keys = orderRef.current;
      const page = Math.max(1, Math.floor(event.currentTarget.clientHeight / optionsRef.current.rowHeight) - 1);
      const move = (target: number | "first" | "last") => {
        event.preventDefault();
        setKeyboardNav(true);
        const next = moveSelection(current, keys, target, event.shiftKey);
        commit(next);
        if (next.lead) scrollToRow(next.lead);
      };
      const leadIndex = current.lead ? keys.indexOf(current.lead) : -1;
      const leadRow = leadIndex >= 0 ? rows[leadIndex] : undefined;
      switch (event.key) {
        case "ArrowDown":
          return move(1);
        case "ArrowUp":
          return move(-1);
        case "PageDown":
          return move(page);
        case "PageUp":
          return move(-page);
        case "Home":
          return move("first");
        case "End":
          return move("last");
        case "ArrowRight":
          if (!leadRow) return move("first");
          event.preventDefault();
          if (leadRow.expandable && !leadRow.expanded) optionsRef.current.setExpanded(leadRow.key, true);
          else if (leadRow.expanded && rows[leadIndex + 1]?.depth === leadRow.depth + 1) move(1);
          return;
        case "ArrowLeft": {
          if (!leadRow) return;
          event.preventDefault();
          if (leadRow.expanded) {
            optionsRef.current.setExpanded(leadRow.key, false);
            return;
          }
          for (let index = leadIndex - 1; index >= 0; index -= 1) {
            if (rows[index]!.depth < leadRow.depth) return move(index - leadIndex);
          }
          return;
        }
        case " ": {
          event.preventDefault();
          const targets = current.keys.size > 0 ? keys.filter((key) => current.keys.has(key)) : current.lead ? [current.lead] : [];
          if (targets.length > 0) optionsRef.current.toggleChecked(targets);
          return;
        }
        case "Enter":
        case "F2":
          if (!current.lead) return;
          event.preventDefault();
          optionsRef.current.edit(current.lead);
          return;
        case "Escape":
          // Only consume Escape when it clears something (FK-PIT-0164).
          if (current.keys.size === 0) return;
          event.preventDefault();
          event.stopPropagation();
          commit({ ...EMPTY_SELECTION, lead: current.lead, anchor: current.lead });
          return;
        case "ContextMenu":
        case "F10": {
          if (event.key === "F10" && !event.shiftKey) return;
          if (!current.lead) return;
          event.preventDefault();
          scrollToRow(current.lead);
          const row = event.currentTarget.querySelector<HTMLElement>(`[data-path="${CSS.escape(current.lead)}"]`);
          const rect = (row ?? event.currentTarget).getBoundingClientRect();
          openMenuAt(current.lead, { x: rect.left + 24, y: rect.bottom - 4 });
          return;
        }
        default:
          if ((event.key === "a" || event.key === "A") && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit({ keys: new Set(keys), anchor: keys[0] ?? null, lead: current.lead ?? keys.at(-1) ?? null });
          }
      }
    },
  };

  return {
    selection,
    marquee,
    keyboardNav,
    viewportProps,
    /** Current selection without waiting for a render (row menus, checkbox clicks). */
    selectionRef,
    orderRef,
    commit,
    openMenuAt,
  };
}
