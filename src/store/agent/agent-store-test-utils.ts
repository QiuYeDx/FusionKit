import useAgentStore, { createSessionSlot, type SessionSlot } from "./useAgentStore";

// Test helpers: state goes into the session's slot, and the projection follows as in the app.

/** Starts over with a single session of this id, shown on screen; earlier sessions are deleted. */
export function useTestSession(id: string, parts: Partial<Omit<SessionSlot, "session">> & { session?: Partial<SessionSlot["session"]> } = {}): void {
  const { session, ...rest } = parts;
  const store = useAgentStore.getState();
  store.removeAllSessions();
  store.adoptSession(createSessionSlot({ id, messages: [], status: "idle", createdAt: 1, updatedAt: 1, ...session }, rest), { activate: true });
}

/** Changes the shown session's slot directly, as if the app had written it. */
export function patchActiveSlot(parts: Partial<Omit<SessionSlot, "session">> & { session?: Partial<SessionSlot["session"]> }): void {
  const { activeSessionId, slots } = useAgentStore.getState();
  const current = slots[activeSessionId];
  const { session, ...rest } = parts;
  useAgentStore.getState().adoptSession({ ...current, ...rest, session: { ...current.session, ...session } });
}
