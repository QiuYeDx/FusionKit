import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteUtf8File } from "../translation/atomic-file";
import {
  agentSessionIdSchema,
  agentSessionMetaSchema,
  MAX_STORED_SESSION_BYTES,
  saveAgentSessionRequestSchema,
  type AgentSessionsError,
  type AgentSessionsResult,
  type StoredAgentSessionMeta,
} from "../../../src/agent/session-store-contract";

// ---------------------------------------------------------------------------
// Agent sessions on disk: <root>/<id>.json in the export format, and index.json
// for the list. Every operation runs in one queue so the index is never written
// by two operations at once. The index is rebuilt from the files when it is
// missing, damaged or out of step with them.
// ---------------------------------------------------------------------------

const INDEX_FILE = "index.json";
const SESSION_FILE = /^([A-Za-z0-9_-]{1,100})\.json$/;

const ok = <T>(value: T): AgentSessionsResult<T> => ({ ok: true, value });
const fail = (error: AgentSessionsError): AgentSessionsResult<never> => ({ ok: false, error });

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** The list entry of a saved file, read from its own content; a file that cannot be read is listed as unreadable. */
function metaFromContent(id: string, content: string, modified: number): StoredAgentSessionMeta {
  try {
    const session = (JSON.parse(content) as { session?: Record<string, unknown> }).session;
    if (!session || session.id !== id || !Array.isArray(session.messages)) throw new Error("invalid");
    const messages = session.messages as { role?: unknown; content?: unknown; event?: unknown }[];
    let preview = "";
    for (let index = messages.length - 1; index >= 0 && !preview; index--) {
      const message = messages[index];
      if (typeof message?.content === "string" && message.content.trim() && (message.role === "assistant" || (message.role === "user" && !message.event))) {
        preview = message.content.replace(/\s+/g, " ").trim().slice(0, 120);
      }
    }
    return agentSessionMetaSchema.parse({
      id,
      title: typeof session.title === "string" ? session.title.slice(0, 200) : "",
      titleSource: session.titleSource === "generated" || session.titleSource === "manual" ? session.titleSource : "auto",
      pinned: session.pinned === true,
      createdAt: typeof session.createdAt === "number" ? session.createdAt : modified,
      updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : modified,
      messageCount: messages.length,
      preview,
    });
  } catch {
    return unreadable(id, modified);
  }
}

function unreadable(id: string, modified: number): StoredAgentSessionMeta {
  return { id, title: "", titleSource: "auto", pinned: false, createdAt: modified, updatedAt: modified, messageCount: 0, preview: "", unreadable: true };
}

export class AgentSessionRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private index: Map<string, StoredAgentSessionMeta> | undefined;

  constructor(readonly root: string) {}

  list(): Promise<AgentSessionsResult<StoredAgentSessionMeta[]>> {
    return this.serial(async () => {
      const index = await this.reconcile();
      return ok([...index.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    });
  }

  load(id: string): Promise<AgentSessionsResult<string>> {
    return this.serial(async () => {
      if (!agentSessionIdSchema.safeParse(id).success) return fail("agent_session_invalid");
      try {
        const stat = await fs.stat(this.file(id));
        if (stat.size > MAX_STORED_SESSION_BYTES) return fail("agent_session_too_large");
        return ok(await fs.readFile(this.file(id), "utf8"));
      } catch (error) {
        return fail(isMissing(error) ? "agent_session_not_found" : "agent_session_unreadable");
      }
    });
  }

  save(request: unknown): Promise<AgentSessionsResult<null>> {
    return this.serial(async () => {
      const parsed = saveAgentSessionRequestSchema.safeParse(request);
      if (!parsed.success) return fail("agent_session_invalid");
      const { meta, content } = parsed.data;
      if (Buffer.byteLength(content, "utf8") > MAX_STORED_SESSION_BYTES) return fail("agent_session_too_large");
      try {
        if ((JSON.parse(content) as { session?: { id?: unknown } }).session?.id !== meta.id) return fail("agent_session_invalid");
      } catch {
        return fail("agent_session_invalid");
      }
      const index = await this.reconcile();
      try {
        await atomicWriteUtf8File(this.file(meta.id), content);
        index.set(meta.id, { ...meta, unreadable: undefined });
        await this.writeIndex(index);
        return ok(null);
      } catch {
        return fail("agent_session_write_failed");
      }
    });
  }

  remove(id: string): Promise<AgentSessionsResult<null>> {
    return this.serial(async () => {
      if (!agentSessionIdSchema.safeParse(id).success) return fail("agent_session_invalid");
      const index = await this.reconcile();
      try {
        await fs.rm(this.file(id), { force: true });
        index.delete(id);
        await this.writeIndex(index);
        return ok(null);
      } catch {
        return fail("agent_session_write_failed");
      }
    });
  }

  clear(): Promise<AgentSessionsResult<null>> {
    return this.serial(async () => {
      try {
        for (const name of await this.readNames()) {
          if (SESSION_FILE.test(name) || name.endsWith(".tmp")) await fs.rm(path.join(this.root, name), { force: true });
        }
        this.index = new Map();
        return ok(null);
      } catch {
        return fail("agent_session_write_failed");
      }
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private file(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  private async readNames(): Promise<string[]> {
    try { return await fs.readdir(this.root); }
    catch (error) { if (isMissing(error)) return []; throw error; }
  }

  /** The index, checked against the files on disk the first time it is needed. */
  private async reconcile(): Promise<Map<string, StoredAgentSessionMeta>> {
    if (this.index) return this.index;
    const stored = new Map<string, StoredAgentSessionMeta>();
    let indexValid = true;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.root, INDEX_FILE), "utf8")) as { version?: unknown; sessions?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error("invalid index");
      for (const entry of parsed.sessions) {
        const meta = agentSessionMetaSchema.safeParse(entry);
        if (meta.success) stored.set(meta.data.id, meta.data); else indexValid = false;
      }
    } catch {
      indexValid = false;
    }
    const ids = (await this.readNames()).flatMap((name) => {
      const match = SESSION_FILE.exec(name);
      return match && name !== INDEX_FILE ? [match[1]] : [];
    });
    const index = new Map<string, StoredAgentSessionMeta>();
    let changed = !indexValid || stored.size !== ids.length;
    for (const id of ids) {
      const known = stored.get(id);
      if (known) { index.set(id, known); continue; }
      changed = true;
      let modified = Date.now();
      try {
        const stat = await fs.stat(this.file(id));
        modified = stat.mtimeMs;
        index.set(id, stat.size > MAX_STORED_SESSION_BYTES ? unreadable(id, modified) : metaFromContent(id, await fs.readFile(this.file(id), "utf8"), modified));
      } catch {
        index.set(id, unreadable(id, modified));
      }
    }
    this.index = index;
    if (changed && ids.length) await this.writeIndex(index).catch(() => undefined);
    return index;
  }

  private async writeIndex(index: Map<string, StoredAgentSessionMeta>): Promise<void> {
    await atomicWriteUtf8File(path.join(this.root, INDEX_FILE), JSON.stringify({ version: 1, sessions: [...index.values()] }));
  }
}
