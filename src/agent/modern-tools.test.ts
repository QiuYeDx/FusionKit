import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@/type/model";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import useLocalSubtitleTranscriberStore from "@/store/tools/subtitle/useLocalSubtitleTranscriberStore";
import { DEFAULT_STUDIO_TRANSCRIPTION_CONFIG, DEFAULT_TRANSCRIPTION_PREFERENCES } from "@/subtitle-studio/transcription/preferences-contract";
import { DEFAULT_AUTOMATIC_EXPORT_PREFERENCES } from "@/subtitle-studio/automatic-export-contract";
import { modernAgentTools } from "./modern-tools";
import { usePreparedActionsStore } from "./prepared-actions";
import { emptySelection, translationDraftMemory } from "@/services/subtitle-studio/translation-draft";

const mocks = vi.hoisted(() => ({ controller: {} as Record<string, any>, trackStarted: vi.fn(), state: {} as Record<string, any>, watch: vi.fn() }));
vi.mock("./pipeline-watch", () => ({ watchStudioPipeline: mocks.watch }));
vi.mock("@/services/subtitle-studio/transcription-controller", () => ({
  getStudioTranscriptionController: () => mocks.controller,
  getTranscriptionReadiness: (state: any) => ({ canEnqueue: state.drafts.length > 0 && state.drafts.every((draft: any) => draft.status === "ready"), readyCount: state.drafts.filter((draft: any) => draft.status === "ready").length, reason: null }),
}));
vi.mock("@/services/subtitle-studio/translation-overview-controller", () => ({ getStudioTranslationOverviewController: () => ({ trackStarted: mocks.trackStarted }) }));
const api = { listDocuments: vi.fn(), importSubtitles: vi.fn(), importSubtitlePaths: vi.fn(), listTranslationTasks: vi.fn(), listTranscriptionTasks: vi.fn(), planTranslationBatch: vi.fn(), createTranslationBatch: vi.fn() };
const knowledge = { read: vi.fn() };
const originalWindow = globalThis.window;
const documentId = "00000000-0000-4000-8000-000000000001";
const secondDocumentId = "00000000-0000-4000-8000-000000000003";
const thirdDocumentId = "00000000-0000-4000-8000-000000000004";
const collectionId = "00000000-0000-4000-8000-000000000002";
const doc = { id: documentId, revision: 1, origin: { displayName: "subtitle.srt", format: "srt" }, capabilities: { translate: true }, cueCount: 3, translationStatus: "none" };
async function call(name: keyof typeof modernAgentTools, args: unknown = {}, abortSignal?: AbortSignal): Promise<any> {
  const execute = modernAgentTools[name].execute as (input: unknown, options: unknown) => Promise<unknown>;
  return execute(args, { toolCallId: "call-one", messages: [], abortSignal });
}
const setSession = (id: string) => useAgentStore.setState({ session: { ...useAgentStore.getState().session, id } });
beforeEach(() => {
  vi.clearAllMocks(); setSession(`reset-${Math.random()}`); usePreparedActionsStore.setState({ actions: [] }); setSession("modern-test");
  useAgentStore.setState({ executionMode: "queue_only" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { subtitleStudio: api, translationKnowledge: knowledge } });
  useModelStore.setState({ profiles: [{ id: "task-profile", name: "Task model", provider: Model.OpenAI, apiKey: "secret-task-key", baseUrl: "https://private-api.example/v1", modelKey: "model-one", apiFormat: "responses", tokenPricing: { inputTokensPerMillion: 1, outputTokensPerMillion: 1 } }], assignment: { agent: null, taskExecution: "task-profile" } });
  api.listDocuments.mockResolvedValue({ ok: true, value: { documents: [doc], total: 1, unavailableDocuments: 0 } });
  api.importSubtitles.mockResolvedValue({ ok: true, value: null });
  api.planTranslationBatch.mockResolvedValue({ ok: true, value: { batchId: "batch-one", items: [{ ok: true, documentId, displayName: "subtitle.srt", plan: { cueCount: 3 } }], totalEstimatedInputTokens: 400 } });
  api.createTranslationBatch.mockResolvedValue({ ok: true, value: { items: [{ ok: true, documentId, displayName: "subtitle.srt", taskId: "task-one" }] } });
  api.listTranslationTasks.mockResolvedValue({ ok: true, value: { total: 1, counts: { queued: 1 }, items: [{ documentId, revision: 1, taskId: "task-one", displayName: "subtitle.srt", status: "queued", completedBatches: 0, totalBatches: 1, canResume: false, model: { apiKey: "secret" } }] } });
  mocks.state = { config: structuredClone(DEFAULT_STUDIO_TRANSCRIPTION_CONFIG), autoTranslation: structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation), autoExport: { ...DEFAULT_AUTOMATIC_EXPORT_PREFERENCES }, drafts: [], error: null };
  mocks.controller = {
    refresh: vi.fn().mockResolvedValue(undefined), getState: () => mocks.state,
    setConfig: vi.fn(value => { mocks.state.config = value; }), setAutoTranslation: vi.fn(value => { mocks.state.autoTranslation = value; }),
    selectMedia: vi.fn(async () => { mocks.state.drafts = [{ id: "picked-draft", displayName: "media.mp4", status: "ready", audioStreamId: "audio-one" }]; }),
    removeDraft: vi.fn(id => { mocks.state.drafts = mocks.state.drafts.filter((item: any) => item.id !== id); }),
    enqueue: vi.fn(async () => { mocks.state.drafts = []; return { batchId: "transcription-batch", tasks: [{ taskId: "transcription-task", displayName: "media.mp4", status: "queued" }] }; }),
  };
});
afterEach(() => { setSession(`cleanup-${Math.random()}`); Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("modern tools fixed API boundaries", () => {
  it("uses a native import and preserves cancellation without starting translation", async () => {
    expect(await call("import_studio_subtitles")).toEqual({ success: true, data: { cancelled: true, importedCount: 0 } });
    expect(api.importSubtitles).toHaveBeenCalledWith({ encoding: "utf-8" });
    expect(api.createTranslationBatch).not.toHaveBeenCalled();
  });
  it("imports subtitles from a folder the user typed, and from no other", async () => {
    useAgentStore.getState().addMessage({ id: "typed", role: "user", content: "把 D:/字幕/第一季 里的字幕导入工作台", timestamp: 1 });
    expect(await call("import_studio_subtitles", { paths: ["D:/私人"] })).toMatchObject({ success: false, error: "studio_import_path_not_typed" });
    api.importSubtitlePaths.mockResolvedValueOnce({ ok: true, value: { items: [{ fileName: "01.srt", ok: true, document: doc }] } });
    expect(await call("import_studio_subtitles", { paths: ["D:/字幕/第一季"] })).toMatchObject({ success: true, data: { importedCount: 1, total: 1 } });
    expect(api.importSubtitlePaths).toHaveBeenCalledWith({ encoding: "utf-8", paths: ["D:/字幕/第一季"] });
    api.importSubtitlePaths.mockResolvedValueOnce({ ok: true, value: { items: [] } });
    expect(await call("import_studio_subtitles", { paths: ["D:/字幕/第一季"] })).toMatchObject({ success: false, error: "studio_import_no_subtitles" });
    expect(api.importSubtitles).not.toHaveBeenCalled();
  });
  it.each(["filePaths", "apiKey", "endpoint", "fileToken"])("rejects forbidden %s before opening a picker", async field => {
    expect(await call("import_studio_subtitles", { [field]: "private" })).toMatchObject({ success: false, error: "invalid_tool_arguments" });
    expect(api.importSubtitles).not.toHaveBeenCalled();
  });
  it("distinguishes fixed API failures and unavailable bridge from an empty library", async () => {
    api.listDocuments.mockResolvedValueOnce({ ok: false, error: "access_denied" });
    expect(await call("list_studio_documents")).toEqual({ success: false, error: "access_denied" });
    api.listDocuments.mockRejectedValueOnce(new Error("IPC failed for secret-task-key"));
    const unexpected = await call("list_studio_documents");
    expect(unexpected).toEqual({ success: false, error: "tool_request_failed", data: { reason: "IPC failed for [redacted]" } });
    expect(JSON.stringify(useAgentStore.getState().sessionLog)).not.toContain("secret-task-key");
    expect(useAgentStore.getState().sessionLog.at(-1)).toMatchObject({ type: "error", data: { source: "modern_tool", reason: "IPC failed for [redacted]" } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    expect(await call("list_studio_documents")).toMatchObject({ success: false, error: "subtitle_studio_unavailable" });
  });
  it("checks abort before a native picker or configuration mutation", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await call("import_studio_subtitles", {}, controller.signal)).toMatchObject({ success: false, error: "agent_cancelled" });
    expect(api.importSubtitles).not.toHaveBeenCalled();
  });
  it("preserves an already committed import receipt when stop occurs in the native picker", async () => {
    const controller = new AbortController();
    api.importSubtitles.mockImplementationOnce(async () => { controller.abort(); return { ok: true, value: { items: [{ ok: true, document: doc }] } }; });
    expect(await call("import_studio_subtitles", {}, controller.signal)).toMatchObject({ success: true, data: { importedCount: 1 } });
    expect(api.createTranslationBatch).not.toHaveBeenCalled();
  });
  it("keeps actual queued task status and projects out model metadata", async () => {
    const result = await call("get_studio_tasks");
    expect(result.data.items[0].status).toBe("queued");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("bounds document results and forbids excessive pagination", async () => {
    api.listDocuments.mockResolvedValueOnce({ ok: true, value: { documents: [doc, doc, doc], total: 3, unavailableDocuments: 0 } });
    expect((await call("list_studio_documents", { limit: 1 })).data.items).toHaveLength(1);
    expect(await call("list_studio_documents", { limit: 100 })).toMatchObject({ success: false });
  });
  it("projects unavailable documents to a count without recovery capabilities or native paths", async () => {
    api.listDocuments.mockResolvedValueOnce({ ok: true, value: { documents: [doc], total: 1, unavailableDocuments: 1,
      unavailable: [{ id: documentId, token: "private-recovery-token", directory: "C:\\private\\documents", reason: "document_unavailable" }] } });
    const result = await call("list_studio_documents");
    expect(result.data.unavailableCount).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/private-recovery-token|private|directory|token/);
  });
});

describe("translation preparation and admission", () => {
  it("preserves preparation and submission failures alongside the actual admitted subset", async () => {
    const unavailable = { ok: false, documentId: thirdDocumentId, displayName: "missing.srt", error: "document_unavailable" };
    api.planTranslationBatch.mockResolvedValueOnce({ ok: true, value: { batchId: "mixed-batch", totalEstimatedInputTokens: 800, items: [
      { ok: true, documentId, displayName: "ready.srt", plan: {} },
      { ok: true, documentId: secondDocumentId, displayName: "changed.srt", plan: {} }, unavailable] } });
    api.createTranslationBatch.mockResolvedValueOnce({ ok: true, value: { items: [
      { ok: true, documentId, displayName: "ready.srt", taskId: "task-one" },
      { ok: false, documentId: secondDocumentId, displayName: "changed.srt", error: "revision_conflict" }, unavailable] } });
    const result = await call("prepare_studio_translation", { documents: [documentId, secondDocumentId, thirdDocumentId].map(documentId => ({ documentId, revision: 1 })) });
    expect(result.data.receipt).toMatchObject({ phase: "preparation", total: 3, successCount: 2, failureCount: 1,
      items: [{ status: "ready" }, { status: "ready" }, { id: thirdDocumentId, name: "missing.srt", status: "failed", error: "document_unavailable" }] });
    expect(usePreparedActionsStore.getState().actions[0].preparationReceipt).toEqual(result.data.receipt);
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ status: "completed", result: { executionStatus: "queued",
      receipt: { phase: "submission", total: 3, successCount: 1, failureCount: 2, items: [
        { id: documentId, name: "ready.srt", status: "queued", taskId: "task-one" },
        { id: secondDocumentId, name: "changed.srt", status: "failed", error: "revision_conflict" },
        { id: thirdDocumentId, name: "missing.srt", status: "failed", error: "document_unavailable" }] } } });
    expect(mocks.trackStarted).toHaveBeenCalledWith(["task-one"]);
  });
  it("returns per-file reasons when every document fails preparation", async () => {
    api.planTranslationBatch.mockResolvedValueOnce({ ok: true, value: { batchId: "failed-plan", totalEstimatedInputTokens: 0,
      items: [{ ok: false, documentId, displayName: "broken.srt", error: "unsupported_feature" }] } });
    expect(await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] })).toMatchObject({ success: false,
      data: { receipt: { phase: "preparation", total: 1, successCount: 0, failureCount: 1,
        items: [{ id: documentId, name: "broken.srt", status: "failed", error: "unsupported_feature" }] } } });
    expect(usePreparedActionsStore.getState().actions).toHaveLength(0);
    expect(api.createTranslationBatch).not.toHaveBeenCalled();
  });
  it.each(["queue_only", "auto_execute"] as const)("retains all-failed admission receipts in %s without retrying", async mode => {
    useAgentStore.setState({ executionMode: mode });
    api.createTranslationBatch.mockResolvedValueOnce({ ok: true, value: { items: [{ ok: false, documentId, displayName: "subtitle.srt", error: "revision_conflict" }] } });
    const result = await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] });
    if (mode === "queue_only") await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    const expected = { phase: "submission", total: 1, successCount: 0, failureCount: 1,
      items: [{ id: documentId, name: "subtitle.srt", status: "failed", error: "revision_conflict" }] };
    const action = usePreparedActionsStore.getState().actions[0];
    expect(action).toMatchObject({ status: "failed", result: { receipt: expected } });
    if (mode === "auto_execute") expect(result).toMatchObject({ success: false, data: { result: { receipt: expected } } });
    await usePreparedActionsStore.getState().confirmAction(action.id);
    expect(api.createTranslationBatch).toHaveBeenCalledTimes(1);
    expect(mocks.trackStarted).not.toHaveBeenCalled();
  });
  it("does not invent per-file failures or retry when the admission response is lost", async () => {
    useAgentStore.setState({ executionMode: "auto_execute" });
    api.createTranslationBatch.mockRejectedValueOnce(new Error("private-api secret-task-key"));
    const result = await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] });
    expect(result).toMatchObject({ success: false, error: "studio_translation_submission_unknown", data: {
      receipt: { phase: "preparation", successCount: 1, failureCount: 0 } } });
    expect(result.data.result).toBeUndefined();
    const action = usePreparedActionsStore.getState().actions[0];
    expect(action.result).toBeUndefined();
    await usePreparedActionsStore.getState().confirmAction(action.id);
    expect(api.createTranslationBatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/private-api|secret-task-key/);
  });
  it.each(["queue_only", "ask_before_execute"] as const)("does not submit in %s and submits the exact batch once on confirmation", async mode => {
    useAgentStore.setState({ executionMode: mode });
    const result = await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] });
    expect(result).toMatchObject({ success: true, data: { executionStatus: "prepared" } });
    expect(api.createTranslationBatch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/secret-task-key|private-api/);
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(api.createTranslationBatch).toHaveBeenCalledTimes(1);
    expect(api.createTranslationBatch).toHaveBeenCalledWith({ batchId: "batch-one", apiKey: "secret-task-key" });
    expect(mocks.trackStarted).toHaveBeenCalledWith(["task-one"]);
  });
  it("auto mode returns submitted receipts rather than claiming translation completion", async () => {
    useAgentStore.setState({ executionMode: "auto_execute" });
    expect(await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] })).toMatchObject({ success: true, data: { executionStatus: "submitted", result: { executionStatus: "queued", taskIds: ["task-one"] } } });
  });
  it("rejects stale sessions after planning without registering executable authority", async () => {
    api.planTranslationBatch.mockImplementationOnce(async () => { setSession("new-session"); return { ok: true, value: { batchId: "late-batch", items: [{ ok: true }], totalEstimatedInputTokens: 1 } }; });
    expect(await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] })).toMatchObject({ success: false, error: "agent_session_changed" });
    expect(usePreparedActionsStore.getState().actions).toHaveLength(0);
    expect(api.createTranslationBatch).not.toHaveBeenCalled();
  });
  it("records a plan revision conflict once without retrying the mutation", async () => {
    api.createTranslationBatch.mockResolvedValueOnce({ ok: false, error: "revision_conflict" });
    const result = await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] });
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ status: "failed", error: "revision_conflict" });
    expect(api.createTranslationBatch).toHaveBeenCalledTimes(1);
  });
  it("never falls back to an unassigned task model", async () => {
    useModelStore.setState({ assignment: { agent: "task-profile", taskExecution: null } });
    expect(await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] })).toMatchObject({ success: false, error: "task_model_not_configured" });
    expect(api.planTranslationBatch).not.toHaveBeenCalled();
  });
  it("retires the old main-owned plan before a replacement, including cancelled planning", async () => {
    const first = await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] });
    const abort = new AbortController();
    api.planTranslationBatch.mockImplementationOnce(async () => { abort.abort(); return { ok: true, value: { batchId: "replacement", items: [] } }; });
    expect(await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] }, abort.signal)).toMatchObject({ success: false, error: "agent_cancelled" });
    await usePreparedActionsStore.getState().confirmAction(first.data.actionId);
    expect(api.createTranslationBatch).not.toHaveBeenCalled();
    expect(usePreparedActionsStore.getState().actions).toHaveLength(1);
    expect(usePreparedActionsStore.getState().actions[0].status).toBe("dismissed");
  });
});

