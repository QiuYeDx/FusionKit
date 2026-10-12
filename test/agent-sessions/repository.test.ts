import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() }, ipcMain: { handle: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() } }));
vi.mock("../../electron/main/translation/atomic-file", async (load) => {
  const actual = await load<typeof import("../../electron/main/translation/atomic-file")>();
  return { atomicWriteUtf8File: vi.fn(actual.atomicWriteUtf8File) };
});

import { BrowserWindow } from "electron";
import { AgentSessionRepository } from "../../electron/main/agent-sessions/repository";
import { atomicWriteUtf8File } from "../../electron/main/translation/atomic-file";
import { setupAgentSessionsIPC } from "../../electron/main/agent-sessions";
import { AGENT_SESSIONS_CHANNELS, MAX_STORED_SESSION_BYTES, type StoredAgentSessionMeta } from "../../src/agent/session-store-contract";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "fk-agent-sessions-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const meta = (id: string, extra: Partial<StoredAgentSessionMeta> = {}): StoredAgentSessionMeta => ({
  id, title: `Title ${id}`, titleSource: "auto", pinned: false, createdAt: 1, updatedAt: 10, messageCount: 1, preview: "hello", ...extra,
});
const content = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, exportedAt: 1, executionMode: "queue_only",
  session: { id, messages: [{ id: "m", role: "user", content: "hello there", timestamp: 1 }, { id: "r", role: "assistant", content: "answer   text", timestamp: 2 }],
    status: "idle", createdAt: 1, updatedAt: 10, ...extra },
  tokenStats: { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalCost: 0, stepCount: 0, lastPromptTokens: 0, interactions: [] },
  sessionLog: [],
});

describe("agent session repository", () => {
  it("saves, lists newest first, loads, removes and clears", async () => {
    const repository = new AgentSessionRepository(root);
    expect(await repository.list()).toEqual({ ok: true, value: [] });
    expect(await repository.save({ meta: meta("a", { updatedAt: 5 }), content: content("a") })).toEqual({ ok: true, value: null });
    expect(await repository.save({ meta: meta("b", { updatedAt: 9, pinned: true }), content: content("b") })).toEqual({ ok: true, value: null });
    const listed = await repository.list();
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual(["b", "a"]);
    expect(await repository.load("a")).toEqual({ ok: true, value: content("a") });
    expect(await repository.remove("a")).toEqual({ ok: true, value: null });
    expect(await repository.load("a")).toEqual({ ok: false, error: "agent_session_not_found" });
    // A fresh process reads the same list from the index.
    const reopened = await new AgentSessionRepository(root).list();
    expect(reopened.ok && reopened.value).toEqual([meta("b", { updatedAt: 9, pinned: true })]);
    expect(await repository.clear()).toEqual({ ok: true, value: null });
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(await repository.list()).toEqual({ ok: true, value: [] });
  });

  it("refuses ids that could leave the folder, mismatched content and oversized files", async () => {
    const repository = new AgentSessionRepository(root);
    for (const id of ["../evil", "a/b", "a\\b", "", "x".repeat(101), "con.json"]) {
      expect(await repository.load(id)).toEqual({ ok: false, error: "agent_session_invalid" });
      expect(await repository.remove(id)).toEqual({ ok: false, error: "agent_session_invalid" });
      expect(await repository.save({ meta: meta(id), content: content(id) })).toEqual({ ok: false, error: "agent_session_invalid" });
    }
    expect(await repository.save({ meta: meta("a"), content: content("b") })).toEqual({ ok: false, error: "agent_session_invalid" });
    expect(await repository.save({ meta: meta("a"), content: "{not json" })).toEqual({ ok: false, error: "agent_session_invalid" });
    expect(await repository.save({ meta: { ...meta("a"), extra: 1 }, content: content("a") })).toEqual({ ok: false, error: "agent_session_invalid" });
    const huge = content("a", { title: "x".repeat(MAX_STORED_SESSION_BYTES) });
    expect(await repository.save({ meta: meta("a"), content: huge })).toEqual({ ok: false, error: "agent_session_too_large" });
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  it("keeps the previous file and list entry when a write fails", async () => {
    const repository = new AgentSessionRepository(root);
    await repository.save({ meta: meta("a"), content: content("a") });
    vi.mocked(atomicWriteUtf8File).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    expect(await repository.save({ meta: meta("a", { title: "Changed", updatedAt: 99 }), content: content("a", { title: "Changed" }) }))
      .toEqual({ ok: false, error: "agent_session_write_failed" });
    expect(await readFile(path.join(root, "a.json"), "utf8")).toBe(content("a"));
    const listed = await repository.list();
    expect(listed.ok && listed.value[0]).toMatchObject({ title: "Title a", updatedAt: 10 });
  });

  it("rebuilds a missing or damaged index from the files and lists unreadable files", async () => {
    await writeFile(path.join(root, "good.json"), content("good", { title: "Saved title", titleSource: "manual", pinned: true }));
    await writeFile(path.join(root, "bad.json"), "{ broken");
    await writeFile(path.join(root, "index.json"), "not json");
    await writeFile(path.join(root, "notes.txt"), "ignored");
    const listed = await new AgentSessionRepository(root).list();
    expect(listed.ok).toBe(true);
    const byId = Object.fromEntries((listed.ok ? listed.value : []).map((item) => [item.id, item]));
    expect(Object.keys(byId).sort()).toEqual(["bad", "good"]);
    expect(byId.good).toMatchObject({ title: "Saved title", titleSource: "manual", pinned: true, messageCount: 2, preview: "answer text" });
    expect(byId.bad).toMatchObject({ unreadable: true, messageCount: 0 });
    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    expect(index.sessions).toHaveLength(2);
  });

  it("drops index entries whose file is gone and adds files the index does not know", async () => {
    const repository = new AgentSessionRepository(root);
    await repository.save({ meta: meta("a"), content: content("a") });
    await repository.save({ meta: meta("b"), content: content("b") });
    await rm(path.join(root, "a.json"));
    await writeFile(path.join(root, "c.json"), content("c"));
    const listed = await new AgentSessionRepository(root).list();
    expect(listed.ok && listed.value.map((item) => item.id).sort()).toEqual(["b", "c"]);
  });

  it("answers only the app's own main frame", async () => {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    const repository = new AgentSessionRepository(root);
    setupAgentSessionsIPC(repository, { handle: ((channel: string, handler: never) => { handlers.set(channel, handler); }) as never });
    const mainFrame = {};
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as never);
    expect(await handlers.get(AGENT_SESSIONS_CHANNELS.list)!({ sender: { mainFrame }, senderFrame: mainFrame })).toEqual({ ok: true, value: [] });
    expect(await handlers.get(AGENT_SESSIONS_CHANNELS.list)!({ sender: { mainFrame }, senderFrame: {} })).toEqual({ ok: false, error: "agent_sessions_blocked" });
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
    expect(await handlers.get(AGENT_SESSIONS_CHANNELS.clear)!({ sender: { mainFrame }, senderFrame: mainFrame })).toEqual({ ok: false, error: "agent_sessions_blocked" });
  });
});
