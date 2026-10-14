import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cueHistory } from "@/services/subtitle-studio/cue-history";
import { EXTERNAL_TOOLS } from "../catalog";
import { resetExternalConfirmations, useExternalConfirmationsStore } from "../confirmations";
import { useExternalAgentStore } from "../store";
import { forgetKnownRevisions } from "./studio";
import { addedCueId, clock, insertStudioCue, splitStudioCue } from "./structure";

const DOC = "00000000-0000-4000-8000-000000000001";
const TRACK = "00000000-0000-4000-8000-0000000000a1";
const OWN = "00000000-0000-4000-8000-0000000000a2";
const CUE1 = "00000000-0000-4000-8000-0000000000c1";
const CUE2 = "00000000-0000-4000-8000-0000000000c2";
const NEW = "00000000-0000-4000-8000-0000000000d1";
const text = (plain: string) => ({ plain, spans: [{ text: plain, marks: [] }] });
const summary = (revision = 3) => ({ id: DOC, revision, origin: { displayName: "Episode 01.srt", format: "srt" }, capabilities: { translate: true }, cueCount: 2, translationStatus: "partial" });
const page = () => ({
  summary: summary(), offset: 0, tasks: [],
  cues: [
    { id: CUE1, sourceRevision: 1, timing: { startMs: 1000, endMs: 3000 }, source: text("おはよう。いい天気だね。") },
    { id: CUE2, sourceRevision: 1, timing: { startMs: 5000, endMs: 6000 }, source: text("そうだね") },
  ],
  translationTracks: [
    { id: TRACK, language: "zh", name: "claude-code", revision: 2, origin: "ai", agent: { name: "claude-code" }, entries: {} },
    { id: OWN, language: "en", revision: 1, origin: "ai", entries: {} },
  ],
});
const api = { listDocuments: vi.fn(), readDocumentPage: vi.fn(), editCues: vi.fn(), suggestCueSplit: vi.fn() };
const originalWindow = globalThis.window;
const ctx = () => ({ sessionId: "s1", client: { name: "claude-code", version: "2" }, signal: new AbortController().signal });
const input = <K extends keyof typeof EXTERNAL_TOOLS>(name: K, value: object) => EXTERNAL_TOOLS[name].inputSchema.parse(value) as never;
const trust = (value: "auto" | "confirm_writes" | "read_only") => useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: value, sessions: [] }, activity: {} });

beforeEach(() => {
  vi.clearAllMocks(); forgetKnownRevisions(); resetExternalConfirmations(); cueHistory.clear();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { subtitleStudio: api, externalAgent: { requestAttention: vi.fn() } } });
  trust("auto");
  api.listDocuments.mockResolvedValue({ ok: true, value: { documents: [summary()], total: 1, unavailableDocuments: 0 } });
  api.readDocumentPage.mockImplementation(async ({ revision }) => revision === 3 ? { ok: true, value: page() } : { ok: false, error: "revision_conflict" });
  api.suggestCueSplit.mockResolvedValue({ ok: true, value: { splitMs: 2000, basis: "proportional" } });
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("split_studio_cue", () => {
  it("splits where the second part starts, at the suggested time, as one undo step, and returns the new cue", async () => {
    api.editCues.mockResolvedValue({ ok: true, value: { summary: summary(4), undo: { kind: "batch", operations: [{ kind: "delete", cueIds: [NEW] }, { kind: "timing", changes: {} }] }, changed: 2, stoppedTasks: 0 } });
    const result = await splitStudioCue(input("split_studio_cue", { documentId: DOC, revision: 3, cueId: CUE1, splitBefore: "いい天気",
      translations: { trackId: TRACK, first: "早上好。", second: "天气真好。" } }), ctx());
    expect(api.suggestCueSplit).toHaveBeenCalledWith({ documentId: DOC, revision: 3, cueId: CUE1, offset: 5 });
    expect(api.editCues).toHaveBeenCalledWith({ documentId: DOC, revision: 3, operation: { kind: "split", cueId: CUE1, splitMs: 2000,
      sources: [text("おはよう。"), text("いい天気だね。")], trackId: TRACK, targets: [text("早上好。"), text("天气真好。")] } });
    expect(result).toMatchObject({ revision: 4, cueId: NEW, splitMs: 2000, basis: "proportional" });
    cueHistory.sync(DOC, 4);
    expect(cueHistory.peek("undo", DOC)).toMatchObject({ label: "split", count: 1 });
  });

  it("refuses words not found once, times outside the cue and tracks it did not create, writing nothing", async () => {
    await expect(splitStudioCue(input("split_studio_cue", { documentId: DOC, revision: 3, cueId: CUE1, splitBefore: "こんばんは" }), ctx())).rejects.toMatchObject({ code: "invalid_split" });
    await expect(splitStudioCue(input("split_studio_cue", { documentId: DOC, revision: 3, cueId: CUE1, splitBefore: "。" }), ctx())).rejects.toMatchObject({ code: "invalid_split" });
    await expect(splitStudioCue(input("split_studio_cue", { documentId: DOC, revision: 3, cueId: CUE1, splitBefore: "いい", splitMs: 3000 }), ctx())).rejects.toMatchObject({ code: "invalid_time" });
    await expect(splitStudioCue(input("split_studio_cue", { documentId: DOC, revision: 3, cueId: CUE1, splitBefore: "いい", translations: { trackId: OWN, first: "a", second: "b" } }), ctx()))
      .rejects.toMatchObject({ code: "track_not_writable" });
    await expect(splitStudioCue(input("split_studio_cue", { documentId: DOC, revision: 3, cueId: NEW, splitBefore: "いい" }), ctx())).rejects.toMatchObject({ code: "cue_not_found" });
    await expect(splitStudioCue(input("split_studio_cue", { documentId: DOC, revision: 2, cueId: CUE1, splitBefore: "いい" }), ctx())).rejects.toMatchObject({ code: "revision_conflict", detail: { currentRevision: 3 } });
    expect(api.editCues).not.toHaveBeenCalled();
  });
});

