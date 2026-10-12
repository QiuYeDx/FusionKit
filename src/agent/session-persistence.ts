import { create } from "zustand";
import useAgentStore, { createSessionSlot, sessionMeta, settledSession, type SessionSlot } from "@/store/agent/useAgentStore";
import { abortAllTurns, abortSessionTurn, onTurnEnd } from "./orchestrator";
import { parseSessionJson } from "./session-schema";
import { MAX_STORED_SESSION_BYTES, type AgentSessionsApi, type AgentSessionsError } from "./session-store-contract";
import { forgetAllSessionDrafts, forgetSessionDraft } from "./session-drafts";
import { exportSession, type SessionExportResult } from "./session-io";
import type { AgentSessionMeta, SessionExportData } from "./types";

// ---------------------------------------------------------------------------
// Saving conversations in the application data folder. A session with messages
// is saved shortly after it changes and at once when a turn ends; a saved
// session is read back when the user opens it. Confirmation authority is never
// saved: a session read back has no pending card.
// ---------------------------------------------------------------------------

export const SAVE_DELAY_MS = 800;

type SaveError = AgentSessionsError | "agent_session_unavailable";

interface PersistenceState {
  /** The saved list has been read (or there is no storage). */
  ready: boolean;
  /** Sessions being read from disk. */
  loading: Record<string, true>;
  /** The latest save of a session failed; it stays in memory and can be saved again. */
  saveErrors: Record<string, SaveError>;
}

export const useSessionPersistenceStore = create<PersistenceState>(() => ({ ready: false, loading: {}, saveErrors: {} }));

function api(): AgentSessionsApi | undefined {
  return typeof window !== "undefined" ? window.agentSessions : undefined;
}

function setSaveError(id: string, error: SaveError | undefined) {
  useSessionPersistenceStore.setState((state) => {
    if (state.saveErrors[id] === error) return state;
    const saveErrors = { ...state.saveErrors };
    if (error) saveErrors[id] = error; else delete saveErrors[id];
    return { saveErrors };
  });
}

function setLoading(id: string, loading: boolean) {
  useSessionPersistenceStore.setState((state) => {
    const next = { ...state.loading };
    if (loading) next[id] = true; else delete next[id];
    return { loading: next };
  });
}

/** The file to write: the whole session, or with the oldest log details dropped when it would pass the limit. */
export function serializeSession(data: SessionExportData): string | null {
  const encoder = new TextEncoder();
  const fits = (json: string) => json.length <= MAX_STORED_SESSION_BYTES && encoder.encode(json).byteLength <= MAX_STORED_SESSION_BYTES;
  let json = JSON.stringify(data);
  if (fits(json)) return json;
  let sessionLog = data.sessionLog.map(({ data: _details, ...entry }) => entry);
  json = JSON.stringify({ ...data, sessionLog });
  while (!fits(json) && sessionLog.length) {
    sessionLog = sessionLog.slice(Math.ceil(sessionLog.length / 2));
    json = JSON.stringify({ ...data, sessionLog });
  }
  return fits(json) ? json : null;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const chains = new Map<string, Promise<void>>();

async function write(id: string): Promise<void> {
  const storage = api();
  const slot = useAgentStore.getState().slots[id];
  if (!storage || !slot || slot.session.messages.length === 0) return;
  const content = serializeSession(useAgentStore.getState().forSession(id).getSessionExportData());
  if (!content) { setSaveError(id, "agent_session_too_large"); return; }
  try {
    const result = await storage.save({ meta: sessionMeta(slot.session), content });
    // A session deleted while its save was on the way is removed after it, in the same queue.
    setSaveError(id, result.ok ? undefined : result.error);
  } catch {
    setSaveError(id, "agent_session_unavailable");
  }
}

/** Saves the session now, after any save already on its way. */
export function saveSessionNow(id: string): Promise<void> {
  const timer = timers.get(id);
  if (timer) { clearTimeout(timer); timers.delete(id); }
  const next = (chains.get(id) ?? Promise.resolve()).then(() => write(id));
  chains.set(id, next);
  void next.finally(() => { if (chains.get(id) === next) chains.delete(id); });
  return next;
}

function scheduleSave(id: string): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.set(id, setTimeout(() => { timers.delete(id); void saveSessionNow(id); }, SAVE_DELAY_MS));
}

function cancelSave(id: string): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  setSaveError(id, undefined);
}

/** Saves every session with a change still waiting. */
export function flushSessionSaves(): Promise<void> {
  return Promise.all([...timers.keys()].map((id) => saveSessionNow(id))).then(() => undefined);
}

/** A saved file, checked like an import, as a session that is idle and holds no confirmation. */
export function slotFromSavedContent(id: string, content: string): SessionSlot {
  const data = parseSessionJson(content);
  if (data.session.id !== id) throw new Error("agent_session_invalid");
  return createSessionSlot(settledSession(data.session), { tokenStats: data.tokenStats, sessionLog: data.sessionLog });
}

