/**
 * Row selection for the entry list: a transient highlight (click, Ctrl/Shift,
 * marquee, keyboard) that bulk actions such as checking or translating apply
 * to. It is separate from the checked set, which decides what gets renamed, so
 * a stray click never discards a carefully built rename selection.
 */
export interface RowSelection {
  readonly keys: ReadonlySet<string>;
  /** Fixed end of Shift ranges. */
  readonly anchor: string | null;
  /** Moving end: the row keyboard navigation continues from. */
  readonly lead: string | null;
}

export const EMPTY_SELECTION: RowSelection = { keys: new Set(), anchor: null, lead: null };

export interface ClickModifiers {
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  readonly toggle: boolean;
  readonly range: boolean;
}

/** Keys between two rows (inclusive) in display order; empty when either is not shown. */
export function rangeKeys(order: readonly string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start < 0 || end < 0) return [];
  const [low, high] = start <= end ? [start, end] : [end, start];
  return order.slice(low, high + 1);
}

/** Explorer-style click: plain selects one, Ctrl toggles, Shift selects a range, Ctrl+Shift adds a range. */
export function clickSelection(
  selection: RowSelection,
  order: readonly string[],
  key: string,
  modifiers: ClickModifiers,
): RowSelection {
  const anchor = selection.anchor && order.includes(selection.anchor) ? selection.anchor : null;
  if (modifiers.range && anchor) {
    const range = rangeKeys(order, anchor, key);
    const keys = modifiers.toggle ? new Set([...selection.keys, ...range]) : new Set(range);
    return { keys, anchor, lead: key };
  }
  if (modifiers.toggle) {
    const keys = new Set(selection.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: key, lead: key };
  }
  return { keys: new Set([key]), anchor: key, lead: key };
}

/** Row index range [first, last] covered by a vertical band, or null when it covers no row. */
export function rowsInBand(top: number, bottom: number, rowHeight: number, count: number): [number, number] | null {
  const low = Math.min(top, bottom);
  const high = Math.max(top, bottom);
  if (count === 0 || high < 0 || low >= count * rowHeight) return null;
  const first = Math.max(0, Math.floor(low / rowHeight));
  const last = Math.min(count - 1, Math.floor(high / rowHeight));
  return [first, last];
}

/**
 * Marquee result relative to the selection the drag started from: the band
 * replaces it, is added to it (Shift) or toggles rows against it (Ctrl).
 */
export function marqueeSelection(
  base: ReadonlySet<string>,
  order: readonly string[],
  band: [number, number] | null,
  mode: "replace" | "add" | "toggle",
): RowSelection {
  const covered = band ? order.slice(band[0], band[1] + 1) : [];
  const keys = new Set(mode === "replace" ? [] : base);
  for (const key of covered) {
    if (mode === "toggle" && base.has(key)) keys.delete(key);
    else keys.add(key);
  }
  return { keys, anchor: covered[0] ?? null, lead: covered.at(-1) ?? null };
}

/** Moves the lead by `delta` rows (clamped). Shift extends from the anchor. */
export function moveSelection(
  selection: RowSelection,
  order: readonly string[],
  target: number | "first" | "last",
  extend: boolean,
): RowSelection {
  if (order.length === 0) return selection;
  const current = selection.lead ? order.indexOf(selection.lead) : -1;
  let index: number;
  if (target === "first") index = 0;
  else if (target === "last") index = order.length - 1;
  else if (current < 0) index = target > 0 ? 0 : order.length - 1;
  else index = Math.min(order.length - 1, Math.max(0, current + target));
  const key = order[index]!;
  return clickSelection(selection, order, key, { toggle: false, range: extend });
}

/** Drops rows that are no longer shown (collapsed, filtered out or removed). */
export function pruneSelection(selection: RowSelection, order: readonly string[]): RowSelection {
  const shown = new Set(order);
  const keys = [...selection.keys].filter((key) => shown.has(key));
  const anchor = selection.anchor && shown.has(selection.anchor) ? selection.anchor : null;
  const lead = selection.lead && shown.has(selection.lead) ? selection.lead : null;
  if (keys.length === selection.keys.size && anchor === selection.anchor && lead === selection.lead) return selection;
  return { keys: new Set(keys), anchor, lead };
}

/** Keys a row action applies to: the whole selection when the row is part of it, otherwise the row alone. */
export function actionTargets(selection: RowSelection, order: readonly string[], key: string): string[] {
  if (!selection.keys.has(key)) return [key];
  return order.filter((candidate) => selection.keys.has(candidate));
}
