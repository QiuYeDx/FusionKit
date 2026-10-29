import { createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileVideoCamera } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { NAMESPACES } from "@/i18n/constants";
import { resources } from "@/i18n/resources";
import { MEDIA_CONVERTER_ROUTE, ToolNameMap } from "@/constants/router";
import { TOOL_META, isMediaConverterSupported } from "@/pages/Tools/_shared/toolMeta";
import { LangEnum } from "@/type/lang";
import Tools from "@/pages/Tools";
import MediaConverter from ".";

// The catalog's header button opens the agent's workflow templates: its store and agent are not
// what this test is about.
vi.mock("@/pages/HomeAgent/components/PromptTemplates", () => ({
  TemplateMenuButton: () => null,
  openPromptTemplate: () => undefined,
}));
vi.mock("@/components/agent-orb/AgentOrb", () => ({ default: () => null }));

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const LANGUAGES = [LangEnum.ZH, LangEnum.EN, LangEnum.JA, LangEnum.ZH_HANT];

/**
 * A stand-in `window` with the preload's `mediaConverter` as given (`undefined`: no such API at all). Motion
 * listens on the window once one exists, so it is an EventTarget.
 */
const fakeWindow = (api: { supported: boolean } | undefined) => Object.assign(new EventTarget(), api ? { mediaConverter: api } : {});

/** Renders as the app would under `fakeWindow(api)`. */
function render(element: ReactElement, api: { supported: boolean } | undefined, route = "/tools"): string {
  vi.stubGlobal("window", fakeWindow(api));
  try {
    // The app's providers: the router and the tooltips' (src/main.tsx).
    return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [route] }, createElement(TooltipProvider, null, element)));
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The markup of one `<section>` of the catalog, found by its heading id. */
function section(markup: string, headingId: string): string | undefined {
  return markup.split("<section").map(part => `<section${part}`).find(part => part.includes(`aria-labelledby="${headingId}"`));
}

const toolCount = (markup: string) => Number(/FusionKit · (\d+)/.exec(markup)?.[1]);

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage(LangEnum.ZH);
});

describe("media converter registration", () => {
  it("registers the tool, its route, tone and bottom navigation name", () => {
    expect(MEDIA_CONVERTER_ROUTE).toBe("/tools/media/converter");
    expect(TOOL_META.mediaConverter).toEqual({
      id: "mediaConverter",
      toneVar: "--tool-media",
      icon: FileVideoCamera,
      category: "media",
      status: "stable",
      route: MEDIA_CONVERTER_ROUTE,
    });
    expect(ToolNameMap[MEDIA_CONVERTER_ROUTE]).toBe("menu.media.converter");
    // The route is registered whatever the platform; only the page decides what it shows.
    const app = source("../../../../App.tsx");
    expect(app).toContain('import MediaConverter from "./pages/Tools/Media/MediaConverter";');
    expect(app).toMatch(/\n {16}<Route path=\{MEDIA_CONVERTER_ROUTE\} element=\{<MediaConverter \/>\} \/>/);
  });

  it("defines the media tone for the light and the dark theme", () => {
    const css = source("../../../../index.css");
    const block = (selector: string) => css.split(`\n${selector} {`)[1]?.split("\n}")[0] ?? "";
    expect(block(":root")).toContain("--tool-media: oklch(0.62 0.15 335);");
    expect(block(".dark")).toContain("--tool-media: oklch(0.72 0.15 335);");
  });

  it("reads the platform from the preload and nothing else", () => {
    vi.stubGlobal("window", { mediaConverter: { supported: true } });
    expect(isMediaConverterSupported()).toBe(true);
    vi.stubGlobal("window", { mediaConverter: { supported: false } });
    expect(isMediaConverterSupported()).toBe(false);
    vi.stubGlobal("window", {});
    expect(isMediaConverterSupported()).toBe(false);
    vi.unstubAllGlobals();
    // Under Node there is no window at all.
    expect(isMediaConverterSupported()).toBe(false);
  });
});

describe("tools catalog media section", () => {
  it("shows the media tools between the classic and the experimental tools where the converter is supported", () => {
    const markup = render(createElement(Tools), { supported: true });
    const media = section(markup, "media-tools-title");
    expect(media).toBeDefined();
    expect(media).toContain('data-testid="tools-media-heading"');
    expect(media).toContain("媒体工具");
    expect(media).toContain("处理音视频文件的工具，全程在本机运行。");
    expect(media).toContain('<span class="tools-count" aria-hidden="true">01</span>');
    expect([...media!.matchAll(/data-tool-card="([A-Za-z]+)"/g)].map(match => match[1])).toEqual(["mediaConverter"]);
    expect(media).toContain(`href="${MEDIA_CONVERTER_ROUTE}"`);
    expect(media).toContain("音视频转换");
    expect(media).toContain("压缩 · 转换 · 提取音频");
    expect(media).toContain("本机处理 · 不上传");
    expect(media).toContain("lg:col-span-3");
    // No hand-over to the agent until I5, and no Beta badge.
    expect(media).not.toContain("tool-agent-handoff");
    expect(media).not.toContain("Beta");
    const order = ["classic-tools-title", "media-tools-title", "experimental-tools-title"].map(id => markup.indexOf(`aria-labelledby="${id}"`));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 2 featured + 5 classic + 1 media + 1 experimental.
    expect(toolCount(markup)).toBe(9);
  });

  it("leaves the section out, and out of the count, where the converter is not supported", () => {
    for (const api of [{ supported: false }, undefined]) {
      const markup = render(createElement(Tools), api);
      expect(section(markup, "media-tools-title")).toBeUndefined();
      expect(markup).not.toContain("mediaConverter");
      expect(markup).not.toContain(MEDIA_CONVERTER_ROUTE);
      expect(toolCount(markup)).toBe(8);
    }
  });

  it("keeps the featured, classic and experimental sections as they were", () => {
    const shown = render(createElement(Tools), { supported: true });
    const hidden = render(createElement(Tools), { supported: false });
    for (const id of ["classic-tools-title", "experimental-tools-title"]) {
      expect(section(shown, id)).toBeDefined();
      expect(section(shown, id)).toBe(section(hidden, id));
    }
    const featured = (markup: string) => markup.split('data-testid="tools-featured-grid"')[1]?.split("</section>")[0];
    expect(featured(shown)).toBeDefined();
    expect(featured(shown)).toBe(featured(hidden));
  });

  it("declares the media tools outside the two lists the agent capability catalog reads", () => {
    const catalog = source("../../index.tsx");
    // The same cuts as src/agent/capability-catalog.test.ts.
    const classic = catalog.split("const CLASSIC_TOOLS:")[1].split("const EXPERIMENTAL_TOOLS:")[0];
    const featured = catalog.split("const FEATURED_TOOLS =")[1].split("const Tools:")[0];
    expect(`${classic}\n${featured}`).not.toContain("mediaConverter");
    const declared = catalog.indexOf("const MEDIA_TOOLS:");
    expect(declared).toBeGreaterThan(catalog.indexOf("const EXPERIMENTAL_TOOLS:"));
    expect(declared).toBeLessThan(catalog.indexOf("type FeaturedItem"));
  });
});