const loads = new Map<string, Promise<boolean>>();

/** Reads a saved session into memory without showing it. */
export function ensureSessionLoaded(id: string): Promise<boolean> {
  if (useAgentStore.getState().hasSession(id)) return Promise.resolve(true);
  const meta = useAgentStore.getState().catalog[id];
  const storage = api();
  if (!meta || meta.unreadable || !storage) return Promise.resolve(false);
  const existing = loads.get(id);
  if (existing) return existing;
  setLoading(id, true);
  const operation = (async () => {
    try {
      const result = await storage.load(id);
      if (!result.ok) throw new Error(result.error);
      const slot = slotFromSavedContent(id, result.value);
      // Deleted while it was being read: it stays deleted.
      if (!useAgentStore.getState().catalog[id]) return false;
      // A change made to the list entry while loading (a rename, a pin) wins over the file.
      const latest = useAgentStore.getState().catalog[id];
      const session = { ...slot.session, title: latest.title || slot.session.title, titleSource: latest.titleSource, pinned: latest.pinned };
      if (!useAgentStore.getState().hasSession(id)) useAgentStore.getState().adoptSession({ ...slot, session });
      return true;
    } catch {
      useAgentStore.getState().markUnreadable(id);
      return false;
    } finally {
      setLoading(id, false);
      loads.delete(id);
    }
  })();
  loads.set(id, operation);
  return operation;
}

/** Shows a session, reading it from disk first when needed. */
export async function openSession(id: string): Promise<boolean> {
  if (!(await ensureSessionLoaded(id))) return false;
  return useAgentStore.getState().activateSession(id);
}

export function newSession(): string {
  return useAgentStore.getState().createSession();
}

export async function renameSession(id: string, title: string): Promise<boolean> {
  await ensureSessionLoaded(id);
  const renamed = useAgentStore.getState().renameSession(id, title);
  if (renamed) void saveSessionNow(id);
  return renamed;
}

export async function setSessionPinned(id: string, pinned: boolean): Promise<void> {
  await ensureSessionLoaded(id);
  useAgentStore.getState().setPinned(id, pinned);
  void saveSessionNow(id);
}

/** Exports any session, reading it from disk first when it is not open. */
export async function exportSessionById(id: string): Promise<SessionExportResult> {
  if (!(await ensureSessionLoaded(id))) return { success: false, errorCode: "invalid" };
  return exportSession(() => useAgentStore.getState().forSession(id).getSessionExportData());
}

/** Deletes a session for good: its reply stops, its cards are void and its file is removed. */
export async function deleteSession(id: string): Promise<boolean> {
  abortSessionTurn(id);
  cancelSave(id);
  useAgentStore.getState().removeSession(id);
  forgetSessionDraft(id);
  const storage = api();
  if (!storage) return true;
  await chains.get(id)?.catch(() => undefined);
  try { return (await storage.remove(id)).ok; } catch { return false; }
}

/** Deletes every saved and open session and starts with a blank one. */
export async function clearAllSessions(): Promise<boolean> {
  abortAllTurns();
  for (const id of [...timers.keys()]) cancelSave(id);
  useAgentStore.getState().removeAllSessions();
  forgetAllSessionDrafts();
  useSessionPersistenceStore.setState({ saveErrors: {} });
  const storage = api();
  if (!storage) return true;
  await Promise.all([...chains.values()].map((chain) => chain.catch(() => undefined)));
  try { return (await storage.clear()).ok; } catch { return false; }
}

let started = false;

/** Reads the saved list and starts saving changes. Safe to call more than once. */
export async function initAgentSessions(): Promise<void> {
  if (started) return;
  started = true;
  useAgentStore.subscribe((state, previous) => {
    if (state.slots === previous.slots) return;
    for (const [id, slot] of Object.entries(state.slots)) {
      const before = previous.slots[id];
      if (slot.session.messages.length === 0) continue;
      if (!before || before.session !== slot.session || before.tokenStats !== slot.tokenStats || before.sessionLog !== slot.sessionLog) scheduleSave(id);
    }
  });
  onTurnEnd((id) => { void saveSessionNow(id); });
  if (typeof window !== "undefined") window.addEventListener("beforeunload", () => { void flushSessionSaves(); });
  const storage = api();
  if (!storage) { useSessionPersistenceStore.setState({ ready: true }); return; }
  try {
    const result = await storage.list();
    if (result.ok) useAgentStore.getState().setCatalog(result.value as AgentSessionMeta[]);
  } catch { /* Without the saved list, sessions of this run are still kept in memory. */ }
  useSessionPersistenceStore.setState({ ready: true });
}
