import { describe, expect, it } from "vitest";
import type { PreparedAction, PreparedActionReceipt } from "@/agent/prepared-actions";
import { actionFailureReceipt, actionReceipt, agentToolPath, groupPreparedActions, hasPreparedAction, readReceipt, taskRows } from "./presentation";

const action = (id: string, status: PreparedAction["status"], extra: Partial<PreparedAction> = {}): PreparedAction => ({ id, status, sessionId: "current", title: id, summary: id, toolKey: "subtitleStudio", ...extra });
const preparation: PreparedActionReceipt = { phase: "preparation", total: 2, successCount: 1, failureCount: 1, items: [
  { id: "ready", name: "第一集.srt", status: "ready" },
  { id: "failed", name: "第二集.srt", status: "failed", error: "revision_conflict" },
] };
const submission: PreparedActionReceipt = { phase: "submission", total: 1, successCount: 1, failureCount: 0, items: [{ id: "task", taskId: "task", name: "第一集.srt", status: "queued" }] };

describe("HomeAgent current work and historical receipts", () => {
  it("keeps two ready actions before twenty terminal receipts and excludes other sessions", () => {
    const actions = Array.from({ length: 20 }, (_, i) => action(`past-${i}`, i === 4 ? "failed" : "completed"));
    actions.push(action("ready-1", "ready"), action("ready-2", "ready"), action("another-session", "ready", { sessionId: "other" }));
    const grouped = groupPreparedActions(actions, "current");
    expect(grouped.active.map(item => item.id)).toEqual(["ready-1", "ready-2"]);
    expect(grouped.history).toHaveLength(20);
    expect(grouped.history[0].id).toBe("past-19");
    expect(grouped.failedCount).toBe(1);
    expect(grouped.latestFailure?.id).toBe("past-4");
  });
  it("retains a preparation failure even when all admitted tasks submit successfully", () => {
    const partial = action("partial", "completed", { preparationReceipt: preparation, result: { receipt: submission } });
    expect(actionReceipt(partial)).toEqual(submission);
    expect(actionFailureReceipt(partial)).toEqual(preparation);
    const grouped = groupPreparedActions([partial], "current");
    expect(grouped.failedCount).toBe(1);
    expect(grouped.latestFailure).toEqual(partial);
  });
  it("orders history by actual resolution time while preserving reverse order for legacy actions", () => {
    const grouped = groupPreparedActions([
      action("slow-first", "failed", { updatedAt: 300 }),
      action("legacy-first", "completed"),
      action("fast-second", "completed", { updatedAt: 200 }),
      action("legacy-second", "completed"),
    ], "current");
    expect(grouped.history.map(item => item.id)).toEqual(["slow-first", "fast-second", "legacy-second", "legacy-first"]);
  });
  it("retains all-failure submission results instead of falling back to preparation", () => {
    const failed: PreparedActionReceipt = { ...submission, successCount: 0, failureCount: 1, items: [{ id: "ready", name: "第一集.srt", status: "failed", error: "access_denied" }] };
    const result = action("failed", "failed", { preparationReceipt: preparation, result: { receipt: failed } });
    expect(actionReceipt(result)).toEqual(failed);
    expect(actionFailureReceipt(result)?.items[0].error).toBe("access_denied");
  });
  it("suppresses duplicate prepared receipts only for a matching action in the current session", () => {
    expect(hasPreparedAction([action("active", "ready")], "current", "active")).toBe(true);
    expect(hasPreparedAction([action("active", "completed")], "current", "active")).toBe(true);
    expect(hasPreparedAction([action("active", "ready")], "imported", "active")).toBe(false);
    expect(hasPreparedAction([], "current", "evicted")).toBe(false);
    expect(hasPreparedAction([action("active", "ready")], "current", undefined)).toBe(false);
  });
  it("rejects malformed receipt shapes without hiding valid per-file failures", () => {
    expect(readReceipt(preparation)).toEqual(preparation);
    expect(readReceipt({ ...preparation, phase: "completed" })).toBeUndefined();
    expect(readReceipt({ ...preparation, successCount: -1 })).toBeUndefined();
    expect(readReceipt({ ...preparation, items: [{ id: "x", name: "x", status: "completed" }] })).toBeUndefined();
    expect(readReceipt({ ...preparation, items: Array.from({ length: 51 }, () => preparation.items[0]) })).toBeUndefined();
  });
});

describe("HomeAgent task state projection", () => {
  it("shows native local progress objects and Studio numeric progress without calling queued work complete", () => {
    const rows = taskRows({ tasks: [
      { name: "A.mkv", status: "transcribing", progress: { overallProgress: 43.4 } },
      { fileName: "B.srt", status: "running", progress: 38.8 },
      { name: "C.srt", status: "queued", progress: 100 },
      { name: "D.mkv", status: "failed", progress: 100, error: { code: "transcription_failed" } },
    ] });
    expect(rows.map(row => [row.status, row.progress, row.error])).toEqual([
      ["transcribing", 43, undefined], ["running", 39, undefined], ["queued", undefined, undefined], ["failed", undefined, "transcription_failed"],
    ]);
  });
  it.each(["preparing_media", "loading_model", "post_processing", "exporting", "cancelling", "interrupted", "needs_configuration", "no_content", "cancelled", "completed"])("preserves the actual %s status", status => {
    expect(taskRows({ items: [{ name: "File", status }] })[0].status).toBe(status);
  });
  it("does not infer success for unknown statuses or invalid progress", () => {
    expect(taskRows({ items: [{ name: "File", status: "future_status", progress: 100 }] })[0].status).toBeUndefined();
    expect(taskRows({ items: [{ name: "File", status: "running", progress: NaN }] })[0].progress).toBeUndefined();
    expect(taskRows({ items: [{ name: "File", status: "running", progress: 130 }] })[0].progress).toBe(100);
  });
});

describe("HomeAgent handoff and draft progress checks", () => {
  it("directs transcription to its workspace and other Studio operations to documents", () => {
    expect(agentToolPath("subtitleStudio", "/tools/subtitle/studio", "prepare_studio_transcription")).toBe("/tools/subtitle/studio?view=transcription");
    expect(agentToolPath("subtitleStudio", "/tools/subtitle/studio", "home:prepared_transcription_summary")).toBe("/tools/subtitle/studio?view=transcription");
    expect(agentToolPath("subtitleStudio", "/tools/subtitle/studio", "get_studio_tasks", "transcription")).toBe("/tools/subtitle/studio?view=transcription");
    expect(agentToolPath("subtitleStudio", "/tools/subtitle/studio", "prepare_studio_translation")).toBe("/tools/subtitle/studio?view=documents");
    expect(agentToolPath("translator", "/tools/subtitle/translator")).toBe("/tools/subtitle/translator");
  });
});
