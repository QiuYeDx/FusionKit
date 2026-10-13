import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cueHistory } from "@/services/subtitle-studio/cue-history";
import { EXTERNAL_TOOLS } from "../catalog";
import { resetExternalConfirmations, useExternalConfirmationsStore } from "../confirmations";
import { useExternalAgentStore } from "../store";
import { readStudioDocument } from "./document";
import { importStudioSubtitles } from "./importing";
import { forgetKnownRevisions } from "./studio";
import { createStudioTranslationTrack, writeStudioTranslations } from "./translation";

const DOC = "00000000-0000-4000-8000-000000000001";
const TRACK = "00000000-0000-4000-8000-0000000000a1";
const OWN = "00000000-0000-4000-8000-0000000000a2";
const CUE1 = "00000000-0000-4000-8000-0000000000c1";
const CUE2 = "00000000-0000-4000-8000-0000000000c2";
const text = (plain: string) => ({ plain, spans: [{ text: plain, marks: [] }] });
const summary = (revision = 3) => ({ id: DOC, revision, origin: { displayName: "Episode 01.srt", format: "srt" }, capabilities: { translate: true }, cueCount: 2, translationStatus: "partial" });
const page = (revision = 3) => ({
  summary: summary(revision), offset: 0, tasks: [],
  cues: [
    { id: CUE1, sourceRevision: 2, timing: { startMs: 1000, endMs: 1800 }, source: text("おはよう") },
    { id: CUE2, sourceRevision: 1, timing: { startMs: 3000, endMs: null }, source: text("いい天気だね") },
  ],
  translationTracks: [
    { id: TRACK, language: "zh", name: "claude-code", revision: 2, origin: "ai", agent: { name: "claude-code" }, entries: { [CUE1]: { sourceRevision: 1, sourceHash: "h", text: text("早上好"), origin: "ai", reviewStatus: "unreviewed" } } },
    { id: OWN, language: "en", revision: 1, origin: "ai", entries: {} },
  ],
});
const api = { listDocuments: vi.fn(), readDocumentPage: vi.fn(), importSubtitlePaths: vi.fn(), createAgentTranslationTrack: vi.fn(), editCues: vi.fn() };
const originalWindow = globalThis.window;
const ctx = () => ({ sessionId: "s1", client: { name: "claude-code", version: "2" }, signal: new AbortController().signal });
const input = <K extends keyof typeof EXTERNAL_TOOLS>(name: K, value: object) => EXTERNAL_TOOLS[name].inputSchema.parse(value) as never;

beforeEach(() => {
  vi.clearAllMocks(); forgetKnownRevisions(); resetExternalConfirmations(); cueHistory.clear();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { subtitleStudio: api, externalAgent: { requestAttention: vi.fn() } } });
  useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: "auto", sessions: [] }, activity: {} });
  api.listDocuments.mockResolvedValue({ ok: true, value: { documents: [summary()], total: 1, unavailableDocuments: 0 } });
  api.readDocumentPage.mockImplementation(async ({ revision }) => revision === 3 ? { ok: true, value: page() } : { ok: false, error: "revision_conflict" });
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("read_studio_document", () => {
  it("finds the current revision, returns cues and the chosen track's translations with stale marks", async () => {
    const result = await readStudioDocument(input("read_studio_document", { documentId: DOC, trackId: TRACK }), ctx());
    expect(api.listDocuments).toHaveBeenCalled();
    expect(result.tracks).toEqual([
      { trackId: TRACK, language: "zh", name: "claude-code", origin: "ai", writtenBy: "claude-code", writable: true },
      { trackId: OWN, language: "en", origin: "ai", writtenBy: null, writable: false },
    ]);
    expect(result.cues).toEqual([
      { cueId: CUE1, index: 0, startMs: 1000, endMs: 1800, text: "おはよう", translation: { text: "早上好", origin: "ai", reviewed: false, stale: true } },
      { cueId: CUE2, index: 1, startMs: 3000, endMs: null, text: "いい天気だね", translation: null },
    ]);
    expect(result.nextOffset).toBeNull();
    // The revision is remembered: the next read needs no search.
    api.listDocuments.mockClear();
    await readStudioDocument(input("read_studio_document", { documentId: DOC, limit: 1 }), ctx());
    expect(api.listDocuments).not.toHaveBeenCalled();
  });

  it("answers document_not_found and track_not_found", async () => {
    await expect(readStudioDocument(input("read_studio_document", { documentId: "00000000-0000-4000-8000-0000000000ff" }), ctx())).rejects.toMatchObject({ code: "document_not_found" });
    await expect(readStudioDocument(input("read_studio_document", { documentId: DOC, trackId: "00000000-0000-4000-8000-0000000000ee" }), ctx())).rejects.toMatchObject({ code: "track_not_found" });
  });
});

