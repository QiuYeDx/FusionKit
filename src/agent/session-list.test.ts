import { describe, expect, it } from "vitest";
import { groupSessions, matchesSessionQuery } from "./session-list";
import type { AgentSessionMeta } from "./types";

const now = new Date(2026, 9, 12, 15, 0).getTime();
const day = 24 * 60 * 60 * 1000;
const meta = (id: string, updatedAt: number, extra: Partial<AgentSessionMeta> = {}): AgentSessionMeta => ({
  id, title: id, titleSource: "auto", pinned: false, createdAt: updatedAt, updatedAt, messageCount: 2, preview: "", ...extra,
});

describe("session list", () => {
  it("puts pinned sessions first, then today, yesterday, the last week and earlier", () => {
    const groups = groupSessions([
      meta("old", now - 30 * day), meta("week", now - 3 * day), meta("yesterday", now - day),
      meta("today-early", new Date(2026, 9, 12, 0, 5).getTime()), meta("today-late", now - 1000),
      meta("pinned-old", now - 40 * day, { pinned: true }),
    ], now);
    expect(groups.map((group) => [group.key, group.sessions.map((item) => item.id)])).toEqual([
      ["pinned", ["pinned-old"]], ["today", ["today-late", "today-early"]], ["yesterday", ["yesterday"]],
      ["week", ["week"]], ["earlier", ["old"]],
    ]);
  });
  it("counts days by the local calendar, not by 24-hour windows", () => {
    const lateYesterday = new Date(2026, 9, 11, 23, 59).getTime();
    expect(groupSessions([meta("a", lateYesterday)], new Date(2026, 9, 12, 0, 1).getTime())[0].key).toBe("yesterday");
  });
  it("searches titles and the latest words without regard to case, keeping the groups", () => {
    const list = [meta("a", now, { title: "Translate EP01" }), meta("b", now - day, { title: "其他", preview: "把 ep01 改成双语" }), meta("c", now, { title: "无关" })];
    expect(groupSessions(list, now, "ep01").flatMap((group) => group.sessions.map((item) => item.id))).toEqual(["a", "b"]);
    expect(groupSessions(list, now, "  ").flatMap((group) => group.sessions)).toHaveLength(3);
    expect(groupSessions(list, now, "nothing")).toEqual([]);
    expect(matchesSessionQuery(list[0], "translate")).toBe(true);
  });
});
