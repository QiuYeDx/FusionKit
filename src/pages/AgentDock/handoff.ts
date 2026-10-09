/** A viewport rectangle in CSS pixels. */
export type DockRect = { left: number; top: number; width: number; height: number };
export type Viewport = { width: number; height: number };

export const DOCK_EDGE = 11;
export const DOCK_LAUNCHER = 36;
/** The panel rests one edge gap above the launcher, clear of the bottom navigation. */
export const DOCK_PANEL_BOTTOM = DOCK_EDGE + DOCK_LAUNCHER + DOCK_EDGE;
const TITLE_BAR = 40;

/** Where the open panel rests: left edge aligned with the launcher, sized to the window. */
export function dockPanelRect(viewport: Viewport): DockRect {
  const width = Math.min(400, viewport.width - DOCK_EDGE * 2);
  const height = Math.min(620, viewport.height - DOCK_PANEL_BOTTOM - TITLE_BAR - 8);
  return { left: DOCK_EDGE, top: viewport.height - DOCK_PANEL_BOTTOM - height, width, height };
}

/**
 * The home page's conversation column: the centered message column from below
 * the title bar to the bottom of its composer (see HomeAgent's layout).
 */
export function predictHomeColumn(viewport: Viewport): DockRect {
  const width = Math.min(672, viewport.width - 32);
  const top = TITLE_BAR + 8;
  return { left: (viewport.width - width) / 2, top, width, height: Math.max(120, viewport.height - 58 - top) };
}

let homeColumn: (() => DockRect | null) | null = null;
let lastHomeColumn: { rect: DockRect; viewport: Viewport } | null = null;

/**
 * The home page lends a reader of its conversation column while it shows a
 * conversation; the dock reads it the moment the route leaves home, while the
 * home page is still on screen.
 */
export function registerHomeColumn(read: () => DockRect | null): () => void {
  homeColumn = read;
  return () => {
    const rect = read();
    if (rect) lastHomeColumn = { rect, viewport: { width: window.innerWidth, height: window.innerHeight } };
    if (homeColumn === read) homeColumn = null;
  };
}

/** The live home column, or null when the home page shows no conversation. */
export function readHomeColumn(): DockRect | null {
  const rect = homeColumn?.() ?? null;
  if (rect) lastHomeColumn = { rect, viewport: { width: window.innerWidth, height: window.innerHeight } };
  return rect;
}

/** Where the home column will appear when returning: the last measurement in this window size, or the layout's prediction. */
export function homeColumnTarget(viewport: Viewport): DockRect {
  const last = lastHomeColumn;
  return last && last.viewport.width === viewport.width && last.viewport.height === viewport.height ? last.rect : predictHomeColumn(viewport);
}
