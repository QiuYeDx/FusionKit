import { describe, expect, it } from "vitest";
import { createSettingSearchParams, resolveSettingTab } from "./settingNavigation";

describe("setting navigation", () => {
  it("accepts known tabs and falls back to general", () => {
    expect(resolveSettingTab("proxy")).toBe("proxy");
    expect(resolveSettingTab("agent")).toBe("agent");
    expect(resolveSettingTab("audio")).toBe("general");
    expect(resolveSettingTab("unknown")).toBe("general");
    expect(resolveSettingTab(null)).toBe("general");
  });

  it("switches the tab and keeps the other parameters", () => {
    const next = createSettingSearchParams(new URLSearchParams("tab=general&source=tool"), "model");
    expect(next.get("tab")).toBe("model");
    expect(next.get("source")).toBe("tool");
  });
});
