import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAgentStore from "@/store/agent/useAgentStore";
import { useTestSession } from "@/store/agent/agent-store-test-utils";
import { KnowledgeService, KnowledgeServiceError } from "../../electron/main/translation-knowledge/service";
import type { KnowledgeResult } from "@/translation-knowledge/ipc-contract";
import { KNOWLEDGE_CHANGED_EVENT } from "@/translation-knowledge/library-events";
import { knowledgeAgentTools } from "./knowledge-tools";
import { usePreparedActionsStore } from "./prepared-actions";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const originalWindow = globalThis.window;
const collectionId = "00000000-0000-4000-8000-000000000002";
const documentId = "00000000-0000-4000-8000-000000000001";
const pair = { source: "ja", target: "zh-Hans" };
const SOURCE = "テイムフィールド家のお嬢様";
const TARGET = "泰姆菲尔德家的大小姐";
async function call(name: keyof typeof knowledgeAgentTools, args: unknown = {}): Promise<any> {
  const execute = knowledgeAgentTools[name].execute as (input: unknown, options: unknown) => Promise<unknown>;
  return execute(args, { toolCallId: "call-one", messages: [] });
}
/** A new session replaces (deletes) the previous one, which voids its authority. */
const setSession = (id: string) => useTestSession(id);
const events: Event[] = [];
function installWindow(api: Record<string, unknown>) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { translationKnowledge: api, dispatchEvent: (event: Event) => { events.push(event); return true; } } });
}
beforeEach(() => {
  vi.clearAllMocks(); events.length = 0;
  setSession(`reset-${Math.random()}`); usePreparedActionsStore.setState({ actions: [] }); setSession("knowledge-test");
  useAgentStore.setState({ executionMode: "queue_only" });
});
afterEach(() => { setSession(`cleanup-${Math.random()}`); Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("translation knowledge search", () => {
  const knowledge = { read: vi.fn() };
  beforeEach(() => installWindow(knowledge));
  const term = (id: string, source: string, target: string, collection = collectionId, extra: Record<string, unknown> = {}) => ({ id, revision: 1, collectionId: collection,
    enabled: true, kind: "term", payload: { source, target, aliases: [], note: "" }, ...extra });
  const ids = (items: { id: string }[]) => items.map(item => item.id);

  it("paginates matched entries, collections and presets independently beyond the first page", async () => {
    const entries = Array.from({ length: 3 }, (_, index) => term(`entry-${index}`, `Match source ${index}`, "target"));
    const collections = Array.from({ length: 4 }, (_, index) => ({ id: index ? `collection-${index}` : collectionId, name: `Match collection ${index}`, description: "", languagePair: pair, archived: false }));
    const presets = Array.from({ length: 2 }, (_, index) => ({ id: `preset-${index}`, name: `Match preset ${index}`, languagePair: pair, collectionIds: [collectionId], instructions: "", context: "" }));
    knowledge.read.mockResolvedValue({ ok: true, value: { generation: 1, data: { entries, presets,
      collections: [...collections, { id: "archived", name: "Match archived", description: "", languagePair: pair, archived: true }, { id: "other", name: "Unrelated", description: "", languagePair: pair, archived: false }] } } });
    const first = (await call("search_translation_knowledge", { query: "Match", limit: 2 })).data;
    const second = (await call("search_translation_knowledge", { query: "Match", limit: 2, offset: 2 })).data;
    const last = (await call("search_translation_knowledge", { query: "Match", limit: 2, offset: 4 })).data;
    expect(first.pagination).toMatchObject({ offset: 0, limit: 2,
      entries: { total: 3, hasMore: true, nextOffset: 2 }, collections: { total: 4, hasMore: true, nextOffset: 2 }, presets: { total: 2, hasMore: false, nextOffset: null } });
    expect(second.pagination).toMatchObject({ offset: 2, limit: 2,
      entries: { total: 3, hasMore: false, nextOffset: null }, collections: { total: 4, hasMore: false, nextOffset: null }, presets: { total: 2, hasMore: false, nextOffset: null } });
    for (const key of ["entries", "collections", "presets"] as const) {
      const found = ids([...first[key], ...second[key]]);
      expect(new Set(found).size).toBe(found.length);
      expect(found).toEqual(ids(({ entries, collections, presets })[key]));
      expect(last[key]).toEqual([]);
    }
    expect(second.total).toBe(3); expect(second.offset).toBe(2);
  });

  it("returns bounded summaries with the entry's collection and enabled state", async () => {
    const entry = term(documentId, "Test source", "x".repeat(800), collectionId, { revision: 2, enabled: false });
    knowledge.read.mockResolvedValueOnce({ ok: true, value: { generation: 1, data: { entries: [entry, entry], presets: [],
      collections: [{ id: collectionId, name: "Test collection", description: "", languagePair: pair, archived: false }] } } });
    const result = await call("search_translation_knowledge", { query: "Test", limit: 1 });
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0]).toMatchObject({ id: documentId, revision: 2, enabled: false, collection: "Test collection" });
    expect(result.data.entries[0].summary.length).toBeLessThanOrEqual(400);
  });

  function zzzLibrary() {
    const otherCollection = randomUUID(), english = randomUUID();
    return { otherCollection, value: { generation: 3, data: {
      collections: [{ id: collectionId, name: "绝区零", description: "ZZZ · ゼンゼロ 角色名", archived: false, languagePair: pair },
        { id: otherCollection, name: "原神", description: "", archived: false, languagePair: pair },
        { id: english, name: "Zenless Zone Zero", description: "ZZZ", archived: false, languagePair: { source: "en", target: "zh-Hans" } }],
      entries: [term("t-1", SOURCE, TARGET), term("t-2", "ホロウ", "空洞", collectionId, { enabled: false, payload: { source: "ホロウ", target: "空洞", aliases: ["空洞（ホロウ）"], note: "城市灾害" } }),
        term("t-3", "モンド", "蒙德", otherCollection), { id: "t-4", revision: 1, collectionId, enabled: true, kind: "rule", payload: { text: "称呼保留敬称", required: false } }],
      presets: [{ id: "p-1", name: "绝区零全套", languagePair: pair, collectionIds: [collectionId, otherCollection], instructions: "", context: "" }] } } };
  }

  it("finds a work's collection and entries by its name or nickname", async () => {
    const { value, otherCollection } = zzzLibrary();
    knowledge.read.mockResolvedValue({ ok: true, value });
    const result = (await call("search_translation_knowledge", { query: "ZZZ", languagePair: { source: "ja" } })).data;
    expect(result.collections).toEqual([expect.objectContaining({ id: collectionId, name: "绝区零", entryCount: 3, languagePair: pair })]);
    expect(ids(result.entries)).toEqual(["t-1", "t-2", "t-4"]);
    // An entry carries its collection's name, so a work's name narrows a wording search.
    expect(ids((await call("search_translation_knowledge", { query: "绝区零 大小姐" })).data.entries)).toEqual(["t-1"]);
    expect(ids((await call("search_translation_knowledge", { query: "城市灾害" })).data.entries)).toEqual(["t-2"]);
    expect(ids((await call("search_translation_knowledge", { query: "敬称", kind: "rule" })).data.entries)).toEqual(["t-4"]);
    expect(ids((await call("search_translation_knowledge", { query: "", enabled: "disabled" })).data.entries)).toEqual(["t-2"]);
    expect((await call("search_translation_knowledge", { query: "全套" })).data.presets).toEqual([expect.objectContaining({ id: "p-1", collectionIds: [collectionId, otherCollection] })]);
  });

  it("requires every word of a multi-word query", async () => {
    const { value } = zzzLibrary();
    knowledge.read.mockResolvedValue({ ok: true, value });
    expect(ids((await call("search_translation_knowledge", { query: "泰姆菲尔德 大小姐" })).data.entries)).toEqual(["t-1"]);
    expect((await call("search_translation_knowledge", { query: "泰姆菲尔德 不存在" })).data.entries).toEqual([]);
  });

  it("lists the catalog with language pairs, counts and presets", async () => {
    const { value, otherCollection } = zzzLibrary();
    knowledge.read.mockResolvedValue({ ok: true, value });
    const result = await call("list_translation_knowledge_catalog", { limit: 1 });
    expect(result.data.collections).toEqual([{ id: collectionId, name: "绝区零", description: "ZZZ · ゼンゼロ 角色名", languagePair: pair, entryCount: 3, enabledCount: 2 }]);
    expect(result.data.pagination.collections).toEqual({ total: 3, hasMore: true, nextOffset: 1 });
    expect(result.data.presets).toEqual([{ id: "p-1", name: "绝区零全套", languagePair: pair, collectionIds: [collectionId, otherCollection], collections: ["绝区零", "原神"] }]);
  });

  it("tells the model what was wrong with its arguments", async () => {
    const result = await call("prepare_knowledge_changes", { subjects: [{ ref: "zzz", name: "绝区零", kind: "work" }], entries: [] });
    expect(result).toMatchObject({ success: false, error: "invalid_tool_arguments" });
    expect(result.data.issues.join(" ")).toContain("a collection is the work itself");
    expect((await call("search_translation_knowledge", { state: "review" })).data.issues[0]).toMatch(/state/);
    expect(knowledge.read).not.toHaveBeenCalled();
  });

  it("reports an unavailable library with a stable code", async () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    expect(await call("list_translation_knowledge_catalog")).toEqual({ success: false, error: "translation_knowledge_unavailable" });
    installWindow({ read: vi.fn().mockResolvedValue({ ok: false, error: "storage_unavailable" }) });
    expect(await call("search_translation_knowledge", { query: "x" })).toEqual({ success: false, error: "storage_unavailable" });
  });
});

