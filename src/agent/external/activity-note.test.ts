import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityNote } from "./activity";
import { deriveNote, summaryOf } from "./activity-note";
import { confirmed, pathItem, resetExternalConfirmations, useExternalConfirmationsStore } from "./confirmations";
import type { ExternalTrust } from "./contract";
import { useExternalAgentStore } from "./store";

const originalWindow = globalThis.window;
const report = vi.fn();
const ctx = (note: ActivityNote, signal = new AbortController().signal) => ({ sessionId: "s1", client: { name: "claude-code", version: "2" }, signal, note });
const translation = { action: "translation" as const, summary: "write_translations" as const, values: { count: 2, document: "ep01.srt", track: "claude-code" }, items: [{ text: "早上好" }, { text: "天气真好" }] };
const trust = (value: ExternalTrust) => useExternalAgentStore.setState({ status: { enabled: true, state: "running", port: 1, trust: value, sessions: [] }, activity: {} });
const pending = () => useExternalConfirmationsStore.getState().requests.filter(item => item.status === "pending");

beforeEach(() => {
  resetExternalConfirmations();
  report.mockClear();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { externalAgent: { requestAttention: vi.fn(), reportActivity: report } } });
  trust("confirm_writes");
});
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });

describe("activity notes", () => {
  it("say how each call was allowed", async () => {
    const run = async (note: ActivityNote, decide?: (id: string) => void) => {
      const call = confirmed(ctx(note), "write_studio_translations", translation, async () => "done");
      if (decide) { await vi.waitFor(() => expect(pending()).toHaveLength(1)); decide(pending()[0].id); }
      return call.catch(error => error.code);
    };
    const asked: ActivityNote = {};
    await run(asked, id => useExternalConfirmationsStore.getState().decide(id, true, { allowSession: true }));
    expect(asked.approval).toBe("confirmed");
    const granted: ActivityNote = {};
    await run(granted);
    expect(granted.approval).toBe("session");
    const declined: ActivityNote = {};
    resetExternalConfirmations();
    expect(await run(declined, id => useExternalConfirmationsStore.getState().decide(id, false))).toBe("declined_by_user");
    expect(declined.approval).toBe("declined");
    trust("auto");
    const automatic: ActivityNote = {};
    await run(automatic);
    expect(automatic.approval).toBe("auto");
    trust("read_only");
    const refused: ActivityNote = {};
    expect(await run(refused)).toBe("read_only");
    expect(refused.approval).toBe("read_only");
  });

  it("keep names and paths but never cue text", async () => {
    trust("auto");
    const note: ActivityNote = {};
    await confirmed(ctx(note), "write_studio_translations", translation, async () => "done");
    expect(note.summary).toEqual({ action: "translation", key: "write_translations", values: { count: 2, document: "ep01.srt", track: "claude-code" } });
    expect(JSON.stringify(note)).not.toContain("早上好");
    const split = summaryOf({ action: "structure", summary: "split_cue", values: { document: "ep01.srt", number: 2, at: "00:00:02.270" }, items: [{ text: "いい", detail: "00:00:02.000 → 00:00:02.270" }] });
    expect(split.items).toBeUndefined();
    expect(JSON.stringify(split)).not.toContain("いい");
    const many = summaryOf({ action: "files", summary: "convert_source", values: { count: 25, format: "SRT" }, items: Array.from({ length: 25 }, (_, index) => pathItem(`D:\\subs\\${index}.ass`)) });
    expect(many.items).toHaveLength(20);
    expect(many.more).toBe(5);
    expect(many.items?.[0]).toEqual({ text: "0.ass", detail: "D:\\subs\\0.ass" });
  });

  it("report the outcome of a call that answered before the user decided", async () => {
    const note: ActivityNote = {};
    const call = confirmed(ctx(note), "rename_paths", { action: "rename", summary: "rename_paths", values: { count: 1 }, items: [{ text: "Episode 1.mp4", from: "第1話.mp4" }] },
      async () => ({ renamed: 1, journalId: "journal-1" }), { waitMs: 10 });
    await expect(call).rejects.toMatchObject({ code: "confirmation_pending" });
    expect(note.confirmationId).toBe(pending()[0].id);
    useExternalConfirmationsStore.getState().decide(pending()[0].id, true);
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(report).toHaveBeenCalledWith({ confirmationId: note.confirmationId, status: "ok", note: { result: { renamed: 1 }, undo: { kind: "rename", journalId: "journal-1" } } });

    const declined: ActivityNote = {};
    await expect(confirmed(ctx(declined), "rename_paths", { action: "rename", summary: "rename_paths", values: { count: 1 }, items: [] }, async () => 1, { waitMs: 10 })).rejects.toMatchObject({ code: "confirmation_pending" });
    useExternalConfirmationsStore.getState().decide(pending()[0].id, false);
    expect(report).toHaveBeenLastCalledWith({ confirmationId: declined.confirmationId, status: "declined" });

    const failing: ActivityNote = {};
    await expect(confirmed(ctx(failing), "convert_subtitle_files", { action: "files", summary: "convert_source", values: { count: 1, format: "SRT" }, items: [] },
      async () => { throw new Error("disk full"); }, { waitMs: 10 })).rejects.toMatchObject({ code: "confirmation_pending" });
    useExternalConfirmationsStore.getState().decide(pending()[0].id, true);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3));
    expect(report).toHaveBeenLastCalledWith({ confirmationId: failing.confirmationId, status: "failed", error: "tool_failed", note: { reason: "disk full" } });
  });

  it("read results and references from each tool's answer", () => {
    expect(deriveNote("write_studio_translations", { written: 12, unchanged: 0, document: { documentId: "d1", name: "Ep01.srt" } }))
      .toEqual({ result: { written: 12, unchanged: 0 }, target: { documentId: "d1", documentName: "Ep01.srt" } });
    expect(deriveNote("convert_subtitle_files", { written: 1, total: 3, files: [
      { source: "a.ass", ok: true, output: "D:\\a.srt" }, { source: "b.ass", ok: false, error: "x" }, { source: "c.srt", ok: false, skipped: true, error: "already_srt" },
    ] })).toEqual({ result: { files: 1, skipped: 1, failed: 1 }, outputs: ["D:\\a.srt"] });
    expect(deriveNote("import_studio_subtitles", { importedCount: 1, total: 2, items: [{ ok: true, document: { documentId: "d2", name: "x.srt" } }, { ok: false }] }))
      .toEqual({ result: { imported: 1, total: 2 }, target: { documentId: "d2", documentName: "x.srt" } });
    expect(deriveNote("undo_name_changes", { status: "completed", restored: 3 })).toEqual({ result: { restored: 3 } });
    expect(deriveNote("list_studio_documents", { items: [] })).toEqual({});
    expect(deriveNote("rename_paths", "nonsense")).toEqual({});
  });
});
