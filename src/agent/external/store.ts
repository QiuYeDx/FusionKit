import { create } from "zustand";
import type { ExternalAgentStatus } from "./contract";

export const EXTERNAL_ACTIVITY_LIMIT = 50;

export interface ExternalActivityEntry {
  callId: string;
  tool: string;
  ok: boolean;
  error?: string;
  at: number;
}

interface ExternalAgentState {
  status: ExternalAgentStatus | null;
  /** Recent calls per connected session, newest last. */
  activity: Record<string, ExternalActivityEntry[]>;
  setStatus: (status: ExternalAgentStatus) => void;
  record: (sessionId: string, entry: ExternalActivityEntry) => void;
}

/** No persistence: connections and their activity live only while they last. */
export const useExternalAgentStore = create<ExternalAgentState>((set) => ({
  status: null,
  activity: {},
  setStatus: (status) => set((state) => {
    const live = new Set(status.sessions.map((session) => session.id));
    const activity = Object.fromEntries(Object.entries(state.activity).filter(([id]) => live.has(id)));
    return { status, activity };
  }),
  record: (sessionId, entry) => set((state) => ({
    activity: { ...state.activity, [sessionId]: [...(state.activity[sessionId] ?? []), entry].slice(-EXTERNAL_ACTIVITY_LIMIT) },
  })),
}));
