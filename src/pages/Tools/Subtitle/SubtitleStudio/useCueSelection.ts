import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { EMPTY_SELECTION, actionTargets, clickSelection, marqueeSelection, moveSelection, pruneSelection, type RowSelection } from '@/services/row-selection';

/** Elements inside a row that keep their own pointer behaviour (buttons, the inline editor). */
export const CUE_CONTROL_ATTR = 'data-cue-control';
const DRAG_THRESHOLD = 4;
const AUTO_SCROLL_EDGE = 28;

export type MarqueeRect = { left: number; top: number; width: number; height: number };
type DragState = {
  pointerId: number; startClientX: number; startClientY: number; startX: number; startY: number;
  key: string | null; toggle: boolean; range: boolean; base: ReadonlySet<string>;
  clientX: number; clientY: number; active: boolean;
};
type Options = {
  /** Cue ids in display order. */
  order: readonly string[];
  /** The focusable list; rows carry `data-cue-id`. */
  listRef: RefObject<HTMLElement | null>;
  /** The element that scrolls the list. */
  scrollRef: RefObject<HTMLElement | null>;
  openMenu: (targets: string[], point: { x: number; y: number }) => void;
  /** Shortcuts beyond selection (edit, delete, copy, undo). Return true when handled. */
  onKey: (event: KeyboardEvent<HTMLElement>, selection: RowSelection, targets: string[]) => boolean;
};

const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest(`[${CUE_CONTROL_ATTR}]`);
const rowKeyOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-cue-id]')?.dataset.cueId ?? null : null;

/**
 * Explorer-style selection for the cue table: click, Ctrl/⌘ and Shift clicks,
 * marquee drag with auto-scroll and keyboard navigation. Rows have variable
 * heights (wrapped subtitle text), so hit testing measures the rendered rows;
 * a page holds at most 100 of them.
 */
