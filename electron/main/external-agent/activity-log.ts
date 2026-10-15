import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVITY_CHANGE_LIMIT,
  ACTIVITY_LINE_LIMIT_BYTES,
  ACTIVITY_PAGE_LIMIT,
  ACTIVITY_READ_LIMIT,
  ACTIVITY_RETENTION_MS,
  compareNewestFirst,
  isChange,
  isProblem,
  matchesFilter,
  type ActivityClient,
  type ActivityListPage,
  type ActivityListRequest,
  type ActivityNote,
  type ActivityRecord,
  type ActivitySession,
  type ActivitySessionSummary,
  type ActivityUpdate,
} from "../../../src/agent/external/activity";
import type { ExternalActivityEvent } from "../../../src/agent/external/contract";

type Line =
  | ({ t: "call" } & ActivityRecord)
  | { t: "update"; id: string; status: ActivityRecord["status"]; error?: string; approval?: ActivityRecord["approval"]; endedAt: number; note?: ActivityRecord["note"] }
  | ({ t: "session" } & ActivitySession)
  | { t: "end"; id: string; endedAt: number }
  | { t: "undone"; id: string };

const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
const time = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const client = (value: unknown): ActivityClient | undefined => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const name = text(record?.name, 100);
  return name ? { name, version: text(record?.version, 50) ?? "" } : undefined;
};

/** Keeps a record line within the size limit by dropping detail first, then the note. */
function bounded(record: ActivityRecord): ActivityRecord {
  const fits = (value: ActivityRecord) => Buffer.byteLength(JSON.stringify({ t: "call", ...value })) <= ACTIVITY_LINE_LIMIT_BYTES;
  if (fits(record)) return record;
  const note = record.note;
  if (note) {
    const summary = note.summary ? { ...note.summary, items: undefined, more: (note.summary.items?.length ?? 0) + (note.summary.more ?? 0) } : undefined;
    const lighter: ActivityRecord = { ...record, note: { ...note, ...(summary ? { summary } : {}), outputs: note.outputs?.slice(0, 3) } };
    if (fits(lighter)) return lighter;
  }
  const { note: _dropped, ...bare } = record;
  return bare;
}

/**
 * The record of external agents' calls: `<userData>/external-agent/activity.jsonl`,
 * one event per line, appended as calls finish and compacted on load or when it
 * grows. Writing never blocks or fails a call.
 */
export class ActivityLog {
  private records = new Map<string, ActivityRecord>();
  private sessions = new Map<string, ActivitySession>();
  private writes: Promise<void> = Promise.resolve();
  private lines = 0;
  private warned = false;

  constructor(private readonly directory: string, private readonly options: {
    now?: () => number;
    onEvent?: (event: ExternalActivityEvent) => void;
  } = {}) {}

  get file() { return path.join(this.directory, "activity.jsonl"); }
  private now() { return this.options.now?.() ?? Date.now(); }

  /** Reads the file, skipping damaged lines, then drops what is past keeping. */
  async load(liveSessionIds: ReadonlySet<string> = new Set()): Promise<void> {
    let content = "";
    try { content = await readFile(this.file, "utf8"); } catch { content = ""; }
    let lines = 0;
    for (const raw of content.split("\n")) {
      if (!raw.trim()) continue;
      lines++;
      if (Buffer.byteLength(raw) > ACTIVITY_LINE_LIMIT_BYTES + 1024) continue;
      let line: unknown;
      try { line = JSON.parse(raw); } catch { continue; }
      this.apply(line);
    }
    this.lines = lines;
    const pruned = this.prune(liveSessionIds);
    if (pruned || this.lines !== this.records.size + this.sessions.size) await this.rewrite();
  }