describe("prepared translation knowledge changes", () => {
  const roots: string[] = [];
  let service: KnowledgeService;
  const wrap = async <T,>(operation: () => Promise<T>): Promise<KnowledgeResult<T>> => {
    try { return { ok: true, value: await operation() }; }
    catch (error) { if (error instanceof KnowledgeServiceError) return { ok: false, error: error.code, diagnostics: error.diagnostics }; throw error; }
  };
  const api = { read: vi.fn(() => wrap(() => service.read())), saveRecords: vi.fn((request: never) => wrap(() => service.saveRecords(request))) };
  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fk-agent-knowledge-")); roots.push(root);
    service = new KnowledgeService(root);
    installWindow(api);
  });
  afterEach(async () => { await service.dispose(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  const proposal = {
    languagePair: pair,
    collections: [{ ref: "zzz", name: "绝区零" }],
    entries: [{ action: "create", collection: { ref: "zzz" }, kind: "term", source: SOURCE, target: TARGET, basis: "user_stated", evidence: "应该是泰姆菲尔德家的大小姐" }],
  };
  const action = (id: string) => usePreparedActionsStore.getState().actions.find(item => item.id === id)!;

  it("prepares a card without writing, even in automatic execution", async () => {
    const before = await service.read();
    for (const mode of ["queue_only", "auto_execute"] as const) {
      useAgentStore.setState({ executionMode: mode });
      const result = await call("prepare_knowledge_changes", proposal);
      expect(result).toMatchObject({ success: true, data: { executionStatus: "prepared",
        items: [{ status: "new", group: "collections" }, { status: "new", group: "entries", kind: "term", label: `${SOURCE} → ${TARGET}`, collection: "绝区零" }] } });
      expect(action(result.data.actionId)).toMatchObject({ status: "ready", requiresConfirmation: true, toolKey: "translationKnowledge", summaryKey: "home:prepared_knowledge_summary",
        knowledge: { counts: { collections: 1, created: 1 } } });
    }
    expect((await service.read()).generation).toBe(before.generation);
    expect(api.saveRecords).not.toHaveBeenCalled();
    // The second proposal replaced the first card.
    expect(usePreparedActionsStore.getState().actions.map(item => item.status)).toEqual(["dismissed", "ready"]);
  });

  it("refuses invalid proposals with reasons and reports already saved wording as unchanged", async () => {
    const invalid = await call("prepare_knowledge_changes", { entries: [{ action: "create", collection: { id: randomUUID() }, kind: "term", source: "a", target: "b", basis: "user_stated" }] });
    expect(invalid).toMatchObject({ success: false, error: "knowledge_proposal_invalid", data: { items: [{ status: "invalid", reason: "unknown_collection" }] } });
    expect(await call("prepare_knowledge_changes", { entries: [] })).toMatchObject({ success: false, error: "invalid_tool_arguments" });
    expect(usePreparedActionsStore.getState().actions).toEqual([]);
    const prepared = await call("prepare_knowledge_changes", proposal);
    await usePreparedActionsStore.getState().confirmAction(prepared.data.actionId);
    const library = await service.read();
    const again = await call("prepare_knowledge_changes", { entries: [{ action: "create", collection: { id: library.data.collections[0].id }, kind: "term", source: SOURCE, target: TARGET, basis: "user_stated" }] });
    expect(again).toMatchObject({ success: true, data: { executionStatus: "unchanged", items: [{ status: "exists" }] } });
  });

  it("saves everything once on confirmation, enabled at once", async () => {
    const prepared = await call("prepare_knowledge_changes", proposal);
    await usePreparedActionsStore.getState().confirmAction(prepared.data.actionId);
    expect(action(prepared.data.actionId)).toMatchObject({ status: "completed", result: { executionStatus: "saved", counts: { collections: 1, created: 1 } } });
    const saved = await service.read();
    expect(api.saveRecords).toHaveBeenCalledTimes(1);
    expect(saved.data.collections[0]).toMatchObject({ name: "绝区零", languagePair: pair });
    expect(saved.data.entries[0]).toMatchObject({ enabled: true, origin: { kind: "manual", note: "应该是泰姆菲尔德家的大小姐" }, payload: { source: SOURCE, target: TARGET } });
    expect(action(prepared.data.actionId).result).toMatchObject({ focusCollectionId: saved.data.collections[0].id });
    expect(events.map(event => event.type)).toEqual([KNOWLEDGE_CHANGED_EVENT]);

    // An inferred wording is marked as such on the card, and is enabled like any confirmed entry.
    const inferred = await call("prepare_knowledge_changes", { entries: [{ action: "create", collection: { id: saved.data.collections[0].id }, kind: "term", source: "ホロウ", target: "空洞", basis: "agent_inferred" }] });
    expect(action(inferred.data.actionId).knowledge!.items[0]).toMatchObject({ aiSourced: true, basis: "agent_inferred" });
    await usePreparedActionsStore.getState().confirmAction(inferred.data.actionId);
    const entry = (await service.read()).data.entries.find(item => item.kind === "term" && item.payload.source === "ホロウ")!;
    expect(entry).toMatchObject({ enabled: true, origin: { kind: "agent" } });

    // Disabling goes through the same card.
    const library = await service.read();
    const disable = await call("prepare_knowledge_changes", { entries: [{ action: "disable", entryId: entry.id, revision: entry.revision, basis: "user_stated" }] });
    expect(disable.data.items).toEqual([expect.objectContaining({ status: "disable" })]);
    await usePreparedActionsStore.getState().confirmAction(disable.data.actionId);
    const after = await service.read();
    expect(after.data.entries.find(item => item.id === entry.id)).toMatchObject({ enabled: false, revision: entry.revision + 1 });
    expect(after.generation).toBe(library.generation + 1);
  });

  it("fails without writing when an edited entry changed after preparation", async () => {
    const first = await call("prepare_knowledge_changes", proposal);
    await usePreparedActionsStore.getState().confirmAction(first.data.actionId);
    const library = await service.read();
    const entry = library.data.entries[0];
    const edit = await call("prepare_knowledge_changes", { entries: [{ action: "update", entryId: entry.id, revision: entry.revision, target: "泰姆菲尔德大小姐", basis: "user_stated" }] });
    // Someone edits the same entry first.
    await service.saveRecords({ generation: library.generation, items: [{ group: "entries", record: { ...entry, enabled: false } }] });
    const before = await service.read();
    await usePreparedActionsStore.getState().confirmAction(edit.data.actionId);
    expect(action(edit.data.actionId)).toMatchObject({ status: "failed", error: "knowledge_changed" });
    expect(await service.read()).toEqual(before);
  });

  it("saves after an unrelated change and treats a repeated save of the same records as done", async () => {
    const prepared = await call("prepare_knowledge_changes", proposal);
    const library = await service.read();
    await service.saveRecords({ generation: library.generation, items: [{ group: "collections", record: { id: randomUUID(), revision: 1, archived: false, name: "Other", description: "", languagePair: pair } }] });
    // A first attempt whose answer was lost: the records are already there.
    api.saveRecords.mockImplementationOnce(async (request: never) => { await service.saveRecords(request); return { ok: false, error: "write_failed" }; });
    await usePreparedActionsStore.getState().confirmAction(prepared.data.actionId);
    expect(action(prepared.data.actionId)).toMatchObject({ status: "failed", error: "write_failed" });
    // Asking again finds the collection and term already saved.
    const retry = await call("prepare_knowledge_changes", proposal);
    expect(retry).toMatchObject({ success: true, data: { executionStatus: "unchanged" } });
    expect(retry.data.items.map((item: { status: string }) => item.status)).toEqual(["exists", "exists"]);
    const after = await service.read();
    expect(after.data.entries).toHaveLength(1);
    expect(after.data.collections.map(item => item.name).sort()).toEqual(["Other", "绝区零"]);
  });

  it("leaves the library unchanged when dismissed", async () => {
    const before = await service.read();
    const prepared = await call("prepare_knowledge_changes", proposal);
    usePreparedActionsStore.getState().dismissAction(prepared.data.actionId);
    expect(action(prepared.data.actionId).status).toBe("dismissed");
    expect(await service.read()).toEqual(before);
  });
});
