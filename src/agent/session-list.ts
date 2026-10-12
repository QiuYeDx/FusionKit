import type { AgentSessionMeta } from "./types";

// ---------------------------------------------------------------------------
// Session list — pinned first, then by local day of the last change.
// ---------------------------------------------------------------------------

export type SessionGroupKey = "pinned" | "today" | "yesterday" | "week" | "earlier";
export interface SessionGroup { key: SessionGroupKey; sessions: AgentSessionMeta[] }

const ORDER: SessionGroupKey[] = ["pinned", "today", "yesterday", "week", "earlier"];

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function groupOf(meta: AgentSessionMeta, today: number): SessionGroupKey {
  if (meta.pinned) return "pinned";
  if (meta.updatedAt >= today) return "today";
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (meta.updatedAt >= yesterday.getTime()) return "yesterday";
  const week = new Date(today); week.setDate(week.getDate() - 6);
  return meta.updatedAt >= week.getTime() ? "week" : "earlier";
}

/** Case-insensitive match on the title and the latest words. */
export function matchesSessionQuery(meta: AgentSessionMeta, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return meta.title.toLocaleLowerCase().includes(needle) || meta.preview.toLocaleLowerCase().includes(needle);
}

export function groupSessions(metas: readonly AgentSessionMeta[], now: number, query = ""): SessionGroup[] {
  const today = startOfDay(now);
  const groups = new Map<SessionGroupKey, AgentSessionMeta[]>();
  for (const meta of metas) {
    if (!matchesSessionQuery(meta, query)) continue;
    const key = groupOf(meta, today);
    groups.set(key, [...(groups.get(key) ?? []), meta]);
  }
  return ORDER.filter((key) => groups.has(key)).map((key) => ({
    key,
    sessions: groups.get(key)!.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt),
  }));
}