describe("transcription preparation ownership", () => {
  it("refuses existing manual drafts before changing configuration or opening a picker", async () => {
    mocks.state.drafts = [{ id: "manual", status: "ready" }];
    expect(await call("prepare_studio_transcription")).toMatchObject({ success: false, error: "studio_transcription_existing_drafts" });
    expect(mocks.controller.selectMedia).not.toHaveBeenCalled(); expect(mocks.controller.setConfig).not.toHaveBeenCalled();
  });
  it("takes media from paths the user typed, and from nothing else, without opening the picker", async () => {
    const folder = "H:\\ASMR\\【RJ01342767】作品\\本編wav";
    mocks.controller.selectMediaFromPaths = vi.fn(async () => { mocks.state.drafts = [{ id: "typed-draft", displayName: "01.wav", status: "ready", audioStreamId: "a" }]; return { matched: 23, nextOffset: 20 }; });
    useAgentStore.getState().addMessage({ id: "typed", role: "user", content: `"${folder}"中的音频文件都转写`, timestamp: 1 });
    // Neither an untyped folder nor one named only by a FusionKit interface event counts.
    useAgentStore.getState().addMessage({ id: "event", role: "user", content: "D:\\Private", timestamp: 2, event: { kind: "action_completed" } });
    expect(await call("prepare_studio_transcription", { paths: ["D:\\Private"] })).toMatchObject({ success: false, error: "studio_transcription_path_not_typed" });
    expect(mocks.controller.selectMediaFromPaths).not.toHaveBeenCalled();
    // A folder inside the typed one is the user's choice too.
    const result = await call("prepare_studio_transcription", { paths: [`${folder}\\Disc 2`], recursive: true });
    expect(result).toMatchObject({ success: true, data: { executionStatus: "prepared", mediaMatched: 23, nextOffset: 20 } });
    expect(mocks.controller.selectMediaFromPaths).toHaveBeenCalledWith({ paths: [`${folder}\\Disc 2`], recursive: true });
    expect(mocks.controller.selectMedia).not.toHaveBeenCalled();
  });
  it("reports a typed folder without media instead of preparing nothing", async () => {
    mocks.controller.selectMediaFromPaths = vi.fn(async () => ({ matched: 0 }));
    useAgentStore.getState().addMessage({ id: "typed", role: "user", content: "转写 C:\\Audio\\empty 里的文件", timestamp: 1 });
    expect(await call("prepare_studio_transcription", { paths: ["C:\\Audio\\empty"] })).toMatchObject({ success: false, error: "studio_transcription_no_media" });
  });
  it("hands the whole transcribe, translate and export job to Studio for this batch only", async () => {
    const saved = structuredClone(mocks.state.autoTranslation);
    const result = await call("prepare_studio_transcription", { language: "ja", translation: { language: "zh" }, export: { content: "bilingual", conflictPolicy: "overwrite" } });
    expect(result).toMatchObject({ success: true, data: { executionStatus: "prepared", pipeline: { translateTo: "zh", export: { format: "auto", mode: "bilingual", order: "source-first", conflictPolicy: "overwrite" } } } });
    expect(mocks.state.autoTranslation).toMatchObject({ enabled: true, language: "zh" });
    expect(usePreparedActionsStore.getState().actions[0].summaryValues).toMatchObject({ translateTo: "zh", exportFormat: "auto", exportContent: "bilingual", exportConflict: "overwrite" });
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(mocks.controller.enqueue).toHaveBeenCalledWith({ expectedDraftIds: ["picked-draft"], autoExport: { format: "auto", mode: "bilingual", order: "source-first", conflictPolicy: "overwrite", removeAfterExport: false } });
    // The user's own Studio choice is back, and the batch is followed until it is done.
    expect(mocks.state.autoTranslation).toEqual(saved);
    expect(mocks.watch).toHaveBeenCalledWith({ sessionId: "modern-test", taskIds: ["transcription-task"], translate: true, exportFiles: true, removeAfterExport: false });
  });
  it("follows the Studio export setting when the user did not mention export, and fills what a requested export leaves open", async () => {
    mocks.state.autoExport = { ...DEFAULT_AUTOMATIC_EXPORT_PREFERENCES, enabled: true, format: "srt", conflictPolicy: "overwrite", removeAfterExport: true };
    const result = await call("prepare_studio_transcription");
    expect(result.data.pipeline).toMatchObject({ exportSettingsFrom: "tool_page", export: { format: "srt", mode: "source", conflictPolicy: "overwrite", removeAfterExport: true } });
    usePreparedActionsStore.getState().dismissAction(result.data.actionId);
    const asked = await call("prepare_studio_transcription", { translation: { language: "zh" }, export: { format: "lrc", removeDocument: false } });
    expect(asked.data.pipeline).toMatchObject({ exportSettingsFrom: "user", export: { format: "lrc", mode: "bilingual", conflictPolicy: "overwrite", removeAfterExport: false } });
  });
  it("refuses translated output without a translation, and restores the choice when the user drops the card", async () => {
    expect(await call("prepare_studio_transcription", { export: { content: "target" } })).toMatchObject({ success: false, error: "studio_export_needs_translation" });
    const saved = structuredClone(mocks.state.autoTranslation);
    const result = await call("prepare_studio_transcription", { translation: { language: "en" } });
    expect(mocks.state.autoTranslation.enabled).toBe(true);
    usePreparedActionsStore.getState().dismissAction(result.data.actionId);
    await vi.waitFor(() => expect(mocks.state.autoTranslation).toEqual(saved));
    expect(mocks.controller.enqueue).not.toHaveBeenCalled();
  });
  it("uses the prepared media only after confirmation and keeps auto translation off", async () => {
    const result = await call("prepare_studio_transcription", { language: "ja" });
    expect(result).toMatchObject({ success: true, data: { executionStatus: "prepared" } });
    expect(mocks.controller.enqueue).not.toHaveBeenCalled();
    expect(mocks.state.autoTranslation.enabled).toBe(false);
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(mocks.controller.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.controller.enqueue).toHaveBeenCalledWith({ expectedDraftIds: ["picked-draft"], autoExport: null });
  });
  it("rejects a prepared batch when one draft becomes unready without leaking native draft tokens", async () => {
    mocks.controller.selectMedia.mockImplementationOnce(async () => { mocks.state.drafts = [
      { id: "private-file-token-one", displayName: "one.mp4", status: "ready", audioStreamId: "audio-one" },
      { id: "private-file-token-two", displayName: "two.mp4", status: "ready", audioStreamId: "audio-two" }]; });
    const result = await call("prepare_studio_transcription");
    expect(result.data.receipt).toMatchObject({ phase: "preparation", total: 2, successCount: 2 });
    mocks.state.drafts[1].status = "expired"; mocks.state.drafts[1].error = "access_denied";
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(mocks.controller.enqueue).not.toHaveBeenCalled();
    const action = usePreparedActionsStore.getState().actions[0];
    expect(action).toMatchObject({ status: "failed", result: { receipt: { total: 2, successCount: 0, failureCount: 2, items: [
      { id: "media-1", name: "one.mp4", status: "failed" }, { id: "media-2", name: "two.mp4", status: "failed", error: "access_denied" }] } } });
    expect(JSON.stringify([result, action])).not.toContain("private-file-token");
  });
  it("retains exact file evidence when expiry is detected inside scoped admission", async () => {
    const result = await call("prepare_studio_transcription");
    mocks.controller.enqueue.mockImplementationOnce(async () => { mocks.state.error = "revision_conflict"; mocks.state.drafts[0].status = "expired"; mocks.state.drafts[0].error = "access_denied"; return null; });
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(mocks.controller.enqueue).toHaveBeenCalledWith({ expectedDraftIds: ["picked-draft"], autoExport: null });
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ status: "failed", result: { receipt: {
      successCount: 0, failureCount: 1, items: [{ id: "media-1", name: "media.mp4", error: "access_denied" }] } } });
  });
  it("does not silently include drafts added after preparation", async () => {
    const result = await call("prepare_studio_transcription");
    mocks.state.drafts.push({ id: "new-manual", status: "ready" });
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(mocks.controller.enqueue).not.toHaveBeenCalled();
    expect(mocks.state.drafts).toEqual([{ id: "new-manual", status: "ready" }]);
  });
  it("rejects a changed configuration and releases only its prepared draft", async () => {
    const result = await call("prepare_studio_transcription");
    mocks.state.config.language = "en";
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(mocks.controller.enqueue).not.toHaveBeenCalled();
    expect(usePreparedActionsStore.getState().actions[0].error).toBe("studio_transcription_draft_changed");
    expect(mocks.controller.removeDraft).toHaveBeenCalledWith("picked-draft");
  });
  it("does not silently reuse old configuration when the supplied prompt is invalid", async () => {
    expect(await call("prepare_studio_transcription", { initialPrompt: "bad\u0001prompt" })).toMatchObject({ success: false, error: "studio_transcription_configuration_invalid" });
    expect(mocks.controller.setConfig).not.toHaveBeenCalled();
    expect(mocks.controller.selectMedia).not.toHaveBeenCalled();
  });
  it("dismissal releases its fixed-picker media without submitting", async () => {
    const result = await call("prepare_studio_transcription");
    usePreparedActionsStore.getState().dismissAction(result.data.actionId);
    expect(mocks.controller.removeDraft).toHaveBeenCalledWith("picked-draft");
    expect(mocks.controller.enqueue).not.toHaveBeenCalled();
  });
  it("cleans owned drafts when cancellation arrives while the native picker is open", async () => {
    const abort = new AbortController();
    mocks.controller.selectMedia.mockImplementationOnce(async () => { mocks.state.drafts = [{ id: "picked-draft", status: "ready" }]; abort.abort(); });
    expect(await call("prepare_studio_transcription", {}, abort.signal)).toMatchObject({ success: false, error: "agent_cancelled" });
    expect(mocks.controller.removeDraft).toHaveBeenCalledWith("picked-draft");
    expect(mocks.controller.enqueue).not.toHaveBeenCalled();
  });
  it("retains unknown submission evidence and never retries or removes it automatically", async () => {
    const result = await call("prepare_studio_transcription");
    mocks.controller.enqueue.mockImplementationOnce(async () => { mocks.state.drafts[0].status = "submission_unknown"; return null; });
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    await usePreparedActionsStore.getState().confirmAction(result.data.actionId);
    expect(mocks.controller.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.controller.removeDraft).not.toHaveBeenCalled();
    expect(usePreparedActionsStore.getState().actions[0]).toMatchObject({ status: "failed", error: "studio_transcription_submission_unknown" });
    expect(usePreparedActionsStore.getState().actions[0].result).toBeUndefined();
  });
});