  private apply(input: unknown): void {
    if (!input || typeof input !== "object") return;
    const line = input as Record<string, unknown>;
    const id = text(line.id, 200);
    if (!id) return;
    if (line.t === "session") {
      const who = client(line.client); const connectedAt = time(line.connectedAt);
      if (who && connectedAt !== undefined) this.sessions.set(id, { id, client: who, connectedAt, ...(time(line.endedAt) !== undefined ? { endedAt: time(line.endedAt) } : {}) });
    } else if (line.t === "end") {
      const session = this.sessions.get(id); const endedAt = time(line.endedAt);
      if (session && endedAt !== undefined) session.endedAt = endedAt;
    } else if (line.t === "call") {
      const who = client(line.client); const startedAt = time(line.startedAt); const sessionId = text(line.sessionId, 200); const tool = text(line.tool, 100);
      if (!who || startedAt === undefined || !sessionId || !tool) return;
      const { t: _type, ...record } = line;
      this.records.set(id, { ...(record as unknown as ActivityRecord), id, client: who, sessionId, tool, startedAt });
    } else if (line.t === "update") {
      const record = this.records.get(id);
      if (!record) return;
      const { t: _type, id: _id, note, ...change } = line as Extract<Line, { t: "update" }>;
      this.records.set(id, { ...record, ...change, ...(note ? { note: { ...record.note, ...note } } : {}) });
    } else if (line.t === "undone") {
      const record = this.records.get(id);
      if (record) record.undone = true;
    }
  }

  /** 30 days; the newest changes and reads up to their limits; sessions nothing refers to. */
  private prune(liveSessionIds: ReadonlySet<string>): boolean {
    const before = this.records.size + this.sessions.size;
    const oldest = this.now() - ACTIVITY_RETENTION_MS;
    const sorted = [...this.records.values()].sort(compareNewestFirst);
    let changes = 0, reads = 0;
    for (const record of sorted) {
      const keep = record.startedAt >= oldest && (isChange(record) ? ++changes <= ACTIVITY_CHANGE_LIMIT : ++reads <= ACTIVITY_READ_LIMIT);
      if (!keep) this.records.delete(record.id);
    }
    const referenced = new Set([...this.records.values()].map(record => record.sessionId));
    for (const session of this.sessions.values()) {
      const recent = (session.endedAt ?? session.connectedAt) >= oldest;
      if (!liveSessionIds.has(session.id) && !referenced.has(session.id) && !recent) this.sessions.delete(session.id);
    }
    return this.records.size + this.sessions.size !== before;
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.writes.then(work).catch(error => {
      if (!this.warned) { this.warned = true; console.warn("[external-agent] activity record not written:", error instanceof Error ? error.message : error); }
    });
    this.writes = next;
    return next;
  }