export function useCueSelection(options: Options) {
  const [selection, setSelection] = useState<RowSelection>(EMPTY_SELECTION);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [keyboardNav, setKeyboardNav] = useState(false);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const drag = useRef<DragState | null>(null);
  const frame = useRef(0);
  const suppressClick = useRef(false);

  const commit = (next: RowSelection) => { selectionRef.current = next; setSelection(next); };

  // Rows that leave the page (paging, deletion) leave the selection.
  const orderKey = options.order.join('\n');
  useEffect(() => {
    const pruned = pruneSelection(selectionRef.current, optionsRef.current.order);
    if (pruned !== selectionRef.current) commit(pruned);
  }, [orderKey]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const rows = () => [...(optionsRef.current.listRef.current?.querySelectorAll<HTMLElement>('[data-cue-id]') ?? [])];
  const listPoint = (clientX: number, clientY: number) => {
    const rect = optionsRef.current.listRef.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top, width: rect.width, height: rect.height, top: rect.top } : null;
  };
  /** Indices of the rendered rows that a vertical band (list coordinates) touches. */
  const band = (from: number, to: number, top: number): [number, number] | null => {
    const low = Math.min(from, to), high = Math.max(from, to);
    let first = -1, last = -1;
    rows().forEach((row, index) => {
      const rect = row.getBoundingClientRect();
      if (rect.bottom - top > low && rect.top - top < high) { if (first < 0) first = index; last = index; }
    });
    return first < 0 ? null : [first, last];
  };

  const updateMarquee = () => {
    const state = drag.current;
    const point = state ? listPoint(state.clientX, state.clientY) : null;
    if (!state || !point) return;
    const clampX = (value: number) => Math.min(point.width, Math.max(0, value));
    const clampY = (value: number) => Math.min(point.height, Math.max(0, value));
    const [x0, x1] = [clampX(state.startX), clampX(point.x)].sort((a, b) => a - b);
    const [y0, y1] = [clampY(state.startY), clampY(point.y)].sort((a, b) => a - b);
    setMarquee({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    commit(marqueeSelection(state.base, optionsRef.current.order, band(state.startY, point.y, point.top), state.toggle ? 'toggle' : state.range ? 'add' : 'replace'));
  };

  const autoScroll = () => {
    const state = drag.current;
    const viewport = optionsRef.current.scrollRef.current;
    if (!state?.active || !viewport) return;
    const rect = viewport.getBoundingClientRect();
    // The sticky table header covers the top edge of the viewport.
    const top = rect.top + 36;
    let delta = 0;
    if (state.clientY < top + AUTO_SCROLL_EDGE) delta = -(top + AUTO_SCROLL_EDGE - state.clientY);
    else if (state.clientY > rect.bottom - AUTO_SCROLL_EDGE) delta = state.clientY - (rect.bottom - AUTO_SCROLL_EDGE);
    if (delta) {
      const before = viewport.scrollTop;
      viewport.scrollTop += Math.sign(delta) * Math.min(32, Math.ceil(Math.abs(delta) / 3) + 2);
      if (viewport.scrollTop !== before) updateMarquee();
    }
    frame.current = requestAnimationFrame(autoScroll);
  };

  const endDrag = () => {
    const state = drag.current;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    if (!state?.active) return;
    const list = optionsRef.current.listRef.current;
    if (list?.hasPointerCapture(state.pointerId)) list.releasePointerCapture(state.pointerId);
    setMarquee(null);
    // The click that ends a drag must not also act on the row under it.
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);
  };

  const rowOf = (key: string) => rows().find(row => row.dataset.cueId === key);
  const scrollToRow = (key: string) => rowOf(key)?.scrollIntoView({ block: 'nearest' });

  const openMenuAt = (key: string, point: { x: number; y: number }) => {
    let current = selectionRef.current;
    if (!current.keys.has(key)) {
      current = clickSelection(current, optionsRef.current.order, key, { toggle: false, range: false });
      commit(current);
    }
    optionsRef.current.openMenu(actionTargets(current, optionsRef.current.order, key), point);
  };

  /** Targets of keyboard actions: the selection, or the focused row. */
  const keyTargets = (current: RowSelection) => {
    const order = optionsRef.current.order;
    return current.keys.size ? order.filter(key => current.keys.has(key)) : current.lead && order.includes(current.lead) ? [current.lead] : [];
  };

  const listProps = {
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || isControl(event.target)) return;
      // Keep keyboard focus on the list and avoid native text selection while selecting rows.
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      setKeyboardNav(false);
      if (event.button !== 0 || isControl(event.target)) return;
      const point = listPoint(event.clientX, event.clientY);
      drag.current = {
        pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY,
        startX: point?.x ?? 0, startY: point?.y ?? 0, key: rowKeyOf(event.target),
        toggle: event.ctrlKey || event.metaKey, range: event.shiftKey, base: selectionRef.current.keys,
        clientX: event.clientX, clientY: event.clientY, active: false,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      state.clientX = event.clientX; state.clientY = event.clientY;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.startClientX, event.clientY - state.startClientY) < DRAG_THRESHOLD) return;
        state.active = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        frame.current = requestAnimationFrame(autoScroll);
      }
      updateMarquee();
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (state.active) { endDrag(); return; }
      drag.current = null;
      if (state.key) commit(clickSelection(selectionRef.current, optionsRef.current.order, state.key, { toggle: state.toggle, range: state.range }));
      else if (!state.toggle && !state.range) commit(EMPTY_SELECTION);
    },
    onPointerCancel: endDrag,
    onLostPointerCapture: () => { if (drag.current?.active) endDrag(); },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!suppressClick.current) return;
      event.preventDefault(); event.stopPropagation();
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      if (event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      const key = rowKeyOf(event.target);
      if (!key) { commit(EMPTY_SELECTION); return; }
      openMenuAt(key, { x: event.clientX, y: event.clientY });
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
      const current = selectionRef.current;
      const order = optionsRef.current.order;
      if (optionsRef.current.onKey(event, current, keyTargets(current))) { event.preventDefault(); return; }
      const move = (target: number | 'first' | 'last') => {
        event.preventDefault();
        setKeyboardNav(true);
        const next = moveSelection(current, order, target, event.shiftKey);
        commit(next);
        if (next.lead) scrollToRow(next.lead);
      };
      switch (event.key) {
        case 'ArrowDown': return move(1);
        case 'ArrowUp': return move(-1);
        case 'PageDown': return move(10);
        case 'PageUp': return move(-10);
        case 'Home': return move('first');
        case 'End': return move('last');
        case 'Escape':
          // Only consume Escape when it clears something (FK-PIT-0164).
          if (!current.keys.size) return;
          event.preventDefault(); event.stopPropagation();
          commit({ ...EMPTY_SELECTION, lead: current.lead, anchor: current.lead });
          return;
        case 'ContextMenu':
        case 'F10': {
          if (event.key === 'F10' && !event.shiftKey) return;
          if (!current.lead) return;
          event.preventDefault();
          scrollToRow(current.lead);
          const rect = (rowOf(current.lead) ?? event.currentTarget).getBoundingClientRect();
          openMenuAt(current.lead, { x: rect.left + 48, y: rect.bottom - 4 });
          return;
        }
        default:
          if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit({ keys: new Set(order), anchor: order[0] ?? null, lead: current.lead ?? order.at(-1) ?? null });
          }
      }
    },
  };

  return { selection, selectionRef, marquee, keyboardNav, setKeyboardNav, listProps, commit, openMenuAt, scrollToRow };
}
