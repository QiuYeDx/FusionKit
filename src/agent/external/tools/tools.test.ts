import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@/type/model";
import useModelStore from "@/store/useModelStore";
import { usePageContextStore } from "@/agent/page-context";
import { EXTERNAL_TOOLS } from "../catalog";
import { useExternalAgentStore } from "../store";
import { getFusionkitStatus } from "./status";
import { listStudioDocuments } from "./studio-documents";

const api = { listDocuments: vi.fn(), listTranslationTasks: vi.fn(), listTranscriptionTasks: vi.fn() };
const originalWindow = globalThis.window;
const ctx = () => ({ sessionId: "s1", client: { name: "codex", version: "1" }, signal: new AbortController().signal });
const doc = (index: number) => ({ id: `00000000-0000-4000-8000-00000000000${index}`, revision: 3, origin: { displayName: `ep0${index}.srt`, format: "srt" }, capabilities: { translate: true }, cueCount: 120, translationStatus: "none" });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { subtitleStudio: api } });
  useModelStore.setState({ profiles: [{ id: "agent", name: "My Agent", provider: Model.OpenAI, apiKey: "sk-agent-secret", baseUrl: "https://private.example/v1", modelKey: "gpt-x", apiFormat: "responses", tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { agent: "agent", taskExecution: null } });
  usePageContextStore.setState({ pathname: "/tools/subtitle/studio" });
  useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: "auto", sessions: [] }, activity: {} });
  api.listDocuments.mockResolvedValue({ ok: true, value: { documents: [doc(1)], total: 7, allTotal: 7, unavailableDocuments: 1 } });
  api.listTranslationTasks.mockResolvedValue({ ok: true, value: { total: 2, counts: { queued: 1, running: 1, failed: 1, interrupted: 0, needs_configuration: 0, completed: 3, cancelled: 0 }, items: [] } });
  api.listTranscriptionTasks.mockResolvedValue({ ok: true, value: [{ status: "transcribing" }, { status: "completed" }] });
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("get_fusionkit_status", () => {
  it("reports state and which models exist, never their keys or addresses", async () => {
    const result = await getFusionkitStatus({}, ctx());
    expect(result).toMatchObject({
      app: "FusionKit", currentPage: "/tools/subtitle/studio", trust: "auto",
      fusionkitModels: { agent: { configured: true, name: "My Agent", model: "gpt-x" }, taskExecution: { configured: false } },
      subtitleStudio: { available: true, documentCount: 7, unavailableDocumentCount: 1, translationTasks: { queued: 1, running: 1, needsAttention: 1 }, transcriptionTasks: { available: true, active: 1 } },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("sk-agent-secret");
    expect(text).not.toContain("private.example");
  });

  it("still answers when Subtitle Studio or its transcription runtime cannot be read", async () => {
    api.listTranscriptionTasks.mockResolvedValue({ ok: false, error: "resource_busy" });
    expect((await getFusionkitStatus({}, ctx())).subtitleStudio).toMatchObject({ available: true, documentCount: 7, transcriptionTasks: { available: false } });
    api.listDocuments.mockResolvedValue({ ok: false, error: "access_denied" });
    expect((await getFusionkitStatus({}, ctx())).subtitleStudio).toEqual({ available: false });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    expect((await getFusionkitStatus({}, ctx())).subtitleStudio).toEqual({ available: false });
  });
});

describe("list_studio_documents", () => {
  const input = (value: object = {}) => EXTERNAL_TOOLS.list_studio_documents.inputSchema.parse(value);
  it("passes the filters through and maps documents with paging", async () => {
    const result = await listStudioDocuments(input({ query: "ep", format: "srt", status: "untranslated", offset: 0, limit: 1 }), ctx());
    expect(api.listDocuments).toHaveBeenCalledWith({ offset: 0, pageSize: 1, query: "ep", format: "srt", status: "untranslated" });
    expect(result).toEqual({ total: 7, offset: 0, nextOffset: 1, unavailableCount: 1,
      items: [{ documentId: doc(1).id, revision: 3, name: "ep01.srt", format: "srt", cueCount: 120, translationStatus: "none", canTranslate: true, task: null }] });
  });

  it("returns an empty page for an empty library", async () => {
    api.listDocuments.mockResolvedValue({ ok: true, value: { documents: [], total: 0, unavailableDocuments: 0 } });
    expect(await listStudioDocuments(input(), ctx())).toEqual({ total: 0, offset: 0, nextOffset: null, items: [], unavailableCount: 0 });
  });

  it("keeps Studio's error code", async () => {
    api.listDocuments.mockResolvedValue({ ok: false, error: "document_unavailable" });
    await expect(listStudioDocuments(input(), ctx())).rejects.toMatchObject({ code: "document_unavailable" });
  });
});