  private append(line: Line): Promise<void> {
    this.lines++;
    const serialized = `${JSON.stringify(line)}\n`;
    const write = this.queue(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(this.file, serialized, { encoding: "utf8", mode: 0o600 });
    });
    // Compact once the file carries a tenth more lines than it needs.
    const needed = this.records.size + this.sessions.size;
    if (this.lines > needed * 1.1 + 100 || this.overLimits()) return write.then(() => { this.prune(new Set(this.liveIds)); return this.rewrite(); });
    return write;
  }

  private overLimits(): boolean {
    let changes = 0, reads = 0;
    for (const record of this.records.values()) if (isChange(record)) changes++; else reads++;
    return changes > ACTIVITY_CHANGE_LIMIT * 1.1 || reads > ACTIVITY_READ_LIMIT * 1.1;
  }

  private liveIds: string[] = [];

  /** Writes the current state as a fresh file. */
  private rewrite(): Promise<void> {
    return this.queue(async () => {
      await mkdir(this.directory, { recursive: true });
      const body = [
        ...[...this.sessions.values()].map(session => JSON.stringify({ t: "session", ...session })),
        ...[...this.records.values()].sort((a, b) => a.startedAt - b.startedAt).map(record => JSON.stringify({ t: "call", ...record })),
      ].map(line => `${line}\n`).join("");
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.lines = this.records.size + this.sessions.size;
    });
  }

  /** Follows the live connections: new ones start, missing ones end. */
  syncSessions(live: ReadonlyArray<{ id: string; client: ActivityClient; connectedAt: number }>): void {
    this.liveIds = live.map(session => session.id);
    const ids = new Set(this.liveIds);
    for (const session of live) {
      if (this.sessions.has(session.id)) continue;
      const started: ActivitySession = { id: session.id, client: { name: session.client.name.slice(0, 100), version: session.client.version.slice(0, 50) }, connectedAt: session.connectedAt };
      this.sessions.set(session.id, started);
      void this.append({ t: "session", ...started });
    }
    for (const session of this.sessions.values()) {
      if (session.endedAt === undefined && !ids.has(session.id)) {
        session.endedAt = this.now();
        void this.append({ t: "end", id: session.id, endedAt: session.endedAt });
      }
    }
  }

  record(input: ActivityRecord): ActivityRecord {
    const record = bounded(input);
    if (!this.sessions.has(record.sessionId)) {
      const session: ActivitySession = { id: record.sessionId, client: record.client, connectedAt: record.startedAt };
      this.sessions.set(session.id, session);
      void this.append({ t: "session", ...session });
    }
    this.records.set(record.id, record);
    void this.append({ t: "call", ...record });
    this.options.onEvent?.({ type: "record", record });
    return record;
  }

  /** A call that waited for the user settled; only that call's pending record changes. */
  settle(update: ActivityUpdate): ActivityRecord | null {
    const record = [...this.records.values()].find(item => item.confirmationId === update.confirmationId && item.status === "pending");
    if (!record) return null;
    const approval = update.status === "declined" ? "declined" : update.status === "expired" ? "expired" : "confirmed";
    const note: ActivityNote | undefined = update.note ? { ...record.note, ...update.note } : record.note;
    const next = bounded({ ...record, status: update.status, approval, endedAt: this.now(),
      ...(update.error ? { error: update.error } : {}), ...(note ? { note } : {}) });
    this.records.set(record.id, next);
    void this.append({ t: "update", id: record.id, status: next.status, approval, endedAt: next.endedAt!, ...(next.error ? { error: next.error } : {}), ...(next.note ? { note: next.note } : {}) });
    this.options.onEvent?.({ type: "record", record: next });
    return next;
  }

  markUndone(id: string): ActivityRecord | null {
    const record = this.records.get(id);
    if (!record || record.undone || record.note?.undo?.kind !== "rename") return null;
    record.undone = true;
    void this.append({ t: "undone", id });
    this.options.onEvent?.({ type: "record", record });
    return record;
  }

  list(request: ActivityListRequest): ActivityListPage {
    const limit = Math.min(request.limit ?? 100, ACTIVITY_PAGE_LIMIT);
    const before = request.before;
    const matching = [...this.records.values()]
      .filter(record => (!request.sessionId || record.sessionId === request.sessionId) && matchesFilter(record, request.filter))
      .filter(record => !before || compareNewestFirst(record, { startedAt: before.at, id: before.id }) > 0)
      .sort(compareNewestFirst);
    const records = matching.slice(0, limit);
    const last = records.at(-1);
    return { records, ...(matching.length > limit && last ? { next: { at: last.startedAt, id: last.id } } : {}) };
  }

  sessionSummaries(liveSessionIds: ReadonlySet<string>): ActivitySessionSummary[] {
    const counts = new Map<string, { changes: number; problems: number; lastAt?: number }>();
    for (const record of this.records.values()) {
      const count = counts.get(record.sessionId) ?? { changes: 0, problems: 0 };
      if (isChange(record)) count.changes++;
      if (isProblem(record)) count.problems++;
      count.lastAt = Math.max(count.lastAt ?? 0, record.startedAt);
      counts.set(record.sessionId, count);
    }
    return [...this.sessions.values()]
      .map(session => ({ ...session, live: liveSessionIds.has(session.id), ...(counts.get(session.id) ?? { changes: 0, problems: 0 }) }))
      .sort((a, b) => Number(b.live) - Number(a.live) || (b.lastAt ?? b.connectedAt) - (a.lastAt ?? a.connectedAt));
  }

  /** Forgets every call and every ended connection; live connections stay. */
  async clear(liveSessionIds: ReadonlySet<string>): Promise<void> {
    this.records.clear();
    for (const id of [...this.sessions.keys()]) if (!liveSessionIds.has(id)) this.sessions.delete(id);
    await this.rewrite();
    this.options.onEvent?.({ type: "cleared" });
  }

  /** Waits for pending writes (tests, shutdown). */
  flush(): Promise<void> { return this.writes; }
}
