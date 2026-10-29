/**
 * Whether a layer (dialog, menu, list, popover) is on screen. Panels that stay mounted while closed,
 * such as the title bar's connection panel, hide behind `aria-hidden`, `inert` or `hidden`; counting
 * them as open made every tool page refuse file drops (FK-PIT-0198).
 */
export function isShownLayer(element: Element): boolean {
  return !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}
