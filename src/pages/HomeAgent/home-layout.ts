import { motionValue } from "motion/react";

// ---------------------------------------------------------------------------
// The home page's horizontal layout: the session list docked at the left, and the
// conversation centered in the space beside it. Shared by the home page, its
// session list and the floating panel's flight back home.
// ---------------------------------------------------------------------------

/** The list hugs the window's left edge, like the title bar's capsules hug their corners. */
export const SIDEBAR_LEFT = 8;
export const SIDEBAR_WIDTH = 248;
/**
 * From this window width on the list stays beside the conversation: the 672px column, centered in the space right
 * of the list (8 + 248), keeps at least 32px on both sides: 256 + 36 + 672 + 36 = 1000.
 */
export const SIDEBAR_DOCK_MIN_WIDTH = 1000;
/** While the list is docked, the centered content moves right by half the list's footprint: centered beside it. */
export const DOCKED_CONTENT_SHIFT = (SIDEBAR_LEFT + SIDEBAR_WIDTH) / 2;

const COLLAPSED_KEY = "fusionkit-agent-sidebar-collapsed";
export const readSidebarCollapsed = () => { try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; } };
export const writeSidebarCollapsed = (collapsed: boolean) => {
  try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* the choice then lasts while the app runs */ }
};

/** How far the home page's centered content is moved right now; the session list animates it with its own spring. */
export const homeContentShift = motionValue(0);

/** The shift the home page will have in a window of this width, before it is on screen. */
export function predictHomeContentShift(width: number): number {
  return width >= SIDEBAR_DOCK_MIN_WIDTH && !readSidebarCollapsed() ? DOCKED_CONTENT_SHIFT : 0;
}