describe("local handoff and knowledge projection", () => {
  it("paginates matched entries, collections and recipes independently beyond the first page", async () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({ id: `entry-${index}`, revision: 1, title: `Match entry ${index}`, collectionId,
      state: "candidate", kind: "term", scope: { languagePair: { source: "ja", target: "zh-Hans" } }, payload: { source: "source", target: "target" } }));
    const collections = Array.from({ length: 4 }, (_, index) => ({ id: `collection-${index}`, name: `Match collection ${index}`, archived: false }));
    const recipes = Array.from({ length: 2 }, (_, index) => ({ id: `recipe-${index}`, name: `Match recipe ${index}`, archived: false,
      languagePair: { source: "ja", target: "zh-Hans" } }));
    knowledge.read.mockResolvedValue({ ok: true, value: { generation: 1, approvals: {}, data: { entries,
      collections: [...collections, { id: "archived", name: "Match archived", archived: true }, { id: "other", name: "Unrelated", archived: false }], recipes } } });
    const first = (await call("search_translation_knowledge", { query: "Match", limit: 2 })).data;
    const second = (await call("search_translation_knowledge", { query: "Match", limit: 2, offset: 2 })).data;
    const last = (await call("search_translation_knowledge", { query: "Match", limit: 2, offset: 4 })).data;
    expect(first.pagination).toEqual({ offset: 0, limit: 2,
      entries: { total: 3, hasMore: true, nextOffset: 2 }, collections: { total: 4, hasMore: true, nextOffset: 2 }, recipes: { total: 2, hasMore: false, nextOffset: null } });
    expect(second.pagination).toEqual({ offset: 2, limit: 2,
      entries: { total: 3, hasMore: false, nextOffset: null }, collections: { total: 4, hasMore: false, nextOffset: null }, recipes: { total: 2, hasMore: false, nextOffset: null } });
    for (const key of ["entries", "collections", "recipes"] as const) {
      const ids = [...first[key], ...second[key]].map((item: { id: string }) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(({ entries, collections, recipes })[key].map(item => item.id));
      expect(last[key]).toEqual([]);
      expect(last.pagination[key]).toMatchObject({ hasMore: false, nextOffset: null });
    }
    expect(second.total).toBe(3); expect(second.offset).toBe(2);
  });
  it("rejects unsupported classic output formats without changing preferences", async () => {
    expect(await call("configure_local_transcription", { outputFormats: ["VTT"] })).toMatchObject({ success: false, error: "invalid_tool_arguments" });
  });
  it("does not report all-failed local IPC reads as an empty successful queue", async () => {
    const failure = { ok: false, error: { code: "owner_released" } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localSubtitleApi: { probeRuntime: vi.fn().mockResolvedValue(failure), listManagedResources: vi.fn().mockResolvedValue(failure), getSessionSnapshot: vi.fn().mockResolvedValue(failure) } } });
    expect(await call("get_local_transcription_status")).toEqual({ success: false, error: "owner_released" });
  });
  it("only updates local transcription preferences and never consumes input authority", async () => {
    const originalInputs = useLocalSubtitleTranscriberStore.getState().draftInputFiles;
    expect(await call("configure_local_transcription", { language: "ja", outputFormats: ["SRT", "LRC"] })).toMatchObject({ success: true, data: { executionStatus: "configured", route: "/tools/subtitle/local-transcriber" } });
    expect(useLocalSubtitleTranscriberStore.getState().preferences.language).toBe("ja");
    expect(useLocalSubtitleTranscriberStore.getState().draftInputFiles).toBe(originalInputs);
  });
  it("returns bounded matched summaries and review state without raw library evidence", async () => {
    const entry = { id: documentId, revision: 2, title: "Test term", collectionId, state: "ready", kind: "term", scope: { languagePair: { source: "ja", target: "zh-Hans" } }, payload: { source: "source", target: "x".repeat(800) }, evidence: [{ sourceId: "private-evidence" }] };
    knowledge.read.mockResolvedValueOnce({ ok: true, value: { generation: 1, approvals: {}, data: { entries: [entry, entry], collections: [{ id: collectionId, name: "Test collection", archived: false }], recipes: [], sources: [{ excerpt: "PRIVATE RAW EVIDENCE" }] } } });
    const result = await call("search_translation_knowledge", { query: "Test", limit: 1 });
    expect(result.data.entries).toHaveLength(1); expect(result.data.entries[0].state).toBe("unconfirmed");
    expect(result.data.entries[0].summary.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE RAW EVIDENCE|private-evidence/);
  });
});

