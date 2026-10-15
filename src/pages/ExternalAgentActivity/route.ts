export const EXTERNAL_ACTIVITY_ROUTE = "/external-agent";

/** The activity page, optionally showing one connection. */
export function externalActivityPath(sessionId?: string): string {
  return sessionId ? `${EXTERNAL_ACTIVITY_ROUTE}?${new URLSearchParams({ session: sessionId }).toString()}` : EXTERNAL_ACTIVITY_ROUTE;
}

export function readActivitySession(search: string): string | null {
  const values = new URLSearchParams(search).getAll("session");
  return values.length === 1 && values[0] && values[0].length <= 200 ? values[0] : null;
}
