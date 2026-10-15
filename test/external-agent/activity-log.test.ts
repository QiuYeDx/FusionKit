import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "../../electron/main/external-agent/activity-log";
import { ACTIVITY_CHANGE_LIMIT, ACTIVITY_LINE_LIMIT_BYTES, ACTIVITY_READ_LIMIT, ACTIVITY_RETENTION_MS, type ActivityRecord } from "../../src/agent/external/activity";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 12);
const client = { name: "claude-code", version: "2.1.0" };
let directory: string;
let sequence = 0;
/** Every log a test opened: their writes finish before the folder goes. */
let opened: ActivityLog[] = [];
function track(log: ActivityLog): ActivityLog { opened.push(log); return log; }

function call(change: Partial<ActivityRecord> = {}): ActivityRecord {
  sequence++;
  return { id: `r${sequence}`, sessionId: "s1", client, tool: "write_studio_translations", access: "write", startedAt: NOW - 1000 + sequence, endedAt: NOW, status: "ok", ...change };
}
const lines = async () => (await readFile(path.join(directory, "activity.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "fusionkit-activity-")); sequence = 0; });
afterEach(async () => {
  await Promise.all(opened.map(log => log.flush()));
  opened = [];
  await rm(directory, { recursive: true, force: true });
});

describe("external agent activity log", () => {
  it("appends calls and connections and reads them back after a restart, newest first", async () => {
    const events: unknown[] = [];
    const log = track(new ActivityLog(directory, { now: () => NOW, onEvent: event => events.push(event) }));
    await log.load();
    log.syncSessions([{ id: "s1", client, connectedAt: NOW - 5000 }]);
    const read = log.record(call({ tool: "read_studio_document", access: "read", approval: "none" }));
    const write = log.record(call({ approval: "session", note: { summary: { action: "translation", key: "write_translations", values: { count: 12, document: "Ep01.srt", track: "claude-code" } }, result: { written: 12 } } }));
    log.syncSessions([]);
    await log.flush();
    expect(events).toEqual([{ type: "record", record: read }, { type: "record", record: write }]);

    const reloaded = track(new ActivityLog(directory, { now: () => NOW }));
    await reloaded.load();
    expect(reloaded.list({ filter: "all" }).records.map(record => record.id)).toEqual([write.id, read.id]);
    expect(reloaded.list({ filter: "changes" }).records).toEqual([write]);
    expect(reloaded.sessionSummaries(new Set())).toEqual([{ id: "s1", client, connectedAt: NOW - 5000, endedAt: NOW, live: false, changes: 1, problems: 0, lastAt: write.startedAt }]);
  });

  it("filters problems and pages with a stable cursor", async () => {
    const log = track(new ActivityLog(directory, { now: () => NOW }));
    await log.load();
    const records = Array.from({ length: 5 }, (_, index) => log.record(call({ startedAt: NOW - 100 + (index % 2) })));
    const declined = log.record(call({ status: "declined", approval: "declined" }));
    const refused = log.record(call({ status: "failed", error: "read_only", approval: "read_only" }));
    expect(log.list({ filter: "problems" }).records.map(record => record.id).sort()).toEqual([declined.id, refused.id].sort());
    const first = log.list({ filter: "all", limit: 3 });
    const second = log.list({ filter: "all", limit: 3, before: first.next });
    const third = log.list({ filter: "all", limit: 3, before: second.next });
    const ids = [...first.records, ...second.records, ...third.records].map(record => record.id);
    expect(new Set(ids).size).toBe(7);
    expect(third.next).toBeUndefined();
    expect(ids).toEqual(expect.arrayContaining(records.map(record => record.id)));
  });

  it("settles a call that waited for the user, and only that pending call", async () => {
    const log = track(new ActivityLog(directory, { now: () => NOW }));
    await log.load();
    const waiting = log.record(call({ status: "pending", approval: "none", confirmationId: "confirm-1", note: { summary: { action: "rename", key: "rename_paths", values: { count: 3 } } } }));
    expect(log.settle({ confirmationId: "confirm-x", status: "ok" })).toBeNull();
    const settled = log.settle({ confirmationId: "confirm-1", status: "ok", note: { result: { renamed: 3 }, undo: { kind: "rename", journalId: "j1" } } });
    expect(settled).toMatchObject({ id: waiting.id, status: "ok", approval: "confirmed", note: { summary: { key: "rename_paths" }, result: { renamed: 3 }, undo: { journalId: "j1" } } });
    // Settling again is not possible: the call is no longer pending.
    expect(log.settle({ confirmationId: "confirm-1", status: "declined" })).toBeNull();
    expect(log.markUndone(waiting.id)).toMatchObject({ undone: true });
    expect(log.markUndone(waiting.id)).toBeNull();
    await log.flush();
    const reloaded = track(new ActivityLog(directory, { now: () => NOW }));
    await reloaded.load();
    expect(reloaded.list({ filter: "all" }).records[0]).toMatchObject({ status: "ok", approval: "confirmed", undone: true, note: { result: { renamed: 3 } } });
    // Loading folded the update lines into the call.
    expect((await lines()).filter(line => line.t === "call")).toHaveLength(1);
    expect((await lines()).some(line => line.t === "update" || line.t === "undone")).toBe(false);
  });

  it("keeps 30 days, the newest changes and reads up to their limits, and skips damaged lines", async () => {
    await mkdir(directory, { recursive: true });
    const old = { t: "call", ...call({ startedAt: NOW - ACTIVITY_RETENTION_MS - DAY }) };
    const changes = Array.from({ length: ACTIVITY_CHANGE_LIMIT + 300 }, (_, index) => ({ t: "call", ...call({ startedAt: NOW - 10 * DAY + index }) }));
    const reads = Array.from({ length: ACTIVITY_READ_LIMIT + 200 }, (_, index) => ({ t: "call", ...call({ access: "read", tool: "list_studio_documents", startedAt: NOW - 10 * DAY + index }) }));
    const long = JSON.stringify({ t: "call", ...call({ note: { reason: "x" } }), padding: "y".repeat(ACTIVITY_LINE_LIMIT_BYTES * 2) });
    const body = [JSON.stringify(old), ...changes.map(line => JSON.stringify(line)), ...reads.map(line => JSON.stringify(line)), "{not json", long, JSON.stringify({ t: "call", id: "no-session" })].join("\n");
    await writeFile(path.join(directory, "activity.jsonl"), body);

    const log = track(new ActivityLog(directory, { now: () => NOW }));
    await log.load();
    const kept = log.list({ filter: "changes", limit: 200 });
    expect(kept.records[0].startedAt).toBe(changes.at(-1)!.startedAt);
    let all = 0, cursor = kept.next, page = kept.records.length;
    all += page;
    while (cursor) { const next = log.list({ filter: "changes", limit: 200, before: cursor }); all += next.records.length; cursor = next.next; }
    expect(all).toBe(ACTIVITY_CHANGE_LIMIT);
    const written = await lines();
    expect(written.filter(line => line.access === "read")).toHaveLength(ACTIVITY_READ_LIMIT);
    expect(written.filter(line => line.access !== "read")).toHaveLength(ACTIVITY_CHANGE_LIMIT);
    expect(written.some(line => line.id === old.id)).toBe(false);
  });

  it("shortens a record that would not fit one line instead of losing it", async () => {
    const log = track(new ActivityLog(directory, { now: () => NOW }));
    await log.load();
    const items = Array.from({ length: 20 }, (_, index) => ({ text: `file-${index}.srt`, detail: `C:\\${"long\\".repeat(55)}file-${index}.srt` }));
    const record = log.record(call({ note: { summary: { action: "files", key: "convert_source", values: { count: 20, format: "SRT" }, items }, outputs: items.map(item => item.detail) } }));
    expect(record.note?.summary?.items).toBeUndefined();
    expect(record.note?.summary?.more).toBe(20);
    await log.flush();
    for (const line of (await readFile(path.join(directory, "activity.jsonl"), "utf8")).trim().split("\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(ACTIVITY_LINE_LIMIT_BYTES);
  });

  it("clears every call and ended connection but keeps the live one", async () => {
    const events: unknown[] = [];
    const log = track(new ActivityLog(directory, { now: () => NOW, onEvent: event => events.push(event) }));
    await log.load();
    log.syncSessions([{ id: "s1", client, connectedAt: NOW }, { id: "s2", client: { name: "codex", version: "1" }, connectedAt: NOW }]);
    log.record(call());
    log.syncSessions([{ id: "s1", client, connectedAt: NOW }]);
    await log.clear(new Set(["s1"]));
    expect(events.at(-1)).toEqual({ type: "cleared" });
    expect(log.list({ filter: "all" }).records).toEqual([]);
    expect(log.sessionSummaries(new Set(["s1"])).map(session => session.id)).toEqual(["s1"]);
    log.record(call());
    await log.flush();
    const reloaded = track(new ActivityLog(directory, { now: () => NOW }));
    await reloaded.load(new Set(["s1"]));
    expect(reloaded.list({ filter: "all" }).records).toHaveLength(1);
    expect(reloaded.sessionSummaries(new Set(["s1"])).map(session => session.id)).toEqual(["s1"]);
  });

  it("keeps working when the file cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A file where the directory should be: every write fails.
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "");
    const log = track(new ActivityLog(blocked, { now: () => NOW }));
    await log.load();
    const record = log.record(call());
    await log.flush();
    expect(log.list({ filter: "all" }).records).toEqual([record]);
    expect(warn).toHaveBeenCalledTimes(1);
    log.record(call());
    await log.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
