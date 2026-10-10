import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import axios from "axios";

const electron = vi.hoisted(() => ({ windows: new Set<unknown>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: (contents: unknown) => electron.windows.has(contents) ? {} : null },
}));

import { WEB_LOOKUP_CHANNELS } from "../../src/web-lookup/contract";
import { assertPublicHost, isPrivateAddress, parsePublicUrl, WebLookupError } from "../../electron/main/web-lookup/guard";
import { htmlToText } from "../../electron/main/web-lookup/html";
import { bingTarget, parseBingResults } from "../../electron/main/web-lookup/sources";
import { publicOnlyLookup, WEB_MAX_BYTES, WebLookupService, type HttpGet } from "../../electron/main/web-lookup/service";
import { setupWebLookupIPC } from "../../electron/main/web-lookup";
import { assertLegacyWebLookupChannelAllowed, createWebLookupApi } from "../../electron/preload/web-lookup-api";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
type Reply = { status?: number; type?: string; body: string | Buffer; location?: string };
function server(routes: Record<string, Reply | ((url: URL) => Reply)>) {
  const requests: string[] = [];
  const get: HttpGet = async url => {
    requests.push(url);
    const parsed = new URL(url);
    const key = Object.keys(routes).find(prefix => url.startsWith(prefix));
    if (!key) return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("missing") };
    const route = routes[key];
    const reply = typeof route === "function" ? route(parsed) : route;
    return { status: reply.status ?? 200, headers: { "content-type": reply.type ?? "application/json; charset=utf-8", location: reply.location },
      body: Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body) };
  };
  return { get, requests };
}
const json = (value: unknown): Reply => ({ body: JSON.stringify(value) });

