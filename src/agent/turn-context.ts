import useAgentStore from "@/store/agent/useAgentStore";

// ---------------------------------------------------------------------------
// Which session a tool call belongs to. Every tool of a turn receives the turn's
// abort signal (guarded-tools), so the signal identifies the session that asked,
// whichever session the user is looking at meanwhile.
// ---------------------------------------------------------------------------

const sessions = new WeakMap<AbortSignal, string>();

export function bindTurnSession(signal: AbortSignal, sessionId: string): void {
  sessions.set(signal, sessionId);
}

/** The session of the turn that owns this signal; direct calls without a turn act for the current session. */
export function sessionOfSignal(signal?: AbortSignal): string {
  return (signal && sessions.get(signal)) ?? useAgentStore.getState().activeSessionId;
}

/** The state of one session, or undefined once it is deleted. */
export function sessionSlot(sessionId: string) {
  return useAgentStore.getState().slots[sessionId];
}

/** Calls a listener once for every session that disappears from the store. */
export function onSessionRemoved(listener: (sessionId: string) => void): () => void {
  return useAgentStore.subscribe((state, previous) => {
    if (state.slots === previous.slots) return;
    for (const id of Object.keys(previous.slots)) if (!state.slots[id]) listener(id);
  });
}
