import { afterEach, describe, expect, it } from "vitest";
import {
  buildPageContextSection, isPageContextActive, PAGE_SNAPSHOT_LIMIT, pageTitleKey, pageTools, registerPageContext, setRouteTitleKeys,
  resolvePageContext, updatePageDisplay, usePageContextStore,
} from "./page-context";

const t = (key: string) => `t(${key})`;
afterEach(() => usePageContextStore.setState({ pathname: "/", pages: [] }));

describe("page context registry", () => {
  it("resolves the latest registration for the current route and forgets unregistered pages", () => {
    const first = registerPageContext({ route: "/tools/a", titleKey: "a", read: () => ({ route: "/tools/a", titleKey: "a" }) });
    const second = registerPageContext({ route: "/tools/a", titleKey: "a2", read: () => ({ route: "/tools/a", titleKey: "a2" }) });
    registerPageContext({ route: "/tools/b", titleKey: "b", read: () => null });
    usePageContextStore.getState().setPathname("/tools/a");
    expect(resolvePageContext()?.id).toBe(second.id);
    second.unregister();
    expect(resolvePageContext()?.id).toBe(first.id);
    expect(isPageContextActive(second.id)).toBe(false);
    updatePageDisplay(first.id, { titleKey: "a", subject: "doc.srt" });
    expect(resolvePageContext()?.subject).toBe("doc.srt");
    expect(resolvePageContext("/tools/none")).toBeUndefined();
  });

  it("names routes from the registration, the home page or the known routes", () => {
    setRouteTitleKeys({ "/tools/subtitle/studio": "studio:title" });
    expect(pageTitleKey("/")).toBe("home:agent_title");
    expect(pageTitleKey("/tools/subtitle/studio")).toBe("studio:title");
    expect(pageTitleKey("/tools/unknown")).toBeUndefined();
    expect(pageTitleKey("/tools/unknown", { titleKey: "x" })).toBe("x");
  });
});

describe("page context section", () => {
  it("includes the snapshot, subject and guidance of the page", () => {
    const page = { id: "p", route: "/tools/x", titleKey: "x", read: () => ({ route: "/tools/x", titleKey: "x", subject: "doc.srt", instructions: "Use page tools.", describe: () => ({ cueCount: 3 }) }) };
    expect(buildPageContextSection("/tools/x", page, t)).toEqual({ route: "/tools/x", title: "t(x)", subject: "doc.srt", instructions: "Use page tools.", snapshot: { cueCount: 3 } });
    expect(buildPageContextSection("/", undefined, t)).toEqual({ route: "/", title: "t(home:agent_title)" });
  });

  it("truncates large snapshots and drops broken ones without failing the turn", () => {
    const large = { id: "p", route: "/x", titleKey: "x", read: () => ({ route: "/x", titleKey: "x", describe: () => ({ text: "a".repeat(PAGE_SNAPSHOT_LIMIT * 2) }) }) };
    const section = buildPageContextSection("/x", large, t);
    expect(section.snapshotTruncated).toBe(true);
    expect(String(section.snapshot).length).toBe(PAGE_SNAPSHOT_LIMIT);
    const broken = { id: "p", route: "/x", titleKey: "x", read: () => ({ route: "/x", titleKey: "x", describe: () => { throw new Error("boom"); } }) };
    expect(buildPageContextSection("/x", broken, t)).toEqual({ route: "/x", title: "t(x)", snapshotError: "boom" });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const unserializable = { id: "p", route: "/x", titleKey: "x", read: () => ({ route: "/x", titleKey: "x", describe: () => cyclic }) };
    expect(buildPageContextSection("/x", unserializable, t).snapshotError).toBeTruthy();
  });
});

describe("page tools", () => {
  it("run the page's current tool and refuse once the page is gone", async () => {
    let version = 1;
    const tool = () => ({ description: "d", inputSchema: undefined as never, execute: async () => ({ success: true, data: version }) });
    const read = () => ({ route: "/x", titleKey: "x", tools: { page_echo: tool() } });
    const registration = registerPageContext({ route: "/x", titleKey: "x", read });
    const tools = pageTools(resolvePageContext("/x")!);
    const options = { toolCallId: "1", messages: [] };
    version = 2;
    await expect(tools.page_echo.execute!({}, options)).resolves.toEqual({ success: true, data: 2 });
    registration.unregister();
    await expect(tools.page_echo.execute!({}, options)).resolves.toEqual({ success: false, error: "page_unavailable" });
  });
});
