import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAgentStore from "@/store/agent/useAgentStore";
import useWebLookupStore, { DEFAULT_WEB_LOOKUP_SETTINGS, parseBiligameWikis, sanitizeWebLookupSettings } from "@/store/useWebLookupStore";
import { KnowledgeService, KnowledgeServiceError } from "../../electron/main/translation-knowledge/service";
import type { KnowledgeResult } from "@/translation-knowledge/ipc-contract";
import { knowledgeAgentTools } from "./knowledge-tools";
import { usePreparedActionsStore } from "./prepared-actions";
import { resetWebPagesForTest, webAgentTools } from "./web-tools";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const originalWindow = globalThis.window;
const tools = { ...webAgentTools, ...knowledgeAgentTools };
async function call(name: keyof typeof tools, args: unknown = {}): Promise<any> {
  const execute = tools[name].execute as (input: unknown, options: unknown) => Promise<unknown>;
  return execute(args, { toolCallId: "call-web", messages: [] });
}
const setSession = (id: string) => useAgentStore.setState({ session: { ...useAgentStore.getState().session, id } });
const webLookup = { search: vi.fn(), read: vi.fn() };
function installWindow(extra: Record<string, unknown> = {}) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { webLookup, dispatchEvent: () => true, ...extra } });
}
const PAGE = { url: "https://wiki.biligame.com/zzz/%E6%B3%B0%E5%A7%86%E8%8F%B2%E5%B0%94%E5%BE%B7", title: "泰姆菲尔德", site: "wiki.biligame.com/zzz",
  text: "テイムフィールド家のお嬢様，中文译名为泰姆菲尔德家的大小姐。", truncated: false, accessedAt: "2026-10-10T08:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks(); resetWebPagesForTest();
  useWebLookupStore.setState({ ...structuredClone(DEFAULT_WEB_LOOKUP_SETTINGS) });
  setSession(`reset-${Math.random()}`); usePreparedActionsStore.setState({ actions: [] }); setSession("web-test");
  useAgentStore.setState({ executionMode: "queue_only" });
  installWindow();
});
afterEach(() => { setSession(`cleanup-${Math.random()}`); Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("web lookup settings", () => {
  it("is off by default and every source starts on", () => {
    expect(DEFAULT_WEB_LOOKUP_SETTINGS).toEqual({ enabled: false, biligameWikis: [],
      sources: { wikipedia: true, moegirl: true, baidu_baike: true, biligame: true, bing: true } });
  });

  it("parses wiki codes and names the invalid ones", () => {
    expect(parseBiligameWikis(" ZZZ, sr，ys  zzz")).toEqual({ codes: ["zzz", "sr", "ys"], invalid: [] });
    expect(parseBiligameWikis("zzz, wiki.biligame.com/sr, -x")).toEqual({ codes: ["zzz"], invalid: ["wiki.biligame.com/sr", "-x"] });
  });

  it("keeps only valid persisted values", () => {
    expect(sanitizeWebLookupSettings({ enabled: true, sources: { wikipedia: false, bing: "yes" } as never, biligameWikis: ["zzz", "BAD CODE", 3, ...Array.from({ length: 12 }, (_, i) => `w${i}`)] as never }))
      .toEqual({ enabled: true, biligameWikis: ["zzz", ...Array.from({ length: 9 }, (_, i) => `w${i}`)], sources: { wikipedia: false, moegirl: true, baidu_baike: true, biligame: true, bing: true } });
    expect(sanitizeWebLookupSettings(undefined)).toEqual(DEFAULT_WEB_LOOKUP_SETTINGS);
    expect(sanitizeWebLookupSettings({ enabled: "true" as never }).enabled).toBe(false);
  });
});

describe("web lookup tools", () => {
  it("refuse while web lookups are off, without asking the main process", async () => {
    expect(await call("web_search", { query: "绝区零", source: "wikipedia" })).toMatchObject({ success: false, error: "web_lookup_disabled", data: { nextAction: expect.stringContaining("Settings → Agent") } });
    expect(await call("web_read", { url: "https://zh.wikipedia.org/wiki/绝区零" })).toMatchObject({ success: false, error: "web_lookup_disabled" });
    expect(webLookup.search).not.toHaveBeenCalled();
    expect(webLookup.read).not.toHaveBeenCalled();
  });

  it("respect turned-off sources and the configured Bilibili wiki", async () => {
    useWebLookupStore.setState({ enabled: true, sources: { ...DEFAULT_WEB_LOOKUP_SETTINGS.sources, moegirl: false } });
    expect(await call("web_search", { query: "绝区零", source: "moegirl" })).toMatchObject({ success: false, error: "web_source_disabled",
      data: { enabledSources: ["wikipedia", "baidu_baike", "biligame", "bing"] } });
    expect(await call("web_read", { url: "https://moegirl.uk/绝区零" })).toMatchObject({ success: false, error: "web_source_disabled" });
    expect(await call("web_search", { query: "泰姆菲尔德", source: "biligame" })).toMatchObject({ success: false, error: "web_source_unconfigured" });
    expect(webLookup.search).not.toHaveBeenCalled();

    useWebLookupStore.setState({ biligameWikis: ["zzz", "sr"] });
    webLookup.search.mockResolvedValue({ ok: true, value: { source: "biligame", query: "泰姆菲尔德", results: [{ title: "泰姆菲尔德", url: PAGE.url, snippet: "家族" }] } });
    const found = await call("web_search", { query: "泰姆菲尔德", source: "biligame" });
    expect(webLookup.search).toHaveBeenCalledWith({ source: "biligame", query: "泰姆菲尔德", language: "zh", limit: 5, game: "zzz" });
    expect(found).toMatchObject({ success: true, data: { sourceName: "Bilibili game wiki", game: "zzz", results: [{ title: "泰姆菲尔德", url: PAGE.url }] } });
  });

  it("limits a Bing search to the given site and reports lookup failures with stable codes", async () => {
    useWebLookupStore.setState({ enabled: true });
    webLookup.search.mockResolvedValue({ ok: false, error: "web_lookup_timeout" });
    expect(await call("web_search", { query: "绝区零", source: "bing", site: "https://zenless.hoyoverse.com/zh-cn" })).toMatchObject({ success: false, error: "web_lookup_timeout" });
    expect(webLookup.search).toHaveBeenCalledWith(expect.objectContaining({ source: "bing", site: "zenless.hoyoverse.com" }));
    expect(await call("web_read", { url: "file:///C:/secret.txt" })).toMatchObject({ success: false, error: "web_lookup_blocked" });
    expect(webLookup.read).not.toHaveBeenCalled();
    expect(await call("web_search", { query: "x", source: "google" })).toEqual({ success: false, error: "invalid_tool_arguments" });
  });

  it("returns bounded page text", async () => {
    useWebLookupStore.setState({ enabled: true });
    webLookup.read.mockResolvedValue({ ok: true, value: { ...PAGE, text: "y".repeat(20000), truncated: true } });
    const page = await call("web_read", { url: PAGE.url });
    expect(page).toMatchObject({ success: true, data: { url: PAGE.url, title: PAGE.title, site: PAGE.site, accessedAt: PAGE.accessedAt, truncated: true } });
    expect(page.data.text.length).toBeLessThanOrEqual(8001);
  });
});

describe("web-sourced translation materials", () => {
  const roots: string[] = [];
  let service: KnowledgeService;
  const wrap = async <T,>(operation: () => Promise<T>): Promise<KnowledgeResult<T>> => {
    try { return { ok: true, value: await operation() }; }
    catch (error) { if (error instanceof KnowledgeServiceError) return { ok: false, error: error.code, diagnostics: error.diagnostics }; throw error; }
  };
  const knowledge = { read: vi.fn(() => wrap(() => service.read())), saveRecords: vi.fn((request: never) => wrap(() => service.saveRecords(request))) };
  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fk-agent-web-")); roots.push(root);
    service = new KnowledgeService(root);
    installWindow({ translationKnowledge: knowledge });
    useWebLookupStore.setState({ enabled: true, biligameWikis: ["zzz"] });
  });
  afterEach(async () => { await service.dispose(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  const entry = { action: "create", collection: { ref: "names" }, kind: "term", source: "テイムフィールド家のお嬢様", target: "泰姆菲尔德家的大小姐",
    basis: "web", url: PAGE.url, evidence: "中文译名为泰姆菲尔德家的大小姐" };
  const proposal = (entries: unknown[]) => ({ languagePair: { source: "ja", target: "zh-Hans" },
    subjects: [{ ref: "zzz", name: "绝区零", kind: "work" }], collections: [{ ref: "names", name: "绝区零 · 人物", subjects: [{ ref: "zzz" }] }], entries });

  it("saves an entry read on a page with that page as its evidence, for review", async () => {
    webLookup.read.mockResolvedValue({ ok: true, value: PAGE });
    await call("web_read", { url: PAGE.url });
    const prepared = await call("prepare_knowledge_changes", proposal([entry]));
    expect(prepared).toMatchObject({ success: true, data: { executionStatus: "prepared", enabledByDefault: false,
      items: [{}, {}, { status: "new", group: "entries", site: "wiki.biligame.com" }] } });
    const action = usePreparedActionsStore.getState().actions.find(item => item.id === prepared.data.actionId)!;
    expect(action.knowledge!.items[2]).toMatchObject({ basis: "web", sourceSite: "wiki.biligame.com" });
    await usePreparedActionsStore.getState().confirmAction(prepared.data.actionId);
    const library = await service.read();
    const saved = library.data.entries[0];
    expect(saved.state).toBe("candidate");
    expect(library.approvals[saved.id]).toBeUndefined();
    expect(library.data.sources[0]).toMatchObject({ kind: "web", url: PAGE.url, title: "泰姆菲尔德", accessedAt: PAGE.accessedAt, excerpt: "中文译名为泰姆菲尔德家的大小姐" });
    expect(saved.evidence).toEqual([{ sourceId: library.data.sources[0].id, support: "direct" }]);
  });

  it("needs the link of a page the assistant read", async () => {
    const missing = await call("prepare_knowledge_changes", proposal([{ ...entry, url: undefined }]));
    expect(missing).toMatchObject({ success: false, error: "knowledge_proposal_invalid", data: { items: [{}, {}, { status: "invalid", reason: "missing_url" }] } });
    // Seen only in search results: read it first.
    const unread = await call("prepare_knowledge_changes", proposal([{ ...entry, url: "https://zh.moegirl.org.cn/泰姆菲尔德", urlTitle: "泰姆菲尔德 - 萌娘百科" }]));
    expect(unread).toMatchObject({ success: false, error: "knowledge_proposal_invalid", data: { items: [{}, {}, { status: "invalid", reason: "page_not_read", site: "zh.moegirl.org.cn" }] } });
    expect(usePreparedActionsStore.getState().actions).toEqual([]);
    expect(knowledge.saveRecords).not.toHaveBeenCalled();
  });
});
