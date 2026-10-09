import { afterEach, describe, expect, it, vi } from "vitest";
import { dockPanelRect, homeColumnTarget, predictHomeColumn, readHomeColumn, registerHomeColumn } from "./handoff";

afterEach(() => vi.unstubAllGlobals());

describe("home ↔ panel handoff geometry", () => {
  it("rests the panel above the launcher, aligned with it", () => {
    expect(dockPanelRect({ width: 1280, height: 860 })).toEqual({ left: 11, top: 860 - 58 - 620, width: 400, height: 620 });
    expect(dockPanelRect({ width: 786, height: 660 })).toEqual({ left: 11, top: 40 + 8, width: 400, height: 660 - 58 - 48 });
    expect(dockPanelRect({ width: 380, height: 660 }).width).toBe(358);
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