describe("settings follow the Studio", () => {
  afterEach(() => { (translationDraftMemory as unknown as { previous?: unknown }).previous = undefined; });
  it("prepares translation with the last translation dialog settings unless the user named them", async () => {
    translationDraftMemory.remember(undefined, undefined, { profileId: "task-profile", language: "ja", instructions: "Keep honorifics.",
      contextWindow: "16384", maxOutputTokens: "2048", maxBatchCues: "20", selection: emptySelection("ja"), documentTopicIds: [], cueIds: [] });
    const result = await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }], maxBatchCues: 10 });
    expect(api.planTranslationBatch).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({
      language: "ja", instructions: "Keep honorifics.", contextWindow: 16384, maxOutputTokens: 2048, maxBatchCues: 10 }) }));
    expect(result.data.appliedSettings).toMatchObject({ model: { source: "tool_page" }, targetLanguage: { value: "ja", source: "tool_page" },
      maxBatchCues: { value: 10, source: "user" }, contextWindow: { value: 16384, source: "tool_page" } });
  });
  it("falls back to the translation dialog defaults without a draft", async () => {
    const result = await call("prepare_studio_translation", { documents: [{ documentId, revision: 1 }] });
    expect(api.planTranslationBatch).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ contextWindow: 32768, maxOutputTokens: 4096, maxBatchCues: 32 }) }));
    expect(result.data.appliedSettings).toMatchObject({ model: { source: "default" }, maxBatchCues: { source: "default" } });
  });
  it("keeps the Studio transcription task mode and prompt when they are omitted", async () => {
    mocks.state.config = { ...mocks.state.config, taskMode: "translate_to_english", advanced: { ...mocks.state.config.advanced, initialPrompt: "Names: Phaethon." } };
    await call("prepare_studio_transcription", { language: "ja" });
    expect(mocks.controller.setConfig).toHaveBeenCalledWith(expect.objectContaining({ language: "ja", taskMode: "translate_to_english",
      advanced: expect.objectContaining({ initialPrompt: "Names: Phaethon." }) }));
  });
});