describe("import_studio_subtitles", () => {
  it("imports typed paths and reports each file", async () => {
    api.importSubtitlePaths.mockResolvedValue({ ok: true, value: { items: [{ fileName: "a.srt", ok: true, document: summary(1) }, { fileName: "b.srt", ok: false, error: "encoding_required" }] } });
    const result = await importStudioSubtitles(input("import_studio_subtitles", { paths: ["D:/subs"] }), ctx());
    expect(api.importSubtitlePaths).toHaveBeenCalledWith({ encoding: "utf-8", paths: ["D:/subs"] });
    expect(result).toMatchObject({ importedCount: 1, total: 2, items: [{ ok: true, document: { documentId: DOC, revision: 1 } }, { ok: false, name: "b.srt", error: "encoding_required" }] });
    api.importSubtitlePaths.mockResolvedValue({ ok: true, value: { items: [] } });
    await expect(importStudioSubtitles(input("import_studio_subtitles", { paths: ["D:/empty"] }), ctx())).rejects.toMatchObject({ code: "no_subtitles_found" });
  });
});

describe("translation tracks", () => {
  it("creates a track owned by the client and reports conflicts with the current revision", async () => {
    api.createAgentTranslationTrack.mockResolvedValue({ ok: true, value: { summary: summary(4), trackId: TRACK } });
    const result = await createStudioTranslationTrack(input("create_studio_translation_track", { documentId: DOC, revision: 3, language: "zh" }), ctx());
    expect(api.createAgentTranslationTrack).toHaveBeenCalledWith({ documentId: DOC, revision: 3, language: "zh", agent: { name: "claude-code" } });
    expect(result).toMatchObject({ trackId: TRACK, revision: 4 });
    await expect(createStudioTranslationTrack(input("create_studio_translation_track", { documentId: DOC, revision: 2, language: "zh" }), ctx()))
      .rejects.toMatchObject({ code: "revision_conflict", detail: { currentRevision: 3 } });
  });

  it("writes valid batches as one undo step and refuses invalid text, unknown and foreign tracks", async () => {
    api.editCues.mockResolvedValue({ ok: true, value: { summary: summary(5), undo: { kind: "entries", trackId: TRACK, entries: { [CUE2]: null } }, changed: 1, stoppedTasks: 0 } });
    const written = await writeStudioTranslations(input("write_studio_translations", { documentId: DOC, revision: 3, trackId: TRACK,
      translations: [{ cueId: CUE2, text: "  天气真好  \r\n" }] }), ctx());
    expect(api.editCues).toHaveBeenCalledWith({ documentId: DOC, revision: 3, operation: { kind: "agent", trackId: TRACK, targets: { [CUE2]: text("天气真好") } } });
    expect(written).toMatchObject({ revision: 5, written: 1, unchanged: 0 });
    cueHistory.sync(DOC, 5);
    expect(cueHistory.peek("undo")).toEqual({ label: "agent", count: 1, operation: { kind: "entries", trackId: TRACK, entries: { [CUE2]: null } } });

    api.editCues.mockClear();
    await expect(writeStudioTranslations(input("write_studio_translations", { documentId: DOC, revision: 3, trackId: TRACK,
      translations: [{ cueId: CUE1, text: "<b>好</b>" }, { cueId: CUE2, text: "   " }] }), ctx()))
      .rejects.toMatchObject({ code: "invalid_translation_text", detail: { problems: [{ cueId: CUE1, problem: "markup" }, { cueId: CUE2, problem: "empty" }] } });
    await expect(writeStudioTranslations(input("write_studio_translations", { documentId: DOC, revision: 3, trackId: OWN, translations: [{ cueId: CUE1, text: "x" }] }), ctx()))
      .rejects.toMatchObject({ code: "track_not_writable" });
    await expect(writeStudioTranslations(input("write_studio_translations", { documentId: DOC, revision: 3, trackId: "00000000-0000-4000-8000-0000000000ee", translations: [{ cueId: CUE1, text: "x" }] }), ctx()))
      .rejects.toMatchObject({ code: "track_not_found" });
    expect(api.editCues).not.toHaveBeenCalled();
  });

  it("asks before writing in confirm_writes and writes nothing when declined", async () => {
    useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: "confirm_writes", sessions: [] }, activity: {} });
    const call = writeStudioTranslations(input("write_studio_translations", { documentId: DOC, revision: 3, trackId: TRACK, translations: [{ cueId: CUE1, text: "早安" }] }), ctx());
    await vi.waitFor(() => expect(useExternalConfirmationsStore.getState().requests).toHaveLength(1));
    const request = useExternalConfirmationsStore.getState().requests[0];
    expect(request).toMatchObject({ summary: "write_translations", values: { count: 1, document: "Episode 01.srt", track: "claude-code" }, items: [{ text: "早安" }] });
    useExternalConfirmationsStore.getState().decide(request.id, false);
    await expect(call).rejects.toMatchObject({ code: "declined_by_user" });
    expect(api.editCues).not.toHaveBeenCalled();
  });
});
