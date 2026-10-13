import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeService, KnowledgeServiceError } from "../../../../electron/main/translation-knowledge/service";
import type { KnowledgeResult } from "@/translation-knowledge/ipc-contract";
import { setAgentNavigator } from "@/agent/navigation-tools";
import { usePageContextStore } from "@/agent/page-context";
import { EXTERNAL_TOOLS } from "../catalog";
import { resetExternalConfirmations, useExternalConfirmationsStore } from "../confirmations";
import { useExternalAgentStore } from "../store";
import { listTranslationKnowledgeCatalog, prepareKnowledgeChanges, searchTranslationKnowledge } from "./knowledge";
import { openFusionkitPage } from "./navigation";
import { getStudioTasks } from "./tasks";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key, resolvedLanguage: "zh", language: "zh" } }));

const originalWindow = globalThis.window;
const roots: string[] = [];
let service: KnowledgeService;
const wrap = async <T,>(operation: () => Promise<T>): Promise<KnowledgeResult<T>> => {
  try { return { ok: true, value: await operation() }; }
  catch (error) { if (error instanceof KnowledgeServiceError) return { ok: false, error: error.code, diagnostics: error.diagnostics }; throw error; }
};
const knowledge = { read: vi.fn(() => wrap(() => service.read())), saveRecords: vi.fn((request: never) => wrap(() => service.saveRecords(request))) };
const studio = { listTranslationTasks: vi.fn(), listTranscriptionTasks: vi.fn() };
const ctx = () => ({ sessionId: "s1", client: { name: "claude-code", version: "2" }, signal: new AbortController().signal });
const parse = <K extends keyof typeof EXTERNAL_TOOLS>(name: K, value: object) => EXTERNAL_TOOLS[name].inputSchema.parse(value) as never;
const proposal = {
  languagePair: { source: "ja", target: "zh-Hans" },
  collections: [{ ref: "zzz", name: "绝区零" }],
  entries: [
    { action: "create", collection: { ref: "zzz" }, kind: "term", source: "テイムフィールド", target: "泰姆菲尔德", basis: "document", evidence: "テイムフィールド家" },
    { action: "create", collection: { ref: "zzz" }, kind: "term", source: "ホロウ", target: "空洞", basis: "agent_inferred" },
  ],
};

beforeEach(async () => {
  vi.clearAllMocks(); resetExternalConfirmations();
  const root = await mkdtemp(path.join(os.tmpdir(), "fk-external-knowledge-")); roots.push(root);
  service = new KnowledgeService(root);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { translationKnowledge: knowledge, subtitleStudio: studio, externalAgent: { requestAttention: vi.fn() }, dispatchEvent: () => true } });
  useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: "auto", sessions: [] }, activity: {} });
});
afterEach(async () => {
  await service.dispose();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  setAgentNavigator(null);
});

describe("translation materials", () => {
  it("always asks before saving, even in auto; a yes saves enabled entries that search and the catalog then find", async () => {
    const call = prepareKnowledgeChanges(parse("prepare_knowledge_changes", proposal), ctx());
    await vi.waitFor(() => expect(useExternalConfirmationsStore.getState().requests).toHaveLength(1));
    const request = useExternalConfirmationsStore.getState().requests[0];
    expect(request).toMatchObject({ action: "knowledge", sessionGrant: false, values: { count: 3 } });
    expect(request.items).toContainEqual({ text: expect.stringContaining("泰姆菲尔德"), tag: "term", detail: "绝区零" });
    expect(request.items).toContainEqual({ text: "绝区零", tag: "collection" });
    useExternalConfirmationsStore.getState().decide(request.id, true);
    await expect(call).resolves.toMatchObject({ status: "saved", counts: { created: 2 } });

    const found = await searchTranslationKnowledge(parse("search_translation_knowledge", { query: "空洞" }), ctx());
    expect(found.entries).toEqual([expect.objectContaining({ kind: "term", enabled: true, collection: "绝区零" })]);
    const catalog = await listTranslationKnowledgeCatalog(parse("list_translation_knowledge_catalog", {}), ctx());
    expect(catalog.collections).toEqual([expect.objectContaining({ name: "绝区零", entryCount: 2, enabledCount: 2 })]);
  });

  it("refuses an invalid proposal with reasons, without asking, and saves nothing when declined", async () => {
    await expect(prepareKnowledgeChanges(parse("prepare_knowledge_changes", { entries: [{ action: "create", collection: { ref: "missing" }, kind: "term", source: "a", target: "b", basis: "document" }] }), ctx()))
      .rejects.toMatchObject({ code: "knowledge_proposal_invalid", detail: { items: [expect.objectContaining({ status: "invalid" })] } });
    expect(useExternalConfirmationsStore.getState().requests).toEqual([]);
    const call = prepareKnowledgeChanges(parse("prepare_knowledge_changes", proposal), ctx());
    await vi.waitFor(() => expect(useExternalConfirmationsStore.getState().requests).toHaveLength(1));
    useExternalConfirmationsStore.getState().decide(useExternalConfirmationsStore.getState().requests[0].id, false);
    await expect(call).rejects.toMatchObject({ code: "declined_by_user" });
    expect(knowledge.saveRecords).not.toHaveBeenCalled();
  });
});

describe("tasks and pages", () => {
  it("reads translation tasks and reports an unavailable transcription runtime", async () => {
    studio.listTranslationTasks.mockResolvedValue({ ok: true, value: { total: 1, counts: { running: 1 }, items: [{ documentId: "d", revision: 2, taskId: "t", displayName: "ep01.srt", status: "running", completedBatches: 1, totalBatches: 3 }] } });
    expect(await getStudioTasks(parse("get_studio_tasks", {}), ctx())).toMatchObject({ kind: "translation", total: 1, items: [{ taskId: "t", status: "running", completedBatches: 1, totalBatches: 3 }] });
    studio.listTranscriptionTasks.mockResolvedValue({ ok: false, error: "resource_busy" });
    await expect(getStudioTasks(parse("get_studio_tasks", { kind: "transcription" }), ctx())).rejects.toMatchObject({ code: "transcription_unavailable", detail: { reason: "resource_busy" } });
  });

  it("opens a fixed page through the app's router", async () => {
    const navigate = vi.fn((to: string) => usePageContextStore.setState({ pathname: to.split("?")[0] }));
    setAgentNavigator(navigate);
    usePageContextStore.setState({ pathname: "/", pages: [] });
    const result = await openFusionkitPage(parse("open_fusionkit_page", { page: "subtitle_studio", studioView: "transcription" }), ctx());
    expect(navigate).toHaveBeenCalledWith("/tools/subtitle/studio?view=transcription");
    expect(result).toEqual({ page: "subtitle_studio", currentPage: "/tools/subtitle/studio" });
    expect(EXTERNAL_TOOLS.open_fusionkit_page.inputSchema.safeParse({ page: "/etc/passwd" }).success).toBe(false);
  });
});
