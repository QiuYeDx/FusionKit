import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO_TRANSCRIPTION_CONFIG } from "@/subtitle-studio/transcription/preferences-contract";
import { EXTERNAL_TOOLS } from "../catalog";
import { resetExternalConfirmations, useExternalConfirmationsStore } from "../confirmations";
import { useExternalAgentStore } from "../store";
import { exportStudioDocument } from "./export";
import { forgetKnownRevisions } from "./studio";
import { startStudioTranscription } from "./transcription";

const controller = vi.hoisted(() => ({ state: {} as Record<string, any>, refresh: vi.fn(), setConfig: vi.fn(), setAutoTranslation: vi.fn(), selectMediaFromPaths: vi.fn(), enqueue: vi.fn(), removeDraft: vi.fn(), getState: vi.fn() }));
vi.mock("@/services/subtitle-studio/transcription-controller", () => ({
  getStudioTranscriptionController: () => controller,
  getTranscriptionReadiness: (state: any) => {
    const reason = state.runtime?.status !== "verified" ? "runtime_not_ready" : !state.drafts.length ? "no_media" : null;
    return { canEnqueue: !reason, readyCount: state.drafts.filter((draft: any) => draft.status === "ready").length, reason };
  },
}));

const DOC = "00000000-0000-4000-8000-000000000001";
const TRACK = "00000000-0000-4000-8000-0000000000a1";
const summary = { id: DOC, revision: 6, origin: { displayName: "Episode 01.srt", format: "srt" }, capabilities: { translate: true }, cueCount: 2, translationStatus: "complete" };
const page = { summary, offset: 0, tasks: [], cues: [], translationTracks: [{ id: TRACK, language: "zh", revision: 1, origin: "ai", agent: { name: "codex" }, entries: {} }] };
const plan = (changes: object = {}) => ({ planId: "00000000-0000-4000-8000-0000000000b1", documentId: DOC, revision: 6, fileName: "Episode 01.srt", issues: [{ code: "estimated_end", count: 1, blocking: false, confirmation: true }],
  sourceLocation: { status: "ready" }, ...changes });
const api = { listDocuments: vi.fn(), readDocumentPage: vi.fn(), planExport: vi.fn(), exportDocument: vi.fn(), listTranscriptionTasks: vi.fn() };
const originalWindow = globalThis.window;
const ctx = () => ({ sessionId: "s1", client: { name: "codex", version: "1" }, signal: new AbortController().signal });
const trust = (value: "auto" | "confirm_writes") => useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: value, sessions: [] }, activity: {} });
const exportInput = (value: object) => EXTERNAL_TOOLS.export_studio_document.inputSchema.parse({ documentId: DOC, revision: 6, ...value }) as never;
const transcriptionInput = (value: object) => EXTERNAL_TOOLS.start_studio_transcription.inputSchema.parse({ paths: ["D:/media"], ...value }) as never;

