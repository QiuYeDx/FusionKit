import { afterEach, describe, expect, it, vi } from "vitest";
import { isShownLayer } from "./layers";

type Look = { rects?: number; visibility?: string; hiddenBy?: string };

function layer({ rects = 1, visibility = "visible", hiddenBy }: Look = {}) {
  const selectors: string[] = [];
  const element = {
    closest: (selector: string) => { selectors.push(selector); return hiddenBy ? {} : null; },
    getClientRects: () => ({ length: rects }),
    visibility,
  };
  return { element: element as unknown as Element, selectors };
}

describe("isShownLayer", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("counts a layer that is laid out and visible", () => {
    vi.stubGlobal("getComputedStyle", (element: { visibility: string }) => ({ visibility: element.visibility }));
    expect(isShownLayer(layer().element)).toBe(true);
  });

  it("ignores a closed panel kept mounted behind aria-hidden, inert or hidden", () => {
    vi.stubGlobal("getComputedStyle", (element: { visibility: string }) => ({ visibility: element.visibility }));
    const closed = layer({ hiddenBy: "aria-hidden" });
    expect(isShownLayer(closed.element)).toBe(false);
    expect(closed.selectors).toEqual(['[hidden], [inert], [aria-hidden="true"]']);
  });

  it("ignores layers without a box or with hidden visibility", () => {
    vi.stubGlobal("getComputedStyle", (element: { visibility: string }) => ({ visibility: element.visibility }));
    expect(isShownLayer(layer({ rects: 0 }).element)).toBe(false);
    expect(isShownLayer(layer({ visibility: "hidden" }).element)).toBe(false);
  });
});