describe("media converter page", () => {
  it("shows the header and only the platform notice where the converter is not supported", () => {
    for (const api of [{ supported: false }, undefined]) {
      const markup = render(createElement(MediaConverter), api, MEDIA_CONVERTER_ROUTE);
      expect(markup).toContain('data-platform="unsupported"');
      expect(markup).toContain('data-slot="tool-detail-layout"');
      expect(markup.match(/<h1[ >]/g)).toHaveLength(1);
      expect(markup).toMatch(/<h1[^>]*>音视频转换<\/h1>/);
      expect(markup).toContain("压缩视频、转换格式、提取音频，全程在本机完成，文件不会上传。");
      expect(markup).toContain('data-testid="media-converter-unsupported"');
      expect(markup).toContain("暂不支持此平台");
      expect(markup).toContain("音视频转换目前只能在 Windows 上使用。");
      // No settings column and no file picker.
      expect(markup).toMatch(/<aside class="[^"]*\bhidden\b[^"]*"><\/aside>/);
      expect(markup).not.toContain('data-slot="tool-file-picker"');
      expect(markup).not.toContain('data-slot="tool-config-panel"');
    }
  });

  it("shows the tool itself where the converter is supported", () => {
    const markup = render(createElement(MediaConverter), { supported: true }, MEDIA_CONVERTER_ROUTE);
    expect(markup).toContain('data-platform="supported"');
    expect(markup).toMatch(/<h1[^>]*>音视频转换<\/h1>/);
    expect(markup).not.toContain("media-converter-unsupported");
    expect(markup).not.toContain("暂不支持此平台");
  });
});

describe("media converter wording", () => {
  const keysOf = (value: unknown, prefix = ""): string[] => Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    typeof entry === "object" && entry !== null ? keysOf(entry, `${prefix}${key}.`) : [`${prefix}${key}`]);

  it("registers the media namespace with the same keys in every language", () => {
    expect(NAMESPACES).toContain("media");
    const zh = keysOf(resources[LangEnum.ZH].media).sort();
    // The page's own keys; later tasks add theirs to the same namespace.
    expect(zh).toEqual(expect.arrayContaining(["description", "title", "unsupported.body", "unsupported.title"]));
    for (const language of LANGUAGES) expect(keysOf(resources[language].media).sort(), language).toEqual(zh);
  });

  it("names the tile, the section and the bottom navigation entry in every language", () => {
    const keys = [
      "tools:fields.media_converter", "tools:field_desc.media_converter", "tools:chips.media_converter_tasks", "tools:chips.media_converter_local",
      "tools:catalog.media", "tools:catalog.media_description", "common:menu.media.converter", "media:title", "media:description",
      "media:unsupported.title", "media:unsupported.body",
    ];
    for (const language of LANGUAGES) {
      const t = i18n.getFixedT(language);
      for (const key of keys) {
        const [namespace, path] = key.split(":");
        // Its own entry, not the Chinese fallback.
        expect(i18n.getResource(language, namespace, path), `${language} ${key}`).toEqual(expect.any(String));
        expect(t(key), `${language} ${key}`).not.toBe(key);
      }
      // The bottom navigation shows what the page header says.
      expect(t(`common:${ToolNameMap[MEDIA_CONVERTER_ROUTE]}`)).toBe(t("media:title"));
      expect(t("tools:fields.media_converter")).toBe(t("media:title"));
    }
  });

  it("lists the tile and bottom navigation keys in the usage manifest, the only check of those calls", () => {
    const manifest = source("../../../../../scripts/i18n-usage-manifest.mjs");
    const entry = (selector: string) => manifest.split(`selector: "${selector}"`)[1]?.split("\n  },")[0] ?? "";
    expect(entry("src/pages/Tools/ToolTile.tsx#item.titleKey")).toContain('"tools:fields.media_converter"');
    expect(entry("src/pages/Tools/ToolTile.tsx#item.descKey")).toContain('"tools:field_desc.media_converter"');
    expect(entry("src/pages/Tools/ToolTile.tsx#chip")).toContain('"tools:chips.media_converter_tasks"');
    expect(entry("src/pages/Tools/ToolTile.tsx#chip")).toContain('"tools:chips.media_converter_local"');
    expect(entry("src/pages/components/BottomNavigation.tsx#currentToolName")).toContain('"common:menu.media.converter"');
  });
});
