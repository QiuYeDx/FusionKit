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

describe("translation materials card text", async () => {
  const { knowledgeChangesSummary, knowledgeSavedSummary } = await import("./components/AgentKnowledgeChanges");
  const { toolResultSummary } = await import("./components/AgentToolResult");
  const t = ((key: string, values?: Record<string, unknown>) => values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")})` : key) as never;
  const counts = { subjects: 1, collections: 1, created: 2, updated: 0, archived: 0, existing: 1 };
  const items = [
    { key: "entry:0", group: "entries" as const, status: "new" as const, label: "a → b", collectionName: "绝区零 · 人物", warnings: [] },
    { key: "entry:1", group: "entries" as const, status: "new" as const, label: "c → d", collectionName: "绝区零 · 人物", warnings: [] },
    { key: "entry:2", group: "entries" as const, status: "exists" as const, label: "e → f", collectionName: "其他", warnings: [] },
  ];
  it("names the one destination and only the non-zero counts", () => {
    expect(knowledgeChangesSummary({ items, counts, adoptDefault: true, adoptable: 2 }, t)).toBe(
      "home:knowledge_summary_into(collection=绝区零 · 人物,changes=home:knowledge_count_subjects(count=1)home:knowledge_count_separatorhome:knowledge_count_collections(count=1)home:knowledge_count_separatorhome:knowledge_count_created(count=2)home:knowledge_count_separatorhome:knowledge_count_existing(count=1))");
    const twoPlaces = [...items, { ...items[0], key: "entry:3", collectionName: "通用" }];
    expect(knowledgeChangesSummary({ items: twoPlaces, counts: { ...counts, subjects: 0, collections: 0, existing: 0 }, adoptDefault: true, adoptable: 3 }, t)).toBe("home:knowledge_count_created(count=2)");
  });
  it("reports saved, enabled and already-saved results", () => {
    const saved = (result: Record<string, unknown>) => knowledgeSavedSummary(action("k", "completed", { result }), t);
    expect(saved({ executionStatus: "saved", counts: { subjects: 1, created: 2, updated: 1, archived: 0, existing: 4 }, adopted: 3 })).toBe(
      "home:knowledge_saved_enabled(changes=home:knowledge_count_subjects(count=1)home:knowledge_count_separatorhome:knowledge_count_created(count=2)home:knowledge_count_separatorhome:knowledge_count_updated(count=1),enabled=3)");
    expect(saved({ executionStatus: "saved", counts: { created: 1, updated: 0, archived: 0 }, adopted: 0 })).toBe("home:knowledge_saved_review(changes=home:knowledge_count_created(count=1))");
    expect(saved({ executionStatus: "saved", counts: { created: 0, updated: 0, archived: 2 }, adopted: 0 })).toBe("home:knowledge_saved(changes=home:knowledge_count_archived(count=2))");
    expect(saved({ executionStatus: "saved", alreadySaved: true, counts: {} })).toBe("home:knowledge_saved_already");
    expect(knowledgeSavedSummary(action("k", "ready"), t)).toBeUndefined();
  });
  it("summarizes knowledge tool rows by totals rather than the page", () => {
    expect(toolResultSummary({ toolName: "search_translation_knowledge", success: true, data: { entries: [{}], collections: [], pagination: { entries: { total: 12 }, collections: { total: 3 } } } } as never, t))
      .toBe("home:result_knowledge(entries=12,collections=3)");
    expect(toolResultSummary({ toolName: "list_translation_knowledge_catalog", success: true, data: { pagination: { collections: { total: 4 }, subjects: { total: 2 } } } } as never, t))
      .toBe("home:result_knowledge_catalog(collections=4,subjects=2)");
    expect(toolResultSummary({ toolName: "prepare_knowledge_changes", success: true, data: { executionStatus: "unchanged" } } as never, t)).toBe("home:result_knowledge_unchanged");
  });
});

describe("web lookup rows", async () => {
  const { toolResultSummary } = await import("./components/AgentToolResult");
  const { actionErrorMessage } = await import("./components/action-error");
  const t = ((key: string, values?: Record<string, unknown>) => values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")})` : key) as never;
  it("names the source and the page read", () => {
    expect(toolResultSummary({ toolName: "web_search", success: true, data: { source: "moegirl", results: [{}, {}] } } as never, t)).toBe("home:result_web_search(source=home:web_source_moegirl,count=2)");
    expect(toolResultSummary({ toolName: "web_read", success: true, data: { url: "https://www.example.com/a", title: "绝区零", site: "example.com" } } as never, t)).toBe("home:result_web_read(title=绝区零,site=example.com)");
  });
  it("explains each lookup failure", () => {
    for (const code of ["web_lookup_disabled", "web_source_disabled", "web_source_unconfigured", "web_lookup_failed", "web_lookup_timeout", "web_lookup_blocked", "web_lookup_not_found"])
      expect(actionErrorMessage(code, t)).toMatch(/^home:action_error_web_/);
  });
});

describe("consistency check rows", async () => {
  const { toolResultSummary } = await import("./components/AgentToolResult");
  const t = ((key: string, values?: Record<string, unknown>) => values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")})` : key) as never;
  it("summarizes the groups found, not as a revision", () => {
    expect(toolResultSummary({ toolName: "studio_check_consistency", success: true, data: { status: "awaiting_user_review", groups: 2, checkedLines: 40 } } as never, t)).toBe("home:result_consistency(count=2,checked=40)");
    expect(toolResultSummary({ toolName: "studio_check_consistency", success: true, data: { status: "awaiting_user_review", groups: 0, checkedLines: 40 } } as never, t)).toBe("home:result_consistency_none(checked=40)");
  });
});