beforeEach(() => {
  vi.clearAllMocks(); forgetKnownRevisions(); resetExternalConfirmations(); trust("auto");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { subtitleStudio: api, externalAgent: { requestAttention: vi.fn() } } });
  api.readDocumentPage.mockResolvedValue({ ok: true, value: page });
  api.planExport.mockResolvedValue({ ok: true, value: plan() });
  api.exportDocument.mockResolvedValue({ ok: true, value: { fileName: "Episode 01.srt", revision: 6, partial: false, mode: "bilingual", incomplete: "source-fallback" } });
  controller.state = { drafts: [], selecting: false, submitting: false, runtime: { status: "verified" }, resources: [], error: null,
    config: { ...DEFAULT_STUDIO_TRANSCRIPTION_CONFIG },
    autoTranslation: { enabled: true, language: "zh", instructions: "" } };
  controller.getState.mockImplementation(() => controller.state);
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("export_studio_document", () => {
  it("exports the newest track bilingually next to the source with Studio's defaults, accepting confirmable losses", async () => {
    const result = await exportStudioDocument(exportInput({}), ctx());
    expect(api.planExport).toHaveBeenCalledWith({ documentId: DOC, revision: 6, options: {
      mode: "bilingual", format: "srt", trackId: TRACK, fileNameSuffix: { mode: "none" }, order: "source-first", encoding: "utf-8", bom: false, newline: "lf",
      incomplete: "source-fallback", conflictPolicy: "indexed", stripMediaExt: true, missingEnd: { mode: "next-start", finalDurationMs: 2000 } } });
    expect(api.exportDocument).toHaveBeenCalledWith(expect.objectContaining({ acceptedLosses: ["estimated_end"], destination: "source-directory" }));
    expect(result).toMatchObject({ fileName: "Episode 01.srt", acceptedLosses: [{ code: "estimated_end", count: 1 }] });
  });

  it("refuses blocked plans and unavailable source folders, and needs a translation track for target content", async () => {
    api.planExport.mockResolvedValue({ ok: true, value: plan({ issues: [{ code: "translation_missing", count: 1, blocking: true, confirmation: false }] }) });
    await expect(exportStudioDocument(exportInput({ content: "target", incomplete: "block" }), ctx())).rejects.toMatchObject({ code: "export_blocked", detail: { issues: [{ code: "translation_missing", count: 1, blocking: true }] } });
    api.planExport.mockResolvedValue({ ok: true, value: plan({ sourceLocation: { status: "missing" } }) });
    await expect(exportStudioDocument(exportInput({}), ctx())).rejects.toMatchObject({ code: "source_directory_unavailable" });
    api.readDocumentPage.mockResolvedValue({ ok: true, value: { ...page, translationTracks: [] } });
    await expect(exportStudioDocument(exportInput({ content: "target" }), ctx())).rejects.toMatchObject({ code: "no_translation_track" });
    expect(api.exportDocument).not.toHaveBeenCalled();
  });

  it("always asks before overwriting, even in auto", async () => {
    const call = exportStudioDocument(exportInput({ conflict: "overwrite", destination: "choose_location" }), ctx());
    await vi.waitFor(() => expect(useExternalConfirmationsStore.getState().requests).toHaveLength(1));
    expect(useExternalConfirmationsStore.getState().requests[0]).toMatchObject({ destructive: true, warning: "overwrite", summary: "export_choose", content: "bilingual" });
    useExternalConfirmationsStore.getState().decide(useExternalConfirmationsStore.getState().requests[0].id, false);
    await expect(call).rejects.toMatchObject({ code: "declined_by_user" });
    expect(api.exportDocument).not.toHaveBeenCalled();
  });
});

describe("start_studio_transcription", () => {
  it("refuses while the runtime is not ready or the user has drafts, touching nothing", async () => {
    controller.state = { ...controller.state, runtime: { status: "missing" } };
    await expect(startStudioTranscription(transcriptionInput({}), ctx())).rejects.toMatchObject({ code: "transcription_not_ready", detail: { reason: "runtime_not_ready" } });
    controller.state = { ...controller.state, runtime: { status: "verified" }, drafts: [{ id: "user-draft", status: "ready" }] };
    await expect(startStudioTranscription(transcriptionInput({}), ctx())).rejects.toMatchObject({ code: "transcription_drafts_pending" });
    expect(controller.selectMediaFromPaths).not.toHaveBeenCalled();
    expect(controller.removeDraft).not.toHaveBeenCalled();
  });

  it("queues the batch without automatic translation and restores the user's settings", async () => {
    controller.selectMediaFromPaths.mockImplementation(async () => {
      controller.state = { ...controller.state, drafts: [{ id: "d1", status: "ready", displayName: "ep01.mp4" }] };
      return { matched: 1 };
    });
    controller.enqueue.mockImplementation(async () => {
      controller.state = { ...controller.state, drafts: [] };
      return { batchId: "b1", tasks: [{ taskId: "t1", displayName: "ep01.mp4", status: "queued" }] };
    });
    const result = await startStudioTranscription(transcriptionInput({ modelId: "large-v3", language: "ja" }), ctx());
    expect(controller.setConfig).toHaveBeenNthCalledWith(1, expect.objectContaining({ modelId: "large-v3", language: "ja" }));
    expect(controller.setAutoTranslation).toHaveBeenNthCalledWith(1, expect.objectContaining({ enabled: false }));
    expect(controller.enqueue).toHaveBeenCalledWith({ expectedDraftIds: ["d1"], autoExport: null });
    expect(controller.setAutoTranslation).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, language: "zh" }));
    expect(controller.setConfig).toHaveBeenLastCalledWith(DEFAULT_STUDIO_TRANSCRIPTION_CONFIG);
    expect(result).toMatchObject({ batchId: "b1", tasks: [{ taskId: "t1", status: "queued" }] });
  });

  it("drops its own drafts when nothing can be queued", async () => {
    controller.selectMediaFromPaths.mockImplementation(async () => {
      controller.state = { ...controller.state, drafts: [{ id: "d1", status: "failed", displayName: "bad.mp4", error: "media_unreadable" }] };
      return { matched: 1 };
    });
    await expect(startStudioTranscription(transcriptionInput({}), ctx())).rejects.toMatchObject({ code: "media_not_ready" });
    expect(controller.removeDraft).toHaveBeenCalledWith("d1");
  });
});