describe("insert_studio_cue", () => {
  it("asks in confirm_writes with what FusionKit read from the call, separately from translation writes", async () => {
    trust("confirm_writes");
    useExternalConfirmationsStore.setState({ grants: { s1: ["studio_translation"] } });
    api.editCues.mockResolvedValue({ ok: true, value: { summary: summary(4), undo: { kind: "delete", cueIds: [NEW] }, changed: 1, stoppedTasks: 0 } });
    const call = insertStudioCue(input("insert_studio_cue", { documentId: DOC, revision: 3, cueId: CUE1, position: "after", startMs: 3200, endMs: 4500, text: "補足の一言" }), ctx());
    await vi.waitFor(() => expect(useExternalConfirmationsStore.getState().requests).toHaveLength(1));
    const request = useExternalConfirmationsStore.getState().requests[0];
    expect(request).toMatchObject({ action: "structure", summary: "insert_cue_after", group: "studio_structure", sessionGrant: true,
      values: { document: "Episode 01.srt", number: 1, time: "00:00:03.200 → 00:00:04.500" }, items: [{ text: "補足の一言" }] });
    useExternalConfirmationsStore.getState().decide(request.id, true, { allowSession: true });
    await expect(call).resolves.toMatchObject({ revision: 4, cueId: NEW });
    expect(api.editCues).toHaveBeenCalledWith({ documentId: DOC, revision: 3, operation: { kind: "insert", cueId: CUE1, position: "after", timing: { startMs: 3200, endMs: 4500 }, source: text("補足の一言") } });
    // Allowed for the connection now: the next structure change runs without asking.
    await insertStudioCue(input("insert_studio_cue", { documentId: DOC, revision: 3, cueId: CUE2, position: "before", startMs: 4000, endMs: 4800, text: "もう一言" }), ctx());
    expect(useExternalConfirmationsStore.getState().requests).toHaveLength(1);
  });

  it("refuses times out of order, a missing end, markup and read-only trust", async () => {
    const refused = async (value: object, code: string) => expect(insertStudioCue(input("insert_studio_cue", { documentId: DOC, revision: 3, cueId: CUE1, position: "after", ...value }), ctx())).rejects.toMatchObject({ code });
    await refused({ startMs: 500, endMs: 900, text: "a" }, "invalid_time");
    await refused({ startMs: 5500, endMs: 5900, text: "a" }, "invalid_time");
    await refused({ startMs: 3200, endMs: null, text: "a" }, "invalid_time");
    await refused({ startMs: 3200, endMs: 3100, text: "a" }, "invalid_time");
    await refused({ startMs: 3200, endMs: 3500, text: "<b>a</b>" }, "invalid_text");
    trust("read_only");
    await refused({ startMs: 3200, endMs: 3500, text: "a" }, "read_only");
    expect(api.editCues).not.toHaveBeenCalled();
  });
});

describe("structure helpers", () => {
  it("formats times and finds the cue an edit added", () => {
    expect(clock(3_723_004)).toBe("01:02:03.004");
    expect(addedCueId({ kind: "delete", cueIds: [NEW] })).toBe(NEW);
    expect(addedCueId({ kind: "batch", operations: [{ kind: "delete", cueIds: [NEW] }, { kind: "timing", changes: {} }] })).toBe(NEW);
    expect(addedCueId({ kind: "timing", changes: {} })).toBeUndefined();
  });
});
