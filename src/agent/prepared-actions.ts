import { create } from "zustand";
import useAgentStore from "@/store/agent/useAgentStore";
import type { AgentCapabilityKey } from "./capability-catalog";

export interface PreparedActionResult { success: boolean; data?: unknown; error?: string }
export interface PreparedAction {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  summaryKey?: "home:prepared_translation_summary" | "home:prepared_transcription_summary";
  summaryValues?: Record<string, string | number>;
  toolKey: AgentCapabilityKey;
  status: "ready" | "running" | "completed" | "failed" | "dismissed";
  error?: string;
  result?: unknown;
}
interface ActionCallbacks {
  execute: () => Promise<PreparedActionResult>;
  cleanup?: () => void | Promise<void>;
}
interface PreparedActionsState {
  actions: PreparedAction[];
  confirmAction: (id: string) => Promise<void>;
  dismissAction: (id: string) => void;
}
const callbacks = new Map<string, ActionCallbacks>();
const MAX_READY_ACTIONS = 12;
const MAX_ACTION_HISTORY = 50;
let sequence = 0;

async function cleanup(entry: ActionCallbacks | undefined): Promise<void> {
  try { await entry?.cleanup?.(); }
  catch { /* Capability owners retain failed revocations in their own retry queue. */ }
}

/** No persist middleware: authority and callbacks must never survive an application restart. */
export const usePreparedActionsStore = create<PreparedActionsState>((set, get) => ({
  actions: [],
  confirmAction: async id => {
    const action = get().actions.find(item => item.id === id);
    if (!action || action.status !== "ready") return;
    if (action.sessionId !== useAgentStore.getState().session.id) {
      get().dismissAction(id);
      return;
    }
    const entry = callbacks.get(id);
    callbacks.delete(id);
    // Claim before the first await. UI clicks and automatic execution share this path.
    set(state => ({ actions: state.actions.map(item => item.id === id ? { ...item, status: "running" } : item) }));
    try {
      const result = entry ? await entry.execute() : { success: false, error: "prepared_action_expired" };
      set(state => ({ actions: state.actions.map(item => item.id === id ? {
        ...item, status: result.success ? "completed" : "failed",
        ...(result.success ? { result: result.data } : { error: result.error ?? "prepared_action_failed" }),
      } : item) }));
    } catch {
      set(state => ({ actions: state.actions.map(item => item.id === id ? { ...item, status: "failed", error: "prepared_action_failed" } : item) }));
    } finally { await cleanup(entry); }
  },
  dismissAction: id => {
    const action = get().actions.find(item => item.id === id);
    if (!action || action.status !== "ready") return;
    const entry = callbacks.get(id);
    callbacks.delete(id);
    set(state => ({ actions: state.actions.map(item => item.id === id ? { ...item, status: "dismissed" } : item) }));
    void cleanup(entry);
  },
}));

export function registerPreparedAction(input: Pick<PreparedAction, "sessionId" | "title" | "summary" | "toolKey" | "summaryKey" | "summaryValues"> & ActionCallbacks): PreparedAction {
  if (input.sessionId !== useAgentStore.getState().session.id) throw new Error("agent_session_changed");
  const current = usePreparedActionsStore.getState().actions;
  if (current.filter(item => item.status === "ready" || item.status === "running").length >= MAX_READY_ACTIONS) throw new Error("prepared_action_limit");
  const action: PreparedAction = { id: `prepared-${Date.now()}-${++sequence}`, sessionId: input.sessionId,
    title: input.title.slice(0, 200), summary: input.summary.slice(0, 2000), toolKey: input.toolKey, status: "ready",
    ...(input.summaryKey ? { summaryKey: input.summaryKey, summaryValues: input.summaryValues } : {}) };
  callbacks.set(action.id, { execute: input.execute, cleanup: input.cleanup });
  const active = current.filter(item => item.status === "ready" || item.status === "running");
  const terminal = current.filter(item => item.status !== "ready" && item.status !== "running").slice(-(MAX_ACTION_HISTORY - active.length - 1));
  usePreparedActionsStore.setState({ actions: [...terminal, ...active, action] });
  return action;
}

useAgentStore.subscribe((state, previous) => {
  if (state.session.id === previous.session.id) return;
  for (const action of usePreparedActionsStore.getState().actions) {
    if (action.sessionId !== state.session.id) usePreparedActionsStore.getState().dismissAction(action.id);
  }
});
