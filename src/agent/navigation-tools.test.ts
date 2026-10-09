import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => `t(${key})` } }));

import { executeOpenAppPage, setAgentNavigator } from "./navigation-tools";
import { registerPageContext, usePageContextStore } from "./page-context";

afterEach(() => { setAgentNavigator(null); usePageContextStore.setState({ pathname: "/", pages: [] }); });

describe("open_app_page", () => {
  it("opens only known pages and needs the application navigator", async () => {
    expect(await executeOpenAppPage({ page: "/etc/passwd" })).toEqual({ success: false, error: "invalid_tool_arguments" });
    expect(await executeOpenAppPage({ page: "subtitle_translator" })).toEqual({ success: false, error: "navigation_unavailable" });
  });

  it("navigates, waits for the page to describe itself and returns its snapshot", async () => {
    const navigate = vi.fn((to: string) => {
      usePageContextStore.getState().setPathname(to.split("?")[0]);
      setTimeout(() => registerPageContext({ route: "/tools/subtitle/studio", titleKey: "studio:title", subject: "a.srt",
        read: () => ({ route: "/tools/subtitle/studio", titleKey: "studio:title", subject: "a.srt", describe: () => ({ document: { cueCount: 3 } }) }) }), 20);
    });
    setAgentNavigator(navigate);
    const result = await executeOpenAppPage({ page: "subtitle_studio", studioView: "documents" });
    expect(navigate).toHaveBeenCalledWith("/tools/subtitle/studio?view=documents");
    expect(result).toMatchObject({ success: true, data: { route: "/tools/subtitle/studio", title: "t(studio:title)", subject: "a.srt", snapshot: { document: { cueCount: 3 } } } });
  });

  it("returns after the timeout for pages without context and does not reopen the current page", async () => {
    const navigate = vi.fn((to: string) => usePageContextStore.getState().setPathname(to.split("?")[0]));
    setAgentNavigator(navigate);
    const opened = await executeOpenAppPage({ page: "model_settings" }, undefined, 30);
    expect(navigate).toHaveBeenCalledWith("/setting?tab=model");
    expect(opened).toMatchObject({ success: true, data: { route: "/setting" } });
    expect((opened as { data: Record<string, unknown> }).data.snapshot).toBeUndefined();
    const again = await executeOpenAppPage({ page: "model_settings" }, undefined, 10);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ data: { alreadyOpen: true } });
  });
});
