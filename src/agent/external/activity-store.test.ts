import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import type { ActivityRecord } from "./activity";
import { ALL_SESSIONS, NOTICE_MERGE_MS, noteActivityEvent, resetExternalActivity, setActivityNotices, setActivityViewing, unseenTotal, useExternalActivityStore } from "./activity-store";

let sequence = 0;
// Ahead of the real clock, which marking as seen uses.
const NOW = Date.now() + 60_000;
function record(change: Partial<ActivityRecord> = {}): ActivityRecord {
  sequence++;
  return {
    id: `r${sequence}`, sessionId: "s1", client: { name: "claude-code", version: "2" }, tool: "write_studio_translations", access: "write",
    startedAt: NOW + sequence, endedAt: NOW + sequence, status: "ok", approval: "session",
    note: { summary: { action: "translation", key: "write_translations", values: { count: 12, document: "Ep01.srt", track: "claude-code" } } }, ...change,
  };
}
const event = (value: ActivityRecord) => ({ type: "record" as const, record: value });

beforeEach(() => {
  resetExternalActivity();
  toast.mockClear(); toast.dismiss.mockClear();
  useExternalActivityStore.setState({ lastSeenAt: NOW });
});

describe("external activity indicator and notices", () => {
  it("counts only changes that ran without asking, once each", () => {
    const allowed = record();
    noteActivityEvent(event(allowed));
    noteActivityEvent(event(allowed));
    noteActivityEvent(event(record({ approval: "auto" })));
    noteActivityEvent(event(record({ approval: "confirmed" })));
    noteActivityEvent(event(record({ access: "read", tool: "read_studio_document", approval: "none" })));
    noteActivityEvent(event(record({ status: "failed", error: "tool_failed" })));
    noteActivityEvent(event(record({ startedAt: NOW - 1 })));
    expect(useExternalActivityStore.getState().unseen).toEqual({ s1: 2 });
    expect(unseenTotal(useExternalActivityStore.getState())).toBe(2);
  });

  it("merges one connection's changes within five seconds into one notice", () => {
    const open = vi.fn();
    noteActivityEvent(event(record()), { now: NOW, open });
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining("claude-code"), expect.objectContaining({ id: "external-activity-s1" }));
    noteActivityEvent(event(record()), { now: NOW + 1000, open });
    noteActivityEvent(event(record()), { now: NOW + 2000, open });
    expect(toast).toHaveBeenCalledTimes(3);
    const [message, options] = toast.mock.calls.at(-1)!;
    expect(options.id).toBe("external-activity-s1");
    expect(message).toMatch(/3/);
    options.action.onClick();
    expect(open).toHaveBeenCalledWith("s1");
    // After a quiet spell a new notice starts counting again.
    noteActivityEvent(event(record()), { now: NOW + 2000 + NOTICE_MERGE_MS + 1, open });
    expect(toast.mock.calls.at(-1)![0]).not.toMatch(/做了|made/);
    expect(useExternalActivityStore.getState().unseen.s1).toBe(4);
  });

  it("stays quiet while the page shows that connection, and counts it as seen", () => {
    noteActivityEvent(event(record()));
    setActivityViewing("s1");
    // Opening the page takes away the notice that pointed there.
    expect(toast.dismiss).toHaveBeenCalledWith("external-activity-s1");
    toast.mockClear();
    noteActivityEvent(event(record()));
    expect(toast).not.toHaveBeenCalled();
    expect(unseenTotal(useExternalActivityStore.getState())).toBe(0);
    setActivityViewing(ALL_SESSIONS);
    noteActivityEvent(event(record({ sessionId: "s2" })));
    expect(toast).not.toHaveBeenCalled();
    setActivityViewing(null);
    noteActivityEvent(event(record({ sessionId: "s2" })));
    expect(toast).toHaveBeenCalledOnce();
  });

  it("keeps counting but shows no notice when notices are off; clearing resets", () => {
    setActivityNotices(false);
    noteActivityEvent(event(record()));
    expect(toast).not.toHaveBeenCalled();
    expect(unseenTotal(useExternalActivityStore.getState())).toBe(1);
    noteActivityEvent({ type: "cleared" });
    expect(unseenTotal(useExternalActivityStore.getState())).toBe(0);
  });
});
