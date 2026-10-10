import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAgentStore from "@/store/agent/useAgentStore";
import { KnowledgeService, KnowledgeServiceError } from "../../electron/main/translation-knowledge/service";
import type { KnowledgeResult, LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
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
const setSession = (id: string) => useAgentStore.setState({ session: { ...useAgentStore.getState().session, id } });
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

  it("paginates matched entries, collections and recipes independently beyond the first page", async () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({ id: `entry-${index}`, revision: 1, title: `Match entry ${index}`, collectionId,
      state: "candidate", kind: "term", scope: { languagePair: pair }, payload: { source: "source", target: "target" } }));
    const collections = Array.from({ length: 4 }, (_, index) => ({ id: `collection-${index}`, name: `Match collection ${index}`, archived: false }));
    const recipes = Array.from({ length: 2 }, (_, index) => ({ id: `recipe-${index}`, name: `Match recipe ${index}`, archived: false, languagePair: pair }));
    knowledge.read.mockResolvedValue({ ok: true, value: { generation: 1, approvals: {}, data: { entries, subjects: [],
      collections: [...collections, { id: "archived", name: "Match archived", archived: true }, { id: "other", name: "Unrelated", archived: false }], recipes } } });
    const first = (await call("search_translation_knowledge", { query: "Match", limit: 2 })).data;
    const second = (await call("search_translation_knowledge", { query: "Match", limit: 2, offset: 2 })).data;
    const last = (await call("search_translation_knowledge", { query: "Match", limit: 2, offset: 4 })).data;
    expect(first.pagination).toMatchObject({ offset: 0, limit: 2,
      entries: { total: 3, hasMore: true, nextOffset: 2 }, collections: { total: 4, hasMore: true, nextOffset: 2 }, recipes: { total: 2, hasMore: false, nextOffset: null } });
    expect(second.pagination).toMatchObject({ offset: 2, limit: 2,
      entries: { total: 3, hasMore: false, nextOffset: null }, collections: { total: 4, hasMore: false, nextOffset: null }, recipes: { total: 2, hasMore: false, nextOffset: null } });
    for (const key of ["entries", "collections", "recipes"] as const) {
      const ids = [...first[key], ...second[key]].map((item: { id: string }) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(({ entries, collections, recipes })[key].map(item => item.id));
      expect(last[key]).toEqual([]);
    }
    expect(second.total).toBe(3); expect(second.offset).toBe(2);
  });

  it("returns bounded matched summaries and review state without raw library evidence", async () => {
    const entry = { id: documentId, revision: 2, title: "Test term", collectionId, state: "ready", kind: "term", scope: { languagePair: pair }, payload: { source: "source", target: "x".repeat(800) }, evidence: [{ sourceId: "private-evidence" }] };
    knowledge.read.mockResolvedValueOnce({ ok: true, value: { generation: 1, approvals: {}, data: { entries: [entry, entry], subjects: [], collections: [{ id: collectionId, name: "Test collection", archived: false }], recipes: [], sources: [{ excerpt: "PRIVATE RAW EVIDENCE" }] } } });
    const result = await call("search_translation_knowledge", { query: "Test", limit: 1 });
    expect(result.data.entries).toHaveLength(1); expect(result.data.entries[0].state).toBe("unconfirmed");
    expect(result.data.entries[0].summary.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE RAW EVIDENCE|private-evidence/);
  });

  function zzzLibrary() {
    const subjectId = randomUUID(), otherSubject = randomUUID(), otherCollection = randomUUID();
    const term = (id: string, source: string, target: string, collection = collectionId, extra: Record<string, unknown> = {}) => ({ id, revision: 1, title: source, collectionId: collection,
      aboutSubjectIds: [], state: "ready", kind: "term", scope: { languagePair: pair }, payload: { source, target, aliases: [], sense: "" }, ...extra });
    return { subjectId, otherSubject, value: { generation: 3, approvals: { "t-1": { revision: 1 } }, data: {
      subjects: [{ id: subjectId, kind: "work", name: "绝区零", aliases: ["ZZZ", "ゼンゼロ"], tags: [], archived: false },
        { id: otherSubject, kind: "work", name: "原神", aliases: [], tags: [], archived: false }],
      collections: [{ id: collectionId, name: "人物与称谓", description: "角色名", aboutSubjectIds: [subjectId], archived: false, defaultLanguagePair: pair },
        { id: otherCollection, name: "提瓦特", description: "", aboutSubjectIds: [otherSubject], archived: false, defaultLanguagePair: pair }],
      entries: [term("t-1", SOURCE, TARGET), term("t-2", "ホロウ", "空洞", collectionId, { state: "candidate", payload: { source: "ホロウ", target: "空洞", aliases: ["空洞（ホロウ）"], sense: "城市灾害" } }),
        term("t-3", "モンド", "蒙德", otherCollection)],
      recipes: [], sources: [] } } };
  }

  it("finds a work's collections and entries by its nickname", async () => {
    const { value, subjectId } = zzzLibrary();
    knowledge.read.mockResolvedValue({ ok: true, value });
    const result = (await call("search_translation_knowledge", { query: "ZZZ" })).data;
    expect(result.subjects).toEqual([expect.objectContaining({ id: subjectId, name: "绝区零", kind: "work" })]);
    expect(result.collections).toEqual([expect.objectContaining({ id: collectionId, name: "人物与称谓", entryCount: 2, subjects: ["绝区零"], languagePair: pair })]);
    expect(result.entries.map((entry: { id: string }) => entry.id)).toEqual(["t-1", "t-2"]);
    expect((await call("search_translation_knowledge", { query: "", subjectId })).data.entries.map((entry: { id: string }) => entry.id)).toEqual(["t-1", "t-2"]);
    expect((await call("search_translation_knowledge", { query: "城市灾害" })).data.entries.map((entry: { id: string }) => entry.id)).toEqual(["t-2"]);
    expect((await call("search_translation_knowledge", { query: "", state: "usable" })).data.entries.map((entry: { id: string }) => entry.id)).toEqual(["t-1"]);
    expect((await call("search_translation_knowledge", { query: "", state: "review" })).data.entries.map((entry: { id: string }) => entry.id)).toEqual(["t-2", "t-3"]);
  });

  it("requires every word of a multi-word query", async () => {
    const { value } = zzzLibrary();
    knowledge.read.mockResolvedValue({ ok: true, value });
    expect((await call("search_translation_knowledge", { query: "泰姆菲尔德 大小姐" })).data.entries.map((entry: { id: string }) => entry.id)).toEqual(["t-1"]);
    expect((await call("search_translation_knowledge", { query: "泰姆菲尔德 不存在" })).data.entries).toEqual([]);
  });

  it("lists the catalog with counts, language pairs and works, but no evidence", async () => {
    const { value } = zzzLibrary();
    (value.data.sources as unknown[]).push({ id: "s", excerpt: "PRIVATE EXCERPT" });
    knowledge.read.mockResolvedValue({ ok: true, value });
    const result = await call("list_translation_knowledge_catalog", { limit: 1 });
    expect(result.data.collections).toEqual([{ id: collectionId, name: "人物与称谓", description: "角色名", languagePair: pair, entryCount: 2, usableCount: 1, reviewCount: 1, subjects: ["绝区零"] }]);
    expect(result.data.pagination.collections).toEqual({ total: 2, hasMore: true, nextOffset: 1 });
    expect(result.data.subjects).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
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
    subjects: [{ ref: "zzz", name: "绝区零", kind: "work", aliases: ["ZZZ"] }],
    collections: [{ ref: "names", name: "绝区零 · 人物与称谓", subjects: [{ ref: "zzz" }] }],
    entries: [{ action: "create", collection: { ref: "names" }, kind: "term", source: SOURCE, target: TARGET, basis: "user_stated", evidence: "应该是泰姆菲尔德家的大小姐" }],
  };
  const action = (id: string) => usePreparedActionsStore.getState().actions.find(item => item.id === id)!;

  it("prepares a card without writing, even in automatic execution", async () => {
    const before = await service.read();
    for (const mode of ["queue_only", "auto_execute"] as const) {
      useAgentStore.setState({ executionMode: mode });
      const result = await call("prepare_knowledge_changes", proposal);
      expect(result).toMatchObject({ success: true, data: { executionStatus: "prepared", enabledByDefault: true,
        items: [{ status: "new", group: "subjects" }, { status: "new", group: "collections" }, { status: "new", group: "entries", kind: "term", label: `${SOURCE} → ${TARGET}`, collection: "绝区零 · 人物与称谓" }] } });
      expect(action(result.data.actionId)).toMatchObject({ status: "ready", requiresConfirmation: true, toolKey: "translationKnowledge", summaryKey: "home:prepared_knowledge_summary",
        knowledge: { adoptDefault: true, adoptable: 1, counts: { subjects: 1, collections: 1, created: 1 } } });
    }
    expect((await service.read()).generation).toBe(before.generation);
    expect(api.saveRecords).not.toHaveBeenCalled();
    // The second proposal replaced the first card.
    expect(usePreparedActionsStore.getState().actions.map(item => item.status)).toEqual(["dismissed", "ready"]);
  });

  it("refuses invalid proposals with reasons and reports already saved wording as unchanged", async () => {
    const invalid = await call("prepare_knowledge_changes", { entries: [{ action: "create", collection: { id: randomUUID() }, kind: "term", source: "a", target: "b", basis: "user_stated" }] });
    expect(invalid).toMatchObject({ success: false, error: "knowledge_proposal_invalid", data: { items: [{ status: "invalid", reason: "unknown_collection" }] } });
    expect(await call("prepare_knowledge_changes", { entries: [] })).toEqual({ success: false, error: "invalid_tool_arguments" });
    expect(usePreparedActionsStore.getState().actions).toEqual([]);
    const prepared = await call("prepare_knowledge_changes", proposal);
    await usePreparedActionsStore.getState().confirmAction(prepared.data.actionId);
    const library = await service.read();
    const again = await call("prepare_knowledge_changes", { entries: [{ action: "create", collection: { id: library.data.collections[0].id }, kind: "term", source: SOURCE, target: TARGET, basis: "user_stated" }] });
    expect(again).toMatchObject({ success: true, data: { executionStatus: "unchanged", items: [{ status: "exists" }] } });
  });

  it("saves everything once on confirmation, enabled or for review as chosen", async () => {
    const enabled = await call("prepare_knowledge_changes", proposal);
    await usePreparedActionsStore.getState().confirmAction(enabled.data.actionId);
    expect(action(enabled.data.actionId)).toMatchObject({ status: "completed", result: { executionStatus: "saved", adopted: 1, counts: { created: 1 } } });
    const saved = await service.read();
    expect(api.saveRecords).toHaveBeenCalledTimes(1);
    const entry = saved.data.entries[0];
    expect(entry).toMatchObject({ state: "ready", payload: { source: SOURCE, target: TARGET } });
    expect(saved.approvals[entry.id]).toMatchObject({ method: "human" });
    expect(saved.data.sources[0]).toMatchObject({ kind: "user_note", title: "home:knowledge_source_user_stated" });
    expect(action(enabled.data.actionId).result).toMatchObject({ focusCollectionId: saved.data.collections[0].id });
    expect(events.map(event => event.type)).toEqual([KNOWLEDGE_CHANGED_EVENT]);

    const review = await call("prepare_knowledge_changes", { entries: [{ action: "create", collection: { id: saved.data.collections[0].id }, kind: "term", source: "ホロウ", target: "空洞", basis: "agent_inferred" }] });
    expect(review.data.enabledByDefault).toBe(false);
    await usePreparedActionsStore.getState().confirmAction(review.data.actionId);
    const candidate = (await service.read()).data.entries.find(item => item.kind === "term" && item.payload.source === "ホロウ")!;
    expect(candidate.state).toBe("candidate");
    // The card's switch decides when the user turns it on.
    const chosen = await call("prepare_knowledge_changes", { entries: [{ action: "create", collection: { id: saved.data.collections[0].id }, kind: "term", source: "エーテル", target: "以太", basis: "agent_inferred" }] });
    await usePreparedActionsStore.getState().confirmAction(chosen.data.actionId, { adopt: true });
    const adopted = (await service.read()).data.entries.find(item => item.kind === "term" && item.payload.source === "エーテル")!;
    expect(adopted.state).toBe("ready");
  });

  it("fails without writing when an edited entry changed after preparation", async () => {
    const first = await call("prepare_knowledge_changes", proposal);
    await usePreparedActionsStore.getState().confirmAction(first.data.actionId);
    const library = await service.read();
    const entry = library.data.entries[0];
    const edit = await call("prepare_knowledge_changes", { entries: [{ action: "update", entryId: entry.id, revision: entry.revision, target: "泰姆菲尔德大小姐", basis: "user_stated" }] });
    // Someone edits the same entry first.
    await service.saveRecords({ generation: library.generation, items: [{ group: "entries", record: { ...entry, title: "changed elsewhere" } }] });
    const before = await service.read();
    await usePreparedActionsStore.getState().confirmAction(edit.data.actionId);
    expect(action(edit.data.actionId)).toMatchObject({ status: "failed", error: "knowledge_changed" });
    expect(await service.read()).toEqual(before);
  });

  it("saves after an unrelated change and treats a repeated save of the same records as done", async () => {
    const prepared = await call("prepare_knowledge_changes", proposal);
    const library = await service.read();
    await service.saveRecords({ generation: library.generation, items: [{ group: "subjects", record: { id: randomUUID(), revision: 1, archived: false, kind: "domain", name: "Other", aliases: [], tags: [], description: "" } }] });
    // A first attempt whose answer was lost: the records are already there.
    api.saveRecords.mockImplementationOnce(async (request: never) => { await service.saveRecords(request); return { ok: false, error: "write_failed" }; });
    await usePreparedActionsStore.getState().confirmAction(prepared.data.actionId);
    expect(action(prepared.data.actionId)).toMatchObject({ status: "failed", error: "write_failed" });
    // Asking again finds the work, collection and term already saved.
    const retry = await call("prepare_knowledge_changes", proposal);
    expect(retry).toMatchObject({ success: true, data: { executionStatus: "unchanged" } });
    expect(retry.data.items.map((item: { status: string }) => item.status)).toEqual(["exists", "exists", "exists"]);
    const after = await service.read();
    expect(after.data.entries).toHaveLength(1);
    expect(after.data.collections).toHaveLength(1);
  });

  it("leaves the library unchanged when dismissed", async () => {
    const before = await service.read();
    const prepared = await call("prepare_knowledge_changes", proposal);
    usePreparedActionsStore.getState().dismissAction(prepared.data.actionId);
    expect(action(prepared.data.actionId).status).toBe("dismissed");
    expect(await service.read()).toEqual(before);
  });
});