describe("web lookup address guard", () => {
  it("accepts only public http(s) URLs on default ports without credentials", () => {
    expect(parsePublicUrl("https://zh.wikipedia.org/wiki/A#top").href).toBe("https://zh.wikipedia.org/wiki/A");
    for (const raw of ["file:///etc/passwd", "ftp://example.com/", "https://user:pw@example.com/", "http://example.com:8080/"]) {
      expect(() => parsePublicUrl(raw)).toThrow(WebLookupError);
    }
    expect(() => parsePublicUrl("not a url")).toThrow("invalid_input");
  });

  it("treats loopback, private, link-local, mapped and reserved addresses as private", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "::ffff:7f00:1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "2002:7f00:1::", "2001:0:4136::1", "not-an-ip"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    // 198.18.0.0/15: what a proxy client in fake-IP mode answers for public names.
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::6810:85e5", "198.18.3.199"]) expect(isPrivateAddress(address), address).toBe(false);
  });

  it("refuses local names, private literals and names that resolve privately", async () => {
    const lookup = vi.fn(async (host: string) => host === "rebind.example" ? [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
    for (const raw of ["http://localhost/", "http://printer.local/", "http://127.0.0.1/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://rebind.example/"]) {
      await expect(assertPublicHost(parsePublicUrl(raw), lookup), raw).rejects.toThrow("web_lookup_blocked");
    }
    await expect(assertPublicHost(parsePublicUrl("https://example.com/"), lookup)).resolves.toBeUndefined();
  });

  it("pins direct connections to public answers", async () => {
    await expect(publicOnlyLookup(async () => [{ address: "192.168.0.2", family: 4 }])("example.com")).rejects.toThrow("web_lookup_blocked");
    await expect(publicOnlyLookup(async () => [{ address: "93.184.216.34", family: 4 }])("example.com")).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("makes axios connect only where the pinned lookup allows", async () => {
    const local = http.createServer((_, response) => response.end("reached")).listen(0, "127.0.0.1");
    await new Promise(resolve => local.once("listening", resolve));
    const url = `http://pinned.test:${(local.address() as { port: number }).port}/`;
    try {
      const refused = await axios.get(url, { proxy: false, lookup: publicOnlyLookup(async () => [{ address: "127.0.0.1", family: 4 }]) as never }).catch(error => error);
      expect(refused.cause).toBeInstanceOf(WebLookupError);
      // Control: the same request with an unpinned lookup does reach the local server.
      const reached = await axios.get(url, { proxy: false, lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as never });
      expect(reached.data).toBe("reached");
    } finally { local.close(); }
  });
});

describe("web lookup service", () => {
  it("searches Wikipedia in the chosen language and strips snippet markup", async () => {
    const { get, requests } = server({ "https://ja.wikipedia.org/w/api.php": json({ query: { search: [
      { title: "ゼンレスゾーンゼロ", snippet: "<span class=\"searchmatch\">ゼンレス</span>ゾーンゼロ&amp;は" }] } }) });
    const result = await new WebLookupService(get, publicDns).search({ source: "wikipedia", query: "ゼンレスゾーンゼロ", language: "ja" });
    expect(result).toEqual({ ok: true, value: { source: "wikipedia", query: "ゼンレスゾーンゼロ", results: [
      { title: "ゼンレスゾーンゼロ", url: "https://ja.wikipedia.org/wiki/%E3%82%BC%E3%83%B3%E3%83%AC%E3%82%B9%E3%82%BE%E3%83%BC%E3%83%B3%E3%82%BC%E3%83%AD", snippet: "ゼンレスゾーンゼロ&は" }] } });
    expect(requests[0]).toContain("list=search");
  });

  it("searches the Moegirlpedia mirror and a Bilibili game wiki, and reads their pages as text", async () => {
    const { get, requests } = server({
      "https://moegirl.uk/api.php?action=query&list=search": json({ query: { search: [{ title: "绝区零", snippet: "米哈游" }] } }),
      "https://moegirl.uk/api.php?action=query&prop=extracts": json({ query: { pages: { 1: { title: "绝区零", extract: "《绝区零》是米哈游开发的游戏。" } } } }),
      "https://wiki.biligame.com/zzz/api.php?action=query&list=search": json({ query: { search: [{ title: "泰姆菲尔德", snippet: "家族" }] } }),
      "https://wiki.biligame.com/zzz/api.php?action=parse": json({ parse: { title: "泰姆菲尔德", text: "<div><p>泰姆菲尔德家的大小姐<span class=\"mw-editsection\"><span>[</span>编辑]</span></span></p><script>x()</script></div>" } }),
    });
    const service = new WebLookupService(get, publicDns);
    const moegirl = await service.search({ source: "moegirl", query: "绝区零" });
    expect(moegirl.ok && moegirl.value.results[0].url).toBe("https://moegirl.uk/%E7%BB%9D%E5%8C%BA%E9%9B%B6");
    const page = await service.read({ url: "https://zh.moegirl.org.cn/绝区零" });
    expect(page.ok && page.value).toMatchObject({ title: "绝区零", site: "moegirl.uk", text: "《绝区零》是米哈游开发的游戏。", truncated: false });
    const bili = await service.search({ source: "biligame", game: "zzz", query: "泰姆菲尔德" });
    expect(bili.ok && bili.value.results[0].url).toBe("https://wiki.biligame.com/zzz/%E6%B3%B0%E5%A7%86%E8%8F%B2%E5%B0%94%E5%BE%B7");
    const biliPage = await service.read({ url: "https://wiki.biligame.com/zzz/泰姆菲尔德" });
    expect(biliPage.ok && biliPage.value.text).toBe("泰姆菲尔德家的大小姐");
    expect(requests.every(url => url.startsWith("https://moegirl.uk/") || url.startsWith("https://wiki.biligame.com/zzz/"))).toBe(true);
    expect(await service.search({ source: "biligame", query: "x" })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("reads Baidu Baike through its lemma card and reports a missing entry as no results", async () => {
    const { get } = server({ "https://baike.baidu.com/api/openapi/BaikeLemmaCardApi": url => url.searchParams.get("bk_key") === "绝区零"
      ? json({ key: "绝区零", title: "绝区零", desc: "米哈游开发的游戏", abstract: "《绝区零》是一款动作游戏。", card: [{ name: "开发商", value: ["上海米哈游"] }] })
      : json({}) });
    const service = new WebLookupService(get, publicDns);
    const found = await service.search({ source: "baidu_baike", query: "绝区零" });
    expect(found.ok && found.value.results).toEqual([{ title: "绝区零", url: "https://baike.baidu.com/item/%E7%BB%9D%E5%8C%BA%E9%9B%B6", snippet: "米哈游开发的游戏 — 《绝区零》是一款动作游戏。" }]);
    expect(await service.search({ source: "baidu_baike", query: "不存在的词条" })).toEqual({ ok: true, value: { source: "baidu_baike", query: "不存在的词条", results: [] } });
    const page = await service.read({ url: "https://baike.baidu.com/item/%E7%BB%9D%E5%8C%BA%E9%9B%B6" });
    expect(page.ok && page.value.text).toBe("米哈游开发的游戏\n《绝区零》是一款动作游戏。\n开发商：上海米哈游");
  });

  it("parses Bing organic results, unwraps click links and limits a search to one site", async () => {
    const wrapped = `https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${Buffer.from("https://zenless.hoyoverse.com/zh-cn/news").toString("base64url")}&amp;ntb=1`;
    const html = `<ol><li class="b_ad"><h2><a href="https://ads.example/">Ad</a></h2></li>
      <li class="b_algo" data-x="1"><h2><a href="${wrapped}">绝区零 · <strong>官网</strong></a></h2><div class="b_caption"><p>新艾利都的故事&nbsp;阅读更多</p></div></li>
      <li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=x">Images</a></h2></li>
      <li class="b_algo"><h2><a href="https://zh.wikipedia.org/wiki/x">Wiki</a></h2><p>摘要</p></li></ol>`;
    expect(parseBingResults(html, 5)).toEqual([
      { title: "绝区零 · 官网", url: "https://zenless.hoyoverse.com/zh-cn/news", snippet: "新艾利都的故事" },
      { title: "Wiki", url: "https://zh.wikipedia.org/wiki/x", snippet: "摘要" }]);
    expect(bingTarget("/search?q=1")).toBeUndefined();
    const { get, requests } = server({ "https://cn.bing.com/search": { type: "text/html; charset=utf-8", body: html } });
    const result = await new WebLookupService(get, publicDns).search({ source: "bing", query: "绝区零", site: "zenless.hoyoverse.com", limit: 1 });
    expect(result.ok && result.value.results).toHaveLength(1);
    expect(new URL(requests[0]).searchParams.get("q")).toBe("绝区零 site:zenless.hoyoverse.com");
  });

  it("reads a general page as its main text", async () => {
    const { get } = server({ "https://zenless.hoyoverse.com/": { type: "text/html", body: "<html><head><title>绝区零 官网</title><style>p{}</style></head><body><nav>菜单</nav><main><h1>新闻</h1><p>版本 &quot;2.0&quot; 上线</p></main><footer>版权</footer></body></html>" } });
    const page = await new WebLookupService(get, publicDns).read({ url: "https://zenless.hoyoverse.com/" });
    expect(page.ok && page.value).toMatchObject({ url: "https://zenless.hoyoverse.com/", title: "绝区零 官网", site: "zenless.hoyoverse.com", text: "新闻\n版本 \"2.0\" 上线" });
    expect(page.ok && Date.parse(page.value.accessedAt)).toBeGreaterThan(0);
  });

  it("asks the Chinese wikis for Simplified or Traditional text", async () => {
    const { get, requests } = server({
      "https://zh.wikipedia.org/w/api.php?action=query&list=search": json({ query: { search: [{ title: "米哈游", snippet: "" }] } }),
      "https://zh.wikipedia.org/w/api.php?action=query&prop=extracts": json({ query: { pages: { 1: { title: "米哈游", extract: "米哈游是电子游戏公司。" } } } }),
      "https://moegirl.uk/api.php": json({ query: { pages: { 1: { title: "绝区零", extract: "絕區零" } } } }),
    });
    const service = new WebLookupService(get, publicDns);
    const hans = await service.search({ source: "wikipedia", query: "米哈游", language: "zh" });
    expect(hans.ok && hans.value.results[0].url).toBe("https://zh.wikipedia.org/zh-cn/%E7%B1%B3%E5%93%88%E6%B8%B8");
    const hant = await service.search({ source: "wikipedia", query: "米哈游", language: "zh-Hant" });
    expect(hant.ok && hant.value.results[0].url).toBe("https://zh.wikipedia.org/zh-tw/%E7%B1%B3%E5%93%88%E6%B8%B8");
    expect(requests.map(url => new URL(url).searchParams.get("variant"))).toEqual(["zh-cn", "zh-tw"]);
    for (const [url, variant] of [["https://zh.wikipedia.org/wiki/米哈游", "zh-cn"], ["https://zh.wikipedia.org/zh-hk/米哈游", "zh-tw"], ["https://zh.wikipedia.org/wiki/米哈游?variant=zh-tw", "zh-tw"],
      ["https://moegirl.uk/zh-tw/绝区零", "zh-tw"], ["https://zh.moegirl.org.cn/绝区零", "zh-cn"]] as const) {
      const page = await service.read({ url });
      expect(page.ok, url).toBe(true);
      expect(new URL(requests.at(-1)!).searchParams.get("variant"), url).toBe(variant);
      expect(new URL(requests.at(-1)!).searchParams.get("titles"), url).toMatch(/^(米哈游|绝区零)$/);
    }
  });

  it("falls back to the description of a page drawn by scripts", async () => {
    const { get } = server({ "https://game.example/": { type: "text/html", body: "<html><head><title>官网</title><meta property=\"og:description\" content=\"新艾利都 &amp; 空洞\"></head><body><div id=\"app\"></div><script src=\"a.js\"></script></body></html>" } });
    const page = await new WebLookupService(get, publicDns).read({ url: "https://game.example/" });
    expect(page.ok && page.value).toMatchObject({ title: "官网", text: "新艾利都 & 空洞" });
  });

  it("truncates long text and says so", async () => {
    const { get } = server({ "https://en.wikipedia.org/w/api.php": json({ query: { pages: { 1: { title: "Long", extract: "x".repeat(9000) } } } }) });
    const page = await new WebLookupService(get, publicDns).read({ url: "https://en.wikipedia.org/wiki/Long" });
    expect(page.ok && page.value.truncated).toBe(true);
    expect(page.ok && page.value.text.length).toBe(8001);
  });

  it("never requests a private address, before or after a redirect", async () => {
    const { get, requests } = server({
      "https://example.com/hop": { status: 302, location: "http://127.0.0.1/admin", body: "" },
      "https://example.com/loop": { status: 301, location: "/loop", body: "" },
    });
    const service = new WebLookupService(get, publicDns);
    for (const url of ["http://127.0.0.1/", "http://localhost:80/", "http://192.168.1.1/", "file:///C:/Windows/win.ini", "ftp://example.com/"]) {
      expect(await service.read({ url }), url).toEqual({ ok: false, error: "web_lookup_blocked" });
    }
    expect(requests).toEqual([]);
    expect(await service.read({ url: "https://example.com/hop" })).toEqual({ ok: false, error: "web_lookup_blocked" });
    expect(requests).toEqual(["https://example.com/hop"]);
    expect(await service.read({ url: "https://example.com/loop" })).toEqual({ ok: false, error: "web_lookup_failed" });
    expect(requests.filter(url => url === "https://example.com/loop")).toHaveLength(4);
    const privateDns = new WebLookupService(get, async () => [{ address: "10.0.0.1", family: 4 }]);
    expect(await privateDns.read({ url: "https://intranet.example/" })).toEqual({ ok: false, error: "web_lookup_blocked" });
  });

  it("refuses oversized and non-text responses and maps HTTP failures to stable codes", async () => {
    const { get } = server({
      "https://example.com/big": { type: "text/html", body: Buffer.alloc(WEB_MAX_BYTES + 1, 97) },
      "https://example.com/file.zip": { type: "application/zip", body: "PK" },
      "https://example.com/error": { status: 503, type: "text/html", body: "down" },
      "https://example.com/bad-json": { body: "{" },
    });
    const service = new WebLookupService(get, publicDns);
    expect(await service.read({ url: "https://example.com/big" })).toEqual({ ok: false, error: "web_lookup_failed" });
    expect(await service.read({ url: "https://example.com/file.zip" })).toEqual({ ok: false, error: "web_lookup_failed" });
    expect(await service.read({ url: "https://example.com/error" })).toEqual({ ok: false, error: "web_lookup_failed" });
    expect(await service.read({ url: "https://example.com/missing" })).toEqual({ ok: false, error: "web_lookup_not_found" });
    const timeout = new WebLookupService(async () => { throw new WebLookupError("web_lookup_timeout"); }, publicDns);
    expect(await timeout.search({ source: "wikipedia", query: "x" })).toEqual({ ok: false, error: "web_lookup_timeout" });
    const broken = new WebLookupService(async () => { throw new Error("socket hang up"); }, publicDns);
    expect(await broken.search({ source: "wikipedia", query: "x" })).toEqual({ ok: false, error: "web_lookup_failed" });
    expect(await service.search({ source: "wikipedia", query: "" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await service.search({ source: "google", query: "x" })).toEqual({ ok: false, error: "invalid_input" });
    expect(await service.search({ source: "bing", query: "x", site: "http://evil/" })).toEqual({ ok: false, error: "invalid_input" });
  });

  it("drops scripts, navigation and edit links from HTML", () => {
    expect(htmlToText("<body><header>站点</header><article><h2>标题<span class=\"mw-editsection\"><span>[</span>编辑<span>]</span></span></h2><p>正文<sup class=\"reference\">[1]</sup></p><script>alert(1)</script></article></body>"))
      .toBe("标题\n正文");
  });
});

describe("web lookup bridge", () => {
  it("answers only the application's own main frames", async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const service = { search: vi.fn(async () => ({ ok: true })), read: vi.fn(async () => ({ ok: true })) };
    setupWebLookupIPC(service as never, { handle: (channel: string, handler: never) => { handlers.set(channel, handler); } } as never);
    const mainFrame = {};
    const sender = { mainFrame };
    electron.windows.add(sender);
    expect(await handlers.get(WEB_LOOKUP_CHANNELS.search)!({ sender, senderFrame: mainFrame }, { source: "wikipedia", query: "x" })).toEqual({ ok: true });
    expect(await handlers.get(WEB_LOOKUP_CHANNELS.read)!({ sender, senderFrame: {} }, { url: "https://example.com/" })).toEqual({ ok: false, error: "web_lookup_blocked" });
    const stranger = { mainFrame };
    expect(await handlers.get(WEB_LOOKUP_CHANNELS.read)!({ sender: stranger, senderFrame: mainFrame }, { url: "https://example.com/" })).toEqual({ ok: false, error: "web_lookup_blocked" });
    expect(service.read).not.toHaveBeenCalled();
  });

  it("exposes only the fixed methods and keeps the namespace off the generic bridge", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const api = createWebLookupApi({ invoke });
    expect(Object.keys(api).sort()).toEqual(["read", "search"]);
    await api.read({ url: "https://example.com/" });
    expect(invoke).toHaveBeenCalledWith(WEB_LOOKUP_CHANNELS.read, { url: "https://example.com/" });
    expect(() => assertLegacyWebLookupChannelAllowed("web-lookup:read")).toThrow();
    expect(() => assertLegacyWebLookupChannelAllowed("translate:start")).not.toThrow();
  });
});
