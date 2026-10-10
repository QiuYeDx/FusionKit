import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: { fromWebContents: () => null } }));

import { WebLookupService } from "../../electron/main/web-lookup/service";

/**
 * Read-only requests to the real sources, through the production fetch path (proxy settings, guard,
 * limits). Run by hand when a source may have changed: FUSIONKIT_WEB_LIVE=1. Never part of CI.
 */
describe.skipIf(!process.env.FUSIONKIT_WEB_LIVE)("web lookup against the live sources", () => {
  const service = new WebLookupService();
  const search = async (request: Parameters<WebLookupService["search"]>[0]) => {
    const result = await service.search(request);
    if (!result.ok) throw new Error(`${JSON.stringify(request)} → ${result.error}`);
    console.info(`[live] ${request.source}: ${result.value.results.map(hit => `${hit.title} <${hit.url}>`).slice(0, 3).join(" | ")}`);
    return result.value.results;
  };
  const read = async (url: string) => {
    const result = await service.read({ url });
    if (!result.ok) throw new Error(`${url} → ${result.error}`);
    console.info(`[live] read ${result.value.site}: ${result.value.title} (${result.value.text.length} chars${result.value.truncated ? ", truncated" : ""})`);
    return result.value;
  };

  it("Wikipedia in Chinese and Japanese", async () => {
    const zh = await search({ source: "wikipedia", query: "绝区零", language: "zh" });
    expect(zh.some(hit => hit.url.startsWith("https://zh.wikipedia.org/zh-cn/"))).toBe(true);
    const page = await read(zh[0].url);
    expect(page.text.length).toBeGreaterThan(200);
    // Converted to Simplified: the article's Traditional spellings are gone.
    expect(page.text).not.toMatch(/遊戲|開發/);
    expect((await search({ source: "wikipedia", query: "ゼンレスゾーンゼロ", language: "ja" })).length).toBeGreaterThan(0);
  }, 60_000);

  it("Moegirlpedia through its mirror", async () => {
    const hits = await search({ source: "moegirl", query: "绝区零" });
    expect(hits[0].url).toMatch(/^https:\/\/moegirl\.uk\//);
    expect((await read(hits[0].url)).text.length).toBeGreaterThan(100);
  }, 60_000);

  it("Baidu Baike lemma card", async () => {
    const hits = await search({ source: "baidu_baike", query: "绝区零" });
    expect(hits[0].url).toMatch(/^https:\/\/baike\.baidu\.com\/item\//);
    expect((await read(hits[0].url)).text).toContain("绝区零");
  }, 60_000);

  it("Bilibili game wiki", async () => {
    const hits = await search({ source: "biligame", game: "zzz", query: "艾莲" });
    expect(hits[0].url).toMatch(/^https:\/\/wiki\.biligame\.com\/zzz\//);
    expect((await read(hits[0].url)).text.length).toBeGreaterThan(50);
  }, 60_000);

  it("Bing, limited to an official site, and a general page", async () => {
    const hits = await search({ source: "bing", query: "绝区零", site: "zenless.hoyoverse.com" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(hit => !/bing\.com/.test(new URL(hit.url).hostname))).toBe(true);
    const page = await service.read({ url: "https://zenless.hoyoverse.com/" });
    console.info(`[live] official site: ${page.ok ? `${page.value.title} (${page.value.text.length} chars)` : page.error}`);
  }, 60_000);
});
