import { afterEach, describe, expect, it, vi } from "vitest";
import { clampDockOffset, dockPanelRect, homeColumnTarget, predictHomeColumn, readHomeColumn, registerHomeColumn } from "./handoff";

afterEach(() => vi.unstubAllGlobals());

describe("home ↔ panel handoff geometry", () => {
  it("rests the panel above the launcher, aligned with it", () => {
    expect(dockPanelRect({ width: 1280, height: 860 })).toEqual({ left: 11, top: 860 - 58 - 620, width: 400, height: 620 });
    expect(dockPanelRect({ width: 786, height: 660 })).toEqual({ left: 11, top: 40 + 8, width: 400, height: 660 - 58 - 48 });
    expect(dockPanelRect({ width: 380, height: 660 }).width).toBe(358);
  });

  it("keeps a dragged panel inside the window, below the title bar", () => {
    const viewport = { width: 1280, height: 860 };
    expect(clampDockOffset({ x: 300, y: -100 }, viewport)).toEqual({ x: 300, y: -100 });
    // Right edge: 1280 - 11 - 400 - 11; top: the title bar plus a gap; bottom: one edge gap from the window.
    expect(clampDockOffset({ x: 5000, y: -5000 }, viewport)).toEqual({ x: 858, y: 48 - 182 });
    expect(clampDockOffset({ x: -50, y: 500 }, viewport)).toEqual({ x: 0, y: 47 });
    expect(clampDockOffset({ x: 10.6, y: 0 }, viewport)).toEqual({ x: 11, y: 0 });
    // A panel that already fills the window stays where it rests.
    expect(clampDockOffset({ x: 40, y: 0 }, { width: 380, height: 660 }).x).toBe(0);
  });

  it("predicts the home column from the home page layout", () => {
    expect(predictHomeColumn({ width: 1280, height: 860 })).toEqual({ left: 304, top: 48, width: 672, height: 860 - 58 - 48 });
    expect(predictHomeColumn({ width: 600, height: 660 }).width).toBe(568);
  });

  it("reads the live column while home shows a conversation and remembers it for the return", () => {
    vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 860 });
    let rect: { left: number; top: number; width: number; height: number } | null = { left: 300, top: 48, width: 680, height: 700 };
    const unregister = registerHomeColumn(() => rect);
    expect(readHomeColumn()).toEqual(rect);
    unregister();
    expect(readHomeColumn()).toBeNull();
    expect(homeColumnTarget({ width: 1280, height: 860 })).toEqual({ left: 300, top: 48, width: 680, height: 700 });
    // Another window size falls back to the prediction.
    expect(homeColumnTarget({ width: 1000, height: 700 })).toEqual(predictHomeColumn({ width: 1000, height: 700 }));
    rect = null;
    registerHomeColumn(() => rect);
    expect(readHomeColumn()).toBeNull();
  });
});
